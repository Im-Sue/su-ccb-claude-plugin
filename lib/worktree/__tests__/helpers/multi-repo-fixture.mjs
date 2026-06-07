import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { requirementWorktreeStatePath } from "../../index.mjs";

const execFileAsync = promisify(execFile);

export async function git(cwd, args, options = {}) {
  const result = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
    ...options
  });
  return (result.stdout ?? "").trim();
}

export async function runGitResult(cwd, args, options = {}) {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      env: options.env ? { ...process.env, ...options.env } : undefined
    });
    return {
      exitCode: 0,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? ""
    };
  } catch (error) {
    return {
      exitCode: Number.isInteger(error?.code) ? error.code : 1,
      stdout: error?.stdout ?? "",
      stderr: error?.stderr ?? ""
    };
  }
}

async function initRepo(repoRoot, fileName, content, message) {
  await mkdir(repoRoot, { recursive: true });
  await git(repoRoot, ["init", "-b", "main"]);
  await git(repoRoot, ["config", "user.email", "ccb-test@example.invalid"]);
  await git(repoRoot, ["config", "user.name", "CCB Test"]);
  await writeFile(join(repoRoot, fileName), content, "utf8");
  await git(repoRoot, ["add", fileName]);
  await git(repoRoot, ["commit", "-m", message]);
}

export function codeWorkspace(requirementId) {
  return {
    path: `../root-req-${requirementId}`,
    branch: `ccb/req-${requirementId}`
  };
}

export function spaceWorktreePath(projectRoot, requirementId, spaceId) {
  const prefix = spaceId === "root" ? "root" : spaceId;
  return resolve(projectRoot, `../${prefix}-req-${requirementId}`);
}

export async function writeTopology(projectRoot, content) {
  const path = join(projectRoot, "docs", ".ccb", "config", "implementation-topology.yaml");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  return path;
}

export function twoSpaceTopologyYaml(options = {}) {
  const pluginPath = options.pluginPath ?? "../plugin-req-<requirementId>";
  return `
schema_version: implementation-topology-v0.1
spaces:
  - space_id: root
    kind: git_worktree
    repo: "."
    worktree_path: "../root-req-<requirementId>"
    branch: "ccb/req-<requirementId>"
  - space_id: plugin
    kind: git_worktree
    repo: "vendor/plugin"
    worktree_path: "${pluginPath}"
    branch: "ccb/req-<requirementId>"
associations:
  - association_id: plugin-to-root
    kind: git_submodule_gitlink
    from_space: plugin
    to_space: root
    submodule_path: "vendor/plugin"
`;
}

export async function readState(projectRoot, requirementId) {
  return JSON.parse(await readFile(requirementWorktreeStatePath(projectRoot, requirementId), "utf8"));
}

export async function readJournalEvents(projectRoot) {
  const journal = await readFile(join(projectRoot, "docs", ".ccb", "events", "journal.jsonl"), "utf8");
  return journal
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export async function createMultiRepoFixture(options = {}) {
  const baseDir = await mkdtemp(join(tmpdir(), `ccb-multirepo-${randomUUID()}-`));
  const projectRoot = join(baseDir, "superproject");
  const submoduleSource = join(baseDir, "plugin-source");
  await initRepo(submoduleSource, "plugin.txt", "plugin\n", "plugin initial");
  await initRepo(projectRoot, "README.md", "root\n", "root initial");

  await git(projectRoot, [
    "-c",
    "protocol.file.allow=always",
    "submodule",
    "add",
    submoduleSource,
    "vendor/plugin"
  ]);
  await git(projectRoot, ["commit", "-m", "add plugin submodule"]);

  const pluginRepo = join(projectRoot, "vendor", "plugin");
  await git(pluginRepo, ["config", "user.email", "ccb-test@example.invalid"]);
  await git(pluginRepo, ["config", "user.name", "CCB Test"]);
  await writeTopology(projectRoot, options.topologyYaml ?? twoSpaceTopologyYaml(options));

  return {
    baseDir,
    projectRoot,
    pluginRepo,
    submoduleSource,
    cleanup: async () => {
      await rm(baseDir, { recursive: true, force: true });
    }
  };
}
