#!/usr/bin/env node
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_DIR = join(ROOT, "references/kernel/schemas");
// console 输出默认关闭：plugin 只生成自身 mjs 产物，不写 console（保持仓独立）。
// 下游 su-oriel 刷新自身 .ts 产物时显式传 --console-out-dir <dir>。
const consoleOutArgIndex = process.argv.indexOf("--console-out-dir");
const CONSOLE_OUT_DIR = consoleOutArgIndex !== -1 ? resolve(process.argv[consoleOutArgIndex + 1]) : null;

const PLUGIN_TARGETS = new Map([
  ["breakdown-draft", "lib/breakdown-draft/generated-validator.mjs"],
  ["dev-task", "lib/subtask/generated-validator.mjs"],
  ["anchor-dispatch", "lib/anchor-dispatch/generated-validator.mjs"],
  ["plugin-hook-envelope", "lib/plugin-hook-envelope/generated-validator.mjs"],
  ["requirement-md-frontmatter", "lib/requirement-md-frontmatter/generated-validator.mjs"]
]);

function scalar(value) {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed.replace(/^['"]|['"]$/g, "");
}

function arrayScalar(value) {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null;
  const body = trimmed.slice(1, -1).trim();
  if (!body) return [];
  return body.split(",").map((item) => scalar(item));
}

function lineIndent(line) {
  return line.match(/^(\s*)/)?.[1].length ?? 0;
}

function readNestedList(lines, startIndex, baseIndent) {
  const list = [];
  let index = startIndex;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && lineIndent(line) <= baseIndent) break;
    const match = line.match(/^\s*-\s*(.+?)\s*$/);
    if (!match) continue;
    list.push(arrayScalar(match[1]) ?? scalar(match[1]));
  }
  return { value: list, nextIndex: index };
}

function readTopLevel(lines, key) {
  const pattern = new RegExp(`^${key}:\\s*(.+?)\\s*$`);
  for (const line of lines) {
    const match = line.match(pattern);
    if (match) return scalar(match[1]);
  }
  return null;
}

function readListAfter(lines, key) {
  const list = [];
  const start = lines.findIndex((line) => line.match(new RegExp(`^\\s*${key}:\\s*$`)));
  if (start < 0) return list;
  const baseIndent = lines[start].match(/^(\s*)/)?.[1].length ?? 0;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const indent = line.match(/^(\s*)/)?.[1].length ?? 0;
    if (line.trim() && indent <= baseIndent) break;
    const match = line.match(/^\s*-\s*(.+?)\s*$/);
    if (match) list.push(scalar(match[1]));
  }
  return list;
}

function parseFields(lines) {
  const fields = new Map();
  const start = lines.findIndex((line) => line === "fields:");
  if (start < 0) return fields;
  let current = null;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && !line.startsWith(" ")) break;
    const fieldMatch = line.match(/^  ([A-Za-z0-9_.]+):\s*$/);
    if (fieldMatch) {
      current = {};
      fields.set(fieldMatch[1], current);
      continue;
    }
    if (!current) continue;
    const propertyMatch = line.match(/^    ([A-Za-z0-9_]+):\s*(.*?)\s*$/);
    if (!propertyMatch) continue;
    const [, key, raw] = propertyMatch;
    if (raw === "") {
      const nested = readNestedList(lines, index + 1, lineIndent(line));
      current[key] = nested.value;
      index = nested.nextIndex - 1;
      continue;
    }
    current[key] = arrayScalar(raw) ?? scalar(raw);
  }
  return fields;
}

