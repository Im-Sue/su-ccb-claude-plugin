import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { assertInitializedProject, detectArchitectureCandidate, initProjectScaffold } from "../index.mjs";

async function tempProject() {
  return join(tmpdir(), `ccb-su-init-${randomUUID()}`);
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function writeProjectFile(projectRoot, relativePath, content = "") {
  const path = join(projectRoot, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

test("initProjectScaffold creates docs-driven project structure from contract", async () => {
  const projectRoot = await tempProject();
  try {
    const summary = await initProjectScaffold({ projectRoot });
    const verification = await assertInitializedProject(projectRoot);

    assert.equal(verification.ok, true, verification.missing.join(", "));
    assert.ok(summary.created.length > 0);
    assert.match(await readFile(join(projectRoot, "docs", "00_项目总览.md"), "utf8"), /doc_type: project_overview/);
    assert.match(
      await readFile(join(projectRoot, "docs", ".ccb", "docs-structure-contract.yaml"), "utf8"),
      /^version: docs-structure-contract-v0\.1/m
    );
    assert.equal(await exists(join(projectRoot, "docs", ".ccb", "config")), true);
    assert.equal(await exists(join(projectRoot, "docs", ".ccb", "config", "capabilities.project.yaml")), false);
    assert.equal(await readFile(join(projectRoot, "docs", ".ccb", "events", "journal.jsonl"), "utf8"), "");
    assert.equal(await exists(join(projectRoot, "docs", "00_文档地图.md")), false);
    assert.equal(await exists(join(projectRoot, "docs", ".ccb", "specs")), false);
    assert.equal(await exists(join(projectRoot, "docs", ".ccb", "requirements")), false);
    assert.equal(summary.architectureCandidate.reason, "no_source");
    assert.equal(summary.architectureCandidate.eligible, false);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("initProjectScaffold is additive and does not overwrite existing files", async () => {
  const projectRoot = await tempProject();
  try {
    await initProjectScaffold({ projectRoot });
    const overviewPath = join(projectRoot, "docs", "00_项目总览.md");
    const before = await readFile(overviewPath, "utf8");
    const second = await initProjectScaffold({ projectRoot });
    const after = await readFile(overviewPath, "utf8");

    assert.equal(after, before);
    assert.ok(second.skipped.some((item) => item.path === "docs/00_项目总览.md"));
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("detectArchitectureCandidate returns no_source for empty and bare git projects", async () => {
  const emptyRoot = await tempProject();
  const gitRoot = await tempProject();
  try {
    assert.equal((await detectArchitectureCandidate({ projectRoot: emptyRoot })).reason, "no_source");

    await mkdir(join(gitRoot, ".git"), { recursive: true });
    const candidate = await detectArchitectureCandidate({ projectRoot: gitRoot });
    assert.equal(candidate.reason, "no_source");
    assert.deepEqual(candidate.sourceRoots, []);
  } finally {
    await rm(emptyRoot, { recursive: true, force: true });
    await rm(gitRoot, { recursive: true, force: true });
  }
});

test("detectArchitectureCandidate accepts a single marker root and returns a concrete target path", async () => {
  const projectRoot = await tempProject();
  try {
    await writeProjectFile(projectRoot, "package.json", "{\"name\":\"single\"}\n");

    const candidate = await detectArchitectureCandidate({ projectRoot });
    assert.equal(candidate.eligible, true);
    assert.equal(candidate.reason, "eligible");
    assert.deepEqual(candidate.sourceRoots, ["."]);
    assert.match(candidate.targetPath, /^docs\/01_架构设计\/ccb-su-init-[a-z0-9-]+-架构\.md$/);
    assert.equal(candidate.targetPath.includes("<"), false);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("detectArchitectureCandidate accepts marker-less projects with at least three source files", async () => {
  const projectRoot = await tempProject();
  try {
    await writeProjectFile(projectRoot, "src/a.js", "export const a = 1;\n");
    await writeProjectFile(projectRoot, "src/b.ts", "export const b = 2;\n");
    await writeProjectFile(projectRoot, "scripts/run.sh", "echo run\n");

    const candidate = await detectArchitectureCandidate({ projectRoot });
    assert.equal(candidate.eligible, true);
    assert.equal(candidate.reason, "eligible");
    assert.deepEqual(candidate.sourceRoots, ["."]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("detectArchitectureCandidate skips monorepo signals and multiple marker roots", async () => {
  const gitmodulesRoot = await tempProject();
  const twoMarkersRoot = await tempProject();
  const rootAggregator = await tempProject();
  try {
    await writeProjectFile(gitmodulesRoot, ".gitmodules", "[submodule \"app\"]\n");
    await writeProjectFile(gitmodulesRoot, "docs/01_架构设计/已有架构.md", "---\ndoc_type: architecture\n---\n");
    const gitmodules = await detectArchitectureCandidate({ projectRoot: gitmodulesRoot });
    assert.equal(gitmodules.reason, "multiple_source_roots");
    assert.deepEqual(gitmodules.existingArchitectureDocs, ["docs/01_架构设计/已有架构.md"]);

    await writeProjectFile(twoMarkersRoot, "frontend/package.json", "{\"name\":\"frontend\"}\n");
    await writeProjectFile(twoMarkersRoot, "backend/package.json", "{\"name\":\"backend\"}\n");
    const twoMarkers = await detectArchitectureCandidate({ projectRoot: twoMarkersRoot });
    assert.equal(twoMarkers.reason, "multiple_source_roots");
    assert.deepEqual(twoMarkers.sourceRoots, ["backend", "frontend"]);

    await writeProjectFile(rootAggregator, "package.json", "{\"name\":\"root\"}\n");
    await writeProjectFile(rootAggregator, "packages/api/package.json", "{\"name\":\"api\"}\n");
    const aggregator = await detectArchitectureCandidate({ projectRoot: rootAggregator });
    assert.equal(aggregator.reason, "multiple_source_roots");
    assert.deepEqual(aggregator.sourceRoots, [".", "packages/api"]);
  } finally {
    await rm(gitmodulesRoot, { recursive: true, force: true });
    await rm(twoMarkersRoot, { recursive: true, force: true });
    await rm(rootAggregator, { recursive: true, force: true });
  }
});

test("detectArchitectureCandidate treats non-template architecture markdown recursively as existing output", async () => {
  const projectRoot = await tempProject();
  try {
    await writeProjectFile(projectRoot, "package.json", "{\"name\":\"single\"}\n");
    await writeProjectFile(projectRoot, "docs/01_架构设计/nested/已有架构.md", "---\ndoc_type: architecture\n---\n");

    const candidate = await detectArchitectureCandidate({ projectRoot });
    assert.equal(candidate.eligible, false);
    assert.equal(candidate.reason, "architecture_exists");
    assert.deepEqual(candidate.existingArchitectureDocs, ["docs/01_架构设计/nested/已有架构.md"]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("detectArchitectureCandidate ignores architecture templates", async () => {
  const projectRoot = await tempProject();
  try {
    await writeProjectFile(projectRoot, "package.json", "{\"name\":\"single\"}\n");
    await writeProjectFile(projectRoot, "docs/01_架构设计/_模板_架构.md", "# template\n");

    const candidate = await detectArchitectureCandidate({ projectRoot });
    assert.equal(candidate.eligible, true);
    assert.equal(candidate.reason, "eligible");
    assert.deepEqual(candidate.existingArchitectureDocs, []);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
