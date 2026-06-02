import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  ConflictError,
  IOError,
  LockTimeoutError,
  appendEvent,
  hashContent,
  withFileLock
} from "../runtime/index.mjs";
import {
  POLICY_VERSION,
  resolveCapabilityOutcomePolicy
} from "./generated-policy.mjs";
import { validateEvidenceSet } from "./evidence-registry.mjs";
import { rejection } from "./errors.mjs";
import { validateMustAskApprovals } from "./must-ask.mjs";
import {
  applyRequirementMarkdownEffects,
  applyTaskStateEffects,
  canonicalLockPath,
  resolveStateEffects
} from "./state-effects.mjs";

const DEFAULT_RETRY_POLICY = {
  maxAttempts: 3,
  initialDelayMs: 250,
  multiplier: 2,
  maxDelayMs: 2000
};

const REQUIREMENT_FINALIZE_POLICY_ID = "requirement.finalize:delivered:requirement";
const REQUIREMENT_PROMOTE_POLICY_ID = "requirement.promote:planning:requirement";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeSubjectType(value) {
  return value === "task" ? "subtask" : value;
}

function evidenceRefs(evidence) {
  return evidence.map((item) => item.ref ?? item.params?.idempotency_key ?? item.check_id).filter(Boolean);
}

function isRetryable(error) {
  return error instanceof LockTimeoutError || error instanceof IOError;
}

function parseFrontmatter(content) {
  const matched = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!matched) return {};
  const frontmatter = {};
  for (const line of matched[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    frontmatter[key] = value;
  }
  return frontmatter;
}

async function readRequirementForGuard({ projectRoot, subjectRef, expectedHash, capabilityName }) {
  const hash = expectedHash ?? subjectRef.base_hash;
  if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) {
    return {
      ok: false,
      code: "GUARD_FAILED",
      issues: [`${capabilityName} requires expectedHash or subjectRef.base_hash`]
    };
  }
  if (!subjectRef.canonical_path) {
    return {
      ok: false,
      code: "GUARD_FAILED",
      issues: [`${capabilityName} requires subjectRef.canonical_path`]
    };
  }

  let content;
  try {
    content = await readFile(join(projectRoot, subjectRef.canonical_path), "utf8");
  } catch (error) {
    return {
      ok: false,
      code: "GUARD_FAILED",
      issues: [error instanceof Error ? error.message : String(error)]
    };
  }
  const currentHash = hashContent(content);
  if (currentHash !== hash) {
    return {
      ok: false,
      code: "CAS_CONFLICT",
      reconcileRequired: true,
      issues: ["requirement markdown changed after AI read hash"]
    };
  }
  return { ok: true, content, status: parseFrontmatter(content).status };
}

async function validateRequirementFinalizeGuards(input) {
  const checked = await readRequirementForGuard({ ...input, capabilityName: "requirement.finalize" });
  if (!checked.ok) return checked;

  if (checked.status === "cancelled" || checked.status === "deferred") {
    return {
      ok: false,
      code: "GUARD_FAILED",
      issues: [`requirement.finalize cannot override ${checked.status} requirement`]
    };
  }
  return { ok: true };
}

async function validateRequirementPromoteGuards(input) {
  const checked = await readRequirementForGuard({ ...input, capabilityName: "requirement.promote" });
  if (!checked.ok) return checked;

  if (checked.status === "drafting") return { ok: true };
  if (checked.status === "planning") return { ok: true, noop: true };

  return {
    ok: false,
    code: "GUARD_FAILED",
    issues: [`requirement.promote cannot override ${checked.status ?? "missing"} requirement`]
  };
}

async function validateExecutableGuards({ projectRoot, policy, subjectRef, expectedHash }) {
  if (policy.policy_id === REQUIREMENT_FINALIZE_POLICY_ID) {
    return await validateRequirementFinalizeGuards({ projectRoot, subjectRef, expectedHash });
  }
  if (policy.policy_id === REQUIREMENT_PROMOTE_POLICY_ID) {
    return await validateRequirementPromoteGuards({ projectRoot, subjectRef, expectedHash });
  }
  return { ok: true };
}

function rejectionFromError(error, context) {
  if (error instanceof ConflictError) {
    return rejection({ ...context, code: "CAS_CONFLICT", reconcileRequired: true, issues: [error.message] });
  }
  if (error instanceof LockTimeoutError) {
    return rejection({ ...context, code: "LOCK_TIMEOUT", retryable: true, issues: [error.message] });
  }
  if (error instanceof IOError) {
    return rejection({ ...context, code: "EVENT_APPEND_FAILED", retryable: true, reconcileRequired: true, issues: [error.message] });
  }
  return rejection({
    ...context,
    code: "CANONICAL_WRITE_FAILED",
    reconcileRequired: true,
    issues: [error instanceof Error ? error.message : String(error)]
  });
}

async function appendRejected(projectRoot, input, outcomeId, code, issues) {
  await appendEvent(
    {
      type: "capability_outcome_rejected",
      subject_type: input.subjectRef.subject_type,
      subject_id: input.subjectRef.subject_id,
      payload: {
        outcome_id: outcomeId,
        capability_id: input.capabilityId,
        outcome_type: input.outcomeType,
        code,
        issues
      },
      idempotency_key: `capability-outcome:${outcomeId}:rejected`,
      emitted_at: input.now ?? new Date().toISOString(),
      source_actor: input.sourceActor ?? "ai_session"
    },
    { projectRoot, failPolicy: "warning-only", journalPath: input.journalPath }
  );
}