function parseSchema(content) {
  const lines = content.split(/\r?\n/);
  const schemaName = readTopLevel(lines, "schema_name");
  if (!schemaName || typeof schemaName !== "string") throw new Error("schema_name missing");
  const required =
    readListAfter(lines, "required_frontmatter").length > 0
      ? readListAfter(lines, "required_frontmatter")
      : readListAfter(lines, "required").length > 0
        ? readListAfter(lines, "required")
        : readListAfter(lines, "required_fields");
  const fields = [...parseFields(lines)].map(([name, rule]) => ({ name, ...rule }));
  const rootType = lines.some((line) => line.includes("markdown_with_frontmatter"))
    ? "markdown_with_frontmatter"
    : readTopLevel(lines, "kind") === "markdown_frontmatter"
      ? "markdown_frontmatter"
      : "object";
  const bodyTypeMatch = content.match(/\nbody:\n\s+type:\s*([A-Za-z0-9_]+)/);
  const bodyRequiredMatch = content.match(/\nbody:\n(?:.*\n)*?\s+required:\s*(false|true)/);
  return {
    schemaName,
    functionName: `validate${schemaName
      .split(/[-_]/)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join("")}`,
    rootType,
    required,
    fields,
    body: bodyTypeMatch
      ? {
          type: bodyTypeMatch[1],
          required: bodyRequiredMatch ? bodyRequiredMatch[1] !== "false" : true
        }
      : null
  };
}

