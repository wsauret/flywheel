import { describe, it, expect } from "bun:test";
import {
  truncateField,
  type Span,
  type StepSpan,
  type WorkflowSpan,
} from "../src/infra/trace-types";

// ---------------------------------------------------------------------------
// truncateField
// ---------------------------------------------------------------------------

describe("truncateField", () => {
  it("passes through short strings unchanged", () => {
    expect(truncateField("hello")).toBe('"hello"');
  });

  it("serializes objects to JSON", () => {
    const obj = { a: 1, b: "two" };
    expect(truncateField(obj)).toBe(JSON.stringify(obj));
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
});

// ---------------------------------------------------------------------------
// Discriminated union narrowing
// ---------------------------------------------------------------------------

describe("discriminated union narrowing", () => {
  it("narrows step span input type via kind", () => {
    const span: Span = {
      spanId: "550e8400-e29b-41d4-a716-446655440000",
      traceId: "660e8400-e29b-41d4-a716-446655440000",
      parentSpanId: null,
      sessionId: "sess-1",
      startTimeMs: 1700000000000,
      status: "ok",
      error: null,
      kind: "step",
      input: { stepType: "build", stepTitle: "Build frontend" },
      output: { failureReason: null },
    };

    if (span.kind === "step") {
      // TypeScript should narrow this — access step-specific fields
      const stepSpan: StepSpan = span;
      expect(stepSpan.input.stepType).toBe("build");
      expect(stepSpan.input.stepTitle).toBe("Build frontend");
    } else {
      throw new Error("Expected kind to be step");
    }
  });

  it("narrows workflow span via kind", () => {
    const span: Span = {
      spanId: "a",
      traceId: "b",
      parentSpanId: null,
      sessionId: "s",
      startTimeMs: 0,
      status: "ok",
      error: null,
      kind: "workflow",
      input: { stepIds: ["s1"], workflowName: "test" },
      output: { stepsCompleted: 1, failureReason: null },
    };

    if (span.kind === "workflow") {
      const wf: WorkflowSpan = span;
      expect(wf.input.workflowName).toBe("test");
      expect(wf.output.stepsCompleted).toBe(1);
    } else {
      throw new Error("Expected kind to be workflow");
    }
  });
});

