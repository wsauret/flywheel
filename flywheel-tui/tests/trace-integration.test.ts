/**
 * End-to-end integration test for trace infrastructure.
 *
 * Wires real TraceWriter + TraceCollector + EventBus together,
 * emits a realistic sequence of FlywheelEvents, then verifies
 * the JSONL output on disk.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import * as path from "node:path";
import { tmpdir } from "node:os";

import { EventBus } from "../src/infra/event-bus";
import { createTraceWriter } from "../src/orchestration/session/trace-writer";
import { createTraceCollector } from "../src/orchestration/session/trace-collector";
import type { Span } from "../src/infra/trace-types";
import { TRACES_DIR, resolveTraceFile } from "../src/infra/paths";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "trace-integration-"));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function now(): number {
  return Date.now();
}

function readTraceLines(sessionId: string): string[] {
  const filePath = resolveTraceFile(sessionId, tempDir);
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0);
}

function readIndexEntries(): Array<{
  traceId: string;
  sessionId: string;
  workflowName: string;
  startTimeMs: number;
  endTimeMs: number;
  durationMs: number;
  status: "ok" | "error";
  spanCount: number;
  closedSpanCount: number;
}> {
  const indexPath = path.resolve(tempDir, TRACES_DIR, "index.jsonl");
  if (!existsSync(indexPath)) return [];
  return readFileSync(indexPath, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

/** Emit full happy-path workflow event sequence. */
function emitHappyPath(bus: EventBus, workflowId: string) {
  // 1. queue:initialized
  bus.emit({
    type: "queue:initialized",
    workflowId,
    stepIds: ["s1"],
    timestamp: now(),
  });

  // 2. queue:step-started
  bus.emit({
    type: "queue:step-started",
    workflowId,
    stepId: "s1",
    stepType: "work",
    stepTitle: "Implement feature",
    timestamp: now(),
  });

  // 3. engine:started
  bus.emit({
    type: "engine:started",
    workflowId,
    stepIndex: 0,
    timestamp: now(),
  });

  // 4. trace:tool-started (Read)
  bus.emit({
    type: "trace:tool-started",
    workflowId,
    toolUseId: "t1",
    toolName: "Read",
    toolInput: '{"file_path":"src/main.ts"}',
    timestamp: now(),
  });

  // 5. trace:tool-completed (Read)
  bus.emit({
    type: "trace:tool-completed",
    workflowId,
    toolUseId: "t1",
    toolOutput: "file contents...",
    isError: false,
    timestamp: now(),
  });

  // 6. trace:tool-started (Edit)
  bus.emit({
    type: "trace:tool-started",
    workflowId,
    toolUseId: "t2",
    toolName: "Edit",
    toolInput: '{"file_path":"src/main.ts","old_string":"...","new_string":"..."}',
    timestamp: now(),
  });

  // 7. trace:tool-completed (Edit)
  bus.emit({
    type: "trace:tool-completed",
    workflowId,
    toolUseId: "t2",
    toolOutput: "success",
    isError: false,
    timestamp: now(),
  });

  // 8. queue:step-completed
  bus.emit({
    type: "queue:step-completed",
    workflowId,
    stepId: "s1",
    stepType: "work",
    stepTitle: "Implement feature",
    timestamp: now(),
  });

  // 10. queue:completed
  bus.emit({
    type: "queue:completed",
    workflowId,
    stepsCompleted: 1,
    timestamp: now(),
  });
}

/** Emit error workflow event sequence (step fails). */
function emitErrorPath(bus: EventBus, workflowId: string) {
  bus.emit({
    type: "queue:initialized",
    workflowId,
    stepIds: ["s1"],
    timestamp: now(),
  });
  bus.emit({
    type: "queue:step-started",
    workflowId,
    stepId: "s1",
    stepType: "work",
    stepTitle: "Broken feature",
    timestamp: now(),
  });
  bus.emit({
    type: "engine:started",
    workflowId,
    stepIndex: 0,
    timestamp: now(),
  });
  bus.emit({
    type: "queue:step-failed",
    workflowId,
    stepId: "s1",
    stepType: "work",
    stepTitle: "Broken feature",
    reason: "agent crashed",
    timestamp: now(),
  });
  bus.emit({
    type: "queue:failed",
    workflowId,
    reason: "step failed",
    stepsCompleted: 0,
    finalStatus: "failed",
    timestamp: now(),
  });
}

// ---------------------------------------------------------------------------
// Happy path: full workflow event sequence
// ---------------------------------------------------------------------------

