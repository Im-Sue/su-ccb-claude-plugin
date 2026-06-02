import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { assertInitializedProject, initProjectScaffold } from "../index.mjs";

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
