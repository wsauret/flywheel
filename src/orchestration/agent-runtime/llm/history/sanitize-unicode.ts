/**
 * Removes unpaired Unicode surrogate characters from a string.
 *
 * Unpaired surrogates (high surrogates 0xD800-0xDBFF without matching low
 * surrogates 0xDC00-0xDFFF, or vice versa) cause JSON serialization errors in
 * many API providers and protobuf serializers (notably Google's GenAI SDK).
 *
 * Valid emoji and other characters outside the Basic Multilingual Plane use
 * properly paired surrogates and will NOT be affected by this function.
 *
 * Copied from pi `packages/ai/src/utils/sanitize-unicode.ts` (MIT); credited in
 * THIRD-PARTY-NOTICES.md.
 */
export function sanitizeSurrogates(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}
