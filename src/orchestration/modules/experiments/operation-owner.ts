import { Schema } from "effect"
import type { InFlightRecord, InFlightWrite, StoredFact } from "../../../infra/event-store-types.js"
import { Log } from "../../../infra/log.js"
import { createOrderedLane } from "../../../infra/ordered-lane.js"
import { coalesceRepeats } from "../../../infra/repeat-coalescer.js"
import type { ExperimentFact } from "./facts.js"

export const EXPERIMENT_OPERATION_KIND = "experiment.operation"
export const EXPERIMENT_GIT_SETTLEMENT_KIND = "experiment.git_settlement"
const EXPERIMENT_OPERATION_KEY = "run"
const INTERRUPTION_KINDS = [EXPERIMENT_OPERATION_KIND, EXPERIMENT_GIT_SETTLEMENT_KIND]
const log = Log.create({ service: "experiment-operation" })

/** Retires the live run's hold in the commit of the fact that records its outcome. */
export const EXPERIMENT_OPERATION_RETIREMENT: readonly InFlightWrite[] = [{ op: "drop", kind: EXPERIMENT_OPERATION_KIND, key: EXPERIMENT_OPERATION_KEY }]

export const experimentInterruptionMessage = "Experiment work was interrupted with an unresolved operation. Inspect the experiment worktree, then run /experiment clear discard to discard the operation and leave the worktree as it is. The runtime will not rerun, revert, commit, or discard it by itself."

/** What a settlement reads of one measurement, bound to the exact candidate
 *  content it measured. It is also the durable `pending` hold's result, so a
 *  reopened runner settles the same value. */
const PendingExperimentResultSchema = Schema.Struct({
  status: Schema.Union([Schema.Literal("passed"), Schema.Literal("measurement_failed"), Schema.Literal("checks_failed")]),
  metrics: Schema.Record(Schema.String, Schema.Finite),
  durationMs: Schema.Number,
  measuredTree: Schema.String,
  resultTree: Schema.String,
})
export type PendingExperimentResult = typeof PendingExperimentResultSchema.Type

/** The `experiment.operation` hold, the durable image of the operation
 *  state. `running` is a measurement whose outcome is unknown, `settling` the
 *  Git work of a settlement. Only `pending` is safe to continue after a
 *  restart: nothing touched the worktree since `resultTree` was captured, and
 *  the settlement checks that again. */
const OperationHoldSchema = Schema.Union([
  Schema.Struct({ state: Schema.Literal("running") }),
  Schema.Struct({ state: Schema.Literal("pending"), result: PendingExperimentResultSchema }),
  Schema.Struct({ state: Schema.Literal("settling") }),
])
type OperationHold = typeof OperationHoldSchema.Type
const strict = { onExcessProperty: "error" } as const
const decodeHold = Schema.decodeUnknownOption(OperationHoldSchema, strict)
const encodeHold = Schema.decodeUnknownSync(OperationHoldSchema, strict)

// Every release up to 0.1.3 wrote the measurement's hold with its command and
// working directory, which no reader used: the charter's measure command and
// the mode's work directory are facts. It means what `running` means.
// Remove this conversion after 2027-05-08; a row of it then reads as an
// unknown shape, which is interrupted too.
const PreviousRunningHoldSchema = Schema.Struct({ state: Schema.Literal("running"), command: Schema.String, cwd: Schema.String })
const decodePreviousRunningHold = Schema.decodeUnknownOption(PreviousRunningHoldSchema, strict)

/** The hold a row holds, in its current shape, or `undefined` for a shape no
 *  release writes. Strict, so the previous shape takes its conversion. */
function readHold(payload: unknown): OperationHold | undefined {
  const current = decodeHold(payload)
  if (current._tag === "Some") return current.value
  return decodePreviousRunningHold(payload)._tag === "Some" ? { state: "running" } : undefined
}

// Every reader of an unchanged unknown row meets it again: a runner open, each
// stop, and each interruption check. One row is one condition, keyed by its
// bytes, so it records once and its repeats as one count per window.
const unknownHolds = coalesceRepeats<number>({
  windowMs: 60 * 60 * 1000,
  first: (_row, bytes) => { log.warn("experiment operation hold has an unknown shape; it stays interrupted", { bytes }) },
  repeated: (_row, repeats) => { log.warn("experiment operation hold has an unknown shape again", { count: repeats.count, windowMs: repeats.windowMs }) },
})

