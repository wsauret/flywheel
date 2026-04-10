/**
 * Tests for Phase 4: Trace Events + EventBus Wiring
 *
 * Verifies that:
 * - New trace event types flow through EventBus correctly
 * - TraceEventHandler converts NDJSONEvents → trace FlywheelEvents
 * - TraceCollector subscribes to trace events and creates correct spans
 * - End-to-end: NDJSONEvent → trace event → span in collector
 */

import { describe, it, expect, beforeEach } from "bun:test";

import { EventBus, createEmit, type EmitFn } from "../src/infra/event-bus";
import type { FlywheelEvent } from "../src/infra/events";
import type { NDJSONEvent } from "../src/orchestration/engines/subprocess/ndjson-parser";
import type { Span } from "../src/infra/trace-types";
import type { TraceWriter, TraceIndexEntry } from "../src/orchestration/session/trace-writer";
import { createTraceCollector, type TraceCollector } from "../src/orchestration/session/trace-collector";
import { createTraceEventHandler, type TraceEventHandler } from "../src/orchestration/engines/subprocess/trace-event-handler";

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

function makeToolUseNDJSON(toolName: string, toolUseId: string, input: unknown): NDJSONEvent {
  return {
    type: "assistant",
    data: {
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: toolUseId, name: toolName, input },
        ],
      },
    },
    raw: "{}",
  };
}

function makeToolResultNDJSON(toolUseId: string, content: string, isError = false): NDJSONEvent {
  return {
    type: "tool_result",
    data: {
      type: "tool_result",
      tool_use_id: toolUseId,
      content,
      is_error: isError,
    },
    raw: "{}",
  };
}

// ---------------------------------------------------------------------------
// Trace event types flow through EventBus
// ---------------------------------------------------------------------------

