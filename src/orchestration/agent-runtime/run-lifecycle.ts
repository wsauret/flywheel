import { Deferred, Effect, Exit, Fiber, Scope, SynchronizedRef } from "effect";
import { bridgeExternalPromise, type ExternalPromiseBridge } from "./external-promise-bridge.js";
import { closeScopedAbortSignal, createScopedAbortSignal } from "./scoped-abort-signal.js";

/** One model turn, owned by the run that opened it. */
export interface OwnedTurn {
  /** This turn's interrupt signal: it fires on ESC, on run abort, and when the
   *  turn ends. The only bridge from the turn's lifetime into the Promise-shaped
   *  provider and tool APIs the turn drives. */
  readonly signal: AbortSignal;
  /** Scope of this turn's foreground work. Every foreground tool fiber forks
   *  into it, so ending the turn interrupts and awaits all of them. */
  readonly scope: Scope.Scope;
  /** Runs this turn's settlement as the turn's own child fiber and resolves
   *  with what that settlement produced. The child is interruptible, so ESC
   *  reaches it and a run abort reaches it through the run's scope.
   *
   *  `work` receives the publisher its terminal phase calls from inside its own
   *  uninterruptible region: an interrupt requested during the turn is
   *  delivered the moment the fiber becomes interruptible again and poisons the
   *  fiber's exit, so a published settlement is the only one that survives an
   *  interrupted turn. Without a publication, the fiber's exit is the result. */
  settle<A, E = never>(work: (publish: (settled: A) => void) => Effect.Effect<A, E>): Promise<A>;
  /** Ends the turn: fires the signal, then interrupts and awaits every fiber in
   *  the turn scope, so nothing this turn started is still writing when it
   *  resolves. Idempotent. */
  end(): Promise<void>;
}

export interface CurrentTurnInterruption {
  beginTurn(): OwnedTurn;
  /** ESC: interrupts the current turn's child fiber and leaves the run alive.
   *  During a live run, an interrupt that finds no open turn, or finds the
   *  current turn already interrupted, carries into the next turn, which
   *  opens interrupted: the person's latest decision wins even when it lands
   *  between a Resume and the turn the Resume opens. False when no run is
   *  live, the run is being aborted, or an interrupt is already carried.
   *  It never waits: no transition holds the run's state across async work. */
  interrupt(): boolean;
  /** A person handed the turn back (a Resume or a message) after an
   *  interrupt: an interrupt carried from before that hand-back is stale and
   *  must not cut the work the person just authorized. */
  discardPendingInterrupt(): void;
}

interface ActiveTurn {
  readonly handle: OwnedTurn;
  interrupt(): boolean;
  end(): Promise<void>;
}

interface RunningState<A> {
  readonly tag: "running";
  readonly done: Deferred.Deferred<A>;
  readonly fiber: Fiber.Fiber<A>;
  readonly bridge: ExternalPromiseBridge<A>;
  /** Scope the run fiber owns. Every turn scope is a child of it, so a run
   *  abort closes the turns it still has open. */
  readonly runScope: Scope.Closeable;
  readonly currentTurn: ActiveTurn | null;
  /** Set by the first `abort()`; also the idempotency mark, since a second
   *  abort must not interrupt an already-interrupted fiber again. */
  readonly abortResult: { readonly value: A } | null;
  /** Escape can arrive when no live turn can take it: before the first turn
   *  opens, or after the current turn was already interrupted and before the
   *  next one opens. The next turn opens interrupted. */
  readonly interruptPending: boolean;
}

type RunState<A> =
  | { readonly tag: "idle"; readonly done: Deferred.Deferred<A> }
  | RunningState<A>
  | { readonly tag: "done"; readonly done: Deferred.Deferred<A> };

/**
 * Owns one run's liveness as a fiber tree: the retained run fiber is the
 * parent, each turn is a scoped child of it, and each foreground tool fiber is
 * a child of its turn.
 *
 * `start` hands the run's external Promise to that fiber through the bridge,
 * and `abort()` interrupts it. Interruption fires the run's abort signal and
 * the bridge holds the fiber open until the loop has really unwound, so `done`
 * settles only after owned cleanup - the run body, then every turn scope still
 * attached to the run - which is the settlement contract callers rely on before
 * disposing durable writers. `done` carries the run's own settlement whenever
 * it produced one, so an aborted run reports what the loop actually did on its
 * way out; a rejected run settles `done` with that rejection, so a defect is
 * loud at the caller instead of a silently pending promise.
 *
 * `interrupt()` (ESC) reaches the current turn's child fiber and nothing above
 * it, so an interrupted turn leaves the run alive and resumable.
 */
