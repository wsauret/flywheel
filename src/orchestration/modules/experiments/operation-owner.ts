import type { InFlightRecord, InFlightWrite, StoredFact } from "../../../infra/event-store-types.js"
import { createOrderedLane } from "../../../infra/ordered-lane.js"
import type { ExperimentCommandResult } from "./experiment-command-runner.js"
import type { ExperimentFact } from "./facts.js"

export const EXPERIMENT_OPERATION_KIND = "experiment.operation"
export const EXPERIMENT_GIT_SETTLEMENT_KIND = "experiment.git_settlement"
const EXPERIMENT_OPERATION_KEY = "run"
const INTERRUPTION_KINDS = [EXPERIMENT_OPERATION_KIND, EXPERIMENT_GIT_SETTLEMENT_KIND]

/** Retires the live run's hold in the commit of the fact that records its outcome. */
export const EXPERIMENT_OPERATION_RETIREMENT: readonly InFlightWrite[] = [{ op: "drop", kind: EXPERIMENT_OPERATION_KIND, key: EXPERIMENT_OPERATION_KEY }]

export const experimentInterruptionMessage = "Experiment work was interrupted with an unresolved operation. Inspect the experiment worktree, then run /experiment clear discard to discard the operation and leave the worktree as it is. The runtime will not rerun, revert, commit, or discard it by itself."

/** One command result bound to the exact candidate content measured by it. */
export interface PendingExperimentResult extends ExperimentCommandResult {
  readonly measuredTree: string
  readonly resultTree: string
}

/** The hold is durable exactly while the state is `running`, `pending`, or
 *  `interrupted`. `abandoned` is a stopped run whose command still executes. */
export type ExperimentOperationState<Pending> =
  | { readonly status: "idle" }
  | { readonly status: "running"; readonly command: string }
  | { readonly status: "pending"; readonly value: Pending }
  | { readonly status: "abandoned"; readonly command: string }
  | { readonly status: "interrupted" }

type ExperimentOperationEvent<Pending> =
  | { readonly type: "opened"; readonly hold: boolean }
  | { readonly type: "began"; readonly command: string }
  | { readonly type: "measured"; readonly value: Pending }
  | { readonly type: "failed" }
  | { readonly type: "settled" }
  | { readonly type: "stopped" }

/** The one transition of the operation. An event that does not apply to the
 *  current state returns it unchanged. */
function transition<Pending>(state: ExperimentOperationState<Pending>, event: ExperimentOperationEvent<Pending>): ExperimentOperationState<Pending> {
  switch (event.type) {
    case "opened": return event.hold && state.status === "idle" ? { status: "interrupted" } : state
    case "began": return state.status === "idle" ? { status: "running", command: event.command } : state
    case "measured":
      if (state.status === "running") return { status: "pending", value: event.value }
      return state.status === "abandoned" ? { status: "idle" } : state
    case "failed":
      if (state.status === "running" || state.status === "pending") return { status: "interrupted" }
      return state.status === "abandoned" ? { status: "idle" } : state
    case "settled": return state.status === "pending" ? { status: "idle" } : state
    case "stopped":
      if (state.status === "running") return { status: "abandoned", command: state.command }
      return state.status === "pending" || state.status === "interrupted" ? { status: "idle" } : state
  }
}

/** How a settlement ended: its run fact retired the hold, it refused and keeps
 *  the result for a corrected call, or its outcome is unknown. */
type ExperimentSettleOutcome = "settled" | "kept-pending" | "unresolved"

interface ExperimentOperationDependencies {
  readonly listInFlight: (kinds: readonly string[]) => Promise<readonly InFlightRecord[]>
  readonly putInFlight: (kind: string, key: string, payload: unknown) => Promise<void>
  /** The runner's `SessionFactWriter.record`: `null` means nothing was written. */
  readonly record: (fact: ExperimentFact, inFlight?: readonly InFlightWrite[]) => Promise<StoredFact | null>
}

export interface ExperimentOperation<Pending = PendingExperimentResult> {
  snapshot(): ExperimentOperationState<Pending>
  subscribe(listener: (state: ExperimentOperationState<Pending>) => void): () => void
  /** The interruption message while a hold blocks new work. Rejects when the
   *  hold read fails; the next call reads again. */
  blocker(): Promise<string | undefined>
  /** Runs `admit` and writes the hold before it moves to `running`, and
   *  answers what `admit` returned. Rejects with the refusal when work is
   *  interrupted or not idle, or when `admit` or the hold write rejects. */
  begin<Admitted extends { readonly command: string; readonly cwd: string }>(admit: () => Promise<Admitted>): Promise<Admitted>
  measured(value: Pending): void
  failed(): void
  /** Runs `work` on the pending result and answers its result. Rejects with
   *  the refusal when no result is pending; a rejection of `work` moves the
   *  operation to `interrupted`, as an `unresolved` outcome does. */
  settle<T>(work: (pending: Pending) => Promise<{ readonly outcome: ExperimentSettleOutcome; readonly result: T }>): Promise<T>
  /** Records leaving experiment mode and, in the same commit, retires the hold
   *  of a live run. With `discard`, it also retires the holds of interrupted
   *  work, which only the person confirms. Applies the stop only after the
   *  store acknowledged the fact, which it answers; rejects with nothing
   *  changed when the write is refused or unacknowledged. */
  stop(workDir: string | null, discard?: boolean): Promise<StoredFact>
}

