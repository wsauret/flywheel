/**
 * Tool-argument coercion against the tool's declared JSON Schema.
 *
 * A call whose meaning is clear runs without a correction round trip.
 * A value that is valid for its schema is never changed, except that a
 * double-escaped non-ASCII escape in a string is decoded, because that is an
 * encoding error and not content. ASCII and control escapes, escaped
 * backslashes, lone surrogates, Windows paths, and raw-text tools stay as written.
 * Repairs never invent content or choose between possible meanings.
 * Unions keep valid members, select a tagged case, or accept exactly one
 * successful conversion. Objects, open maps, and lists convert recursively.
 * Every repair reports how the input was read. The dispatcher keeps repairs
 * only after tool-owned repair and final validation, and leads the result
 * with their notes. Safety, permission, policy, and containment remain unchanged.
 */

import { definitionText } from "../llm/tool-definition-text.js";
import type { ToolInputRepair } from "../llm/types.js";
import { discriminatedBranch, schemaProblems, toSchemaNode, type SchemaNode, type SchemaProperties } from "./validate-input.js";

interface UnknownFields {
  [key: string]: unknown;
}

// Generic envelope keys models wrongly nest the whole argument object under.
// Unwrapping only fires when such a key is the *sole* input key and the schema
// does not declare it, so a tool legitimately taking a `payload` arg is unaffected.
const WRAPPER_KEYS = new Set(["payload", "json", "content", "input", "args", "arguments", "parameters", "task_content"]);

// Keys that models write for exactly what a declared key means, by the
// declared key. Many models name the file `file_path`, and some models write
// `old_text` for an exact-text replacement. A synonym maps only when the
// schema declares the key, the input lacks it, and the schema does not
// declare the synonym itself.
const KEY_SYNONYMS: ReadonlyMap<string, readonly string[]> = new Map([
  ["path", ["file_path"]],
  ["old_string", ["old_text"]],
  ["new_string", ["new_text"]],
]);

// Enum values that models write for exactly what a declared value means: many
// models ask a search for `files_with_matches` when they want matching files.
const VALUE_SYNONYMS: ReadonlyMap<string, string> = new Map([
  ["files_with_matches", "matching_files"],
]);

// Top-level keys that carry no request for any Flywheel tool. `windowsHide` is
// a process-launch option that repository instructions name, so a model copies
// it into shell calls; every Flywheel launch already hides its console.
const IGNORED_KEYS = new Set(["windowsHide"]);

type InputRepairObserver = (repair: ToolInputRepair) => void;

const NO_REPAIR_OBSERVER: InputRepairObserver = () => {};

export interface CoercionOptions {
  /** The tool's string arguments are raw file text, such as a custom-grammar patch, so no escape in them decodes. */
  readonly verbatimText?: boolean;
}

/** One walk's observer and options. */
interface Coercion {
  readonly onRepair: InputRepairObserver;
  readonly verbatimText: boolean;
}

export function coerceToolInput(
  input: UnknownFields,
  schema: UnknownFields,
  onRepair: InputRepairObserver = NO_REPAIR_OBSERVER,
  options: CoercionOptions = {},
): UnknownFields {
  const schemaNode = toSchemaNode(schema);
  const coercion: Coercion = { onRepair, verbatimText: options.verbatimText === true };
  const unwrapped = schemaProblems(input, schemaNode).length === 0 ? input : unwrapSingleWrapper(input, schemaNode, coercion);
  const converted = coerceValue(unwrapped, schemaNode, "", coercion);
  return isPlainObject(converted) ? converted : input;
}

