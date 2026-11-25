/** Serializes a value to JSON and truncates at a UTF-8 byte budget without
 *  splitting a multi-byte character. Unserializable values become a marker. */
export function truncateField(value: unknown, maxBytes: number = 4096): string {
  let json: string;
  try {
    json = JSON.stringify(value) ?? "null";
  } catch {
    // Distinguishable marker: a value that cannot stringify (circular refs,
    // throwing getters) must not masquerade as a literal JSON null.
    json = "<unserializable>";
  }

  const buf = Buffer.from(json, "utf-8");
  if (buf.length <= maxBytes) return json;

  // Truncate at byte boundary, then decode; Buffer.toString handles partial
  // multi-byte sequences by stopping before an incomplete character.
  // We trim one extra byte at a time if we land mid-character.
  let end = maxBytes;
  while (end > 0) {
    const slice = buf.subarray(0, end);
    const decoded = slice.toString("utf-8");
    // Re-encode to check we didn't gain replacement characters
    if (!decoded.includes("\uFFFD")) {
      return decoded;
    }
    end--;
  }
  return "";
}
