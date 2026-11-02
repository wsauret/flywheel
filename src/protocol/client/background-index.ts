import { errorMessage } from "../../infra/error-message.js"
import { CANCELED_LABEL, PARTIAL_LABEL, STOPPED_LABEL, SUBAGENT_INTERRUPTED_LABEL } from "../../infra/output/run-labels.js"
import type { AttachedRuntimeClient } from "../app-service-types.js"
import { backgroundCursor, type BackgroundWorkProgress, type BackgroundWorkRow, type BackgroundWorkStatus } from "../background-index-protocol-types.js"
import { cursorKey } from "../runtime-ui-protocol-types.js"
import { lostWithLane } from "./connection-failures.js"
import { createCursorIntake, isLaneBreak } from "./cursor-intake.js"
import { formatDuration } from "./format.js"
import { workflowProgressCount } from "./workflow-progress.js"
import { WAITING_ON_PARENT } from "./session-controls.js"

/** Active work only, or every row the chat ever started. */
export type BackgroundIndexFilter = "active" | "all"

/** `rows` while loading or after an error is the previous read, for display only. */
export type BackgroundIndexState =
  | { readonly status: "idle" }
  | { readonly status: "loading"; readonly rows?: readonly BackgroundWorkRow[] }
  | { readonly status: "ready"; readonly rows: readonly BackgroundWorkRow[] }
  | { readonly status: "error"; readonly rows?: readonly BackgroundWorkRow[]; readonly error: string }

/** One row as a client lists it: how deep it nests, and whether it is dimmed because it finished. */
export interface BackgroundIndexEntry {
  readonly row: BackgroundWorkRow
  readonly depth: number
  readonly dimmed: boolean
}

const ACTIVE_STATUSES: ReadonlySet<BackgroundWorkStatus> = new Set(["running", "waiting_on_parent"])

function isActiveBackgroundRow(row: BackgroundWorkRow): boolean {
  return ACTIVE_STATUSES.has(row.status)
}

/** The rows a filter shows, in the runtime's order. Active keeps the running
 *  rows and the rows that wait on their parent, and keeps the parent row of
 *  each such nested row in view, dimmed when it finished. */
export function backgroundIndexEntries(rows: readonly BackgroundWorkRow[], filter: BackgroundIndexFilter): readonly BackgroundIndexEntry[] {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const depthOf = (row: BackgroundWorkRow): number => {
    let depth = 0
    for (let parent = row.parentRowId; parent !== undefined && depth < rows.length; parent = byId.get(parent)?.parentRowId) depth++
    return depth
  }
  const shown = new Set<string>()
  for (const row of rows) {
    if (filter === "all" || isActiveBackgroundRow(row)) {
      for (let current: BackgroundWorkRow | undefined = row; current !== undefined && !shown.has(current.id); current = current.parentRowId === undefined ? undefined : byId.get(current.parentRowId)) {
        shown.add(current.id)
      }
    }
  }
  return rows.filter((row) => shown.has(row.id)).map((row) => ({ row, depth: depthOf(row), dimmed: !isActiveBackgroundRow(row) }))
}

const STATUS_LABELS = {
  running: "Running",
  waiting_on_parent: WAITING_ON_PARENT,
  interrupted: SUBAGENT_INTERRUPTED_LABEL,
  completed: "Completed",
  partial: PARTIAL_LABEL,
  failed: "Failed",
  stopped: STOPPED_LABEL,
  cancelled: CANCELED_LABEL,
  ended: "Ended",
} as const satisfies { readonly [S in BackgroundWorkStatus]: string }

/** The status of a row in the words both clients show. */
function backgroundStatusLabel(row: BackgroundWorkRow): string {
  return STATUS_LABELS[row.status]
}

/** How many names of running agents a workflow row lists before it counts the rest. */
const ACTIVE_NAMES = 3

/** A workflow's progress beside its status: the count its card shows, and
 *  while it runs, the names of the agents that run. Only an active
 *  workflow names running agents: an interrupt holds the agents it cut. */
function workflowProgressParts(progress: BackgroundWorkProgress, active: boolean): readonly string[] {
  if (!active) return [workflowProgressCount({ ...progress, running: 0, lists: [] })]
  const names = progress.active.length > ACTIVE_NAMES
    ? `${progress.active.slice(0, ACTIVE_NAMES).join(", ")} +${progress.active.length - ACTIVE_NAMES} more`
    : progress.active.join(", ")
  return [workflowProgressCount({ ...progress, lists: [] }), ...(names === "" ? [] : [names])]
}

/** What a row states beside its title: its status, the exit code of a
 *  command that ended by itself, the duration of a finished command or
 *  subagent, the model of a running child, and a workflow's progress. A
 *  stopped or canceled command shows no exit code: the code is the
 *  command's reaction to the stop, such as 143 from a trapped SIGTERM or the
 *  1 that Windows job termination sets, not its outcome. */