/** The one-line note that tells the model how the dispatcher read its argument. */
export function describeInputRepair(repair: ToolInputRepair): string {
  switch (repair.kind) {
    case "unwrapped":
      return `Note: the arguments inside \`${repair.path}\` were read as the arguments themselves.`;
    case "wrapped_in_array":
      return `Note: the single value of \`${repair.path}\` was read as a list with one item.`;
    case "unwrapped_array":
      return `Note: the one-item list in \`${repair.path}\` was read as its item.`;
    case "stringified_value":
      return `Note: the value of \`${repair.path}\` was read as text.`;
    case "dropped_null":
      return `Note: \`${repair.path}\` was null, so it was left out.`;
    case "dropped_key":
      return `Note: \`${repair.path}\` is not a parameter of this tool, so it was ignored.`;
    case "renamed_key":
      return `Note: \`${siblingPath(repair.path, repair.from)}\` was read as \`${repair.path}\`.`;
    case "renamed_value":
      return `Note: \`${repair.from}\` in \`${repair.path}\` was read as \`${repair.to}\`.`;
    case "parsed_value":
      return `Note: the text value of \`${repair.path}\` was read as ${PARSED_TYPE_NAMES[repair.type]}.`;
    case "decoded_escapes":
      return `Note: the \`\\uXXXX\` escapes in \`${repair.path}\` were read as the characters they name.`;
  }
}

const PARSED_TYPE_NAMES = { number: "a number", integer: "a number", boolean: "a boolean", array: "a list", object: "an object" } as const;

/** The dot path of `key` beside the last segment of `path`. */
function siblingPath(path: string, key: string): string {
  const parent = path.lastIndexOf(".");
  return parent === -1 ? key : `${path.slice(0, parent)}.${key}`;
}

function unwrapSingleWrapper(
  input: UnknownFields,
  schema: SchemaNode,
  { onRepair }: Coercion,
): UnknownFields {
  const [key, ...rest] = Object.keys(input);
  if (key === undefined || rest.length > 0) return input;
  if (!WRAPPER_KEYS.has(key)) return input;
  if (schema.properties && Object.hasOwn(schema.properties, key)) return input;

  const inner = input[key];
  const parsed = typeof inner === "string" ? tryJsonParse(inner) : inner;
  if (!isPlainObject(parsed)) return input;
  onRepair({ kind: "unwrapped", path: key });
  return parsed;
}

function coerceObject(
  value: UnknownFields,
  schema: SchemaNode,
  path: string,
  coercion: Coercion,
): UnknownFields {
  const { onRepair } = coercion;
  const properties = schema.properties ?? {};

  const declared = schema.additionalProperties === true || typeof schema.additionalProperties === "object" ? new Map<string, string>() : declaredKeys(value, properties);
  let mutated = false;
  const out: UnknownFields = {};
  for (const [inputKey, item] of Object.entries(value)) {
    const key = declared.get(inputKey) ?? inputKey;
    const propSchema = Object.hasOwn(properties, key) ? properties[key] : typeof schema.additionalProperties === "object" ? schema.additionalProperties : undefined;
    if (path === "" && propSchema === undefined && schema.additionalProperties !== true && (schema.properties !== undefined || schema.additionalProperties === false) && IGNORED_KEYS.has(key)) {
      onRepair({ kind: "dropped_key", path: key });
      mutated = true;
      continue;
    }
    if (item === null && Object.hasOwn(properties, key) && propSchema !== undefined && schemaProblems(item, propSchema).length > 0 && !schema.required?.includes(key)) {
      onRepair({ kind: "dropped_null", path: childPath(path, key) });
      mutated = true;
      continue;
    }
    if (key !== inputKey) {
      onRepair({ kind: "renamed_key", path: childPath(path, key), from: inputKey });
      mutated = true;
    }
    const coerced = propSchema === undefined ? item : coerceValue(item, propSchema, childPath(path, key), coercion);
    if (coerced !== item) mutated = true;
    Object.defineProperty(out, key, { value: coerced, enumerable: true, writable: true, configurable: true });
  }
  return mutated ? out : value;
}

/** The input keys that name an absent declared key, mapped to that key: the
 *  key in the text form that the model saw, or a synonym with the identical
 *  meaning. A key that the schema declares itself stays as it is, and a
 *  declared key with two candidate spellings in the input maps neither. */
