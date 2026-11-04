import { Cause, Effect, Exit, FiberMap, Queue, Scope } from "effect"

/** How one attempt's child ended: its value, its mapped error, or an
 *  interruption. */
export type WorkflowHostChildSettlement<A, E> = {
  readonly attemptId: string
} & (
  | { readonly kind: "value"; readonly value: A }
  | { readonly kind: "error"; readonly error: E }
  | { readonly kind: "interrupted" }
)

interface WorkflowHostChildController<A, E> {
  /** Start one attempt's child beside the children that run already. */
  fork(attemptId: string, run: (signal: AbortSignal) => Promise<A>, mapError: (error: unknown) => E): void
  /** The next child that ended, in the order the children ended. */
  next(): Promise<WorkflowHostChildSettlement<A, E>>
  /** The attempts whose children started and whose ends `next` has not
   *  returned yet. */
  inFlight(): ReadonlySet<string>
  /** Interrupt one attempt's child, or every child. */
  interrupt(attemptId?: string): void
  /** Wait until every child's worker promise settled. */
  settle(): Promise<void>
  /** Interrupt every child and release the controller's scope. */
  close(): Promise<void>
}

/** The children of one workflow host: one fiber per running attempt, keyed
 *  by attempt id in a FiberMap that the controller's scope owns, and one
 *  unbounded queue of their ends. The host forks every attempt that
 *  admission starts and then takes ends from the queue in the order the
 *  children end, so every attempt that waits on no other runs at once. */
export function createWorkflowHostChildController<A, E>(): WorkflowHostChildController<A, E> {
  const scope = Effect.runSync(Scope.make())
  const fibers = Effect.runSync(Scope.provide(FiberMap.make<string, void, never>(), scope))
  const ends = Effect.runSync(Queue.unbounded<WorkflowHostChildSettlement<A, E>>())
  const forked = new Set<string>()
  // Fiber interruption ends the child at once, so control commits while the
  // worker promise is still unwinding. Those promises stay retained here:
  // they, not the fibers, are the proof that worker-owned resources settled.
  const unsettled = new Set<Promise<void>>()

  function fork(attemptId: string, start: (signal: AbortSignal) => Promise<A>, mapError: (error: unknown) => E): void {
    if (forked.has(attemptId)) throw new Error(`Workflow host already runs attempt "${attemptId}"`)
    forked.add(attemptId)
    let settle = (): void => {}
    const settled = new Promise<void>((resolve) => { settle = resolve })
    unsettled.add(settled)
    const child = Effect.callback<A, E>((resume, signal) => {
      void start(signal).then(
        (value) => resume(Effect.succeed(value)),
        (error) => resume(Effect.fail(mapError(error))),
      ).finally(() => {
        unsettled.delete(settled)
        settle()
      })
    }).pipe(Effect.onExit((exit) => Queue.offer(ends, settlementOf(attemptId, exit, mapError))), Effect.asVoid, Effect.ignore)
    Effect.runSync(FiberMap.run(fibers, attemptId, child))
  }

  async function next(): Promise<WorkflowHostChildSettlement<A, E>> {
    const end = await Effect.runPromise(Queue.take(ends))
    forked.delete(end.attemptId)
    return end
  }

  return {
    fork,
    next,
    inFlight: () => forked,
    interrupt: (attemptId) => {
      Effect.runFork(attemptId === undefined ? FiberMap.clear(fibers) : FiberMap.remove(fibers, attemptId))
    },
    settle: async () => { await Promise.all(unsettled) },
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  }
}

/** One child's end. A defect, such as a worker that throws before it
 *  returns a promise, ends the child with its mapped error, so the host
 *  always receives the end. */
function settlementOf<A, E>(attemptId: string, exit: Exit.Exit<A, E>, mapError: (error: unknown) => E): WorkflowHostChildSettlement<A, E> {
  if (Exit.isSuccess(exit)) return { attemptId, kind: "value", value: exit.value }
  if (Cause.hasInterruptsOnly(exit.cause)) return { attemptId, kind: "interrupted" }
  const error = Cause.findError(exit.cause)
  return { attemptId, kind: "error", error: error._tag === "Success" ? error.success : mapError(Cause.squash(exit.cause)) }
}
