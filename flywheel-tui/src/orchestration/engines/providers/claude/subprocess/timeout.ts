// No idle timeout — agents can "think" for >5 min with no output.

import { killProcessGroup, type ChildHandle } from "../../../../../infra/process-lifecycle.js";

export const DEFAULT_TIMEOUT_MINUTES = 60;
const MIN_TIMEOUT_MINUTES = 1;
const MAX_TIMEOUT_MINUTES = 120;

export function clampTimeoutMinutes(minutes: number): number {
  return Math.max(MIN_TIMEOUT_MINUTES, Math.min(MAX_TIMEOUT_MINUTES, minutes));
}

interface SubprocessTimeout {
  /** The AbortController — pass `signal` to observe cancellation. */
  controller: AbortController;
  /** The AbortSignal for external consumers. */
  signal: AbortSignal;
  /** Whether the timeout has fired. */
  timedOut: boolean;
  /** Whether the process was interrupted by user (SIGINT/SIGTERM). */
  interrupted: boolean;
  /** Cancel the timeout (prevents it from firing). */
  cancel(): void;
  /** Interrupt the subprocess (user-initiated, not a timeout). */
  interrupt(): void;
  /** Wire up process-group-kill when the signal aborts. */
  attachProcess(child: ChildHandle): void;
}

export function createSubprocessTimeout(timeoutMs: number): SubprocessTimeout {
  const controller = new AbortController();
  let timedOut = false;
  let interrupted = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`Subprocess timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  return {
    controller,
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    get interrupted() {
      return interrupted;
    },
    cancel() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
    interrupt() {
      interrupted = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      controller.abort(new Error("Subprocess interrupted by user"));
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