function declaredKeys(value: UnknownFields, properties: SchemaProperties): Map<string, string> {
  const declared = new Map<string, string>();
  const candidates = new Map<string, string[]>();
  for (const inputKey of Object.keys(value)) {
    if (Object.hasOwn(properties, inputKey)) continue;
    const matches = Object.keys(properties).filter((key) => namesMatch(inputKey, key) || KEY_SYNONYMS.get(key)?.includes(inputKey));
    const [only] = matches;
    if (only !== undefined && matches.length === 1 && !Object.hasOwn(value, only)) {
      candidates.set(only, [...(candidates.get(only) ?? []), inputKey]);
    }
  }
  for (const [key, inputs] of candidates) if (inputs.length === 1 && inputs[0] !== undefined) declared.set(inputs[0], key);
  return declared;
}

function namesMatch(input: string, declared: string): boolean {
  const normalize = (name: string) => definitionText(name).toLowerCase().replace(/[\s_-]/g, "").replace(/id$/, "");
  return normalize(input) === normalize(declared);
}

function coerceValue(value: UnknownFields[string], schema: SchemaNode, path: string, coercion: Coercion): UnknownFields[string] {
  const enumTypes = schema.type === undefined && schema.enum
    ? [...new Set(schema.enum.map((member) => typeof member))].filter((type) => type === "string" || type === "number" || type === "boolean")
    : undefined;
  const branches = schema.branches ?? (schema.types ?? enumTypes)?.map((type) => ({ ...schema, types: undefined, type }));
  if (branches) {
    if (schemaProblems(value, schema).length === 0) {
      const accepting = branches.find((branch) => schemaProblems(value, branch).length === 0);
      // A valid member needs no type repair, but its strings still receive the bounded encoding repair.
      return accepting ? coerceValue(value, accepting, path, coercion) : value;
    }
    const selected = discriminatedBranch(value, branches);
    if (selected) return coerceValue(value, selected, path, coercion);
    const candidates = branches.map((branch) => {
      const repairs: ToolInputRepair[] = [];
      const candidate = coerceValue(value, branch, path, { ...coercion, onRepair: (repair) => repairs.push(repair) });
      return { candidate, repairs, valid: schemaProblems(candidate, branch).length === 0 && schemaProblems(candidate, schema).length === 0 };
    }).filter((candidate) => candidate.valid);
    const [only] = candidates;
    if (only && candidates.length === 1) {
      for (const repair of only.repairs) coercion.onRepair(repair);
      return only.candidate;
    }
    return value;
  }
  if (Array.isArray(value) && value.length === 1 && schema.type !== "array" && schema.type !== "object" && schemaProblems(value, schema).length > 0) {
    const repairs: ToolInputRepair[] = [];
    const converted = coerceValue(value[0], schema, path, { ...coercion, onRepair: (repair) => repairs.push(repair) });
    if (schemaProblems(converted, schema).length === 0) {
      coercion.onRepair({ kind: "unwrapped_array", path });
      for (const repair of repairs) coercion.onRepair(repair);
      return converted;
    }
  }
  if (typeof value === "string" && schema.enum !== undefined && !schema.enum.includes(value)) {
    const matches = schema.enum.filter((member): member is string => typeof member === "string" && schemaProblems(member, schema).length === 0 && (namesMatch(value, member) || VALUE_SYNONYMS.get(value) === member));
    const [declared] = matches;
    if (declared !== undefined && matches.length === 1) {
      coercion.onRepair({ kind: "renamed_value", path, from: value, to: declared });
      return declared;
    }
  }
  switch (schema.type) {
    case "object":
      return coerceMaybeObject(value, schema, path, coercion);
    case "array":
      return coerceMaybeArray(value, schema, path, coercion);
    case "number":
    case "integer":
      return typeof value === "string" ? parsedScalar(value, coerceNumber(value, schema.type === "integer"), schema.type, path, coercion) : value;
    case "boolean":
      return typeof value === "string" ? parsedScalar(value, coerceBoolean(value), "boolean", path, coercion) : value;
    case "string":
      if (typeof value === "number" || typeof value === "boolean") {
        coercion.onRepair({ kind: "stringified_value", path });
        return coerceValue(String(value), schema, path, coercion);
      }
      return typeof value === "string" && !coercion.verbatimText ? decodeDoubleEscapes(value, path, coercion) : value;
    default:
      return isPlainObject(value) ? coerceObject(value, schema, path, coercion) : value;
  }
}