export class RunLifecycle<A> implements CurrentTurnInterruption {
  readonly done: Promise<A>;

  private readonly deferred = Deferred.makeUnsafe<A>();
  private readonly state = SynchronizedRef.makeUnsafe<RunState<A>>({ tag: "idle", done: this.deferred });

  constructor() {
    this.done = Effect.runPromise(Deferred.await(this.deferred));
  }

  start(run: (signal: AbortSignal) => Promise<A>): boolean {
    return Effect.runSync(SynchronizedRef.modifyEffect(this.state, (state) => {
      if (state.tag !== "idle") return Effect.succeed([false, state] as const);

      // The run body calls back into this lifecycle (`beginTurn` on its way to
      // the first request), so it must not execute inside the transition that
      // claims the slot: defer it one microtask, past `start` returning.
      const bridge = bridgeExternalPromise((signal) => Promise.resolve().then(() => run(signal)));
      const runScope = Scope.makeUnsafe("sequential");
      const fiber = Effect.runFork(bridge.owned.pipe(
        // Ordered cleanup before settlement: the run body settles first, then
        // every turn scope the run still owns closes, and only then does
        // `done` report the run's terminal.
        Effect.ensuring(Scope.close(runScope, Exit.void)),
        Effect.onExit((exit) => this.settle(exit)),
      ));
      return Effect.succeed([true, { tag: "running", done: state.done, fiber, bridge, runScope, currentTurn: null, abortResult: null, interruptPending: false }] as const);
    }));
  }

  /** Request the run stop. Running: interrupts the run fiber and returns;
   *  `done` settles when the loop finishes unwinding. Idle: settles `done`
   *  with `abortResult` directly, since no run will ever produce one. */
  abort(abortResult: A): void {
    const ref = this.state;
    Effect.runFork(Effect.gen(function* () {
      const target = yield* SynchronizedRef.modifyEffect(ref, (state): Effect.Effect<readonly [{ readonly fiber: Fiber.Fiber<A>; readonly turn: ActiveTurn | null } | null, RunState<A>]> => {
        switch (state.tag) {
          case "idle":
            return Effect.gen(function* () {
              yield* Deferred.complete(state.done, Effect.succeed(abortResult));
              return [null, { tag: "done", done: state.done }] as const;
            });
          case "running": {
            if (state.abortResult) return Effect.succeed([null, state] as const);
            // Fire the run's signal here, not through the interruption: the
            // loop must observe the durable abort at a definite moment to
            // classify its exit as aborted rather than merely interrupted.
            // The turn stays current: a run body that returns on the signal
            // settles before this abort's end of the turn has closed it, and
            // `settle` must then wait for that same end.
            return Effect.sync(() => {
              state.bridge.stop();
              return [{ fiber: state.fiber, turn: state.currentTurn }, { ...state, abortResult: { value: abortResult } }] as const;
            });
          }
          case "done":
            return Effect.succeed([null, state] as const);
        }
      });
      if (!target) return;
      // Outside the transition, not detached: the turn's end waits for every
      // fiber the turn owns, which can take as long as a tool takes to stop,
      // and the transitions ESC and the loop run synchronously must never
      // wait behind it. Interrupting the run fiber runs its cleanup, which
      // settles `done` through this same state, so awaiting it while still
      // holding the transition would deadlock against it.
      const { fiber, turn } = target;
      if (turn) yield* Effect.promise(() => turn.end());
      yield* Fiber.interrupt(fiber);
    }));
  }

  beginTurn(): OwnedTurn {
    return Effect.runSync(SynchronizedRef.modifyEffect(this.state, (state) => {
      // A turn opened with no live run above it is its own root: one turn
      // implementation, so the settlement has exactly one ownership path.
      if (state.tag !== "running") return Effect.succeed([openStandaloneTurn(), state] as const);
      const turn = openTurn(state.runScope);

      const previous = state.currentTurn;
      return Effect.sync(() => {
        // The loop ends each turn before it opens the next; this covers a
        // caller that did not, and the previous turn's own scope owns that wait.
        if (previous) void previous.end();
        if (state.interruptPending) turn.interrupt();
        return [turn.handle, { ...state, currentTurn: turn, interruptPending: false }] as const;
      });
    }));
  }

