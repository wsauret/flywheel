/**
 * Capped output buffer — preserves the tail (most recent content) when
 * the character limit is exceeded. Truncated content is replaced with a
 * marker so downstream consumers know data was lost.
 */

export const TRUNCATION_MARKER = "[...truncated in memory...]\n";

export const BUFFER_LIMIT = 2_000_000;

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

export class OutputBuffer {
  private data = "";
  private _truncated = false;

  append(content: string): void {
    const r = appendWithCharLimit(this.data, content, BUFFER_LIMIT);
    this.data = r.content;
    if (r.truncated) this._truncated = true;
  }

  getState(): BufferState {
    return { content: this.data, truncated: this._truncated };
  }
}
