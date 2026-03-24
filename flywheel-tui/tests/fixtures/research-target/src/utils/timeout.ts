/**
 * Timeout utility — wraps promises with a timeout boundary.
 *
 * Used by the Scheduler to enforce per-task timeout limits.
 * Throws a TimeoutError when the deadline is exceeded.
 */

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`Operation timed out after ${ms}ms`);
    this.name = "TimeoutError";
  }
}

/**
 * Wrap a promise with a timeout. If the promise doesn't resolve
 * within the given milliseconds, rejects with TimeoutError.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new TimeoutError(ms));
    }, ms);

    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

/**
 * Create an AbortSignal that fires after the given milliseconds.
 */
export function createTimeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(new TimeoutError(ms)), ms);
  return controller.signal;
}
