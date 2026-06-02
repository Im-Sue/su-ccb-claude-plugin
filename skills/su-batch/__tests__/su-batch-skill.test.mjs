import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const skillPath = join(dirname(fileURLToPath(import.meta.url)), "..", "SKILL.md");

test("su-batch documents single-command subtask coordinator payload and stop policy", async () => {
  const content = await readFile(skillPath, "utf8");

  assert.match(content, /"task_ids":\s*\["<subtaskId>"/);
  assert.match(content, /"policy_profile":\s*"autonomous-batch"/);
  assert.match(content, /"on_subtask_failure":\s*"stop_and_report"/);
  assert.match(content, /逐个子任务走 `implementation` → `review` → `archive`/);
  assert.match(content, /失败即停/);
});
