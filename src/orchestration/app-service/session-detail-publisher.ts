import type { RuntimeQueryResult, SessionRow } from "../../protocol/app-service-types.js"
import { sessionDetailCursor, type RuntimeSessionDetailView } from "../../protocol/session-detail-protocol-types.js"
import type { RuntimeUiPatch } from "../../protocol/runtime-ui-protocol-types.js"
import { createAdmissionEdges } from "../../protocol/client/session-controls.js"
import type { StatusView } from "../../protocol/status-protocol-types.js"
import { errorMessage } from "../../infra/error-message.js"
import { parseProjectionFact } from "../../infra/event-projection.js"
import type { StoredFact } from "../../infra/event-store-types.js"
import { Log } from "../../infra/log.js"
import { parseStoredSessionRuntimeFact } from "../../infra/runtime-fact-parser.js"
import { parseConversationTreeFact } from "../session/conversation/conversation-facts.js"
import { TURN_END_ID_PREFIX } from "../session/conversation/turn-end-record.js"
import { installedSessionAdmission } from "../session/module-session-operations.js"
import { restartBackoffMs } from "./project-executor-generations.js"
import type { ProjectStateClient } from "./project-state-client.js"
import type { RuntimeUiBus } from "./runtime-ui-bus.js"
import { runtimeReadAnchor } from "./runtime-ui-patch-sequencer.js"
import type { SessionHolder } from "./session-holds.js"

const log = Log.create({ service: "session-detail-publisher" })

type DetailSnapshot = RuntimeQueryResult<{ type: "sessionDetailSnapshot"; sessionIds: readonly string[] }>

/** One client connection, or `undefined` for an in-process caller, which
 *  names no connection and holds until the publisher is disposed. */
type DetailHolder = SessionHolder | undefined

/** Why a holder holds a session's detail: it shows the session, as an open
 *  tab does from its `session.activate` to its `session.release`, or it read
 *  the detail through a snapshot, until its `session_detail.release`. Each
 *  hold ends only by its own release, so a client that lets go of a detail
 *  it read never lets go of a tab it shows, nor the reverse. */
type DetailHold = "shown" | "read"

const HOLD_BITS = { shown: 1, read: 2 } as const satisfies { readonly [hold in DetailHold]: number }

/** Where the one wait for the totals of a row that shows them loading
 *  stands: it runs, or it settled and the row still loaded after it. */
type TotalsWait = "waiting" | "waited"

/** Why a held session is read only at the backoff: its read failed, or its
 *  row kept its totals loading after the wait for them settled. */
type RetryCause = "read_failed" | "totals_loading"

/** The account's one publisher of session detail rows (C5). A session is held
 *  while at least one holder shows it or reads it, and the last hold to end
 *  makes the publisher forget it, so the held set is what clients show now. */
export interface SessionDetailPublisher {
  /** `holder` shows `sessionIds`, as an open tab does. A session that no
   *  holder held before is read once, so its admission reaches `onRead`. */
  hold(holder: DetailHolder, sessionIds: readonly string[]): void
  /** Reads `sessionIds` for `holder`, which holds them from this call on. */
  snapshot(holder: DetailHolder, sessionIds: readonly string[], ready: () => Promise<void>): Promise<DetailSnapshot>
  /** Ends the `hold` that `holder` has on `sessionId`. */
  release(holder: DetailHolder, sessionId: string, hold: DetailHold): void
  /** `holder` ended: it holds no session any more. */
  drop(holder: DetailHolder): void
  /** The metadata of `sessionIds` changed: each one held is read again. */
  refresh(sessionIds: Iterable<string>): void
  /** An executor patch. What a held session admits changes when what an
   *  Interrupt can cut changes, its notices change with its provider
   *  connection, a workflow's row carries its progress, and a row read while
   *  its totals loaded lacks them, so an edge of any of these reads it
   *  again. */
  apply(patch: RuntimeUiPatch): void
  /** The session was deleted: its holders receive the null row. */
  remove(sessionId: string): void
  /** A new executor generation: every held session is read again. */
  reset(): void
  dispose(): void
}

/** Reads a held session only when an input of its row can have changed: its
 *  metadata, an edge of what an Interrupt can cut or of its provider
 *  connection, its first totals, its workflow progress, a
 *  module's admission facts, a record of how a turn ended, or the parent's
 *  tool result that settles it. Ordinary conversation appends change only
 *  the transcript, which the row does not carry, so they read nothing. A
 *  read publishes its row only when the holders were given another row
 *  before; a snapshot follows the same rule, so a snapshot that reads a
 *  newer row tells the holders that have the older one, and its own holder
 *  drops that patch by position. */
