/** Identifies nonempty public narration without changing the signed provider block.
 * Unknown, redacted, and unreadable signatures retain ordinary thinking treatment. */
export function isAnthropicNarration(block: { thinking?: unknown; signature?: unknown; redacted?: unknown }): boolean {
  if (block.redacted === true || typeof block.thinking !== "string" || !block.thinking.trim() || typeof block.signature !== "string") return false;
  let decoded: string;
  try {
    decoded = atob(block.signature);
  } catch {
    return false;
  }
  const bytes = Uint8Array.from(decoded, character => character.charCodeAt(0));
  // The signature envelope's field 2 contains metadata; its field 1 holds block_kind in field 8.
  const metadata = bytesField(bytes, 2);
  if (metadata === undefined) return false;
  const header = bytesField(metadata, 1);
  if (header === undefined) return false;
  const kind = bytesField(header, 8);
  return kind !== undefined && decoder.decode(kind) === "narration";
}

/** Whether a thinking block is a progress update that the agent said to its person, which every reader takes as the
 *  agent's text: one that its adapter marked, or signed narration. Every other thinking block is private deliberation. */
export function isProgressUpdate(block: { thinking?: unknown; signature?: unknown; redacted?: unknown; presentation?: unknown }): boolean {
  return block.presentation === "progress" || isAnthropicNarration(block);
}

const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

function varint(bytes: Uint8Array, offset: number): { value: number; next: number } | undefined {
  let value = 0;
  let scale = 1;
  for (let index = 0; index < 10; index++) {
    const byte = bytes[offset + index];
    if (byte === undefined) return;
    value += (byte & 127) * scale;
    if ((byte & 128) === 0) return { value, next: offset + index + 1 };
    scale *= 128;
  }
  return;
}

function bytesField(bytes: Uint8Array, field: number): Uint8Array | undefined {
  let offset = 0;
  let found: Uint8Array | undefined;
  while (offset < bytes.length) {
    const tag = varint(bytes, offset);
    if (tag === undefined) return;
    const wireType = tag.value & 7;
    const fieldNumber = Math.floor(tag.value / 8);
    offset = tag.next;
    switch (wireType) {
      case 0: {
        const value = varint(bytes, offset);
        if (value === undefined) return;
        offset = value.next;
        break;
      }
      case 1:
        if (offset + 8 > bytes.length) return;
        offset += 8;
        break;
      case 2: {
        const length = varint(bytes, offset);
        if (length === undefined || length.value > bytes.length - length.next) return;
        offset = length.next + length.value;
        if (fieldNumber === field) found = bytes.subarray(length.next, offset);
        break;
      }
      case 5:
        if (offset + 4 > bytes.length) return;
        offset += 4;
        break;
      default:
        return;
    }
  }
  return found;
}
