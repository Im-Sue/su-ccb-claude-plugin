import assert from "node:assert/strict";
import test from "node:test";

import { validateAnchorDispatch } from "../../anchor-dispatch/generated-validator.mjs";
import { validateBreakdownDraft } from "../../breakdown-draft/generated-validator.mjs";
import { validateDocsStructureContract } from "../../docs-structure-contract/generated-validator.mjs";
import { validateDevTask } from "../../subtask/generated-validator.mjs";

function validBreakdownDraft() {
  return {
    schema_version: "breakdown-draft-v0.2",
    status: "draft",
    requirement_id: "req-1",
    carrier_task_id: "req-1",
    carrier_task_key: "Generated validator",
    base_task_revision: 0,
    generated_at: "2026-05-22T12:00:00.000Z",
    updated_at: "2026-05-22T12:00:00.000Z",
    generated_by: "ai_session",
    generation_source: {
      cc_agent: "ccb_claude",
      cx_agent: "ccb_codex",
      ccb_job_id: "job_123"
    },
    plan: {
      title: "Plan title",
      summary: "Plan summary",
      spec_outline_md: "## Outline\n\n- Keep the generated validator focused."
    },
    subtasks: [
      {
        section_id: "pr1-generated-validator",
        order: 1,
        title: "Generated validator",
        summary: "Check generated validator behavior.",
        spec_section_md: "## Generated validator\n\n- Check generated validator behavior.",
        priority: "high",
        implementation_owner: "ccb_codex",
        dependencies: [],
        include: true
      }
    ]
  };
}

function nestedObject(depth) {
  let value = {};
  for (let index = 0; index < depth; index += 1) {
    value = { child: value };
  }
  return value;
}

function validDocsStructureContract() {
  return {
    version: "docs-structure-contract-v0.1",
    adr: "ADR-0037",
    human_docs: {
      root: "docs/",
      naming_default: "<模块/主题>-<文档类型>.md",
      entries: [
        {
          path: "02_需求设计/",
          doc_type: "requirement"
        },
        {
          path: "03_开发计划/",
          doc_types: ["technical_design", "dev_task"]
        }
      ],
      view_split: {
        reference_views: [],
        integrated_views: ["requirement", "technical_design", "dev_task"]
      }
    },
    machine_layer: {
      root: "docs/.ccb/",
      holds: [],
      not_holds: []
    },
    entity_status: {
      requirement: {
        doc_types: ["requirement"],
        kind: "requirement_lifecycle",
        fields: ["status"],
        values: ["drafting", "planning"]
      },
      task_subtask: {
        doc_types: ["dev_task"],
        kind: "task_workflow",
        fields: ["current_node", "status"],
        values: {
          current_node: ["dispatch"],
          status: ["reviewing"]
        }
      },
      adr: {
        doc_types: [],
        kind: "adr_decision",
        fields: ["status"],
        values: ["accepted"]
      }
    },
    documents: {
      requirement_bound: {
        doc_types: ["technical_design", "dev_task"],
        must_have: ["doc_type", "requirement_id"],
        status: "entity_or_follows_requirement"
      },
      evergreen: {
        doc_types: [],
        must_have: ["doc_type", "updated"],
        status: "none"
      },
      archive_index: {
        doc_types: [],
        must_have: ["doc_type", "updated"],
        status: "none"
      },
      health: ["parseStatus", "link_validity", "stale"]
    },
    truth_model: {},
    maintenance: {}
  };
}

test("plugin generated dev-task validator rejects non-canonical owner", () => {
  const result = validateDevTask({
    frontmatter: {
      doc_type: "dev_task",
      task_id: "subtask-abcdef123456",
      title: "Generated validator",
      status: "reviewing",
      current_node: "dispatch",
      node_substate: "awaiting_codex_pickup",
      priority: "medium",
      requirement_id: "req-1",
      section_id: "pr1-generated-validator",
      order: 1,
      implementation_owner: "auto",
      dependencies: [],
      source_breakdown_draft: "docs/.ccb/drafts/breakdown/req-1.json",
      source_draft_hash: "a".repeat(64),
      created_at: "2026-05-22T12:00:00.000Z"
    },
    body: "# Generated validator\n\n- This body is long enough for markdown quality checks."
  });

  assert.equal(result.ok, false);
  assert.equal(result.issues.some((issue) => issue.path === "implementation_owner"), true);
});