export function backgroundRowDetail(row: BackgroundWorkRow): string {
  const endedByStop = row.status === "stopped" || row.status === "cancelled"
  return [
    backgroundStatusLabel(row),
    row.exitCode === undefined || endedByStop ? undefined : `exit ${row.exitCode}`,
    row.durationMs === undefined ? undefined : formatDuration(row.durationMs),
    row.model === undefined ? undefined : row.effort === undefined ? row.model : `${row.model} · ${row.effort}`,
    ...(row.progress === undefined ? [] : workflowProgressParts(row.progress, isActiveBackgroundRow(row))),
  ].filter((part) => part !== undefined).join(" · ")
}

/** Whether the runtime admits Stop on the row now. */
export function canStopBackgroundRow(row: BackgroundWorkRow): row is BackgroundWorkRow & { readonly stop: NonNullable<BackgroundWorkRow["stop"]> } {
  return row.stop !== undefined && isActiveBackgroundRow(row)
}

/** Stops an active row through its launching call. False when the row admits no Stop. */
export async function stopBackgroundRow(client: Pick<AttachedRuntimeClient, "dispatch">, row: BackgroundWorkRow): Promise<boolean> {
  if (!canStopBackgroundRow(row)) return false
  await client.dispatch({ type: "background.terminate", sessionId: row.stop.sessionId, toolUseId: row.stop.toolUseId })
  return true
}

export interface BackgroundIndexController {
  readonly sessionId: string
  readonly snapshot: BackgroundIndexState
  /** Subscribes and reads the index once for each lane. Repeated calls do not read again. */
  start(): Promise<void>
  /** Reads the index again, keeping the last rows for display meanwhile. */
  refresh(): Promise<void>
  onChange(listener: () => void): () => void
  /** Unsubscribes. A client disposes the controller when it stops showing the index. */
  dispose(): void
}

/** The background index of one chat, read while a client shows it. Each
 *  `background.changed` patch reads it again. Construction is passive. */
export function createBackgroundIndexController(options: {
  readonly client: Pick<AttachedRuntimeClient, "query" | "subscribe" | "onLane">
  readonly sessionId: string
}): BackgroundIndexController {
  const { client, sessionId } = options
  const cursor = backgroundCursor(sessionId)
  const listeners = new Set<() => void>()
  let state: BackgroundIndexState = { status: "idle" }
  let started = false
  let disposed = false
  let generation = 0
  let queuedRefresh: Promise<void> | undefined
  let startWork = Promise.resolve()
  let unsubscribe: (() => void) | undefined
  let stopLanes: (() => void) | undefined

  const emit = (): void => {
    if (!disposed) for (const listener of listeners) listener()
  }
  const lastRows = (): readonly BackgroundWorkRow[] | undefined => "rows" in state ? state.rows : undefined

  function invalidate(): void {
    generation++
    const rows = lastRows()
    state = { status: "loading", ...(rows ? { rows } : {}) }
    emit()
  }

  const intake = createCursorIntake({
    cursor,
    onApply: () => { void refresh() },
    onRecover: () => { void refresh() },
  })

  function refresh(): Promise<void> {
    if (disposed) return Promise.resolve()
    if (!started) return start()
    invalidate()
    // One read answers a burst of invalidations.
    if (queuedRefresh) return queuedRefresh
    queuedRefresh = Promise.resolve().then(async () => {
      queuedRefresh = undefined
      if (disposed) return
      const token = generation
      try {
        const result = await client.query({ type: "sessionBackgroundWork", sessionId })
        if (disposed || generation !== token) return
        intake.seed(result.snapshotPosition)
        // Seeding can drain an invalidation that arrived before the result.
        if (disposed || generation !== token) return
        state = { status: "ready", rows: result.rows }
        emit()
      } catch (cause) {
        // A read lost with its lane is read again on the next lane.
        if (disposed || generation !== token || lostWithLane(cause)) return
        const rows = lastRows()
        state = { status: "error", ...(rows ? { rows } : {}), error: errorMessage(cause) }
        emit()
      }
    })
    return queuedRefresh
  }

  function start(): Promise<void> {
    if (disposed) return Promise.resolve()
    if (started) return startWork
    started = true
    unsubscribe = client.subscribe((event) => {
      if (disposed || event.type !== "patch") return
      if (event.patch.cursor.scope === "workspace" && event.patch.cursor.domain === "runtime" && event.patch.payload.kind === "runtime.invalidate") {
        intake.reset()
        // A lane break voids the read in flight; the next lane reads.
        if (isLaneBreak(event.patch)) invalidate()
        else void refresh()
      } else if (cursorKey(event.patch.cursor) === cursorKey(cursor)) {
        const classification = intake.accept(event.patch)
        if (classification === "gap" || classification === "unseeded") void refresh()
      }
    })
    let first: Promise<void> | undefined
    stopLanes = client.onLane(() => {
      intake.reset()
      const read = refresh()
      first ??= read
    })
    startWork = first ?? Promise.resolve()
    return startWork
  }

  return {
    sessionId,
    get snapshot() { return state },
    start,
    refresh,
    onChange(listener) {
      if (!disposed) listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dispose() {
      disposed = true
      stopLanes?.()
      unsubscribe?.()
      intake.reset()
      listeners.clear()
    },
  }
}
