import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { loadClassifierCorpus } from "../../collaboration-classifier/index.mjs";
import { resolveCollaborationProfile } from "../index.mjs";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const GOLDEN_DISTRIBUTION_PATH = join(pluginRoot, "references", "kernel", "classifier", "corpus", "golden-distribution.json");

async function loadGoldenDistribution() {
  const corpus = JSON.parse(await readFile(GOLDEN_DISTRIBUTION_PATH, "utf8"));
  assert.equal(corpus.schema_version, "classifier-golden-v0.1");
  return corpus.cases.map((item) => ({
    ...item,
    diff: item.diff_lines.join("\n")
  }));
}

function distributionFor(cases) {
  const counts = { lite: 0, standard: 0, full: 0 };
  const results = [];
  for (const item of cases) {
    const result = resolveCollaborationProfile({ subject_id: item.id, diff: item.diff });
    const tier = result.collaboration_profile.ceremony_tier;
    counts[tier] += 1;
    results.push({ id: item.id, expected: item.expected_tier, actual: tier });
  }
  return { counts, results };
}

test("golden distribution stays non-collapsed across lite/standard/full", async () => {
  const cases = await loadGoldenDistribution();
  assert.ok(cases.length >= 12);

  const { counts, results } = distributionFor(cases);
  for (const result of results) {
    assert.equal(result.actual, result.expected, `${result.id} expected ${result.expected} got ${result.actual}`);
  }

  assert.ok(counts.lite >= 3, `expected at least 3 lite cases, got ${counts.lite}`);
  assert.ok(counts.standard >= 3, `expected at least 3 standard cases, got ${counts.standard}`);
  assert.ok(counts.full >= 3, `expected at least 3 full cases, got ${counts.full}`);
  assert.notEqual(counts.full, cases.length, "golden distribution collapsed to all full");
  assert.notEqual(counts.lite, cases.length, "golden distribution collapsed to all lite");
  console.log(`golden distribution: lite=${counts.lite} standard=${counts.standard} full=${counts.full} total=${cases.length}`);
});

test("actual pass upgrades when planned lite diff later touches money-sink", async () => {
  const cases = await loadGoldenDistribution();
  const moneyWrite = cases.find((item) => item.id === "golden_money_write_sql_full");
  assert.ok(moneyWrite);

  const result = resolveCollaborationProfile({
    subject_id: "golden-actual-upgrade",
    pass: "actual",
    planned_profile: { ceremony_tier: "lite" },
    diff: moneyWrite.diff
  });

  assert.equal(result.collaboration_profile.pass, "actual");
  assert.equal(result.collaboration_profile.ceremony_tier, "full");
  assert.equal(result.upgraded_from_planned, true);
  assert.equal(
    result.collaboration_profile.semantic_overrides.some((override) => override.trigger === "actual_diff_exceeds_planned" && override.type === "tier_floor"),
    true
  );
});

test("risk_envelope table surface only downgrades after complete typed close_evidence", () => {
  const openEnvelope = [
    {
      surface_ref: { type: "table", id: "market_settlement" },
      opened_by: "subtask-create-settlement-table",
      status: "open",
      floor: "full"
    }
  ];

  const open = resolveCollaborationProfile({ subject_id: "golden-envelope-open", diff: "", risk_envelope: openEnvelope });
  assert.equal(open.collaboration_profile.ceremony_tier, "full");

  const partial = resolveCollaborationProfile({
    subject_id: "golden-envelope-partial",
    diff: "",
    risk_envelope: openEnvelope,
    close_evidence: {
      "table:market_settlement": { migration_verified_ref: "test:migration-ok" }
    }
  });
  assert.equal(partial.risk_envelope[0].status, "partially_closed");
  assert.equal(partial.collaboration_profile.ceremony_tier, "full");

  const closed = resolveCollaborationProfile({
    subject_id: "golden-envelope-closed",
    diff: "",
    risk_envelope: openEnvelope,
    close_evidence: {
      "table:market_settlement": {
        migration_verified_ref: "test:migration-ok",
        rollback_or_compat_ref: "review:compat-ok"
      }
    }
  });
  assert.equal(closed.risk_envelope[0].status, "closed");
  assert.equal(closed.collaboration_profile.ceremony_tier, "lite");
});

test("anti-laundering summary fixtures never resolve to lite", async () => {
  const corpus = await loadClassifierCorpus();
  const ids = [
    "l2_alter_add_not_null_default_standard",
    "l2_shadow_route_standard",
    "l2_mq_indirect_money_standard",
    "l2_reflection_unresolved_sink_standard"
  ];

  const summary = [];
  for (const id of ids) {
    const item = corpus.cases.find((candidate) => candidate.id === id);
    assert.ok(item, `missing basic corpus fixture ${id}`);
    const result = resolveCollaborationProfile({ subject_id: id, diff: item.diff });
    const tier = result.collaboration_profile.ceremony_tier;
    summary.push(`${id}:${tier}/${result.collaboration_profile.classifier_coverage}`);
    assert.notEqual(tier, "lite", `${id} must not resolve to lite`);
  }
  console.log(`anti-laundering summary: ${summary.join(", ")}`);
});