type HeldWork =
  | { readonly status: "none" }
  | { readonly status: "pending"; readonly value: PendingExperimentResult }
  | { readonly status: "interrupted" }

/** The one reading of the holds a runner opens with, for the owner and for
 *  the commands that run without a live runner. Anything but one readable
 *  `pending` hold is interrupted work. */
function heldWork(rows: readonly InFlightRecord[]): HeldWork {
  const [row] = rows
  if (row === undefined) return { status: "none" }
  if (rows.length !== 1 || row.kind !== EXPERIMENT_OPERATION_KIND) return { status: "interrupted" }
  const hold = readHold(row.payload)
  if (hold === undefined) {
    unknownHolds.observe(`${row.kind}:${row.key}:${Bun.hash(row.raw).toString(16)}`, row.raw.length)
    return { status: "interrupted" }
  }
  return hold.state === "pending" ? { status: "pending", value: hold.result } : { status: "interrupted" }
}

/** The hold is durable exactly while the state is `running`, `pending`, or
 *  `interrupted`. `abandoned` is a stopped run whose command still executes. */
export type ExperimentOperationState =
  | { readonly status: "idle" }
  | { readonly status: "running"; readonly command: string }
  | { readonly status: "pending"; readonly value: PendingExperimentResult }
  | { readonly status: "abandoned"; readonly command: string }
  | { readonly status: "interrupted" }

type ExperimentOperationEvent =
  | { readonly type: "opened"; readonly held: HeldWork }
  | { readonly type: "began"; readonly command: string }
  | { readonly type: "measured"; readonly value: PendingExperimentResult }
  | { readonly type: "failed" }
  | { readonly type: "settled" }
  | { readonly type: "stopped" }

/** The one transition of the operation. An event that does not apply to the
 *  current state returns it unchanged. */
