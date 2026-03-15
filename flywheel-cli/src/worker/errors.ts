/**
 * Worker error categorization and retryability classification.
 *
 * Maps `WorkerFailureReason` kinds to retryable/non-retryable, and provides
 * `isTransientError()` to detect transient network/connection errors from
 * error messages and stderr output.
 *
 * `ExecutionStatus.interrupted` = cancellation, NOT a WorkerFailureReason kind.
 */

import type { WorkerFailureReason } from "../schemas/worker";
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
export function isTransientError(message: string): boolean {
  return TRANSIENT_REGEX.test(message);
}

/**
 * Get the list of transient error patterns (for testing/debug).
 */
export function getTransientPatterns(): readonly string[] {
  return TRANSIENT_PATTERNS;
}

// ---------------------------------------------------------------------------
// Retryability classification
// ---------------------------------------------------------------------------

/** Failure kinds that are retryable. */
const RETRYABLE_KINDS = new Set<WorkerFailureReason["kind"]>([
  "timeout",
  "api_error",
  "rate_limited",
  "transient",
]);

/** Failure kinds that are NOT retryable. */
const NON_RETRYABLE_KINDS = new Set<WorkerFailureReason["kind"]>([
  "exit_code",
  "schema_error",
  "completion_not_detected",
  "interrupted",
]);

/**
 * Determine if a `WorkerFailureReason` is retryable.
 *
 * Pass this as the `isRetryable` predicate to `retry<T>()`.
 */
export function isRetryable(reason: WorkerFailureReason): boolean {
  return RETRYABLE_KINDS.has(reason.kind);
}

/**
 * Categorize an error into a `WorkerFailureReason` based on exit code,
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
}): WorkerFailureReason | undefined {
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
  // from code/text the worker produces containing transient-like patterns
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

  // Non-zero exit code
  if (exitCode !== 0) {
    return {
      kind: "exit_code",
      exitCode,
      message: `Process exited with code ${exitCode}`,
    };
  }

  // Completion not detected (exit 0 but no marker)
  if (!completionDetected) {
    return {
      kind: "completion_not_detected",
      message: "Process completed but completion marker was not detected",
    };
  }

  // Success — no failure
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
