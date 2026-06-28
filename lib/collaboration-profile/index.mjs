import { appendCollaborationProfileDecided, appendRiskEnvelopeUpdated } from "../runtime/index.mjs";
import { classifyGitDiff } from "../collaboration-classifier/index.mjs";

const TIER_RANK = { lite: 0, standard: 1, full: 2 };
const RANK_TIER = ["lite", "standard", "full"];
const ENVELOPE_TYPES = new Set(["table", "api", "money_sink", "permission_scope"]);
const CLOSE_EVIDENCE_BY_SURFACE = new Map([
  ["table", ["migration_verified_ref", "rollback_or_compat_ref"]],
  ["api", ["contract_test_ref", "backward_compat_ref"]],
  ["money_sink", ["invariant_ref", "idempotency_ref", "reconciliation_ref"]],
  ["permission_scope", ["authz_matrix_ref", "privilege_negative_test_ref"]]
]);

export const ARTIFACT_MINIMA = Object.freeze({
  requirement: "one_line_goal_plus_risk_basis",
  technical_design: "tradeoff_and_risk_or_explicit_waiver",
  dev_task: "goal_scope_forbidden_acceptance",
  review: "pass_fail_unknown_per_item",
  archive: "completion_evidence_uncovered_items_residual_risk"
});

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function maxTier(...tiers) {
  const rank = tiers.reduce((current, tier) => Math.max(current, TIER_RANK[tier] ?? 0), 0);
  return RANK_TIER[rank];
}

function normalizeTier(value, fallback = "lite") {
  return Object.hasOwn(TIER_RANK, value) ? value : fallback;
}

function tierFromVerification(verification) {
  if (verification === "full") return "full";
  if (verification === "integration" || verification === "targeted_plus_edge") return "standard";
  return "lite";
}

function surfaceRef(surface) {
  if (!surface || !ENVELOPE_TYPES.has(surface.type)) return null;
  return { type: surface.type, id: String(surface.id ?? "unknown") };
}

function surfaceKey(ref) {
  return `${ref?.type ?? "unknown"}:${ref?.id ?? "unknown"}`;
}

function defaultEnvelopeFloor(type) {
  if (type === "money_sink" || type === "permission_scope") return "full";
  return "standard";
}

function envelopeFloor(item) {
  return normalizeTier(item?.floor, defaultEnvelopeFloor(item?.surface_ref?.type));
}

function isClosed(item) {
  return item?.status === "closed";
}

function hasAnyCloseEvidence(type, evidence) {
  if (!isObject(evidence)) return false;
  const required = CLOSE_EVIDENCE_BY_SURFACE.get(type) ?? [];
  return required.some((field) => typeof evidence[field] === "string" && evidence[field].trim().length > 0);
}

function hasAllCloseEvidence(type, evidence) {
  if (!isObject(evidence)) return false;
  const required = CLOSE_EVIDENCE_BY_SURFACE.get(type) ?? [];
  return required.length > 0 && required.every((field) => typeof evidence[field] === "string" && evidence[field].trim().length > 0);
}

function normalizeCloseEvidence(closeEvidence) {
  if (Array.isArray(closeEvidence)) {
    return new Map(
      closeEvidence
        .filter((item) => isObject(item) && isObject(item.surface_ref))
        .map((item) => [surfaceKey(item.surface_ref), item.close_evidence ?? {}])
    );
  }
  if (!isObject(closeEvidence)) return new Map();
  return new Map(Object.entries(closeEvidence));
}

function applyCloseEvidence(envelope, closeEvidence) {
  const evidenceBySurface = normalizeCloseEvidence(closeEvidence);
  return (Array.isArray(envelope) ? envelope : []).map((item) => {
    if (!isObject(item) || !isObject(item.surface_ref)) return item;
    if (isClosed(item)) return item;
    const evidence = evidenceBySurface.get(surfaceKey(item.surface_ref));
    if (!evidence) return item;
    const type = item.surface_ref.type;
    if (hasAllCloseEvidence(type, evidence)) {
      return { ...item, status: "closed", close_evidence: evidence };
    }
    if (hasAnyCloseEvidence(type, evidence)) {
      return { ...item, status: "partially_closed", close_evidence: evidence };
    }
    return item;
  });
}

