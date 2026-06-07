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
import {
  WORKTREE_STATE_SCHEMA_VERSION_V02,
  normalizeWorktreeStateV02,
  serializeWorktreeStateV02
} from "./state.mjs";
import {
  expandTopology,
  loadImplementationTopology,
  topologySourceFor
} from "./topology.mjs";

const execFileAsync = promisify(execFile);

const SOURCE_ACTOR = "ccb_claude";
const STATE_SCHEMA_VERSION = WORKTREE_STATE_SCHEMA_VERSION_V02;
const GIT_MAX_BUFFER = 10 * 1024 * 1024;
const GIT_DIAGNOSTIC_SNIPPET_LENGTH = 500;
const SUBMODULE_REMOVE_REJECTION = /working trees containing submodules cannot be moved or removed/;
const MULTI_SPACE_ORCHESTRATOR_REQUIRED = "multi-space runtime requires the multi-space orchestrator (pr4)";

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
      maxBuffer: GIT_MAX_BUFFER,
      env: {
        ...process.env,
        ...(options.env ?? {}),
        LC_ALL: "C",
        LANG: "C",
        LANGUAGE: "C"
      }
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

function truncateGitDiagnostic(value) {
  const output = typeof value === "string" ? value : "";
  return output.length > GIT_DIAGNOSTIC_SNIPPET_LENGTH
    ? output.slice(0, GIT_DIAGNOSTIC_SNIPPET_LENGTH)
    : output;
}

function cleanupGitFailurePayload(requirementId, workspace, failure = {}, forceAttempted = false) {
  return {
    requirementId,
    path: workspace.absolutePath,
    branch: workspace.branch,
    forceAttempted,
    exitCode: Number.isInteger(failure.exitCode) ? failure.exitCode : 1,
    stderr: truncateGitDiagnostic(failure.stderr),
    stdout: truncateGitDiagnostic(failure.stdout)
  };
}

function gitFailureFromError(error) {
  return {
    exitCode: Number.isInteger(error?.exitCode) ? error.exitCode : 1,
    stderr: error?.stderr ?? error?.message ?? "",
    stdout: error?.stdout ?? ""
  };
}

