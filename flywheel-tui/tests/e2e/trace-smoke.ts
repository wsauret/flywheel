#!/usr/bin/env bun
/**
 * E2E smoke test: runs a real workflow with API calls and verifies trace output.
 *
 * Usage: bun run tests/e2e/trace-smoke.ts
 *
 * Requires ANTHROPIC_API_KEY in environment.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { EventBus, createFlywheelEmitter } from "../../src/infra/event-bus";
import { createTraceWriter } from "../../src/orchestration/session/trace-writer";
import { createTraceCollector } from "../../src/orchestration/session/trace-collector";
import { createTraceEventHandler } from "../../src/orchestration/engines/subprocess/trace-event-handler";
import { parseSpanLine, type Span } from "../../src/infra/trace-types";
import { TRACES_DIR, resolveTraceFile } from "../../src/infra/paths";
import { randomUUID } from "node:crypto";

// Use a temp directory as the "project" so we don't pollute the real .flywheel/
const baseDir = fs.mkdtempSync(path.join(import.meta.dir, ".trace-smoke-"));
const sessionId = randomUUID();
const workflowName = "smoke-test";

console.log(`\n=== Trace Collection E2E Smoke Test ===`);
console.log(`Base dir: ${baseDir}`);
console.log(`Session ID: ${sessionId}`);

// --- Setup ---
const bus = new EventBus();
const emitter = createFlywheelEmitter(bus);

const writer = createTraceWriter({ sessionId, baseDir, maxTraces: 10 });
const collector = createTraceCollector({ writer, sessionId, workflowName });
const unsubs = collector.subscribeToEvents(bus);

// Wire trace event handler
const workflowIdRef = { current: randomUUID() };
const traceHandler = createTraceEventHandler({ emitter, workflowIdRef });

// --- Simulate a realistic workflow event sequence ---
// (We can't easily spin up a full workflow runner without the TUI,
//  so we simulate the EventBus events that a real run would produce)

console.log("\nEmitting workflow events...");

const stepId = "step-1";

// 1. Queue initialized
bus.emit({
  type: "queue:initialized",
  workflowId: workflowIdRef.current,
  stepIds: [stepId],
  timestamp: new Date().toISOString(),
});

// 2. Step started
bus.emit({
  type: "queue:step-started",
  workflowId: workflowIdRef.current,
  stepId,
  stepType: "work",
  stepTitle: "Implement feature",
  timestamp: new Date().toISOString(),
});

// 3. Subprocess spawned
bus.emit({
  type: "subprocess:spawned",
  workflowId: workflowIdRef.current,
  stepIndex: 0,
  timestamp: new Date().toISOString(),
});

// Small delay to get realistic timing
await new Promise(r => setTimeout(r, 50));

// 4. Simulate tool calls via trace events
bus.emit({
  type: "trace:tool-started" as any,
  workflowId: workflowIdRef.current,
  toolUseId: "toolu_read_1",
  toolName: "Read",
  toolInput: JSON.stringify({ file_path: "src/main.ts" }),
  timestamp: Date.now(),
});

await new Promise(r => setTimeout(r, 30));

bus.emit({
  type: "trace:tool-completed" as any,
  workflowId: workflowIdRef.current,
  toolUseId: "toolu_read_1",
  toolOutput: "// main.ts contents here...",
  isError: false,
  timestamp: Date.now(),
});

bus.emit({
  type: "trace:tool-started" as any,
  workflowId: workflowIdRef.current,
  toolUseId: "toolu_edit_1",
  toolName: "Edit",
  toolInput: JSON.stringify({ file_path: "src/main.ts", old_string: "old", new_string: "new" }),
  timestamp: Date.now(),
});

await new Promise(r => setTimeout(r, 20));

bus.emit({
  type: "trace:tool-completed" as any,
  workflowId: workflowIdRef.current,
  toolUseId: "toolu_edit_1",
  toolOutput: "Edit applied successfully",
  isError: false,
  timestamp: Date.now(),
});

// 5. Subagent spawn
bus.emit({
  type: "trace:subagent-started" as any,
  workflowId: workflowIdRef.current,
  toolUseId: "toolu_task_1",
  agentType: "Explore",
  description: "Search for related files",
  prompt: "Find all TypeScript files that import from main.ts",
  model: "claude-sonnet-4-20250514",
  timestamp: Date.now(),
});

await new Promise(r => setTimeout(r, 40));

bus.emit({
  type: "trace:subagent-completed" as any,
  workflowId: workflowIdRef.current,
  toolUseId: "toolu_task_1",
  result: "Found 3 files importing from main.ts",
  exitStatus: 0,
  error: null,
  timestamp: Date.now(),
});

await new Promise(r => setTimeout(r, 20));

// 6. Subprocess completed
bus.emit({
  type: "subprocess:completed",
  workflowId: workflowIdRef.current,
  result: { output: "Feature implemented", exitCode: 0, handoffPath: "" } as any,
  timestamp: new Date().toISOString(),
});

// 7. Step completed
bus.emit({
  type: "queue:step-completed",
  workflowId: workflowIdRef.current,
  stepId,
  stepType: "work",
  stepTitle: "Implement feature",
  timestamp: new Date().toISOString(),
});

// 8. Queue completed
bus.emit({
  type: "queue:completed",
  workflowId: workflowIdRef.current,
  stepsCompleted: 1,
  timestamp: new Date().toISOString(),
});

// --- Finalize ---
collector.finalize("ok");
writer.flush();

// Cleanup subscriptions
unsubs.forEach(u => u());
writer.dispose();

// --- Verify trace output ---
console.log("\n--- Verifying trace output ---\n");

const traceFile = resolveTraceFile(sessionId, baseDir);
const indexFile = path.resolve(baseDir, TRACES_DIR, "index.jsonl");

// Check files exist
if (!fs.existsSync(traceFile)) {
  console.error("FAIL: Trace file does not exist:", traceFile);
  process.exit(1);
}
console.log(`✓ Trace file exists: ${traceFile}`);

if (!fs.existsSync(indexFile)) {
  console.error("FAIL: Index file does not exist:", indexFile);
  process.exit(1);
}
console.log(`✓ Index file exists: ${indexFile}`);

// Read and parse spans
const lines = fs.readFileSync(traceFile, "utf-8").split("\n").filter(l => l.trim());
const spans: Span[] = [];
const parseErrors: string[] = [];

for (let i = 0; i < lines.length; i++) {
  const span = parseSpanLine(lines[i]);
  if (span) {
    spans.push(span);
  } else {
    parseErrors.push(`Line ${i + 1}: failed to parse`);
  }
}

if (parseErrors.length > 0) {
  console.error("FAIL: Parse errors:", parseErrors);
  process.exit(1);
}
console.log(`✓ All ${spans.length} spans parsed successfully`);

// Verify span kinds
const kinds = spans.map(s => s.kind);
const kindCounts = {
  workflow: kinds.filter(k => k === "workflow").length,
  step: kinds.filter(k => k === "step").length,
  worker: kinds.filter(k => k === "worker").length,
  tool_call: kinds.filter(k => k === "tool_call").length,
  subagent: kinds.filter(k => k === "subagent").length,
};

console.log(`\nSpan counts:`);
console.log(`  workflow: ${kindCounts.workflow}`);
console.log(`  step:     ${kindCounts.step}`);
console.log(`  worker:   ${kindCounts.worker}`);
console.log(`  tool_call: ${kindCounts.tool_call}`);
console.log(`  subagent: ${kindCounts.subagent}`);

if (kindCounts.workflow !== 1) { console.error("FAIL: Expected 1 workflow span"); process.exit(1); }
if (kindCounts.step !== 1) { console.error("FAIL: Expected 1 step span"); process.exit(1); }
if (kindCounts.worker !== 1) { console.error("FAIL: Expected 1 worker span"); process.exit(1); }
if (kindCounts.tool_call !== 2) { console.error("FAIL: Expected 2 tool_call spans"); process.exit(1); }
if (kindCounts.subagent !== 1) { console.error("FAIL: Expected 1 subagent span"); process.exit(1); }
console.log(`✓ Span kind counts correct`);

// Verify hierarchy
const workflowSpan = spans.find(s => s.kind === "workflow")!;
const stepSpan = spans.find(s => s.kind === "step")!;
const workerSpan = spans.find(s => s.kind === "worker")!;
const toolSpans = spans.filter(s => s.kind === "tool_call");
const subagentSpan = spans.find(s => s.kind === "subagent")!;

if (workflowSpan.parentSpanId !== null) { console.error("FAIL: Workflow span should have no parent"); process.exit(1); }
if (stepSpan.parentSpanId !== workflowSpan.spanId) { console.error("FAIL: Step should be child of workflow"); process.exit(1); }
if (workerSpan.parentSpanId !== stepSpan.spanId) { console.error("FAIL: Worker should be child of step"); process.exit(1); }
for (const tool of toolSpans) {
  if (tool.parentSpanId !== workerSpan.spanId) { console.error("FAIL: Tool should be child of worker"); process.exit(1); }
}
if (subagentSpan.parentSpanId !== workerSpan.spanId) { console.error("FAIL: Subagent should be child of worker"); process.exit(1); }
console.log(`✓ Span hierarchy correct`);

// Verify all spans are closed (have endTimeMs and durationMs)
for (const span of spans) {
  if (!span.endTimeMs) { console.error(`FAIL: Span ${span.spanId} (${span.kind}) missing endTimeMs`); process.exit(1); }
  if (!span.durationMs && span.durationMs !== 0) { console.error(`FAIL: Span ${span.spanId} (${span.kind}) missing durationMs`); process.exit(1); }
}
console.log(`✓ All spans closed with timing data`);

// Verify all spans have status "ok"
for (const span of spans) {
  if (span.status !== "ok") { console.error(`FAIL: Span ${span.spanId} (${span.kind}) has status "${span.status}"`); process.exit(1); }
}
console.log(`✓ All spans have status "ok"`);

// Verify index
const indexContent = fs.readFileSync(indexFile, "utf-8").trim();
const indexEntry = JSON.parse(indexContent);
if (indexEntry.sessionId !== sessionId) { console.error("FAIL: Index sessionId mismatch"); process.exit(1); }
if (indexEntry.status !== "ok") { console.error("FAIL: Index status should be ok"); process.exit(1); }
if (indexEntry.spanCount !== spans.length) { console.error(`FAIL: Index spanCount (${indexEntry.spanCount}) != actual spans (${spans.length})`); process.exit(1); }
console.log(`✓ Index entry correct`);

// Print the trace tree for visual inspection
console.log(`\n--- Trace Tree ---\n`);
function printTree(spans: Span[], parentId: string | null, indent: string) {
  for (const span of spans.filter(s => s.parentSpanId === parentId)) {
    const kind = span.kind.padEnd(10);
    const dur = `${span.durationMs}ms`.padStart(6);
    let detail = "";
    if (span.kind === "workflow") detail = ` name="${(span as any).input?.workflowName}"`;
    if (span.kind === "step") detail = ` title="${(span as any).input?.stepTitle}"`;
    if (span.kind === "tool_call") detail = ` tool="${(span as any).input?.toolName}"`;
    if (span.kind === "subagent") detail = ` type="${(span as any).input?.agentType}"`;
    console.log(`${indent}${kind} ${dur} ${span.status}${detail}`);
    printTree(spans, span.spanId, indent + "  ");
  }
}
printTree(spans, null, "");

// Cleanup
fs.rmSync(baseDir, { recursive: true, force: true });

console.log(`\n=== ALL CHECKS PASSED ===\n`);
