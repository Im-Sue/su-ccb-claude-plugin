import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { IOError, ValidationError } from "./errors.mjs";
import { withFileLock } from "./file-lock.mjs";
import { notifyEventAppended } from "./hook-notifier.mjs";

const COLLABORATION_TIERS = new Set(["full", "standard", "lite"]);
const CLASSIFIER_COVERAGE = new Set(["full", "partial"]);
const COLLABORATION_PASSES = new Set(["planned", "actual"]);
const SEMANTIC_OVERRIDE_TYPES = new Set(["consult_only", "consult_plus_decision_record", "tier_floor"]);
const VERIFICATION_MINIMUMS = new Set(["static", "targeted", "targeted_plus_edge", "integration", "full"]);
const RISK_SURFACE_TYPES = new Set(["table", "api", "money_sink", "permission_scope"]);
const RISK_ENVELOPE_STATUSES = new Set(["open", "partially_closed", "closed"]);
const RISK_CLOSE_EVIDENCE_BY_SURFACE = new Map([
  ["table", ["migration_verified_ref", "rollback_or_compat_ref"]],
  ["api", ["contract_test_ref", "backward_compat_ref"]],
  ["money_sink", ["invariant_ref", "idempotency_ref", "reconciliation_ref"]],
  ["permission_scope", ["authz_matrix_ref", "privilege_negative_test_ref"]]
]);

function journalPath(options = {}) {
  if (options.journalPath) return options.journalPath;
  return join(options.projectRoot ?? process.cwd(), "docs", ".ccb", "events", "journal.jsonl");
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function assertPayload(condition, issue, issues) {
  if (!condition) issues.push(issue);
}

function normalizeEvent(event) {
  const issues = [];
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new ValidationError("event must be an object", { issues: ["event must be an object"] });
  }
  for (const key of ["type", "subject_type", "subject_id", "emitted_at", "source_actor"]) {
    if (typeof event[key] !== "string" || event[key].trim().length === 0) {
      issues.push(`${key} must be a non-empty string`);
    }
  }
  if (event.idempotency_key !== undefined && (typeof event.idempotency_key !== "string" || event.idempotency_key.trim().length === 0)) {
    issues.push("idempotency_key must be a non-empty string when provided");
  }
  if (event.payload === undefined || event.payload === null || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    issues.push("payload must be an object");
  }
  if (typeof event.emitted_at === "string" && Number.isNaN(new Date(event.emitted_at).getTime())) {
    issues.push("emitted_at must be an ISO8601 datetime string");
  }

  if (issues.length > 0) {
    throw new ValidationError(`invalid EventJournal event: ${issues.join("; ")}`, { issues });
  }

  return {
    type: event.type,
    subject_type: event.subject_type,
    subject_id: event.subject_id,
    payload: event.payload,
    idempotency_key: event.idempotency_key ?? null,
    emitted_at: event.emitted_at,
    source_actor: event.source_actor
  };
}

function normalizeTypedEvent(event, type, payload) {
  const source = isObject(event) ? event : {};
  return {
    type,
    subject_type: source.subject_type ?? source.subjectType,
    subject_id: source.subject_id ?? source.subjectId,
    payload,
    idempotency_key: source.idempotency_key ?? source.idempotencyKey ?? null,
    emitted_at: source.emitted_at ?? source.emittedAt ?? new Date().toISOString(),
    source_actor: source.source_actor ?? source.sourceActor
  };
}

function normalizeCollaborationProfilePayload(payload) {
  const issues = [];
  if (!isObject(payload)) {
    throw new ValidationError("invalid collaboration_profile_decided payload", { issues: ["payload must be an object"] });
  }

  assertPayload(COLLABORATION_TIERS.has(payload.tier), "tier must be full, standard, or lite", issues);
  assertPayload(COLLABORATION_PASSES.has(payload.pass), "pass must be planned or actual", issues);
  assertPayload(isNonEmptyString(payload.risk_basis), "risk_basis must be a non-empty string", issues);
  assertPayload(isStringArray(payload.negative_evidence), "negative_evidence must be a string array", issues);
  assertPayload(Array.isArray(payload.waivers), "waivers must be an array", issues);
  assertPayload(VERIFICATION_MINIMUMS.has(payload.verification_minimum), "verification_minimum is invalid", issues);
  assertPayload(CLASSIFIER_COVERAGE.has(payload.classifier_coverage), "classifier_coverage must be full or partial", issues);
  assertPayload(Array.isArray(payload.semantic_overrides), "semantic_overrides must be an array", issues);

  for (const [index, waiver] of (payload.waivers ?? []).entries()) {
    assertPayload(isObject(waiver), `waivers[${index}] must be an object`, issues);
    if (!isObject(waiver)) continue;
    assertPayload(isNonEmptyString(waiver.action_or_artifact), `waivers[${index}].action_or_artifact must be a non-empty string`, issues);
    assertPayload(isNonEmptyString(waiver.reason), `waivers[${index}].reason must be a non-empty string`, issues);
  }

  for (const [index, override] of (payload.semantic_overrides ?? []).entries()) {
    assertPayload(isObject(override), `semantic_overrides[${index}] must be an object`, issues);
    if (!isObject(override)) continue;
    assertPayload(isNonEmptyString(override.trigger), `semantic_overrides[${index}].trigger must be a non-empty string`, issues);
    assertPayload(SEMANTIC_OVERRIDE_TYPES.has(override.type), `semantic_overrides[${index}].type is invalid`, issues);
  }

  if (payload.evidence_refs !== undefined) {
    assertPayload(isStringArray(payload.evidence_refs), "evidence_refs must be a string array", issues);
  }

  if (issues.length > 0) {
    throw new ValidationError(`invalid collaboration_profile_decided payload: ${issues.join("; ")}`, { issues });
  }
  return payload;
}