function envelopeOpenTier(envelope) {
  return (Array.isArray(envelope) ? envelope : [])
    .filter((item) => isObject(item) && !isClosed(item))
    .reduce((tier, item) => maxTier(tier, envelopeFloor(item)), "lite");
}

function envelopeEvents(beforeEnvelope, afterEnvelope) {
  const before = new Map((Array.isArray(beforeEnvelope) ? beforeEnvelope : []).map((item) => [surfaceKey(item.surface_ref), item]));
  return (Array.isArray(afterEnvelope) ? afterEnvelope : []).filter((item) => {
    const previous = before.get(surfaceKey(item.surface_ref));
    return !previous || previous.status !== item.status || JSON.stringify(previous.close_evidence ?? {}) !== JSON.stringify(item.close_evidence ?? {});
  });
}

function shouldCarrySurface(surface) {
  if (!surfaceRef(surface)) return false;
  return TIER_RANK[normalizeTier(surface.floor)] >= TIER_RANK.standard;
}

function addCurrentSurfacesToEnvelope(envelope, surfaces, openedBy) {
  const result = [...(Array.isArray(envelope) ? envelope : [])];
  const existing = new Set(result.map((item) => surfaceKey(item.surface_ref)));

  for (const surface of surfaces.filter(shouldCarrySurface)) {
    const ref = surfaceRef(surface);
    const key = surfaceKey(ref);
    if (existing.has(key)) continue;
    existing.add(key);
    result.push({
      surface_ref: ref,
      opened_by: openedBy,
      status: "open",
      floor: normalizeTier(surface.floor, defaultEnvelopeFloor(ref.type)),
      opened_reason: surface.source
    });
  }
  return result;
}

function redFlagsFromSignals(signals) {
  const scopeFlags = Array.isArray(signals?.scope_assessment?.red_flags) ? signals.scope_assessment.red_flags : [];
  const openFlags = Array.isArray(signals?.open_red_flags) ? signals.open_red_flags : [];
  return [...scopeFlags, ...openFlags].filter((flag) => {
    if (!flag) return false;
    if (isObject(flag) && flag.status && flag.status !== "open") return false;
    return true;
  });
}

function hasDecisionRecordNeed(decisionShape = {}) {
  return Boolean(
    decisionShape.needs_decision_record ||
      decisionShape.decision_record_required ||
      decisionShape.naming_decision ||
      decisionShape.testing_strategy_decision ||
      decisionShape.consistency_decision ||
      decisionShape.naming_or_test_strategy ||
      (Array.isArray(decisionShape.decision_record_reasons) && decisionShape.decision_record_reasons.length > 0)
  );
}

function scopeTier(scope = {}) {
  if (scope.impact === "design_affecting" || scope.complexity === "complex") return "standard";
  return "lite";
}

function dispatchTier(signals = {}) {
  const risk = signals.dispatch?.risk_level ?? signals.dispatch_risk_level ?? signals.risk_level;
  if (risk === "high" || risk === "full") return "full";
  if (risk === "medium" || risk === "standard") return "standard";
  return "lite";
}

function hardListSurfaces(surfaces) {
  return surfaces.filter((surface) => normalizeTier(surface.floor) === "full");
}

