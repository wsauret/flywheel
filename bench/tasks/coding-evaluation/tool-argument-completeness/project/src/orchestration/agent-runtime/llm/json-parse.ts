/**
 * Streaming-aware JSON parser. Used by adapters that accumulate
 * provider-emitted tool-call argument deltas; the final buffer can be
 * malformed (raw control characters in string values, dangling backslashes)
 * because providers don't always escape correctly mid-stream.
 *
 * Ported from `upstream llm/utils/json-parse.ts` for sharing across Flywheel agent runtime adapters.
 * Three-tier fallback: strict JSON.parse → repair control chars + bad
 * escapes → partial-json's tolerant parse.
 */

import { parse as partialParse } from "partial-json";

const VALID_JSON_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

interface UnknownFields { [key: string]: unknown }

function isControlCharacter(char: string): boolean {
  const codePoint = char.codePointAt(0);
  return codePoint !== undefined && codePoint >= 0x00 && codePoint <= 0x1f;
}

function escapeControlCharacter(char: string): string {
  switch (char) {
    case "\b": return "\\b";
    case "\f": return "\\f";
    case "\n": return "\\n";
    case "\r": return "\\r";
    case "\t": return "\\t";
    default: return `\\u${char.codePointAt(0)?.toString(16).padStart(4, "0") ?? "0000"}`;
  }
}

function repairJson(json: string): string {
  let repaired = "";
  let inString = false;

  for (let index = 0; index < json.length; index++) {
    // SAFETY: index < json.length guarantees json[index] is a character.
    const char = json[index]!;

    if (!inString) {
      repaired += char;
      if (char === '"') inString = true;
      continue;
    }

    if (char === '"') {
      repaired += char;
      inString = false;
      continue;
    }

    if (char === "\\") {
      const nextChar = json[index + 1];
      if (nextChar === undefined) { repaired += "\\\\"; continue; }
      if (nextChar === "u") {
        const unicodeDigits = json.slice(index + 2, index + 6);
        if (/^[0-9a-fA-F]{4}$/.test(unicodeDigits)) {
          repaired += `\\u${unicodeDigits}`;
          index += 5;
          continue;
        }
      }
      if (VALID_JSON_ESCAPES.has(nextChar)) {
        repaired += `\\${nextChar}`;
        index += 1;
        continue;
      }
      repaired += "\\\\";
      continue;
    }

    repaired += isControlCharacter(char) ? escapeControlCharacter(char) : char;
  }

  return repaired;
}

// Returns `unknown`: provider-supplied JSON has no guaranteed shape, so the
// caller must narrow rather than receive a caller-chosen, unchecked `as T`.
// oxlint-disable-next-line anti-slop/no-unknown-returns -- boundary: Provider JSON has no trusted shape before runtime narrowing.
function parseJsonWithRepair(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch (error) {
    const repaired = repairJson(json);
    if (repaired !== json) return JSON.parse(repaired);
    throw error;
  }
}

/**
 * Strips a non-JSON envelope a model sometimes wraps tool arguments in: a
 * markdown code fence (```json ... ```) and/or leading/trailing prose around
 * the outermost JSON object/array. Returns the input trimmed-and-unchanged when
 * it already looks like bare JSON, so valid payloads are never reshaped.
 */
function stripJsonEnvelope(text: string): string {
  let s = text.trim();
  const fence = /^```(?:json5?|jsonc)?\s*\n?([\s\S]*?)\n?```$/i.exec(s);
  if (fence?.[1] !== undefined) s = fence[1].trim();

  const start = s.search(/[{[]/);
  if (start === -1) return s;
  const close = s[start] === "{" ? "}" : "]";
  const end = s.lastIndexOf(close);
  return end > start ? s.slice(start, end + 1) : s;
}

/**
 * Result of parsing model-authored tool-call arguments. `input` is always an
 * object; on total parse failure (or a non-object payload) it is `{}` and
 * `parseError` carries a model-ready description with a bounded snippet of
 * the raw text. The dispatcher turns that into an error tool_result instead
 * of silently executing the tool with empty arguments - the conversation
 * stores the parsed `{}`, so without the snippet the model cannot see what
 * it actually sent.
 */
export interface ParsedToolArguments {
  input: UnknownFields;
  parseError?: string;
}

/**
 * Parse a (possibly malformed or incomplete) JSON string from a streaming
 * tool-call accumulator. Never throws.
 */
function isJsonObject(value: unknown): value is UnknownFields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseToolArguments(raw: string | undefined): ParsedToolArguments {
  if (!raw || raw.trim() === "") return { input: {} };
  const salvaged = salvageJson(raw);
  if (isJsonObject(salvaged)) {
    return { input: salvaged };
  }
  const reason = salvaged === undefined
    ? "the argument text is not parseable as JSON"
    : `the argument text parsed to ${describeJsonValue(salvaged)} instead of an object`;
  return { input: {}, parseError: `${reason}. Raw argument text received: ${rawSnippet(raw)}` };
}

/** Three-tier salvage: strict parse -> repair -> partial parse, each tried on
 *  the raw text and an envelope-stripped candidate. `undefined` = total failure. */
// oxlint-disable-next-line anti-slop/no-unknown-returns -- boundary: Salvaged provider JSON has no trusted shape before runtime narrowing.
function salvageJson(raw: string): unknown {
  const candidates = [raw];
  const stripped = stripJsonEnvelope(raw);
  if (stripped !== raw && stripped.trim() !== "") candidates.push(stripped);

  for (const candidate of candidates) {
    try {
      return parseJsonWithRepair(candidate);
    } catch {
      // fall through to the next candidate / tolerant tiers
    }
  }
  for (const candidate of candidates) {
    try {
      const result = partialParse(candidate);
      if (result) return result;
    } catch {
      // try repaired form below
    }
    try {
      const result = partialParse(repairJson(candidate));
      if (result) return result;
    } catch {
      // next candidate
    }
  }
  return undefined;
}

function describeJsonValue(value: unknown): string {
  if (Array.isArray(value)) return "a JSON array";
  if (value === null) return "null";
  return `a JSON ${typeof value}`;
}

const RAW_SNIPPET_MAX = 600;

function rawSnippet(raw: string): string {
  if (raw.length <= RAW_SNIPPET_MAX) return raw;
  return `${raw.slice(0, RAW_SNIPPET_MAX)} … [${raw.length - RAW_SNIPPET_MAX} more chars]`;
}
