import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { ConflictError } from "../../runtime/index.mjs";
import {
  archiveRequirementWorktree,
  cleanupRequirementWorktree,
  discardRequirementWorktree,
  ensureRequirementWorktree,
  mergeRequirementWorktree,
  requirementWorktreeStatePath,
  reopenRequirementWorktree
} from "../index.mjs";

process.env.CCB_EVENT_HOOK_URLS = "";

const execFileAsync = promisify(execFile);

async function git(cwd, args, options = {}) {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    ...options
  });
  return (result.stdout ?? "").trim();
}

async function pathPresent(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function tempGitProject() {
  const baseDir = join(tmpdir(), `ccb-worktree-lib-${randomUUID()}`);
  const projectRoot = join(baseDir, "repo");
  await mkdir(projectRoot, { recursive: true });
  await git(projectRoot, ["init", "-b", "main"]);
  await git(projectRoot, ["config", "user.email", "ccb-test@example.invalid"]);
  await git(projectRoot, ["config", "user.name", "CCB Test"]);
  await writeFile(join(projectRoot, "README.md"), "initial\n", "utf8");
  await writeFile(join(projectRoot, ".gitignore"), "/.ccb/\n", "utf8");
  await git(projectRoot, ["add", "README.md", ".gitignore"]);
  await git(projectRoot, ["commit", "-m", "initial"]);
  return { baseDir, projectRoot };
}

function codeWorkspace(requirementId) {
  return {
    path: `../SU-CCB-req-${requirementId}`,
    branch: `ccb/req-${requirementId}`
  };
}

function worktreePath(projectRoot, requirementId) {
  return resolve(projectRoot, codeWorkspace(requirementId).path);
}

async function readState(projectRoot, requirementId) {
  return JSON.parse(await readFile(requirementWorktreeStatePath(projectRoot, requirementId), "utf8"));
}

async function commitCanonicalState(projectRoot, message = "commit runtime state") {
  await git(projectRoot, ["add", "docs/.ccb"]);
  await git(projectRoot, ["commit", "-m", message]);
}

async function branchExists(projectRoot, branch) {
  try {
    await git(projectRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

async function commitWorktreeFile(worktreeRoot, fileName, content, message) {
  await writeFile(join(worktreeRoot, fileName), content, "utf8");
  await git(worktreeRoot, ["add", fileName]);
  await git(worktreeRoot, ["commit", "-m", message]);
  return await git(worktreeRoot, ["rev-parse", "HEAD"]);
}

async function overwriteRuntimeState(projectRoot, requirementId, patch) {
  const statePath = requirementWorktreeStatePath(projectRoot, requirementId);
  const state = JSON.parse(await readFile(statePath, "utf8"));
  await writeFile(statePath, `${JSON.stringify({ ...state, ...patch }, null, 2)}\n`, "utf8");
}

async function writeRequirementDoc(projectRoot, requirementId, content = []) {
  const path = join(projectRoot, "docs", "02_需求设计", `${requirementId}.md`);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, [
    "---",
    `id: ${requirementId}`,
    "status: delivering",
    "---",
    "",
    "# Requirement",
    "",
    ...content
  ].join("\n"), "utf8");
  return path;
}

async function writeDevTaskDoc(projectRoot, requirementId, taskId, overrides = {}) {
  const path = join(projectRoot, "docs", "03_开发计划", `${taskId}-开发任务.md`);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, [
    "---",
    "doc_type: dev_task",
    `task_id: ${taskId}`,
    `title: ${taskId}`,
    `status: ${overrides.status ?? "done"}`,
    `current_node: ${overrides.current_node ?? "archive"}`,
    "node_substate: archived",
    `review_status: ${overrides.review_status ?? "passed"}`,
    "priority: medium",
    `requirement_id: ${requirementId}`,
    "section_id: pr1-worktree",
    "order: 1",
    "implementation_owner: ccb_codex",
    "dependencies: []",
    `source_breakdown_draft: docs/.ccb/drafts/breakdown/${requirementId}.json`,
    `source_draft_hash: ${"a".repeat(64)}`,
    "created_at: 2026-06-06T10:00:00.000Z",
    "---",
    "",
    "# Dev Task",
    ""
  ].join("\n"), "utf8");
  return path;
}

test("ensure creates a requirement worktree, records target state, and is idempotent", async () => {
  const { baseDir, projectRoot } = await tempGitProject();
  const requirementId = "req-ensure";
  try {
    const baseSha = await git(projectRoot, ["rev-parse", "HEAD"]);
    const created = await ensureRequirementWorktree({
      projectRoot,
      requirementId,
      codeWorkspace: codeWorkspace(requirementId)
    });

    assert.equal(created.status, "created");
    assert.equal(created.targetBranch, "main");
    assert.equal(created.baseSha, baseSha);
    assert.equal(await git(worktreePath(projectRoot, requirementId), ["rev-parse", "--abbrev-ref", "HEAD"]), codeWorkspace(requirementId).branch);

    const state = await readState(projectRoot, requirementId);
    assert.equal(state.confirmed_target_branch, "main");
    assert.equal(state.base_sha, baseSha);
    assert.equal(state.path, codeWorkspace(requirementId).path);
    assert.equal(state.branch, codeWorkspace(requirementId).branch);

    const existing = await ensureRequirementWorktree({
      projectRoot,
      requirementId,
      codeWorkspace: codeWorkspace(requirementId)
    });
    assert.equal(existing.status, "existing");
    assert.equal(existing.baseSha, baseSha);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("ensure remains reusable after a subtask reaches archive without touching the worktree", async () => {
  const { baseDir, projectRoot } = await tempGitProject();
  const requirementId = "req-multi-subtask";
  try {
    await ensureRequirementWorktree({
      projectRoot,
      requirementId,
      codeWorkspace: codeWorkspace(requirementId)
    });
    await writeDevTaskDoc(projectRoot, requirementId, "subtask-111111111111");

    const existing = await ensureRequirementWorktree({
      projectRoot,
      requirementId,
      codeWorkspace: codeWorkspace(requirementId)
    });

    assert.equal(existing.status, "existing");
    assert.equal((await readState(projectRoot, requirementId)).status, "ready");
    assert.equal(await pathPresent(worktreePath(projectRoot, requirementId)), true);
    assert.equal(await branchExists(projectRoot, codeWorkspace(requirementId).branch), true);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("ensure rejects a path that exists outside the expected git worktree", async () => {
  const { baseDir, projectRoot } = await tempGitProject();
  const requirementId = "req-path-conflict";
  try {
    await mkdir(worktreePath(projectRoot, requirementId), { recursive: true });

    await assert.rejects(
      () =>
        ensureRequirementWorktree({
          projectRoot,
          requirementId,
          codeWorkspace: codeWorkspace(requirementId)
        }),
      ConflictError
    );
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("ensure rejects an expected branch that is already checked out elsewhere", async () => {
  const { baseDir, projectRoot } = await tempGitProject();
  const requirementId = "req-branch-conflict";
  try {
    await git(projectRoot, [
      "worktree",
      "add",
      "-b",
      codeWorkspace(requirementId).branch,
      resolve(projectRoot, "../other-worktree"),
      "HEAD"
    ]);

    await assert.rejects(
      () =>
        ensureRequirementWorktree({
          projectRoot,
          requirementId,
          codeWorkspace: codeWorkspace(requirementId)
        }),
      ConflictError
    );
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("archive merges the recorded branch, reports divergence, and removes worktree resources", async () => {
  const { baseDir, projectRoot } = await tempGitProject();
  const requirementId = "req-archive";
  try {
    await ensureRequirementWorktree({
      projectRoot,
      requirementId,
      codeWorkspace: codeWorkspace(requirementId)
    });
    const featureSha = await commitWorktreeFile(
      worktreePath(projectRoot, requirementId),
      "feature.txt",
      "from worktree\n",
      "feature work"
    );
    await overwriteRuntimeState(projectRoot, requirementId, { base_sha: featureSha });
    await commitCanonicalState(projectRoot);

    const result = await archiveRequirementWorktree({
      projectRoot,
      requirementId,
      codeWorkspace: codeWorkspace(requirementId)
    });

    assert.equal(result.status, "archived");
    assert.deepEqual(result.warnings.map((warning) => warning.type), ["target_branch_diverged"]);
    assert.equal(await pathPresent(worktreePath(projectRoot, requirementId)), false);
    assert.equal(await branchExists(projectRoot, codeWorkspace(requirementId).branch), false);
    assert.equal(await readFile(join(projectRoot, "feature.txt"), "utf8"), "from worktree\n");
    assert.equal((await readState(projectRoot, requirementId)).status, "archived");
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("merge keeps worktree resources and cleanup archives after ancestor validation", async () => {
  const { baseDir, projectRoot } = await tempGitProject();
  const requirementId = "req-merge-cleanup";
  try {
    await ensureRequirementWorktree({
      projectRoot,
      requirementId,
      codeWorkspace: codeWorkspace(requirementId)
    });
    const featureSha = await commitWorktreeFile(
      worktreePath(projectRoot, requirementId),
      "feature.txt",
      "from worktree\n",
      "feature work"
    );
    await commitCanonicalState(projectRoot);

    const merged = await mergeRequirementWorktree({
      projectRoot,
      requirementId,
      codeWorkspace: codeWorkspace(requirementId)
    });

    assert.equal(merged.status, "merged");
    assert.equal(merged.mergedBranchSha, featureSha);
    assert.equal(await pathPresent(worktreePath(projectRoot, requirementId)), true);
    assert.equal(await branchExists(projectRoot, codeWorkspace(requirementId).branch), true);
    assert.equal((await readState(projectRoot, requirementId)).status, "merged");

    const cleaned = await cleanupRequirementWorktree({
      projectRoot,
      requirementId,
      codeWorkspace: codeWorkspace(requirementId)
    });

    assert.equal(cleaned.status, "archived");
    assert.equal(await pathPresent(worktreePath(projectRoot, requirementId)), false);
    assert.equal(await branchExists(projectRoot, codeWorkspace(requirementId).branch), false);
    assert.equal((await readState(projectRoot, requirementId)).status, "archived");
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("reopen moves merged state back to ready while preserving the worktree", async () => {
  const { baseDir, projectRoot } = await tempGitProject();
  const requirementId = "req-reopen";
  try {
    await ensureRequirementWorktree({
      projectRoot,
      requirementId,
      codeWorkspace: codeWorkspace(requirementId)
    });
    await commitWorktreeFile(
      worktreePath(projectRoot, requirementId),
      "feature.txt",
      "from worktree\n",
      "feature work"
    );
    await commitCanonicalState(projectRoot);
    await mergeRequirementWorktree({
      projectRoot,
      requirementId,
      codeWorkspace: codeWorkspace(requirementId)
    });

    const reopened = await reopenRequirementWorktree({
      projectRoot,
      requirementId,
      codeWorkspace: codeWorkspace(requirementId)
    });

    assert.equal(reopened.status, "ready");
    assert.equal(await pathPresent(worktreePath(projectRoot, requirementId)), true);
    assert.equal(await branchExists(projectRoot, codeWorkspace(requirementId).branch), true);
    assert.equal((await readState(projectRoot, requirementId)).status, "ready");
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("discard rejects merged and archived worktree states", async () => {
  const { baseDir, projectRoot } = await tempGitProject();
  const requirementId = "req-discard-guard";
  try {
    await ensureRequirementWorktree({
      projectRoot,
      requirementId,
      codeWorkspace: codeWorkspace(requirementId)
    });
    await commitWorktreeFile(
      worktreePath(projectRoot, requirementId),
      "feature.txt",
      "from worktree\n",
      "feature work"
    );
    await commitCanonicalState(projectRoot);
    await mergeRequirementWorktree({
      projectRoot,
      requirementId,
      codeWorkspace: codeWorkspace(requirementId)
    });

    await assert.rejects(
      () =>
        discardRequirementWorktree({
          projectRoot,
          requirementId,
          codeWorkspace: codeWorkspace(requirementId)
        }),
      ConflictError
    );

    await cleanupRequirementWorktree({
      projectRoot,
      requirementId,
      codeWorkspace: codeWorkspace(requirementId)
    });
    await assert.rejects(
      () =>
        discardRequirementWorktree({
          projectRoot,
          requirementId,
          codeWorkspace: codeWorkspace(requirementId)
        }),
      ConflictError
    );
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("merge sync-commits canonical allowlist files before merging requirement branch", async () => {
  const { baseDir, projectRoot } = await tempGitProject();
  const requirementId = "req-sync";
  try {
    await ensureRequirementWorktree({
      projectRoot,
      requirementId,
      codeWorkspace: codeWorkspace(requirementId)
    });
    await writeRequirementDoc(projectRoot, requirementId, ["synced requirement"]);
    await writeDevTaskDoc(projectRoot, requirementId, "subtask-111111111111");
    await mkdir(join(projectRoot, "docs", ".ccb", "drafts", "breakdown"), { recursive: true });
    await writeFile(join(projectRoot, "docs", ".ccb", "drafts", "breakdown", `${requirementId}.json`), "{}\n", "utf8");
    await writeFile(join(projectRoot, "docs", "00_文档地图.md"), "# Map\n", "utf8");
    await commitWorktreeFile(
      worktreePath(projectRoot, requirementId),
      "feature.txt",
      "from worktree\n",
      "feature work"
    );

    const merged = await mergeRequirementWorktree({
      projectRoot,
      requirementId,
      codeWorkspace: codeWorkspace(requirementId)
    });

    assert.equal(merged.status, "merged");
    assert.match(
      await git(projectRoot, ["log", "--format=%s", "--", `docs/02_需求设计/${requirementId}.md`]),
      new RegExp(`chore\\(${requirementId}\\): canonical sync before requirement merge`)
    );
    assert.equal(await readFile(join(projectRoot, "feature.txt"), "utf8"), "from worktree\n");
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("merge escalates when canonical dirty files fall outside the sync allowlist", async () => {
  const { baseDir, projectRoot } = await tempGitProject();
  const requirementId = "req-sync-outside";
  try {
    await ensureRequirementWorktree({
      projectRoot,
      requirementId,
      codeWorkspace: codeWorkspace(requirementId)
    });
    await commitWorktreeFile(
      worktreePath(projectRoot, requirementId),
      "feature.txt",
      "from worktree\n",
      "feature work"
    );
    await writeFile(join(projectRoot, "outside.txt"), "do not sync\n", "utf8");

    const result = await mergeRequirementWorktree({
      projectRoot,
      requirementId,
      codeWorkspace: codeWorkspace(requirementId)
    });

    assert.equal(result.status, "escalated");
    assert.equal(result.reason, "canonical_dirty_outside_allowlist");
    assert.match(result.porcelain, /outside\.txt/);
    assert.equal((await readState(projectRoot, requirementId)).status, "ready");
    assert.equal(await pathPresent(worktreePath(projectRoot, requirementId)), true);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("cleanup escalates when the worktree branch tip is not an ancestor of target", async () => {
  const { baseDir, projectRoot } = await tempGitProject();
  const requirementId = "req-cleanup-ancestor";
  try {
    await ensureRequirementWorktree({
      projectRoot,
      requirementId,
      codeWorkspace: codeWorkspace(requirementId)
    });
    const featureSha = await commitWorktreeFile(
      worktreePath(projectRoot, requirementId),
      "feature.txt",
      "from worktree\n",
      "feature work"
    );
    await overwriteRuntimeState(projectRoot, requirementId, {
      status: "merged",
      merged_branch_sha: featureSha,
      target_sha_after_merge: await git(projectRoot, ["rev-parse", "HEAD"]),
      merged_at: "2026-06-06T10:00:00.000Z"
    });

    const result = await cleanupRequirementWorktree({
      projectRoot,
      requirementId,
      codeWorkspace: codeWorkspace(requirementId)
    });

    assert.equal(result.status, "escalated");
    assert.equal(result.reason, "cleanup_branch_not_ancestor");
    assert.equal(await pathPresent(worktreePath(projectRoot, requirementId)), true);
    assert.equal(await branchExists(projectRoot, codeWorkspace(requirementId).branch), true);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("merge and cleanup recover after git state already reached the target transition", async () => {
  const { baseDir, projectRoot } = await tempGitProject();
  const requirementId = "req-recovery";
  try {
    await ensureRequirementWorktree({
      projectRoot,
      requirementId,
      codeWorkspace: codeWorkspace(requirementId)
    });
    const featureSha = await commitWorktreeFile(
      worktreePath(projectRoot, requirementId),
      "feature.txt",
      "from worktree\n",
      "feature work"
    );
    await commitCanonicalState(projectRoot);
    await git(projectRoot, ["merge", "--no-edit", codeWorkspace(requirementId).branch]);
    await overwriteRuntimeState(projectRoot, requirementId, { status: "ready" });

    const merged = await mergeRequirementWorktree({
      projectRoot,
      requirementId,
      codeWorkspace: codeWorkspace(requirementId)
    });
    assert.equal(merged.status, "merged");
    assert.equal(merged.mergedBranchSha, featureSha);

    await git(projectRoot, ["worktree", "remove", worktreePath(projectRoot, requirementId)]);
    await git(projectRoot, ["branch", "-d", codeWorkspace(requirementId).branch]);

    const cleaned = await cleanupRequirementWorktree({
      projectRoot,
      requirementId,
      codeWorkspace: codeWorkspace(requirementId)
    });
    assert.equal(cleaned.status, "archived");
    assert.equal(cleaned.recovery, "git_resources_already_cleaned");
    assert.equal((await readState(projectRoot, requirementId)).status, "archived");
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("archive escalates when the recorded target branch no longer exists and preserves the worktree", async () => {
  const { baseDir, projectRoot } = await tempGitProject();
  const requirementId = "req-target-missing";
  try {
    await ensureRequirementWorktree({
      projectRoot,
      requirementId,
      codeWorkspace: codeWorkspace(requirementId)
    });
    await commitCanonicalState(projectRoot);
    await git(projectRoot, ["checkout", "--detach"]);
    await git(projectRoot, ["branch", "-D", "main"]);

    const result = await archiveRequirementWorktree({
      projectRoot,
      requirementId,
      codeWorkspace: codeWorkspace(requirementId)
    });

    assert.equal(result.status, "escalated");
    assert.equal(result.reason, "target_branch_missing");
    assert.equal(await pathPresent(worktreePath(projectRoot, requirementId)), true);
    assert.equal(await branchExists(projectRoot, codeWorkspace(requirementId).branch), true);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("archive aborts a merge conflict and leaves the worktree branch intact", async () => {
  const { baseDir, projectRoot } = await tempGitProject();
  const requirementId = "req-conflict";
  try {
    await ensureRequirementWorktree({
      projectRoot,
      requirementId,
      codeWorkspace: codeWorkspace(requirementId)
    });
    await commitCanonicalState(projectRoot);
    await commitWorktreeFile(
      worktreePath(projectRoot, requirementId),
      "conflict.txt",
      "worktree\n",
      "worktree conflict side"
    );
    await writeFile(join(projectRoot, "conflict.txt"), "main\n", "utf8");
    await git(projectRoot, ["add", "conflict.txt"]);
    await git(projectRoot, ["commit", "-m", "main conflict side"]);

    const result = await archiveRequirementWorktree({
      projectRoot,
      requirementId,
      codeWorkspace: codeWorkspace(requirementId)
    });

    assert.equal(result.status, "escalated");
    assert.equal(result.reason, "merge_conflict");
    assert.equal(await git(projectRoot, ["diff", "--name-only", "--diff-filter=U"]), "");
    assert.equal(await pathPresent(worktreePath(projectRoot, requirementId)), true);
    assert.equal(await branchExists(projectRoot, codeWorkspace(requirementId).branch), true);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("discard force-removes the worktree and branch without merging code", async () => {
  const { baseDir, projectRoot } = await tempGitProject();
  const requirementId = "req-discard";
  try {
    await ensureRequirementWorktree({
      projectRoot,
      requirementId,
      codeWorkspace: codeWorkspace(requirementId)
    });
    await commitWorktreeFile(
      worktreePath(projectRoot, requirementId),
      "discarded.txt",
      "discard me\n",
      "discarded work"
    );

    const result = await discardRequirementWorktree({
      projectRoot,
      requirementId,
      codeWorkspace: codeWorkspace(requirementId)
    });

    assert.equal(result.status, "discarded");
    assert.equal(await pathPresent(worktreePath(projectRoot, requirementId)), false);
    assert.equal(await branchExists(projectRoot, codeWorkspace(requirementId).branch), false);
    assert.equal(await pathPresent(join(projectRoot, "discarded.txt")), false);
    assert.equal((await readState(projectRoot, requirementId)).status, "discarded");
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});

test("concurrent ensure calls for the same requirement are serialized by the canonical lock", async () => {
  const { baseDir, projectRoot } = await tempGitProject();
  const requirementId = "req-lock";
  try {
    const results = await Promise.all([
      ensureRequirementWorktree({
        projectRoot,
        requirementId,
        codeWorkspace: codeWorkspace(requirementId)
      }),
      ensureRequirementWorktree({
        projectRoot,
        requirementId,
        codeWorkspace: codeWorkspace(requirementId)
      })
    ]);

    assert.deepEqual(results.map((result) => result.status).sort(), ["created", "existing"]);
    assert.equal(await git(worktreePath(projectRoot, requirementId), ["rev-parse", "--abbrev-ref", "HEAD"]), codeWorkspace(requirementId).branch);
  } finally {
    await rm(baseDir, { recursive: true, force: true });
  }
});
