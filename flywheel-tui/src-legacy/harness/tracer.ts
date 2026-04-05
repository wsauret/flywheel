/**
 * Observability layer for the agent harness.
 *
 * Every event the harness emits flows through here. The tracer is the
 * foundation for:
 *
 *   1. Execution trajectories — full timeline of turns, tool calls,
 *      decisions, and state transitions, reconstructable from events.
 *   2. Logs — human-readable interpretation for debugging.
 *   3. Monitoring — real-time visibility via callbacks.
 *   4. Cost analysis — per-turn and cumulative token/cost tracking.
 *
 * The harness itself never writes to stdout/stderr/files. It emits
 * typed events; consumers (CLI, TUI, tests, log files) subscribe and
 * decide what to do with them.
 */

import type { UsageInfo } from "./llm.js";

// ---------------------------------------------------------------------------
// Trace event types
// ---------------------------------------------------------------------------

/** Base fields present on every trace event. */
interface TraceEventBase {
  /** Monotonic timestamp (ms since epoch). */
  ts: number;
  /** Turn index (0-based) this event belongs to, if applicable. */
  turn?: number;
}

/** All possible trace events, each with a discriminating `type` field. */
export type TraceEvent = TraceEventBase & (
  | { type: "turn_start" }
  | { type: "turn_end"; toolCallCount: number; hasCompletion: boolean; durationMs: number }
  | { type: "text_delta"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "tool_call_start"; id: string; name: string; input: Record<string, unknown>; intent?: string }
  | { type: "tool_call_end"; id: string; name: string; content: string; isError: boolean; durationMs: number }
  | { type: "completion_attempt"; handoff: unknown; result: "pending" | "confirmed" | "error"; message?: string }
  | { type: "doom_loop"; warning: string }
  | { type: "tool_failure_warning"; consecutiveFailures: number }
  | { type: "context_overflow"; action: "truncate"; messagesBefore: number; messagesAfter: number }
  | { type: "output_overflow"; action: "continue" }
  | { type: "usage"; usage: UsageInfo; cumulative: UsageInfo }
  | { type: "error"; error: Error; recoverable: boolean }
  | { type: "complete"; status: string; totalTurns: number; totalUsage: UsageInfo; durationMs: number }
);

export type TraceCallback = (event: TraceEvent) => void;

// ---------------------------------------------------------------------------
// Trace emitter — used internally by the harness
// ---------------------------------------------------------------------------

/** Distributive Omit for union types — preserves discriminants. */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** Input type for emitter — `ts` is auto-filled if omitted. */
export type TraceInput = DistributiveOmit<TraceEvent, "ts"> & { ts?: number };

/** Creates a trace emitter bound to a callback + session start time. */
export function createTraceEmitter(callback?: TraceCallback): TraceEmitter {
  const cb = callback ?? noop;
  const sessionStart = Date.now();
  return {
    emit(partial: TraceInput): void {
      cb({ ts: Date.now(), ...partial } as TraceEvent);
    },
    get sessionStartMs(): number {
      return sessionStart;
    },
    get elapsedMs(): number {
      return Date.now() - sessionStart;
    },
  };
}

export interface TraceEmitter {
  emit(event: TraceInput): void;
  readonly sessionStartMs: number;
  readonly elapsedMs: number;
}

const noop: TraceCallback = () => {};

// ---------------------------------------------------------------------------
// Console tracer — human-readable output for CLI
// ---------------------------------------------------------------------------

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const BOLD = "\x1b[1m";

/** Model pricing ($/Mtok) — March 2026 rates. Cache read is 90% off input. */
const MODEL_PRICING: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-opus-4-6": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheRead: 0.3 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5, cacheRead: 0.1 },
};

export function estimateCost(usage: UsageInfo, model?: string): number {
  const pricing = MODEL_PRICING[model ?? ""] ?? MODEL_PRICING["claude-sonnet-4-6"]!;
  const inputCost = (usage.inputTokens / 1_000_000) * pricing.input;
  const outputCost = (usage.outputTokens / 1_000_000) * pricing.output;
  const cacheCost = ((usage.cacheReadInputTokens ?? 0) / 1_000_000) * (pricing.cacheRead ?? pricing.input);
  return inputCost + outputCost + cacheCost;
}

