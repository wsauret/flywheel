/**
 * Tests for TraceWriter — persists spans to JSONL files and maintains a trace index.
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

import { createTraceWriter, type TraceWriter, type TraceIndexEntry } from "../src/orchestration/session/trace-writer";
import type { Span, ToolCallSpan, WorkflowSpan } from "../src/infra/trace-types";
import { parseSpanLine } from "../src/infra/trace-types";
import { TRACES_DIR } from "../src/infra/paths";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TMP_ROOT = path.join(
  os.tmpdir(),
  `flywheel-trace-writer-test-${process.pid}-${Date.now()}`,
);

let tmpDir: string;

function makeTmpDir(): string {
  const dir = path.join(TMP_ROOT, crypto.randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeSpan(overrides: Partial<ToolCallSpan> = {}): ToolCallSpan {
  return {
    spanId: crypto.randomUUID(),
    traceId: "trace-1",
    parentSpanId: null,
    sessionId: "session-1",
    startTimeMs: Date.now(),
    endTimeMs: Date.now() + 100,
    durationMs: 100,
    status: "ok",
    error: null,
    kind: "tool_call",
    input: { toolName: "read", toolInput: '{"path":"a.ts"}' },
    output: { toolOutput: "file contents", isError: false },
    ...overrides,
  };
}

function makeWorkflowSpan(overrides: Partial<WorkflowSpan> = {}): WorkflowSpan {
  return {
    spanId: crypto.randomUUID(),
    traceId: "trace-1",
    parentSpanId: null,
    sessionId: "session-1",
    startTimeMs: Date.now(),
    endTimeMs: Date.now() + 1000,
    durationMs: 1000,
    status: "ok",
    error: null,
    kind: "workflow",
    input: { stepIds: ["s1"], workflowName: "test-wf" },
    output: { stepsCompleted: 1, failureReason: null },
    ...overrides,
  };
}

function makeIndexEntry(overrides: Partial<TraceIndexEntry> = {}): TraceIndexEntry {
  return {
    traceId: "trace-1",
    sessionId: "session-1",
    workflowName: "test-wf",
    startTimeMs: 1000,
    endTimeMs: 2000,
    durationMs: 1000,
    status: "ok",
    spanCount: 3,
    closedSpanCount: 3,
    ...overrides,
  };
}

function traceFilePath(sessionId: string, baseDir: string): string {
  return path.resolve(baseDir, TRACES_DIR, `${sessionId}.jsonl`);
}

function indexFilePath(baseDir: string): string {
  return path.resolve(baseDir, TRACES_DIR, "index.jsonl");
}

function readLines(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, "utf-8");
  return content.split("\n").filter((line) => line.trim().length > 0);
}

function readIndex(baseDir: string): TraceIndexEntry[] {
  const lines = readLines(indexFilePath(baseDir));
  return lines.map((line) => JSON.parse(line));
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  tmpDir = makeTmpDir();
});

afterEach(() => {
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

// ---------------------------------------------------------------------------
// JSONL append
// ---------------------------------------------------------------------------

describe("TraceWriter — JSONL append", () => {
  it("writes multiple spans, each on its own line", () => {
    const writer = createTraceWriter({ sessionId: "s1", baseDir: tmpDir });
    const span1 = makeSpan({ spanId: "span-1", sessionId: "s1" });
    const span2 = makeSpan({ spanId: "span-2", sessionId: "s1" });

    writer.writeSpan(span1);
    writer.writeSpan(span2);
    writer.flush();

    const lines = readLines(traceFilePath("s1", tmpDir));
    expect(lines.length).toBe(2);

    const parsed1 = JSON.parse(lines[0]);
    const parsed2 = JSON.parse(lines[1]);
    expect(parsed1.spanId).toBe("span-1");
    expect(parsed2.spanId).toBe("span-2");
  });

  it("each line is valid JSON and parseable as a Span", () => {
    const writer = createTraceWriter({ sessionId: "s1", baseDir: tmpDir });
    const span = makeSpan({ sessionId: "s1" });
    writer.writeSpan(span);
    writer.flush();

    const lines = readLines(traceFilePath("s1", tmpDir));
    expect(lines.length).toBe(1);

    const parsed = parseSpanLine(lines[0]);
    expect(parsed).not.toBeNull();
    expect(parsed!.kind).toBe("tool_call");
  });

  it("creates traces directory if it does not exist", () => {
    const freshDir = makeTmpDir();
    const tracesPath = path.resolve(freshDir, TRACES_DIR);
    expect(fs.existsSync(tracesPath)).toBe(false);

    const writer = createTraceWriter({ sessionId: "s1", baseDir: freshDir });
    writer.writeSpan(makeSpan({ sessionId: "s1" }));
    writer.flush();

    expect(fs.existsSync(tracesPath)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Index update
// ---------------------------------------------------------------------------

describe("TraceWriter — index update", () => {
  it("writes index entry only on finalizeTrace, not per span", () => {
    const writer = createTraceWriter({ sessionId: "s1", baseDir: tmpDir });
    writer.writeSpan(makeSpan({ sessionId: "s1" }));
    writer.flush();

    // No index yet — only spans written
    const indexBefore = readIndex(tmpDir);
    expect(indexBefore.length).toBe(0);

    // Now finalize
    writer.finalizeTrace(makeIndexEntry({ sessionId: "s1" }));

    const indexAfter = readIndex(tmpDir);
    expect(indexAfter.length).toBe(1);
    expect(indexAfter[0].traceId).toBe("trace-1");
    expect(indexAfter[0].status).toBe("ok");
  });

  it("index entry contains all required fields", () => {
    const writer = createTraceWriter({ sessionId: "s1", baseDir: tmpDir });
    const entry = makeIndexEntry({
      traceId: "t-abc",
      sessionId: "s1",
      workflowName: "deploy",
      startTimeMs: 5000,
      endTimeMs: 8000,
      durationMs: 3000,
      status: "error",
      spanCount: 10,
      closedSpanCount: 8,
    });
    writer.finalizeTrace(entry);

    const index = readIndex(tmpDir);
    expect(index.length).toBe(1);
    expect(index[0]).toEqual(entry);
  });

  it("multiple finalizeTrace calls append to index", () => {
    const w1 = createTraceWriter({ sessionId: "s1", baseDir: tmpDir });
    w1.finalizeTrace(makeIndexEntry({ traceId: "t1", sessionId: "s1" }));
    w1.dispose();

    const w2 = createTraceWriter({ sessionId: "s2", baseDir: tmpDir });
    w2.finalizeTrace(makeIndexEntry({ traceId: "t2", sessionId: "s2" }));
    w2.dispose();

    const index = readIndex(tmpDir);
    expect(index.length).toBe(2);
    expect(index[0].traceId).toBe("t1");
    expect(index[1].traceId).toBe("t2");
  });
});

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

describe("TraceWriter — rotation", () => {
  it("evicts oldest non-error traces when max_traces exceeded", () => {
    const maxTraces = 3;

    // Write 3 traces
    for (let i = 1; i <= 3; i++) {
      const w = createTraceWriter({ sessionId: `s${i}`, baseDir: tmpDir, maxTraces });
      w.writeSpan(makeSpan({ sessionId: `s${i}`, traceId: `t${i}` }));
      w.flush();
      w.finalizeTrace(makeIndexEntry({ traceId: `t${i}`, sessionId: `s${i}`, startTimeMs: i * 1000, status: "ok" }));
      w.dispose();
    }

    // Write a 4th — should evict the oldest (t1)
    const w4 = createTraceWriter({ sessionId: "s4", baseDir: tmpDir, maxTraces });
    w4.writeSpan(makeSpan({ sessionId: "s4", traceId: "t4" }));
    w4.flush();
    w4.finalizeTrace(makeIndexEntry({ traceId: "t4", sessionId: "s4", startTimeMs: 4000, status: "ok" }));
    w4.dispose();

    const index = readIndex(tmpDir);
    expect(index.length).toBe(3);
    const traceIds = index.map((e) => e.traceId);
    expect(traceIds).not.toContain("t1");
    expect(traceIds).toContain("t2");
    expect(traceIds).toContain("t3");
    expect(traceIds).toContain("t4");

    // Trace file for t1 should be deleted
    expect(fs.existsSync(traceFilePath("s1", tmpDir))).toBe(false);
  });

  it("preserves error traces during eviction", () => {
    const maxTraces = 3;

    // t1 = error (oldest), t2 = ok, t3 = ok
    const w1 = createTraceWriter({ sessionId: "s1", baseDir: tmpDir, maxTraces });
    w1.writeSpan(makeSpan({ sessionId: "s1", traceId: "t1" }));
    w1.flush();
    w1.finalizeTrace(makeIndexEntry({ traceId: "t1", sessionId: "s1", startTimeMs: 1000, status: "error" }));
    w1.dispose();

    const w2 = createTraceWriter({ sessionId: "s2", baseDir: tmpDir, maxTraces });
    w2.writeSpan(makeSpan({ sessionId: "s2", traceId: "t2" }));
    w2.flush();
    w2.finalizeTrace(makeIndexEntry({ traceId: "t2", sessionId: "s2", startTimeMs: 2000, status: "ok" }));
    w2.dispose();

    const w3 = createTraceWriter({ sessionId: "s3", baseDir: tmpDir, maxTraces });
    w3.writeSpan(makeSpan({ sessionId: "s3", traceId: "t3" }));
    w3.flush();
    w3.finalizeTrace(makeIndexEntry({ traceId: "t3", sessionId: "s3", startTimeMs: 3000, status: "ok" }));
    w3.dispose();

    // Write t4 — should evict t2 (oldest non-error), NOT t1 (error)
    const w4 = createTraceWriter({ sessionId: "s4", baseDir: tmpDir, maxTraces });
    w4.writeSpan(makeSpan({ sessionId: "s4", traceId: "t4" }));
    w4.flush();
    w4.finalizeTrace(makeIndexEntry({ traceId: "t4", sessionId: "s4", startTimeMs: 4000, status: "ok" }));
    w4.dispose();

    const index = readIndex(tmpDir);
    expect(index.length).toBe(3);
    const traceIds = index.map((e) => e.traceId);
    expect(traceIds).toContain("t1"); // error preserved
    expect(traceIds).not.toContain("t2"); // oldest non-error evicted
    expect(traceIds).toContain("t3");
    expect(traceIds).toContain("t4");

    // Error trace file still exists
    expect(fs.existsSync(traceFilePath("s1", tmpDir))).toBe(true);
    // Evicted trace file deleted
    expect(fs.existsSync(traceFilePath("s2", tmpDir))).toBe(false);
  });

  it("index references never point to deleted files", () => {
    const maxTraces = 2;

    for (let i = 1; i <= 4; i++) {
      const w = createTraceWriter({ sessionId: `s${i}`, baseDir: tmpDir, maxTraces });
      w.writeSpan(makeSpan({ sessionId: `s${i}`, traceId: `t${i}` }));
      w.flush();
      w.finalizeTrace(makeIndexEntry({ traceId: `t${i}`, sessionId: `s${i}`, startTimeMs: i * 1000 }));
      w.dispose();
    }

    const index = readIndex(tmpDir);
    for (const entry of index) {
      const filePath = traceFilePath(entry.sessionId, tmpDir);
      expect(fs.existsSync(filePath)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Flush
// ---------------------------------------------------------------------------

describe("TraceWriter — flush", () => {
  it("flush writes all buffered spans", () => {
    const writer = createTraceWriter({ sessionId: "s1", baseDir: tmpDir });

    writer.writeSpan(makeSpan({ spanId: "a", sessionId: "s1" }));
    writer.writeSpan(makeSpan({ spanId: "b", sessionId: "s1" }));
    writer.writeSpan(makeSpan({ spanId: "c", sessionId: "s1" }));

    // Before flush, file may or may not have content (depending on buffer)
    writer.flush();

    const lines = readLines(traceFilePath("s1", tmpDir));
    expect(lines.length).toBe(3);
  });

  it("dispose calls flush and closes fd", () => {
    const writer = createTraceWriter({ sessionId: "s1", baseDir: tmpDir });
    writer.writeSpan(makeSpan({ spanId: "x", sessionId: "s1" }));
    writer.dispose();

    const lines = readLines(traceFilePath("s1", tmpDir));
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]).spanId).toBe("x");
  });

  it("writeSpan after dispose is a no-op", () => {
    const writer = createTraceWriter({ sessionId: "s1", baseDir: tmpDir });
    writer.writeSpan(makeSpan({ spanId: "before", sessionId: "s1" }));
    writer.dispose();

    // This should not throw or write
    writer.writeSpan(makeSpan({ spanId: "after", sessionId: "s1" }));

    const lines = readLines(traceFilePath("s1", tmpDir));
    expect(lines.length).toBe(1);
    expect(JSON.parse(lines[0]).spanId).toBe("before");
  });
});

// ---------------------------------------------------------------------------
// Crash safety
// ---------------------------------------------------------------------------

describe("TraceWriter — crash safety", () => {
  it("partially written last line does not corrupt earlier lines", () => {
    const writer = createTraceWriter({ sessionId: "s1", baseDir: tmpDir });
    writer.writeSpan(makeSpan({ spanId: "good-1", sessionId: "s1" }));
    writer.writeSpan(makeSpan({ spanId: "good-2", sessionId: "s1" }));
    writer.flush();

    // Simulate a partial write by appending garbage to the file
    const filePath = traceFilePath("s1", tmpDir);
    fs.appendFileSync(filePath, '{"spanId":"trunca');

    // Read back — earlier lines should still be valid
    const rawContent = fs.readFileSync(filePath, "utf-8");
    const allLines = rawContent.split("\n").filter((l) => l.trim().length > 0);
    expect(allLines.length).toBe(3); // 2 good + 1 partial

    // First two lines parse correctly
    const parsed1 = parseSpanLine(allLines[0]);
    const parsed2 = parseSpanLine(allLines[1]);
    expect(parsed1).not.toBeNull();
    expect(parsed2).not.toBeNull();
    expect(parsed1!.spanId).toBe("good-1");
    expect(parsed2!.spanId).toBe("good-2");

    // Partial line returns null (not a crash)
    const parsed3 = parseSpanLine(allLines[2]);
    expect(parsed3).toBeNull();
  });
});
