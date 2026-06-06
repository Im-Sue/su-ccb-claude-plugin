import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, lstat, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

import {
  ConflictError,
  IOError,
  RuntimeError,
  ValidationError,
  appendEvent,
  safeWriteFile,
  withFileLock
} from "../runtime/index.mjs";

const execFileAsync = promisify(execFile);

const SOURCE_ACTOR = "ccb_claude";
const STATE_SCHEMA_VERSION = "requirement-worktree-v0.1";
const GIT_MAX_BUFFER = 10 * 1024 * 1024;

export class GitCommandError extends RuntimeError {
  constructor(cwd, args, result, cause) {
    const detail = (result.stderr || result.stdout || "").trim();
    super(
      `git ${args.join(" ")} failed in ${cwd}${detail ? `: ${detail}` : ""}`,
      { code: "GIT_COMMAND_FAILED", path: cwd, cause }
    );
    this.cwd = cwd;
    this.args = args;
    this.exitCode = result.exitCode;
    this.stdout = result.stdout;
    this.stderr = result.stderr;
  }
}

function normalizeProjectRoot(projectRoot) {
  if (typeof projectRoot !== "string" || projectRoot.trim().length === 0) {
    throw new ValidationError("projectRoot must be a non-empty string");
  }
  return resolve(projectRoot);
}

function requiredString(value, field) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function safeFileSegment(value) {
  const safe = String(value).replace(/[^a-zA-Z0-9._-]/g, "_");
  return safe || "requirement";
}

function statePath(projectRoot, requirementId) {
  return join(projectRoot, "docs", ".ccb", "worktrees", `${safeFileSegment(requirementId)}.json`);
}

function lockTargetPath(projectRoot, requirementId) {
  return join(projectRoot, ".ccb", "locks", "worktree", safeFileSegment(requirementId));
}

function isoNow(options) {
  const value = options.now?.() ?? new Date();
  return typeof value === "string" ? value : value.toISOString();
}

function normalizeBranchRef(value) {
  if (!value) return null;
  return value.startsWith("refs/heads/") ? value.slice("refs/heads/".length) : value;
}

function parseWorktreeList(output) {
  const records = [];
  let current = null;
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {
      current = null;
      continue;
    }
    const separator = line.indexOf(" ");
    const key = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1);
    if (key === "worktree") {
      current = { path: resolve(value), head: null, branch: null, detached: false };
      records.push(current);
      continue;
    }
    if (!current) continue;
    if (key === "HEAD") current.head = value;
    if (key === "branch") current.branch = normalizeBranchRef(value);
    if (key === "detached") current.detached = true;
  }
  return records;
}

function samePath(left, right) {
  return resolve(left) === resolve(right);
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw new IOError(`failed to inspect path: ${path}`, { path, cause: error });
  }
}

async function assertPathAbsentOrExpectedWorktree(path, records) {
  if (records.some((record) => samePath(record.path, path))) return;
  if (!await pathExists(path)) return;
  let kind = "path";
  try {
    const stats = await lstat(path);
    kind = stats.isDirectory() ? "directory" : "file";
  } catch {
    // The earlier access check already proved the conflict; the exact kind is best-effort.
  }
  throw new ConflictError(`worktree path exists but is not the expected git worktree: ${path}`, {
    path,
    kind
  });
}

async function defaultRunGit(cwd, args, options = {}) {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: GIT_MAX_BUFFER
    });
    return {
      exitCode: 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? ""
    };
  } catch (error) {
    const failed = {
      exitCode: Number.isInteger(error?.code) ? error.code : 1,
      stdout: error?.stdout ?? "",
      stderr: error?.stderr ?? ""
    };
    if (options.allowFailure) return failed;
    throw new GitCommandError(cwd, args, failed, error);
  }
}

async function git(projectRoot, args, options = {}) {
  const runGit = options.runGit ?? defaultRunGit;
  const cwd = options.cwd ?? projectRoot;
  const result = await runGit(cwd, args, options);
  if (result.exitCode !== 0 && !options.allowFailure) {
    throw new GitCommandError(cwd, args, result);
  }
  return result;
}

async function gitOutput(projectRoot, args, options = {}) {
  return (await git(projectRoot, args, options)).stdout.trim();
}

