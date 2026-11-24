import { normalizeProviderAttemptFailure } from "./provider-failure.js";

/** Invoke one provider SDK operation and normalize only failures raised by that
 * invocation. Code that consumes or converts the returned value stays outside
 * this boundary. A provider-specific failure handler may classify SDK errors;
 * errors raised by that handler propagate unchanged. */
export async function invokeProviderAttempt<Value>(
  invoke: () => Value | PromiseLike<Value>,
  onFailure: (error: unknown) => never = (error) => { throw normalizeProviderAttemptFailure(error); },
): Promise<Value> {
  try {
    return await invoke();
  } catch (error) {
    onFailure(error);
  }
}

/** Wrap one provider SDK iterator so only `next` failures are normalized.
 * `return` and `throw` pass through unchanged to preserve SDK cleanup and
 * caller-owned cancellation semantics. The optional failure handler runs only
 * when the SDK's next operation rejects. */
export function normalizeProviderAttemptIterator<Value>(
  source: AsyncIterable<Value>,
  onFailure: (error: unknown) => never = (error) => { throw normalizeProviderAttemptFailure(error); },
): AsyncIterableIterator<Value> {
  const iterator = source[Symbol.asyncIterator]();

  return {
    async next(...args) {
      try {
        return await iterator.next(...args);
      } catch (error) {
        onFailure(error);
      }
    },
    return: iterator.return?.bind(iterator) ?? (async (value) => ({ value, done: true })),
    throw: iterator.throw?.bind(iterator) ?? (async (error) => { throw error; }),
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}
