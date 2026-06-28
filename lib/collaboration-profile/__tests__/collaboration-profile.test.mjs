import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { resolveAndAppendCollaborationProfile, resolveCollaborationProfile } from "../index.mjs";

async function tempProject() {
  const root = join(tmpdir(), `ccb-collaboration-profile-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  return root;
}

function diff(lines) {
  return lines.join("\n");
}

test("needs_consult adds consult_only without raising lite tier", () => {
  const result = resolveCollaborationProfile({
    subject_id: "subtask-lite-consult",
    diff: "",
    signals: {
      decision_shape: { needs_consult: true, multi_options: true },
      scope_assessment: { complexity: "simple", impact: "local_reversible", red_flags: [] }
    }
  });

  assert.equal(result.collaboration_profile.ceremony_tier, "lite");
  assert.equal(result.collaboration_profile.consult_required, true);
  assert.equal(result.collaboration_profile.semantic_overrides.length, 1);
  assert.equal(result.collaboration_profile.semantic_overrides[0].type, "consult_only");
  assert.equal(result.collaboration_profile.verification_minimum, "static");
});

test("open red flags and hard-list surfaces use tier_floor", () => {
  const redFlagOnly = resolveCollaborationProfile({
    subject_id: "subtask-red-flag",
    diff: "",
    signals: {
      open_red_flags: ["auth model unclear"],
      decision_shape: { needs_consult: true }
    }
  });

  assert.equal(redFlagOnly.collaboration_profile.ceremony_tier, "full");
  assert.equal(
    redFlagOnly.collaboration_profile.semantic_overrides.some((override) => override.trigger === "open_red_flags" && override.type === "tier_floor"),
    true
  );

  const apiBreak = resolveCollaborationProfile({
    subject_id: "subtask-api-break",
    diff: diff([
      "diff --git a/yudao-module-demo-api/src/main/java/com/acme/api/DemoApi.java b/yudao-module-demo-api/src/main/java/com/acme/api/DemoApi.java",
      "index 1111111..2222222 100644",
      "--- a/yudao-module-demo-api/src/main/java/com/acme/api/DemoApi.java",
      "+++ b/yudao-module-demo-api/src/main/java/com/acme/api/DemoApi.java",
      "@@ -1 +1 @@",
      "+public interface DemoApi {}"
    ])
  });
  assert.equal(apiBreak.collaboration_profile.ceremony_tier, "full");
  assert.equal(
    apiBreak.collaboration_profile.semantic_overrides.some((override) => override.trigger === "hard_list_surface" && override.type === "tier_floor"),
    true
  );
});

test("actual pass only upgrades when actual diff exceeds planned profile", () => {
  const result = resolveCollaborationProfile({
    subject_id: "subtask-actual-upgrade",
    pass: "actual",
    planned_profile: { ceremony_tier: "lite" },
    diff: diff([
      "diff --git a/src/main/java/com/acme/service/TaskServiceImpl.java b/src/main/java/com/acme/service/TaskServiceImpl.java",
      "index 1111111..2222222 100644",
      "--- a/src/main/java/com/acme/service/TaskServiceImpl.java",
      "+++ b/src/main/java/com/acme/service/TaskServiceImpl.java",
      "@@ -1,4 +1,5 @@",
      " public class TaskServiceImpl {",
      "+  public void complete(Long userId) { pointApi.addPoint(userId, 10); }",
      " }"
    ])
  });

  assert.equal(result.collaboration_profile.pass, "actual");
  assert.equal(result.collaboration_profile.ceremony_tier, "standard");
  assert.equal(result.upgraded_from_planned, true);
  assert.equal(
    result.collaboration_profile.semantic_overrides.some((override) => override.trigger === "actual_diff_exceeds_planned" && override.type === "tier_floor"),
    true
  );
});

test("risk_envelope open surfaces floor downstream tier until typed close evidence is complete", () => {
  const openEnvelope = [
    {
      surface_ref: { type: "money_sink", id: "point-account" },
      opened_by: "subtask-build-settlement",
      status: "open",
      floor: "full"
    }
  ];
  const downstream = resolveCollaborationProfile({
    subject_id: "subtask-use-settlement",
    diff: "",
    risk_envelope: openEnvelope
  });
  assert.equal(downstream.collaboration_profile.ceremony_tier, "full");

  const partiallyClosed = resolveCollaborationProfile({
    subject_id: "subtask-use-settlement",
    diff: "",
    risk_envelope: openEnvelope,
    close_evidence: {
      "money_sink:point-account": { invariant_ref: "test:invariant" }
    }
  });
  assert.equal(partiallyClosed.risk_envelope[0].status, "partially_closed");
  assert.equal(partiallyClosed.collaboration_profile.ceremony_tier, "full");

  const closed = resolveCollaborationProfile({
    subject_id: "subtask-use-settlement",
    diff: "",
    risk_envelope: openEnvelope,
    close_evidence: {
      "money_sink:point-account": {
        invariant_ref: "test:invariant",
        idempotency_ref: "test:idempotency",
        reconciliation_ref: "test:reconciliation"
      }
    }
  });
  assert.equal(closed.risk_envelope[0].status, "closed");
  assert.equal(closed.collaboration_profile.ceremony_tier, "lite");
});

test("resolver writes collaboration profile and risk envelope events", async () => {
  const projectRoot = await tempProject();
  try {
    const result = await resolveAndAppendCollaborationProfile(
      {
        subject_type: "subtask",
        subject_id: "subtask-event",
        source_actor: "ccb_codex",
        pass: "planned",
        diff: diff([
          "diff --git a/src/main/java/com/acme/service/TaskServiceImpl.java b/src/main/java/com/acme/service/TaskServiceImpl.java",
          "index 1111111..2222222 100644",
          "--- a/src/main/java/com/acme/service/TaskServiceImpl.java",
          "+++ b/src/main/java/com/acme/service/TaskServiceImpl.java",
          "@@ -1,4 +1,5 @@",
          " public class TaskServiceImpl {",
          "+  public void complete(Long userId) { pointApi.addPoint(userId, 10); }",
          " }"
        ])
      },
      { projectRoot }
    );

    assert.equal(result.events.profile.appended, true);
    assert.equal(result.events.risk_envelope.length, 1);
    assert.equal(result.events.risk_envelope[0].appended, true);

    const journal = await readFile(join(projectRoot, "docs", ".ccb", "events", "journal.jsonl"), "utf8");
    const events = journal.trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.type), ["collaboration_profile_decided", "risk_envelope_updated"]);
    assert.equal(events[0].payload.tier, "standard");
    assert.equal(events[0].payload.classifier_coverage, "full");
    assert.equal(events[1].payload.surface_ref.type, "money_sink");
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
