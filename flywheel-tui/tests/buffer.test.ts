import { describe, it, expect } from "bun:test";
import {
  appendWithCharLimit,
  OutputBuffer,
  TRUNCATION_MARKER,
  BUFFER_LIMIT,
} from "../src/infra/output-buffer";

// ---------------------------------------------------------------------------
// appendWithCharLimit
// ---------------------------------------------------------------------------

describe("appendWithCharLimit", () => {
  it("appends content within limit without truncation", () => {
    const result = appendWithCharLimit("hello ", "world", 20);
    expect(result.content).toBe("hello world");
    expect(result.truncated).toBe(false);
  });

  it("truncates and preserves tail when limit exceeded", () => {
    // Limit must be larger than TRUNCATION_MARKER.length to fit marker + tail
    const existing = "A".repeat(50);
    const newContent = "B".repeat(50);
    const limit = 60; // combined = 100 chars > 60
    const result = appendWithCharLimit(existing, newContent, limit);

    expect(result.truncated).toBe(true);
    expect(result.content).toStartWith(TRUNCATION_MARKER);
    expect(result.content.length).toBeLessThanOrEqual(limit);
    // Tail (most recent content) should be preserved
    expect(result.content).toEndWith("B".repeat(limit - TRUNCATION_MARKER.length));
  });

  it("prepends truncation marker (includes trailing newline)", () => {
    expect(TRUNCATION_MARKER).toBe("[...truncated in memory...]\n");
    expect(TRUNCATION_MARKER.endsWith("\n")).toBe(true);
  });

  it("preserves tail content after truncation", () => {
    // Create a known scenario: limit of 50 chars
    const existing = "A".repeat(30);
    const newContent = "B".repeat(30);
    const result = appendWithCharLimit(existing, newContent, 50);

    expect(result.truncated).toBe(true);
    // The tail should be from the combined content
    expect(result.content).toStartWith(TRUNCATION_MARKER);
    // The B's (most recent) should be at the end
    expect(result.content).toEndWith("B".repeat(Math.min(30, 50 - TRUNCATION_MARKER.length)));
  });

  it("completion marker at end survives truncation", () => {
    const completionMarker = "<promise>COMPLETE</promise>";
    const existing = "X".repeat(100);
    const newContent = "Y".repeat(50) + completionMarker;
    const limit = 80;

    const result = appendWithCharLimit(existing, newContent, limit);
    expect(result.truncated).toBe(true);
    // The completion marker is at the very end of newContent, so it must survive
    expect(result.content).toEndWith(completionMarker);
  });

  it("returns combined content when exactly at limit", () => {
    const result = appendWithCharLimit("12345", "67890", 10);
    expect(result.content).toBe("1234567890");
    expect(result.truncated).toBe(false);
  });

  it("handles empty existing content", () => {
    const result = appendWithCharLimit("", "hello", 100);
    expect(result.content).toBe("hello");
    expect(result.truncated).toBe(false);
  });

  it("handles empty new content", () => {
    const result = appendWithCharLimit("hello", "", 100);
    expect(result.content).toBe("hello");
    expect(result.truncated).toBe(false);
  });

  // --- Edge cases (Gap 9) ---

  it("both empty strings returns empty content, not truncated", () => {
    const result = appendWithCharLimit("", "", 100);
    expect(result).toEqual({ content: "", truncated: false });
  });

  it("empty chunk with non-empty existing returns existing unchanged", () => {
    const result = appendWithCharLimit("a", "", 100);
    expect(result).toEqual({ content: "a", truncated: false });
  });

  it("zero charLimit returns empty content, not truncated", () => {
    const result = appendWithCharLimit("", "x", 0);
    expect(result).toEqual({ content: "", truncated: false });
  });

  it("negative charLimit returns empty content, not truncated", () => {
    const result = appendWithCharLimit("abc", "def", -5);
    expect(result).toEqual({ content: "", truncated: false });
  });

  it("limit smaller than truncation marker truncates marker to fit", () => {
    // TRUNCATION_MARKER is 29 chars: "[...truncated in memory...]\n"
    const limit = 10;
    // Force truncation: combined > limit
    const result = appendWithCharLimit("aaaa", "bbbbbbbb", limit);
    expect(result.truncated).toBe(true);
    expect(result.content.length).toBeLessThanOrEqual(limit);
    // Should be the truncation marker sliced to fit
    expect(result.content).toBe(TRUNCATION_MARKER.slice(0, limit));
  });

  it("limit exactly equal to truncation marker length returns just the marker", () => {
    const limit = TRUNCATION_MARKER.length; // 28
    // combined must exceed limit to trigger truncation
    const result = appendWithCharLimit("a".repeat(20), "b".repeat(20), limit);
    expect(result.truncated).toBe(true);
    expect(result.content).toBe(TRUNCATION_MARKER.slice(0, limit));
  });

  it("tail correctly assembled from both current and chunk when split across boundary", () => {
    // TRUNCATION_MARKER is 28 chars, keep = 6, limit = 34
    // We need combined > 34 chars. Use larger strings where tail is purely from chunk.
    // existing = "A".repeat(20), chunk = "C".repeat(20) → combined = 40 > 34
    // combinedTailStart = 40 - 6 = 34, 34 >= existing.length(20) → tail from chunk only
    // tail = chunk.slice(34-20) = chunk.slice(14) = "CCCCCC"
    const existing = "A".repeat(20);
    const chunk = "C".repeat(20);
    const keep = 6;
    const limit = TRUNCATION_MARKER.length + keep; // 28 + 6 = 34
    const result = appendWithCharLimit(existing, chunk, limit);

    expect(result.truncated).toBe(true);
    expect(result.content).toBe(TRUNCATION_MARKER + "C".repeat(6));
  });

  it("tail spans current and chunk when split at boundary", () => {
    // TRUNCATION_MARKER is 28 chars. keep = 6, limit = 34.
    // We need combined > 34 to trigger truncation.
    // existing = "A".repeat(20), chunk = "B".repeat(20) → combined = 40 chars > 34
    // keep = 6, combinedTailStart = 40 - 6 = 34
    // 34 >= existing.length(20)? yes → tail = chunk.slice(34-20) = chunk.slice(14) = "BBBBBB"
    // That doesn't span the boundary. We need combinedTailStart < existing.length.
    // existing = "A".repeat(30), chunk = "B".repeat(10) → combined = 40
    // combinedTailStart = 40 - 6 = 34, 34 >= 30? yes → tail from chunk only
    // Need: combinedTailStart < existing.length
    // existing = "A".repeat(36), chunk = "B".repeat(4) → combined = 40
    // combinedTailStart = 40 - 6 = 34, 34 < 36? yes!
    // tailFromExisting = existing.slice(34) = "AA" (2 chars)
    // remaining = 6 - 2 = 4
    // tailFromChunk = chunk.slice(-4) = "BBBB"
    // tail = "AA" + "BBBB" = "AABBBB" (6 chars) ← spans the boundary!
    const existing = "A".repeat(36);
    const chunk = "B".repeat(4);
    const keep = 6;
    const limit = TRUNCATION_MARKER.length + keep; // 28 + 6 = 34
    const result = appendWithCharLimit(existing, chunk, limit);

    expect(result.truncated).toBe(true);
    expect(result.content).toBe(TRUNCATION_MARKER + "AABBBB");
  });
});

// ---------------------------------------------------------------------------
// OutputBuffer
// ---------------------------------------------------------------------------

describe("OutputBuffer", () => {
  it("stores content", () => {
    const buf = new OutputBuffer();
    buf.append("hello world");
    expect(buf.getState().content).toBe("hello world");
  });

  it("reports truncated: false when content fits", () => {
    const buf = new OutputBuffer();
    buf.append("small content");
    expect(buf.getState().truncated).toBe(false);
  });

  it("truncates at buffer limit", () => {
    const buf = new OutputBuffer();
    buf.append("Z".repeat(2_100_000));
    expect(buf.getState().truncated).toBe(true);
  });

  it("buffer limit is 2M", () => {
    expect(BUFFER_LIMIT).toBe(2_000_000);
  });

  it("accumulates content across multiple appends", () => {
    const buf = new OutputBuffer();
    buf.append("hello ");
    buf.append("world");
    expect(buf.getState().content).toBe("hello world");
  });

  it("truncation marker is prepended when truncated", () => {
    const buf = new OutputBuffer();
    buf.append("Z".repeat(2_100_000));
    const state = buf.getState();
    expect(state.truncated).toBe(true);
    expect(state.content).toStartWith(TRUNCATION_MARKER);
  });
});