function semanticOverrides({ signals, surfaces, actualExceedsPlanned }) {
  const overrides = [];
  const decisionShape = signals?.decision_shape ?? {};
  if (decisionShape.needs_consult || decisionShape.multi_options) {
    overrides.push({
      trigger: "decision_shape.needs_consult",
      type: "consult_only",
      reason: "低危但存在多方案或需要拍板，强制打开 consult，不抬档"
    });
  }
  if (hasDecisionRecordNeed(decisionShape)) {
    overrides.push({
      trigger: "decision_shape.decision_record",
      type: "consult_plus_decision_record",
      reason: "命名、测试策略或一致性决策需要留下 decision_record"
    });
  }

  const redFlags = redFlagsFromSignals(signals);
  if (redFlags.length > 0) {
    overrides.push({
      trigger: "open_red_flags",
      type: "tier_floor",
      reason: `open red flags require tier floor: ${redFlags.map(String).join(", ")}`
    });
  }

  const hardSurfaces = hardListSurfaces(surfaces);
  if (hardSurfaces.length > 0) {
    overrides.push({
      trigger: "hard_list_surface",
      type: "tier_floor",
      reason: `hard-list surfaces require full floor: ${hardSurfaces.map((surface) => `${surface.type}:${surface.id}`).join(", ")}`
    });
  }

  if (actualExceedsPlanned) {
    overrides.push({
      trigger: "actual_diff_exceeds_planned",
      type: "tier_floor",
      reason: "actual diff touched higher-risk surface than planned profile; only-upgrade rule applied"
    });
  }

  return overrides;
}

function verificationMinimum(tier, classification, surfaces) {
  if (tier === "full") return "full";
  if (tier === "standard") {
    if (surfaces.some((surface) => surface.type === "money_sink" || surface.type === "permission_scope")) {
      return "integration";
    }
    return "targeted_plus_edge";
  }
  if (classification.files_analyzed.length === 0) return "static";
  return "targeted";
}

function evidenceRefs(input, classification) {
  const refs = Array.isArray(input.evidence_refs) ? [...input.evidence_refs] : [];
  if (typeof input.diff_ref === "string" && input.diff_ref.trim()) refs.push(input.diff_ref);
  refs.push(...classification.files_analyzed.map((path) => `diff:${path}`));
  return [...new Set(refs)];
}

function riskBasis({ localTier, effectiveTier, classification, surfaces, overrides, envelopeTier, plannedTier }) {
  const surfaceSummary = surfaces.length > 0 ? surfaces.map((surface) => `${surface.type}:${surface.change}:${surface.floor}`).join(", ") : "no classifier surface";
  const overrideSummary = overrides.length > 0 ? `; overrides=${overrides.map((item) => `${item.trigger}/${item.type}`).join(", ")}` : "";
  const envelopeSummary = envelopeTier !== "lite" ? `; open_envelope_floor=${envelopeTier}` : "";
  const plannedSummary = plannedTier ? `; planned_floor=${plannedTier}` : "";
  return `local=${localTier}, effective=${effectiveTier}, classifier=${classification.classifier_coverage}, surfaces=[${surfaceSummary}]${overrideSummary}${envelopeSummary}${plannedSummary}`;
}

function eventPayloadFromProfile(profile, result) {
  return {
    tier: profile.ceremony_tier,
    ceremony_tier: profile.ceremony_tier,
    pass: profile.pass,
    risk_basis: profile.risk_basis,
    negative_evidence: profile.negative_evidence,
    waivers: profile.waivers,
    verification_minimum: profile.verification_minimum,
    classifier_coverage: profile.classifier_coverage,
    semantic_overrides: profile.semantic_overrides,
    artifact_minima: profile.artifact_minima,
    consult_required: profile.consult_required,
    evidence_refs: profile.evidence_refs,
    touched_surfaces: result.classification.touched_surfaces,
    local_tier: result.local_tier,
    effective_tier: result.effective_tier,
    upgraded_from_planned: result.upgraded_from_planned
  };
}

