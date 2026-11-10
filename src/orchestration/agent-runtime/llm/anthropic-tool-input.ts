/**
 * Reads the input text of one Anthropic `tool_use` block against the input
 * schema of its tool.
 *
 * The model writes each parameter of a call as its own item, and it often
 * writes a list parameter as the same parameter repeated, one item each.
 * Anthropic serializes every item as one object member, so the text can hold
 * the same key more than once:
 *
 * - With buffered input (the API default), each item arrives as a quoted
 *   string: `{"evidence": "a", "evidence": "b"}`. `JSON.parse` keeps only the
 *   last member, so every other item is lost without an error.
 * - With `eager_input_streaming`, the API does not quote or validate a value
 *   whose schema type is not a string, so each item arrives as the model's
 *   own text: `{"evidence": a "quoted" fact, "evidence": b}`. That text is not
 *   JSON, and a strict parse refuses the whole call.
 *
 * Both are one recoverable shape at the provider boundary. This reader splits
 * the object at the members of the declared parameters, reads each value as
 * JSON or, when it is not JSON, as the text that the model wrote, and gathers
 * the repeated members of a list parameter into one list. A repeated
 * parameter that is not a list stays a refusal that names it, because no
 * single value is the one the model meant. A text that ends before its object
 * closes stays a refusal, because a prefix is never a complete call.
 *
 * A list parameter that the model gives once, as one bare value, stays that
 * value here. The tool dispatcher's one schema coercion wraps it as a
 * one-item list for every provider, and records the wrap on the call.
 */

import { isRecord } from "../../../infra/record.js";
import { parseToolArguments, readJsonValue, unfinishedToolArguments, type ParsedToolArguments } from "../../../infra/llm/json-parse.js";

interface UnknownFields {
  [key: string]: unknown;
}

/** The parsed call, and the parameters that this reader gathered or read as
 *  text, for the adapter's one record of the repair. */
export interface AnthropicToolInput extends ParsedToolArguments {
  readonly repaired?: { readonly repeated: readonly string[]; readonly unquoted: number };
}

interface Member {
  readonly key: string;
  readonly value: unknown;
  readonly unquoted: boolean;
}

export function parseAnthropicToolInput(raw: string, schema: UnknownFields | undefined): AnthropicToolInput {
  const parsed = parseToolArguments(raw);
  const properties = isRecord(schema?.properties) ? schema.properties : {};
  const keys = Object.keys(properties);
  if (keys.length === 0 || (parsed.parseError === undefined && !keys.some((key) => occurrences(raw, key) > 1))) return parsed;

  const text = raw.trim();
  if (!text.startsWith("{")) return parsed;
  if (!text.endsWith("}")) return unfinishedToolArguments(raw);
  const members = splitMembers(text.slice(1, -1), keys);
  if (members === undefined) return parsed;

  const groups = Map.groupBy(members, ({ key }) => key);
  const input: UnknownFields = {};
  const repeated: string[] = [];
  for (const [key, group] of groups) {
    if (group.length === 1) {
      input[key] = group[0]?.value;
      continue;
    }
    if (!declaresList(properties[key])) {
      return { input: {}, parseError: `the arguments give the parameter "${key}" ${group.length} times, and its schema takes one value. Send "${key}" once` };
    }
    input[key] = group.flatMap(({ value }) => (Array.isArray(value) ? value : [value]));
    repeated.push(key);
  }
  const unquoted = members.filter((member) => member.unquoted).length;
  if (repeated.length === 0 && unquoted === 0) return parsed;
  return { input, repaired: { repeated, unquoted } };
}

/** How many times `"key":` starts a member anywhere in the text. A count above
 *  one is only a reason to split the object: a nested object can use the same
 *  name, and the split reads top-level members only. */
function occurrences(raw: string, key: string): number {
  return raw.match(new RegExp(`"${RegExp.escape(key)}"\\s*:`, "g"))?.length ?? 0;
}

function declaresList(property: unknown): boolean {
  if (!isRecord(property)) return false;
  const type = property.type;
  return type === "array" || (Array.isArray(type) && type.includes("array"));
}

/**
 * Splits the text between the outer braces into members. A value ends at the
 * first `, "<declared parameter>":` after it whose preceding text is one JSON
 * value, so a comma or a parameter name inside a string or a nested object
 * does not end it. A value that is JSON at no such point is the model's own
 * text up to the next declared parameter. Undefined when the text does not
 * start with a quoted member name.
 */
function splitMembers(body: string, keys: readonly string[]): Member[] | undefined {
  const names = keys.map((key) => RegExp.escape(key)).join("|");
  const boundaries = [...body.matchAll(new RegExp(`,\\s*"(?:${names})"\\s*:`, "g"))].map(({ index }) => index);
  boundaries.push(body.length);
  const members: Member[] = [];
  let start = 0;
  while (start < body.length) {
    const name = /^\s*"((?:[^"\\]|\\.)*)"\s*:/.exec(body.slice(start));
    const key = name ? readJsonValue(`"${name[1]}"`)?.value : undefined;
    if (!name || typeof key !== "string") return undefined;
    const valueStart = start + name[0].length;
    const ends = boundaries.filter((boundary) => boundary >= valueStart);
    const end = ends.find((boundary) => readJsonValue(body.slice(valueStart, boundary)) !== undefined);
    if (end === undefined) {
      const textEnd = ends[0] ?? body.length;
      members.push({ key, value: body.slice(valueStart, textEnd).trim(), unquoted: true });
      start = textEnd + 1;
    } else {
      members.push({ key, value: readJsonValue(body.slice(valueStart, end))?.value, unquoted: false });
      start = end + 1;
    }
  }
  return members;
}
