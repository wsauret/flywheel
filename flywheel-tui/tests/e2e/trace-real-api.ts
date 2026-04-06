#!/usr/bin/env bun
/**
 * E2E test with REAL Claude API calls.
 * Spawns a real Claude Code subprocess, traces the output, verifies trace data.
 *
 * Usage: bun run tests/e2e/trace-real-api.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { EventBus, createFlywheelEmitter } from "../../src/infra/event-bus";
import { createTraceWriter } from "../../src/orchestration/session/trace-writer";
import { createTraceCollector } from "../../src/orchestration/session/trace-collector";
import { createTraceEventHandler } from "../../src/orchestration/engines/subprocess/trace-event-handler";
import { NDJSONParser } from "../../src/orchestration/engines/subprocess/ndjson-parser";
import { parseSpanLine, type Span } from "../../src/infra/trace-types";
import { TRACES_DIR, resolveTraceFile } from "../../src/infra/paths";
import { randomUUID } from "node:crypto";

const baseDir = fs.mkdtempSync(path.join(import.meta.dir, ".trace-real-"));
const sessionId = randomUUID();
const workflowName = "real-api-smoke-test";

console.log(`\n=== REAL API Trace Collection E2E Test ===`);
console.log(`Base dir: ${baseDir}`);
console.log(`Session ID: ${sessionId}\n`);

// --- Setup tracing infrastructure ---
const bus = new EventBus();
const emitter = createFlywheelEmitter(bus);
const workflowIdRef = { current: randomUUID() };

const writer = createTraceWriter({ sessionId, baseDir, maxTraces: 10 });
const collector = createTraceCollector({ writer, sessionId, workflowName });
const unsubs = collector.subscribeToEvents(bus);

const traceHandler = createTraceEventHandler({ emitter, workflowIdRef });

// Emit workflow start events
bus.emit({
  type: "queue:initialized",
  workflowId: workflowIdRef.current,
  stepIds: ["step-1"],
  timestamp: new Date().toISOString(),
});

bus.emit({
  type: "queue:step-started",
  workflowId: workflowIdRef.current,
  stepId: "step-1",
  stepType: "work",
  stepTitle: "Quick API test",
  timestamp: new Date().toISOString(),
});

bus.emit({
  type: "subprocess:spawned",
  workflowId: workflowIdRef.current,
  stepIndex: 0,
  timestamp: new Date().toISOString(),
});

// --- Spawn real Claude Code process ---
console.log("Spawning Claude Code with a simple prompt...");

const ndjsonParser = new NDJSONParser();
ndjsonParser.onEvent = (event) => {
  // Feed to trace handler (converts tool_use/tool_result to trace events)
  traceHandler.handleEvent(event);
};

const proc = Bun.spawn(
  ["claude", "--output-format", "stream-json", "-p", "Read the file package.json in the current directory and tell me the project name. Use the Read tool."],
  {
    cwd: path.resolve(import.meta.dir, "../.."),  // project root for tool access
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env },
  },
);

// Read stdout and feed to NDJSON parser
const reader = proc.stdout.getReader();
const decoder = new TextDecoder();

try {
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const text = decoder.decode(value, { stream: true });
    ndjsonParser.write(text);
  }
} catch (err) {
  console.error("Error reading stdout:", err);
}

const exitCode = await proc.exited;
console.log(`Claude Code exited with code: ${exitCode}\n`);

// Flush remaining NDJSON
ndjsonParser.flush();

// --- Close workflow ---
if (exitCode === 0) {
  bus.emit({
    type: "subprocess:completed",
    workflowId: workflowIdRef.current,
    result: { output: "done", exitCode: 0, handoffPath: "" } as any,
    timestamp: new Date().toISOString(),
  });
  bus.emit({
    type: "queue:step-completed",
    workflowId: workflowIdRef.current,
    stepId: "step-1",
    stepType: "work",
    stepTitle: "Quick API test",
    timestamp: new Date().toISOString(),
  });
  bus.emit({
    type: "queue:completed",
    workflowId: workflowIdRef.current,
    stepsCompleted: 1,
    timestamp: new Date().toISOString(),
  });
} else {
  bus.emit({
    type: "subprocess:failed",
    workflowId: workflowIdRef.current,
    failure: { message: `exit code ${exitCode}`, type: "process_error" } as any,
    timestamp: new Date().toISOString(),
  });
  bus.emit({
    type: "queue:step-failed",
    workflowId: workflowIdRef.current,
    stepId: "step-1",
    stepType: "work",
    stepTitle: "Quick API test",
    reason: `exit code ${exitCode}`,
    timestamp: new Date().toISOString(),
  });
  bus.emit({
    type: "queue:failed",
    workflowId: workflowIdRef.current,
    reason: `exit code ${exitCode}`,
    stepsCompleted: 0,
    timestamp: new Date().toISOString(),
  });
}

// Finalize
collector.finalize(exitCode === 0 ? "ok" : "error");
writer.flush();
unsubs.forEach(u => u());
writer.dispose();

// --- Verify ---
console.log("--- Verifying trace output ---\n");

const traceFile = resolveTraceFile(sessionId, baseDir);
const indexFile = path.resolve(baseDir, TRACES_DIR, "index.jsonl");

if (!fs.existsSync(traceFile)) {
  console.error("FAIL: Trace file missing");
  process.exit(1);
}
console.log(`✓ Trace file exists`);

if (!fs.existsSync(indexFile)) {
  console.error("FAIL: Index file missing");
  process.exit(1);
}
console.log(`✓ Index file exists`);

const lines = fs.readFileSync(traceFile, "utf-8").split("\n").filter(l => l.trim());
const spans: Span[] = [];

for (const line of lines) {
  const span = parseSpanLine(line);
  if (span) spans.push(span);
  else console.warn("WARNING: Unparseable line");
}

console.log(`✓ ${spans.length} spans parsed`);

// Count by kind
const kinds: Record<string, number> = {};
for (const s of spans) {
  kinds[s.kind] = (kinds[s.kind] || 0) + 1;
}
console.log(`\nSpan counts:`, kinds);

// Verify minimum structure
if (!kinds.workflow || kinds.workflow < 1) { console.error("FAIL: No workflow span"); process.exit(1); }
if (!kinds.step || kinds.step < 1) { console.error("FAIL: No step span"); process.exit(1); }
if (!kinds.worker || kinds.worker < 1) { console.error("FAIL: No worker span"); process.exit(1); }
console.log(`✓ Minimum span structure present`);

// Verify all spans closed
let unclosed = 0;
for (const s of spans) {
  if (!s.endTimeMs) unclosed++;
}
if (unclosed > 0) {
  console.error(`FAIL: ${unclosed} unclosed spans`);
  process.exit(1);
}
console.log(`✓ All spans closed with timing`);

// Verify hierarchy
const workflowSpan = spans.find(s => s.kind === "workflow");
if (workflowSpan?.parentSpanId !== null) {
  console.error("FAIL: Workflow span should have no parent");
  process.exit(1);
}
console.log(`✓ Hierarchy valid`);

// Print trace tree
console.log(`\n--- Trace Tree ---\n`);
function printTree(spans: Span[], parentId: string | null, indent: string) {
  for (const span of spans.filter(s => s.parentSpanId === parentId)) {
    const kind = span.kind.padEnd(10);
    const dur = `${span.durationMs}ms`.padStart(8);
    const status = span.status;
    let detail = "";
    if (span.kind === "tool_call") detail = ` tool="${(span as any).input?.toolName}"`;
    if (span.kind === "subagent") detail = ` type="${(span as any).input?.agentType}"`;
    if (span.kind === "step") detail = ` title="${(span as any).input?.stepTitle}"`;
    console.log(`${indent}${kind} ${dur} ${status}${detail}`);
    printTree(spans, span.spanId, indent + "  ");
  }
}
printTree(spans, null, "");

// Print raw JSONL for inspection
console.log(`\n--- Raw JSONL (first 5 lines) ---\n`);
for (let i = 0; i < Math.min(5, lines.length); i++) {
  const parsed = JSON.parse(lines[i]);
  console.log(JSON.stringify(parsed, null, 2).slice(0, 200) + "...");
  console.log();
}

// Cleanup
fs.rmSync(baseDir, { recursive: true, force: true });

console.log(`\n=== REAL API TEST PASSED ===`);
console.log(`Total spans: ${spans.length}`);
console.log(`Span kinds: ${JSON.stringify(kinds)}`);
console.log();
