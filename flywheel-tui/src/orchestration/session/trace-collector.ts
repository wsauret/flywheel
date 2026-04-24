import { randomUUID } from "node:crypto";
import type { EventBus, Unsubscribe } from "../../infra/event-bus.js";
import type { SpanKind, Span, SpanStatus } from "../../infra/trace-types.js";
import { truncateField } from "../../infra/trace-types.js";
import type { TraceWriter } from "./trace-writer.js";
import { subscribeTraceEvents } from "./trace-subscriptions.js";

interface TraceCollectorDeps {
  writer: TraceWriter;
  sessionId: string;
  workflowName: string;
}

export interface TraceCollector {
  startSpan(kind: SpanKind, name: string, input?: unknown): string;
  endSpan(spanId: string, output?: unknown, status?: SpanStatus, error?: { message: string; code?: string }): void;
  subscribeToEvents(bus: EventBus): Unsubscribe[];
  finalize(status?: SpanStatus): void;
  dispose(): void;
}

interface OpenSpan {
  spanId: string;
  kind: SpanKind;
  name: string;
  parentSpanId: string | null;
  startTimeMs: number;
  input: unknown;
}

const MAX_FIELD_BYTES = 4096;

export function createTraceCollector(deps: TraceCollectorDeps): TraceCollector {
  const { writer, sessionId, workflowName } = deps;
  const traceId = randomUUID();

  const openSpans = new Map<string, OpenSpan>();
  const spanStack: string[] = [];
  let spanCount = 0;
  let closedSpanCount = 0;
  let traceStartTimeMs = 0;

  let workflowSpanId: string | null = null;
  let finalized = false;
  const stepSpanIds = new Map<string, string>();
  const toolSpanIds = new Map<string, string>();

  function truncateInput(value: unknown): unknown {
    const serialized = truncateField(value, MAX_FIELD_BYTES);
    try {
      return JSON.parse(serialized);
    } catch {
      return serialized;
    }
  }

  function currentParentSpanId(): string | null {
    return spanStack.length > 0 ? spanStack[spanStack.length - 1] : null;
  }

  function removeFromStack(spanId: string): void {
    const idx = spanStack.indexOf(spanId);
    if (idx !== -1) {
      spanStack.splice(idx, 1);
    }
  }

  function buildCompletedSpan(
    open: OpenSpan,
    output: unknown,
    status: SpanStatus,
    error: { message: string; code?: string } | null,
    endTimeMs: number,
  ): Span {
    const truncatedInput = truncateInput(open.input);
    const truncatedOutput = truncateInput(output);

    const base = {
      spanId: open.spanId,
      traceId,
      parentSpanId: open.parentSpanId,
      sessionId,
      startTimeMs: open.startTimeMs,
      endTimeMs,
      durationMs: endTimeMs - open.startTimeMs,
      status,
      error,
    };

    // Discriminated union constructed from runtime `kind` — TS can't narrow this statically
    return {
      ...base,
      kind: open.kind,
      input: truncatedInput,
      output: truncatedOutput,
    } as Span;
  }

  function startSpan(kind: SpanKind, name: string, input?: unknown): string {
    const spanId = randomUUID();
    const parentSpanId = currentParentSpanId();
    const startTimeMs = Date.now();

    if (spanCount === 0) {
      traceStartTimeMs = startTimeMs;
    }

    const open = {
      spanId,
      kind,
      name,
      parentSpanId,
      startTimeMs,
      input: input ?? null,
    };

    openSpans.set(spanId, open);
    spanStack.push(spanId);
    spanCount++;

    return spanId;
  }

  function endSpan(
    spanId: string,
    output?: unknown,
    status: SpanStatus = "ok",
    error?: { message: string; code?: string },
  ): void {
    const open = openSpans.get(spanId);
    if (!open) return; // Already ended or unknown span — no-op

    const endTimeMs = Date.now();
    const errorObj = error ?? (status === "error" ? { message: "unknown error" } : null);

    const span = buildCompletedSpan(open, output ?? null, status, errorObj, endTimeMs);
    writer.writeSpan(span);

    openSpans.delete(spanId);
    removeFromStack(spanId);
    closedSpanCount++;
  }

  function findOpenSpanByKind(kind: SpanKind): string | null {
    for (let i = spanStack.length - 1; i >= 0; i--) {
      const spanId = spanStack[i]!;
      if (openSpans.get(spanId)?.kind === kind) return spanId;
    }
    return null;
  }

  function resetStackForStep(wfSpanId: string | null): void {
    const liveIds = spanStack.filter((id) => openSpans.has(id));
    spanStack.length = 0;
    if (wfSpanId && openSpans.has(wfSpanId)) spanStack.push(wfSpanId);
    for (const id of liveIds) {
      if (id !== wfSpanId && !spanStack.includes(id)) spanStack.push(id);
    }
  }

  function subscribeToEvents(bus: EventBus): Unsubscribe[] {
    return subscribeTraceEvents(bus, {
      startSpan,
      endSpan,
      findOpenSpanByKind,
      resetStackForStep,
      get workflowSpanId() { return workflowSpanId; },
      setWorkflowSpanId(id: string) { workflowSpanId = id; },
      getStepSpanId: (stepId) => stepSpanIds.get(stepId),
      setStepSpanId: (stepId, spanId) => { stepSpanIds.set(stepId, spanId); },
      deleteStepSpanId: (stepId) => { stepSpanIds.delete(stepId); },
      getToolSpanId: (toolUseId) => toolSpanIds.get(toolUseId),
      setToolSpanId: (toolUseId, spanId) => { toolSpanIds.set(toolUseId, spanId); },
      deleteToolSpanId: (toolUseId) => { toolSpanIds.delete(toolUseId); },
    }, workflowName);
  }

  function finalize(status: SpanStatus = "ok"): void {
    if (finalized) return;
    finalized = true;
    const endTimeMs = Date.now();

    const openSpanIds = [...spanStack].reverse();
    for (const spanId of openSpanIds) {
      const open = openSpans.get(spanId);
      if (!open) continue;

      const defaultOutput = buildDefaultOutput(open.kind, status);
      endSpan(spanId, defaultOutput, status, status === "error" ? { message: "trace finalized with open spans" } : undefined);
    }

    const summary = {
      traceId,
      sessionId,
      workflowName,
      startTimeMs: traceStartTimeMs || endTimeMs,
      endTimeMs,
      durationMs: endTimeMs - (traceStartTimeMs || endTimeMs),
      status,
      spanCount,
      closedSpanCount,
    };
    writer.finalizeTrace(summary);
    writer.flush();
  }

  function buildDefaultOutput(kind: SpanKind, status: SpanStatus): unknown {
    const reason = status === "error" ? "trace finalized with open spans" : null;
    switch (kind) {
      case "workflow":
        return { stepsCompleted: 0, failureReason: reason };
      case "step":
        return { failureReason: reason };
      case "worker":
        return { resultSummary: "", failureReason: reason };
      case "subagent":
        return { result: "", exitStatus: status === "error" ? 1 : 0, error: reason };
      case "tool_call":
        return { toolOutput: "", isError: status === "error" };
    }
  }

  function dispose(): void {
    if (!finalized) finalize();
    writer.dispose();
  }

  return {
    startSpan,
    endSpan,
    subscribeToEvents,
    finalize,
    dispose,
  };
}
