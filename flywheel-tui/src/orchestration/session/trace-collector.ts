/**
 * Trace Collector
 *
 * Builds span trees from EventBus events and writes completed spans via
 * TraceWriter. Each collector instance represents a single trace (one
 * workflow run), identified by a `traceId` generated via `randomUUID`.
 *
 * Span stack for automatic `parentSpanId` linkage: when a new span is
 * started, its parent is the top of the stack. The span is then pushed
 * onto the stack. When ended, it is removed from the stack (not necessarily
 * LIFO — spans may be ended out of order due to event interleaving).
 *
 * Single-threaded assumption: Bun's event loop serializes event handling
 * and span lifecycle updates — no locking needed. Do NOT use Worker
 * threads for this component. (Matches BudgetTracker pattern.)
 *
 * Usage:
 *   const collector = createTraceCollector({ writer, sessionId, workflowName });
 *   const unsubs = collector.subscribeToEvents(bus);
 *   // ... workflow runs, events flow ...
 *   collector.finalize("ok"); // close open spans, write index entry
 *   collector.dispose();      // dispose writer
 */

import { randomUUID } from "node:crypto";
import type { EventBus, Unsubscribe } from "../../infra/event-bus";
import type { SpanKind, Span } from "../../infra/trace-types";
import { truncateField } from "../../infra/trace-types";
import type { TraceWriter, TraceIndexEntry } from "./trace-writer";
import { subscribeTraceEvents } from "./trace-subscriptions.js";

// Types

export interface TraceCollectorDeps {
  writer: TraceWriter;
  sessionId: string;
  workflowName: string;
}

export interface TraceCollector {
  /** Get the traceId for this collector. */
  getTraceId(): string;
  /** Start a span, returns spanId. */
  startSpan(kind: SpanKind, name: string, input?: unknown): string;
  /** End a span with output and status. */
  endSpan(spanId: string, output?: unknown, status?: "ok" | "error", error?: { message: string; code?: string }): void;
  /** Auto-timed span wrapper. */
  recordSpan<T>(kind: SpanKind, name: string, input: unknown, fn: () => T): T;
  /** Subscribe to EventBus for automatic span creation. Returns unsub functions. */
  subscribeToEvents(bus: EventBus): Unsubscribe[];
  /** Close all open spans as error, finalize trace, flush writer. */
  finalize(status?: "ok" | "error"): void;
  /** Dispose writer. */
  dispose(): void;
}

// Internal span record (mutable, pre-completion)

interface OpenSpan {
  spanId: string;
  kind: SpanKind;
  name: string;
  parentSpanId: string | null;
  startTimeMs: number;
  input: unknown;
}

// Constants

const MAX_FIELD_BYTES = 4096;

// Factory

export function createTraceCollector(deps: TraceCollectorDeps): TraceCollector {
  const { writer, sessionId, workflowName } = deps;
  const traceId = randomUUID();

  // Open spans indexed by spanId for O(1) lookup on endSpan
  const openSpans = new Map<string, OpenSpan>();

  // Span stack for automatic parentSpanId linkage.
  // The top of the stack is the current parent for new spans.
  const spanStack: string[] = [];

  // Bookkeeping for finalize
  let spanCount = 0;
  let closedSpanCount = 0;
  let traceStartTimeMs = 0;

  // Track event-created span IDs for structural mapping
  let workflowSpanId: string | null = null;
  const stepSpanIds = new Map<string, string>(); // stepId → spanId
  const toolSpanIds = new Map<string, string>(); // toolUseId → spanId

  // Helpers

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
    status: "ok" | "error",
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

    // Build the discriminated union member based on kind.
    // Input/output are typed per kind, but we trust the caller to provide
    // the correct shape (or truncated version of it).
    return {
      ...base,
      kind: open.kind,
      input: truncatedInput,
      output: truncatedOutput,
    } as Span;
  }

  // Public API

  function getTraceId(): string {
    return traceId;
  }

  function startSpan(kind: SpanKind, name: string, input?: unknown): string {
    const spanId = randomUUID();
    const parentSpanId = currentParentSpanId();
    const startTimeMs = Date.now();

    if (spanCount === 0) {
      traceStartTimeMs = startTimeMs;
    }

    const open: OpenSpan = {
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
    status: "ok" | "error" = "ok",
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

  function recordSpan<T>(kind: SpanKind, name: string, input: unknown, fn: () => T): T {
    const spanId = startSpan(kind, name, input);
    try {
      const result = fn();
      endSpan(spanId, undefined, "ok");
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      endSpan(spanId, undefined, "error", { message });
      throw err;
    }
  }

  // EventBus subscriptions

  function subscribeToEvents(bus: EventBus): Unsubscribe[] {
    return subscribeTraceEvents(bus, {
      startSpan,
      endSpan,
      get workflowSpanId() { return workflowSpanId; },
      setWorkflowSpanId(id: string) { workflowSpanId = id; },
      stepSpanIds,
      toolSpanIds,
      spanStack,
      openSpans,
    }, workflowName);
  }

  // Lifecycle

  function finalize(status: "ok" | "error" = "ok"): void {
    const endTimeMs = Date.now();

    // Close all open spans in reverse stack order with the given status
    const openSpanIds = [...spanStack].reverse();
    for (const spanId of openSpanIds) {
      const open = openSpans.get(spanId);
      if (!open) continue;

      // Build default output based on kind
      const defaultOutput = buildDefaultOutput(open.kind, status);
      endSpan(spanId, defaultOutput, status, status === "error" ? { message: "trace finalized with open spans" } : undefined);
    }

    // Write index entry
    const summary: TraceIndexEntry = {
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

  function buildDefaultOutput(kind: SpanKind, status: "ok" | "error"): unknown {
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
    writer.dispose();
  }

  return {
    getTraceId,
    startSpan,
    endSpan,
    recordSpan,
    subscribeToEvents,
    finalize,
    dispose,
  };
}
