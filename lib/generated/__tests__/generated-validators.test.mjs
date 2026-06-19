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

test("plugin generated docs-structure-contract validator preserves ADR-0026 baseline", () => {
  const valid = validateDocsStructureContract({
    version: "docs-structure-contract-v0.1",
    adr: "ADR-0037",
    human_docs: {},
    machine_layer: {},
    entity_status: {},
    documents: {},
    truth_model: {},
    maintenance: {}
  });
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
