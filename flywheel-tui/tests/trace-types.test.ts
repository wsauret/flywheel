import { describe, it, expect } from "bun:test";
import {
  SpanSchema,
  truncateField,
  parseSpanLine,
  type Span,
  type StepSpan,
  type WorkflowSpan,
  type WorkerSpan,
  type SubagentSpan,
  type ToolCallSpan,
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
// SpanSchema validation
// ---------------------------------------------------------------------------

describe("SpanSchema", () => {
  const baseFields = {
    spanId: "550e8400-e29b-41d4-a716-446655440000",
    traceId: "660e8400-e29b-41d4-a716-446655440000",
    parentSpanId: null,
    sessionId: "sess-1",
    startTimeMs: 1700000000000,
    endTimeMs: 1700000001000,
    durationMs: 1000,
    status: "ok" as const,
    error: null,
  };

  it("validates a correct workflow span", () => {
    const span = {
      ...baseFields,
      kind: "workflow",
      input: { stepIds: ["s1", "s2"], workflowName: "deploy" },
      output: { stepsCompleted: 2, failureReason: null },
    };
    const result = SpanSchema.safeParse(span);
    expect(result.success).toBe(true);
  });

  it("validates a correct step span", () => {
    const span = {
      ...baseFields,
      kind: "step",
      input: { stepType: "build", stepTitle: "Build frontend" },
      output: { failureReason: null },
    };
    const result = SpanSchema.safeParse(span);
    expect(result.success).toBe(true);
  });

  it("validates a correct worker span", () => {
    const span = {
      ...baseFields,
      kind: "worker",
      input: { stepIndex: 0 },
      output: { resultSummary: "done", failureReason: null },
    };
    const result = SpanSchema.safeParse(span);
    expect(result.success).toBe(true);
  });

  it("validates a worker span with ndjsonEventCount", () => {
    const span = {
      ...baseFields,
      kind: "worker",
      input: { stepIndex: 0 },
      output: { resultSummary: "done", failureReason: null, ndjsonEventCount: 42 },
    };
    const result = SpanSchema.safeParse(span);
    expect(result.success).toBe(true);
    if (result.success) {
      const worker = result.data as WorkerSpan;
      expect(worker.output.ndjsonEventCount).toBe(42);
    }
  });

  it("validates a worker span without ndjsonEventCount (backward compat)", () => {
    const span = {
      ...baseFields,
      kind: "worker",
      input: { stepIndex: 0 },
      output: { resultSummary: "done", failureReason: null },
    };
    const result = SpanSchema.safeParse(span);
    expect(result.success).toBe(true);
    if (result.success) {
      const worker = result.data as WorkerSpan;
      expect(worker.output.ndjsonEventCount).toBeUndefined();
    }
  });

  it("validates a correct subagent span", () => {
    const span = {
      ...baseFields,
      kind: "subagent",
      input: {
        agentType: "claude",
        description: "Fix bug",
        prompt: "Fix the null pointer",
        model: "claude-sonnet-4-20250514",
      },
      output: { result: "Fixed", exitStatus: 0, error: null },
    };
    const result = SpanSchema.safeParse(span);
    expect(result.success).toBe(true);
  });

  it("validates a correct tool_call span", () => {
    const span = {
      ...baseFields,
      kind: "tool_call",
      input: { toolName: "read_file", toolInput: '{"path":"src/index.ts"}' },
      output: { toolOutput: "file contents...", isError: false },
    };
    const result = SpanSchema.safeParse(span);
    expect(result.success).toBe(true);
  });

  it("rejects span with missing required field (spanId)", () => {
    const { spanId, ...noId } = {
      ...baseFields,
      kind: "step",
      input: { stepType: "build", stepTitle: "Build" },
      output: { failureReason: null },
    };
    const result = SpanSchema.safeParse(noId);
    expect(result.success).toBe(false);
  });

  it("rejects span with invalid kind", () => {
    const span = {
      ...baseFields,
      kind: "invalid_kind",
      input: {},
      output: {},
    };
    const result = SpanSchema.safeParse(span);
    expect(result.success).toBe(false);
  });

  it("rejects span with wrong input shape for kind", () => {
    const span = {
      ...baseFields,
      kind: "step",
      input: { toolName: "wrong" }, // step expects stepType + stepTitle
      output: { failureReason: null },
    };
    const result = SpanSchema.safeParse(span);
    expect(result.success).toBe(false);
  });

  it("accepts span with error field populated", () => {
    const span = {
      ...baseFields,
      status: "error" as const,
      error: { message: "Something went wrong", code: "ERR_TIMEOUT" },
      kind: "step",
      input: { stepType: "build", stepTitle: "Build" },
      output: { failureReason: "timeout" },
    };
    const result = SpanSchema.safeParse(span);
    expect(result.success).toBe(true);
  });

  it("accepts span with optional endTimeMs/durationMs omitted", () => {
    const { endTimeMs, durationMs, ...partial } = baseFields;
    const span = {
      ...partial,
      kind: "step",
      input: { stepType: "build", stepTitle: "Build" },
      output: { failureReason: null },
    };
    const result = SpanSchema.safeParse(span);
    expect(result.success).toBe(true);
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

// ---------------------------------------------------------------------------
// parseSpanLine
// ---------------------------------------------------------------------------

describe("parseSpanLine", () => {
  const validSpan = {
    spanId: "550e8400-e29b-41d4-a716-446655440000",
    traceId: "660e8400-e29b-41d4-a716-446655440000",
    parentSpanId: null,
    sessionId: "sess-1",
    startTimeMs: 1700000000000,
    endTimeMs: 1700000001000,
    durationMs: 1000,
    status: "ok",
    error: null,
    kind: "step",
    input: { stepType: "build", stepTitle: "Build frontend" },
    output: { failureReason: null },
  };

  it("parses a valid JSONL line", () => {
    const line = JSON.stringify(validSpan);
    const result = parseSpanLine(line);
    expect(result).not.toBeNull();
    expect(result!.kind).toBe("step");
    expect(result!.spanId).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("returns null for malformed JSON", () => {
    const result = parseSpanLine("{broken json");
    expect(result).toBeNull();
  });

  it("returns null for empty string", () => {
    const result = parseSpanLine("");
    expect(result).toBeNull();
  });

  it("returns null for valid JSON that fails schema validation", () => {
    const result = parseSpanLine(JSON.stringify({ kind: "step", bad: true }));
    expect(result).toBeNull();
  });

  it("returns null for truncated line", () => {
    const line = JSON.stringify(validSpan);
    const truncated = line.slice(0, Math.floor(line.length / 2));
    const result = parseSpanLine(truncated);
    expect(result).toBeNull();
  });

  it("does not throw on any input", () => {
    const inputs = [
      "",
      "null",
      "42",
      "[]",
      "{broken",
      JSON.stringify({ kind: "unknown" }),
      "x".repeat(10000),
    ];
    for (const input of inputs) {
      expect(() => parseSpanLine(input)).not.toThrow();
    }
  });
});
