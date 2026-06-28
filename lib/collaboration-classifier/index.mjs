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
  const indexMatch = sql.match(/\bon\s+([`"'\[]?[A-Za-z0-9_.-]+[`"'\]]?)\s*\(/i);
  if (indexMatch) return sqlIdentifier(indexMatch[1]);
  return "unknown";
}

function normalizeSqlLine(line) {
  return line.replace(/^[+-]\s*/, "").trim().replace(/\s+/g, " ");
}

function stripSqlLinePrefix(line) {
  return line.replace(/^[+-]\s?/, "");
}

function fileLooksSql(path) {
  return /\.sql$/i.test(path) || /(^|\/)(sql|db|database|migration|migrations)(\/|$)/i.test(path);
}

function fileLooksMyBatis(path) {
  return /Mapper\.xml$|(^|\/)mapper\/.*\.xml$/i.test(path);
}

function addedLines(file) {
  return file.changedLines.filter((line) => line.startsWith("+")).map(stripSqlLinePrefix);
}

function changedPayloadLines(file) {
  return file.changedLines.map(stripSqlLinePrefix);
}

function splitSqlStatements(content) {
  const statements = [];
  let current = "";
  let quote = null;
  let blockComment = false;
  let lineComment = false;
  let depth = 0;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    const next = content[index + 1];
    current += char;

    if (lineComment) {
      if (char === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        current += next;
        index += 1;
        blockComment = false;
      }
      continue;
    }
    if (quote) {
      if (char === quote && next === quote && quote === "'") {
        current += next;
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }

    if (char === "-" && next === "-") {
      current += next;
      index += 1;
      lineComment = true;
      continue;
    }
    if (char === "/" && next === "*") {
      current += next;
      index += 1;
      blockComment = true;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") depth += 1;
    if (char === ")" && depth > 0) depth -= 1;
    if (char === ";" && depth === 0) {
      const statement = current.trim();
      if (statement) statements.push(statement);
      current = "";
    }
  }

  const trailing = current.trim();
  if (trailing) statements.push(trailing);
  return statements;
}

function stripSqlComments(sql) {
  let result = "";
  let quote = null;
  let blockComment = false;
  let lineComment = false;

  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];

    if (lineComment) {
      if (char === "\n") {
        lineComment = false;
        result += " ";
      }
      continue;
    }
    if (blockComment) {
      if (char === "*" && next === "/") {
        index += 1;
        blockComment = false;
        result += " ";
      }
      continue;
    }
    if (quote) {
      result += char;
      if (char === quote && next === quote && quote === "'") {
        result += next;
        index += 1;
        continue;
      }
      if (char === quote) quote = null;
      continue;
    }
    if (char === "-" && next === "-") {
      index += 1;
      lineComment = true;
      continue;
    }
    if (char === "/" && next === "*") {
      index += 1;
      blockComment = true;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") quote = char;
    result += char;
  }
  return result;
}

function tokenizeSql(sql) {
  const text = stripSqlComments(sql);
  const tokens = [];
  let index = 0;

  while (index < text.length) {
    const char = text[index];
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      const quote = char;
      let value = "";
      index += 1;
      while (index < text.length) {
        const current = text[index];
        const next = text[index + 1];
        if (current === quote && next === quote && quote === "'") {
          value += current + next;
          index += 2;
          continue;
        }
        if (current === quote) {
          index += 1;
          break;
        }
        value += current;
        index += 1;
      }
      tokens.push({ type: quote === "'" ? "string" : "word", value, upper: value.toUpperCase() });
      continue;
    }
    if (char === "[") {
      let value = "";
      index += 1;
      while (index < text.length && text[index] !== "]") {
        value += text[index];
        index += 1;
      }
      if (text[index] === "]") index += 1;
      tokens.push({ type: "word", value, upper: value.toUpperCase() });
      continue;
    }
    if (/[A-Za-z0-9_@$#]/.test(char)) {
      let value = "";
      while (index < text.length && /[A-Za-z0-9_@$#]/.test(text[index])) {
        value += text[index];
        index += 1;
      }
      tokens.push({ type: "word", value, upper: value.toUpperCase() });
      continue;
    }
    tokens.push({ type: "symbol", value: char, upper: char });
    index += 1;
  }
  return tokens;
}

function tokenIs(token, value) {
  return token?.upper === value;
}

function tokenValue(token) {
  return token?.value ?? "unknown";
}

function readQualifiedIdentifier(tokens, startIndex) {
  const parts = [];
  let index = startIndex;
  while (index < tokens.length) {
    if (tokens[index]?.type !== "word") break;
    parts.push(tokens[index].value);
    index += 1;
    if (tokens[index]?.value !== ".") break;
    index += 1;
  }
  return { value: parts.join(".") || "unknown", nextIndex: index };
}

function containsToken(tokens, value, startIndex = 0) {
  return tokens.slice(startIndex).some((token) => tokenIs(token, value));
}

function fullEscalationReason(rawSql, tokens) {
  const normalized = rawSql.toLowerCase();
  if (/\b(backfill|large[_ -]?table|big[_ -]?table|online[_ -]?migration|pt-online-schema-change|gh-ost)\b/i.test(rawSql)) {
    return "migration hint indicates large-table/online/backfill risk";
  }
  if (/回填|大表|百万|千万|亿级|无回滚|无\s*rollback|no\s+rollback|rollback\s*:\s*none/i.test(rawSql)) {
    return "migration comment indicates backfill/large-table/no-rollback risk";
  }
  if (/默认值.*语义|default.*semantic/.test(normalized)) {
    return "migration comment indicates default value semantic change";
  }
  if (containsToken(tokens, "ALGORITHM") || containsToken(tokens, "LOCK") || containsToken(tokens, "ONLINE")) {
    return "DDL includes online/lock/algorithm migration controls";
  }
  return null;
}

function parseAlterTableStatement(rawSql, tokens) {
  const tableIndex = tokens.findIndex((token) => tokenIs(token, "TABLE"));
  if (tableIndex < 0) return null;
  let cursor = tableIndex + 1;
  if (tokenIs(tokens[cursor], "IF") && tokenIs(tokens[cursor + 1], "EXISTS")) cursor += 2;
  const table = readQualifiedIdentifier(tokens, cursor);
  cursor = table.nextIndex;
  const op = tokens[cursor];
  const rest = tokens.slice(cursor + 1);

  if (["DROP", "MODIFY", "CHANGE", "RENAME"].some((keyword) => tokenIs(op, keyword))) {
    return { kind: "alter_breaking", table: table.value, floor: "full", change: "breaking", source: "l1.sql.alter_breaking" };
  }

  if (tokenIs(op, "ALTER") && containsToken(rest, "DEFAULT")) {
    return { kind: "alter_default", table: table.value, floor: "full", change: "breaking", source: "l2.sql.default_semantics" };
  }

  if (!tokenIs(op, "ADD")) return null;

  if (
    tokenIs(rest[0], "CONSTRAINT") ||
    ["UNIQUE", "PRIMARY", "FOREIGN", "CHECK", "KEY", "INDEX"].some((keyword) => containsToken(rest, keyword))
  ) {
    const unique = containsToken(rest, "UNIQUE");
    return {
      kind: unique ? "alter_add_unique_or_constraint" : "alter_add_constraint",
      table: table.value,
      floor: "standard",
      change: "constraint",
      source: unique ? "l2.sql.add_unique_index" : "l2.sql.add_constraint"
    };
  }

  let columnCursor = 0;
  if (tokenIs(rest[columnCursor], "COLUMN")) columnCursor += 1;
  const column = tokenValue(rest[columnCursor]);
  const hasNotNull = rest.some((token, index) => tokenIs(token, "NOT") && tokenIs(rest[index + 1], "NULL"));
  const hasExplicitNull = containsToken(rest, "NULL");
  const hasDefault = containsToken(rest, "DEFAULT");

  if (hasNotNull && hasDefault) {
    return {
      kind: "alter_add_not_null_default",
      table: table.value,
      column,
      floor: "standard",
      change: "schema_semantic",
      source: "l2.sql.add_not_null_default"
    };
  }
  if (hasNotNull && !hasDefault) {
    return {
      kind: "alter_add_not_null_without_default",
      table: table.value,
      column,
      floor: "full",
      change: "breaking",
      source: "l2.sql.add_not_null_without_default"
    };
  }
  if (hasDefault) {
    return {
      kind: "alter_add_default",
      table: table.value,
      column,
      floor: "standard",
      change: "schema_semantic",
      source: "l2.sql.add_default"
    };
  }
  if (hasExplicitNull) {
    return {
      kind: "alter_add_nullable",
      table: table.value,
      column,
      floor: "lite",
      change: "additive",
      source: "l1.sql.alter_add_nullable"
    };
  }
  return {
    kind: "alter_add_unknown_nullability",
    table: table.value,
    column,
    floor: "standard",
    change: "schema_semantic",
    source: "l2.sql.add_unknown_nullability"
  };
}

function parseSqlStatement(rawSql) {
  const tokens = tokenizeSql(rawSql);
  if (tokens.length === 0) return null;
  const escalation = fullEscalationReason(rawSql, tokens);
  const first = tokens[0];
  const second = tokens[1];

  if (tokenIs(first, "CREATE") && tokenIs(second, "TABLE")) {
    const table = readQualifiedIdentifier(tokens, 2);
    return {
      kind: "create_table",
      table: table.value,
      floor: escalation ? "full" : "lite",
      change: escalation ? "schema_semantic" : "additive",
      source: escalation ? "l2.sql.full_escalation" : "l1.sql.create_table",
      escalation
    };
  }

  if (tokenIs(first, "CREATE") && tokenIs(second, "UNIQUE") && containsToken(tokens, "INDEX")) {
    return {
      kind: "create_unique_index",
      table: extractTableName(rawSql),
      floor: escalation ? "full" : "standard",
      change: escalation ? "schema_semantic" : "constraint",
      source: escalation ? "l2.sql.full_escalation" : "l2.sql.create_unique_index",
      escalation
    };
  }

  if (tokenIs(first, "ALTER") && tokenIs(second, "TABLE")) {
    const parsed = parseAlterTableStatement(rawSql, tokens);
    if (!parsed) return null;
    return escalation ? { ...parsed, floor: "full", change: "schema_semantic", source: "l2.sql.full_escalation", escalation } : parsed;
  }

  if (["UPDATE", "DELETE"].some((keyword) => tokenIs(first, keyword))) {
    return { kind: "data_backfill", table: tokenValue(tokens[1]), floor: "full", change: "data_migration", source: "l2.sql.backfill" };
  }
  if (tokenIs(first, "INSERT") && containsToken(tokens, "SELECT")) {
    const intoIndex = tokens.findIndex((token) => tokenIs(token, "INTO"));
    const table = intoIndex >= 0 ? readQualifiedIdentifier(tokens, intoIndex + 1).value : "unknown";
    return { kind: "data_backfill", table, floor: "full", change: "data_migration", source: "l2.sql.backfill" };
  }
  return null;
}

function classifySqlStatements(file, touchedSurfaces, partialReasons) {
  const statements = splitSqlStatements(addedLines(file).join("\n"));
  for (const statement of statements) {
    const parsed = parseSqlStatement(statement);
    if (!parsed) continue;
    touchedSurfaces.push(
      surface({
        type: "table",
        id: parsed.table ?? extractTableName(statement),
        path: file.path,
        change: parsed.change,
        floor: parsed.floor,
        source: parsed.source,
        evidence: [normalizeSqlLine(statement), ...(parsed.escalation ? [parsed.escalation] : [])]
      })
    );
  }

  if (statements.length === 0 && fileLooksSql(file.path) && file.changedLines.length > 0) {
    partialReasons.push(partialReason("sql_parse_failed", file.path, "SQL file changed but no parseable statement was found"));
  }
}

function parseXmlStartTags(line) {
  const tags = [];
  let index = 0;
  while (index < line.length) {
    const start = line.indexOf("<", index);
    if (start < 0) break;
    if (line[start + 1] === "/" || line[start + 1] === "!" || line[start + 1] === "?") {
      index = start + 1;
      continue;
    }
    let cursor = start + 1;
    let name = "";
    while (cursor < line.length && /[A-Za-z0-9_.:-]/.test(line[cursor])) {
      name += line[cursor];
      cursor += 1;
    }
    if (name) tags.push(name.split(":").at(-1).toLowerCase());
    index = cursor;
  }
  return tags;
}

function classifyMyBatisXml(file, touchedSurfaces) {
  const tags = new Set(changedPayloadLines(file).flatMap(parseXmlStartTags));
  const path = file.path;
  const addSurface = (change, source, evidence) => {
    touchedSurfaces.push(surface({ type: "table", id: `mybatis:${path}`, path, change, floor: "standard", source, evidence }));
  };

  const dynamicTags = ["if", "choose", "when", "otherwise", "foreach", "trim", "where", "set", "bind"];
  if (dynamicTags.some((tag) => tags.has(tag))) {
    addSurface("mapper_dynamic_sql", "l2.mybatis.dynamic_sql", `dynamic tags: ${dynamicTags.filter((tag) => tags.has(tag)).join(", ")}`);
  }

  const resultMapTags = ["resultmap", "result", "id", "association", "collection", "constructor", "discriminator"];
  if (resultMapTags.some((tag) => tags.has(tag))) {
    addSurface("mapper_result_map", "l2.mybatis.result_map", `resultMap tags: ${resultMapTags.filter((tag) => tags.has(tag)).join(", ")}`);
  }

  const writeTags = ["insert", "update", "delete"];
  if (writeTags.some((tag) => tags.has(tag))) {
    addSurface("mapper_write_statement", "l2.mybatis.write_statement", `write tags: ${writeTags.filter((tag) => tags.has(tag)).join(", ")}`);
  }

  if (tags.has("select")) {
    addSurface("mapper_select_statement", "l2.mybatis.select_statement", "select statement changed");
  }

  if (!["if", "choose", "when", "otherwise", "foreach", "trim", "where", "set", "bind", "resultmap", "result", "id", "association", "collection", "constructor", "discriminator", "insert", "update", "delete", "select"].some((tag) => tags.has(tag))) {
    addSurface("mapper_xml_changed", "l2.mybatis.mapper_xml_changed", "mapper XML changed without a more specific L2 tag");
  }
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

  if (fileLooksSql(path)) {
    classifySqlStatements(file, touchedSurfaces, partialReasons);
  } else {
    for (const line of file.changedLines.filter((item) => item.startsWith("+") || item.startsWith("-"))) {
      classifySqlLine(line, path, touchedSurfaces, partialReasons);
    }
  }

  if (fileLooksMyBatis(path)) {
    classifyMyBatisXml(file, touchedSurfaces);
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
