interface DebouncedWriterOpts {
  intervalMs?: number;
}

export interface DebouncedWriter<T> {
  schedule(data: T): void;
  flush(): Promise<void>;
  dispose(): void;
}

const DEFAULT_INTERVAL_MS = 5000;

function asError(error: Error): Error {
  return error;
}

export function createDebouncedWriter<T>(
  write: (data: T) => Promise<void>,
  opts?: DebouncedWriterOpts,
): DebouncedWriter<T> {
  const intervalMs = opts?.intervalMs ?? DEFAULT_INTERVAL_MS;

  let pending: { data: T } | null = null;
  let queued: { data: T } | null = null;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let writing = false;

  let lastError: Error | null = null;
  let flushWaiters: Array<{ resolve: () => void; reject: (error: Error) => void }> = [];

  function resolveFlushWaiters(): void {
    const waiters = flushWaiters;
    flushWaiters = [];
    for (const waiter of waiters) {
      waiter.resolve();
    }
  }

  function rejectFlushWaiters(error: Error): void {
    const waiters = flushWaiters;
    flushWaiters = [];
    for (const waiter of waiters) {
      waiter.reject(error);
    }
  }

  async function doWrite(data: T): Promise<void> {
    writing = true;
    try {
      let current: { data: T } | null = { data };
      while (current) {
        await write(current.data);
        current = queued;
        queued = null;
      }
      lastError = null;
      writing = false;
      resolveFlushWaiters();
    } catch (cause) {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      lastError = error;
      queued = null;
      writing = false;
      rejectFlushWaiters(error);
      throw error;
    }
  }

  function fire(): void {
    timerId = null;
    if (!pending) return;

    const data = pending.data;
    pending = null;

    if (writing) {
      queued = { data };
    } else {
      void doWrite(data).catch((error: Error) => {
        lastError = error;
      });
    }
  }

  function schedule(data: T): void {
    if (disposed) return;

    pending = { data };

    if (timerId !== null) {
      clearTimeout(timerId);
    }
    timerId = setTimeout(fire, intervalMs);
  }

  async function flush(): Promise<void> {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }

    if (pending) {
      const data = pending.data;
      pending = null;

      if (writing) {
        queued = { data };
        return new Promise<void>((resolve, reject) => {
          flushWaiters.push({ resolve, reject });
        });
      }
      await doWrite(data);
    } else if (writing) {
      return new Promise<void>((resolve, reject) => {
        flushWaiters.push({ resolve, reject });
      });
    } else if (lastError !== null) {
      const err = lastError;
      lastError = null;
      throw asError(err);
    }
  }

  // dispose() does not flush; callers must await flush() first per ARCH-RUNTIME-029 disposal
  // ordering. Pending data is intentionally dropped here.

  function dispose(): void {
    if (disposed) return;
    disposed = true;

    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }

    pending = null;
    queued = null;
    rejectFlushWaiters(new Error("DebouncedWriter disposed before flush completed"));
  }

  return { schedule, flush, dispose };
}
