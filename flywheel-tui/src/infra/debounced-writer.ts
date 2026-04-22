interface DebouncedWriterOpts {
  intervalMs?: number;
}

export interface DebouncedWriter<T> {
  schedule(data: T): void;
  flush(): Promise<void>;
  dispose(): void;
}

const DEFAULT_INTERVAL_MS = 5000;

export function createDebouncedWriter<T>(
  write: (data: T) => Promise<void>,
  opts?: DebouncedWriterOpts,
): DebouncedWriter<T> {
  const intervalMs = opts?.intervalMs ?? DEFAULT_INTERVAL_MS;

  let pendingData: T | undefined;
  let hasPending = false;
  let timerId: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let writing = false;
  let queuedData: T | undefined;
  let hasQueued = false;

  let flushResolvers: (() => void)[] = [];

  async function doWrite(data: T): Promise<void> {
    writing = true;
    try {
      await write(data);
    } finally {
      writing = false;
    }

    if (hasQueued) {
      const nextData = queuedData as T;
      hasQueued = false;
      queuedData = undefined;
      await doWrite(nextData);
    }

    const resolvers = flushResolvers;
    flushResolvers = [];
    for (const resolve of resolvers) {
      resolve();
    }
  }

  function fire(): void {
    timerId = null;
    if (!hasPending) return;

    const data = pendingData as T;
    hasPending = false;
    pendingData = undefined;

    if (writing) {
      queuedData = data;
      hasQueued = true;
    } else {
      doWrite(data);
    }
  }

  function schedule(data: T): void {
    if (disposed) return;

    pendingData = data;
    hasPending = true;

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

    if (hasPending) {
      const data = pendingData as T;
      hasPending = false;
      pendingData = undefined;

      if (writing) {
        queuedData = data;
        hasQueued = true;
        return new Promise<void>((resolve) => {
          flushResolvers.push(resolve);
        });
      } else {
        await doWrite(data);
      }
    } else if (writing) {
      return new Promise<void>((resolve) => {
        flushResolvers.push(resolve);
      });
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;

    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }

    hasPending = false;
    pendingData = undefined;
  }

  return { schedule, flush, dispose };
}
