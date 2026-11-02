import { assertNever } from "../../infra/assert-never.js";
import { InvariantViolation } from "../../infra/invariant.js";
import { PersistenceWriteRefused } from "../../infra/event-store-types.js";
import { HandoffInvalidError, HandoffNotProducedError } from "./handoff-errors.js";
import type { AgentFailureKind } from "../vm/agent-outcome.js";

/** Typed carrier for a worker's terminal failure across the attempt runner's
 *  classification boundary. Carrying the kind lets classification consume typed data instead
 *  of re-deriving the class from message patterns; `failureDetail` keeps the
 *  raw provider message so the pattern heuristics for the provider-boundary
 *  kinds see provider text, not Flywheel's humanized display copy. */
export class WorkerFailedError extends Error {
  constructor(
    readonly failureKind: AgentFailureKind,
    failureMessage: string,
    readonly failureDetail: string,
  ) {
    super(`Worker failed: ${failureMessage}`);
    this.name = "WorkerFailedError";
  }
}

/** Kind-direct classification. Returns null for the provider-boundary kinds
 *  whose class depends on the provider message (auth vs rate limit vs noise);
 *  those fall through to the status/pattern heuristics on the message. */
function classifyAgentFailureKind(kind: AgentFailureKind): ErrorType | null {
  switch (kind) {
    case "transient_disconnect":
    case "stream_stalled":
    case "api_overloaded":
      // Includes reconnect exhaustion: waiting and retrying is the remedy.
      return "transient";
    case "input_closed":
      // A broken input source is a runtime bug, not a provider condition.
      return "invariant";
    case "model_reassigned":
      // Consumed by the resilience rebuild before classification; reaching
      // here is a runtime bug.
      return "invariant";
    case "budget_exhausted":
      // A retry burns another full budget; the brief needs a smaller scope.
      return "fatal";
    case "model_unavailable":
      // No provider offers the model; a retry plans the same empty chain.
      return "fatal";
    case "interrupted":
    case "aborted":
      // Normally consumed by the abort path before classification; reaching
      // here means the signal state was unexpected.
      return "unknown";
    case "api_error":
    case "output_overflow":
      return null;
    default:
      return assertNever(kind);
  }
}

export type ErrorType = "transient" | "fatal" | "invariant" | "unknown" | "handoff";

// Provider/SDK errors have no stable typed shape; message patterns are a boundary
// heuristic, checked after class-based internal matches.
const FATAL_PATTERNS = [
  "unauthorized",
  "forbidden",
  "invalid api key",
  "invalid x-api-key",
  "authentication failed",
  "permission denied",
  "credit",
  "billing",
  "quota exceeded",
];

const TRANSIENT_PATTERNS = [
  "timeout",
  "timed out",
  "etimedout",
  "econnrefused",
  "econnreset",
  "enotfound",
  "epipe",
  "socket hang up",
  "rate limit",
  "rate_limit",
  "too many requests",
  "overloaded",
  "service unavailable",
  "bad gateway",
  "stream closed before",
  "stream idle",
];

const FATAL_STATUS_CODES = new Set([401, 403]);
const TRANSIENT_STATUS_CODES = new Set([408, 429, 502, 503, 529]);

function getStatus(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "status" in error) {
    const s = error.status;
    return typeof s === "number" ? s : undefined;
  }
  return undefined;
}

export function classifyError(error: unknown): ErrorType {
  if (error instanceof PersistenceWriteRefused || (error instanceof Error && error.cause instanceof PersistenceWriteRefused)) return "fatal";
  if (error instanceof HandoffNotProducedError || error instanceof HandoffInvalidError) {
    // The worker ran but broke the handoff contract: a model-output failure in
    // workflow vocabulary, not an internal invariant of ours.
    return "handoff";
  }
  if (error instanceof InvariantViolation) return "invariant";
  if (error instanceof WorkerFailedError) {
    const byKind = classifyAgentFailureKind(error.failureKind);
    if (byKind !== null) return byKind;
    return classifyMessageText(error.failureDetail);
  }

  const status = getStatus(error);
  if (status !== undefined) {
    if (FATAL_STATUS_CODES.has(status)) return "fatal";
    if (TRANSIENT_STATUS_CODES.has(status)) return "transient";
  }

  return classifyMessageText(error instanceof Error ? error.message : String(error));
}

function classifyMessageText(text: string): ErrorType {
  const message = text.toLowerCase();
  if (FATAL_PATTERNS.some(p => message.includes(p))) return "fatal";
  if (TRANSIENT_PATTERNS.some(p => message.includes(p))) return "transient";
  return "unknown";
}
