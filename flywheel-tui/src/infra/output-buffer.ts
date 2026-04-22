const TRUNCATION_MARKER = "[...truncated in memory...]\n";

const BUFFER_LIMIT = 2_000_000;

interface BufferState {
  content: string;
  truncated: boolean;
}

function appendWithCharLimit(
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

  if (charLimit <= TRUNCATION_MARKER.length) {
    return { content: TRUNCATION_MARKER.slice(0, charLimit), truncated: true };
  }

  const keep = charLimit - TRUNCATION_MARKER.length;
  const combinedTailStart = combined.length - keep;

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
