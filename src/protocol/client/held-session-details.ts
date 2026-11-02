import { errorMessage } from "../../infra/error-message.js"
import type { ChildSessionRow, RuntimeClient, SessionCatalogRow, SessionRow } from "../app-service-types.js"
import type { RuntimeUiPatch } from "../runtime-ui-protocol-types.js"
import type { RuntimeSessionDetailView } from "../session-detail-protocol-types.js"
import { lostWithLane } from "./connection-failures.js"
import { createCursorIntake } from "./cursor-intake.js"
import { releaseAfterLastRead } from "./held-read-release.js"

/** What holding one session's detail came to. `missing` is the runtime's own
 *  answer that it has no such session; `failed` is a read that did not answer,
 *  with its cause; `released` is a hold this client let go of while it read. */
export type HoldOutcome =
  | { readonly kind: "held" }
  | { readonly kind: "missing" }
  | { readonly kind: "failed"; readonly cause: unknown }
  | { readonly kind: "released" }

const HELD: HoldOutcome = { kind: "held" }
const RELEASED: HoldOutcome = { kind: "released" }

/** A session's place below its chat: the chat at the top of its parent chain
 *  and the children from that chat down to the session, in that order. */
export interface SessionRoute {
  readonly root: SessionCatalogRow
  /** The children from the root's child down to the session, each with the
   *  kind that decides how a client opens it. */
  readonly children: readonly { readonly id: string; readonly kind: "subagent" | "workflow-agent" }[]
}

/** Walks `sessionId`'s parent chain up to its chat through `read`, one link
 *  at a time. Undefined when a link is unknown or the chain returns to a
 *  session it already passed, so a chain no runtime state can make never
 *  loops a client. */
export async function resolveSessionRoute(
  read: (sessionId: string) => Promise<SessionRow | undefined>,
  sessionId: string,
): Promise<SessionRoute | undefined> {
  const children: { readonly id: string; readonly kind: "subagent" | "workflow-agent" }[] = []
  const visited = new Set<string>()
  let current: string | undefined = sessionId
  while (current !== undefined && !visited.has(current)) {
    visited.add(current)
    const row = await read(current)
    if (!row) return undefined
    if (row.kind === "chat") return { root: row, children: children.toReversed() }
    children.push({ id: row.id, kind: row.kind })
    current = row.parentSessionId
  }
  return undefined
}

/** Ordered detail held for the sessions a client shows. Each held session
 *  follows its own `session_detail` cursor from the snapshot that seeded it,
 *  so a rename, an admission change, or a deletion reaches the held view in
 *  order, and a session nobody holds costs no read. The owner routes every
 *  patch through `accept` and calls `refresh` when a new lane opens or the
 *  runtime invalidates every cursor; a break alone reads nothing. */
export interface HeldSessionDetails {
  /** The held rows that are children, never a chat (ARCH-PROTOCOL-049). */
  readonly rows: readonly ChildSessionRow[]
  get(sessionId: string): ChildSessionRow | undefined
  /** The held row of any session, a chat among them. */
  detail(sessionId: string): SessionRow | undefined
  /** The whole detail the last read seeded, with every later row change. */
  view(sessionId: string): RuntimeSessionDetailView | undefined
  /** Whether a held session's read has answered, and why its last read
   *  failed when it did. Undefined for a session this client does not hold. */
  state(sessionId: string): { readonly loaded: boolean; readonly error?: string } | undefined
  /** The chat at the top of `sessionId`'s parent chain, from held rows and
   *  then `catalogRow`, or undefined while a link of the chain is unknown. */
  root(sessionId: string | undefined, catalogRow: (id: string) => SessionRow | undefined): string | undefined
  /** True for a session this client holds, whatever its read has answered
   *  so far, so a catalog change during the read does not mistake the
   *  selection for a gone session. A held session that another client
   *  deleted stays held until it is forgotten; `lost` says that it is gone. */
  has(sessionId: string): boolean
  /** The last row of a held session that the runtime has since said it no
   *  longer has, such as after a delete made by another client. Undefined
   *  for a session that still exists or that this client never saw. */
  lost(sessionId: string): SessionRow | undefined
  /** Holds the one session and answers what its read came to. A read that a
   *  refresh supersedes answers with that refresh. */
  holdSession(sessionId: string): Promise<HoldOutcome>
  /** Holds the session and then its parent chain to its chat, and answers
   *  what the session's own read came to. */
  hold(sessionId: string): Promise<HoldOutcome>
  forget(sessionId: string): void
  /** Keeps each of `sessionIds` and its parent chain, and forgets every
   *  other hold. */
  retainChains(sessionIds: Iterable<string>): void
  /** Reads the named held sessions again, ignoring unknown ids. With no ids,
   * reads every held session, for a new lane or an invalidation. */
  refresh(sessionIds?: Iterable<string>): void
  accept(patch: RuntimeUiPatch): void
  dispose(): void
}

