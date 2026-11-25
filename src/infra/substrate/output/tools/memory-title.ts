const MAX_MEMORY_TITLE_GRAPHEMES = 60;
const titleSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Normalize a generated memory mutation title for validation and transcript rendering. Returns null when the value has no visible text. */
export function normalizeMemoryTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const title = value
    .replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (!title || !title.replace(/\p{Cf}/gu, "").trim()) return null;
  const graphemes = Array.from(titleSegmenter.segment(title), ({ segment }) => segment);
  return graphemes.length > MAX_MEMORY_TITLE_GRAPHEMES
    ? `${graphemes.slice(0, MAX_MEMORY_TITLE_GRAPHEMES - 1).join("")}…`
    : title;
}
