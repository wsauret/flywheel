/**
 * Bridges one external Promise into the Effect world so a fiber owns it.
 *
 * An external Promise (the agent loop, a provider stream, any foreign async
 * boundary) cannot be interrupted: it can only be asked to stop through an
 * AbortSignal and then observed until it really settles. Interrupting the fiber
 * that awaits it proves nothing about the work itself, so the bridge splits the
 * two: the fiber's interruption fires the signal, and the scope does not release
 * until the Promise has settled for real. `settlement()` is what the work
 * actually did on its way out, which an interrupted fiber's own exit has
 * discarded.
 */

import { Effect, Exit } from "effect";

export interface ExternalPromiseBridge<A> {
  /** Effect that owns the work for the length of one fiber: it succeeds with
   *  the work's value, dies on its rejection, and on interruption it fires the
   *  work's abort signal and completes only once the work is settled. */
  readonly owned: Effect.Effect<A>;
  /** Asks the work to stop, now and without waiting: fires its abort signal.
   *  Idempotent, and a no-op once the work has settled, so finished work never
   *  looks aborted. Interrupting the owning fiber calls this too; a caller that
   *  needs the signal fired at a definite moment calls it directly, because
   *  fiber interruption is scheduled, not immediate. */
  stop(): void;
  /** The work's own settlement, or null while it has none. Non-null by the time
   *  `owned` completes for any reason except a failure to start. */
  settlement(): Exit.Exit<A> | null;
}

export function bridgeExternalPromise<A>(start: (signal: AbortSignal) => Promise<A>): ExternalPromiseBridge<A> {
  const abort = new AbortController();
  let settlement: Exit.Exit<A> | null = null;
  let settled: Promise<void> = Promise.resolve();

  const acquire = Effect.sync(() => {
    const work = start(abort.signal).then(
      (value) => {
        settlement = Exit.succeed(value);
        return value;
      },
      (error) => {
        // oxlint-disable-next-line flywheel/no-effect-escape-hatch -- boundary: an opaque Promise rejection at the external edge has no typed channel; record it as a defect so the fiber's owner sees it instead of a forever-pending await.
        settlement = Exit.die(error);
        throw error;
      },
    );
    settled = work.then(() => {}, () => {});
    return work;
  });

  const stop = (): void => {
    // Already settled: firing the signal now would make naturally finished
    // work look aborted to everything that still holds the signal.
    if (settlement === null) abort.abort();
  };

  return {
    owned: Effect.acquireUseRelease(
      acquire,
      (work) => Effect.promise(() => work),
      () => Effect.promise(async () => {
        stop();
        await settled;
      }),
    ),
    stop,
    settlement: () => settlement,
  };
}
