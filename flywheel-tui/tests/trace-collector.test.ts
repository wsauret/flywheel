/**
 * Tests for TraceCollector — builds span trees from EventBus events and
 * writes completed spans via TraceWriter.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import * as crypto from "node:crypto";

import { EventBus } from "../src/infra/event-bus";
import { truncateField } from "../src/infra/trace-types";
import type { Span } from "../src/infra/trace-types";
import type { TraceWriter, TraceIndexEntry } from "../src/orchestration/session/trace-writer";
import { createTraceCollector, type TraceCollector } from "../src/orchestration/session/trace-collector";

// ---------------------------------------------------------------------------
// In-memory TraceWriter for testing
// ---------------------------------------------------------------------------

interface InMemoryWriter extends TraceWriter {
  spans: Span[];
  indexEntries: TraceIndexEntry[];
  flushed: boolean;
  disposed: boolean;
}

function createInMemoryWriter(): InMemoryWriter {
  const writer: InMemoryWriter = {
    spans: [],
    indexEntries: [],
    flushed: false,
    disposed: false,
    writeSpan(span: Span) {
      writer.spans.push(span);
    },
    finalizeTrace(summary: TraceIndexEntry) {
      writer.indexEntries.push(summary);
    },
    flush() {
      writer.flushed = true;
    },
    dispose() {
      writer.disposed = true;
    },
  };
  return writer;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function now(): number {
  return Date.now();
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let writer: InMemoryWriter;
let collector: TraceCollector;

beforeEach(() => {
  writer = createInMemoryWriter();
  collector = createTraceCollector({
    writer,
    sessionId: "test-session",
    workflowName: "test-workflow",
  });
});

// ---------------------------------------------------------------------------
// Span tree construction
// ---------------------------------------------------------------------------

describe("TraceCollector — span tree construction", () => {
  it("startSpan + endSpan produces a completed span with correct fields", () => {
    const spanId = collector.startSpan("step", "my-step", { stepType: "implement", stepTitle: "Do stuff" });
    collector.endSpan(spanId, { failureReason: null }, "ok");

    expect(writer.spans.length).toBe(1);
    const span = writer.spans[0];
    expect(span.spanId).toBe(spanId);
    expect(span.kind).toBe("step");
    expect(span.status).toBe("ok");
    expect(span.error).toBeNull();
    expect(span.sessionId).toBe("test-session");
    expect(span.traceId).toBe(collector.getTraceId());
  });

  it("parentSpanId is automatically linked via span stack", () => {
    const parentId = collector.startSpan("workflow", "root", { stepIds: ["s1"], workflowName: "wf" });
    const childId = collector.startSpan("step", "child", { stepType: "plan", stepTitle: "Plan" });
    const grandchildId = collector.startSpan("worker", "grandchild", { stepIndex: 0 });

    // End in reverse order
    collector.endSpan(grandchildId, { resultSummary: "done", failureReason: null }, "ok");
    collector.endSpan(childId, { failureReason: null }, "ok");
    collector.endSpan(parentId, { stepsCompleted: 1, failureReason: null }, "ok");

    expect(writer.spans.length).toBe(3);

    const grandchildSpan = writer.spans.find((s) => s.spanId === grandchildId)!;
    const childSpan = writer.spans.find((s) => s.spanId === childId)!;
    const parentSpan = writer.spans.find((s) => s.spanId === parentId)!;

    expect(parentSpan.parentSpanId).toBeNull();
    expect(childSpan.parentSpanId).toBe(parentId);
    expect(grandchildSpan.parentSpanId).toBe(childId);
  });

  it("root span has null parentSpanId", () => {
    const spanId = collector.startSpan("workflow", "root", { stepIds: [], workflowName: "wf" });
    collector.endSpan(spanId, { stepsCompleted: 0, failureReason: null }, "ok");

    const span = writer.spans[0];
    expect(span.parentSpanId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

describe("TraceCollector — timing", () => {
  it("durationMs is computed correctly from startTimeMs and endTimeMs", () => {
    const spanId = collector.startSpan("step", "timed", { stepType: "test", stepTitle: "T" });

    // Small delay to ensure non-zero duration
    const start = Date.now();
    while (Date.now() - start < 5) {
      // busy wait
    }

    collector.endSpan(spanId, { failureReason: null }, "ok");

    const span = writer.spans[0];
    expect(span.startTimeMs).toBeDefined();
    expect(span.endTimeMs).toBeDefined();
    expect(span.durationMs).toBeDefined();
    expect(span.durationMs).toBe(span.endTimeMs! - span.startTimeMs);
    expect(span.durationMs!).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// traceId
// ---------------------------------------------------------------------------

describe("TraceCollector — traceId", () => {
  it("traceId is a valid UUID", () => {
    const traceId = collector.getTraceId();
    // UUID v4 pattern
    expect(traceId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it("traceId is consistent across all spans in a trace", () => {
    const id1 = collector.startSpan("workflow", "root", { stepIds: [], workflowName: "wf" });
    const id2 = collector.startSpan("step", "child", { stepType: "a", stepTitle: "A" });
    collector.endSpan(id2, { failureReason: null }, "ok");
    collector.endSpan(id1, { stepsCompleted: 1, failureReason: null }, "ok");

    const traceId = collector.getTraceId();
    for (const span of writer.spans) {
      expect(span.traceId).toBe(traceId);
    }
  });

  it("different collectors have different traceIds", () => {
    const writer2 = createInMemoryWriter();
    const collector2 = createTraceCollector({
      writer: writer2,
      sessionId: "test-session-2",
      workflowName: "test-workflow",
    });

    expect(collector.getTraceId()).not.toBe(collector2.getTraceId());
  });
});

// ---------------------------------------------------------------------------
// recordSpan — auto-timed wrapper
// ---------------------------------------------------------------------------

describe("TraceCollector — recordSpan", () => {
  it("executes the function and returns its result", () => {
    const result = collector.recordSpan("tool_call", "my-tool", { toolName: "read", toolInput: "{}" }, () => {
      return 42;
    });
    expect(result).toBe(42);
  });

  it("writes a completed span with ok status on success", () => {
    collector.recordSpan("tool_call", "my-tool", { toolName: "read", toolInput: "{}" }, () => "done");

    expect(writer.spans.length).toBe(1);
    const span = writer.spans[0];
    expect(span.status).toBe("ok");
    expect(span.kind).toBe("tool_call");
  });

  it("writes a completed span with error status on throw", () => {
    expect(() => {
      collector.recordSpan("tool_call", "bad-tool", { toolName: "write", toolInput: "{}" }, () => {
        throw new Error("boom");
      });
    }).toThrow("boom");

    expect(writer.spans.length).toBe(1);
    const span = writer.spans[0];
    expect(span.status).toBe("error");
    expect(span.error).toEqual({ message: "boom" });
  });

  it("respects parent span stack", () => {
    const parentId = collector.startSpan("step", "parent", { stepType: "a", stepTitle: "A" });

    collector.recordSpan("tool_call", "child-tool", { toolName: "x", toolInput: "{}" }, () => "ok");

    collector.endSpan(parentId, { failureReason: null }, "ok");

    const childSpan = writer.spans.find((s) => s.kind === "tool_call")!;
    expect(childSpan.parentSpanId).toBe(parentId);
  });
});

// ---------------------------------------------------------------------------
// Input/output truncation
// ---------------------------------------------------------------------------

describe("TraceCollector — truncation", () => {
  it("truncates input values > 4KB before writing", () => {
    const bigInput = { stepType: "x".repeat(8000), stepTitle: "title" };
    const spanId = collector.startSpan("step", "big-input", bigInput);
    collector.endSpan(spanId, { failureReason: null }, "ok");

    const span = writer.spans[0];
    // The truncated input, when serialized, should be significantly smaller than the original
    const originalBytes = Buffer.from(JSON.stringify(bigInput), "utf-8").length;
    const inputJson = JSON.stringify(span.input);
    const inputBytes = Buffer.from(inputJson, "utf-8").length;
    expect(originalBytes).toBeGreaterThan(4096);
    expect(inputBytes).toBeLessThan(originalBytes);
    // truncateField caps at 4096 bytes; re-serialization may add minor overhead (quotes)
    expect(inputBytes).toBeLessThanOrEqual(4096 + 10);
  });

  it("truncates output values > 4KB before writing", () => {
    const spanId = collector.startSpan("step", "big-output", { stepType: "t", stepTitle: "T" });
    const bigOutput = { failureReason: "x".repeat(8000) };
    collector.endSpan(spanId, bigOutput, "ok");

    const span = writer.spans[0];
    const originalBytes = Buffer.from(JSON.stringify(bigOutput), "utf-8").length;
    const outputJson = JSON.stringify(span.output);
    const outputBytes = Buffer.from(outputJson, "utf-8").length;
    expect(originalBytes).toBeGreaterThan(4096);
    expect(outputBytes).toBeLessThan(originalBytes);
    // truncateField caps at 4096 bytes; re-serialization may add minor overhead (quotes)
    expect(outputBytes).toBeLessThanOrEqual(4096 + 10);
  });

  it("small values pass through unchanged", () => {
    const input = { stepType: "plan", stepTitle: "Plan things" };
    const spanId = collector.startSpan("step", "small", input);
    const output = { failureReason: null };
    collector.endSpan(spanId, output, "ok");

    const span = writer.spans[0] as any;
    expect(span.input).toEqual(input);
    expect(span.output).toEqual(output);
  });
});

// ---------------------------------------------------------------------------
// EventBus integration — subscribeToEvents
// ---------------------------------------------------------------------------

describe("TraceCollector — EventBus integration", () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
    collector.subscribeToEvents(bus);
  });

  it("queue:initialized opens a workflow span", () => {
    bus.emit({
      type: "queue:initialized",
      workflowId: "wf-1",
      stepIds: ["s1", "s2"],
      timestamp: now(),
    });

    // Span is open, not yet written — finalize to check
    collector.finalize("ok");

    const workflowSpan = writer.spans.find((s) => s.kind === "workflow");
    expect(workflowSpan).toBeDefined();
    expect((workflowSpan as any).input.stepIds).toEqual(["s1", "s2"]);
    expect((workflowSpan as any).input.workflowName).toBe("test-workflow");
  });

  it("queue:completed closes the workflow span with ok status", () => {
    bus.emit({
      type: "queue:initialized",
      workflowId: "wf-1",
      stepIds: ["s1"],
      timestamp: now(),
    });
    bus.emit({
      type: "queue:completed",
      workflowId: "wf-1",
      stepsCompleted: 1,
      timestamp: now(),
    });

    const workflowSpan = writer.spans.find((s) => s.kind === "workflow");
    expect(workflowSpan).toBeDefined();
    expect(workflowSpan!.status).toBe("ok");
    expect((workflowSpan as any).output.stepsCompleted).toBe(1);
    expect((workflowSpan as any).output.failureReason).toBeNull();
  });

  it("queue:failed closes the workflow span with error status", () => {
    bus.emit({
      type: "queue:initialized",
      workflowId: "wf-1",
      stepIds: ["s1"],
      timestamp: now(),
    });
    bus.emit({
      type: "queue:failed",
      workflowId: "wf-1",
      reason: "budget exhausted",
      stepsCompleted: 0,
      timestamp: now(),
    });

    const workflowSpan = writer.spans.find((s) => s.kind === "workflow");
    expect(workflowSpan).toBeDefined();
    expect(workflowSpan!.status).toBe("error");
    expect(workflowSpan!.error).toEqual({ message: "budget exhausted" });
    expect((workflowSpan as any).output.failureReason).toBe("budget exhausted");
  });

  it("queue:step-started / queue:step-completed produces step span as child of workflow", () => {
    bus.emit({
      type: "queue:initialized",
      workflowId: "wf-1",
      stepIds: ["s1"],
      timestamp: now(),
    });
    bus.emit({
      type: "queue:step-started",
      workflowId: "wf-1",
      stepId: "s1",
      stepType: "implement",
      stepTitle: "Build feature",
      timestamp: now(),
    });
    bus.emit({
      type: "queue:step-completed",
      workflowId: "wf-1",
      stepId: "s1",
      stepType: "implement",
      stepTitle: "Build feature",
      timestamp: now(),
    });

    // Step span should be written
    const stepSpan = writer.spans.find((s) => s.kind === "step");
    expect(stepSpan).toBeDefined();
    expect(stepSpan!.status).toBe("ok");
    expect((stepSpan as any).input.stepType).toBe("implement");
    expect((stepSpan as any).input.stepTitle).toBe("Build feature");

    // Close workflow to check parent linkage
    collector.finalize("ok");
    const workflowSpan = writer.spans.find((s) => s.kind === "workflow");
    expect(stepSpan!.parentSpanId).toBe(workflowSpan!.spanId);
  });

  it("queue:step-failed closes step span with error status", () => {
    bus.emit({
      type: "queue:initialized",
      workflowId: "wf-1",
      stepIds: ["s1"],
      timestamp: now(),
    });
    bus.emit({
      type: "queue:step-started",
      workflowId: "wf-1",
      stepId: "s1",
      stepType: "plan",
      stepTitle: "Plan step",
      timestamp: now(),
    });
    bus.emit({
      type: "queue:step-failed",
      workflowId: "wf-1",
      stepId: "s1",
      stepType: "plan",
      stepTitle: "Plan step",
      reason: "agent crashed",
      timestamp: now(),
    });

    const stepSpan = writer.spans.find((s) => s.kind === "step");
    expect(stepSpan).toBeDefined();
    expect(stepSpan!.status).toBe("error");
    expect(stepSpan!.error).toEqual({ message: "agent crashed" });
    expect((stepSpan as any).output.failureReason).toBe("agent crashed");
  });

  it("subprocess:spawned / subprocess:completed produces worker span as child of step", () => {
    bus.emit({
      type: "queue:initialized",
      workflowId: "wf-1",
      stepIds: ["s1"],
      timestamp: now(),
    });
    bus.emit({
      type: "queue:step-started",
      workflowId: "wf-1",
      stepId: "s1",
      stepType: "implement",
      stepTitle: "Build",
      timestamp: now(),
    });
    bus.emit({
      type: "subprocess:spawned",
      workflowId: "wf-1",
      stepIndex: 0,
      timestamp: now(),
    });
    bus.emit({
      type: "subprocess:completed",
      workflowId: "wf-1",
      result: {
        output: "done",
        exitCode: 0,
        truncated: false,
        durationMs: 500,
        handoffPath: "/tmp/handoff",
      },
      timestamp: now(),
    });

    const workerSpan = writer.spans.find((s) => s.kind === "worker");
    expect(workerSpan).toBeDefined();
    expect(workerSpan!.status).toBe("ok");
    expect((workerSpan as any).input.stepIndex).toBe(0);

    // Worker should be child of step
    const stepSpans = writer.spans.filter((s) => s.kind === "step");
    // Step is still open, so check via finalize
    collector.finalize("ok");
    const stepSpan = writer.spans.find((s) => s.kind === "step");
    expect(workerSpan!.parentSpanId).toBe(stepSpan!.spanId);
  });

  it("subprocess:failed closes worker span with error status", () => {
    bus.emit({
      type: "queue:initialized",
      workflowId: "wf-1",
      stepIds: ["s1"],
      timestamp: now(),
    });
    bus.emit({
      type: "queue:step-started",
      workflowId: "wf-1",
      stepId: "s1",
      stepType: "implement",
      stepTitle: "Build",
      timestamp: now(),
    });
    bus.emit({
      type: "subprocess:spawned",
      workflowId: "wf-1",
      stepIndex: 0,
      timestamp: now(),
    });
    bus.emit({
      type: "subprocess:failed",
      workflowId: "wf-1",
      failure: { kind: "transient", message: "timeout" },
      timestamp: now(),
    });

    const workerSpan = writer.spans.find((s) => s.kind === "worker");
    expect(workerSpan).toBeDefined();
    expect(workerSpan!.status).toBe("error");
    expect(workerSpan!.error).toEqual({ message: "timeout" });
    expect((workerSpan as any).output.failureReason).toBe("timeout");
  });

  it("subscribeToEvents returns unsubscribe functions", () => {
    // Already subscribed in beforeEach, create a fresh one
    const bus2 = new EventBus();
    const writer2 = createInMemoryWriter();
    const collector2 = createTraceCollector({
      writer: writer2,
      sessionId: "s2",
      workflowName: "wf",
    });
    const unsubs = collector2.subscribeToEvents(bus2);

    expect(unsubs.length).toBeGreaterThan(0);

    // Unsubscribe all
    for (const unsub of unsubs) {
      unsub();
    }

    // Events should no longer create spans
    bus2.emit({
      type: "queue:initialized",
      workflowId: "wf-1",
      stepIds: [],
      timestamp: now(),
    });

    collector2.finalize("ok");
    // Only the forced-close spans from finalize, no workflow span from event
    const workflowSpans = writer2.spans.filter((s) => s.kind === "workflow");
    expect(workflowSpans.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Finalize / dispose
// ---------------------------------------------------------------------------

describe("TraceCollector — finalize", () => {
  it("closes all open spans with error status on finalize", () => {
    collector.startSpan("workflow", "root", { stepIds: [], workflowName: "wf" });
    collector.startSpan("step", "open-step", { stepType: "a", stepTitle: "A" });

    collector.finalize("error");

    // Both spans should be written with error status
    expect(writer.spans.length).toBe(2);
    for (const span of writer.spans) {
      expect(span.status).toBe("error");
    }
  });

  it("finalize writes a TraceIndexEntry via finalizeTrace", () => {
    const bus = new EventBus();
    collector.subscribeToEvents(bus);

    bus.emit({
      type: "queue:initialized",
      workflowId: "wf-1",
      stepIds: ["s1"],
      timestamp: now(),
    });
    bus.emit({
      type: "queue:completed",
      workflowId: "wf-1",
      stepsCompleted: 1,
      timestamp: now(),
    });

    collector.finalize("ok");

    expect(writer.indexEntries.length).toBe(1);
    const entry = writer.indexEntries[0];
    expect(entry.traceId).toBe(collector.getTraceId());
    expect(entry.sessionId).toBe("test-session");
    expect(entry.workflowName).toBe("test-workflow");
    expect(entry.status).toBe("ok");
    expect(entry.durationMs).toBe(entry.endTimeMs - entry.startTimeMs);
  });

  it("finalize flushes the writer", () => {
    collector.finalize("ok");
    expect(writer.flushed).toBe(true);
  });

  it("dispose disposes the writer", () => {
    collector.dispose();
    expect(writer.disposed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration: full event sequence
// ---------------------------------------------------------------------------

describe("TraceCollector — integration", () => {
  it("full workflow event sequence produces correct span tree", () => {
    const bus = new EventBus();
    collector.subscribeToEvents(bus);

    // Workflow initialized
    bus.emit({
      type: "queue:initialized",
      workflowId: "wf-1",
      stepIds: ["s1", "s2"],
      timestamp: now(),
    });

    // Step 1 starts + worker + completes
    bus.emit({
      type: "queue:step-started",
      workflowId: "wf-1",
      stepId: "s1",
      stepType: "implement",
      stepTitle: "Build feature",
      timestamp: now(),
    });
    bus.emit({
      type: "subprocess:spawned",
      workflowId: "wf-1",
      stepIndex: 0,
      timestamp: now(),
    });
    bus.emit({
      type: "subprocess:completed",
      workflowId: "wf-1",
      result: {
        output: "implemented",
        exitCode: 0,
        truncated: false,
        durationMs: 1000,
        handoffPath: "/tmp/h1",
      },
      timestamp: now(),
    });
    bus.emit({
      type: "queue:step-completed",
      workflowId: "wf-1",
      stepId: "s1",
      stepType: "implement",
      stepTitle: "Build feature",
      timestamp: now(),
    });

    // Step 2 starts + worker fails + step fails
    bus.emit({
      type: "queue:step-started",
      workflowId: "wf-1",
      stepId: "s2",
      stepType: "test",
      stepTitle: "Run tests",
      timestamp: now(),
    });
    bus.emit({
      type: "subprocess:spawned",
      workflowId: "wf-1",
      stepIndex: 1,
      timestamp: now(),
    });
    bus.emit({
      type: "subprocess:failed",
      workflowId: "wf-1",
      failure: { kind: "transient", message: "test failure" },
      timestamp: now(),
    });
    bus.emit({
      type: "queue:step-failed",
      workflowId: "wf-1",
      stepId: "s2",
      stepType: "test",
      stepTitle: "Run tests",
      reason: "test failure",
      timestamp: now(),
    });

    // Workflow fails
    bus.emit({
      type: "queue:failed",
      workflowId: "wf-1",
      reason: "step failed",
      stepsCompleted: 1,
      timestamp: now(),
    });

    // Verify span tree
    expect(writer.spans.length).toBe(5); // workflow + 2 steps + 2 workers

    const workflowSpan = writer.spans.find((s) => s.kind === "workflow")!;
    const stepSpans = writer.spans.filter((s) => s.kind === "step");
    const workerSpans = writer.spans.filter((s) => s.kind === "worker");

    expect(workflowSpan.status).toBe("error");
    expect(workflowSpan.parentSpanId).toBeNull();

    // Step 1 — ok, child of workflow
    const step1 = stepSpans.find((s) => (s as any).input.stepType === "implement")!;
    expect(step1.status).toBe("ok");
    expect(step1.parentSpanId).toBe(workflowSpan.spanId);

    // Step 2 — error, child of workflow
    const step2 = stepSpans.find((s) => (s as any).input.stepType === "test")!;
    expect(step2.status).toBe("error");
    expect(step2.parentSpanId).toBe(workflowSpan.spanId);

    // Worker 1 — ok, child of step 1
    const worker1 = workerSpans.find((s) => s.status === "ok")!;
    expect(worker1.parentSpanId).toBe(step1.spanId);

    // Worker 2 — error, child of step 2
    const worker2 = workerSpans.find((s) => s.status === "error")!;
    expect(worker2.parentSpanId).toBe(step2.spanId);

    // All share the same traceId
    const traceId = collector.getTraceId();
    for (const span of writer.spans) {
      expect(span.traceId).toBe(traceId);
      expect(span.sessionId).toBe("test-session");
    }
  });
});
