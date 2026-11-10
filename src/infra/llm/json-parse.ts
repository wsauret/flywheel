/**
 * Streaming-aware JSON parser. Used by adapters that accumulate
 * provider-emitted tool-call argument deltas; the final buffer can be
 * malformed (raw control characters in string values, dangling backslashes)
 * because providers don't always escape correctly mid-stream.
 *
 * Adapted from pi `packages/ai/src/utils/json-parse.ts` (MIT); credited in
 * THIRD-PARTY-NOTICES.md.
 * Two repair tiers: strict JSON.parse, then repair control chars and bad
 * escapes. A buffer neither tier accepts is classified, not salvaged. When
 * the text ends with no syntax error before its end, it is a prefix of a
 * document the model never finished (an output-length cut or a dropped
 * stream), and a tool that runs on a completed prefix gets silently shortened
 * input. Otherwise the text is closed but invalid, and the message names the
 * character where the syntax fails and shows the text around it. Either way
 * the call is refused with a parse error that the dispatcher turns into an
 * error result, so the model can send a corrected call.
 */

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

function isJsonObject(value: unknown): value is UnknownFields {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One JSON value read by the same two tiers as tool arguments: strict, then
 *  the repair of raw control characters and bad escapes. Undefined when
 *  neither tier accepts the text. */
export function readJsonValue(text: string): { readonly value: unknown } | undefined {
  try {
    return { value: parseJsonWithRepair(text) };
  } catch {
    return undefined;
  }
}

/** The refusal for argument text that ends before its arguments close. */
export function unfinishedToolArguments(raw: string): ParsedToolArguments {
  return { input: {}, parseError: describeRejectedArguments(raw, { kind: "unfinished" }) };
}

/**
 * Parse a (possibly malformed or incomplete) JSON string from a streaming
 * tool-call accumulator. Never throws.
 */
export function parseToolArguments(raw: string | undefined): ParsedToolArguments {
  if (!raw || raw.trim() === "") return { input: {} };
  const salvaged = salvageJson(raw);
  if (salvaged.kind === "complete" && isJsonObject(salvaged.value)) {
    return { input: salvaged.value };
  }
  return { input: {}, parseError: describeRejectedArguments(raw, salvaged) };
}

/** Where a text stops being JSON. `unfinished` means that the text ends with
 *  no syntax error before its end, so it is a prefix of a document that was
 *  cut. `invalid` names the first character (zero-based `index`) that no JSON
 *  document can contain at that place. */
type JsonSyntaxFault =
  | { readonly kind: "unfinished" }
  | { readonly kind: "invalid"; readonly index: number; readonly reason: string };

type SalvagedJson = { readonly kind: "complete"; readonly value: unknown } | JsonSyntaxFault;

/** Strict parse, then repair, each tried on the raw text and an
 *  envelope-stripped candidate. Text that neither accepts is classified by
 *  the syntax scanner; a prefix is never returned as a value. */
function salvageJson(raw: string): SalvagedJson {
  const stripped = stripJsonEnvelope(raw);
  const candidates = stripped !== raw && stripped.trim() !== "" ? [raw, stripped] : [raw];

  for (const candidate of candidates) {
    try {
      return { kind: "complete", value: parseJsonWithRepair(candidate) };
    } catch {
      // fall through to the next candidate / the classification below
    }
  }
  const rawFault = findJsonSyntaxFault(raw);
  if (candidates.length === 1 || rawFault.kind === "unfinished") return rawFault;
  // The stripped text is the part that the model meant as JSON, so its fault
  // is the useful one. Its index moves back to a position in the raw text.
  const strippedFault = findJsonSyntaxFault(stripped);
  if (strippedFault.kind === "unfinished") return strippedFault;
  return { ...strippedFault, index: raw.indexOf(stripped) + strippedFault.index };
}

const JSON_LITERALS = ["true", "false", "null"] as const;
const STRUCTURAL_CHARACTERS = new Set([",", ":", "{", "}", "[", "]", '"']);
const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const NUMBER_CHARACTERS = /[-+.eE0-9]*/y;
const NUMBER_PREFIX = /^-?(?:(?:0|[1-9]\d*)(?:\.\d*|\.\d+[eE][+-]?\d*|[eE][+-]?\d*)?)?$/;
const EXPECTED_VALUE = "expected a JSON value: a string, number, object, array, true, false, or null";
const DOUBLE_QUOTES = "JSON strings and property names use double quotes, not single quotes";

/**
 * Finds the first syntax fault in a text that JSON.parse rejected. The
 * scanner accepts what `repairJson` repairs (raw control characters and
 * unknown escapes inside strings), so a fault that it reports is one that
 * repair could not remove.
 */
function findJsonSyntaxFault(text: string): JsonSyntaxFault {
  const invalid = (index: number, reason: string): JsonSyntaxFault => ({ kind: "invalid", index, reason });
  const containers: Array<"{" | "["> = [];
  let expect: "value" | "key" | "colon" | "separator" = "value";
  let lastComma = -1;
  let lastQuote = -1;
  let justOpened = false;
  let justClosedString = false;

  for (let index = skipJsonWhitespace(text, 0); index < text.length; index = skipJsonWhitespace(text, index)) {
    // SAFETY: index < text.length guarantees text[index] is a character.
    const char = text[index]!;
    const container = containers.at(-1);
    const afterOpen = justOpened;
    const afterString = justClosedString;
    justOpened = false;
    justClosedString = false;
    // Text such as `"say "hi" now"` closes the string early. The next
    // character is then ordinary text where JSON expects punctuation, and the
    // useful position is the quote that closed the string.
    const unescapedQuote = afterString && !STRUCTURAL_CHARACTERS.has(char);

    if (expect === "separator") {
      const closer = container === "{" ? "}" : "]";
      if (unescapedQuote) return invalid(lastQuote, "unescaped quote inside a string");
      if (container === undefined) return invalid(index, "unexpected text after the end of the JSON value");
      if (char === ",") {
        lastComma = index;
        expect = container === "{" ? "key" : "value";
      } else if (char === closer) {
        containers.pop();
      } else {
        return invalid(index, `expected "," or "${closer}" after ${container === "{" ? "the property value" : "the array element"}`);
      }
      index += 1;
      continue;
    }
    if (expect === "colon") {
      if (unescapedQuote) return invalid(lastQuote, "unescaped quote inside a string");
      if (char !== ":") return invalid(index, 'expected ":" after the property name');
      expect = "value";
      index += 1;
      continue;
    }
    if (char === "'") return invalid(index, DOUBLE_QUOTES);
    if (expect === "key") {
      if (char === "}") {
        if (!afterOpen) return invalid(lastComma, 'trailing comma before "}"');
        containers.pop();
        expect = "separator";
        index += 1;
        continue;
      }
      if (char !== '"') return invalid(index, "expected a double-quoted property name");
    }
    if (char === "]" && container === "[") {
      if (!afterOpen) return invalid(lastComma, 'trailing comma before "]"');
      containers.pop();
      expect = "separator";
      index += 1;
      continue;
    }

    const end = char === '"' ? scanJsonString(text, index)
      : char === "{" || char === "[" ? index + 1
        : char === "-" || (char >= "0" && char <= "9") ? scanJsonNumber(text, index)
          : scanJsonLiteral(text, index);
    if (typeof end !== "number") return end;
    if (char === "{" || char === "[") {
      containers.push(char);
      justOpened = true;
    }
    if (char === '"') {
      lastQuote = end - 1;
      justClosedString = true;
    }
    expect = char === "{" ? "key" : char === "[" ? "value" : expect === "key" ? "colon" : "separator";
    index = end;
  }
  // JSON.parse rejected the text, so a scan that finds a closed document
  // means that the scanner and the parser disagree. Say so instead of
  // claiming a cut.
  return containers.length === 0 && expect === "separator"
    ? invalid(0, "the JSON parser rejected the text")
    : { kind: "unfinished" };
}

function skipJsonWhitespace(text: string, index: number): number {
  let next = index;
  while (next < text.length && " \t\n\r".includes(text[next] ?? "")) next += 1;
  return next;
}

/** Returns the index after the closing quote of the string at `start`. */
function scanJsonString(text: string, start: number): number | JsonSyntaxFault {
  for (let index = start + 1; index < text.length; index++) {
    const char = text[index];
    if (char === '"') return index + 1;
    if (char !== "\\") continue;
    if (text[index + 1] === "u") {
      const digits = text.slice(index + 2, index + 6);
      if (!/^[0-9a-fA-F]*$/.test(digits)) {
        return { kind: "invalid", index, reason: "a \\u escape needs four hexadecimal digits" };
      }
      index += 4;
    }
    index += 1;
  }
  return { kind: "unfinished" };
}

/** Returns the index after the number at `start`. */
function scanJsonNumber(text: string, start: number): number | JsonSyntaxFault {
  NUMBER_CHARACTERS.lastIndex = start;
  const run = NUMBER_CHARACTERS.exec(text)?.[0] ?? "";
  const end = start + run.length;
  if (end === text.length && NUMBER_PREFIX.test(run)) return { kind: "unfinished" };
  NUMBER.lastIndex = start;
  if (NUMBER.exec(text)?.[0].length === run.length) return end;
  return { kind: "invalid", index: start, reason: "invalid number" };
}

/** Returns the index after the literal `true`, `false`, or `null` at `start`. */
function scanJsonLiteral(text: string, start: number): number | JsonSyntaxFault {
  const word = JSON_LITERALS.find((literal) => literal[0] === text[start]);
  if (word !== undefined) {
    const found = text.slice(start, start + word.length);
    if (found === word) return start + word.length;
    if (start + found.length === text.length && word.startsWith(found)) return { kind: "unfinished" };
  }
  return { kind: "invalid", index: start, reason: EXPECTED_VALUE };
}

const RAW_SNIPPET_MAX = 600;
const FAULT_CONTEXT = 80;
const FAULT_MARKER = "<<HERE>>";

/** The model-facing reason for a refused call. The conversation stores the
 *  refused call as `{}`, so the message shows the part of the text that the
 *  model must fix: the start for a non-object value, the marked fault for
 *  invalid JSON, and the end for a cut text. */
function describeRejectedArguments(raw: string, salvaged: SalvagedJson): string {
  switch (salvaged.kind) {
    case "complete":
      return `the argument text parsed to ${describeJsonValue(salvaged.value)} instead of an object. Raw argument text received: ${rawSnippet(raw)}`;
    case "unfinished": {
      const tail = raw.length > 2 * FAULT_CONTEXT ? `…${raw.slice(-2 * FAULT_CONTEXT)}` : raw;
      return `the argument text is incomplete JSON: it ends before the arguments are closed, so the call was cut off before its arguments were finished. The text has ${raw.length} characters and ends with: ${tail}`;
    }
    case "invalid": {
      const from = Math.max(0, salvaged.index - FAULT_CONTEXT);
      const to = Math.min(raw.length, salvaged.index + FAULT_CONTEXT);
      const before = `${from > 0 ? "…" : ""}${raw.slice(from, salvaged.index)}`;
      const after = `${raw.slice(salvaged.index, to)}${to < raw.length ? "…" : ""}`;
      const character = salvaged.index + 1;
      return `the argument text is not valid JSON at character ${character} of ${raw.length}: ${salvaged.reason}. The text around it, with ${FAULT_MARKER} before character ${character}: ${before}${FAULT_MARKER}${after}`;
    }
  }
}

function describeJsonValue(value: unknown): string {
  if (Array.isArray(value)) return "a JSON array";
  if (value === null) return "null";
  return `a JSON ${typeof value}`;
}

function rawSnippet(raw: string): string {
  if (raw.length <= RAW_SNIPPET_MAX) return raw;
  return `${raw.slice(0, RAW_SNIPPET_MAX)} … [${raw.length - RAW_SNIPPET_MAX} more chars]`;
}
