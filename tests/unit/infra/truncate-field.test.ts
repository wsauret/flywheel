import { describe, it, expect } from "bun:test";
import { truncateField } from "../../../src/infra/truncate-field";

describe("truncateField", () => {
  it("passes through short strings unchanged", () => {
    expect(truncateField("hello")).toBe('"hello"');
  });

  it("truncates strings exceeding 4KB byte limit", () => {
    const big = "x".repeat(8000);
    const result = truncateField(big);
    expect(Buffer.byteLength(result, "utf-8")).toBeLessThanOrEqual(4096);
  });

  it("truncates at custom byte limit", () => {
    const big = "x".repeat(200);
    const result = truncateField(big, 100);
    expect(Buffer.byteLength(result, "utf-8")).toBeLessThanOrEqual(100);
  });

  it("handles multi-byte characters without splitting mid-character", () => {
    // emoji is 4 bytes in UTF-8
    const emojis = "\u{1F600}".repeat(2000);
    const result = truncateField(emojis, 4096);
    expect(Buffer.byteLength(result, "utf-8")).toBeLessThanOrEqual(4096);
    // Should still be valid UTF-8 — no replacement characters
    expect(result).not.toContain("\uFFFD");
  });

  it("handles undefined and null", () => {
    expect(truncateField(undefined)).toBe("null");
    expect(truncateField(null)).toBe("null");
  });

  it("marks unserializable values instead of faking null", () => {
    const circular: { [key: string]: unknown } = {};
    circular.self = circular;
    expect(truncateField(circular)).toBe("<unserializable>");
  });
});