/** The read side a chat runner exposes to protocol projections. */
export type ExperimentOperationView = Pick<ExperimentOperation<unknown>, "snapshot" | "subscribe">

/** Owns a runner's experiment operation: its state, its durable hold, and the
 *  writes that retire the hold. Durable transitions run in one lane, so a stop
 *  never interleaves with an admission or a settlement. */
export function createExperimentOperation<Pending = PendingExperimentResult>(deps: ExperimentOperationDependencies): ExperimentOperation<Pending> {
  let state: ExperimentOperationState<Pending> = { status: "idle" }
  const listeners = new Set<(state: ExperimentOperationState<Pending>) => void>()
  const apply = (event: ExperimentOperationEvent<Pending>): void => {
    const next = transition(state, event)
    if (next === state) return
    state = next
    for (const listener of listeners) listener(next)
  }
  // Read on first use, so a runner that never runs an experiment reads
  // nothing, and every rejection reaches the call that awaits it. Every
  // durable transition opens before this owner writes its own row, so the
  // first read still sees only what the runner opened with.
  let atOpen: Promise<void> | undefined
  const opened = (): Promise<void> => {
    atOpen ??= deps.listInFlight(INTERRUPTION_KINDS).then(
      (rows) => apply({ type: "opened", hold: rows.length > 0 }),
      (error: unknown) => {
        atOpen = undefined
        throw error
      },
    )
    return atOpen
  }
  const refuseInterrupted = (): void => {
    if (state.status === "interrupted") throw new Error(experimentInterruptionMessage)
  }
  const lane = createOrderedLane()

  return {
    snapshot: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async blocker() {
      await opened()
      return state.status === "interrupted" ? experimentInterruptionMessage : undefined
    },
    begin: (admit) => lane.run(async () => {
      await opened()
      refuseInterrupted()
      if (state.status !== "idle") throw new Error("Experiment execution is not idle.")
      const admitted = await admit()
      await deps.putInFlight(EXPERIMENT_OPERATION_KIND, EXPERIMENT_OPERATION_KEY, { state: "running", command: admitted.command, cwd: admitted.cwd })
      apply({ type: "began", command: admitted.command })
      return admitted
    }),
    measured: (value) => apply({ type: "measured", value }),
    failed: () => apply({ type: "failed" }),
    settle: (work) => lane.run(async () => {
      await opened()
      refuseInterrupted()
      if (state.status !== "pending") throw new Error("No experiment result is pending.")
      let settled: Awaited<ReturnType<typeof work>>
      try {
        settled = await work(state.value)
      } catch (error) {
        apply({ type: "failed" })
        throw error
      }
      if (settled.outcome === "settled") apply({ type: "settled" })
      if (settled.outcome === "unresolved") apply({ type: "failed" })
      return settled.result
    }),
    // The retirement is decided from the state at entry: `measured` or
    // `failed` can still move `running` while the write is in flight, and
    // `stopped` accepts either successor. An ordinary stop never opens the
    // owner, so a hold left by an ended process stays until it is discarded.
    stop: (workDir, discard = false) => lane.run(async () => {
      const live = state.status === "running" || state.status === "pending"
      if (!live && discard) await opened()
      const retirement = live
        ? EXPERIMENT_OPERATION_RETIREMENT
        : discard && state.status === "interrupted"
          ? await experimentInterruptionRetirement(deps.listInFlight)
          : undefined
      const stored = await deps.record({ type: "experiment.mode.changed", version: 1, actor: "flywheel", payload: { active: false, workDir } }, retirement)
      if (!stored) throw new Error("Experiment mode could not be recorded.")
      if (retirement) apply({ type: "stopped" })
      return stored
    }),
  }
}

/** Reports unresolved experiment work without mutating or interpreting it. */
export function findExperimentInterruption(
  listInFlight: (kinds: readonly string[]) => Promise<readonly InFlightRecord[]>,
): Promise<string | undefined> {
  return listInFlight(INTERRUPTION_KINDS).then((rows) => rows.length > 0
    ? experimentInterruptionMessage
    : undefined)
}

/** The drop of every hold of unresolved experiment work, for the stop that
 *  the person confirmed with `/experiment clear discard`. */
export async function experimentInterruptionRetirement(
  listInFlight: (kinds: readonly string[]) => Promise<readonly InFlightRecord[]>,
): Promise<InFlightWrite[]> {
  return (await listInFlight(INTERRUPTION_KINDS)).map((row): InFlightWrite => ({ op: "drop", kind: row.kind, key: row.key }))
}
