/**
 * Debounced Writer Utility
 *
 * Generic debounced write mechanism with in-flight write serialization.
 * Multiple rapid `schedule()` calls coalesce into a single write after
 * the debounce interval. Concurrent writes are prevented via a boolean
 * guard — if a write is in-flight, the next one queues and runs after.
 *
 * Usage:
 *   const writer = createDebouncedWriter(writeFn, { intervalMs: 5000 });
 *   writer.schedule(data);      // debounced
 *   await writer.flush();       // force-write now
 *   writer.dispose();           // cancel + cleanup
 */

// Types

interface DebouncedWriterOpts {
  /** Debounce interval in ms. Default: 5000. */
  intervalMs?: number;
}

export interface DebouncedWriter<T> {
  /** Schedule a debounced write with the given data. */
  schedule(data: T): void;
  /** Force-write pending data immediately. Returns when write completes. */
  flush(): Promise<void>;
  /** Cancel pending timer. Does NOT flush. */
  dispose(): void;
}

// Factory

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

  // Resolve chain for flush() callers waiting on in-flight writes
  let flushResolvers: (() => void)[] = [];

  async function doWrite(data: T): Promise<void> {
    writing = true;
    try {
      await write(data);
    } finally {
      writing = false;
    }

    // Process queued write if any
    if (hasQueued) {
      const nextData = queuedData as T;
      hasQueued = false;
      queuedData = undefined;
      await doWrite(nextData);
    }

    // Resolve any flush() waiters
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
      // Queue it — doWrite will pick it up
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

    // Reset debounce timer
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
        // Queue and wait
        queuedData = data;
        hasQueued = true;
        return new Promise<void>((resolve) => {
          flushResolvers.push(resolve);
        });
      } else {
        await doWrite(data);
      }
    } else if (writing) {
      // Wait for current in-flight write to finish
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

    // Do NOT flush — dispose is cancel-only
    hasPending = false;
    pendingData = undefined;
  }

  return { schedule, flush, dispose };
}
