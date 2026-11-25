/**
 * Three-stage JSON extraction for LLM-emitted JSON.
 *
 * Models that are asked to emit JSON sometimes wrap the object in a markdown
 * code fence or surround it with explanatory prose. This walks through:
 *
 *  1. Strict `JSON.parse` on the raw text.
 *  2. Extract a fenced ```json … ``` block and parse that.
 *  3. Take the substring from the first `{` to the last `}` and parse that.
 *
 * Throws the original parse error if all three stages fail.
 *
 */
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function parseJson(text: string): JsonValue {
  return JSON.parse(text);
}

export function tryParseJsonFromText(text: string): JsonValue {
  try {
    return parseJson(text);
  } catch (originalErr) {
    const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
    if (fenced?.[1]) {
      try { return parseJson(fenced[1]); } catch {
        // Fall through to the next salvage strategy.
      }
    }
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first !== -1 && last > first) {
      try { return parseJson(text.slice(first, last + 1)); } catch {
        // Preserve the original parse error below.
      }
    }
    throw originalErr;
  }
}
