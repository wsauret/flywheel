/**
 * The text form of a tool definition on every Anthropic route.
 *
 * The Claude engine that the claude-agent-sdk route runs rewrites every string and every object key of each tool
 * definition before it sends it, and no engine switch stops that (CLI 2.1.296, `UO` and `$on`). It folds the text with
 * NFKC, removes unpaired surrogates, and removes every format (Cf), private-use (Co), and unassigned (Cn) character,
 * which includes the zero-width characters U+200B to U+200F, the bidirectional controls U+202A to U+202E and U+2066 to
 * U+2069, the byte order mark U+FEFF, and the private-use block U+E000 to U+F8FF. It repeats both steps until the text
 * no longer changes. The shared Anthropic request path applies the same rewrite, so the native route and the
 * claude-agent-sdk route show the model the same definitions. The model then writes a key or an enum value in this
 * form, and the tool dispatcher reads such a key or value as the declared one (`coerce-input.ts`).
 *
 * Unassigned code points depend on the Unicode version of the runtime. The engine and Flywheel both run on Bun, so the
 * two agree while their Bun versions share a Unicode version.
 */

const FORMAT_CHARACTERS = /[\p{Cf}\p{Co}\p{Cn}]/gu;
const UNPAIRED_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
/** The engine gives up after this many passes; a real text settles after one or two. */
const MAX_PASSES = 10;

/** One string of a tool definition in the form that every Anthropic route sends. ASCII text is unchanged. */
export function definitionText(text: string): string {
  // oxlint-disable-next-line no-control-regex -- boundary: the engine skips every text that holds only ASCII code points.
  if (!/[^\0-\x7f]/.test(text)) return text;
  let current = text;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const next = current.normalize("NFKC").replace(UNPAIRED_SURROGATE, "").replace(FORMAT_CHARACTERS, "");
    if (next === current) return current;
    current = next;
  }
  return current;
}

/** One JSON value of a tool definition. An absent optional field stays `undefined`, so serialization still omits it. */
type DefinitionNode = string | number | boolean | null | undefined | readonly DefinitionNode[] | { readonly [key: string]: DefinitionNode };

/** A tool definition value with `definitionText` applied to every string and every object key, at every depth. */
export function definitionValue<Value>(value: Value): Value {
  // SAFETY: the rewrite keeps the JSON shape of the value and changes only the text of its strings and keys.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: a structural copy of the same JSON shape.
  return rewrite(value) as Value;
}

function rewrite(value: unknown): DefinitionNode {
  if (typeof value === "string") return definitionText(value);
  if (Array.isArray(value)) return value.map(rewrite);
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [definitionText(key), rewrite(item)]));
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  return undefined;
}