function parsedScalar(text: string, parsed: string | number | boolean, type: "number" | "integer" | "boolean", path: string, { onRepair }: Coercion): UnknownFields[string] {
  if (parsed !== text) onRepair({ kind: "parsed_value", path, type });
  return parsed;
}

function coerceMaybeObject(value: UnknownFields[string], schema: SchemaNode, path: string, coercion: Coercion): UnknownFields[string] {
  if (isPlainObject(value)) return coerceObject(value, schema, path, coercion);
  if (typeof value === "string") {
    const parsed = tryJsonParse(value);
    if (isPlainObject(parsed)) {
      coercion.onRepair({ kind: "parsed_value", path, type: "object" });
      return coerceObject(parsed, schema, path, coercion);
    }
  }
  return value;
}

function coerceMaybeArray(value: UnknownFields[string], schema: SchemaNode, path: string, coercion: Coercion): UnknownFields[string] {
  if (Array.isArray(value)) return coerceArray(value, schema, path, coercion);
  if (typeof value === "string") {
    const parsed = tryJsonParse(value);
    if (Array.isArray(parsed)) {
      coercion.onRepair({ kind: "parsed_value", path, type: "array" });
      return coerceArray(parsed, schema, path, coercion);
    }
  }
  // Bare scalar for a declared array: wrap into a single-element array when
  // the items type accepts the scalar's kind. The kind check keeps genuine
  // type mismatches loud instead of smuggling them past validation.
  if (itemsAcceptScalar(schema.items, value)) {
    coercion.onRepair({ kind: "wrapped_in_array", path });
    return [value];
  }
  return value;
}

/** Applied at the wrap site: does the declared items type accept this
 *  scalar's primitive kind? Undeclared or unknown items types never wrap. */
function itemsAcceptScalar(items: SchemaNode | undefined, value: UnknownFields[string]): boolean {
  return items !== undefined && (items.type !== undefined || items.types !== undefined || items.branches !== undefined) && schemaProblems(value, items).length === 0;
}

function coerceArray(arr: UnknownFields[string][], schema: SchemaNode, path: string, coercion: Coercion): UnknownFields[string][] {
  if (!schema.items) return arr;

  const items = schema.items;
  let mutated = false;
  const out = arr.map((item, index) => {
    const next = coerceValue(item, items, childPath(path, String(index)), coercion);
    if (next !== item) mutated = true;
    return next;
  });
  return mutated ? out : arr;
}

function childPath(path: string, key: string): string {
  return path === "" ? key : `${path}.${key}`;
}

// Decimal text only: `Number` would also read "0x10", "0b1", and "" as numbers.
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function coerceNumber(value: string, asInteger: boolean): string | number {
  const trimmed = value.trim();
  if (!DECIMAL.test(trimmed)) return value;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return value;
  if (asInteger && !Number.isInteger(parsed)) return value;
  return parsed;
}

function coerceBoolean(value: string): string | boolean {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  return value;
}

/** Decodes the `\uXXXX` escapes that a model wrote twice over, so a string holds the six characters `\u00e9`
 *  where it means one character. Only an escape of a character that JSON text can hold as written is decoded: a
 *  non-ASCII character that is not a control, not half of a surrogate pair, and not a line or paragraph
 *  separator. A pair of escapes that spells one surrogate pair decodes to its one character. An escape
 *  after an odd run of backslashes is literal text and stays. Text that holds a Windows path stays whole,
 *  because there `\u` can start a directory name such as `\users`. */
