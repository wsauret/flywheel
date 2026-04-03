import { describe, expect, it } from "bun:test";
import { DoomLoopDetector, extractToolSignature } from "../../src/harness/doom-loop.js";

// ═══════════════════════════════════════════════════════════════════════════
// Tool Signature
// ═══════════════════════════════════════════════════════════════════════════

describe("extractToolSignature", () => {
  it("produces a stable fingerprint from name and sorted keys", () => {
    const sig1 = extractToolSignature("read", { path: "file.txt", encoding: "utf-8" });
    const sig2 = extractToolSignature("read", { encoding: "utf-8", path: "file.txt" });
    expect(sig1).toBe(sig2);
  });

  it("produces different signatures for different inputs", () => {
    const sig1 = extractToolSignature("read", { path: "a.txt" });
    const sig2 = extractToolSignature("read", { path: "b.txt" });
    expect(sig1).not.toBe(sig2);
  });

  it("produces different signatures for different tool names", () => {
    const sig1 = extractToolSignature("read", { path: "a.txt" });
    const sig2 = extractToolSignature("write", { path: "a.txt" });
    expect(sig1).not.toBe(sig2);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Single-Call Repetition (AAA)
// ═══════════════════════════════════════════════════════════════════════════

describe("single-call repetition", () => {
  it("detects AAA pattern at default threshold (3)", () => {
    const detector = new DoomLoopDetector();
    const sig = extractToolSignature("read", { path: "file.txt" });

    detector.recordToolCall("read", sig);
    detector.recordToolCall("read", sig);
    expect(detector.isLooping()).toBe(false);

    detector.recordToolCall("read", sig);
    expect(detector.isLooping()).toBe(true);
    expect(detector.getWarning()).toContain("Doom loop detected");
    expect(detector.getWarning()).toContain("same tool call");
  });

  it("does not trigger below threshold", () => {
    const detector = new DoomLoopDetector();
    const sig = extractToolSignature("read", { path: "file.txt" });

    detector.recordToolCall("read", sig);
    detector.recordToolCall("read", sig);
    expect(detector.isLooping()).toBe(false);
    expect(detector.getWarning()).toBeUndefined();
  });

  it("does not trigger for different calls", () => {
    const detector = new DoomLoopDetector();
    detector.recordToolCall("read", extractToolSignature("read", { path: "a.txt" }));
    detector.recordToolCall("read", extractToolSignature("read", { path: "b.txt" }));
    detector.recordToolCall("read", extractToolSignature("read", { path: "c.txt" }));
    expect(detector.isLooping()).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Multi-Call Cycle (ABCABC)
// ═══════════════════════════════════════════════════════════════════════════

describe("multi-call cycle", () => {
  it("detects ABABAB pattern (length-2 cycle)", () => {
    const detector = new DoomLoopDetector();
    const sigA = extractToolSignature("read", { path: "a.txt" });
    const sigB = extractToolSignature("write", { path: "b.txt" });

    // AB AB AB
    detector.recordToolCall("read", sigA);
    detector.recordToolCall("write", sigB);
    detector.recordToolCall("read", sigA);
    detector.recordToolCall("write", sigB);
    detector.recordToolCall("read", sigA);
    detector.recordToolCall("write", sigB);

    expect(detector.isLooping()).toBe(true);
    expect(detector.getWarning()).toContain("sequence of 2 tool calls");
  });

  it("detects ABCABCABC pattern (length-3 cycle)", () => {
    const detector = new DoomLoopDetector();
    const sigA = extractToolSignature("read", { path: "a.txt" });
    const sigB = extractToolSignature("write", { path: "b.txt" });
    const sigC = extractToolSignature("grep", { pattern: "test" });

    for (let i = 0; i < 3; i++) {
      detector.recordToolCall("read", sigA);
      detector.recordToolCall("write", sigB);
      detector.recordToolCall("grep", sigC);
    }

    expect(detector.isLooping()).toBe(true);
    expect(detector.getWarning()).toContain("sequence of 3 tool calls");
  });

  it("does not detect incomplete cycle repetitions", () => {
    const detector = new DoomLoopDetector();
    const sigA = extractToolSignature("read", { path: "a.txt" });
    const sigB = extractToolSignature("write", { path: "b.txt" });

    // AB AB A — only 2 full repetitions, need 3
    detector.recordToolCall("read", sigA);
    detector.recordToolCall("write", sigB);
    detector.recordToolCall("read", sigA);
    detector.recordToolCall("write", sigB);
    detector.recordToolCall("read", sigA);

    expect(detector.isLooping()).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Reset
// ═══════════════════════════════════════════════════════════════════════════

describe("reset", () => {
  it("clears history so looping state is reset", () => {
    const detector = new DoomLoopDetector();
    const sig = extractToolSignature("read", { path: "file.txt" });

    detector.recordToolCall("read", sig);
    detector.recordToolCall("read", sig);
    detector.recordToolCall("read", sig);
    expect(detector.isLooping()).toBe(true);

    detector.reset();
    expect(detector.isLooping()).toBe(false);

    // After reset, need to accumulate again
    detector.recordToolCall("read", sig);
    expect(detector.isLooping()).toBe(false);
  });
});
