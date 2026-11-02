import type { AttachedRuntimeClient } from "../app-service-types.js"
import {
  isGlobalRuntimeInvalidation,
  isRuntimeInvalidationPayload,
  type RuntimeSessionCursorIdentity,
  type RuntimeSessionViewsResult,
  type RuntimeUiPatch,
  type RuntimeUiPatchPayload,
} from "../runtime-ui-protocol-types.js"
import { lostWithLane } from "./connection-failures.js"
import { isLaneBreak } from "./cursor-intake.js"
import { createFamilyIntake, runtimeSnapshotScopeKey } from "./family-intake.js"

/** One session-scoped domain's readings (budget, status, workflow view,
 *  question, roles, a module's session domain) for every session a client
 *  shows. The terminal and the web client both read their session domains
 *  through this one family, so what a session's view costs is one decision:
 *
 *  - A session is read once on each lane when the client shows it, even when
 *    a live patch already delivered its view. A broadcast patch is not
 *    demand: the runtime learns that a client shows a session only from a
 *    read, and it answers a read with more than its patches carry, such as a
 *    budget's generation speed.
 *  - Every read asked for in one task goes out as one read at one published
 *    watermark, so a list, a lane, or a global invalidation costs one read
 *    for the domain whatever it shows.
 *  - Live patches for a session being read wait behind the read and replay
 *    after its seed. A newer read or a retired session adopts no late answer.
 *  - A lane break keeps every view on screen, and the next lane reads every
 *    session held at the break again. A session the runtime no longer serves
 *    answers null and drops out then.
 *
 *  The family keeps no views of its own. It reads and writes them through
 *  the client's store, so each view has one home. */
export interface SessionReadingFamily {
  /** Reads each session not read on this lane yet. */
  ensure(sessionIds: Iterable<string>): void
  /** Reads the sessions again, replacing a read in flight, such as after a
   *  send that changes what the runtime will answer. */
  refresh(sessionIds: Iterable<string>): void
  /** Forgets the session: its view, its reads, and its live patches. */
  retire(sessionId: string): void
  /** Every session the family holds: read, being read, or with a view. */
  sessionIds(): readonly string[]
  dispose(): void
}

/** The client's store for one domain's views, by session. */
export interface SessionViewStore<View> {
  get(sessionId: string): View | undefined
  set(sessionId: string, view: View): void
  delete(sessionId: string): void
  keys(): Iterable<string>
}

type SessionCursor<Domain extends string> = RuntimeSessionCursorIdentity & { readonly domain: Domain }

export interface SessionReadingFamilyOptions<Domain extends string, Payload extends RuntimeUiPatchPayload, View> {
  readonly domain: Domain
  readonly cursor: (sessionId: string) => SessionCursor<Domain>
  readonly client: Pick<AttachedRuntimeClient, "subscribe" | "onLane"> & Partial<Pick<AttachedRuntimeClient, "query">>
  /** Reads the sessions at one published watermark. Only returned entries
   *  are covered, including null views. */
  readonly query: (sessionIds: readonly string[]) => Promise<RuntimeSessionViewsResult<View>>
  /** True when the runtime answers a read for one session only. Each session
   *  then gets its own read, because one answer carries one watermark. */
  readonly readsOneSession?: boolean
  /** True when a live payload belongs to this domain (its update or removal kind). */
  readonly isPayload: (payload: RuntimeUiPatchPayload) => payload is Payload
  /** Folds a live payload into the session's held view; null is the domain's `*.removed` kind. */
  readonly payloadView: (payload: Payload, current: View | undefined) => View | null
  /** The view held once a fresh view, from a read or a live payload, arrives
   *  for a session: for a domain whose fresh view can know less than the held
   *  one, such as a budget still loading. The fresh view when absent. */
  readonly settle?: (held: View | undefined, fresh: View) => View
  /** The view held once the lane breaks, from the view held then: for a domain
   *  whose view runs on past its last delivery, such as a status whose clock
   *  a client advances, it states what was known at the break. The held view
   *  stays until the view read from the next lane replaces it. Unchanged when
   *  absent. */
  readonly heldAcrossBreak?: (held: View, brokeAt: number) => View
  /** Whether a live patch for a session the family does not hold yet is
   *  kept. Every patch is kept when absent. A client that shows few of the
   *  sessions the runtime broadcasts keeps only those. */
  readonly admits?: (sessionId: string) => boolean
  readonly views: SessionViewStore<View>
  /** Called once after a read or a live payload changed the views. */
  readonly changed?: () => void
  /** Reports the first failure of a read episode. Recovery retries with backoff. */
  readonly onReadFailed?: (cause: unknown) => void
}

type DomainPatch<Domain extends string, Payload extends RuntimeUiPatchPayload> = RuntimeUiPatch & {
  readonly cursor: SessionCursor<Domain>
  readonly payload: Payload
}
type CursorScope<Domain extends string> = { readonly kind: "cursor"; readonly cursor: SessionCursor<Domain> }
/** One read over several sessions. It gathers the sessions asked for in one
 *  task, and its session list is fixed once the read goes out. */