export function resolveCollaborationProfile(input = {}) {
  const pass = input.pass === "actual" ? "actual" : "planned";
  const subjectId = input.subject_id ?? input.subjectId ?? "unknown-subject";
  const openedBy = input.opened_by ?? `collaboration.profile:${subjectId}:${pass}`;
  const classification = input.classification ?? classifyGitDiff(input.diff ?? "");
  const surfaces = classification.touched_surfaces ?? [];
  const baseLocalTier = maxTier(classification.minimum_tier, scopeTier(input.signals?.scope_assessment), dispatchTier(input.signals));
  const plannedTier = input.planned_profile?.ceremony_tier ?? input.plannedProfile?.ceremony_tier ?? null;
  const actualExceedsPlanned = pass === "actual" && plannedTier && TIER_RANK[baseLocalTier] > TIER_RANK[plannedTier];
  const plannedFloor = pass === "actual" && plannedTier ? plannedTier : "lite";
  const overrides = semanticOverrides({ signals: input.signals ?? {}, surfaces, actualExceedsPlanned });
  const overrideTier = overrides.some((override) => override.trigger === "open_red_flags" || override.trigger === "hard_list_surface") ? "full" : "lite";
  const closedEnvelope = applyCloseEvidence(input.risk_envelope ?? input.riskEnvelope ?? [], input.close_evidence ?? input.closeEvidence);
  const envelopeWithCurrent = addCurrentSurfacesToEnvelope(closedEnvelope, surfaces, openedBy);
  const envelopeTier = envelopeOpenTier(envelopeWithCurrent);
  const localTier = maxTier(baseLocalTier, plannedFloor, overrideTier, tierFromVerification(input.verification_minimum));
  const effectiveTier = maxTier(localTier, envelopeTier);
  const verification = input.verification_minimum ?? verificationMinimum(effectiveTier, classification, surfaces);
  const consultRequired = effectiveTier !== "lite" || overrides.some((override) => override.type === "consult_only" || override.type === "consult_plus_decision_record");

  const profile = {
    ceremony_tier: effectiveTier,
    classifier_coverage: classification.classifier_coverage,
    pass,
    consult_required: consultRequired,
    semantic_overrides: overrides,
    artifact_minima: { ...ARTIFACT_MINIMA },
    verification_minimum: verification,
    risk_basis: riskBasis({
      localTier,
      effectiveTier,
      classification,
      surfaces,
      overrides,
      envelopeTier,
      plannedTier: pass === "actual" ? plannedTier : null
    }),
    negative_evidence: [
      ...(classification.negative_evidence ?? []),
      ...(redFlagsFromSignals(input.signals ?? {}).length === 0 ? ["no open red flags in input signals"] : [])
    ],
    waivers: Array.isArray(input.waivers) ? input.waivers : [],
    evidence_refs: evidenceRefs(input, classification)
  };

  return {
    collaboration_profile: profile,
    risk_envelope: envelopeWithCurrent,
    classification,
    local_tier: localTier,
    effective_tier: effectiveTier,
    envelope_updates: envelopeEvents(input.risk_envelope ?? input.riskEnvelope ?? [], envelopeWithCurrent),
    upgraded_from_planned: actualExceedsPlanned
  };
}

export async function resolveAndAppendCollaborationProfile(input = {}, options = {}) {
  const result = resolveCollaborationProfile(input);
  const subjectType = input.subject_type ?? input.subjectType ?? "subtask";
  const subjectId = input.subject_id ?? input.subjectId ?? "unknown-subject";
  const sourceActor = input.source_actor ?? input.sourceActor ?? "collaboration.profile";
  const pass = result.collaboration_profile.pass;
  const idPrefix = input.idempotency_key_prefix ?? `collaboration-profile:${subjectId}:${pass}`;
  const profileEvent = await appendCollaborationProfileDecided(
    {
      subject_type: subjectType,
      subject_id: subjectId,
      source_actor: sourceActor,
      idempotency_key: `${idPrefix}:decided`,
      payload: eventPayloadFromProfile(result.collaboration_profile, result)
    },
    options
  );

  const envelopeEventsWritten = [];
  for (const item of result.envelope_updates) {
    const ref = item.surface_ref;
    const key = surfaceKey(ref).replace(/[^A-Za-z0-9_.:-]/g, "_");
    envelopeEventsWritten.push(
      await appendRiskEnvelopeUpdated(
        {
          subject_type: subjectType,
          subject_id: subjectId,
          source_actor: sourceActor,
          idempotency_key: `${idPrefix}:risk-envelope:${key}:${item.status}`,
          payload: {
            surface_ref: ref,
            status: item.status,
            close_evidence: item.close_evidence,
            floor: item.floor,
            opened_by: item.opened_by
          }
        },
        options
      )
    );
  }

  return { ...result, events: { profile: profileEvent, risk_envelope: envelopeEventsWritten } };
}