describe("Trace integration — happy path", () => {
  it("produces correct JSONL trace file with valid span tree", () => {
    const sessionId = "session-happy";
    const bus = new EventBus();
    const writer = createTraceWriter({
      sessionId,
      baseDir: tempDir,
      debounceMs: 0,
    });
    const collector = createTraceCollector({
      writer,
      sessionId,
      workflowName: "test-workflow",
    });
    const unsubs = collector.subscribeToEvents(bus);

    emitHappyPath(bus, "wf-happy");
    collector.finalize("ok");
    collector.dispose();
    unsubs.forEach((u) => u());

    // -----------------------------------------------------------------------
    // 1. Read JSONL lines and parse each as Span
    // -----------------------------------------------------------------------
    const lines = readTraceLines(sessionId);
    expect(lines.length).toBeGreaterThanOrEqual(5); // workflow + step + worker + 2 tool_call

    const spans: Span[] = [];
    for (const line of lines) {
      const span = JSON.parse(line) as Span;
      expect(span).not.toBeNull();
      spans.push(span);
    }

    // -----------------------------------------------------------------------
    // 2. Verify span tree hierarchy
    // -----------------------------------------------------------------------
    const workflowSpans = spans.filter((s) => s.kind === "workflow");
    const stepSpans = spans.filter((s) => s.kind === "step");
    const workerSpans = spans.filter((s) => s.kind === "worker");
    const toolSpans = spans.filter((s) => s.kind === "tool_call");

    expect(workflowSpans.length).toBe(1);
    expect(stepSpans.length).toBe(1);
    expect(workerSpans.length).toBe(1);
    expect(toolSpans.length).toBe(2);

    const wf = workflowSpans[0];
    const step = stepSpans[0];
    const worker = workerSpans[0];

    // Root has no parent
    expect(wf.parentSpanId).toBeNull();
    // Step is child of workflow
    expect(step.parentSpanId).toBe(wf.spanId);
    // Worker is child of step
    expect(worker.parentSpanId).toBe(step.spanId);
    // Tool calls are children of worker
    for (const tool of toolSpans) {
      expect(tool.parentSpanId).toBe(worker.spanId);
    }

    // -----------------------------------------------------------------------
    // 3. All spans have ok status, endTimeMs, durationMs
    // -----------------------------------------------------------------------
    for (const span of spans) {
      expect(span.status).toBe("ok");
      expect(span.endTimeMs).toBeDefined();
      expect(span.durationMs).toBeDefined();
      expect(typeof span.endTimeMs).toBe("number");
      expect(typeof span.durationMs).toBe("number");
      expect(span.durationMs).toBe(span.endTimeMs! - span.startTimeMs);
    }

    // -----------------------------------------------------------------------
    // 4. Workflow span input has stepIds and workflowName
    // -----------------------------------------------------------------------
    const wfInput = wf.input as { stepIds: string[]; workflowName: string };
    expect(wfInput.stepIds).toEqual(["s1"]);
    expect(wfInput.workflowName).toBe("test-workflow");

    // -----------------------------------------------------------------------
    // 5. Tool spans have correct toolName and toolInput
    // -----------------------------------------------------------------------
    const readTool = toolSpans.find(
      (s) => (s.input as { toolName: string }).toolName === "Read",
    );
    const editTool = toolSpans.find(
      (s) => (s.input as { toolName: string }).toolName === "Edit",
    );
    expect(readTool).toBeDefined();
    expect(editTool).toBeDefined();
    expect((readTool!.input as { toolInput: string }).toolInput).toContain(
      "src/main.ts",
    );

    // -----------------------------------------------------------------------
    // 6. Index file has 1 entry matching the trace
    // -----------------------------------------------------------------------
    const indexEntries = readIndexEntries();
    expect(indexEntries.length).toBe(1);

    const entry = indexEntries[0];
    expect(entry.sessionId).toBe(sessionId);
    expect(entry.status).toBe("ok");
    expect(entry.workflowName).toBe("test-workflow");
    expect(entry.spanCount).toBeGreaterThanOrEqual(5);
    expect(entry.closedSpanCount).toBe(entry.spanCount);
    expect(entry.durationMs).toBe(entry.endTimeMs - entry.startTimeMs);

    // All spans share the same traceId, which matches the index entry
    const traceId = spans[0].traceId;
    expect(traceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    for (const span of spans) {
      expect(span.traceId).toBe(traceId);
      expect(span.sessionId).toBe(sessionId);
    }
    expect(entry.traceId).toBe(traceId);
  });
});

// ---------------------------------------------------------------------------
// Error path: step failure propagation
// ---------------------------------------------------------------------------

describe("Trace integration — error path", () => {
  it("produces error spans and error index entry", () => {
    const sessionId = "session-error";
    const bus = new EventBus();
    const writer = createTraceWriter({
      sessionId,
      baseDir: tempDir,
      debounceMs: 0,
    });
    const collector = createTraceCollector({
      writer,
      sessionId,
      workflowName: "error-workflow",
    });
    const unsubs = collector.subscribeToEvents(bus);

    emitErrorPath(bus, "wf-error");
    collector.finalize("error");
    collector.dispose();
    unsubs.forEach((u) => u());

    const lines = readTraceLines(sessionId);
    const spans: Span[] = [];
    for (const line of lines) {
      const span = JSON.parse(line) as Span;
      expect(span).not.toBeNull();
      spans.push(span);
    }

    // Worker and step and workflow should all be error
    const wf = spans.find((s) => s.kind === "workflow")!;
    const step = spans.find((s) => s.kind === "step")!;
    const worker = spans.find((s) => s.kind === "worker")!;

    expect(wf.status).toBe("error");
    expect(step.status).toBe("error");
    expect(worker.status).toBe("error");

    // All spans should have endTimeMs/durationMs (no unclosed)
    for (const span of spans) {
      expect(span.endTimeMs).toBeDefined();
      expect(span.durationMs).toBeDefined();
    }

    // Index entry should be error
    const indexEntries = readIndexEntries();
    expect(indexEntries.length).toBe(1);
    expect(indexEntries[0].status).toBe("error");
  });
});

// ---------------------------------------------------------------------------
// Rotation: error traces survive eviction
// ---------------------------------------------------------------------------

describe("Trace integration — rotation", () => {
  it("evicts oldest ok traces while preserving error traces", () => {
    const maxTraces = 5;

    // Create maxTraces ok traces
    for (let i = 0; i < maxTraces; i++) {
      const sid = `session-ok-${i}`;
      const bus = new EventBus();
      const writer = createTraceWriter({
        sessionId: sid,
        baseDir: tempDir,
        maxTraces,
        debounceMs: 0,
      });
      const collector = createTraceCollector({
        writer,
        sessionId: sid,
        workflowName: `ok-workflow-${i}`,
      });
      const unsubs = collector.subscribeToEvents(bus);

      emitHappyPath(bus, `wf-ok-${i}`);
      collector.finalize("ok");
      collector.dispose();
      unsubs.forEach((u) => u());
    }

    // Create 1 error trace
    {
      const sid = "session-error-rot";
      const bus = new EventBus();
      const writer = createTraceWriter({
        sessionId: sid,
        baseDir: tempDir,
        maxTraces,
        debounceMs: 0,
      });
      const collector = createTraceCollector({
        writer,
        sessionId: sid,
        workflowName: "error-workflow-rot",
      });
      const unsubs = collector.subscribeToEvents(bus);

      emitErrorPath(bus, "wf-error-rot");
      collector.finalize("error");
      collector.dispose();
      unsubs.forEach((u) => u());
    }

    // Now create one more ok trace to trigger rotation
    {
      const sid = "session-ok-extra";
      const bus = new EventBus();
      const writer = createTraceWriter({
        sessionId: sid,
        baseDir: tempDir,
        maxTraces,
        debounceMs: 0,
      });
      const collector = createTraceCollector({
        writer,
        sessionId: sid,
        workflowName: "ok-workflow-extra",
      });
      const unsubs = collector.subscribeToEvents(bus);

      emitHappyPath(bus, "wf-ok-extra");
      collector.finalize("ok");
      collector.dispose();
      unsubs.forEach((u) => u());
    }

    const entries = readIndexEntries();

    // Error traces are exempt from the cap
    const errorEntries = entries.filter((e) => e.status === "error");
    expect(errorEntries.length).toBe(1);
    expect(errorEntries[0].sessionId).toBe("session-error-rot");

    // Non-error traces capped at maxTraces
    const okEntries = entries.filter((e) => e.status === "ok");
    expect(okEntries.length).toBeLessThanOrEqual(maxTraces);

    // Total = capped ok + all errors
    expect(entries.length).toBe(okEntries.length + errorEntries.length);

    // The error trace file must still exist
    const errorTraceFile = resolveTraceFile("session-error-rot", tempDir);
    expect(existsSync(errorTraceFile)).toBe(true);
  });
});
