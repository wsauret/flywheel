export interface ChildHandle {
  readonly pid: number;
  kill(signal?: number): void;
}

export function killProcessGroup(child: ChildHandle, signal: NodeJS.Signals): void {
  const signalNum = signalToNumber(signal);

  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, signalNum); // negative PID targets the process group
      return;
    } catch (err: unknown) {
      if (isEsrch(err)) {
        try { child.kill(signalNum); } catch {}
        return;
      }
      try { child.kill(signalNum); } catch {}
    }
  } else {
    try { child.kill(signalNum); } catch {}
  }
}

function isEsrch(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "ESRCH";
}

const SIGNAL_MAP: Record<string, number> = {
  SIGTERM: 15,
  SIGKILL: 9,
  SIGINT: 2,
};

function signalToNumber(signal: NodeJS.Signals): number {
  return SIGNAL_MAP[signal] ?? 15;
}
