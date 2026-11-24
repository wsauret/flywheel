import type { ImageBlockParam } from "@anthropic-ai/sdk/resources/messages.js";

// CLI 2.1.294 and 2.1.295 run every top-level image of a pushed user message through a resize step. The step
// decodes the base64, names the media type from the bytes, and passes the bytes unchanged only when the format is
// one that it sends, both sides are at most 2,000 pixels, and the file is at most 512,000 bytes. Otherwise it
// shrinks or re-encodes the image and adds an "[Image: original ...]" text block. A transcript row and a tool result
// reach the service unchanged. No setting turns the step off.

/** The longest side that the CLI keeps. */
const MAX_SIDE = 2_000;
/** The largest file that the CLI keeps. */
const MAX_BYTES = 512_000;
/** The longest base64 text of a file of at most `MAX_BYTES`. */
const MAX_BASE64_LENGTH = Math.ceil(MAX_BYTES / 3) * 4;

interface ImageHeader {
  readonly mediaType: string;
  readonly width: number;
  readonly height: number;
}

/**
 * Whether the CLI would change this image if the bridge pushed it as a top-level block. It is true also when the
 * header cannot be read, because the bridge must never push an image that the CLI could change. A URL or file source
 * is passed unchanged.
 */
export function cliRewritesImage(source: ImageBlockParam["source"]): boolean {
  if (source.type !== "base64") return false;
  if (source.data.length > MAX_BASE64_LENGTH) return true;
  const bytes = Buffer.from(source.data, "base64");
  if (bytes.length > MAX_BYTES || bytes.toString("base64") !== source.data) return true;
  const header = imageHeader(bytes);
  return header === undefined || header.mediaType !== source.media_type || header.width < 1 || header.height < 1 || header.width > MAX_SIDE || header.height > MAX_SIDE;
}

/** The format and size that a PNG, JPEG, GIF, or WebP file states in its header. */
function imageHeader(bytes: Buffer): ImageHeader | undefined {
  const ascii = (start: number, end: number) => bytes.toString("latin1", start, end);
  if (bytes.length >= 24 && bytes.readUInt32BE(0) === 0x89504e47 && ascii(12, 16) === "IHDR") {
    return { mediaType: "image/png", width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  if (bytes.length >= 10 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) {
    return { mediaType: "image/gif", width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
  }
  if (bytes.length >= 30 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return webpHeader(bytes, ascii(12, 16));
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) return jpegHeader(bytes);
  return undefined;
}

function webpHeader(bytes: Buffer, chunk: string): ImageHeader | undefined {
  const mediaType = "image/webp";
  switch (chunk) {
    case "VP8 ": return { mediaType, width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    case "VP8L": {
      const bits = bytes.readUInt32LE(21);
      return { mediaType, width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    case "VP8X": return { mediaType, width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
    default: return undefined;
  }
}

/** Reads the segments up to the first frame header, which states the size. */
function jpegHeader(bytes: Buffer): ImageHeader | undefined {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1] ?? 0;
    // A fill byte before a marker.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    const frame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (frame) return offset + 9 <= bytes.length ? { mediaType: "image/jpeg", width: bytes.readUInt16BE(offset + 7), height: bytes.readUInt16BE(offset + 5) } : undefined;
    offset += 2 + bytes.readUInt16BE(offset + 2);
  }
  return undefined;
}