export function createSessionDetailPublisher(deps: {
  state: Pick<ProjectStateClient, "onStored">
  bus: RuntimeUiBus
  read: (sessionId: string) => Promise<RuntimeQueryResult<{ type: "sessionDetail"; sessionId: string }>>
  own: (work: Promise<void>) => void
  closing: () => boolean
  /** Each row read for a held session; null when the session is gone. */
  onRead?: (sessionId: string, row: SessionRow | null) => void
  /** No holder holds the session any more. */
  onReleased?: (sessionId: string) => void
  /** The wait before held reads that failed are tried again, after
   *  `failures` failed reads in a row. */
  retryDelayMs?: (failures: number) => number
  /** Settles once the session's totals are ready, such as after the summary
   *  index rebuilds, so a row read while they load is read again then. */
  totalsReady?: (sessionId: string) => Promise<void>
}): SessionDetailPublisher {
  // Each holder of a held session, with the bits of the holds it has.
  const holders = new Map<string, Map<DetailHolder, number>>()
  // The row identity that each held session's holders were last given.
  const published = new Map<string, string>()
  // The parent tool call each held session answers, from its last read row;
  // null for a session that answers none, absent for one not read yet.
  const launches = new Map<string, string | null>()
  // What an Interrupt can cut in each session the executor reports.
  let interruptible = createAdmissionEdges()
  // The provider connection of each session the executor reports. A retry
  // or a lost connection changes the row's notices and no fact says so.
  const connections = new Map<string, StatusView["connectionState"]>()
  // Each stored tool result version, as type@version, that a read failed to
  // decode. The first failure of a version is logged; later ones are not.
  // The record holds ids only: a decode error can quote the fact's text, and
  // `flywheel events search` reads the fact at the logged position.
  const unreadableResultVersions = new Set<string>()
  const pending = new Set<string>()
  // Held sessions whose last read failed or kept its totals loading. Only
  // the retry timer reads them again, so a read that keeps failing, such as
  // a history read past its deadline under load, runs at the backoff and
  // never at the fact rate.
  const retrying = new Map<string, RetryCause>()
  // Held sessions whose last read row showed its totals loading, with the
  // one wait for their totals that this loading episode allows.
  const loadingTotals = new Map<string, TotalsWait>()
  const retryDelayMs = deps.retryDelayMs ?? restartBackoffMs
  const owners = installedSessionAdmission()
  let queued = false
  let failures = 0
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let work: Promise<unknown> = Promise.resolve()
  function serialize<T>(run: () => Promise<T>): Promise<T> {
    const result = work.then(run)
    work = result.catch(() => {})
    return result
  }

  function take(holder: DetailHolder, sessionId: string, hold: DetailHold): boolean {
    const current = holders.get(sessionId)
    if (current) {
      current.set(holder, (current.get(holder) ?? 0) | HOLD_BITS[hold])
      return false
    }
    holders.set(sessionId, new Map([[holder, HOLD_BITS[hold]]]))
    return true
  }

  function release(holder: DetailHolder, sessionId: string, hold: DetailHold): void {
    const current = holders.get(sessionId)
    const held = current?.get(holder)
    if (!current || held === undefined) return
    const rest = held & ~HOLD_BITS[hold]
    if (rest !== 0) current.set(holder, rest)
    else letGo(holder, sessionId, current)
  }

  function letGo(holder: DetailHolder, sessionId: string, current: Map<DetailHolder, number>): void {
    current.delete(holder)
    if (current.size > 0) return
    holders.delete(sessionId)
    published.delete(sessionId)
    launches.delete(sessionId)
    pending.delete(sessionId)
    loadingTotals.delete(sessionId)
    if (retrying.delete(sessionId) && retrying.size === 0) failures = 0
    deps.onReleased?.(sessionId)
  }

  function accept(sessionId: string, view: RuntimeSessionDetailView | null): void {
    const row = view?.row ?? null
    launches.set(sessionId, row?.parentSessionId !== undefined && row.parentToolUseId !== undefined ? launchKey(row.parentSessionId, row.parentToolUseId) : null)
    if (row?.totalsLoading && loadingTotals.get(sessionId) === "waited") {
      retry(sessionId, "totals_loading")
    } else {
      if (retrying.delete(sessionId) && retrying.size === 0) recovered()
      if (row?.totalsLoading) awaitTotals(sessionId)
      else loadingTotals.delete(sessionId)
    }
    deps.onRead?.(sessionId, row)
    const key = detailKey(row)
    const prior = published.get(sessionId)
    published.set(sessionId, key)
    if (prior !== undefined && prior !== key) deps.bus.publish({ cursor: sessionDetailCursor(sessionId), payload: { kind: "session_detail.changed", row } })
  }

  /** Totals are an input of the row that no fact announces. A row read
   *  while they load is read again once the summary index is ready, which
   *  serves a session the history reads, and again when the executor
   *  reports them, which serves a session it holds (`apply`). A loading
   *  episode waits once. A row that still loads after that wait, such as
   *  one whose budget summary failed, goes to the backoff of a failed read,
   *  so it is read again at that rate and never in a loop. A wait that
   *  fails leaves the row loading until another change reads it; the
   *  summary reader records why. */
  function awaitTotals(sessionId: string): void {
    if (loadingTotals.has(sessionId)) return
    loadingTotals.set(sessionId, "waiting")
    if (!deps.totalsReady) return
    const settle = () => {
      if (loadingTotals.get(sessionId) !== "waiting") return
      loadingTotals.set(sessionId, "waited")
      refresh([sessionId])
    }
    deps.own(deps.totalsReady(sessionId).then(settle, () => {}))
  }

  /** A row whose read failed waits for its backoff, because another read
   *  would fail the same way. A row whose totals stay loading still reads
   *  on a real change, such as a rename or a turn end, because only its
   *  totals are late. */
  function refresh(sessionIds: Iterable<string>): void {
    for (const id of sessionIds) if (holders.has(id) && retrying.get(id) !== "read_failed") pending.add(id)
    pump()
  }

  function pump(): void {
    if (queued || pending.size === 0 || deps.closing()) return
    queued = true
    deps.own(serialize(readNext))
  }

  /** Reads one pending session and then queues the next, so a client's
   *  snapshot, which shares this lane, waits behind at most one read. */
  async function readNext(): Promise<void> {
    queued = false
    const [sessionId] = pending
    if (sessionId === undefined) return
    pending.delete(sessionId)
    try {
      if (holders.has(sessionId)) await readHeld(sessionId)
    } finally {
      pump()
    }
  }

  async function readHeld(sessionId: string): Promise<void> {
    let result: Awaited<ReturnType<typeof deps.read>>
    try {
      result = await deps.read(sessionId)
    } catch (error) {
      if (!deps.closing() && holders.has(sessionId)) retry(sessionId, "read_failed", error)
      return
    }
    if (!deps.closing() && holders.has(sessionId)) accept(sessionId, result.view)
  }

  /** Keeps the change of a session whose read failed, or whose row kept its
   *  totals loading after they were ready, and reads it again after the
   *  backoff even when nothing else changes. One record covers a run of
   *  failures; the read that recovers reports how many failed. */
  function retry(sessionId: string, cause: RetryCause, error?: unknown): void {
    retrying.set(sessionId, cause)
    failures += 1
    if (failures === 1) log.warn("a held session's detail read failed; it is read again after a backoff", { sessionId, cause, ...(error === undefined ? {} : { error: errorMessage(error) }) })
    if (retryTimer !== undefined) return
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      for (const id of retrying.keys()) pending.add(id)
      pump()
    }, retryDelayMs(failures))
    retryTimer.unref?.()
  }

  function recovered(): void {
    if (failures === 0) return
    log.info("held session detail reads recovered", { failures })
    failures = 0
  }

  /** Whether the provider connection of a session changed. The first status
   *  of a session is its baseline, as it is for what Interrupt can cut. */
  function connectionEdge(sessionId: string, status: StatusView | undefined): boolean {
    const prior = connections.get(sessionId)
    if (status === undefined) connections.delete(sessionId)
    else connections.set(sessionId, status.connectionState)
    return prior !== undefined && status !== undefined && prior !== status.connectionState
  }

  /** The held sessions a parent's tool result can settle: each child that
   *  answers that call, and each one not read yet, whose call is unknown.
   *  Only the tool use id is necessary, so the fact is decoded in its stored
   *  shape and its tool text is never resolved. A result that this release
   *  cannot read, such as one that a newer release wrote, can answer any
   *  call: every held session is read again, and the first such result of
   *  each version is logged, so a refresh is never lost without a record. */
  function settledBy(fact: StoredFact): readonly string[] {
    let toolUseId: string
    try {
      const result = parseProjectionFact(fact, parseStoredSessionRuntimeFact)
      if (result.type !== "tool.result.recorded") return []
      toolUseId = result.payload.toolUseId
    } catch {
      const factVersion = `${fact.type}@${fact.version}`
      if (!unreadableResultVersions.has(factVersion)) {
        unreadableResultVersions.add(factVersion)
        log.warn("a tool result has a shape this release cannot read; every held session is read again", { sessionId: fact.sessionId, type: fact.type, version: fact.version, position: fact.position })
      }
      return [...holders.keys()]
    }
    const launch = launchKey(fact.sessionId, toolUseId)
    return [...holders.keys()].filter((sessionId) => {
      const held = launches.get(sessionId)
      return held === undefined || held === launch
    })
  }

  const unsubscribe = deps.state.onStored((facts) => {
    if (holders.size === 0) return
    const changed = new Set<string>()
    for (const fact of facts) {
      for (const owner of owners) for (const id of owner.affectedSessions(fact)) changed.add(id)
      if (fact.type === "chat.entries.appended" && holders.has(fact.sessionId) && recordsTurnEnd(fact)) changed.add(fact.sessionId)
      if (fact.type === "tool.result.recorded") for (const id of settledBy(fact)) changed.add(id)
    }
    refresh(changed)
  })

  return {
    hold(holder, sessionIds) {
      refresh(sessionIds.filter((sessionId) => take(holder, sessionId, "shown")))
    },
    snapshot(holder, sessionIds, ready) {
      for (const sessionId of sessionIds) take(holder, sessionId, "read")
      return ready().then(() => serialize(async () => {
        const views = await Promise.all(sessionIds.map(async (sessionId) => ({ sessionId, view: (await deps.read(sessionId)).view })))
        // A patch for a newer row is published before the position this
        // snapshot answers: the earlier holders apply it, this one drops it.
        for (const { sessionId, view } of views) if (holders.has(sessionId)) accept(sessionId, view)
        return { views, snapshotPosition: deps.bus.snapshotPosition(runtimeReadAnchor("sessionDetailSnapshot")) }
      }))
    },
    release,
    drop(holder) {
      // A Map visits each entry once even when the loop deletes the one it
      // is on, so a held session let go here is never skipped or revisited.
      for (const [sessionId, current] of holders) if (current.has(holder)) letGo(holder, sessionId, current)
    },
    refresh,
    apply({ cursor, payload }) {
      if (cursor.scope !== "session") return
      if (payload.kind === "status.updated" || payload.kind === "status.removed") {
        // Every status is observed, so a session held later has its
        // baseline already. Thinking, generating, and running tools admit
        // the same actions, so only an edge of what Interrupt cuts, or of
        // the provider connection that the row's notices state, reads.
        const status = payload.kind === "status.updated" ? payload.status : undefined
        const edge = interruptible.observe(cursor.sessionId, status)
        if (!connectionEdge(cursor.sessionId, status) && !edge) return
        if (!holders.has(cursor.sessionId)) return
      } else if (!holders.has(cursor.sessionId)) {
        return
      } else if (payload.kind === "budget.updated") {
        // Later totals reach clients through the budget domain; only the
        // first totals of a row that shows them loading read it. They are
        // the input that a row at the backoff for its totals lacks, so they
        // read it before the backoff ends.
        if (payload.budget.totalsLoading || !loadingTotals.has(cursor.sessionId)) return
        if (retrying.get(cursor.sessionId) === "totals_loading") {
          pending.add(cursor.sessionId)
          pump()
          return
        }
      } else return
      refresh([cursor.sessionId])
    },
    remove(sessionId) {
      deps.own(serialize(async () => { if (holders.has(sessionId)) accept(sessionId, null) }))
    },
    reset() {
      // A new generation reports every status again, and every held
      // session, a failing one included, is read now.
      clearTimeout(retryTimer)
      retryTimer = undefined
      interruptible = createAdmissionEdges()
      connections.clear()
      for (const id of holders.keys()) pending.add(id)
      pump()
    },
    dispose() {
      clearTimeout(retryTimer)
      unsubscribe()
    },
  }
}

