import assert from "node:assert/strict";
import test from "node:test";

import {
  assertNotLiteWhenPartial,
  classifyGitDiff,
  loadClassifierCorpus,
  loadSinkManifest,
  validateSinkManifest
} from "../index.mjs";

function hasSurface(classification, expected) {
  return classification.touched_surfaces.some((surface) =>
    Object.entries(expected).every(([key, value]) => surface[key] === value)
  );
}

test("L1 classifier satisfies basic corpus expectations", async () => {
  const corpus = await loadClassifierCorpus();
  assert.ok(corpus.cases.length >= 7);

  for (const item of corpus.cases) {
    const classification = classifyGitDiff(item.diff);
    assert.equal(classification.classifier_coverage, item.expected.classifier_coverage, item.id);
    assert.equal(classification.minimum_tier, item.expected.minimum_tier, item.id);
    assertNotLiteWhenPartial(classification);

    if (item.expected.surface) {
      assert.equal(hasSurface(classification, item.expected.surface), true, `${item.id} should include expected surface`);
    }
    if (item.expected.partial_surface) {
      assert.equal(
        classification.coverage.partial_reasons.some((reason) => reason.surface === item.expected.partial_surface),
        true,
        `${item.id} should include expected partial reason`
      );
    }
  }
});

test("L1 classifies CREATE, nullable ADD and new controller as additive", () => {
  const diff = [
    "diff --git a/sql/init.sql b/sql/init.sql",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/sql/init.sql",
    "@@ -0,0 +1,3 @@",
    "+CREATE TABLE demo_topic (id bigint NOT NULL);",
    "+ALTER TABLE demo_topic ADD COLUMN title varchar(128) NULL;",
    "diff --git a/src/main/java/com/acme/controller/DemoController.java b/src/main/java/com/acme/controller/DemoController.java",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/main/java/com/acme/controller/DemoController.java",
    "@@ -0,0 +1,3 @@",
    "+public class DemoController {}"
  ].join("\n");

  const result = classifyGitDiff(diff);
  assert.equal(result.classifier_coverage, "full");
  assert.equal(result.minimum_tier, "lite");
  assert.equal(hasSurface(result, { type: "table", change: "additive", floor: "lite", source: "l1.sql.create_table" }), true);
  assert.equal(hasSurface(result, { type: "table", change: "additive", floor: "lite", source: "l1.sql.alter_add_nullable" }), true);
  assert.equal(hasSurface(result, { type: "api", change: "additive", floor: "lite", source: "l1.path.new_controller" }), true);
});

test("L1 floors breaking SQL, *-api and existing method signature changes to full", () => {
  const diff = [
    "diff --git a/sql/migration.sql b/sql/migration.sql",
    "index 1111111..2222222 100644",
    "--- a/sql/migration.sql",
    "+++ b/sql/migration.sql",
    "@@ -1 +1 @@",
    "+ALTER TABLE demo_topic MODIFY COLUMN title varchar(32) NOT NULL;",
    "diff --git a/yudao-module-demo-api/src/main/java/com/acme/api/DemoApi.java b/yudao-module-demo-api/src/main/java/com/acme/api/DemoApi.java",
    "index 1111111..2222222 100644",
    "--- a/yudao-module-demo-api/src/main/java/com/acme/api/DemoApi.java",
    "+++ b/yudao-module-demo-api/src/main/java/com/acme/api/DemoApi.java",
    "@@ -1 +1 @@",
    "+public interface DemoApi {}",
    "diff --git a/src/main/java/com/acme/controller/DemoController.java b/src/main/java/com/acme/controller/DemoController.java",
    "index 1111111..2222222 100644",
    "--- a/src/main/java/com/acme/controller/DemoController.java",
    "+++ b/src/main/java/com/acme/controller/DemoController.java",
    "@@ -1 +1 @@",
    "-public DemoResp getDemo(Long id) {",
    "+public DemoResp getDemo(Long id, Boolean detail) {"
  ].join("\n");

  const result = classifyGitDiff(diff);
  assert.equal(result.minimum_tier, "full");
  assert.equal(hasSurface(result, { type: "table", change: "breaking", floor: "full", source: "l1.sql.alter_breaking" }), true);
  assert.equal(hasSurface(result, { type: "api", change: "breaking", floor: "full", source: "l1.path.api_package" }), true);
  assert.equal(hasSurface(result, { type: "api", change: "breaking", floor: "full", source: "l1.java.method_signature" }), true);
});

