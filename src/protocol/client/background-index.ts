import { errorMessage } from "../../infra/error-message.js"
import { CANCELED_LABEL, PARTIAL_LABEL, STOPPED_LABEL, SUBAGENT_INTERRUPTED_LABEL } from "../../infra/output/run-labels.js"
import type { AttachedRuntimeClient } from "../app-service-types.js"
import {
  backgroundCursor,
  isBackgroundPayload,
  type BackgroundPatchPayload,
  type BackgroundWorkProgress,
  type BackgroundWorkRow,
  type BackgroundWorkStatus,
} from "../background-index-protocol-types.js"
import { lostWithLane } from "./connection-failures.js"
import { releaseAfterLastRead } from "./held-read-release.js"
import { formatDuration } from "./format.js"
import { createSessionReadingFamily, type SessionReadingFamily, type SessionViewStore } from "./session-reading-family.js"
import { workflowProgressCount } from "./workflow-progress.js"
import { WAITING_ON_PARENT } from "./session-controls.js"

/** Active work only, or every row the chat ever started. */
export type BackgroundIndexFilter = "active" | "all"

/** The background index of one followed session. Loading lasts only until
 *  the first read of the session answers; after that the client holds rows,
 *  and an error keeps the rows it held when a later read failed. */
export type BackgroundIndexState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly rows: readonly BackgroundWorkRow[] }
  | { readonly status: "error"; readonly error: string; readonly rows?: readonly BackgroundWorkRow[] }

/** What a client's store holds for a followed session once a read answered or failed. */
export type HeldBackgroundIndex = Exclude<BackgroundIndexState, { readonly status: "loading" }>

const LOADING: BackgroundIndexState = { status: "loading" }

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

/** The one order of a background index, which the runtime leaves to its
 *  clients: each level in start order, ties broken by id, and each row
 *  followed by the rows it started. A row whose parent row is not in the
 *  index is a top-level row. */
function orderBackgroundRows(rows: readonly BackgroundWorkRow[]): readonly (readonly [BackgroundWorkRow, number])[] {
  const ids = new Set(rows.map((row) => row.id))
  const children = new Map<string | undefined, BackgroundWorkRow[]>()
  for (const row of rows) {
    const parent = row.parentRowId !== undefined && ids.has(row.parentRowId) ? row.parentRowId : undefined
    children.set(parent, [...children.get(parent) ?? [], row])
  }
  const ordered: (readonly [BackgroundWorkRow, number])[] = []
  const visit = (parent: string | undefined, depth: number): void => {
    const level = (children.get(parent) ?? []).toSorted((a, b) => a.startedAtMs - b.startedAtMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    for (const row of level) {
      ordered.push([row, depth])
      visit(row.id, depth + 1)
    }
  }
  visit(undefined, 0)
  return ordered
}

/** The rows a filter shows, in the index's order, from rows in any order.
 *  Active keeps the running rows and the rows that wait on their parent, and
 *  keeps the parent row of each such nested row in view, dimmed when it
 *  finished. */
export function backgroundIndexEntries(rows: readonly BackgroundWorkRow[], filter: BackgroundIndexFilter): readonly BackgroundIndexEntry[] {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const shown = new Set<string>()
  for (const row of rows) {
    if (filter === "all" || isActiveBackgroundRow(row)) {
      for (let current: BackgroundWorkRow | undefined = row; current !== undefined && !shown.has(current.id); current = current.parentRowId === undefined ? undefined : byId.get(current.parentRowId)) {
        shown.add(current.id)
      }
    }
  }
  return orderBackgroundRows(rows).filter(([row]) => shown.has(row.id)).map(([row, depth]) => ({ row, depth, dimmed: !isActiveBackgroundRow(row) }))
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

/** The state of a followed session's index from what the client's store holds for it. */
export function backgroundIndexState(held: HeldBackgroundIndex | undefined): BackgroundIndexState {
  return held ?? LOADING
}

/** The rows held after one row patch: a changed row replaces the row with its id, or joins the index. */
function foldBackgroundPayload(rows: readonly BackgroundWorkRow[], payload: BackgroundPatchPayload): readonly BackgroundWorkRow[] {
  if (payload.kind === "background.row.removed") return rows.filter((row) => row.id !== payload.rowId)
  const at = rows.findIndex((row) => row.id === payload.row.id)
  return at === -1 ? [...rows, payload.row] : rows.with(at, payload.row)
}

/** Follows the background index of each session a client views
 *  (ARCH-PROTOCOL-069): one read when the client follows the session, then
 *  row patches that change the held rows in place. A read that fails keeps
 *  the rows held and states the error; the family's recovery reads again
 *  with backoff. The client's store holds the indexes, and `admits` names
 *  the sessions the client follows, so the patches of every other session
 *  the runtime broadcasts cost nothing. A read follows the session for this
 *  connection, so a retired session, and every session at `dispose`, sends
 *  `background.release` once its last read settled. */
export function createBackgroundIndexReadings(options: {
  readonly client: Pick<AttachedRuntimeClient, "query" | "dispatch" | "subscribe" | "onLane">
  readonly views: SessionViewStore<HeldBackgroundIndex>
  readonly admits: (sessionId: string) => boolean
  readonly changed?: () => void
}): SessionReadingFamily {
  const { client, views } = options
  // The read that started last for each followed session. Only its failure
  // states an error, so a retired read that fails late never replaces the
  // rows that a newer read answered.
  const lastReads = new Map<string, Promise<unknown>>()
  const family: SessionReadingFamily = createSessionReadingFamily<"background", BackgroundPatchPayload, HeldBackgroundIndex>({
    domain: "background",
    cursor: backgroundCursor,
    client,
    readsOneSession: true,
    async query(sessionIds) {
      const sessionId = sessionIds[0]
      if (sessionId === undefined) return { snapshotPosition: 0, views: [] }
      const read = client.query({ type: "sessionBackgroundWork", sessionId })
      lastReads.set(sessionId, read)
      try {
        const result = await read
        return { snapshotPosition: result.snapshotPosition, views: [{ sessionId, view: { status: "ready", rows: result.rows } }] }
      } catch (cause) {
        // A read lost with its lane is read again on the next lane.
        if (!lostWithLane(cause) && lastReads.get(sessionId) === read) {
          const held = views.get(sessionId)
          views.set(sessionId, { status: "error", error: errorMessage(cause), ...(held?.rows === undefined ? {} : { rows: held.rows }) })
          options.changed?.()
        }
        throw cause
      }
    },
    isPayload: isBackgroundPayload,
    payloadView: (payload, current) => ({ status: "ready", rows: foldBackgroundPayload(current?.rows ?? [], payload) }),
    admits: options.admits,
    views,
    ...(options.changed === undefined ? {} : { changed: options.changed }),
  })

  function unfollow(sessionId: string): void {
    const lastRead = lastReads.get(sessionId)
    if (lastRead === undefined) return
    lastReads.delete(sessionId)
    releaseAfterLastRead({
      lastRead,
      // The client can follow the session again before its last read settles.
      free: () => !lastReads.has(sessionId),
      release: async () => { await client.dispatch({ type: "background.release", sessionId }) },
    })
  }

  return {
    ...family,
    retire(sessionId) {
      family.retire(sessionId)
      unfollow(sessionId)
    },
    dispose() {
      family.dispose()
      // A Map visits each entry once even when `unfollow` deletes the one it is on.
      for (const sessionId of lastReads.keys()) unfollow(sessionId)
    },
  }
}