/** Whether a committed batch records how a turn ended, which changes what
 *  the session admits, such as Resume after an interrupt. */
function recordsTurnEnd(fact: StoredFact): boolean {
  const appended = parseProjectionFact(fact, parseConversationTreeFact)
  return appended.type === "chat.entries.appended" && appended.payload.entries.some((entry) => entry.id.startsWith(TURN_END_ID_PREFIX))
}

function launchKey(parentSessionId: string, toolUseId: string): string {
  return `${parentSessionId}\0${toolUseId}`
}


function detailKey(row: SessionRow | null): string {
  if (!row) return "null"
  return JSON.stringify({
    id: row.id, kind: row.kind, title: row.title, shortTitle: row.shortTitle,
    lifecycleState: row.lifecycleState, notices: row.notices,
    executionCwd: row.executionCwd, parentSessionId: row.parentSessionId,
    parentToolUseId: row.parentToolUseId, stoppedBy: row.stoppedBy,
    childSessionIds: row.childSessionIds, degraded: row.degraded,
    unavailableFields: row.unavailableFields, activity: row.activity,
    inputMode: row.inputMode, admittedActions: row.admittedActions,
    totalsLoading: row.totalsLoading, totalTokens: row.totalTokens, totalCost: row.totalCost,
    totalBilledCost: row.totalBilledCost, priceUnavailable: row.priceUnavailable,
    contextPercent: row.contextPercent, contextPromptTokens: row.contextPromptTokens, durationMs: row.durationMs,
  })
}