function transition(state: ExperimentOperationState, event: ExperimentOperationEvent): ExperimentOperationState {
  switch (event.type) {
    case "opened":
      if (state.status !== "idle" || event.held.status === "none") return state
      return event.held.status === "pending" ? { status: "pending", value: event.held.value } : { status: "interrupted" }
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

type ListInFlight = (kinds: readonly string[]) => Promise<readonly InFlightRecord[]>

interface ExperimentOperationDependencies {
  readonly listInFlight: ListInFlight
  readonly putInFlight: (kind: string, key: string, payload: unknown) => Promise<void>
  /** The runner's `SessionFactWriter.record`: `null` means nothing was written. */
  readonly record: (fact: ExperimentFact, inFlight?: readonly InFlightWrite[]) => Promise<StoredFact | null>
}

export interface ExperimentOperation {
  snapshot(): ExperimentOperationState
  subscribe(listener: (state: ExperimentOperationState) => void): () => void
  /** The interruption message while a hold blocks new work. Rejects when the
   *  hold read fails; the next call reads again. */
  blocker(): Promise<string | undefined>
  /** Runs `admit` and writes the hold before it moves to `running`, and
   *  answers what `admit` returned. Rejects with the refusal when work is
   *  interrupted or not idle, or when `admit` or the hold write rejects. */
  begin<Admitted extends { readonly command: string }>(admit: () => Promise<Admitted>): Promise<Admitted>
  /** Writes the result into the hold before it moves `running` to `pending`,
   *  so a reopened runner settles it. After a stop it writes nothing and
   *  moves `abandoned` to `idle`. Rejects when the hold write rejects. */
  measured(value: PendingExperimentResult): Promise<void>
  failed(): void
  /** Marks the hold `settling`, then runs `work` on the pending result and
   *  answers its result. Rejects with the refusal when no result is pending;
   *  a rejection of `work` moves the operation to `interrupted`, as an
   *  `unresolved` outcome does, and a `kept-pending` outcome writes the
   *  result back into the hold. */
  settle<T>(work: (pending: PendingExperimentResult) => Promise<{ readonly outcome: ExperimentSettleOutcome; readonly result: T }>): Promise<T>
  /** Records leaving experiment mode and, in the same commit, retires the hold
   *  of a live or restored result. With `discard`, it also retires the holds
   *  of interrupted work, which only the person confirms. Applies the stop
   *  only after the store acknowledged the fact, which it answers; rejects
   *  with nothing changed when the write is refused or unacknowledged. */
  stop(workDir: string | null, discard?: boolean): Promise<StoredFact>
}

/** The read side a chat runner exposes to protocol projections. */
export type ExperimentOperationView = Pick<ExperimentOperation, "snapshot" | "subscribe">

/** Owns a runner's experiment operation: its state, its durable hold, and the
 *  writes that retire the hold. Durable transitions run in one lane, so a stop
 *  never interleaves with an admission, a measurement, or a settlement. After
 *  every lane task the hold reads, through `heldWork`, as the state's durable
 *  meaning, so a reopened runner continues exactly a pending result. */
export function createExperimentOperation(deps: ExperimentOperationDependencies): ExperimentOperation {
  let state: ExperimentOperationState = { status: "idle" }
  const listeners = new Set<(state: ExperimentOperationState) => void>()
  const apply = (event: ExperimentOperationEvent): void => {
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
      (rows) => apply({ type: "opened", held: heldWork(rows) }),
      (error: unknown) => {
        atOpen = undefined
        throw error
      },
    )
    return atOpen
  }
  const hold = (value: OperationHold): Promise<void> => deps.putInFlight(EXPERIMENT_OPERATION_KIND, EXPERIMENT_OPERATION_KEY, encodeHold(value))
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
      await hold({ state: "running" })
      apply({ type: "began", command: admitted.command })
      return admitted
    }),
    // In the lane, so a stop that retired the hold first leaves `abandoned`
    // here and nothing writes the hold again.
    measured: (value) => lane.run(async () => {
      if (state.status === "running") await hold({ state: "pending", result: value })
      apply({ type: "measured", value })
    }),
    failed: () => apply({ type: "failed" }),
    settle: (work) => lane.run(async () => {
      await opened()
      refuseInterrupted()
      if (state.status !== "pending") throw new Error("No experiment result is pending.")
      const { value } = state
      // Git work is a protected action: a restart inside it must read as
      // interrupted, never as a result that a second settlement could reuse.
      await hold({ state: "settling" })
      let settled: Awaited<ReturnType<typeof work>>
      try {
        settled = await work(value)
      } catch (error) {
        apply({ type: "failed" })
        throw error
      }
      if (settled.outcome === "kept-pending") await hold({ state: "pending", result: value })
      if (settled.outcome === "settled") apply({ type: "settled" })
      if (settled.outcome === "unresolved") apply({ type: "failed" })
      return settled.result
    }),
    // The retirement is decided from the state at entry: `failed` can still
    // move `running` while the write is in flight, and `stopped` accepts
    // either successor. Work that is not this owner's live run is retired by
    // the same rule as a stop with no live runner.
    stop: (workDir, discard = false) => lane.run(async () => {
      await opened()
      const live = state.status === "running" || state.status === "pending"
      const retirement = live ? EXPERIMENT_OPERATION_RETIREMENT : await experimentStopRetirement(deps.listInFlight, discard)
      const stored = await deps.record({ type: "experiment.mode.changed", version: 1, actor: "flywheel", payload: { active: false, workDir } }, retirement)
      if (!stored) throw new Error("Experiment mode could not be recorded.")
      if (retirement) apply({ type: "stopped" })
      return stored
    }),
  }
}

/** Reports unresolved experiment work without mutating or interpreting it. A
 *  pending result is not interrupted: the runner that opens it settles it. */
export async function findExperimentInterruption(listInFlight: ListInFlight): Promise<string | undefined> {
  return heldWork(await listInFlight(INTERRUPTION_KINDS)).status === "interrupted" ? experimentInterruptionMessage : undefined
}

/** What a stop retires of the holds a runner would open with: a pending
 *  result always (a stop ends the loop that would log it), and interrupted
 *  work only with the person's `discard` (`/experiment clear discard`). For
 *  the owner whose own work is not live, and for the stop that runs with no
 *  live runner, so both retire the same holds. */
export async function experimentStopRetirement(listInFlight: ListInFlight, discard: boolean): Promise<InFlightWrite[] | undefined> {
  const rows = await listInFlight(INTERRUPTION_KINDS)
  const held = heldWork(rows)
  if (held.status === "pending") return [...EXPERIMENT_OPERATION_RETIREMENT]
  if (held.status === "interrupted" && discard) return rows.map((row): InFlightWrite => ({ op: "drop", kind: row.kind, key: row.key }))
  return undefined
}