interface BatchScope {
  readonly kind: "batch"
  readonly key: string
  sessionIds: readonly string[]
  sent: boolean
}
type ReadScope<Domain extends string> = CursorScope<Domain> | BatchScope

export function createSessionReadingFamily<Domain extends string, Payload extends RuntimeUiPatchPayload, View>(
  options: SessionReadingFamilyOptions<Domain, Payload, View>,
): SessionReadingFamily {
  const { views } = options
  // The sessions read on this lane. A live patch fills a view but is not a
  // read, so it does not end the session's demand for one.
  const read = new Set<string>()
  // The sessions whose live patches this family took and whose view a
  // removal has not ended, read or not.
  const patched = new Set<string>()
  // The read, gathering or in flight, that owns each session. Live patches
  // for the session wait behind it, and a new ask for it joins it.
  const owners = new Map<string, BatchScope>()
  // The read that started last for each session, which alone adopts an
  // answer for it. A read that recovery starts again is the newest again.
  const newest = new Map<string, ReadScope<Domain>>()
  // The reads gathered in this task, sent at its end. A live patch that
  // needs one of them sooner starts it at once through the intake.
  let gathering: BatchScope[] = []
  // The sessions held when the lane broke, read again when the next lane opens.
  let heldAtBreak = new Set<string>()
  let reads = 0
  let disposed = false

  const held = (sessionId: string): boolean =>
    read.has(sessionId) || patched.has(sessionId) || owners.has(sessionId) || views.get(sessionId) !== undefined
  const heldSessions = (): Set<string> => new Set([...read, ...patched, ...owners.keys(), ...views.keys()])

  function applyView(sessionId: string, view: View | null): void {
    if (view === null) views.delete(sessionId)
    else views.set(sessionId, options.settle ? options.settle(views.get(sessionId), view) : view)
  }

  /** Whether a read's answer for the session is still wanted: no read that
   *  started later asked for the session, and it was not retired since. */
  function adopts(sessionId: string, scope: ReadScope<Domain>): boolean {
    return newest.get(sessionId) === scope
  }

  function ask(sessionIds: Iterable<string>, again: boolean): void {
    if (disposed) return
    const replaced = new Set<BatchScope>()
    for (const sessionId of sessionIds) {
      const previous = owners.get(sessionId)
      if (previous !== undefined && !previous.sent) continue
      if (!again && (previous !== undefined || read.has(sessionId))) continue
      const scope = gatheringScope()
      scope.sessionIds = [...scope.sessionIds, sessionId]
      owners.set(sessionId, scope)
      if (previous) replaced.add(previous)
    }
    for (const previous of replaced) cancelUnowned(previous)
  }

  /** The read that gathers the next session asked for in this task. */
  function gatheringScope(): BatchScope {
    const open = gathering.at(-1)
    if (open !== undefined && !open.sent && !(options.readsOneSession && open.sessionIds.length > 0)) return open
    if (gathering.length === 0) queueMicrotask(send)
    const scope: BatchScope = { kind: "batch", key: `batch:${++reads}`, sessionIds: [], sent: false }
    gathering.push(scope)
    return scope
  }

  function send(): void {
    const scopes = gathering
    gathering = []
    if (disposed) return
    for (const scope of scopes) {
      if (!scope.sessionIds.some((sessionId) => owners.get(sessionId) === scope)) continue
      // A read a live patch already started is joined, not sent twice.
      void intake.resnapshot(scope)
        .catch(() => {})
    }
  }

  /** Cancels a read in flight that no longer owns any session. */
  function cancelUnowned(scope: BatchScope): void {
    if (!scope.sessionIds.some((sessionId) => owners.get(sessionId) === scope)) intake.cancelSnapshot(scope)
  }

  // A reconnect after sleep, SIGCONT, an idle timeout, or a runtime restart
  // does not guarantee a future patch for state that changed entirely inside
  // the gap, so nothing held before the break is trusted past it. The views
  // stay on screen until the next lane's reads replace them; clearing them
  // instead would blank every session for the length of the gap.
  function breakLane(): void {
    if (options.heldAcrossBreak) {
      const brokeAt = Date.now()
      let moved = false
      for (const sessionId of views.keys()) {
        const view = views.get(sessionId)
        if (view === undefined) continue
        views.set(sessionId, options.heldAcrossBreak(view, brokeAt))
        moved = true
      }
      if (moved) options.changed?.()
    }
    heldAtBreak = new Set([...heldAtBreak, ...heldSessions()])
    read.clear()
    // The intake aborts the reads in flight at the break, but their owning
    // `finally` runs a microtask later. Clearing ownership here keeps a read
    // the next lane starts from being refused by a dead one. A read still
    // gathering goes out with the next lane's reads instead.
    owners.clear()
    gathering = []
  }

  const intake = createFamilyIntake<ReadScope<Domain>, RuntimeSessionViewsResult<View>, DomainPatch<Domain, Payload>>({
    readTransport: options.client.query === undefined ? undefined : { query: options.client.query },
    label: options.domain,
    onEvent(event) {
      if (event.type !== "patch") return
      if (isLaneBreak(event.patch)) breakLane()
      // Every view may be stale. One read covers every held session.
      else if (isGlobalRuntimeInvalidation(event.patch)) ask(heldSessions(), true)
    },
    onConnected() {
      const reread = heldAtBreak
      heldAtBreak = new Set()
      ask(reread, false)
      // The lane's reads go out in its opening burst.
      send()
    },
    accept(patch) {
      if (!isDomainPatch(patch)) return null
      const sessionId = patch.cursor.sessionId
      if (options.admits && !held(sessionId) && !options.admits(sessionId)) return null
      patched.add(sessionId)
      const cursor = options.cursor(sessionId)
      return { cursor, scope: owners.get(sessionId) ?? { kind: "cursor", cursor }, patch }
    },
    scopeKey: (scope) => scope.kind === "batch" ? scope.key : runtimeSnapshotScopeKey(scope),
    mergeRetryScopes: options.readsOneSession ? undefined : (scopes) => {
      if (scopes.length === 1) return scopes[0]
      const sessionIds = [...new Set(scopes.flatMap(scope => scope.kind === "cursor" ? [scope.cursor.sessionId] : scope.sessionIds))].filter(held)
      const scope: BatchScope = { kind: "batch", key: `batch:${++reads}`, sessionIds, sent: false }
      for (const sessionId of sessionIds) owners.set(sessionId, scope)
      return scope
    },
    loadSnapshot(scope) {
      const sessionIds = scope.kind === "cursor"
        ? [scope.cursor.sessionId]
        // A gathered read leaves out a session retired or asked again while
        // it gathered; a read that recovery starts again leaves out a
        // session retired since.
        : scope.sessionIds.filter((sessionId) => scope.sent ? held(sessionId) : owners.get(sessionId) === scope)
      if (scope.kind === "batch") {
        // The list is fixed now: later asks gather a new read.
        scope.sent = true
        scope.sessionIds = sessionIds
      }
      for (const sessionId of sessionIds) newest.set(sessionId, scope)
      return options.query(sessionIds)
    },
    applySnapshot(snapshot, scope) {
      // The read told the runtime that this client shows each session it
      // named, whether or not its answer covers it. Only returned entries
      // seed a view and a position.
      for (const sessionId of scope.kind === "cursor" ? [scope.cursor.sessionId] : scope.sessionIds) {
        if (adopts(sessionId, scope)) read.add(sessionId)
      }
      const adopted = snapshot.views.filter((entry) => adopts(entry.sessionId, scope))
      if (scope.kind === "batch") {
        for (const sessionId of scope.sessionIds) if (owners.get(sessionId) === scope) owners.delete(sessionId)
      }
      for (const entry of adopted) applyView(entry.sessionId, entry.view)
      if (adopted.length > 0) options.changed?.()
      return { snapshotPosition: snapshot.snapshotPosition, cursors: adopted.map((entry) => options.cursor(entry.sessionId)) }
    },
    applyPayload(patch, accepted, context) {
      const view = options.payloadView(patch.payload, views.get(patch.cursor.sessionId))
      applyView(patch.cursor.sessionId, view)
      options.changed?.()
      if (view !== null) return
      patched.delete(patch.cursor.sessionId)
      // A session read on this lane keeps its position, so the view that
      // follows a removal, such as the next question a chat asks once one is
      // answered, applies at once rather than after a gap and a read. A
      // session held by its patches alone is forgotten.
      if (!held(patch.cursor.sessionId)) context.release(accepted.cursor)
    },
    diagnostics(name, detail) {
      if (name === "resnapshot.error" && !lostWithLane(detail?.error)) options.onReadFailed?.(detail?.error)
    },
  })

  function isDomainPatch(patch: RuntimeUiPatch): patch is DomainPatch<Domain, Payload> {
    return patch.cursor.scope === "session" && patch.cursor.domain === options.domain && (options.isPayload(patch.payload) || isRuntimeInvalidationPayload(patch.payload))
  }

  const unsubscribe = options.client.subscribe(intake.handle)
  const stopLanes = options.client.onLane(intake.lane)

  return {
    ensure: (sessionIds) => { ask(sessionIds, false) },
    refresh: (sessionIds) => { ask(sessionIds, true) },
    retire(sessionId) {
      if (disposed) return
      const cursor = options.cursor(sessionId)
      read.delete(sessionId)
      patched.delete(sessionId)
      newest.delete(sessionId)
      heldAtBreak.delete(sessionId)
      const owner = owners.get(sessionId)
      owners.delete(sessionId)
      if (owner) cancelUnowned(owner)
      intake.cancelSnapshot({ kind: "cursor", cursor })
      intake.release(cursor)
      views.delete(sessionId)
    },
    sessionIds: () => [...heldSessions()],
    dispose() {
      if (disposed) return
      disposed = true
      stopLanes()
      unsubscribe()
      intake.dispose()
    },
  }
}