export async function applyCapabilityOutcome(input) {
  const {
    projectRoot,
    capabilityId,
    outcomeType,
    sourceActor = "ai_session",
    evidence = [],
    mustAskRefs = [],
    stateInput = {},
    dryRun = false
  } = input;
  const subjectRef = {
    ...input.subjectRef,
    subject_type: normalizeSubjectType(input.subjectRef?.subject_type)
  };
  const context = { subjectRef, capabilityId, outcomeType };
  const policy = resolveCapabilityOutcomePolicy({
    capabilityId,
    outcomeType,
    subjectType: subjectRef.subject_type
  });
  if (!policy) {
    return rejection({ ...context, code: "POLICY_NOT_FOUND", issues: ["no matching capability outcome policy"] });
  }

  const outcomeId = input.outcomeId ?? input.idempotencyKey ?? randomUUID();
  const evidenceResult = await validateEvidenceSet({ projectRoot, policy, evidence, outcomeId });
  if (!evidenceResult.ok) {
    return rejection({ ...context, code: "EVIDENCE_MISSING", issues: evidenceResult.issues });
  }
  const approvalResult = validateMustAskApprovals({ policy, subjectRef, evidence, mustAskRefs });
  if (!approvalResult.ok) {
    return rejection({ ...context, code: "MUST_ASK_APPROVAL_MISSING", issues: approvalResult.issues });
  }
  const stateEffectsPreview = resolveStateEffects({ policy, stateInput });
  if (!stateEffectsPreview.ok) {
    return rejection({ ...context, code: "STATE_EFFECT_INVALID", issues: stateEffectsPreview.issues });
  }
  const guardResult = await validateExecutableGuards({
    projectRoot,
    policy,
    subjectRef,
    expectedHash: input.expectedHash
  });
  if (!guardResult.ok) {
    return rejection({
      ...context,
      code: guardResult.code,
      reconcileRequired: guardResult.reconcileRequired,
      issues: guardResult.issues
    });
  }
  if (guardResult.noop) {
    return {
      ok: true,
      noop: true,
      outcome_id: outcomeId,
      policy_id: policy.policy_id,
      subject_ref: subjectRef,
      state_effects: stateEffectsPreview.patch,
      write_result: null,
      events: {}
    };
  }
  if (dryRun) {
    return {
      ok: true,
      dry_run: true,
      outcome_id: outcomeId,
      policy_id: policy.policy_id,
      subject_ref: subjectRef,
      state_effects: stateEffectsPreview.patch,
      write_result: null,
      events: {}
    };
  }

  const retryPolicy = { ...DEFAULT_RETRY_POLICY, ...(input.retryPolicy ?? {}) };
  const maxAttempts = Math.max(1, retryPolicy.maxAttempts);
  let lastRejection = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await withFileLock(
        canonicalLockPath(projectRoot, subjectRef, policy.write_target),
        async () => {
          const appliedEvent = await appendEvent(
            {
              type: "capability_outcome_applied",
              subject_type: subjectRef.subject_type,
              subject_id: subjectRef.subject_id,
              payload: {
                outcome_id: outcomeId,
                policy_id: policy.policy_id,
                capability_id: capabilityId,
                outcome_type: outcomeType,
                subject_ref: subjectRef,
                evidence_refs: evidenceRefs(evidence),
                must_ask_refs: mustAskRefs,
                state_effects: stateEffectsPreview.patch,
                expected_hash: input.expectedHash ?? subjectRef.base_hash ?? null,
                policy_version: POLICY_VERSION,
                retry_attempt: attempt
              },
              idempotency_key: `capability-outcome:${outcomeId}:applied`,
              emitted_at: input.now ?? new Date().toISOString(),
              source_actor: sourceActor
            },
            { projectRoot, failPolicy: "fail-closed", journalPath: input.journalPath }
          );

          const audit = {
            runId: `capability-outcome:${outcomeId}:state-write`,
            capabilityRef: `${capabilityId}:${outcomeType}`
          };
          const write = policy.write_target === "dev_task"
            ? await applyTaskStateEffects({
                projectRoot,
                subjectRef,
                policy,
                stateInput,
                expectedHash: input.expectedHash,
                now: input.now ?? new Date().toISOString(),
                sourceActor,
                audit
              })
            : await applyRequirementMarkdownEffects({
                projectRoot,
                subjectRef,
                policy,
                stateInput,
                expectedHash: input.expectedHash,
                sourceActor,
                audit
              });
          if (!write.ok) {
            return rejection({ ...context, code: "STATE_EFFECT_INVALID", issues: write.issues });
          }
          return {
            ok: true,
            outcome_id: outcomeId,
            policy_id: policy.policy_id,
            subject_ref: subjectRef,
            state_effects: write.stateEffects,
            write_result: write.writeResult,
            events: {
              capability_outcome_applied: appliedEvent.event,
              state_write_intent: `state-write:${audit.runId}:intent`,
              state_write_done: `state-write:${audit.runId}:done`
            }
          };
        },
        input.lockOptions ?? {}
      );
    } catch (error) {
      lastRejection = rejectionFromError(error, context);
      if (!isRetryable(error) || attempt >= maxAttempts) break;
      const delay = Math.min(
        retryPolicy.maxDelayMs,
        retryPolicy.initialDelayMs * Math.pow(retryPolicy.multiplier, attempt - 1)
      );
      await sleep(delay);
    }
  }

  const code = lastRejection?.retryable ? "MAX_RETRY_EXCEEDED" : lastRejection?.code ?? "CANONICAL_WRITE_FAILED";
  const issues = lastRejection?.issues ?? ["capability outcome apply failed"];
  await appendRejected(projectRoot, input, outcomeId, code, issues);
  return {
    ...(lastRejection ?? rejection({ ...context, code, issues })),
    code,
    retryable: lastRejection?.retryable ?? false,
    reconcile_required: true
  };
}
