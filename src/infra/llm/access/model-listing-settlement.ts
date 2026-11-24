/** Runs listing tasks with bounded concurrency and an optional settlement deadline. The caller's own abort discards every result. Audits omit the deadline and use their provider-owned probe bounds. */
export async function settleTasks<T>(tasks: readonly ((signal: AbortSignal) => Promise<T>)[], callerSignal: AbortSignal | undefined, timeoutMs: number | undefined, concurrency: number): Promise<readonly T[]> {
  const timeout = new AbortController();
  const signal = callerSignal === undefined
    ? timeout.signal
    : AbortSignal.any([callerSignal, timeout.signal]);
  const timer = timeoutMs === undefined ? undefined : setTimeout(
    () => timeout.abort(new DOMException("Model listing settlement timed out", "TimeoutError")),
    timeoutMs,
  );
  const results: T[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const task = tasks[next];
      next += 1;
      if (!task) continue;
      try {
        const result = await task(signal);
        if (!callerSignal?.aborted) results.push(result);
      } catch (error) {
        if (!signal.aborted || timeout.signal.aborted && !callerSignal?.aborted) throw error;
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
    return results;
  } finally {
    clearTimeout(timer);
  }
}
