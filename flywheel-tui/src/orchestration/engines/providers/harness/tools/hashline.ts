/**
 * Hashline display format for the read tool.
 *
 * Each line is prefixed with `LINENUM#HASH:` where HASH is a 2-character
 * code derived from xxHash32 of the trimmed line text. This format gives
 * the model line-addressable references for editing.
 */

const NIBBLE_STR = "ZPMQVRWSNKTXJBYH";

const DICT = Array.from({ length: 256 }, (_, i) => {
  const h = i >>> 4;
  const l = i & 0x0f;
  return `${NIBBLE_STR[h]!}${NIBBLE_STR[l]!}`;
});

const RE_SIGNIFICANT = /[\p{L}\p{N}]/u;

/**
 * Compute a 2-character hash of a single line.
 *
 * Uses xxHash32 on trailing-whitespace-trimmed text. For lines with no
 * alphanumeric characters, the line index is mixed in as a seed to
 * reduce collisions among punctuation-only / blank lines.
 */
export function computeLineHash(idx: number, line: string): string {
  const trimmed = line.replace(/\r/g, "").trimEnd();
  const seed = RE_SIGNIFICANT.test(trimmed) ? 0 : idx;
  return DICT[Bun.hash.xxHash32(trimmed, seed) & 0xff]!;
}

/**
 * Format a line tag: `LINENUM#HASH` (e.g. `5#KX`).
 */
export function formatLineTag(lineNumber: number, lineText: string): string {
  return `${lineNumber}#${computeLineHash(lineNumber, lineText)}`;
}

/**
 * Format file content with hashline prefixes for display.
 * Each line becomes `LINENUM#HASH:TEXT` where LINENUM is 1-indexed.
 */
export function formatHashLines(content: string): string {
  const lines = content.split("\n");
  return lines
    .map((line, i) => {
      const num = i + 1;
      return `${formatLineTag(num, line)}:${line}`;
    })
    .join("\n");
}