describe("Trace events — EventBus routing", () => {
  let bus: EventBus;
  let emit: EmitFn;

  beforeEach(() => {
    bus = new EventBus();
    emit = createEmit(bus);
  });

  it("trace:tool-started emits with correct fields", () => {
    const received: FlywheelEvent[] = [];
    bus.subscribeToType("trace:tool-started", (e) => received.push(e));

    emit("trace:tool-started", { workflowId: "wf-1", toolUseId: "toolu_123", toolName: "Read", toolInput: '{"file_path":"/foo"}' });

    expect(received).toHaveLength(1);
    const evt = received[0];
    expect(evt.type).toBe("trace:tool-started");
    if (evt.type === "trace:tool-started") {
      expect(evt.workflowId).toBe("wf-1");
      expect(evt.toolUseId).toBe("toolu_123");
      expect(evt.toolName).toBe("Read");
      expect(evt.toolInput).toBe('{"file_path":"/foo"}');
      expect(evt.timestamp).toBeTruthy();
    }
  });

  it("trace:tool-completed emits with correct fields", () => {
    const received: FlywheelEvent[] = [];
    bus.subscribeToType("trace:tool-completed", (e) => received.push(e));

    emit("trace:tool-completed", { workflowId: "wf-1", toolUseId: "toolu_123", toolOutput: "file contents", isError: false });

    expect(received).toHaveLength(1);
    const evt = received[0];
    if (evt.type === "trace:tool-completed") {
      expect(evt.toolUseId).toBe("toolu_123");
      expect(evt.toolOutput).toBe("file contents");
      expect(evt.isError).toBe(false);
    }
  });

  it("trace:subagent-started emits with correct fields", () => {
    const received: FlywheelEvent[] = [];
    bus.subscribeToType("trace:subagent-started", (e) => received.push(e));

    emit("trace:subagent-started", { workflowId: "wf-1", toolUseId: "toolu_456", agentType: "Task", description: "implement feature", prompt: "do the thing" });

    expect(received).toHaveLength(1);
    const evt = received[0];
    if (evt.type === "trace:subagent-started") {
      expect(evt.agentType).toBe("Task");
      expect(evt.description).toBe("implement feature");
      expect(evt.prompt).toBe("do the thing");
    }
  });

  it("trace:subagent-completed emits with correct fields", () => {
    const received: FlywheelEvent[] = [];
    bus.subscribeToType("trace:subagent-completed", (e) => received.push(e));

    emit("trace:subagent-completed", { workflowId: "wf-1", toolUseId: "toolu_456", result: "done", isError: false });

    expect(received).toHaveLength(1);
    const evt = received[0];
    if (evt.type === "trace:subagent-completed") {
      expect(evt.toolUseId).toBe("toolu_456");
      expect(evt.result).toBe("done");
      expect(evt.isError).toBe(false);
    }
  });

  it("typed listener only receives trace events of matching type", () => {
    const toolStarted: FlywheelEvent[] = [];
    const toolCompleted: FlywheelEvent[] = [];
    bus.subscribeToType("trace:tool-started", (e) => toolStarted.push(e));
    bus.subscribeToType("trace:tool-completed", (e) => toolCompleted.push(e));

    emit("trace:tool-started", { workflowId: "wf-1", toolUseId: "toolu_1", toolName: "Read", toolInput: "{}" });
    emit("trace:tool-completed", { workflowId: "wf-1", toolUseId: "toolu_1", toolOutput: "ok", isError: false });

    expect(toolStarted).toHaveLength(1);
    expect(toolCompleted).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// TraceEventHandler — NDJSONEvent → trace FlywheelEvent conversion
// ---------------------------------------------------------------------------

describe("TraceEventHandler", () => {
  let bus: EventBus;
  let emit: EmitFn;
  let handler: TraceEventHandler;

  beforeEach(() => {
    bus = new EventBus();
    emit = createEmit(bus);
    handler = createTraceEventHandler({ emit, workflowId: "wf-test" });
  });

  it("tool_use NDJSONEvent emits trace:tool-started", () => {
    const received: FlywheelEvent[] = [];
    bus.subscribeToType("trace:tool-started", (e) => received.push(e));

    handler.handleEvent(makeToolUseNDJSON("Read", "toolu_abc", { file_path: "/foo" }));

    expect(received).toHaveLength(1);
    if (received[0].type === "trace:tool-started") {
      expect(received[0].toolName).toBe("Read");
      expect(received[0].toolUseId).toBe("toolu_abc");
      expect(received[0].workflowId).toBe("wf-test");
    }
  });

  it("tool_result NDJSONEvent emits trace:tool-completed", () => {
    const received: FlywheelEvent[] = [];
    bus.subscribeToType("trace:tool-completed", (e) => received.push(e));

    // First emit the tool_use so handler knows about it
    handler.handleEvent(makeToolUseNDJSON("Read", "toolu_abc", {}));
    handler.handleEvent(makeToolResultNDJSON("toolu_abc", "file contents"));

    expect(received).toHaveLength(1);
    if (received[0].type === "trace:tool-completed") {
      expect(received[0].toolUseId).toBe("toolu_abc");
      expect(received[0].isError).toBe(false);
    }
  });

  it("tool_result with is_error=true emits trace:tool-completed with isError", () => {
    const received: FlywheelEvent[] = [];
    bus.subscribeToType("trace:tool-completed", (e) => received.push(e));

    handler.handleEvent(makeToolUseNDJSON("Write", "toolu_err", {}));
    handler.handleEvent(makeToolResultNDJSON("toolu_err", "permission denied", true));

    expect(received).toHaveLength(1);
    if (received[0].type === "trace:tool-completed") {
      expect(received[0].isError).toBe(true);
    }
  });

  it("Task tool_use emits trace:subagent-started instead of trace:tool-started", () => {
    const toolEvents: FlywheelEvent[] = [];
    const subagentEvents: FlywheelEvent[] = [];
    bus.subscribeToType("trace:tool-started", (e) => toolEvents.push(e));
    bus.subscribeToType("trace:subagent-started", (e) => subagentEvents.push(e));

    handler.handleEvent(makeToolUseNDJSON("Task", "toolu_sub", {
      description: "implement auth",
      prompt: "build the login page",
    }));

    expect(toolEvents).toHaveLength(0);
    expect(subagentEvents).toHaveLength(1);
    if (subagentEvents[0].type === "trace:subagent-started") {
      expect(subagentEvents[0].agentType).toBe("Task");
      expect(subagentEvents[0].description).toBe("implement auth");
    }
  });

  it("dispatch_agent tool_use emits trace:subagent-started", () => {
    const subagentEvents: FlywheelEvent[] = [];
    bus.subscribeToType("trace:subagent-started", (e) => subagentEvents.push(e));

    handler.handleEvent(makeToolUseNDJSON("dispatch_agent", "toolu_da", {
      task: "run tests",
    }));

    expect(subagentEvents).toHaveLength(1);
  });

  it("tool_result for subagent emits trace:subagent-completed", () => {
    const subagentCompleted: FlywheelEvent[] = [];
    const toolCompleted: FlywheelEvent[] = [];
    bus.subscribeToType("trace:subagent-completed", (e) => subagentCompleted.push(e));
    bus.subscribeToType("trace:tool-completed", (e) => toolCompleted.push(e));

    handler.handleEvent(makeToolUseNDJSON("Task", "toolu_sub", { description: "test" }));
    handler.handleEvent(makeToolResultNDJSON("toolu_sub", "all tests passed"));

    expect(subagentCompleted).toHaveLength(1);
    expect(toolCompleted).toHaveLength(0);
    if (subagentCompleted[0].type === "trace:subagent-completed") {
      expect(subagentCompleted[0].toolUseId).toBe("toolu_sub");
    }
  });

  it("assistant event with multiple tool_use blocks emits multiple events", () => {
    const received: FlywheelEvent[] = [];
    bus.subscribeToType("trace:tool-started", (e) => received.push(e));

    handler.handleEvent({
      type: "assistant",
      data: {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "toolu_1", name: "Read", input: {} },
            { type: "text", text: "reading..." },
            { type: "tool_use", id: "toolu_2", name: "Write", input: {} },
          ],
        },
      },
      raw: "{}",
    });

    expect(received).toHaveLength(2);
  });

  it("ignores non-assistant/non-tool_result event types", () => {
    const received: FlywheelEvent[] = [];
    bus.subscribe((e) => received.push(e));

    handler.handleEvent({ type: "system", data: { type: "system" }, raw: "{}" });
    handler.handleEvent({ type: "result", data: { type: "result" }, raw: "{}" });
    handler.handleEvent({ type: "user", data: { type: "user" }, raw: "{}" });

    expect(received).toHaveLength(0);
  });

  it("handles assistant event with no message gracefully", () => {
    const received: FlywheelEvent[] = [];
    bus.subscribe((e) => received.push(e));

    handler.handleEvent({ type: "assistant", data: { type: "assistant" }, raw: "{}" });

    expect(received).toHaveLength(0);
  });

  it("handles assistant event with non-array content gracefully", () => {
    const received: FlywheelEvent[] = [];
    bus.subscribe((e) => received.push(e));

    handler.handleEvent({
      type: "assistant",
      data: { type: "assistant", message: { content: "not an array" } },
      raw: "{}",
    });

    expect(received).toHaveLength(0);
  });

  it("uses workflowId from construction", () => {
    const received: FlywheelEvent[] = [];
    bus.subscribeToType("trace:tool-started", (e) => received.push(e));

    handler.handleEvent(makeToolUseNDJSON("Read", "toolu_x", {}));

    if (received[0].type === "trace:tool-started") {
      expect(received[0].workflowId).toBe("wf-test");
    }
  });
});

// ---------------------------------------------------------------------------
// TraceCollector — subscribes to trace events and creates spans
// ---------------------------------------------------------------------------

describe("TraceCollector — trace event subscriptions", () => {
  let bus: EventBus;
  let writer: InMemoryWriter;
  let collector: TraceCollector;

  beforeEach(() => {
    bus = new EventBus();
    writer = createInMemoryWriter();
    collector = createTraceCollector({
      writer,
      sessionId: "test-session",
      workflowName: "test-workflow",
    });
    collector.subscribeToEvents(bus);

    // Set up workflow context so spans have parents
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
  });

  it("trace:tool-started + trace:tool-completed creates a tool_call span", () => {
    bus.emit({
      type: "trace:tool-started",
      workflowId: "wf-1",
      toolUseId: "toolu_123",
      toolName: "Read",
      toolInput: '{"file_path":"/foo"}',
      timestamp: now(),
    });
    bus.emit({
      type: "trace:tool-completed",
      workflowId: "wf-1",
      toolUseId: "toolu_123",
      toolOutput: "file contents here",
      isError: false,
      timestamp: now(),
    });

    const toolSpan = writer.spans.find((s) => s.kind === "tool_call");
    expect(toolSpan).toBeDefined();
    expect(toolSpan!.status).toBe("ok");
    expect((toolSpan as any).input.toolName).toBe("Read");
    expect((toolSpan as any).input.toolInput).toBe('{"file_path":"/foo"}');
    expect((toolSpan as any).output.toolOutput).toBe("file contents here");
    expect((toolSpan as any).output.isError).toBe(false);
  });

  it("trace:tool-completed with isError creates error tool_call span", () => {
    bus.emit({
      type: "trace:tool-started",
      workflowId: "wf-1",
      toolUseId: "toolu_err",
      toolName: "Write",
      toolInput: "{}",
      timestamp: now(),
    });
    bus.emit({
      type: "trace:tool-completed",
      workflowId: "wf-1",
      toolUseId: "toolu_err",
      toolOutput: "permission denied",
      isError: true,
      timestamp: now(),
    });

    const toolSpan = writer.spans.find((s) => s.kind === "tool_call");
    expect(toolSpan).toBeDefined();
    expect(toolSpan!.status).toBe("error");
    expect(toolSpan!.error).toBeDefined();
  });

  it("trace:subagent-started + trace:subagent-completed creates a subagent span", () => {
    bus.emit({
      type: "trace:subagent-started",
      workflowId: "wf-1",
      toolUseId: "toolu_sub",
      agentType: "Task",
      description: "implement feature",
      prompt: "build it",
      timestamp: now(),
    });
    bus.emit({
      type: "trace:subagent-completed",
      workflowId: "wf-1",
      toolUseId: "toolu_sub",
      result: "feature built",
      isError: false,
      timestamp: now(),
    });

    const subagentSpan = writer.spans.find((s) => s.kind === "subagent");
    expect(subagentSpan).toBeDefined();
    expect(subagentSpan!.status).toBe("ok");
    expect((subagentSpan as any).input.agentType).toBe("Task");
    expect((subagentSpan as any).input.description).toBe("implement feature");
    expect((subagentSpan as any).output.result).toBe("feature built");
    expect((subagentSpan as any).output.exitStatus).toBe(0);
  });

  it("trace:subagent-completed with isError creates error subagent span", () => {
    bus.emit({
      type: "trace:subagent-started",
      workflowId: "wf-1",
      toolUseId: "toolu_sub_err",
      agentType: "Task",
      description: "test",
      prompt: "run tests",
      timestamp: now(),
    });
    bus.emit({
      type: "trace:subagent-completed",
      workflowId: "wf-1",
      toolUseId: "toolu_sub_err",
      result: "failed",
      isError: true,
      timestamp: now(),
    });

    const subagentSpan = writer.spans.find((s) => s.kind === "subagent");
    expect(subagentSpan).toBeDefined();
    expect(subagentSpan!.status).toBe("error");
    expect((subagentSpan as any).output.exitStatus).toBe(1);
  });

  it("tool_call span is child of worker span", () => {
    bus.emit({
      type: "trace:tool-started",
      workflowId: "wf-1",
      toolUseId: "toolu_child",
      toolName: "Grep",
      toolInput: "{}",
      timestamp: now(),
    });
    bus.emit({
      type: "trace:tool-completed",
      workflowId: "wf-1",
      toolUseId: "toolu_child",
      toolOutput: "matches",
      isError: false,
      timestamp: now(),
    });

    // Close worker via step completion
    bus.emit({
      type: "queue:step-completed",
      workflowId: "wf-1",
      stepId: "step-1",
      stepType: "work",
      stepTitle: "Test step",
      timestamp: now(),
    });

    const toolSpan = writer.spans.find((s) => s.kind === "tool_call")!;
    const workerSpan = writer.spans.find((s) => s.kind === "worker")!;
    expect(toolSpan.parentSpanId).toBe(workerSpan.spanId);
  });

  it("unmatched trace:tool-completed is ignored", () => {
    const spanCountBefore = writer.spans.length;

    bus.emit({
      type: "trace:tool-completed",
      workflowId: "wf-1",
      toolUseId: "toolu_nonexistent",
      toolOutput: "orphan",
      isError: false,
      timestamp: now(),
    });

    expect(writer.spans.length).toBe(spanCountBefore);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: NDJSONEvent → TraceEventHandler → EventBus → TraceCollector
// ---------------------------------------------------------------------------

describe("End-to-end: NDJSON → trace event → span", () => {
  let bus: EventBus;
  let emit: EmitFn;
  let handler: TraceEventHandler;
  let writer: InMemoryWriter;
  let collector: TraceCollector;

  beforeEach(() => {
    bus = new EventBus();
    emit = createEmit(bus);
    writer = createInMemoryWriter();
    collector = createTraceCollector({
      writer,
      sessionId: "e2e-session",
      workflowName: "e2e-workflow",
    });
    collector.subscribeToEvents(bus);

    handler = createTraceEventHandler({ emit, workflowId: "wf-e2e" });

    // Set up workflow context
    bus.emit({ type: "queue:initialized", workflowId: "wf-e2e", stepIds: ["s1"], timestamp: now() });
    bus.emit({ type: "queue:step-started", workflowId: "wf-e2e", stepId: "s1", stepType: "implement", stepTitle: "Build", timestamp: now() });
    bus.emit({ type: "subprocess:spawned", workflowId: "wf-e2e", stepIndex: 0, timestamp: now() });
  });

  it("NDJSONEvent with tool_use → trace:tool-started → tool_call span", () => {
    handler.handleEvent(makeToolUseNDJSON("Read", "toolu_e2e", { file_path: "/src/main.ts" }));
    handler.handleEvent(makeToolResultNDJSON("toolu_e2e", "export function main() {}"));

    const toolSpan = writer.spans.find((s) => s.kind === "tool_call");
    expect(toolSpan).toBeDefined();
    expect(toolSpan!.status).toBe("ok");
    expect((toolSpan as any).input.toolName).toBe("Read");
    expect((toolSpan as any).output.toolOutput).toContain("export function main");
  });

  it("NDJSONEvent with Task tool_use → trace:subagent-started → subagent span", () => {
    handler.handleEvent(makeToolUseNDJSON("Task", "toolu_task", {
      description: "write tests",
      prompt: "write unit tests for main.ts",
    }));
    handler.handleEvent(makeToolResultNDJSON("toolu_task", "tests written successfully"));

    const subagentSpan = writer.spans.find((s) => s.kind === "subagent");
    expect(subagentSpan).toBeDefined();
    expect(subagentSpan!.status).toBe("ok");
    expect((subagentSpan as any).input.agentType).toBe("Task");
    expect((subagentSpan as any).output.result).toContain("tests written");
  });

  it("multiple tool calls in sequence produce correct spans", () => {
    handler.handleEvent(makeToolUseNDJSON("Read", "toolu_1", { file_path: "/a.ts" }));
    handler.handleEvent(makeToolResultNDJSON("toolu_1", "content A"));

    handler.handleEvent(makeToolUseNDJSON("Write", "toolu_2", { file_path: "/b.ts", content: "new" }));
    handler.handleEvent(makeToolResultNDJSON("toolu_2", "written"));

    const toolSpans = writer.spans.filter((s) => s.kind === "tool_call");
    expect(toolSpans).toHaveLength(2);
    expect((toolSpans[0] as any).input.toolName).toBe("Read");
    expect((toolSpans[1] as any).input.toolName).toBe("Write");
  });

  it("mixed tool and subagent calls are classified correctly", () => {
    handler.handleEvent(makeToolUseNDJSON("Read", "toolu_t1", {}));
    handler.handleEvent(makeToolResultNDJSON("toolu_t1", "ok"));

    handler.handleEvent(makeToolUseNDJSON("Task", "toolu_s1", { description: "sub" }));
    handler.handleEvent(makeToolResultNDJSON("toolu_s1", "done"));

    handler.handleEvent(makeToolUseNDJSON("Grep", "toolu_t2", {}));
    handler.handleEvent(makeToolResultNDJSON("toolu_t2", "matches"));

    const toolSpans = writer.spans.filter((s) => s.kind === "tool_call");
    const subagentSpans = writer.spans.filter((s) => s.kind === "subagent");

    expect(toolSpans).toHaveLength(2);
    expect(subagentSpans).toHaveLength(1);
  });
});
