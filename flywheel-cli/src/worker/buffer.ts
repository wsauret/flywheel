/**
 * 3-tier output buffer system (from ralph-tui pattern).
 *
 * Tiers preserve tail content — when a tier overflows, the oldest content
 * is dropped and a truncation marker is prepended.
 *
 * Tier 1: 2,000,000 chars — full history for archival
 * Tier 2: 250,000 chars  — NDJSON flushing / evaluation
 * Tier 3: 100,000 chars  — TUI display
 */

export const TRUNCATION_MARKER = "[...truncated in memory...]\n";

export const TIER_1_LIMIT = 2_000_000;
export const TIER_2_LIMIT = 250_000;
export const TIER_3_LIMIT = 100_000;

export interface BufferState {
  content: string;
  truncated: boolean;
}

/**
 * Append text to a buffer, preserving the tail (most recent content)
 * when the character limit is exceeded.
 *
 * When truncation occurs, the truncation marker is prepended to the
 * remaining content.
 */
export function appendWithCharLimit(
  existing: string,
  newContent: string,
  charLimit: number,
): BufferState {
  if (!newContent) return { content: existing, truncated: false };
  if (charLimit <= 0) return { content: "", truncated: false };

  const combined = existing + newContent;

  if (combined.length <= charLimit) {
    return { content: combined, truncated: false };
  }

  // When limit is too small to fit marker + any tail, truncate the marker itself
  if (charLimit <= TRUNCATION_MARKER.length) {
    return { content: TRUNCATION_MARKER.slice(0, charLimit), truncated: true };
  }

  // Keep the tail that fits within the limit (minus marker length)
  const keep = charLimit - TRUNCATION_MARKER.length;
  const combinedTailStart = combined.length - keep;

  // Handle the case where tail spans current and newContent
  let tail: string;
  if (combinedTailStart >= existing.length) {
    tail = newContent.slice(combinedTailStart - existing.length);
  } else {
    const tailFromExisting = existing.slice(combinedTailStart);
    const remaining = keep - tailFromExisting.length;
    tail = remaining > 0 ? tailFromExisting + newContent.slice(-remaining) : tailFromExisting;
  }

  return {
    content: TRUNCATION_MARKER + tail,
    truncated: true,
  };
}

/**
 * Three-tier buffer: each tier independently tracks content and truncation state.
 */
export class TieredBuffer {
  private tier1 = "";
  private tier2 = "";
  private tier3 = "";
  private tier1Truncated = false;
  private tier2Truncated = false;
  private tier3Truncated = false;

  /**
   * Append content to all three tiers simultaneously.
   */
  append(content: string): void {
    const r1 = appendWithCharLimit(this.tier1, content, TIER_1_LIMIT);
    this.tier1 = r1.content;
    if (r1.truncated) this.tier1Truncated = true;

    const r2 = appendWithCharLimit(this.tier2, content, TIER_2_LIMIT);
    this.tier2 = r2.content;
    if (r2.truncated) this.tier2Truncated = true;

    const r3 = appendWithCharLimit(this.tier3, content, TIER_3_LIMIT);
    this.tier3 = r3.content;
    if (r3.truncated) this.tier3Truncated = true;
  }

  /** Full history (Tier 1, 2M chars). */
  getTier1(): BufferState {
    return { content: this.tier1, truncated: this.tier1Truncated };
  }

  /** Evaluation/flush tier (Tier 2, 250K chars). */
  getTier2(): BufferState {
    return { content: this.tier2, truncated: this.tier2Truncated };
  }

  /** Display tier (Tier 3, 100K chars). */
  getTier3(): BufferState {
    return { content: this.tier3, truncated: this.tier3Truncated };
  }

  /** Whether any tier has been truncated. */
  get truncated(): boolean {
    return this.tier1Truncated || this.tier2Truncated || this.tier3Truncated;
  }
}