test("plugin generated dev-task validator checks dev_task metadata", () => {
  const result = validateDevTask({
    frontmatter: {
      doc_type: "technical_design",
      task_id: "subtask-abcdef123456",
      title: "Generated validator",
      status: "reviewing",
      current_node: "dispatch",
      node_substate: "",
      priority: "medium",
      requirement_id: "req-1",
      section_id: "pr1-generated-validator",
      order: 1,
      implementation_owner: "ccb_codex",
      dependencies: [],
      source_breakdown_draft: "docs/.ccb/drafts/breakdown/req-1.json",
      source_draft_hash: "a".repeat(64),
      created_at: "2026-05-22T12:00:00.000Z"
    },
    body: "# Generated validator\n\n- This body is long enough for markdown quality checks."
  });

  assert.equal(result.ok, false);
  assert.equal(result.issues.some((issue) => issue.path === "doc_type"), true);
  assert.equal(result.issues.some((issue) => issue.path === "node_substate"), true);
});

test("plugin generated breakdown-draft validator rejects generation_source unknown keys", () => {
  const drifted = validBreakdownDraft();
  drifted.generation_source.note = "dead field";

  const result = validateBreakdownDraft(drifted);

  assert.equal(result.ok, false);
  assert.equal(result.issues.some((issue) => issue.path === "generation_source.note"), true);
});

test("plugin generated breakdown-draft validator accepts missing review_history and review notes", () => {
  const missingHistory = validBreakdownDraft();
  assert.equal(validateBreakdownDraft(missingHistory).ok, true);

  const notedHistory = {
    ...validBreakdownDraft(),
    review_history: [
      {
        at: "2026-05-22T12:00:00.000Z",
        actor: "ai",
        action: "created",
        note: "legal review note"
      }
    ]
  };
  assert.equal(validateBreakdownDraft(notedHistory).ok, true);
});

test("plugin generated anchor-dispatch validator preserves ADR-0026 baseline", () => {
  const valid = validateAnchorDispatch({
    command: "su-flow",
    payload: { requirement_id: "req-1", action: "analyze" }
  });
  assert.equal(valid.ok, true);

  const invalid = validateAnchorDispatch({
    command: "Su Flow",
    payload: {}
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.issues.some((issue) => issue.path === "command"), true);
});

test("plugin generated anchor-dispatch validator enforces payload envelope limits", () => {
  const base64 = validateAnchorDispatch({
    command: "su-flow",
    payload: {
      feedback_b64: "abc"
    }
  });
  assert.equal(base64.ok, false);
  assert.equal(base64.issues.some((issue) => issue.path === "payload" && issue.expected.includes("*_b64")), true);

  const oversized = validateAnchorDispatch({
    command: "su-flow",
    payload: {
      note: "x".repeat(70 * 1024)
    }
  });
  assert.equal(oversized.ok, false);
  assert.equal(oversized.issues.some((issue) => issue.path === "payload" && issue.expected.includes("65536")), true);

  const tooDeep = validateAnchorDispatch({
    command: "su-flow",
    payload: nestedObject(9)
  });
  assert.equal(tooDeep.ok, false);
  assert.equal(tooDeep.issues.some((issue) => issue.path === "payload" && issue.expected.includes("depth")), true);
});

test("plugin generated docs-structure-contract validator preserves ADR-0026 baseline", () => {
  const valid = validateDocsStructureContract(validDocsStructureContract());
  assert.equal(valid.ok, true);

  const invalid = validateDocsStructureContract({
    version: "wrong",
    human_docs: {},
    machine_layer: {},
    entity_status: {},
    documents: {},
    truth_model: {},
    maintenance: {}
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.issues.some((issue) => issue.path === "version"), true);
  assert.equal(invalid.issues.some((issue) => issue.path === "adr"), true);
});

test("plugin generated docs-structure-contract validator rejects missing human_docs nested fields", () => {
  const missingHumanDocsShape = validateDocsStructureContract({
    ...validDocsStructureContract(),
    human_docs: {}
  });
  assert.equal(missingHumanDocsShape.ok, false);
  assert.equal(missingHumanDocsShape.issues.some((issue) => issue.path === "human_docs.root"), true);
  assert.equal(missingHumanDocsShape.issues.some((issue) => issue.path === "human_docs.entries"), true);
  assert.equal(missingHumanDocsShape.issues.some((issue) => issue.path === "human_docs.view_split"), true);

  const malformedEntry = validateDocsStructureContract({
    ...validDocsStructureContract(),
    human_docs: {
      ...validDocsStructureContract().human_docs,
      entries: [
        {
          path: "02_需求设计/",
          doc_type: "requirement-doc"
        },
        {
          doc_type: "dev_task"
        }
      ]
    }
  });
  assert.equal(malformedEntry.ok, false);
  assert.equal(malformedEntry.issues.some((issue) => issue.path === "human_docs.entries[0].doc_type"), true);
  assert.equal(malformedEntry.issues.some((issue) => issue.path === "human_docs.entries[1]"), true);
});
