import { Cause, Effect, Exit, Queue } from "effect";

/** Reads a queue as an async iterable that ends with the queue and throws its failure. A query's prompt and the
 *  events of one admitted request reach their readers this way. An optional signal ends a pending read without
 *  interrupting the owner that still closes the engine safely. */
export function queueIterable<A>(queue: Queue.Dequeue<A, Error | Cause.Done>, signal?: AbortSignal): AsyncIterable<A> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: async (): Promise<IteratorResult<A>> => {
        const exit = await Effect.runPromiseExit(Queue.take(queue), { signal });
        signal?.throwIfAborted();
        if (Exit.isSuccess(exit)) return { done: false, value: exit.value };
        const failure = Cause.squash(exit.cause);
        if (Cause.isDone(failure)) return { done: true, value: undefined };
        throw failure instanceof Error ? failure : new Error(String(failure));
      },
    }),
  };
}
