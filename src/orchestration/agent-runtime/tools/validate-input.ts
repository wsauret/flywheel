/**
 * Central structural validation of model-authored tool inputs against the
 * tool's declared JSON Schema. Runs in the dispatcher (`tool-dispatch.ts`)
 * after shared conversion and tool-owned repair, before `execute`, so a malformed call becomes a
 * model-visible correction (an error tool_result on the original call id)
 * instead of a confusing downstream failure. Validation messages distinguish
 * missing, unexpected, and type-mismatched inputs consistently.
 *
 * Scope is deliberately structural: unions, constants, required fields, types,
 * enum membership, and unknown keys, recursing through nested objects and
 * array items. `maxItems` is enforced before item traversal because an array
 * bound is also a work bound. Other size/range constraints stay with tools,
 * which normalize rather than reject. Schemas are treated
 * as closed worlds: unknown keys are errors unless the schema node opts out with
 * `additionalProperties: true` or a schema for map values.
 */

import type { RuntimeToolInput } from "./types.js";

export interface SchemaProperties {
  [name: string]: SchemaNode;
}
export interface SchemaNode {
  type?: string;
  types?: readonly string[];
  branches?: readonly SchemaNode[];
  enum?: readonly unknown[];
  items?: SchemaNode;
  maxItems?: number;
  properties?: SchemaProperties;
  required?: readonly string[];
  additionalProperties?: boolean | SchemaNode;
}

/**
 * Narrow an untyped JSON-Schema object (`tool.inputSchema` is
 * `RuntimeToolInput`) into the `SchemaNode` view this validator reads. Each field is
 * read through a `typeof`/`Array.isArray` guard so the boundary stays
 * cast-free: a malformed field is simply absent from the node, which the
 * validator treats as "no constraint of that kind declared".
 */
export function toSchemaNode(value: unknown): SchemaNode {
  if (!isPlainObject(value)) return {};
  const node: SchemaNode = {};
  if (typeof value.type === "string") node.type = value.type;
  if (Array.isArray(value.type)) node.types = value.type.filter((type): type is string => typeof type === "string");
  const branches = value.anyOf ?? value.oneOf;
  if (Array.isArray(branches)) node.branches = branches.map(toSchemaNode);
  if (Array.isArray(value.enum)) node.enum = value.enum;
  if (Object.hasOwn(value, "const")) node.enum = [value.const];
  if (value.items !== undefined) node.items = toSchemaNode(value.items);
  if (typeof value.maxItems === "number" && Number.isSafeInteger(value.maxItems) && value.maxItems >= 0) {
    node.maxItems = value.maxItems;
  }
  if (isPlainObject(value.properties)) {
    const properties: SchemaProperties = {};
    for (const [key, propSchema] of Object.entries(value.properties)) {
      Object.defineProperty(properties, key, { value: toSchemaNode(propSchema), enumerable: true });
    }
    node.properties = properties;
  }
  if (Array.isArray(value.required)) {
    node.required = value.required.filter((entry): entry is string => typeof entry === "string");
  }
  if (typeof value.additionalProperties === "boolean") node.additionalProperties = value.additionalProperties;
  if (isPlainObject(value.additionalProperties)) node.additionalProperties = toSchemaNode(value.additionalProperties);
  return node;
}

/** Validate `input` against the tool's JSON Schema. Returns one
 *  model-readable problem string per issue; empty means valid. */
export function validateToolInput(
  input: RuntimeToolInput,
  schema: RuntimeToolInput,
): string[] {
  return schemaProblems(input, toSchemaNode(schema));
}

/** The converter uses the same structural judgment when selecting a repair. */
export function schemaProblems(value: unknown, schema: SchemaNode, path = ""): string[] {
  const problems: string[] = [];
  validateValue(value, schema, path, problems);
  return problems;
}

/** Selects a union member only when all object members share a unique fixed tag. */
export function discriminatedBranch(value: unknown, branches: readonly SchemaNode[]): SchemaNode | undefined {
  if (!isPlainObject(value)) return undefined;
  for (const key of Object.keys(branches[0]?.properties ?? {})) {
    const tags = branches.map((branch) => branch.type === "object" ? branch.properties?.[key]?.enum : undefined);
    if (!tags.every((tag) => tag?.length === 1)) continue;
    const values = tags.map((tag) => tag?.[0]);
    if (new Set(values).size !== branches.length) continue;
    const index = values.indexOf(value[key]);
    if (Object.hasOwn(value, key) && index !== -1) return branches[index];
  }
  return undefined;
}
/** Wrap validation problems in the model-facing correction message. */
export function formatToolInputProblems(toolName: string, problems: readonly string[]): string {
  return (
    `${toolName} failed due to the following ${problems.length > 1 ? "issues" : "issue"}:\n` +
    `${problems.join("\n")}\n` +
    `The tool was not executed. Fix the parameters and call ${toolName} again.`
  );
}

