import type { ProcessFailureReason } from "../../../../../infra/ndjson-event-types.js";
import { detectRateLimit } from "./rate-limit.js";

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

const TRANSIENT_REGEX = new RegExp(
  TRANSIENT_PATTERNS.map((p) => escapeRegex(p)).join("|"),
  "i",
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isTransientError(message: string): boolean {
  return TRANSIENT_REGEX.test(message);
}

export function categorizeFailure(opts: {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  timeoutMs?: number;
  completionDetected: boolean;
  interrupted?: boolean;
}): ProcessFailureReason | undefined {
  const { exitCode, stdout, stderr, timedOut, timeoutMs, completionDetected, interrupted } = opts;

  // Must check before timeout since both can set timedOut.
  if (interrupted) {
    return {
      kind: "interrupted",
      message: "Process interrupted by user",
    };
  }

  if (timedOut) {
    return {
      kind: "timeout",
      timeoutMs: timeoutMs ?? 0,
      message: `Process timed out after ${timeoutMs ?? 0}ms`,
    };
  }

  const rateLimitResult = detectRateLimit({ stderr, exitCode });
  if (rateLimitResult.isRateLimit) {
    return {
      kind: "rate_limited",
      message: rateLimitResult.message,
    };
  }

  // Only check stderr — stdout may contain code/text with transient-like patterns.
  if (isTransientError(stderr)) {
    return {
      kind: "transient",
      message: `Transient error detected: ${extractTransientPattern(stderr)}`,
    };
  }

  if (exitCode !== 0 && isApiError(stderr)) {
    return {
      kind: "api_error",
      message: `API error with exit code ${exitCode}`,
    };
  }

  // Crash-after-success: the worker finished, the crash is incidental.
  if (exitCode !== 0 && completionDetected && !interrupted && !timedOut) {
    return undefined;
  }

  if (exitCode !== 0) {
    return {
      kind: "exit_code",
      exitCode,
      message: `Process exited with code ${exitCode}`,
    };
  }

  return undefined;
}

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