async function removeWorktreeForCleanup(projectRoot, absolutePath, options = {}) {
  const result = await git(projectRoot, ["worktree", "remove", absolutePath], {
    ...options,
    allowFailure: true
  });
  if (result.exitCode === 0) return { removed: true, forceAttempted: false };

  if (SUBMODULE_REMOVE_REJECTION.test(result.stderr ?? "")) {
    const forced = await git(projectRoot, ["worktree", "remove", "--force", absolutePath], {
      ...options,
      allowFailure: true
    });
    if (forced.exitCode === 0) return { removed: true, forceAttempted: true };
    return { removed: false, forceAttempted: true, ...forced };
  }

  return { removed: false, forceAttempted: false, ...result };
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

function assertSingleSpaceRuntime(runtimeState) {
  if (!runtimeState) return;
  if (runtimeState.spaces.length !== 1 || runtimeState.associations.length !== 0) {
    throw new ConflictError(MULTI_SPACE_ORCHESTRATOR_REQUIRED);
  }
}

function rootSpaceFromState(runtimeState) {
  return runtimeState?.spaces?.find((space) => space.space_id === "root") ?? runtimeState?.spaces?.[0] ?? null;
}

function singleSpaceRuntimeView(runtimeState) {
  if (!runtimeState) return null;
  assertSingleSpaceRuntime(runtimeState);
  const space = rootSpaceFromState(runtimeState);
  return {
    schema_version: runtimeState.schema_version,
    requirement_id: runtimeState.requirement_id,
    status: space.status,
    path: space.path,
    branch: space.branch,
    confirmed_target_branch: space.target_branch,
    base_sha: space.base_sha,
    merged_branch_sha: space.merged_branch_sha,
    target_sha_after_merge: space.target_sha_after_merge,
    merged_at: space.merged_at,
    merge: space.merge,
    archived_at: space.archived_at,
    archive: space.archive,
    discarded_at: space.discarded_at,
    reopened_at: space.reopened_at,
    topology_source: runtimeState.topology_source,
    last_error: space.last_error ?? runtimeState.last_error,
    created_at: runtimeState.created_at,
    updated_at: runtimeState.updated_at
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

async function readRuntimeState(projectRoot, requirementId, options = {}) {
  const path = statePath(projectRoot, requirementId);
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return {
      path,
      state: options.normalized ? normalizeWorktreeStateV02(parsed) : parsed,
      rawState: parsed
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { path, state: null };
    if (error instanceof SyntaxError) {
      throw new ValidationError(`invalid worktree runtime state JSON: ${path}`, { path, cause: error });
    }
    throw new IOError(`failed to read worktree runtime state: ${path}`, { path, cause: error });
  }
}

async function readSingleSpaceRuntimeState(projectRoot, requirementId) {
  const { path, state } = await readRuntimeState(projectRoot, requirementId, { normalized: true });
  return { path, state: singleSpaceRuntimeView(state) };
}

async function writeRuntimeState(projectRoot, requirementId, state, operation, options = {}) {
  const path = statePath(projectRoot, requirementId);
  await safeWriteFile(path, serializeWorktreeStateV02(state), {
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

function rootSpaceOrThrow(spaces) {
  const root = spaces.find((space) => space.space_id === "root");
  if (!root) {
    throw new ConflictError("implementation topology must declare a root space");
  }
  return root;
}

function assertRootSpaceMatchesWorkspace(projectRoot, rootSpace, codeWorkspace) {
  const rootWorkspace = normalizeWorkspace(projectRoot, {
    path: rootSpace.path,
    branch: rootSpace.branch
  });
  assertStateMatchesWorkspace(
    {
      path: rootWorkspace.relativePath,
      branch: rootWorkspace.branch
    },
    normalizeWorkspace(projectRoot, codeWorkspace)
  );
}

function spaceWorkspace(projectRoot, space) {
  return {
    relativePath: space.path,
    absolutePath: resolve(projectRoot, space.path),
    branch: space.branch,
    repoRoot: resolve(projectRoot, space.repo)
  };
}

function branchTemplatePrefix(template) {
  if (typeof template !== "string") return "";
  const marker = template.indexOf("<requirementId>");
  return marker === -1 ? "" : template.slice(0, marker);
}

function implementationBranchPrefix(space, topology, requirementId) {
  const declared = topology?.spaces?.find((candidate) => candidate.space_id === space.space_id);
  const declaredPrefix = branchTemplatePrefix(declared?.branch);
  if (declaredPrefix) return declaredPrefix;
  const marker = space.branch.indexOf(requirementId);
  return marker > 0 ? space.branch.slice(0, marker) : "";
}

function ensureConflict(message, reason, payload = {}) {
  const error = new ConflictError(message, payload);
  error.ccbEnsureReason = reason;
  error.ccbEnsurePayload = payload;
  return error;
}

function ensureLastError(reason, spaceId, options, payload = {}) {
  return {
    op: "ensure",
    space_id: spaceId,
    reason,
    at: isoNow(options),
    ...payload
  };
}

function updateSpace(runtimeState, spaceId, updater) {
  return {
    ...runtimeState,
    spaces: runtimeState.spaces.map((space) =>
      space.space_id === spaceId ? updater(space) : space
    )
  };
}

function markEnsureFailure(runtimeState, spaceId, reason, options, payload = {}) {
  const lastError = ensureLastError(reason, spaceId, options, payload);
  const next = updateSpace(runtimeState, spaceId, (space) => ({
    ...space,
    last_error: lastError
  }));
  return {
    ...next,
    last_error: lastError,
    updated_at: isoNow(options)
  };
}

async function ensureSpaceWorktree(projectRoot, requirementId, topology, space, input = {}) {
  const workspace = spaceWorkspace(projectRoot, space);
  await git(workspace.repoRoot, ["worktree", "prune"], { ...input, cwd: workspace.repoRoot });
  const records = await worktreeRecords(workspace.repoRoot, { ...input, cwd: workspace.repoRoot });
  const targetRecord = records.find((record) => samePath(record.path, workspace.absolutePath));
  const branchRecord = records.find((record) => record.branch === workspace.branch);

  if (targetRecord && targetRecord.branch !== workspace.branch) {
    throw new ConflictError(`worktree path is checked out with unexpected branch: ${workspace.absolutePath}`, {
      path: workspace.absolutePath,
      space_id: space.space_id
    });
  }
  if (branchRecord && !samePath(branchRecord.path, workspace.absolutePath)) {
    throw new ConflictError(`worktree branch is already checked out at another path: ${workspace.branch}`, {
      path: branchRecord.path,
      space_id: space.space_id
    });
  }
  await assertPathAbsentOrExpectedWorktree(workspace.absolutePath, records);

  if (targetRecord) {
    if (!space.target_branch || !space.base_sha) {
      throw new ConflictError(`worktree exists but runtime target state is missing: ${requirementId}`, {
        path: workspace.absolutePath,
        space_id: space.space_id
      });
    }
    return {
      status: "existing",
      space: {
        ...space,
        status: "ready",
        last_error: null
      },
      workspace
    };
  }

  if (await branchExists(workspace.repoRoot, workspace.branch, { ...input, cwd: workspace.repoRoot })) {
    throw new ConflictError(`worktree branch already exists without the expected worktree: ${workspace.branch}`, {
      space_id: space.space_id
    });
  }

  let targetBranch;
  try {
    targetBranch = await currentBranch(workspace.repoRoot, { ...input, cwd: workspace.repoRoot });
  } catch (error) {
    if (error instanceof ConflictError) {
      throw ensureConflict(
        `implementation space canonical checkout is detached: ${space.space_id}`,
        "target_branch_detached",
        { space_id: space.space_id, repo: space.repo }
      );
    }
    throw error;
  }

  const branchPrefix = implementationBranchPrefix(space, topology, requirementId);
  if (branchPrefix && targetBranch.startsWith(branchPrefix)) {
    throw ensureConflict(
      `implementation branch cannot be captured as merge target: ${targetBranch}`,
      "implementation_branch_as_target",
      { space_id: space.space_id, captured_target: targetBranch }
    );
  }

  const baseSha = await headSha(workspace.repoRoot, { ...input, cwd: workspace.repoRoot });
  await git(
    workspace.repoRoot,
    ["worktree", "add", "-b", workspace.branch, workspace.absolutePath, "HEAD"],
    { ...input, cwd: workspace.repoRoot }
  );

  return {
    status: "created",
    space: {
      ...space,
      target_branch: targetBranch,
      base_sha: baseSha,
      status: "ready",
      last_error: null
    },
    workspace
  };
}

export function requirementWorktreeStatePath(projectRoot, requirementId) {
  return statePath(normalizeProjectRoot(projectRoot), requiredString(requirementId, "requirementId"));
}

export async function ensureRequirementWorktree(input = {}) {
  const projectRoot = normalizeProjectRoot(input.projectRoot);
  const requirementId = requiredString(input.requirementId, "requirementId");

  return await withRequirementLock(projectRoot, requirementId, input, async () => {
    const topology = await loadImplementationTopology({ projectRoot });
    const expanded = expandTopology({
      topology,
      requirementId,
      codeWorkspace: input.codeWorkspace,
      projectRoot
    });
    const { path: runtimeStatePath, state: existingState, rawState: existingRawState } =
      await readRuntimeState(projectRoot, requirementId, { normalized: true });
    const now = isoNow(input);
    let runtimeState = existingState ?? {
      schema_version: STATE_SCHEMA_VERSION,
      requirement_id: requirementId,
      aggregate_status: "pending",
      spaces: expanded.spaces,
      associations: expanded.associations,
      topology_source: topologySourceFor(topology, expanded.contentHash),
      last_error: null,
      created_at: now,
      updated_at: now
    };

    const rootSpace = rootSpaceOrThrow(runtimeState.spaces);
    assertRootSpaceMatchesWorkspace(projectRoot, rootSpace, input.codeWorkspace);

    if (!["pending", "ready"].includes(runtimeState.aggregate_status)) {
      throw new ConflictError(`requirement worktree is already ${runtimeState.aggregate_status}: ${requirementId}`);
    }

    if (!existingState) {
      await writeRuntimeState(projectRoot, requirementId, runtimeState, "ensure", input);
    }

    let createdAny = false;
    let existingAny = false;
    let forceStateWrite = !existingState || existingRawState?.schema_version !== STATE_SCHEMA_VERSION;
    for (const space of runtimeState.spaces) {
      try {
        const result = await ensureSpaceWorktree(projectRoot, requirementId, topology, space, input);
        createdAny = createdAny || result.status === "created";
        existingAny = existingAny || result.status === "existing";
        const shouldWriteState = forceStateWrite ||
          result.status !== "existing" ||
          space.status !== "ready" ||
          space.last_error !== null ||
          runtimeState.last_error !== null;
        runtimeState = normalizeWorktreeStateV02({
          ...updateSpace(runtimeState, space.space_id, () => result.space),
          last_error: null,
          updated_at: shouldWriteState ? isoNow(input) : runtimeState.updated_at
        });
        if (shouldWriteState) {
          await writeRuntimeState(projectRoot, requirementId, runtimeState, "ensure", input);
          forceStateWrite = false;
        }
        await appendWorktreeEvent(
          projectRoot,
          requirementId,
          result.status === "existing" ? "requirement_worktree_ensure_noop" : "requirement_worktree_ensured",
          {
            space_id: result.space.space_id,
            repo: result.space.repo,
            path: result.space.path,
            branch: result.space.branch,
            confirmed_target_branch: result.space.target_branch,
            base_sha: result.space.base_sha
          },
          input
        );
      } catch (error) {
        const reason = error?.ccbEnsureReason ?? "ensure_failed";
        const payload = error?.ccbEnsurePayload ?? { space_id: space.space_id };
        runtimeState = markEnsureFailure(runtimeState, space.space_id, reason, input, payload);
        await writeRuntimeState(projectRoot, requirementId, runtimeState, "ensure", input);
        if (reason === "implementation_branch_as_target" || reason === "target_branch_detached") {
          await appendEscalationEvent(projectRoot, requirementId, reason, {
            requirementId,
            ...payload
          }, input);
        }
        throw error;
      }
    }

    const finalRoot = rootSpaceOrThrow(runtimeState.spaces);
    const finalWorkspace = spaceWorkspace(projectRoot, finalRoot);
    const status = createdAny ? "created" : existingAny ? "existing" : "existing";
    return {
      status,
      requirementId,
      path: finalWorkspace.absolutePath,
      relativePath: finalWorkspace.relativePath,
      branch: finalWorkspace.branch,
      targetBranch: finalRoot.target_branch,
      baseSha: finalRoot.base_sha,
      statePath: runtimeStatePath,
      spaces: runtimeState.spaces.map((space) => ({
        space_id: space.space_id,
        repo: space.repo,
        path: resolve(projectRoot, space.path),
        relativePath: space.path,
        branch: space.branch,
        targetBranch: space.target_branch,
        baseSha: space.base_sha,
        status: space.status
      })),
      aggregateStatus: runtimeState.aggregate_status
    };
  });
}

export async function mergeRequirementWorktree(input = {}) {
  const projectRoot = normalizeProjectRoot(input.projectRoot);
  const requirementId = requiredString(input.requirementId, "requirementId");

  return await withRequirementLock(projectRoot, requirementId, input, async () => {
    await git(projectRoot, ["worktree", "prune"], input);
    const { path: runtimeStatePath, state: runtimeState } = await readSingleSpaceRuntimeState(projectRoot, requirementId);
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
    const { path: runtimeStatePath, state: runtimeState } = await readSingleSpaceRuntimeState(projectRoot, requirementId);
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
            recovery: "git_resources_already_cleaned",
            removal_forced: false
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

    let removalForced = false;
    if (targetRecord) {
      const removal = await removeWorktreeForCleanup(projectRoot, workspace.absolutePath, input);
      removalForced = removal.forceAttempted;
      if (!removal.removed) {
        const result = escalation(
          "cleanup_worktree_remove_failed",
          cleanupGitFailurePayload(requirementId, workspace, removal, removal.forceAttempted)
        );
        await appendEscalationEvent(projectRoot, requirementId, result.reason, result, input);
        return result;
      }
    } else {
      await assertPathAbsentOrExpectedWorktree(workspace.absolutePath, records);
    }
    let shouldDeleteBranch;
    try {
      shouldDeleteBranch = await branchExists(projectRoot, workspace.branch, input);
    } catch (error) {
      const result = escalation(
        "cleanup_branch_delete_failed",
        cleanupGitFailurePayload(requirementId, workspace, gitFailureFromError(error), removalForced)
      );
      await appendEscalationEvent(projectRoot, requirementId, result.reason, result, input);
      return result;
    }
    if (shouldDeleteBranch) {
      const branchDelete = await git(projectRoot, ["branch", "-d", workspace.branch], {
        ...input,
        allowFailure: true
      });
      if (branchDelete.exitCode !== 0) {
        const result = escalation(
          "cleanup_branch_delete_failed",
          cleanupGitFailurePayload(requirementId, workspace, branchDelete, removalForced)
        );
        await appendEscalationEvent(projectRoot, requirementId, result.reason, result, input);
        return result;
      }
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
        target_branch: targetBranch,
        removal_forced: removalForced
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
    const { path: runtimeStatePath, state: runtimeState } = await readSingleSpaceRuntimeState(projectRoot, requirementId);
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
    const { path: runtimeStatePath, state: runtimeState } = await readSingleSpaceRuntimeState(projectRoot, requirementId);
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
