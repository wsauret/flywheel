export interface ChildHandle {
  readonly pid: number;
  kill(signal?: number): void;
}

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
