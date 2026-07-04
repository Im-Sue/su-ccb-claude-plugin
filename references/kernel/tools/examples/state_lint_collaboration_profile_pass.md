---
task_id: fixture-collaboration-profile-pass
current_node: review
status: reviewing
revision: 1
hotfixes_adopted: [decision_escalation_guard]
collaboration_profile:
  ceremony_tier: standard
  classifier_coverage: full
  pass: actual
  consult_required: true
  semantic_overrides:
    - trigger: decision_shape.needs_consult
      type: consult_only
      reason: Low-risk change still has multiple viable approaches.
  artifact_minima:
    requirement: minimal_with_waiver
    technical_design: focused
    dev_task: acceptance_complete
    review: pass_fail_unknown
    archive: evidence_and_residual_risk
  verification_minimum: targeted_plus_edge
  risk_basis: API surface was additive, but review found a compatibility-sensitive route.
  negative_evidence:
    - no money-sink write detected
    - no auth model change detected
  waivers:
    - action_or_artifact: full_e2e
      reason: Covered by route contract test and negative compatibility case.
  evidence_refs:
    - event:collaboration_profile_decided:test
    - test:route-contract
risk_envelope:
  - surface_ref:
      type: api
      id: GET /api/topics
    opened_by: technical_design:fixture
    status: closed
    close_evidence:
      contract_test_ref: test:route-contract
      backward_compat_ref: review:compat-ok
  - surface_ref:
      type: money_sink
      id: point-account
    opened_by: implementation:fixture
    status: partially_closed
    close_evidence:
      invariant_ref: test:point-invariant
---

# Fixture Collaboration Profile Pass