export function createConsoleTracer(options?: { verbose?: boolean; model?: string }): TraceCallback {
  const verbose = options?.verbose ?? false;
  const model = options?.model;

  return (event: TraceEvent) => {
    switch (event.type) {
      case "turn_start":
        console.log(`\n${DIM}--- Turn ${(event.turn ?? 0) + 1} ---${RESET}`);
        break;
      case "turn_end":
        if (verbose) {
          console.log(`${DIM}  ${event.toolCallCount} tool calls, ${event.durationMs}ms${event.hasCompletion ? " [completion]" : ""}${RESET}`);
        }
        break;
      case "tool_call_start":
        console.log(`${CYAN}  > ${event.name}${RESET} ${DIM}${formatInput(event.input)}${RESET}`);
        break;
      case "tool_call_end":
        if (event.isError) {
          console.log(`${RED}  < ${event.name} ERROR (${event.durationMs}ms)${RESET}`);
          console.log(`${RED}    ${event.content.slice(0, 300)}${RESET}`);
        } else if (verbose) {
          console.log(`${DIM}  < ${event.name} ok (${event.durationMs}ms, ${event.content.length} chars)${RESET}`);
        }
        break;
      case "completion_attempt":
        if (event.result === "confirmed") {
          console.log(`${GREEN}${BOLD}  Task confirmed.${RESET}`);
        } else if (event.result === "pending") {
          console.log(`${YELLOW}  Completion pending — verification checklist sent.${RESET}`);
        } else {
          console.log(`${RED}  Completion rejected: ${event.message}${RESET}`);
        }
        break;
      case "doom_loop":
        console.log(`${RED}${BOLD}  Doom loop: ${event.warning}${RESET}`);
        break;
      case "tool_failure_warning":
        console.log(`${YELLOW}  ${event.consecutiveFailures} consecutive tool failures.${RESET}`);
        break;
      case "context_overflow":
        console.log(`${YELLOW}  Context overflow — truncated ${event.messagesBefore} → ${event.messagesAfter} messages.${RESET}`);
        break;
      case "output_overflow":
        console.log(`${YELLOW}  Output overflow — sending continuation.${RESET}`);
        break;
      case "usage": {
        if (verbose) {
          const u = event.usage;
          const cost = estimateCost(u, model);
          console.log(`${DIM}  ${u.inputTokens} in / ${u.outputTokens} out${u.cacheReadInputTokens ? ` (${u.cacheReadInputTokens} cached)` : ""} $${cost.toFixed(4)}${RESET}`);
        }
        break;
      }
      case "error":
        console.log(`${RED}  ${event.recoverable ? "Recoverable" : "Fatal"} error: ${event.error.message}${RESET}`);
        break;
      case "complete": {
        const u = event.totalUsage;
        const totalTokens = u.inputTokens + u.outputTokens;
        const cost = estimateCost(u, model);
        const color = event.status === "completed" ? GREEN : event.status === "error" ? RED : YELLOW;
        console.log(`\n${BOLD}${color}${event.status}${RESET} in ${event.totalTurns} turns, ${(event.durationMs / 1000).toFixed(1)}s`);
        console.log(`${DIM}${totalTokens.toLocaleString()} tokens (${u.inputTokens.toLocaleString()} in, ${u.outputTokens.toLocaleString()} out) — $${cost.toFixed(4)}${RESET}`);
        break;
      }
    }
  };
}

function formatInput(input: Record<string, unknown>): string {
  const s = JSON.stringify(input);
  return s.length > 120 ? s.slice(0, 117) + "..." : s;
}

// ---------------------------------------------------------------------------
// Collecting tracer — for tests and trajectory reconstruction
// ---------------------------------------------------------------------------

export function createCollectingTracer(): { trace: TraceCallback; events: TraceEvent[] } {
  const events: TraceEvent[] = [];
  return {
    trace: (event: TraceEvent) => { events.push(event); },
    events,
  };
}

// ---------------------------------------------------------------------------
// Multi-tracer — fan out to multiple consumers
// ---------------------------------------------------------------------------

export function createMultiTracer(...tracers: TraceCallback[]): TraceCallback {
  return (event: TraceEvent) => {
    for (const t of tracers) t(event);
  };
}
