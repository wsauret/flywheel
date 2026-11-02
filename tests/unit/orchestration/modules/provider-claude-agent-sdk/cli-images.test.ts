import { describe, expect, test } from "bun:test";
import type { Base64ImageSource } from "@anthropic-ai/sdk/resources/messages.js";
import { cliRewritesImage } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/cli-images.js";

/** The start of an image file: enough for its format and size, as the CLI's decoder reads them. */
function png(width: number, height: number): Buffer {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "latin1");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

function gif(width: number, height: number): Buffer {
  const header = Buffer.alloc(13);
  header.write("GIF89a", 0, "latin1");
  header.writeUInt16LE(width, 6);
  header.writeUInt16LE(height, 8);
  return header;
}

/** A JPEG with an APP0 segment and a fill byte before its baseline frame header. */
function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Buffer.from("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  const frame = Buffer.alloc(11);
  frame.writeUInt16BE(0xffc0, 0);
  frame.writeUInt16BE(11, 2);
  frame[4] = 8;
  frame.writeUInt16BE(height, 5);
  frame.writeUInt16BE(width, 7);
  frame[9] = 1;
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, Buffer.from([0xff]), frame]);
}

function webp(chunk: "VP8 " | "VP8L" | "VP8X", width: number, height: number): Buffer {
  const header = Buffer.alloc(30);
  header.write("RIFF", 0, "latin1");
  header.write("WEBP", 8, "latin1");
  header.write(chunk, 12, "latin1");
  if (chunk === "VP8 ") {
    header.writeUInt16LE(width, 26);
    header.writeUInt16LE(height, 28);
  } else if (chunk === "VP8L") {
    const bits = (width - 1) | ((height - 1) << 14);
    header[20] = 0x2f;
    header.writeUInt32LE(bits, 21);
  } else {
    header.writeUIntLE(width - 1, 24, 3);
    header.writeUIntLE(height - 1, 27, 3);
  }
  return header;
}

const source = (bytes: Buffer, mediaType: Base64ImageSource["media_type"] = "image/png"): Base64ImageSource => ({ type: "base64", media_type: mediaType, data: bytes.toString("base64") });

describe("the CLI's rewrite of a pushed image", () => {
  test("keeps an image whose format, media type, size, and sides are within the CLI's limits", () => {
    expect(cliRewritesImage(source(png(2000, 2000)))).toBe(false);
    expect(cliRewritesImage(source(gif(1, 1), "image/gif"))).toBe(false);
    expect(cliRewritesImage(source(jpeg(1500, 1500), "image/jpeg"))).toBe(false);
    expect(cliRewritesImage(source(webp("VP8 ", 640, 480), "image/webp"))).toBe(false);
    expect(cliRewritesImage(source(webp("VP8L", 2000, 1), "image/webp"))).toBe(false);
    expect(cliRewritesImage(source(webp("VP8X", 1290, 2000), "image/webp"))).toBe(false);
    expect(cliRewritesImage(source(Buffer.concat([png(10, 10), Buffer.alloc(512_000 - 33)])))).toBe(false);
    expect(cliRewritesImage({ type: "url", url: "https://example.invalid/a.png" })).toBe(false);
  });

  test("rewrites an image with a side above 2,000 pixels, more than 512,000 bytes, or bytes that the CLI would re-encode or relabel", () => {
    expect(cliRewritesImage(source(png(2001, 10)))).toBe(true);
    expect(cliRewritesImage(source(jpeg(1290, 2796), "image/jpeg"))).toBe(true);
    expect(cliRewritesImage(source(gif(10, 3000), "image/gif"))).toBe(true);
    expect(cliRewritesImage(source(webp("VP8L", 2001, 5), "image/webp"))).toBe(true);
    expect(cliRewritesImage(source(webp("VP8X", 10, 16_000), "image/webp"))).toBe(true);
    expect(cliRewritesImage(source(Buffer.concat([png(10, 10), Buffer.alloc(512_001 - 33)])))).toBe(true);
    // The CLI names the media type from the bytes, and turns a format it does not send into a PNG.
    expect(cliRewritesImage(source(png(10, 10), "image/jpeg"))).toBe(true);
    expect(cliRewritesImage(source(Buffer.from("BM bitmap bytes")))).toBe(true);
    // The CLI decodes the base64 and encodes it again.
    expect(cliRewritesImage({ ...source(png(10, 10)), data: `${png(10, 10).toString("base64")}\n` })).toBe(true);
  });

  test("rewrites an image whose size it cannot read, so the bridge never pushes an image that the CLI could change", () => {
    expect(cliRewritesImage(source(png(10, 10).subarray(0, 20)))).toBe(true);
    expect(cliRewritesImage(source(png(0, 10)))).toBe(true);
    expect(cliRewritesImage(source(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), "image/jpeg"))).toBe(true);
    expect(cliRewritesImage(source(Buffer.from([0xff, 0xd8, 0x00, 0x00, 0x00, 0x00]), "image/jpeg"))).toBe(true);
  });
});
