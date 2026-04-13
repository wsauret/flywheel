import { describe, it, expect } from "bun:test";
import { OutputBuffer } from "../src/infra/output-buffer";

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
    const buf = new OutputBuffer();
    // Just under 2M should not truncate
    buf.append("A".repeat(1_999_999));
    expect(buf.getState().truncated).toBe(false);
    // Pushing over 2M triggers truncation
    buf.append("B".repeat(100_000));
    expect(buf.getState().truncated).toBe(true);
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
    expect(state.content).toStartWith("[...truncated in memory...]\n");
  });
});