function decodeDoubleEscapes(text: string, path: string, { onRepair }: Coercion): string {
  if (!text.includes("\\u") || holdsWindowsPath(text)) return text;
  let decoded = "";
  let copied = 0;
  for (let index = text.indexOf("\\u"); index !== -1; index = text.indexOf("\\u", index)) {
    const unit = escapedUnit(text, index);
    if (unit === undefined || precedingBackslashes(text, index) % 2 === 1) {
      index += unit === undefined ? 1 : 6;
      continue;
    }
    const pairedLow = isHighSurrogate(unit) ? escapedUnit(text, index + 6) : undefined;
    let character: string | undefined;
    let length = 6;
    if (pairedLow !== undefined && isLowSurrogate(pairedLow)) {
      character = String.fromCharCode(unit, pairedLow);
      length = 12;
    } else if (keepsAsWritten(unit)) {
      character = String.fromCharCode(unit);
    }
    if (character !== undefined) {
      decoded += text.slice(copied, index) + character;
      copied = index + length;
    }
    index += length;
  }
  if (copied === 0) return text;
  onRepair({ kind: "decoded_escapes", path });
  return decoded + text.slice(copied);
}

/** True for a code unit that is safe as a literal character in tool text. ASCII and C1 controls (below
 *  U+00A0), surrogate halves, and U+2028/U+2029 (JavaScript line terminators) are not. */
function keepsAsWritten(unit: number): boolean {
  return unit >= 0xa0 && !(unit >= 0xd800 && unit <= 0xdfff) && unit !== 0x2028 && unit !== 0x2029;
}

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/** The code unit that the `\uXXXX` escape at `index` spells, or undefined when four hex digits do not follow. */
function escapedUnit(text: string, index: number): number | undefined {
  if (!text.startsWith("\\u", index)) return undefined;
  let unit = 0;
  for (let offset = index + 2; offset < index + 6; offset += 1) {
    const digit = hexDigitValue(text.charCodeAt(offset));
    if (digit === undefined) return undefined;
    unit = unit * 16 + digit;
  }
  return unit;
}

function hexDigitValue(code: number): number | undefined {
  if (code >= 0x30 && code <= 0x39) return code - 0x30;
  const lower = code | 0x20;
  return lower >= 0x61 && lower <= 0x66 ? lower - 0x57 : undefined;
}

function precedingBackslashes(text: string, index: number): number {
  let count = 0;
  while (text[index - 1 - count] === "\\") count += 1;
  return count;
}

/** True when `text` holds a drive path (`C:\` or `C:/`, with a lone drive letter) or a UNC path (`\\host\`
 *  at the start, after white space, after a quote, or after `=`). */
function holdsWindowsPath(text: string): boolean {
  for (let colon = text.indexOf(":", 1); colon !== -1; colon = text.indexOf(":", colon + 1)) {
    const separator = text[colon + 1];
    if ((separator === "\\" || separator === "/") && isAsciiLetter(text[colon - 1]) && !isAsciiLetter(text[colon - 2])) return true;
  }
  for (let start = text.indexOf("\\\\"); start !== -1; start = text.indexOf("\\\\", start + 1)) {
    const before = text[start - 1];
    if (before !== undefined && before.trim().length > 0 && !"\"'=".includes(before)) continue;
    let end = start + 2;
    while (end < text.length && !isHostEnd(text.charAt(end))) end += 1;
    const separator = text[end];
    if (end > start + 2 && (separator === "\\" || separator === "/") && text[end + 1] !== "\\") return true;
  }
  return false;
}

function isAsciiLetter(character: string | undefined): boolean {
  return character !== undefined && /^[A-Za-z]$/.test(character);
}

function isHostEnd(character: string): boolean {
  return character === "\\" || character === "/" || character.trim().length === 0;
}

function tryJsonParse(s: string): UnknownFields[string] {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function isPlainObject(value: UnknownFields[string]): value is UnknownFields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}