  interrupt(): boolean {
    return Effect.runSync(SynchronizedRef.modifyEffect(this.state, (state) => {
      // An aborted run is ending its turn itself and opens no other one.
      if (state.tag !== "running" || state.abortResult) return Effect.succeed([false, state] as const);
      return Effect.sync((): readonly [boolean, RunState<A>] => {
        if (state.currentTurn?.interrupt()) return [true, state];
        if (state.interruptPending) return [false, state];
        return [true, { ...state, interruptPending: true }];
      });
    }));
  }

  discardPendingInterrupt(): void {
    Effect.runSync(SynchronizedRef.update(this.state, (state) => state.tag === "running" && state.interruptPending ? { ...state, interruptPending: false } : state));
  }

  /** The run is done from the moment its fiber exits; `done` reports it
   *  once the current turn has ended, outside the transition, like abort's
   *  end of the turn. `end()` is idempotent, so a turn an abort is already
   *  ending is awaited, not ended twice. */
  private settle(exit: Exit.Exit<A>): Effect.Effect<void> {
    const ref = this.state;
    return Effect.gen(function* () {
      const settled = yield* SynchronizedRef.modify(ref, (state): readonly [{ readonly state: RunningState<A>; readonly result: Effect.Effect<A> } | null, RunState<A>] => state.tag === "running"
        ? [{ state, result: runSettlement(state, exit) }, { tag: "done", done: state.done }] as const
        : [null, state] as const);
      if (!settled) return;
      const turn = settled.state.currentTurn;
      if (turn) yield* Effect.promise(() => turn.end());
      yield* Deferred.complete(settled.state.done, settled.result);
    });
  }
}

/** A turn with no run above it, for a loop driven without a run lifecycle. */
export function openStandaloneTurn(): OwnedTurn {
  return openTurn(Scope.makeUnsafe("sequential")).handle;
}

/** One turn: an abort signal for the Promise APIs it drives, a scope for the
 *  fibers it owns, and one child fiber that runs its settlement. */
function openTurn(parent: Scope.Scope): ActiveTurn {
  // The signal has its own scope so it can fire at a definite moment - ESC, or
  // the turn's end - without closing the scope that owns the turn's fibers.
  const interruptSignal = createScopedAbortSignal();
  // A child of the run's scope: a run abort closes it, and ending the turn
  // detaches it, so a long run does not accumulate finished turns.
  const scope = Scope.forkUnsafe(parent, "sequential");
  let child: Fiber.Fiber<unknown, unknown> | null = null;
  let ending: Promise<void> | null = null;

  const end = (): Promise<void> => {
    ending ??= Effect.runPromise(Effect.gen(function* () {
      // Signal first, close second: every tool bridged to this signal learns
      // the turn is over at a definite moment, and the close then interrupts
      // and awaits the turn's child and its foreground fibers.
      yield* closeScopedAbortSignal(interruptSignal);
      yield* Scope.close(scope, Exit.void);
    }));
    return ending;
  };

  return {
    handle: {
      signal: interruptSignal.signal,
      scope,
      settle<T, E>(work: (publish: (settled: T) => void) => Effect.Effect<T, E>): Promise<T> {
        let published: { readonly value: T } | null = null;
        const fiber = Effect.runSync(Effect.forkIn(work((settled) => { published = { value: settled }; }), scope));
        child = fiber;
        // The published settlement beats the fiber's exit: an interrupt landing
        // at the terminal phase's boundary discards the fiber's value, never
        // what the turn already settled durably.
        return Effect.runPromise(Fiber.await(fiber).pipe(
          Effect.flatMap((exit) => published ? Effect.succeed(published.value) : exit),
        ));
      },
      end,
    },
    interrupt: () => {
      if (interruptSignal.signal.aborted) return false;
      Effect.runSync(closeScopedAbortSignal(interruptSignal));
      // Not awaited: ESC must return to the UI immediately, and the turn's own
      // settlement is what reports the interrupted turn to the loop.
      if (child) Effect.runFork(Fiber.interrupt(child));
      return true;
    },
    end,
  };
}

/** What `done` reports. The run's own settlement wins whenever it has one: an
 *  aborted run states its own terminal, not the synthetic abort result. The
 *  abort result covers the run that never produced a settlement at all, and
 *  the fiber's exit covers a run that could not start. */
function runSettlement<A>(state: RunningState<A>, exit: Exit.Exit<A>): Effect.Effect<A> {
  const settlement = state.bridge.settlement();
  if (settlement !== null) return settlement;
  if (state.abortResult) return Effect.succeed(state.abortResult.value);
  return exit;
}