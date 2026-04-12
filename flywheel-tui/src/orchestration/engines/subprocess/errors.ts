/**
 * Subprocess error categorization and retryability classification.
 *
 * Maps `SubprocessFailureReason` kinds to retryable/non-retryable, and provides
 * `isTransientError()` to detect transient network/connection errors from
 * error messages and stderr output.
 *
 * `ExecutionStatus.interrupted` = cancellation, NOT a SubprocessFailureReason kind.
 */

import type { SubprocessFailureReason } from "../../../infra/subprocess-types";
import { RateLimitDetector } from "./rate-limit";

// ---------------------------------------------------------------------------
// Transient error detection
// ---------------------------------------------------------------------------

/**
 * All known transient error patterns.
 * These indicate network/connection issues that may resolve on retry.
 */
const TRANSIENT_PATTERNS: readonly string[] = [
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EPIPE",
  "socket hang up",
  "network error",
  "dns resolution",
  "GOAWAY",
  "stream closed",
  "connection reset",
  "unexpected EOF",
  "502",
  "503",
  "service unavailable",
  "temporary",
];

/**
 * Pre-compiled regex for transient error detection.
 * Case-insensitive to catch variations in error formatting.
 */
const TRANSIENT_REGEX = new RegExp(
  TRANSIENT_PATTERNS.map((p) => escapeRegex(p)).join("|"),
  "i",
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Detect whether an error message indicates a transient network/connection error.
 */
function isTransientError(message: string): boolean {
  return TRANSIENT_REGEX.test(message);
}

// ---------------------------------------------------------------------------
// Retryability classification
// ---------------------------------------------------------------------------

/** Failure kinds that are retryable. */
const RETRYABLE_KINDS = new Set<SubprocessFailureReason["kind"]>([
  "timeout",
  "api_error",
  "rate_limited",
  "transient",
  "handoff_missing",
]);

/** Failure kinds that are NOT retryable. */
const NON_RETRYABLE_KINDS = new Set<SubprocessFailureReason["kind"]>([
  "exit_code",
  "schema_error",
  "interrupted",
  "handoff_invalid",
]);

/**
 * Determine if a `SubprocessFailureReason` is retryable.
 *
 * Pass this as the `isRetryable` predicate to `retry<T>()`.
 */
function isRetryable(reason: SubprocessFailureReason): boolean {
  return RETRYABLE_KINDS.has(reason.kind);
}

/**
 * Categorize an error into a `SubprocessFailureReason` based on exit code,
 * output content, and other signals.
 */
export function categorizeFailure(opts: {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  timeoutMs?: number;
  completionDetected: boolean;
  /** Whether the process was killed by user interrupt (SIGINT/SIGTERM) */
  interrupted?: boolean;
}): SubprocessFailureReason | undefined {
  const { exitCode, stdout, stderr, timedOut, timeoutMs, completionDetected, interrupted } = opts;

  // Interrupted by user (Ctrl+C / SIGINT / SIGTERM) — never retry
  // Must check before timeout since both can set timedOut
  if (interrupted) {
    return {
      kind: "interrupted",
      message: "Process interrupted by user",
    };
  }

  // Timeout
  if (timedOut) {
    return {
      kind: "timeout",
      timeoutMs: timeoutMs ?? 0,
      message: `Process timed out after ${timeoutMs ?? 0}ms`,
    };
  }

  // Rate limited (check before transient since rate-limit is more specific)
  // Uses RateLimitDetector which only checks stderr to avoid false positives.
  const rateLimitResult = rateLimitDetector.detect({ stderr, stdout, exitCode });
  if (rateLimitResult.isRateLimit) {
    return {
      kind: "rate_limited",
      message: rateLimitResult.message ?? "Rate limited by API",
    };
  }

  // Transient errors — only check stderr (not stdout) to avoid false positives
  // from code/text the subprocess produces containing transient-like patterns
  if (isTransientError(stderr)) {
    return {
      kind: "transient",
      message: `Transient error detected: ${extractTransientPattern(stderr)}`,
    };
  }

  // API errors (non-zero exit + no specific pattern)
  if (exitCode !== 0 && isApiError(stderr)) {
    return {
      kind: "api_error",
      message: `API error with exit code ${exitCode}`,
    };
  }

  // Crash-after-success recovery: if completion was detected before the crash,
  // treat as success — the worker finished its work, the crash is incidental.
  if (exitCode !== 0 && completionDetected && !interrupted && !timedOut) {
    return undefined;
  }

  // Non-zero exit code
  if (exitCode !== 0) {
    return {
      kind: "exit_code",
      exitCode,
      message: `Process exited with code ${exitCode}`,
    };
  }

  // Clean exit (code 0) is treated as successful completion.
  // The <promise>COMPLETE</promise> marker and NDJSON result events are
  // belt-and-suspenders signals; a clean exit is the authoritative indicator.
  // Previously, missing the completion marker would cause non-retryable failure,
  // silently halting the workflow even though the worker exited successfully.
  return undefined;
}

// ---------------------------------------------------------------------------
// Helper detectors
// ---------------------------------------------------------------------------

/** Module-level detector instance (stateless, safe to reuse). */
const rateLimitDetector = new RateLimitDetector();

function isApiError(text: string): boolean {
  return /api.?error|internal.?server|5\d{2}/i.test(text);
}

function extractTransientPattern(text: string): string {
  for (const pattern of TRANSIENT_PATTERNS) {
    if (text.toLowerCase().includes(pattern.toLowerCase())) {
      return pattern;
    }
  }
  return "unknown transient error";
}