function normalizeRiskEnvelopeUpdatedPayload(payload) {
  const issues = [];
  if (!isObject(payload)) {
    throw new ValidationError("invalid risk_envelope_updated payload", { issues: ["payload must be an object"] });
  }

  const surface = payload.surface_ref;
  assertPayload(isObject(surface), "surface_ref must be an object", issues);
  if (isObject(surface)) {
    assertPayload(RISK_SURFACE_TYPES.has(surface.type), "surface_ref.type is invalid", issues);
    assertPayload(isNonEmptyString(surface.id), "surface_ref.id must be a non-empty string", issues);
  }
  assertPayload(RISK_ENVELOPE_STATUSES.has(payload.status), "status must be open, partially_closed, or closed", issues);

  const requiredEvidence = RISK_CLOSE_EVIDENCE_BY_SURFACE.get(surface?.type) ?? [];
  if (payload.status !== "open") {
    assertPayload(isObject(payload.close_evidence), "close_evidence must be an object when status is not open", issues);
  }
  if (payload.status === "partially_closed" && isObject(payload.close_evidence)) {
    const hasAnyEvidence = requiredEvidence.some((field) => isNonEmptyString(payload.close_evidence[field]));
    assertPayload(hasAnyEvidence, "partially_closed close_evidence must include at least one typed evidence ref", issues);
  }
  if (payload.status === "closed" && isObject(payload.close_evidence)) {
    for (const field of requiredEvidence) {
      assertPayload(isNonEmptyString(payload.close_evidence[field]), `close_evidence.${field} must be a non-empty string`, issues);
    }
  }

  if (issues.length > 0) {
    throw new ValidationError(`invalid risk_envelope_updated payload: ${issues.join("; ")}`, { issues });
  }
  return payload;
}

async function journalHasIdempotencyKey(path, idempotencyKey) {
  if (!idempotencyKey) return false;
  let content;
  try {
    content = await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw new IOError(`failed to read EventJournal: ${path}`, { path, cause: error });
  }

  let byteOffset = 0;
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    const lineByteOffset = byteOffset;
    byteOffset += Buffer.byteLength(line, "utf8") + 1;
    if (!line.trim()) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      console.warn(
        `bad EventJournal line skipped at byte offset ${lineByteOffset}: line ${index + 1}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      continue;
    }
    if (parsed?.idempotency_key === idempotencyKey) return true;
  }
  return false;
}

export async function appendEvent(event, options = {}) {
  const normalized = normalizeEvent(event);
  const path = journalPath(options);
  const projectRoot = options.projectRoot ?? process.cwd();
  const failPolicy = options.failPolicy ?? "fail-closed";

  try {
    try {
      await mkdir(dirname(path), { recursive: true });
    } catch (error) {
      throw new IOError(`failed to prepare EventJournal directory: ${path}`, { path, cause: error });
    }

    const result = await withFileLock(path, async () => {
      if (await journalHasIdempotencyKey(path, normalized.idempotency_key)) {
        return { appended: false, duplicate: true, path, event: normalized };
      }

      try {
        await appendFile(path, `${JSON.stringify(normalized)}\n`, "utf8");
        return { appended: true, duplicate: false, path, event: normalized };
      } catch (error) {
        throw new IOError(`failed to append EventJournal: ${path}`, { path, cause: error });
      }
    }, options.lockOptions ?? {});

    if (result.appended) {
      try {
        await notifyEventAppended({
          event: result.event,
          projectRoot,
          journalPath: path
        });
      } catch (error) {
        console.warn(`EventJournal hook notify failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return result;
  } catch (error) {
    if (failPolicy === "warning-only") {
      return { appended: false, failed: true, path, event: normalized, error };
    }
    throw error;
  }
}

export async function appendCollaborationProfileDecided(event, options = {}) {
  const payload = normalizeCollaborationProfilePayload(event?.payload);
  return await appendEvent(normalizeTypedEvent(event, "collaboration_profile_decided", payload), options);
}

export async function appendRiskEnvelopeUpdated(event, options = {}) {
  const payload = normalizeRiskEnvelopeUpdatedPayload(event?.payload);
  return await appendEvent(normalizeTypedEvent(event, "risk_envelope_updated", payload), options);
}
