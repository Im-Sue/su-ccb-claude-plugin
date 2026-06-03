import { chmod, copyFile, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_CONTRACT_PATH,
  DEFAULT_SCHEMA_PATH,
  loadDocsStructureResolver
} from "../docs-structure/index.mjs";

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const templatesRoot = join(pluginRoot, "templates");
const docsTemplatesRoot = join(templatesRoot, "docs");
const ARCHITECTURE_REASON = {
  ELIGIBLE: "eligible",
  NO_SOURCE: "no_source",
  MULTIPLE_SOURCE_ROOTS: "multiple_source_roots",
  ARCHITECTURE_EXISTS: "architecture_exists"
};
const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "vendor",
  ".venv",
  "target",
  ".next",
  "coverage",
  "tmp",
  ".tmp",
  "examples",
  "fixtures",
  "testdata",
  "docs",
  ".ccb",
  ".claude"
]);
const MARKER_FILES = new Set([
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "composer.json",
  "Gemfile"
]);
const SOURCE_EXTENSIONS = new Set([
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".jsx",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".rb",
  ".php",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".swift",
  ".scala",
  ".sh"
]);
const SOURCE_FILE_THRESHOLD = 3;
const MAX_SOURCE_SCAN_DEPTH = 3;

function normalizePath(value) {
  return value.replace(/\\/g, "/");
}

function rel(projectRoot, absolutePath) {
  return normalizePath(relative(projectRoot, absolutePath));
}

function candidateResult({ projectRoot, resolver, eligible, reason, sourceRoots = [], existingArchitectureDocs = [] }) {
  const architecture = resolver.resolveDocType("architecture");
  const projectSlug = basename(projectRoot)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "project";
  return {
    eligible,
    reason,
    targetPath: normalizePath(join(architecture.directory, `${projectSlug}-架构.md`)),
    sourceRoots,
    existingArchitectureDocs
  };
}

async function safeReadDir(path) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function isTemplateMarkdownFile(fileName) {
  return fileName.startsWith("_模板_");
}

async function collectExistingArchitectureDocs(projectRoot, architectureDirectory) {
  const root = join(projectRoot, architectureDirectory);
  const matches = [];

  async function visit(directory) {
    for (const entry of await safeReadDir(directory)) {
      const entryPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
        continue;
      }
      if (entry.isFile() && entry.name.toLowerCase().endsWith(".md") && !isTemplateMarkdownFile(entry.name)) {
        matches.push(rel(projectRoot, entryPath));
      }
    }
  }

  await visit(root);
  return matches.sort();
}

async function fileExists(path) {
  try {
    const value = await stat(path);
    return value.isFile();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function readTextIfExists(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function hasPackageWorkspaces(projectRoot) {
  const content = await readTextIfExists(join(projectRoot, "package.json"));
  if (!content) return false;
  try {
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" && Object.hasOwn(parsed, "workspaces");
  } catch {
    return false;
  }
}

async function hasCargoWorkspace(projectRoot) {
  const content = await readTextIfExists(join(projectRoot, "Cargo.toml"));
  return Boolean(content && /^\s*\[workspace\]\s*$/m.test(content));
}

async function hasMonorepoSignal(projectRoot) {
  const signalFiles = [
    ".gitmodules",
    "pnpm-workspace.yaml",
    "lerna.json",
    "nx.json",
    "turbo.json",
    "go.work"
  ];
  for (const fileName of signalFiles) {
    if (await fileExists(join(projectRoot, fileName))) return true;
  }
  return (await hasPackageWorkspaces(projectRoot)) || (await hasCargoWorkspace(projectRoot));
}

function isMarkerFile(fileName) {
  return MARKER_FILES.has(fileName) || fileName.endsWith(".csproj");
}

function isSourceFile(fileName) {
  return SOURCE_EXTENSIONS.has(extname(fileName));
}

async function scanSourceShape(projectRoot) {
  const markerDirs = new Set();
  let sourceFileCount = 0;

  async function visit(directory, depth) {
    const entries = await safeReadDir(directory);
    let hasMarker = false;

    for (const entry of entries) {
      if (entry.isFile()) {
        if (isMarkerFile(entry.name)) {
          hasMarker = true;
        }
        if (isSourceFile(entry.name)) {
          sourceFileCount += 1;
        }
      }
    }

    if (hasMarker) {
      markerDirs.add(rel(projectRoot, directory) || ".");
    }

    if (depth >= MAX_SOURCE_SCAN_DEPTH) {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() || IGNORE_DIRS.has(entry.name)) {
        continue;
      }
      await visit(join(directory, entry.name), depth + 1);
    }
  }

  await visit(projectRoot, 0);
  return {
    markerDirs: [...markerDirs].sort(),
    sourceFileCount
  };
}

export async function detectArchitectureCandidate(options = {}) {
  const projectRoot = options.projectRoot ?? process.cwd();
  const resolver = options.resolver ?? (await loadDocsStructureResolver(options));
  const architecture = resolver.resolveDocType("architecture");
  const existingArchitectureDocs = await collectExistingArchitectureDocs(projectRoot, architecture.directory);

  if (await hasMonorepoSignal(projectRoot)) {
    return candidateResult({
      projectRoot,
      resolver,
      eligible: false,
      reason: ARCHITECTURE_REASON.MULTIPLE_SOURCE_ROOTS,
      existingArchitectureDocs
    });
  }

  if (existingArchitectureDocs.length > 0) {
    return candidateResult({
      projectRoot,
      resolver,
      eligible: false,
      reason: ARCHITECTURE_REASON.ARCHITECTURE_EXISTS,
      existingArchitectureDocs
    });
  }

  const sourceShape = await scanSourceShape(projectRoot);
  if (sourceShape.markerDirs.length >= 2) {
    return candidateResult({
      projectRoot,
      resolver,
      eligible: false,
      reason: ARCHITECTURE_REASON.MULTIPLE_SOURCE_ROOTS,
      sourceRoots: sourceShape.markerDirs
    });
  }

  const hasSource = sourceShape.markerDirs.length >= 1 || sourceShape.sourceFileCount >= SOURCE_FILE_THRESHOLD;
  if (!hasSource) {
    return candidateResult({
      projectRoot,
      resolver,
      eligible: false,
      reason: ARCHITECTURE_REASON.NO_SOURCE
    });
  }

  return candidateResult({
    projectRoot,
    resolver,
    eligible: true,
    reason: ARCHITECTURE_REASON.ELIGIBLE,
    sourceRoots: sourceShape.markerDirs.length === 1 ? sourceShape.markerDirs : ["."]
  });
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
  summary.architectureCandidate = await detectArchitectureCandidate({ projectRoot, resolver });

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
