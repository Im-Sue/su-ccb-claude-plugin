import { chmod, copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_CONTRACT_PATH,
  DEFAULT_SCHEMA_PATH,
  loadDocsStructureResolver
} from "../docs-structure/index.mjs";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const templatesRoot = join(pluginRoot, "templates");
const docsTemplatesRoot = join(templatesRoot, "docs");

function normalizePath(value) {
  return value.replace(/\\/g, "/");
}

function rel(projectRoot, absolutePath) {
  return normalizePath(relative(projectRoot, absolutePath));
}

async function listFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(path)));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

async function buildTemplateIndex() {
  const files = await listFiles(docsTemplatesRoot);
  const byName = new Map();
  for (const file of files) {
    byName.set(basename(file), file);
  }
  return byName;
}

async function ensureDir(projectRoot, absolutePath, summary) {
  if (existsSync(absolutePath)) {
    summary.skipped.push({ path: rel(projectRoot, absolutePath), reason: "exists" });
    return;
  }
  await mkdir(absolutePath, { recursive: true });
  summary.created.push({ path: rel(projectRoot, absolutePath), type: "dir" });
}

async function copyIfMissing(projectRoot, sourcePath, targetPath, summary) {
  if (existsSync(targetPath)) {
    summary.skipped.push({ path: rel(projectRoot, targetPath), reason: "exists" });
    return;
  }
  await mkdir(dirname(targetPath), { recursive: true });
  await copyFile(sourcePath, targetPath);
  summary.created.push({ path: rel(projectRoot, targetPath), type: "file" });
}

async function writeIfMissing(projectRoot, targetPath, content, summary) {
  if (existsSync(targetPath)) {
    summary.skipped.push({ path: rel(projectRoot, targetPath), reason: "exists" });
    return;
  }
  await mkdir(dirname(targetPath), { recursive: true });
  await writeFile(targetPath, content, "utf8");
  summary.created.push({ path: rel(projectRoot, targetPath), type: "file" });
}

function isGeneratedDoc(resolvedDocType) {
  return resolvedDocType.maintainedBy === "generated";
}

function isConcreteOutputPath(resolvedDocType) {
  return !resolvedDocType.outputPathPattern.includes("<");
}

async function scaffoldHumanDocs({ projectRoot, resolver, summary }) {
  const templates = await buildTemplateIndex();
  const copiedTemplateNames = new Set();

  for (const docType of resolver.availableDocTypes) {
    const resolved = resolver.resolveDocType(docType);
    await ensureDir(projectRoot, join(projectRoot, resolved.directory), summary);

    if (!resolved.template || isGeneratedDoc(resolved)) {
      continue;
    }

    const sourcePath = templates.get(basename(resolved.template));
    if (!sourcePath) {
      summary.warnings.push(`template not found for ${docType}: ${resolved.template}`);
      continue;
    }

    const targetPath = isConcreteOutputPath(resolved)
      ? join(projectRoot, resolved.outputPathPattern)
      : join(projectRoot, resolved.directory, basename(resolved.template));
    const targetKey = normalizePath(targetPath);
    if (copiedTemplateNames.has(targetKey)) {
      continue;
    }
    copiedTemplateNames.add(targetKey);
    await copyIfMissing(projectRoot, sourcePath, targetPath, summary);
  }
}

function machineRootFromContract(resolver) {
  return resolver.contract.machine_layer?.root ?? "docs/.ccb/";
}

function contractMachinePaths(resolver) {
  const paths = new Set(["index/", "config/"]);
  for (const raw of resolver.contract.machine_layer?.holds ?? []) {
    if (typeof raw !== "string") continue;
    for (const match of raw.matchAll(/[a-z0-9._/-]+\/?/gi)) {
      const value = match[0];
      if (value.includes("/") || value.endsWith(".jsonl")) {
        paths.add(value);
      }
    }
  }
  return [...paths];
}

async function scaffoldMachineLayer({ projectRoot, resolver, summary }) {
  const machineRoot = join(projectRoot, machineRootFromContract(resolver));
  await ensureDir(projectRoot, machineRoot, summary);

  for (const machinePath of contractMachinePaths(resolver)) {
    const target = join(machineRoot, machinePath);
    if (machinePath.endsWith(".jsonl")) {
      await writeIfMissing(projectRoot, target, "", summary);
    } else {
      await ensureDir(projectRoot, target, summary);
    }
  }

  await copyIfMissing(
    projectRoot,
    DEFAULT_CONTRACT_PATH,
    join(machineRoot, "docs-structure-contract.yaml"),
    summary
  );
  await copyIfMissing(
    projectRoot,
    DEFAULT_SCHEMA_PATH,
    join(machineRoot, "schemas", "docs-structure-contract.schema.yaml"),
    summary
  );
}

async function scaffoldAgentFiles({ projectRoot, summary }) {
  await copyIfMissing(projectRoot, join(templatesRoot, "claude-md-template.md"), join(projectRoot, "CLAUDE.md"), summary);
  await copyIfMissing(projectRoot, join(templatesRoot, "codex-md-template.md"), join(projectRoot, "AGENTS.md"), summary);
  await copyIfMissing(
    projectRoot,
    join(pluginRoot, "references", "settings-template.json"),
    join(projectRoot, ".claude", "settings.json"),
    summary
  );

  const hooksRoot = join(templatesRoot, "hooks");
  if (!existsSync(hooksRoot)) return;
  for (const hookPath of await listFiles(hooksRoot)) {
    const targetPath = join(projectRoot, ".claude", "hooks", basename(hookPath));
    await copyIfMissing(projectRoot, hookPath, targetPath, summary);
    await chmod(targetPath, 0o755).catch(() => {});
  }
}

export async function initProjectScaffold(options = {}) {
  const projectRoot = options.projectRoot ?? process.cwd();
  const resolver = options.resolver ?? (await loadDocsStructureResolver(options));
  const summary = {
    projectRoot,
    created: [],
    skipped: [],
    warnings: []
  };

  await scaffoldHumanDocs({ projectRoot, resolver, summary });
  await scaffoldMachineLayer({ projectRoot, resolver, summary });
  await scaffoldAgentFiles({ projectRoot, summary });

  const docMap = resolver.resolveDocType("doc_map");
  summary.warnings.push(`${docMap.outputPathPattern} is generated by indexer and was not created by su-init`);

  return summary;
}

export async function assertInitializedProject(projectRoot) {
  const requiredPaths = [
    "CLAUDE.md",
    "AGENTS.md",
    ".claude/settings.json",
    "docs/00_项目总览.md",
    "docs/01_架构设计/_模板_架构.md",
    "docs/02_需求设计/_模板_需求.md",
    "docs/03_开发计划/_模板_技术设计.md",
    "docs/03_开发计划/_模板_开发任务.md",
    "docs/04_模块规格/_模板_模块规格.md",
    "docs/05_经验沉淀/_模板_经验沉淀.md",
    "docs/06_决策记录/_模板_ADR.md",
    "docs/99_归档",
    "docs/.ccb/docs-structure-contract.yaml",
    "docs/.ccb/schemas/docs-structure-contract.schema.yaml",
    "docs/.ccb/index",
    "docs/.ccb/events/journal.jsonl",
    "docs/.ccb/locks",
    "docs/.ccb/drafts/breakdown"
  ];

  const missing = [];
  for (const path of requiredPaths) {
    try {
      await stat(join(projectRoot, path));
    } catch {
      missing.push(path);
    }
  }
  return {
    ok: missing.length === 0,
    missing
  };
}
