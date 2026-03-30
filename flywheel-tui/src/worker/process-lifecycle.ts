/**
 * Process lifecycle management: process-group kill and graceful shutdown.
 *
 * - Unix: `process.kill(-pid, signal)` sends signal to entire process group
 * - Windows: falls back to `child.kill(signal)` (no process groups)
 * - Grace period: 5 seconds SIGTERM -> wait -> SIGKILL
 * - Global registry: module-level Set<ChildHandle> for shutdown hook
 */

/**
 * Minimal interface for a child process handle.
 * Compatible with Bun's Subprocess and Node's ChildProcess.
 */
export interface ChildHandle {
  readonly pid: number;
  kill(signal?: number): void;
}

/**
 * Global registry of active processes.
 * Module-level so `killAllActiveProcesses()` can be called from shutdown hooks.
 */
export const activeProcesses = new Set<ChildHandle>();

/**
 * Register a child process in the global registry.
 * Returns a cleanup function that removes it.
 */
export function registerProcess(child: ChildHandle): () => void {
  activeProcesses.add(child);
  return () => {
    activeProcesses.delete(child);
  };
}

/** Grace period between SIGTERM and SIGKILL (5 seconds). */
export const GRACE_PERIOD_MS = 5_000;

/**
 * Send a signal to a process group (Unix) or the process directly (Windows).
 *
 * On Unix, sending to -pid kills the entire process group.
 * On ESRCH (no such process), silently falls back to child.kill().
 */
export function killProcessGroup(child: ChildHandle, signal: NodeJS.Signals): void {
  const signalNum = signalToNumber(signal);

  if (process.platform !== "win32") {
    try {
      // Negative PID targets the process group on Unix
      process.kill(-child.pid, signalNum);
      return;
    } catch (err: unknown) {
      if (isEsrch(err)) {
        // Process already gone — try direct kill as fallback
        try {
          child.kill(signalNum);
        } catch {
          // Process already dead, ignore
        }
        return;
      }
      // EPERM or other error — fall through to direct kill
      try {
        child.kill(signalNum);
      } catch {
        // ignore
      }
    }
  } else {
    // Windows: no process groups, kill directly
    try {
      child.kill(signalNum);
    } catch {
      // ignore
    }
  }
}

/**
 * Gracefully kill a process: SIGTERM, wait grace period, then SIGKILL.
 */
export async function gracefulKill(child: ChildHandle): Promise<void> {
  killProcessGroup(child, "SIGTERM");

  // Wait for grace period
  await new Promise<void>((resolve) => setTimeout(resolve, GRACE_PERIOD_MS));

  // Force kill if still alive
  try {
    killProcessGroup(child, "SIGKILL");
  } catch {
    // Process may already be dead
  }
}

/**
 * Send SIGINT to a single active process by PID.
 *
 * Used by the 2-tier interrupt system: first Esc sends SIGINT to the
 * running worker, which terminates the process but preserves the
 * conversation session (resumable via --resume/--session).
 *
 * @returns true if the signal was sent, false if the process was not found or already dead.
 */
export function interruptActiveProcess(pid: number): boolean {
  try {
    process.kill(pid, 2); // SIGINT
    return true;
  } catch {
    return false;
  }
}

/**
 * Send SIGINT to all active processes in the global registry.
 *
 * Unlike `killAllActiveProcesses()` which does SIGTERM→wait→SIGKILL,
 * this sends SIGINT immediately and does NOT clear the registry
 * (processes may still be alive briefly and will be cleaned up by
 * their exit handlers).
 *
 * Used by the escape handler's "interrupt" tier.
 */
export function interruptAllActiveProcesses(): void {
  for (const child of activeProcesses) {
    try {
      killProcessGroup(child, "SIGINT");
    } catch {
      // Process may already be dead
    }
  }
}

/**
 * Kill all active processes (for shutdown hooks).
 * Sends SIGTERM to all, waits grace period, then SIGKILL to survivors.
 */
export async function killAllActiveProcesses(): Promise<void> {
  if (activeProcesses.size === 0) return;

  // SIGTERM all
  for (const child of activeProcesses) {
    try {
      killProcessGroup(child, "SIGTERM");
    } catch {
      // ignore
    }
  }

  // Wait grace period
  await new Promise<void>((resolve) => setTimeout(resolve, GRACE_PERIOD_MS));

  // SIGKILL survivors
  for (const child of activeProcesses) {
    try {
      killProcessGroup(child, "SIGKILL");
    } catch {
      // ignore
    }
  }

  activeProcesses.clear();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isEsrch(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ESRCH"
  );
}

const SIGNAL_MAP: Record<string, number> = {
  SIGTERM: 15,
  SIGKILL: 9,
  SIGINT: 2,
};

function signalToNumber(signal: NodeJS.Signals): number {
  return SIGNAL_MAP[signal] ?? 15;
}