function renderCore(schema, moduleKind) {
  const ts = moduleKind === "ts";
  const exportPrefix = "export ";
  const rootTypeDeclaration = ts ? `const ROOT_TYPE: string = ${JSON.stringify(schema.rootType)};` : `const ROOT_TYPE = ${JSON.stringify(schema.rootType)};`;
  const requiredFieldsDeclaration = ts
    ? `const REQUIRED_FIELDS: string[] = ${JSON.stringify(schema.required, null, 2)};`
    : `const REQUIRED_FIELDS = ${JSON.stringify(schema.required, null, 2)};`;
  const fieldRulesDeclaration = ts
    ? `const FIELD_RULES: Array<Record<string, unknown>> = ${JSON.stringify(schema.fields, null, 2)};`
    : `const FIELD_RULES = ${JSON.stringify(schema.fields, null, 2)};`;
  const bodyRuleDeclaration = ts
    ? `const BODY_RULE: null | { type?: string; required?: boolean; [key: string]: unknown } = ${JSON.stringify(schema.body, null, 2)};`
    : `const BODY_RULE = ${JSON.stringify(schema.body, null, 2)};`;
  return `${ts ? "export interface ValidationIssue { path: string; actual: unknown; expected: string; }\nexport interface ValidationResult { ok: boolean; issues: ValidationIssue[]; }\n\n" : ""}const SCHEMA_NAME = ${JSON.stringify(schema.schemaName)};
${rootTypeDeclaration}
${requiredFieldsDeclaration}
${fieldRulesDeclaration}
${bodyRuleDeclaration}

function isRecord(value${ts ? ": unknown" : ""})${ts ? ": value is Record<string, unknown>" : ""} {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isMissing(value${ts ? ": unknown" : ""})${ts ? ": boolean" : ""} {
  return value === undefined || value === null || value === "";
}

function issue(path${ts ? ": string" : ""}, actual${ts ? ": unknown" : ""}, expected${ts ? ": string" : ""})${ts ? ": ValidationIssue" : ""} {
  return { path, actual, expected };
}

function stringArray(value${ts ? ": unknown" : ""})${ts ? ": string[]" : ""} {
  return Array.isArray(value) ? value.map(String) : [];
}

function stringGroups(value${ts ? ": unknown" : ""})${ts ? ": string[][]" : ""} {
  return Array.isArray(value) ? value.filter(Array.isArray).map((group) => group.map(String)) : [];
}

function getPathValue(record${ts ? ": Record<string, unknown>" : ""}, path${ts ? ": string" : ""})${ts ? ": unknown" : ""} {
  let current${ts ? ": unknown" : ""} = record;
  for (const part of path.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[part];
  }
  return current;
}

function conditionMatches(expression${ts ? ": unknown" : ""}, record${ts ? ": Record<string, unknown>" : ""})${ts ? ": boolean" : ""} {
  if (typeof expression !== "string") return false;
  return expression.split(/\\s+\\|\\|\\s+/).some((rawClause) => {
    const clause = rawClause.trim();
    const existsMatch = clause.match(/^([A-Za-z0-9_.]+)\\s+exists$/);
    if (existsMatch) return getPathValue(record, existsMatch[1]) !== undefined;
    const equalsMatch = clause.match(/^([A-Za-z0-9_.]+)\\s*==\\s*([A-Za-z0-9_.-]+)$/);
    if (equalsMatch) return String(getPathValue(record, equalsMatch[1])) === equalsMatch[2];
    return false;
  });
}

function utf8ByteLength(value${ts ? ": unknown" : ""})${ts ? ": number" : ""} {
  const text = JSON.stringify(value);
  let bytes = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint <= 0x7f) bytes += 1;
    else if (codePoint <= 0x7ff) bytes += 2;
    else if (codePoint <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

function valueDepth(value${ts ? ": unknown" : ""})${ts ? ": number" : ""} {
  if (!value || typeof value !== "object") return 0;
  const children = Array.isArray(value) ? value : Object.values(value);
  if (children.length === 0) return 1;
  return 1 + Math.max(...children.map((child) => valueDepth(child)));
}

function hasBase64BusinessField(value${ts ? ": unknown" : ""})${ts ? ": boolean" : ""} {
  if (Array.isArray(value)) return value.some((item) => hasBase64BusinessField(item));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, nested]) => key.endsWith("_b64") || hasBase64BusinessField(nested));
}

function validateDocTypeValue(value${ts ? ": unknown" : ""}, path${ts ? ": string" : ""}, issues${ts ? ": ValidationIssue[]" : ""})${ts ? ": void" : ""} {
  const pattern = /^[a-z][a-z0-9_]*$/;
  if (typeof value === "string") {
    if (!pattern.test(value)) issues.push(issue(path, value, "snake_case doc_type"));
    return;
  }
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      if (typeof item !== "string" || !pattern.test(item)) {
        issues.push(issue(\`\${path}[\${index}]\`, item, "snake_case doc_type"));
      }
    }
  }
}

function isStrictIso8601(value${ts ? ": unknown" : ""})${ts ? ": boolean" : ""} {
  // Generated validators enforce the canonical writer form. Runtime validation
  // may remain wider for legacy docs that predate the generated contract.
  if (typeof value !== "string") return false;
  if (!/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$/.test(value)) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function hasUsefulMarkdown(value${ts ? ": unknown" : ""})${ts ? ": boolean" : ""} {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return trimmed.length >= 50 && /(^|\\n)\\s*(#{1,6}\\s+|[-*]\\s+)/.test(trimmed);
}

function validateField(rule${ts ? ": Record<string, unknown>" : ""}, value${ts ? ": unknown" : ""}, issues${ts ? ": ValidationIssue[]" : ""})${ts ? ": void" : ""} {
  const path = String(rule.name);
  const type = String(rule.type ?? "");
  if (value === undefined || value === null) return;
  if (type === "literal") {
    if (value !== rule.value) issues.push(issue(path, value, String(rule.value)));
    return;
  }
  if (type === "enum") {
    const values = Array.isArray(rule.values) ? rule.values : [];
    if (!values.includes(value)) issues.push(issue(path, value, values.join(" | ")));
    return;
  }
  if (type === "regex") {
    if (typeof value !== "string" || !new RegExp(String(rule.pattern)).test(value)) {
      issues.push(issue(path, value, String(rule.pattern)));
    }
    return;
  }
  if (type === "non_empty_string") {
    if (typeof value !== "string" || value.trim().length === 0) issues.push(issue(path, value, "non-empty string"));
    return;
  }
  if (type === "string") {
    if (typeof value !== "string") issues.push(issue(path, value, "string"));
    return;
  }
  if (type === "iso8601_datetime") {
    if (!isStrictIso8601(value)) issues.push(issue(path, value, "strict ISO8601 datetime"));
    return;
  }
  if (type === "sha256_hex") {
    if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) issues.push(issue(path, value, "sha256 hex"));
    return;
  }
  if (type === "positive_integer") {
    if (!Number.isInteger(value) || Number(value) < 1) issues.push(issue(path, value, "integer >= 1"));
    return;
  }
  if (type === "integer") {
    if (!Number.isInteger(value)) {
      issues.push(issue(path, value, "integer"));
      return;
    }
    if (typeof rule.minimum === "number" && Number(value) < rule.minimum) issues.push(issue(path, value, \`integer >= \${rule.minimum}\`));
    if (typeof rule.maximum === "number" && Number(value) > rule.maximum) issues.push(issue(path, value, \`integer <= \${rule.maximum}\`));
    return;
  }
  if (type === "non_negative_integer_or_null") {
    if (value !== null && (!Number.isInteger(value) || Number(value) < 0)) issues.push(issue(path, value, "integer >= 0 or null"));
    return;
  }
  if (type === "positive_number_or_null") {
    if (value !== null && (typeof value !== "number" || value <= 0)) issues.push(issue(path, value, "number > 0 or null"));
    return;
  }
  if (type === "object") {
    let objectValue = value;
    if (!isRecord(objectValue) && typeof objectValue === "string" && objectValue.trim().startsWith("{")) {
      try {
        objectValue = JSON.parse(objectValue);
      } catch {
        // Fall through to the object type error below.
      }
    }
    if (!isRecord(objectValue)) {
      issues.push(issue(path, value, "object"));
      return;
    }
    const maxBytes = typeof rule.max_bytes === "number" ? rule.max_bytes : null;
    if (maxBytes !== null && utf8ByteLength(objectValue) > maxBytes) {
      issues.push(issue(path, value, \`object <= \${maxBytes} bytes\`));
    }
    const maxDepth = typeof rule.max_depth === "number" ? rule.max_depth : null;
    if (maxDepth !== null && valueDepth(objectValue) > maxDepth) {
      issues.push(issue(path, value, \`object depth <= \${maxDepth}\`));
    }
    if ((maxBytes !== null || maxDepth !== null) && hasBase64BusinessField(objectValue)) {
      issues.push(issue(path, value, "must not contain *_b64 business fields"));
    }
    const allowedKeys = Array.isArray(rule.allowed_keys) ? rule.allowed_keys.map(String) : null;
    if (allowedKeys) {
      const allowed = new Set(allowedKeys);
      for (const key of Object.keys(objectValue)) {
        if (!allowed.has(key)) issues.push(issue(\`\${path}.\${key}\`, objectValue[key], \`allowed key: \${allowedKeys.join(" | ")}\`));
      }
    }
    const requiredKeys = Array.isArray(rule.required_keys) ? rule.required_keys.map(String) : stringArray(rule.required);
    for (const key of requiredKeys) {
      if (isMissing(objectValue[key])) {
        issues.push(issue(\`\${path}.\${key}\`, objectValue[key], "required"));
      }
    }
    for (const key of stringArray(rule.each_value_required)) {
      for (const [nestedName, nestedValue] of Object.entries(objectValue)) {
        if (isRecord(nestedValue) && isMissing(nestedValue[key])) {
          issues.push(issue(\`\${path}.\${nestedName}.\${key}\`, nestedValue[key], "required"));
        }
      }
    }
    for (const key of stringArray(rule.each_group_required)) {
      for (const [nestedName, nestedValue] of Object.entries(objectValue)) {
        if (isRecord(nestedValue) && isMissing(nestedValue[key])) {
          issues.push(issue(\`\${path}.\${nestedName}.\${key}\`, nestedValue[key], "required"));
        }
      }
    }
    const nonEmptyStringKeys = Array.isArray(rule.non_empty_string_keys) ? rule.non_empty_string_keys.map(String) : [];
    for (const key of nonEmptyStringKeys) {
      if (objectValue[key] !== undefined && (typeof objectValue[key] !== "string" || objectValue[key].trim().length === 0)) {
        issues.push(issue(\`\${path}.\${key}\`, objectValue[key], "non-empty string"));
      }
    }
    return;
  }
  if (type === "array" || type === "non_empty_array" || type === "array_of_task_id") {
    if (!Array.isArray(value)) {
      issues.push(issue(path, value, "array"));
      return;
    }
    if (type === "non_empty_array" && value.length === 0) issues.push(issue(path, value, "non-empty array"));
    if (type === "array_of_task_id" && value.some((item) => typeof item !== "string")) {
      issues.push(issue(path, value, "array of task ids"));
    }
    const itemRequiredGroups = stringGroups(rule.item_required_any_of);
    const checkDocTypes = rule.doc_type_format === "snake_case";
    for (const [index, item] of value.entries()) {
      const itemPath = \`\${path}[\${index}]\`;
      if (itemRequiredGroups.length > 0) {
        if (!isRecord(item)) {
          issues.push(issue(itemPath, item, "object"));
          continue;
        }
        const hasAllowedGroup = itemRequiredGroups.some((group) => group.every((key) => !isMissing(item[key])));
        if (!hasAllowedGroup) {
          issues.push(issue(itemPath, item, \`one of required key sets: \${itemRequiredGroups.map((group) => group.join(" + ")).join(" | ")}\`));
        }
      }
      if (checkDocTypes && isRecord(item)) {
        validateDocTypeValue(item.doc_type, \`\${itemPath}.doc_type\`, issues);
        validateDocTypeValue(item.doc_types, \`\${itemPath}.doc_types\`, issues);
      }
    }
    return;
  }
  if (type === "absolute_path") {
    if (typeof value !== "string" || !value.startsWith("/")) issues.push(issue(path, value, "absolute path"));
    return;
  }
  if (type === "relative_path") {
    if (typeof value !== "string" || value.trim().length === 0 || value.startsWith("/")) issues.push(issue(path, value, "relative path"));
    return;
  }
  if (type === "boolean") {
    if (typeof value !== "boolean") issues.push(issue(path, value, "boolean"));
  }
}

function selectPayload(input${ts ? ": unknown" : ""})${ts ? ": { frontmatter: Record<string, unknown>; body: unknown }" : ""} {
  if (ROOT_TYPE === "markdown_with_frontmatter") {
    const record = isRecord(input) ? input : {};
    return {
      frontmatter: isRecord(record.frontmatter) ? record.frontmatter : {},
      body: record.body
    };
  }
  if (ROOT_TYPE === "markdown_frontmatter") {
    const record = isRecord(input) ? input : {};
    return {
      frontmatter: isRecord(record.frontmatter) ? record.frontmatter : record,
      body: record.body
    };
  }
  return {
    frontmatter: isRecord(input) ? input : {},
    body: undefined
  };
}

${exportPrefix}function ${schema.functionName}(input${ts ? ": unknown" : ""})${ts ? ": ValidationResult" : ""} {
  const { frontmatter, body } = selectPayload(input);
  const issues${ts ? ": ValidationIssue[]" : ""} = [];
  for (const field of REQUIRED_FIELDS) {
    if (frontmatter[field] === undefined || frontmatter[field] === null || frontmatter[field] === "") {
      issues.push(issue(field, frontmatter[field], "required"));
    }
  }
  for (const rule of FIELD_RULES) {
    const fieldName = String(rule.name);
    const value = getPathValue(frontmatter, fieldName);
    if (conditionMatches(rule.required_when, frontmatter) && isMissing(value)) {
      issues.push(issue(fieldName, value, \`required when \${rule.required_when}\`));
    }
    validateField(rule, value, issues);
  }
  if (BODY_RULE?.type === "markdown_min_50_chars_with_heading_or_list") {
    if (!hasUsefulMarkdown(body)) issues.push(issue("body", body, "markdown with >=50 chars and heading or list"));
  } else if (BODY_RULE?.required !== false && BODY_RULE?.type === "markdown" && typeof body !== "string") {
    issues.push(issue("body", body, "markdown string"));
  }
  return { ok: issues.length === 0, issues };
}
`;
}

async function writeGenerated(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
}

async function main() {
  const files = (await readdir(SCHEMA_DIR)).filter((file) => file.endsWith(".schema.yaml")).sort();
  for (const file of files) {
    const schema = parseSchema(await readFile(join(SCHEMA_DIR, file), "utf8"));
    const header = `// Generated by scripts/generate-schema-validators.mjs from ${file}.\n// Do not edit manually. YAML schemas are the ADR-0026 cross-runtime contract source.\n\n`;
    if (CONSOLE_OUT_DIR) {
      await writeGenerated(join(CONSOLE_OUT_DIR, `${schema.schemaName}-validator.ts`), `${header}${renderCore(schema, "ts")}`);
    }
    const pluginTarget =
      PLUGIN_TARGETS.get(schema.schemaName) ??
      `lib/${schema.schemaName}/generated-validator.mjs`;
    await writeGenerated(join(ROOT, pluginTarget), `${header}${renderCore(schema, "mjs")}`);
  }
  console.log(`generated ${files.length} schema validator pair(s)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