test("SQL/MyBatis L2 redline fixtures are classified and do not remain partial", async () => {
  const corpus = await loadClassifierCorpus();
  for (const id of ["l2_alter_add_not_null_default_standard", "l2_create_unique_index_standard"]) {
    const item = corpus.cases.find((candidate) => candidate.id === id);
    assert.ok(item, `missing corpus case ${id}`);
    const result = classifyGitDiff(item.diff);
    assert.notEqual(result.minimum_tier, "lite", `${id} must not be lite`);
    assert.equal(result.classifier_coverage, "full", `${id} should be resolved by L2-A`);
    assert.equal(result.coverage.partial_reasons.length, 0, `${id} should not leave partial coverage`);
  }
});

test("classifier_coverage partial floors unresolved non-SQL semantic surfaces to standard", () => {
  const diff = [
    "diff --git a/config/application.yaml b/config/application.yaml",
    "index 1111111..2222222 100644",
    "--- a/config/application.yaml",
    "+++ b/config/application.yaml",
    "@@ -1 +1 @@",
    "+amount-threshold: 1000"
  ].join("\n");

  const result = classifyGitDiff(diff);
  assert.equal(result.classifier_coverage, "partial");
  assert.equal(result.coverage.can_be_lite, false);
  assert.equal(result.coverage.floor, "standard");
  assert.equal(result.minimum_tier, "standard");
  assert.equal(assertNotLiteWhenPartial(result), true);
});

test("MyBatis XML scanner classifies dynamic SQL and resultMap without partial coverage", () => {
  const diff = [
    "diff --git a/src/main/resources/mapper/TopicMapper.xml b/src/main/resources/mapper/TopicMapper.xml",
    "index 1111111..2222222 100644",
    "--- a/src/main/resources/mapper/TopicMapper.xml",
    "+++ b/src/main/resources/mapper/TopicMapper.xml",
    "@@ -1,4 +1,9 @@",
    "+<resultMap id=\"TopicMap\" type=\"TopicDO\">",
    "+  <id column=\"id\" property=\"id\" />",
    "+  <result column=\"name\" property=\"name\" />",
    "+</resultMap>",
    "+<select id=\"selectTopics\" resultMap=\"TopicMap\">",
    "+  <where><if test=\"name != null\">name = #{name}</if></where>",
    "+</select>"
  ].join("\n");

  const result = classifyGitDiff(diff);
  assert.equal(result.classifier_coverage, "full");
  assert.equal(result.minimum_tier, "standard");
  assert.equal(hasSurface(result, { type: "table", change: "mapper_result_map", floor: "standard", source: "l2.mybatis.result_map" }), true);
  assert.equal(hasSurface(result, { type: "table", change: "mapper_dynamic_sql", floor: "standard", source: "l2.mybatis.dynamic_sql" }), true);
});

test("yudao sink_manifest loads and validates service/table/api/event/topic annotations", async () => {
  const manifest = await loadSinkManifest();
  const validation = validateSinkManifest(manifest);
  assert.equal(validation.ok, true, validation.issues.join("; "));

  const sinkIds = new Set(manifest.sinks.map((sink) => sink.sink_id));
  for (const expected of ["wallet", "order", "settlement", "point-account", "ledger", "freeze", "refund"]) {
    assert.equal(sinkIds.has(expected), true, `missing sink ${expected}`);
  }
  for (const sink of manifest.sinks) {
    assert.ok(sink.service.length > 0, `${sink.sink_id} service annotations`);
    assert.ok(sink.table.length > 0, `${sink.sink_id} table annotations`);
    assert.ok(sink.api.length > 0, `${sink.sink_id} api annotations`);
    assert.ok(sink.event.length > 0, `${sink.sink_id} event annotations`);
    assert.ok(sink.topic.length > 0, `${sink.sink_id} topic annotations`);
  }
});

test("sink_manifest validator rejects malformed manifests", () => {
  const validation = validateSinkManifest({
    schema_version: "sink-manifest-v0.1",
    project_family: "bad",
    sinks: [
      {
        sink_id: "wallet",
        domain: "wallet",
        default_action: "unsafe",
        service: [],
        table: [],
        api: [],
        event: [],
        topic: []
      }
    ]
  });
  assert.equal(validation.ok, false);
  assert.ok(validation.issues.some((issue) => issue.includes("default_action")));
});
