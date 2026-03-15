/**
 * AbortController-based timeout for worker processes.
 *
 * Default: 60 minutes. Configurable via config (bounds: 1-120 minutes).
 * No idle timeout — agents can "think" for >5 min with no output.
 *
 * On abort: triggers process-group-kill flow via process-lifecycle.ts.
 */

import { killProcessGroup, type ChildHandle } from "./process-lifecycle";

/** Default timeout in minutes. */
export const DEFAULT_TIMEOUT_MINUTES = 60;

/** Minimum allowed timeout in minutes. */
export const MIN_TIMEOUT_MINUTES = 1;

/** Maximum allowed timeout in minutes. */
export const MAX_TIMEOUT_MINUTES = 120;

/**
 * Clamp a timeout value to valid bounds.
 */
export function clampTimeoutMinutes(minutes: number): number {
  return Math.max(MIN_TIMEOUT_MINUTES, Math.min(MAX_TIMEOUT_MINUTES, minutes));
}

/**
 * Convert minutes to milliseconds.
 */
export function minutesToMs(minutes: number): number {
  return minutes * 60 * 1000;
}

export interface WorkerTimeout {
  /** The AbortController — pass `signal` to observe cancellation. */
  controller: AbortController;
  /** The AbortSignal for external consumers. */
  signal: AbortSignal;
  /** Whether the timeout has fired. */
  timedOut: boolean;
  /** Cancel the timeout (prevents it from firing). */
  cancel(): void;
  /** Wire up process-group-kill when the signal aborts. */
  attachProcess(child: ChildHandle): void;
}

/**
 * Create a worker timeout that will abort after the specified duration.
 *
 * @param timeoutMs - Timeout in milliseconds. Use `minutesToMs(clampTimeoutMinutes(n))`
 *                    to convert from user-configured minutes.
 */
export function createWorkerTimeout(timeoutMs: number): WorkerTimeout {
  const controller = new AbortController();
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Worker timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  return {
    controller,
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    cancel() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
    attachProcess(child: ChildHandle) {
      // If already aborted, kill immediately
      if (controller.signal.aborted) {
        killProcessGroup(child, "SIGTERM");
        return;
      }
      controller.signal.addEventListener("abort", () => {
        killProcessGroup(child, "SIGTERM");
      }, { once: true });
    },
  };
}