function validateObject(
  value: RuntimeToolInput,
  schema: SchemaNode,
  path: string,
  problems: string[],
): void {
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(value, key)) {
      problems.push(`The required parameter \`${joinPath(path, key)}\` is missing`);
    }
  }
  const declared = schema.properties ?? {};
  if ((schema.additionalProperties !== true && (schema.properties !== undefined || schema.additionalProperties === false)) || typeof schema.additionalProperties === "object") {
    const byNormalizedName = new Map(Object.keys(declared).map((name) => [normalizeName(name), name]));
    for (const key of Object.keys(value)) {
      if (Object.hasOwn(declared, key)) continue;
      if (typeof schema.additionalProperties === "object") {
        validateValue(value[key], schema.additionalProperties, joinPath(path, key), problems);
        continue;
      }
      const suggestion = byNormalizedName.get(normalizeName(key));
      problems.push(
        `An unexpected parameter \`${joinPath(path, key)}\` was provided${suggestion ? ` (did you mean \`${suggestion}\`?)` : ""}`,
      );
    }
  }
  for (const [key, propSchema] of Object.entries(declared)) {
    if (Object.hasOwn(value, key)) validateValue(value[key], propSchema, joinPath(path, key), problems);
  }
}

function validateValue(value: unknown, schema: SchemaNode, path: string, problems: string[]): void {
  const branches = schema.branches ?? schema.types?.map((type) => ({ ...schema, types: undefined, type }));
  if (branches) {
    const selected = discriminatedBranch(value, branches);
    const results = selected ? [schemaProblems(value, selected, path)] : branches.map((branch) => schemaProblems(value, branch, path));
    if (!results.some((result) => result.length === 0)) {
      problems.push(...(selected ? results[0] ?? [] : [`The parameter \`${path}\` does not match any allowed schema: ${results.map((result) => result.join("; ")).join(" or ")}`]));
      return;
    }
    // Type-array branches carry the node's other constraints themselves.
    if (schema.types) return;
  }
  if (schema.enum && !schema.enum.some((member) => Bun.deepEquals(member, value))) {
    const allowed = schema.enum.map((entry) => JSON.stringify(entry)).join(", ");
    problems.push(`The parameter \`${path}\` is expected as one of ${allowed} but provided as ${preview(value)}`);
    return;
  }
  switch (schema.type) {
    case "null":
      if (value !== null) reportTypeMismatch(path, "null", value, problems);
      return;
    case "string":
    case "number":
    case "boolean":
      if (typeof value !== schema.type) reportTypeMismatch(path, schema.type, value, problems);
      return;
    case "integer":
      if (typeof value !== "number" || !Number.isInteger(value)) reportTypeMismatch(path, "integer", value, problems);
      return;
    case "array":
      if (!Array.isArray(value)) {
        reportTypeMismatch(path, "array", value, problems);
        return;
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        problems.push(`The parameter \`${path}\` has ${value.length} items but allows at most ${schema.maxItems}`);
        return;
      }
      if (schema.items) {
        for (const [index, item] of value.entries()) {
          validateValue(item, schema.items, `${path}[${index}]`, problems);
        }
      }
      return;
    case "object": {
      if (!isPlainObject(value)) {
        reportTypeMismatch(path, "object", value, problems);
        return;
      }
      validateObject(value, schema, path, problems);
      return;
    }
    default:
      if (isPlainObject(value)) validateObject(value, schema, path, problems);
      return;
  }
}

function reportTypeMismatch(path: string, expected: string, value: unknown, problems: string[]): void {
  problems.push(
    `The parameter \`${path}\` type is expected as \`${expected}\` but provided as \`${receivedType(value)}\``,
  );
}

function receivedType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isPlainObject(value: unknown): value is RuntimeToolInput {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const PREVIEW_MAX = 60;

function preview(value: unknown): string {
  const bounded = typeof value === "string" ? value.slice(0, PREVIEW_MAX) : value;
  const text = JSON.stringify(bounded) ?? String(bounded);
  return text.length > PREVIEW_MAX ? `${text.slice(0, PREVIEW_MAX)}…` : text;
}

/** Case/underscore-insensitive normalization lets near-miss suggestions handle
 *  stylistic spelling differences. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[_-]/g, "");
}

function joinPath(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}
