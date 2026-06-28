import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(moduleDir, "..", "..");

export const DEFAULT_SINK_MANIFEST_PATH = join(
  pluginRoot,
  "references",
  "kernel",
  "classifier",
  "sink-manifests",
  "yudao-default.json"
);

export const BASIC_CORPUS_PATH = join(pluginRoot, "references", "kernel", "classifier", "corpus", "basic-corpus.json");

const TIER_RANK = { lite: 0, standard: 1, full: 2 };
const RANK_TIER = ["lite", "standard", "full"];
const SINK_MANIFEST_KINDS = new Set(["service", "table", "api", "event", "topic"]);
const SINK_MANIFEST_ACTIONS = new Set(["read", "consumer", "implement", "write", "settle", "refund", "freeze", "unknown"]);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function stringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0);
}

function maxTier(...tiers) {
  const rank = tiers.reduce((current, tier) => Math.max(current, TIER_RANK[tier] ?? 0), 0);
  return RANK_TIER[rank];
}

function parseDiffFiles(diffText) {
  const files = [];
  let current = null;

  for (const line of String(diffText ?? "").split(/\r?\n/)) {
    const diffMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (diffMatch) {
      current = {
        oldPath: diffMatch[1],
        newPath: diffMatch[2],
        path: diffMatch[2],
        newFile: false,
        deletedFile: false,
        binary: false,
        changedLines: []
      };
      files.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("new file mode ")) {
      current.newFile = true;
      continue;
    }
    if (line.startsWith("deleted file mode ")) {
      current.deletedFile = true;
      continue;
    }
    if (line.startsWith("Binary files ")) {
      current.binary = true;
      continue;
    }
    if (line.startsWith("--- ")) {
      if (line === "--- /dev/null") current.newFile = true;
      continue;
    }
    if (line.startsWith("+++ ")) {
      if (line === "+++ /dev/null") current.deletedFile = true;
      else if (line.startsWith("+++ b/")) {
        current.newPath = line.slice("+++ b/".length);
        current.path = current.newPath;
      }
      continue;
    }
    if ((line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---")) {
      current.changedLines.push(line);
    }
  }

  return files;
}

function pathIsApiPackage(path) {
  return /(^|\/)[^/]*-api(\/|$)/.test(path);
}

function pathIsController(path) {
  return /(^|\/)controller(\/|$)/i.test(path) || /Controller\.java$/.test(path);
}

function sqlIdentifier(raw) {
  if (!raw) return "unknown";
  return raw.replace(/^[`"'[]|[`"'\]]$/g, "").replace(/;$/, "");
}

function extractTableName(sql) {
  const createMatch = sql.match(/\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?([`"'\[]?[A-Za-z0-9_.-]+[`"'\]]?)/i);
  if (createMatch) return sqlIdentifier(createMatch[1]);
  const alterMatch = sql.match(/\balter\s+table\s+([`"'\[]?[A-Za-z0-9_.-]+[`"'\]]?)/i);
  if (alterMatch) return sqlIdentifier(alterMatch[1]);
  return "unknown";
}

function normalizeSqlLine(line) {
  return line.replace(/^[+-]\s*/, "").trim().replace(/\s+/g, " ");
}

function isMethodSignatureLine(text) {
  return /^(?:public|protected|private)\s+(?:static\s+)?(?:final\s+)?(?:[\w$<>\[\],.?]+\s+)+([A-Za-z_$][\w$]*)\s*\([^;{}]*\)\s*(?:throws\s+[^{;]+)?[;{]?\s*$/.test(
    text.trim()
  );
}

function methodName(text) {
  return text.trim().match(/\s([A-Za-z_$][\w$]*)\s*\(/)?.[1] ?? "unknown";
}

function changedMethodSignatures(file) {
  if (file.newFile || file.deletedFile || !file.path.endsWith(".java")) return [];
  const removed = file.changedLines
    .filter((line) => line.startsWith("-"))
    .map((line) => line.slice(1).trim())
    .filter(isMethodSignatureLine);
  const added = file.changedLines
    .filter((line) => line.startsWith("+"))
    .map((line) => line.slice(1).trim())
    .filter(isMethodSignatureLine);

  const changes = [];
  for (const oldSignature of removed) {
    const name = methodName(oldSignature);
    const nextSignature = added.find((signature) => methodName(signature) === name && signature !== oldSignature);
    if (nextSignature) {
      changes.push({ name, oldSignature, newSignature: nextSignature });
    }
  }
  return changes;
}

function partialReason(surface, path, reason, floor = "standard") {
  return { surface, path, reason, floor };
}

function surface({ type, id, path, change, floor, source, evidence }) {
  return {
    type,
    id,
    path,
    change,
    floor,
    source,
    evidence: Array.isArray(evidence) ? evidence : [String(evidence)]
  };
}

function classifySqlLine(line, path, touchedSurfaces, partialReasons) {
  const sql = normalizeSqlLine(line);
  if (!sql) return;

  if (/\bcreate\s+table\b/i.test(sql)) {
    touchedSurfaces.push(
      surface({
        type: "table",
        id: extractTableName(sql),
        path,
        change: "additive",
        floor: "lite",
        source: "l1.sql.create_table",
        evidence: sql
      })
    );
    return;
  }

  if (!/\balter\s+table\b/i.test(sql)) return;

  const table = extractTableName(sql);
  if (/\b(drop|modify|rename|change)\b/i.test(sql)) {
    touchedSurfaces.push(
      surface({
        type: "table",
        id: table,
        path,
        change: "breaking",
        floor: "full",
        source: "l1.sql.alter_breaking",
        evidence: sql
      })
    );
    return;
  }

  if (/\badd(?:\s+column)?\b/i.test(sql)) {
    if (/\bnull\b/i.test(sql) && !/\bnot\s+null\b/i.test(sql) && !/\bdefault\b/i.test(sql)) {
      touchedSurfaces.push(
        surface({
          type: "table",
          id: table,
          path,
          change: "additive",
          floor: "lite",
          source: "l1.sql.alter_add_nullable",
          evidence: sql
        })
      );
      return;
    }
    partialReasons.push(partialReason("sql_alter_add_requires_ast", path, "ALTER ADD is not provably nullable-additive in L1"));
  }
}

function classifyFile(file, touchedSurfaces, partialReasons) {
  const path = file.path;
  if (file.binary) {
    partialReasons.push(partialReason("binary_diff", path, "Binary diff cannot be classified by L1"));
    return;
  }

  if (pathIsApiPackage(path)) {
    touchedSurfaces.push(
      surface({
        type: "api",
        id: path,
        path,
        change: "breaking",
        floor: "full",
        source: "l1.path.api_package",
        evidence: "path contains *-api segment"
      })
    );
  }

  if (file.newFile && pathIsController(path)) {
    touchedSurfaces.push(
      surface({
        type: "api",
        id: path,
        path,
        change: "additive",
        floor: "lite",
        source: "l1.path.new_controller",
        evidence: "new controller file"
      })
    );
  }

  for (const signature of changedMethodSignatures(file)) {
    touchedSurfaces.push(
      surface({
        type: "api",
        id: `${path}#${signature.name}`,
        path,
        change: "breaking",
        floor: "full",
        source: "l1.java.method_signature",
        evidence: [signature.oldSignature, signature.newSignature]
      })
    );
  }

  for (const line of file.changedLines.filter((item) => item.startsWith("+") || item.startsWith("-"))) {
    classifySqlLine(line, path, touchedSurfaces, partialReasons);
  }

  if (/Mapper\.xml$|(^|\/)mapper\/.*\.xml$/i.test(path)) {
    partialReasons.push(partialReason("mybatis_xml", path, "MyBatis XML requires L2 semantic analyzer"));
  }
  if (/\.(ya?ml|properties|json)$/i.test(path) && /(^|\/)(config|conf|application|bootstrap|settings|dict)/i.test(path)) {
    partialReasons.push(partialReason("sensitive_config", path, "Config diff may carry business semantics; L1 cannot prove lite"));
  }
  if (/\/(listener|listeners|event|events|schedule|scheduler|job|jobs)\//i.test(path)) {
    partialReasons.push(partialReason("event_listener_schedule", path, "Event/listener/schedule path requires L2 sink analysis"));
  }
}

function uniqueByKey(items, keyFn) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result;
}

export function classifyGitDiff(diffText) {
  const files = parseDiffFiles(diffText);
  const touchedSurfaces = [];
  const partialReasons = [];

  for (const file of files) {
    classifyFile(file, touchedSurfaces, partialReasons);
  }

  const uniqueSurfaces = uniqueByKey(touchedSurfaces, (item) => `${item.type}:${item.id}:${item.source}:${item.change}:${item.floor}`);
  const uniquePartial = uniqueByKey(partialReasons, (item) => `${item.surface}:${item.path}:${item.reason}:${item.floor}`);
  const surfaceFloor = uniqueSurfaces.reduce((tier, item) => maxTier(tier, item.floor), "lite");
  const coverageFloor = uniquePartial.reduce((tier, item) => maxTier(tier, item.floor), "lite");
  const minimumTier = maxTier(surfaceFloor, coverageFloor);

  return {
    classifier_coverage: uniquePartial.length > 0 ? "partial" : "full",
    coverage: {
      status: uniquePartial.length > 0 ? "partial" : "full",
      floor: coverageFloor,
      partial_reasons: uniquePartial,
      can_be_lite: uniquePartial.length === 0
    },
    touched_surfaces: uniqueSurfaces,
    minimum_tier: minimumTier,
    negative_evidence: [
      ...(uniqueSurfaces.some((item) => item.source === "l1.path.api_package") ? [] : ["no *-api path diff detected by L1"]),
      ...(uniqueSurfaces.some((item) => item.source === "l1.sql.alter_breaking") ? [] : ["no ALTER MODIFY/DROP/RENAME detected by L1"]),
      ...(uniqueSurfaces.some((item) => item.source === "l1.java.method_signature") ? [] : ["no existing Java method signature change detected by L1"])
    ],
    files_analyzed: files.map((file) => file.path)
  };
}

export function assertNotLiteWhenPartial(classification) {
  if (classification?.classifier_coverage === "partial" && TIER_RANK[classification.minimum_tier] < TIER_RANK.standard) {
    throw new Error("classifier_coverage=partial must floor minimum_tier to standard or higher");
  }
  return true;
}

export function validateSinkManifest(manifest) {
  const issues = [];
  if (!isObject(manifest)) {
    return { ok: false, issues: ["manifest must be an object"] };
  }
  if (manifest.schema_version !== "sink-manifest-v0.1") issues.push("schema_version must be sink-manifest-v0.1");
  if (!isNonEmptyString(manifest.project_family)) issues.push("project_family must be a non-empty string");
  if (!Array.isArray(manifest.sinks) || manifest.sinks.length === 0) {
    issues.push("sinks must be a non-empty array");
  } else {
    const ids = new Set();
    for (const [index, sink] of manifest.sinks.entries()) {
      const prefix = `sinks[${index}]`;
      if (!isObject(sink)) {
        issues.push(`${prefix} must be an object`);
        continue;
      }
      if (!isNonEmptyString(sink.sink_id)) issues.push(`${prefix}.sink_id must be a non-empty string`);
      if (ids.has(sink.sink_id)) issues.push(`${prefix}.sink_id duplicates ${sink.sink_id}`);
      ids.add(sink.sink_id);
      if (!isNonEmptyString(sink.domain)) issues.push(`${prefix}.domain must be a non-empty string`);
      if (!SINK_MANIFEST_ACTIONS.has(sink.default_action)) issues.push(`${prefix}.default_action is invalid`);
      for (const kind of SINK_MANIFEST_KINDS) {
        if (!stringArray(sink[kind])) issues.push(`${prefix}.${kind} must be a string array`);
      }
    }
  }
  return { ok: issues.length === 0, issues };
}

export async function loadSinkManifest(path = DEFAULT_SINK_MANIFEST_PATH) {
  const manifest = JSON.parse(await readFile(path, "utf8"));
  const validation = validateSinkManifest(manifest);
  if (!validation.ok) {
    throw new Error(`invalid sink_manifest: ${validation.issues.join("; ")}`);
  }
  return manifest;
}

export async function loadClassifierCorpus(path = BASIC_CORPUS_PATH) {
  const corpus = JSON.parse(await readFile(path, "utf8"));
  if (!isObject(corpus) || !Array.isArray(corpus.cases)) {
    throw new Error("classifier corpus must be an object with cases[]");
  }
  return {
    ...corpus,
    cases: corpus.cases.map((item) => ({
      ...item,
      diff: Array.isArray(item.diff_lines) ? item.diff_lines.join("\n") : String(item.diff ?? "")
    }))
  };
}