export interface HeldSessionDetailsOptions {
  /** Reads snapshots and sends `session_detail.release`, which a host can
   *  route around any limit it puts on snapshot reads. */
  readonly client: Pick<RuntimeClient, "query" | "dispatch">
  /** Called with the held session whose view or read state changed, so a
   *  binding can wake only that session's readers. */
  readonly onChange: (sessionId: string) => void
  readonly onDiagnostic?: (message: string, detail?: unknown) => void
}

/** The view with a newer row of the same session. Undefined when the view
 *  is not held yet or the row names another kind, which only a read can
 *  settle. */
function withRow(view: RuntimeSessionDetailView | undefined, row: SessionRow): RuntimeSessionDetailView | undefined {
  if (view?.kind === "chat" && row.kind === "chat") return { ...view, row }
  if (view?.kind === "subagent" && row.kind === "subagent") return { ...view, row }
  if (view?.kind === "workflow-agent" && row.kind === "workflow-agent") return { ...view, row }
  return undefined
}

export function createHeldSessionDetails(options: HeldSessionDetailsOptions): HeldSessionDetails {
  const readings = new Map<string, ReturnType<typeof createReading>>()
  let disposed = false

  function createReading(sessionId: string) {
    let view: RuntimeSessionDetailView | undefined
    let lost: SessionRow | undefined
    let loaded = false
    let failure: string | undefined
    let generation = 0
    let pending: Promise<HoldOutcome> | undefined
    let latest: Promise<HoldOutcome> | undefined
    /** Settles when the next read starts, or when the reading retires. */
    let reread = Promise.withResolvers<void>()
    let retired = false
    /** The runtime's answer for the view. A view that turns null keeps its
     *  last row as lost, so the selection owner can still find the parent
     *  of a session that another client deleted. */
    function replaceView(next: RuntimeSessionDetailView | undefined): void {
      if (next !== undefined) lost = undefined
      else if (view !== undefined) lost = view.row
      view = next
    }
    const intake = createCursorIntake({
      cursor: { scope: "session", domain: "session_detail", sessionId },
      onApply(patch) {
        if (patch.payload.kind !== "session_detail.changed") return
        const { row } = patch.payload
        if (row === null) {
          replaceView(undefined)
        } else {
          const next = withRow(view, row)
          if (next === undefined) { void refresh(); return }
          replaceView(next)
        }
        options.onChange(sessionId)
      },
      onRecover() { void refresh() },
    })
    /** One read of the detail. A newer read supersedes it, such as the refresh
     *  a reconnect starts, and then the newer read answers for it: an open
     *  that waits on this read must get the detail, not a failure that only
     *  says a reconnect happened. A read lost with its lane waits for the read
     *  the next lane starts and answers with it. */
    function refresh(): Promise<HoldOutcome> {
      const request = ++generation
      reread.resolve()
      reread = Promise.withResolvers()
      intake.reset()
      const superseded = () => request !== generation && latest !== undefined ? latest : undefined
      const read = (async (): Promise<HoldOutcome> => {
        try {
          const snapshot = await options.client.query({ type: "sessionDetailSnapshot", sessionIds: [sessionId] })
          if (retired || disposed) return RELEASED
          const newer = superseded()
          if (newer) return await newer
          replaceView(snapshot.views.find((entry) => entry.sessionId === sessionId)?.view ?? undefined)
          loaded = true
          failure = undefined
          intake.seed(snapshot.snapshotPosition)
          options.onChange(sessionId)
          return view === undefined ? { kind: "missing" } : HELD
        } catch (cause) {
          if (retired || disposed) return RELEASED
          if (lostWithLane(cause)) {
            if (request === generation) await reread.promise
            if (retired || disposed) return RELEASED
          }
          const newer = superseded()
          if (newer) return await newer
          options.onDiagnostic?.("session detail read failed", cause)
          failure = errorMessage(cause)
          options.onChange(sessionId)
          return { kind: "failed", cause }
        }
      })()
      latest = read
      return read
    }
    return {
      get view() { return view },
      get lost() { return lost },
      get state() { return failure === undefined ? { loaded } : { loaded, error: failure } },
      ensure(): Promise<HoldOutcome> {
        if (view) return Promise.resolve(HELD)
        pending ??= refresh().finally(() => { pending = undefined })
        return pending
      },
      refresh,
      accept: (patch: RuntimeUiPatch) => intake.accept(patch),
      dispose() { retired = true; generation += 1; intake.reset(); reread.resolve() },
      /** A detail snapshot holds the session's detail for this connection
       *  until it releases it, once no newer reading holds it again. */
      release(free: () => boolean): void {
        if (latest === undefined) return
        releaseAfterLastRead({ lastRead: latest, free, release: async () => { await options.client.dispatch({ type: "session_detail.release", sessionId }) } })
      },
    }
  }

  /** Holds `sessionId`, and its parent chain through the shared resolver
   *  when `chain` says so, in one await of the session's own read. */
  async function holdReading(sessionId: string, chain: boolean): Promise<HoldOutcome> {
    if (disposed) return RELEASED
    let reading = readings.get(sessionId)
    if (!reading) {
      reading = createReading(sessionId)
      readings.set(sessionId, reading)
    }
    const outcome = await reading.ensure()
    if (readings.get(sessionId) !== reading) return RELEASED
    const parent = reading.view?.row.parentSessionId
    if (chain && outcome.kind === "held" && parent) {
      await resolveSessionRoute(async (id) => (await holdReading(id, false)).kind === "held" ? rowOf(id) : undefined, parent)
    }
    return outcome
  }
  function forget(sessionId: string): void {
    const reading = readings.get(sessionId)
    if (!reading) return
    reading.dispose()
    readings.delete(sessionId)
    reading.release(() => !readings.has(sessionId))
    if (!disposed) options.onChange(sessionId)
  }
  const rowOf = (sessionId: string): SessionRow | undefined => readings.get(sessionId)?.view?.row
  return {
    get rows() { return [...readings.values()].flatMap(({ view }) => view && view.row.kind !== "chat" ? [view.row] : []) },
    get(sessionId) { const row = rowOf(sessionId); return row?.kind === "chat" ? undefined : row },
    detail: rowOf,
    view: (sessionId) => readings.get(sessionId)?.view,
    state: (sessionId) => readings.get(sessionId)?.state,
    root(sessionId, catalogRow) {
      const visited = new Set<string>()
      let current = sessionId
      while (current && !visited.has(current)) {
        visited.add(current)
        const row = rowOf(current) ?? catalogRow(current)
        if (row?.kind === "chat") return current
        current = row?.parentSessionId
      }
      return undefined
    },
    has: (sessionId) => readings.has(sessionId),
    lost: (sessionId) => readings.get(sessionId)?.lost,
    holdSession: (sessionId) => holdReading(sessionId, false),
    hold: (sessionId) => holdReading(sessionId, true),
    forget,
    retainChains(sessionIds) {
      const retained = new Set<string>()
      for (const sessionId of sessionIds) {
        let current: string | undefined = sessionId
        while (current && !retained.has(current)) {
          retained.add(current)
          current = rowOf(current)?.parentSessionId ?? undefined
        }
      }
      for (const id of readings.keys()) if (!retained.has(id)) forget(id)
    },
    refresh(sessionIds = readings.keys()) { for (const id of sessionIds) void readings.get(id)?.refresh() },
    accept(patch) {
      if (patch.cursor.scope === "session" && patch.cursor.domain === "session_detail") readings.get(patch.cursor.sessionId)?.accept(patch)
    },
    dispose() { disposed = true; for (const id of readings.keys()) forget(id) },
  }
}