async function branchExists(projectRoot, branch, options = {}) {
  const result = await git(
    projectRoot,
    ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`],
    { ...options, allowFailure: true }
  );
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw new GitCommandError(projectRoot, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], result);
}

async function currentBranch(projectRoot, options = {}) {
  const branch = await gitOutput(projectRoot, ["rev-parse", "--abbrev-ref", "HEAD"], options);
  if (!branch || branch === "HEAD") {
    throw new ConflictError("canonical root must be checked out on a branch before ensuring a requirement worktree", {
      path: projectRoot
    });
  }
  return branch;
}

async function headSha(projectRoot, options = {}) {
  return await gitOutput(projectRoot, ["rev-parse", "HEAD"], options);
}

async function worktreeRecords(projectRoot, options = {}) {
  const output = await gitOutput(projectRoot, ["worktree", "list", "--porcelain"], options);
  return parseWorktreeList(output);
}

async function statusPorcelain(cwd, options = {}) {
  return (await git(cwd, ["-c", "core.quotePath=false", "status", "--porcelain", "--untracked-files=all"], { ...options, cwd })).stdout;
}

function parseFrontmatter(content) {
  const matched = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!matched) return {};
  const frontmatter = {};
  for (const line of matched[1].split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const separator = line.indexOf(":");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^['"]|['"]$/g, "");
    frontmatter[key] = value;
  }
  return frontmatter;
}

async function listMarkdownFiles(root) {
  const entries = await readdir(root, { withFileTypes: true }).catch((error) => {
    if (error?.code === "ENOENT") return [];
    throw error;
  });
  const files = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listMarkdownFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(path);
    }
  }
  return files;
}

async function markdownPathsMatchingFrontmatter(projectRoot, relativeDirectory, predicate) {
  const root = join(projectRoot, relativeDirectory);
  const files = await listMarkdownFiles(root);
  const matched = [];
  for (const path of files) {
    const frontmatter = parseFrontmatter(await readFile(path, "utf8"));
    if (predicate(frontmatter)) matched.push(relative(projectRoot, path).replace(/\\/g, "/"));
  }
  return matched;
}

async function canonicalSyncAllowlist(projectRoot, requirementId) {
  const requirementDocs = await markdownPathsMatchingFrontmatter(
    projectRoot,
    join("docs", "02_需求设计"),
    (frontmatter) => frontmatter.id === requirementId || frontmatter.requirement_id === requirementId
  );
  const devTaskDocs = await markdownPathsMatchingFrontmatter(
    projectRoot,
    join("docs", "03_开发计划"),
    (frontmatter) => frontmatter.doc_type === "dev_task" && frontmatter.requirement_id === requirementId
  );
  return new Set([
    ...requirementDocs,
    ...devTaskDocs,
    "docs/00_文档地图.md",
    "docs/.ccb/events/journal.jsonl",
    relative(projectRoot, statePath(projectRoot, requirementId)).replace(/\\/g, "/"),
    `docs/.ccb/drafts/breakdown/${safeFileSegment(requirementId)}.json`
  ]);
}

function statusPathsFromLine(line) {
  const raw = line.slice(3).trim();
  if (!raw) return [];
  const unquoted = raw.replace(/^"|"$/g, "");
  if (unquoted.includes(" -> ")) {
    return unquoted.split(" -> ").map((item) => item.trim()).filter(Boolean);
  }
  return [unquoted];
}

function parseStatusEntries(output) {
  return output
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line) => ({
      raw: line,
      paths: statusPathsFromLine(line).map((path) => path.replace(/\\/g, "/"))
    }));
}

async function pathExistsOrTracked(projectRoot, relativePath, options = {}) {
  if (await pathExists(join(projectRoot, relativePath))) return true;
  const tracked = await git(
    projectRoot,
    ["ls-files", "--error-unmatch", "--", relativePath],
    { ...options, allowFailure: true }
  );
  return tracked.exitCode === 0;
}

async function canonicalSyncCommit(projectRoot, requirementId, options = {}) {
  const allowlist = await canonicalSyncAllowlist(projectRoot, requirementId);
  const before = parseStatusEntries(await statusPorcelain(projectRoot, options));
  const outside = before.filter((entry) => entry.paths.some((path) => !allowlist.has(path)));
  if (outside.length > 0) {
    return escalation("canonical_dirty_outside_allowlist", {
      requirementId,
      path: projectRoot,
      porcelain: outside.map((entry) => entry.raw).join("\n")
    });
  }

  const changedAllowlistPaths = [
    ...new Set(before.flatMap((entry) => entry.paths).filter((path) => allowlist.has(path)))
  ];
  const addPaths = [];
  for (const relativePath of changedAllowlistPaths) {
    if (await pathExistsOrTracked(projectRoot, relativePath, options)) addPaths.push(relativePath);
  }
  if (addPaths.length === 0) {
    return { status: "noop", committed: false, allowlist: [...allowlist] };
  }

  await git(projectRoot, ["add", "--", ...addPaths], options);
  const diff = await git(projectRoot, ["diff", "--cached", "--quiet", "--", ...addPaths], {
    ...options,
    allowFailure: true
  });
  if (diff.exitCode === 0) return { status: "noop", committed: false, allowlist: [...allowlist] };
  if (diff.exitCode !== 1) {
    throw new GitCommandError(projectRoot, ["diff", "--cached", "--quiet", "--", ...addPaths], diff);
  }

  await git(projectRoot, [
    "commit",
    "-m",
    `chore(${requirementId}): canonical sync before requirement merge`,
    "--",
    ...addPaths
  ], options);

  const after = parseStatusEntries(await statusPorcelain(projectRoot, options));
  const remainingOutside = after.filter((entry) => entry.paths.some((path) => !allowlist.has(path)));
  if (remainingOutside.length > 0) {
    return escalation("canonical_dirty_outside_allowlist", {
      requirementId,
      path: projectRoot,
      porcelain: remainingOutside.map((entry) => entry.raw).join("\n")
    });
  }
  return {
    status: "committed",
    committed: true,
    commitSha: await headSha(projectRoot, options),
    paths: addPaths,
    allowlist: [...allowlist]
  };
}

function normalizeWorkspace(projectRoot, codeWorkspace, runtimeState = null) {
  const pathValue = codeWorkspace?.path ?? runtimeState?.path;
  const branchValue = codeWorkspace?.branch ?? runtimeState?.branch;
  const relativePath = requiredString(pathValue, "codeWorkspace.path");
  const branch = requiredString(branchValue, "codeWorkspace.branch");
  if (isAbsolute(relativePath)) {
    throw new ValidationError("codeWorkspace.path must be relative to projectRoot", {
      path: relativePath
    });
  }
  return {
    relativePath,
    absolutePath: resolve(projectRoot, relativePath),
    branch
  };
}

function assertStateMatchesWorkspace(runtimeState, workspace) {
  if (!runtimeState) return;
  const mismatches = [];
  if (runtimeState.path !== workspace.relativePath) {
    mismatches.push(`path=${runtimeState.path ?? "<missing>"}`);
  }
  if (runtimeState.branch !== workspace.branch) {
    mismatches.push(`branch=${runtimeState.branch ?? "<missing>"}`);
  }
  if (mismatches.length > 0) {
    throw new ConflictError(`worktree runtime state does not match code_workspace: ${mismatches.join(", ")}`);
  }
}

async function readRuntimeState(projectRoot, requirementId) {
  const path = statePath(projectRoot, requirementId);
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return { path, state: parsed };
  } catch (error) {
    if (error?.code === "ENOENT") return { path, state: null };
    if (error instanceof SyntaxError) {
      throw new ValidationError(`invalid worktree runtime state JSON: ${path}`, { path, cause: error });
    }
    throw new IOError(`failed to read worktree runtime state: ${path}`, { path, cause: error });
  }
}

async function writeRuntimeState(projectRoot, requirementId, state, operation, options = {}) {
  const path = statePath(projectRoot, requirementId);
  await safeWriteFile(path, `${JSON.stringify(state, null, 2)}\n`, {
    audit: {
      projectRoot,
      subjectType: "requirement",
      subjectId: requirementId,
      sourceActor: SOURCE_ACTOR,
      resourceType: "requirement_worktree_state",
      operation,
      runId: `worktree-${operation}-${safeFileSegment(requirementId)}-${randomUUID()}`,
      targetPath: relative(projectRoot, path)
    }
  });
  return path;
}

async function appendWorktreeEvent(projectRoot, requirementId, type, payload, options = {}) {
  return await appendEvent(
    {
      type,
      subject_type: "requirement",
      subject_id: requirementId,
      payload,
      idempotency_key: `worktree:${type}:${safeFileSegment(requirementId)}:${randomUUID()}`,
      emitted_at: isoNow(options),
      source_actor: SOURCE_ACTOR
    },
    { projectRoot }
  );
}

function escalation(reason, payload = {}) {
  return {
    status: "escalated",
    reason,
    ...payload
  };
}

async function appendEscalationEvent(projectRoot, requirementId, reason, payload, options) {
  await appendWorktreeEvent(
    projectRoot,
    requirementId,
    "requirement_worktree_archive_escalated",
    { reason, ...payload },
    options
  );
}

async function withRequirementLock(projectRoot, requirementId, options, fn) {
  return await withFileLock(lockTargetPath(projectRoot, requirementId), fn, options.lockOptions ?? {});
}

async function commitExists(projectRoot, sha, options = {}) {
  if (!sha) return false;
  const result = await git(projectRoot, ["cat-file", "-e", `${sha}^{commit}`], {
    ...options,
    allowFailure: true
  });
  return result.exitCode === 0;
}

async function isAncestor(projectRoot, ancestor, descendant, options = {}) {
  const result = await git(projectRoot, ["merge-base", "--is-ancestor", ancestor, descendant], {
    ...options,
    allowFailure: true
  });
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw new GitCommandError(projectRoot, ["merge-base", "--is-ancestor", ancestor, descendant], result);
}

async function collectMergeWarnings(projectRoot, runtimeState, targetBranch, options = {}) {
  const warnings = [];
  if (!runtimeState.base_sha) return warnings;
  if (!await commitExists(projectRoot, runtimeState.base_sha, options)) {
    warnings.push({
      type: "base_sha_missing",
      base_sha: runtimeState.base_sha
    });
    return warnings;
  }
  if (!await isAncestor(projectRoot, runtimeState.base_sha, targetBranch, options)) {
    warnings.push({
      type: "target_branch_diverged",
      target_branch: targetBranch,
      base_sha: runtimeState.base_sha
    });
  }
  return warnings;
}

export function requirementWorktreeStatePath(projectRoot, requirementId) {
  return statePath(normalizeProjectRoot(projectRoot), requiredString(requirementId, "requirementId"));
}

export async function ensureRequirementWorktree(input = {}) {
  const projectRoot = normalizeProjectRoot(input.projectRoot);
  const requirementId = requiredString(input.requirementId, "requirementId");
  const workspace = normalizeWorkspace(projectRoot, input.codeWorkspace);

  return await withRequirementLock(projectRoot, requirementId, input, async () => {
    await git(projectRoot, ["worktree", "prune"], input);
    const records = await worktreeRecords(projectRoot, input);
    const { path: runtimeStatePath, state: runtimeState } = await readRuntimeState(projectRoot, requirementId);
    assertStateMatchesWorkspace(runtimeState, workspace);

    if (runtimeState?.status && runtimeState.status !== "ready") {
      throw new ConflictError(`requirement worktree is already ${runtimeState.status}: ${requirementId}`);
    }

    const targetRecord = records.find((record) => samePath(record.path, workspace.absolutePath));
    const branchRecord = records.find((record) => record.branch === workspace.branch);

    if (targetRecord && targetRecord.branch !== workspace.branch) {
      throw new ConflictError(
        `worktree path is checked out with unexpected branch: ${workspace.absolutePath}`,
        { path: workspace.absolutePath }
      );
    }
    if (branchRecord && !samePath(branchRecord.path, workspace.absolutePath)) {
      throw new ConflictError(
        `worktree branch is already checked out at another path: ${workspace.branch}`,
        { path: branchRecord.path }
      );
    }
    await assertPathAbsentOrExpectedWorktree(workspace.absolutePath, records);

    if (targetRecord) {
      if (!runtimeState?.confirmed_target_branch || !runtimeState?.base_sha) {
        throw new ConflictError(`worktree exists but runtime target state is missing: ${requirementId}`, {
          path: runtimeStatePath
        });
      }
      await appendWorktreeEvent(
        projectRoot,
        requirementId,
        "requirement_worktree_ensure_noop",
        {
          path: workspace.relativePath,
          branch: workspace.branch,
          confirmed_target_branch: runtimeState.confirmed_target_branch,
          base_sha: runtimeState.base_sha
        },
        input
      );
      return {
        status: "existing",
        requirementId,
        path: workspace.absolutePath,
        relativePath: workspace.relativePath,
        branch: workspace.branch,
        targetBranch: runtimeState.confirmed_target_branch,
        baseSha: runtimeState.base_sha,
        statePath: runtimeStatePath
      };
    }

    if (await branchExists(projectRoot, workspace.branch, input)) {
      throw new ConflictError(`worktree branch already exists without the expected worktree: ${workspace.branch}`);
    }

    const targetBranch = await currentBranch(projectRoot, input);
    const baseSha = await headSha(projectRoot, input);
    await git(projectRoot, ["worktree", "add", "-b", workspace.branch, workspace.absolutePath, "HEAD"], input);

    const now = isoNow(input);
    const state = {
      schema_version: STATE_SCHEMA_VERSION,
      requirement_id: requirementId,
      status: "ready",
      path: workspace.relativePath,
      branch: workspace.branch,
      confirmed_target_branch: targetBranch,
      base_sha: baseSha,
      created_at: now,
      updated_at: now
    };
    await writeRuntimeState(projectRoot, requirementId, state, "ensure");
    await appendWorktreeEvent(
      projectRoot,
      requirementId,
      "requirement_worktree_ensured",
      {
        path: workspace.relativePath,
        branch: workspace.branch,
        confirmed_target_branch: targetBranch,
        base_sha: baseSha
      },
      input
    );

    return {
      status: "created",
      requirementId,
      path: workspace.absolutePath,
      relativePath: workspace.relativePath,
      branch: workspace.branch,
      targetBranch,
      baseSha,
      statePath: runtimeStatePath
    };
  });
}

export async function mergeRequirementWorktree(input = {}) {
  const projectRoot = normalizeProjectRoot(input.projectRoot);
  const requirementId = requiredString(input.requirementId, "requirementId");

  return await withRequirementLock(projectRoot, requirementId, input, async () => {
    await git(projectRoot, ["worktree", "prune"], input);
    const { path: runtimeStatePath, state: runtimeState } = await readRuntimeState(projectRoot, requirementId);
    if (!runtimeState) {
      const result = escalation("missing_runtime_state", { requirementId, statePath: runtimeStatePath });
      await appendEscalationEvent(projectRoot, requirementId, result.reason, result, input);
      return result;
    }

    const workspace = normalizeWorkspace(projectRoot, input.codeWorkspace, runtimeState);
    assertStateMatchesWorkspace(runtimeState, workspace);
    if (runtimeState.status === "merged") {
      return {
        status: "merged",
        requirementId,
        path: workspace.absolutePath,
        relativePath: workspace.relativePath,
        branch: workspace.branch,
        targetBranch: runtimeState.confirmed_target_branch,
        mergedBranchSha: runtimeState.merged_branch_sha,
        targetShaAfterMerge: runtimeState.target_sha_after_merge,
        statePath: runtimeStatePath
      };
    }
    if (runtimeState.status !== "ready") {
      throw new ConflictError(`requirement worktree must be ready before merge: ${requirementId}`, {
        status: runtimeState.status
      });
    }

    const targetBranch = runtimeState.confirmed_target_branch;
    if (!targetBranch) {
      const result = escalation("missing_target_branch", { requirementId, statePath: runtimeStatePath });
      await appendEscalationEvent(projectRoot, requirementId, result.reason, result, input);
      return result;
    }

    const records = await worktreeRecords(projectRoot, input);
    const targetRecord = records.find((record) => samePath(record.path, workspace.absolutePath));
    if (!targetRecord) {
      const result = escalation("worktree_missing", {
        requirementId,
        path: workspace.absolutePath,
        branch: workspace.branch
      });
      await appendEscalationEvent(projectRoot, requirementId, result.reason, result, input);
      return result;
    }
    if (targetRecord.branch !== workspace.branch) {
      const result = escalation("worktree_branch_mismatch", {
        requirementId,
        path: workspace.absolutePath,
        expectedBranch: workspace.branch,
        actualBranch: targetRecord.branch
      });
      await appendEscalationEvent(projectRoot, requirementId, result.reason, result, input);
      return result;
    }
    if (!await branchExists(projectRoot, targetBranch, input)) {
      const result = escalation("target_branch_missing", {
        requirementId,
        targetBranch,
        path: workspace.absolutePath,
        branch: workspace.branch
      });
      await appendEscalationEvent(projectRoot, requirementId, result.reason, result, input);
      return result;
    }

    let activeBranch;
    try {
      activeBranch = await currentBranch(projectRoot, input);
    } catch (error) {
      const result = escalation("target_branch_not_current", {
        requirementId,
        targetBranch,
        activeBranch: "HEAD"
      });
      await appendEscalationEvent(projectRoot, requirementId, result.reason, result, input);
      return result;
    }
    if (activeBranch !== targetBranch) {
      const result = escalation("target_branch_not_current", {
        requirementId,
        targetBranch,
        activeBranch
      });
      await appendEscalationEvent(projectRoot, requirementId, result.reason, result, input);
      return result;
    }

    const worktreeStatus = await statusPorcelain(workspace.absolutePath, input);
    if (worktreeStatus.trim()) {
      const result = escalation("worktree_dirty", {
        requirementId,
        path: workspace.absolutePath,
        porcelain: worktreeStatus
      });
      await appendEscalationEvent(projectRoot, requirementId, result.reason, result, input);
      return result;
    }

    const syncResult = await canonicalSyncCommit(projectRoot, requirementId, input);
    if (syncResult.status === "escalated") {
      await appendEscalationEvent(projectRoot, requirementId, syncResult.reason, syncResult, input);
      return syncResult;
    }

    const warnings = await collectMergeWarnings(projectRoot, runtimeState, targetBranch, input);
    const branchSha = await gitOutput(projectRoot, ["rev-parse", workspace.branch], input);
    let mergeResult = { stdout: "", stderr: "" };
    if (!await isAncestor(projectRoot, branchSha, targetBranch, input)) {
      mergeResult = await git(projectRoot, ["merge", "--no-edit", workspace.branch], {
        ...input,
        allowFailure: true
      });
      if (mergeResult.exitCode !== 0) {
        await git(projectRoot, ["merge", "--abort"], { ...input, allowFailure: true });
        const result = escalation("merge_conflict", {
          requirementId,
          targetBranch,
          branch: workspace.branch,
          path: workspace.absolutePath,
          warnings,
          stderr: mergeResult.stderr,
          stdout: mergeResult.stdout
        });
        await appendEscalationEvent(projectRoot, requirementId, result.reason, result, input);
        return result;
      }
    }

    const targetShaAfterMerge = await headSha(projectRoot, input);
    const now = isoNow(input);
    const mergedState = {
      ...runtimeState,
      status: "merged",
      merged_branch_sha: branchSha,
      target_sha_after_merge: targetShaAfterMerge,
      merged_at: runtimeState.merged_at ?? now,
      updated_at: now,
      merge: {
        target_branch: targetBranch,
        warnings,
        canonical_sync: syncResult,
        merge_stdout: mergeResult.stdout,
        merge_stderr: mergeResult.stderr
      }
    };
    await writeRuntimeState(projectRoot, requirementId, mergedState, "merge");
    await appendWorktreeEvent(
      projectRoot,
      requirementId,
      "requirement_worktree_merged",
      {
        path: workspace.relativePath,
        branch: workspace.branch,
        target_branch: targetBranch,
        merged_branch_sha: branchSha,
        target_sha_after_merge: targetShaAfterMerge,
        warnings
      },
      input
    );

    return {
      status: "merged",
      requirementId,
      path: workspace.absolutePath,
      relativePath: workspace.relativePath,
      branch: workspace.branch,
      targetBranch,
      warnings,
      mergedBranchSha: branchSha,
      targetShaAfterMerge,
      statePath: runtimeStatePath
    };
  });
}

export async function cleanupRequirementWorktree(input = {}) {
  const projectRoot = normalizeProjectRoot(input.projectRoot);
  const requirementId = requiredString(input.requirementId, "requirementId");

  return await withRequirementLock(projectRoot, requirementId, input, async () => {
    await git(projectRoot, ["worktree", "prune"], input);
    const { path: runtimeStatePath, state: runtimeState } = await readRuntimeState(projectRoot, requirementId);
    if (!runtimeState) {
      const result = escalation("missing_runtime_state", { requirementId, statePath: runtimeStatePath });
      await appendEscalationEvent(projectRoot, requirementId, result.reason, result, input);
      return result;
    }

    const workspace = normalizeWorkspace(projectRoot, input.codeWorkspace, runtimeState);
    assertStateMatchesWorkspace(runtimeState, workspace);
    if (runtimeState.status === "archived") {
      return {
        status: "archived",
        requirementId,
        path: workspace.absolutePath,
        relativePath: workspace.relativePath,
        branch: workspace.branch,
        targetBranch: runtimeState.confirmed_target_branch,
        statePath: runtimeStatePath
      };
    }
    if (runtimeState.status !== "merged") {
      throw new ConflictError(`requirement worktree must be merged before cleanup: ${requirementId}`, {
        status: runtimeState.status
      });
    }

    const targetBranch = runtimeState.confirmed_target_branch;
    if (!targetBranch) {
      const result = escalation("missing_target_branch", { requirementId, statePath: runtimeStatePath });
      await appendEscalationEvent(projectRoot, requirementId, result.reason, result, input);
      return result;
    }
    if (!await branchExists(projectRoot, targetBranch, input)) {
      const result = escalation("target_branch_missing", {
        requirementId,
        targetBranch,
        path: workspace.absolutePath,
        branch: workspace.branch
      });
      await appendEscalationEvent(projectRoot, requirementId, result.reason, result, input);
      return result;
    }

    let activeBranch;
    try {
      activeBranch = await currentBranch(projectRoot, input);
    } catch {
      const result = escalation("target_branch_not_current", {
        requirementId,
        targetBranch,
        activeBranch: "HEAD"
      });
      await appendEscalationEvent(projectRoot, requirementId, result.reason, result, input);
      return result;
    }
    if (activeBranch !== targetBranch) {
      const result = escalation("target_branch_not_current", {
        requirementId,
        targetBranch,
        activeBranch
      });
      await appendEscalationEvent(projectRoot, requirementId, result.reason, result, input);
      return result;
    }

    const records = await worktreeRecords(projectRoot, input);
    const targetRecord = records.find((record) => samePath(record.path, workspace.absolutePath));
    if (targetRecord && targetRecord.branch !== workspace.branch) {
      const result = escalation("worktree_branch_mismatch", {
        requirementId,
        path: workspace.absolutePath,
        expectedBranch: workspace.branch,
        actualBranch: targetRecord.branch
      });
      await appendEscalationEvent(projectRoot, requirementId, result.reason, result, input);
      return result;
    }
    if (targetRecord) {
      const worktreeStatus = await statusPorcelain(workspace.absolutePath, input);
      if (worktreeStatus.trim()) {
        const result = escalation("worktree_dirty", {
          requirementId,
          path: workspace.absolutePath,
          porcelain: worktreeStatus
        });
        await appendEscalationEvent(projectRoot, requirementId, result.reason, result, input);
        return result;
      }
    }

    const hasBranch = await branchExists(projectRoot, workspace.branch, input);
    if (!hasBranch && !targetRecord) {
      const mergedSha = runtimeState.merged_branch_sha;
      if (mergedSha && await commitExists(projectRoot, mergedSha, input) && await isAncestor(projectRoot, mergedSha, targetBranch, input)) {
        const now = isoNow(input);
        const archivedState = {
          ...runtimeState,
          status: "archived",
          archived_at: runtimeState.archived_at ?? now,
          updated_at: now,
          archive: {
            ...(runtimeState.archive ?? {}),
            target_branch: targetBranch,
            recovery: "git_resources_already_cleaned"
          }
        };
        await writeRuntimeState(projectRoot, requirementId, archivedState, "cleanup");
        await appendWorktreeEvent(
          projectRoot,
          requirementId,
          "requirement_worktree_archived",
          {
            path: workspace.relativePath,
            branch: workspace.branch,
            target_branch: targetBranch,
            recovery: "git_resources_already_cleaned"
          },
          input
        );
        return {
          status: "archived",
          requirementId,
          path: workspace.absolutePath,
          relativePath: workspace.relativePath,
          branch: workspace.branch,
          targetBranch,
          statePath: runtimeStatePath,
          recovery: "git_resources_already_cleaned"
        };
      }
      const result = escalation("worktree_branch_missing", {
        requirementId,
        path: workspace.absolutePath,
        branch: workspace.branch
      });
      await appendEscalationEvent(projectRoot, requirementId, result.reason, result, input);
      return result;
    }

    const branchSha = hasBranch
      ? await gitOutput(projectRoot, ["rev-parse", workspace.branch], input)
      : runtimeState.merged_branch_sha;
    if (!branchSha || !await isAncestor(projectRoot, branchSha, targetBranch, input)) {
      const result = escalation("cleanup_branch_not_ancestor", {
        requirementId,
        targetBranch,
        branch: workspace.branch,
        branchSha
      });
      await appendEscalationEvent(projectRoot, requirementId, result.reason, result, input);
      return result;
    }

    if (targetRecord) {
      await git(projectRoot, ["worktree", "remove", workspace.absolutePath], input);
    } else {
      await assertPathAbsentOrExpectedWorktree(workspace.absolutePath, records);
    }
    if (await branchExists(projectRoot, workspace.branch, input)) {
      await git(projectRoot, ["branch", "-d", workspace.branch], input);
    }

    const now = isoNow(input);
    const archivedState = {
      ...runtimeState,
      status: "archived",
      archived_at: runtimeState.archived_at ?? now,
      updated_at: now,
      archive: {
        ...(runtimeState.archive ?? {}),
        target_branch: targetBranch,
        branch_sha: branchSha
      }
    };
    await writeRuntimeState(projectRoot, requirementId, archivedState, "cleanup");
    await appendWorktreeEvent(
      projectRoot,
      requirementId,
      "requirement_worktree_archived",
      {
        path: workspace.relativePath,
        branch: workspace.branch,
        target_branch: targetBranch
      },
      input
    );

    return {
      status: "archived",
      requirementId,
      path: workspace.absolutePath,
      relativePath: workspace.relativePath,
      branch: workspace.branch,
      targetBranch,
      statePath: runtimeStatePath
    };
  });
}

export async function reopenRequirementWorktree(input = {}) {
  const projectRoot = normalizeProjectRoot(input.projectRoot);
  const requirementId = requiredString(input.requirementId, "requirementId");

  return await withRequirementLock(projectRoot, requirementId, input, async () => {
    await git(projectRoot, ["worktree", "prune"], input);
    const { path: runtimeStatePath, state: runtimeState } = await readRuntimeState(projectRoot, requirementId);
    if (!runtimeState) {
      const result = escalation("missing_runtime_state", { requirementId, statePath: runtimeStatePath });
      await appendEscalationEvent(projectRoot, requirementId, result.reason, result, input);
      return result;
    }

    const workspace = normalizeWorkspace(projectRoot, input.codeWorkspace, runtimeState);
    assertStateMatchesWorkspace(runtimeState, workspace);
    if (runtimeState.status !== "merged") {
      throw new ConflictError(`requirement worktree must be merged before reopen: ${requirementId}`, {
        status: runtimeState.status
      });
    }

    const records = await worktreeRecords(projectRoot, input);
    const targetRecord = records.find((record) => samePath(record.path, workspace.absolutePath));
    if (!targetRecord) {
      const result = escalation("worktree_missing", {
        requirementId,
        path: workspace.absolutePath,
        branch: workspace.branch
      });
      await appendEscalationEvent(projectRoot, requirementId, result.reason, result, input);
      return result;
    }
    if (targetRecord.branch !== workspace.branch) {
      const result = escalation("worktree_branch_mismatch", {
        requirementId,
        path: workspace.absolutePath,
        expectedBranch: workspace.branch,
        actualBranch: targetRecord.branch
      });
      await appendEscalationEvent(projectRoot, requirementId, result.reason, result, input);
      return result;
    }
    if (!await branchExists(projectRoot, workspace.branch, input)) {
      const result = escalation("worktree_branch_missing", {
        requirementId,
        path: workspace.absolutePath,
        branch: workspace.branch
      });
      await appendEscalationEvent(projectRoot, requirementId, result.reason, result, input);
      return result;
    }

    const worktreeStatus = await statusPorcelain(workspace.absolutePath, input);
    if (worktreeStatus.trim()) {
      const result = escalation("worktree_dirty", {
        requirementId,
        path: workspace.absolutePath,
        porcelain: worktreeStatus
      });
      await appendEscalationEvent(projectRoot, requirementId, result.reason, result, input);
      return result;
    }

    const now = isoNow(input);
    const readyState = {
      ...runtimeState,
      status: "ready",
      reopened_at: now,
      updated_at: now
    };
    await writeRuntimeState(projectRoot, requirementId, readyState, "reopen");
    await appendWorktreeEvent(
      projectRoot,
      requirementId,
      "requirement_worktree_reopened",
      {
        path: workspace.relativePath,
        branch: workspace.branch,
        target_branch: runtimeState.confirmed_target_branch
      },
      input
    );

    return {
      status: "ready",
      requirementId,
      path: workspace.absolutePath,
      relativePath: workspace.relativePath,
      branch: workspace.branch,
      targetBranch: runtimeState.confirmed_target_branch,
      statePath: runtimeStatePath
    };
  });
}

export async function archiveRequirementWorktree(input = {}) {
  const merged = await mergeRequirementWorktree(input);
  if (merged.status === "escalated") return merged;
  const cleaned = await cleanupRequirementWorktree(input);
  return {
    ...cleaned,
    warnings: cleaned.warnings ?? merged.warnings ?? []
  };
}

export async function discardRequirementWorktree(input = {}) {
  const projectRoot = normalizeProjectRoot(input.projectRoot);
  const requirementId = requiredString(input.requirementId, "requirementId");

  return await withRequirementLock(projectRoot, requirementId, input, async () => {
    await git(projectRoot, ["worktree", "prune"], input);
    const { path: runtimeStatePath, state: runtimeState } = await readRuntimeState(projectRoot, requirementId);
    if (runtimeState?.status && runtimeState.status !== "ready") {
      throw new ConflictError(`requirement worktree must be ready before discard: ${requirementId}`, {
        status: runtimeState.status
      });
    }
    const workspace = normalizeWorkspace(projectRoot, input.codeWorkspace, runtimeState);
    assertStateMatchesWorkspace(runtimeState, workspace);

    const records = await worktreeRecords(projectRoot, input);
    const targetRecord = records.find((record) => samePath(record.path, workspace.absolutePath));
    if (targetRecord) {
      if (targetRecord.branch !== workspace.branch) {
        throw new ConflictError(`worktree path is checked out with unexpected branch: ${workspace.absolutePath}`, {
          path: workspace.absolutePath
        });
      }
      await git(projectRoot, ["worktree", "remove", "--force", workspace.absolutePath], input);
    } else {
      await assertPathAbsentOrExpectedWorktree(workspace.absolutePath, records);
    }

    if (await branchExists(projectRoot, workspace.branch, input)) {
      await git(projectRoot, ["branch", "-D", workspace.branch], input);
    }

    const now = isoNow(input);
    const discardedState = {
      ...(runtimeState ?? {
        schema_version: STATE_SCHEMA_VERSION,
        requirement_id: requirementId,
        path: workspace.relativePath,
        branch: workspace.branch,
        confirmed_target_branch: null,
        base_sha: null,
        created_at: null
      }),
      status: "discarded",
      discarded_at: now,
      updated_at: now
    };
    await writeRuntimeState(projectRoot, requirementId, discardedState, "discard");
    await appendWorktreeEvent(
      projectRoot,
      requirementId,
      "requirement_worktree_discarded",
      {
        path: workspace.relativePath,
        branch: workspace.branch
      },
      input
    );

    return {
      status: "discarded",
      requirementId,
      path: workspace.absolutePath,
      relativePath: workspace.relativePath,
      branch: workspace.branch,
      statePath: runtimeStatePath
    };
  });
}
