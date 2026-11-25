
export function truncateHeadTail(
  text: string,
  maxBytes: number,
  portionBytes?: number,
) {
  const byteLen = Buffer.byteLength(text, "utf-8");
  if (byteLen <= maxBytes) return { text, truncated: false, omittedBytes: 0 };
  const portion = portionBytes ?? Math.floor(maxBytes / 2);
  const bytes = Buffer.from(text, "utf-8");
  const first = bytes.subarray(0, portion).toString("utf-8");
  const last = bytes.subarray(-portion).toString("utf-8");
  const omittedBytes = byteLen - portion * 2;
  return {
    text: `${first}\n[... ${omittedBytes} bytes omitted ...]\n${last}`,
    truncated: true,
    omittedBytes,
  };
}

/** Returns the longest valid UTF-8 prefix whose encoded form fits `maxBytes`. */
export function truncateUtf8Prefix(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf-8");
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0) {
    const byte = bytes[end];
    if (byte === undefined || (byte & 0xc0) !== 0x80) break;
    end -= 1;
  }
  return bytes.subarray(0, end).toString("utf-8");
}
