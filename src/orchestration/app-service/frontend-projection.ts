import { errorDetail, errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import type { SessionManager } from "../session/manager.js"
import type { DurableSessionCatalogRow } from "../session/session-catalog-types.js"
import { recordedExecutionCwd } from "../session/session-execution-directory.js"
import { durableCatalogRowFromSession, mergeListMetadata, projectSessionCatalogRow, replaceCatalogTotals, type SessionActionEvidence } from "../session/session-catalog-row.js"
import { subagentRunOutcome, subagentSessionActions, subagentStoppedBy } from "../session/child-session-run-evidence.js"
import { chatSessionActions } from "../session/chat-session-run-evidence.js"
import type { SessionEntry, SessionStore } from "../session-store/types.js"
import type { SessionView } from "../session-store/view.js"
import { entryActivity } from "../session-store/activity.js"
import type {
  SessionCatalogRow,
  SessionCatalogSnapshot,
  SessionRow,
  Unsubscribe,
} from "../../protocol/app-service-types.js"
import type { RuntimeSummaryProjection } from "./runtime-summary-projection.js"

const DEFAULT_MAX_SNAPSHOT_HZ = 20

const log = Log.create({ service: "frontend-projection" })

export interface ProjectedSession {
  readonly row: SessionRow
}
type CatalogRowWithoutExecutionCwd<Row = SessionRow> = Row extends SessionRow ? Omit<Row, "executionCwd"> : never

/** One UI-visible change to a single session, ready for the app-service to mint
 *  a `session`-domain patch from. `added`/`updated` carry the whole catalog row
 *  (the idempotent unit); `removed` names only the gone session. */
export type SessionChange =
  | { kind: "added"; row: SessionCatalogRow }
  | { kind: "updated"; row: SessionCatalogRow }
  | { kind: "removed"; sessionId: string }

/** The catalog lists chats only. Workflow and subagent children have no row here
 *  and no `session`-domain patch: it is reached through `sessionDetail` and
 *  the per-session domains (ARCH-PROTOCOL-048), so a session that dispatches many
 *  children never churns every client's catalog. */
export interface FrontendProjection {
  snapshot(): Promise<SessionCatalogSnapshot>
  hasLiveSession(sessionId: string): boolean
  /** The listed row for a live session, or null for a child or an unknown id. */
  liveCatalogRow(sessionId: string): Promise<SessionCatalogRow | null>
  /** The listed row for a session, or null for a child or an unknown id. */
  catalogRow(sessionId: string): Promise<SessionCatalogRow | null>
  /** Subscribe to whole-row patches for changed metadata IDs, changed live
   *  row inputs, and liveness transitions. Unchanged catalog rows are not re-projected. */
  subscribe(onChanges: (changes: readonly SessionChange[]) => void): Unsubscribe
  dispose(): void
}


export interface FrontendProjectionDeps {
  readonly sessionStore: SessionStore
  readonly manager: SessionManager
  readonly projectRoot: string
  readonly summaries?: RuntimeSummaryProjection
  readonly maxSnapshotHz?: number
}

interface CatalogDiffState {
  keyById: Map<string, string | null>
  /** The entry values each live row was last projected from. */
  inputsById: Map<string, readonly unknown[]>
  liveIds: Set<string>
  metadataById: Map<string, DurableSessionCatalogRow>
  /** Sessions this diff has met as children. A child is never keyed, so its
   *  signalled deletion is not the durable-only removal the sweep must emit. */
  children: Set<string>
  /** Sessions whose last row projection threw, so the failure is reported once
   *  per streak instead of once per flush. Cleared when the row projects again. */
  failedProjections: Set<string>
}

function catalogMetadataById(list: readonly DurableSessionCatalogRow[]): Map<string, DurableSessionCatalogRow> {
  return new Map(list.map((row) => [row.id, row] as const))
}

const LOADING_SUMMARIES: RuntimeSummaryProjection = {
  admit: async () => {},
  view: () => ({ totalsLoading: true }),
  subscribe: () => () => {},
  settled: async () => {},
  dispose() {},
}

export function createFrontendProjection(deps: FrontendProjectionDeps): FrontendProjection {
  const summaries = deps.summaries ?? LOADING_SUMMARIES
  const minSnapshotIntervalMs = 1000 / (deps.maxSnapshotHz ?? DEFAULT_MAX_SNAPSHOT_HZ)
  const subscriptions = new Set<Unsubscribe>()
  const listedIds = new Set<string>()

  async function snapshot(): Promise<SessionCatalogSnapshot> {
    const list = await deps.manager.listMetadata()
    void summaries.admit(list.sessions.map((session) => session.id))
    const rows = projectSessionList(list.sessions)
    listedIds.clear()
    for (const row of rows) listedIds.add(row.id)
    return {
      rows,
      activeRuntimeCount: listedLiveIds(deps.sessionStore).filter((id) => deps.sessionStore.isRunning(id)).length,
      errors: list.errors,
    }
  }

  function hasLiveSession(sessionId: string): boolean {
    return deps.sessionStore.get(sessionId) !== undefined
  }

  async function liveCatalogRow(sessionId: string): Promise<SessionCatalogRow | null> {
    void summaries.admit([sessionId])
    const entry = deps.sessionStore.get(sessionId)
    if (!entry) return null
    const metadata = await liveSessionMetadata(deps, sessionId)
    if (!metadata) return null
    return listedRow(withRuntimeSummary(projectEntrySummary(sessionId, entry, metadata), summaries))
  }

  async function catalogRow(sessionId: string): Promise<SessionCatalogRow | null> {
    void summaries.admit([sessionId])
    const entry = deps.sessionStore.get(sessionId)
    const metadata = await (entry ? liveSessionMetadata(deps, sessionId) : readSessionMetadata(deps, sessionId))
    if (!metadata) return null
    return listedRow(entry
      ? withRuntimeSummary(projectEntrySummary(sessionId, entry, metadata), summaries)
      : withRuntimeSummary(projectSessionCatalogRow(metadata), summaries))
  }


  function subscribe(onChanges: (changes: readonly SessionChange[]) => void): Unsubscribe {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | null = null
    let lastNotifiedAt = 0
    // Per-session change gate, as the status projection gates its view: a
    // live row is a function of the entry values it reads (`catalogRowInputs`)
    // and its durable metadata (gated by manager change IDs). Metadata and
    // stat changes also refresh durable-only rows. Only affected IDs are
    // re-emitted, so a streaming session, whose entry moves on every output
    // sync, projects no row until a value its row shows changes.
    const liveIds = listedLiveIds(deps.sessionStore)
    // Live rows only: durable rows reach the client through snapshot(), so the
    // initial diff baseline never pays a whole-catalog read.
    const initialRows = new Map(liveIds.flatMap((id) => {
      const entry = deps.sessionStore.get(id)
      return entry ? [[id, { row: entrySummary(id, entry), inputs: catalogRowInputs(entry) }] as const] : []
    }))
    const diffState: CatalogDiffState = {
      keyById: new Map(),
      inputsById: new Map(),
      liveIds: new Set(),
      metadataById: new Map(),
      children: new Set(),
      failedProjections: new Set(),
    }
    const pendingStats = new Set<string>()
    const pendingMetadata = new Set<string>()
    // Listed sessions whose store entry moved since the last flush. Undefined
    // after a store membership or order change, when the flush sweeps every
    // live and formerly live row.
    let pendingLive: Set<string> | undefined = new Set()
    const initialized = (async () => {
      const initialMetadataById = await metadataForIds(deps, liveIds)
      if (disposed) return
      diffState.metadataById = initialMetadataById
      for (const id of liveIds) {
        const initial = initialRows.get(id)
        if (!initial) continue
        const metadata = initialMetadataById.get(id)
        // No metadata row means no execution directory, so the session has no
        // projectable row yet; the next diff emits it once metadata lands.
        if (!metadata) continue
        const row = withRuntimeSummary(mergeListMetadata(initial.row, metadata), summaries)
        // A notification during this read belongs to the first patch, even if
        // the baseline read already includes its committed value.
        diffState.keyById.set(id, pendingMetadata.has(id) || pendingStats.has(id) ? null : JSON.stringify(row))
        diffState.inputsById.set(id, initial.inputs)
        diffState.liveIds.add(id)
      }
    })().catch((error: unknown) => { log.warn("session catalog baseline failed", { error: errorMessage(error) }) })
    // Deletions the manager has signalled since the last flush. A deleted
    // durable-only session leaves no diffable evidence - its metadata row is
    // gone from the very list a re-read would return - so the writer's signal
    // is the authority for its `removed` emission.
    const pendingRemovals = new Set<string>()
    // True while scoped catalog reads are failing, so a failure streak is
    // reported once instead of once per flush.
    let diffSuspended = false

    let flushing = false
    let notifiedDuringFlush = false

    const emit = (changes: readonly SessionChange[]): void => {
      lastNotifiedAt = Date.now()
      onChanges(changes)
    }

    const flush = async (): Promise<void> => {
      timer = null
      if (disposed) return
      flushing = true
      await initialized
      const live = pendingLive
      const metadata = new Set(pendingMetadata)
      const removals = new Set(pendingRemovals)
      const stats = new Set(pendingStats)
      pendingLive = new Set()
      pendingMetadata.clear()
      pendingRemovals.clear()
      pendingStats.clear()
      let changes: readonly SessionChange[]
      try {
        changes = await diffSessionCatalog(deps, diffState, live, metadata, removals, stats)
      } catch (err) {
        // A scoped catalog read failure must never kill the patch stream: it
        // once died silently here and every later launch stayed invisible to
        // connected clients. Keep all dirty inputs so the next signal retries.
        if (!diffSuspended) {
          diffSuspended = true
          log.warn("session catalog diff failed; patches suspended until a later signal succeeds", { error: errorMessage(err), errorDetail: errorDetail(err) })
        }
        if (live) for (const id of live) pendingLive?.add(id)
        else pendingLive = undefined
        for (const id of removals) pendingRemovals.add(id)
        for (const id of metadata) pendingMetadata.add(id)
        for (const id of stats) pendingStats.add(id)
        return
      } finally {
        flushing = false
        if (notifiedDuringFlush) {
          notifiedDuringFlush = false
          notify()
        }
      }
      diffSuspended = false
      if (!disposed && changes.length > 0) emit(changes)
    }

    const notify = (): void => {
      if (disposed) return
      if (flushing) { notifiedDuringFlush = true; return }
      if (timer) return
      const delay = minSnapshotIntervalMs - (Date.now() - lastNotifiedAt)
      timer = setTimeout(flush, Math.max(0, delay))
    }

    const unsubscribeStore = deps.sessionStore.onChange((changed) => {
      if (!changed) {
        pendingLive = undefined
        notify()
        return
      }
      // The catalog lists chats only, so a child's change wakes nothing.
      const listed = [...changed].filter((id) => deps.sessionStore.get(id)?.kind === "chat")
      if (listed.length === 0) return
      for (const id of listed) pendingLive?.add(id)
      notify()
    }, "frontend-projection")
    const unsubscribeManager = deps.manager.subscribe((change) => {
      if (change.kind === "deleted") {
        if (listedIds.has(change.sessionId) || diffState.keyById.has(change.sessionId)) pendingRemovals.add(change.sessionId)
      }
      else for (const id of change.sessionIds) pendingMetadata.add(id)
      notify()
    })
    const unsubscribeSummaries = summaries.subscribe((sessionIds) => {
      for (const sessionId of sessionIds) pendingStats.add(sessionId)
      notify()
    })
    const unsubscribe = (): void => {
      disposed = true
      if (timer) clearTimeout(timer)
      unsubscribeStore()
      unsubscribeManager()
      unsubscribeSummaries()
      subscriptions.delete(unsubscribe)
    }
    subscriptions.add(unsubscribe)
    return unsubscribe
  }

  return { snapshot, hasLiveSession, liveCatalogRow, catalogRow, subscribe, dispose: () => { for (const unsubscribe of subscriptions) unsubscribe() } }

  function projectSessionList(list: readonly DurableSessionCatalogRow[]): readonly SessionCatalogRow[] {
    const metadataById = catalogMetadataById(list.filter((row) => row.kind === "chat"))
    const liveById = new Map<string, SessionCatalogRow>()
    for (const id of listedLiveIds(deps.sessionStore)) {
      const entry = deps.sessionStore.get(id)
      const metadata = metadataById.get(id)
      const live = entry && metadata ? listedRow(withRuntimeSummary(projectEntrySummary(id, entry, metadata), summaries)) : null
      if (live) liveById.set(id, live)
    }
    const projected = [...metadataById.values()].flatMap((row) => {
      const listed = liveById.get(row.id) ?? listedRow(withRuntimeSummary(projectSessionCatalogRow(row), summaries))
      return listed ? [listed] : []
    })
    for (const [id, live] of liveById) if (!metadataById.has(id)) projected.push(live)
    return projected
  }
}

function listedRow(row: SessionRow): SessionCatalogRow | null {
  return row.kind === "chat" ? row : null
}

/** Live sessions the catalog lists: every store entry except a child's. */
function listedLiveIds(sessionStore: SessionStore): readonly string[] {
  return sessionStore.allIds().filter((id) => sessionStore.get(id)?.kind === "chat")
}

async function liveSessionMetadata(deps: FrontendProjectionDeps, sessionId: string): Promise<DurableSessionCatalogRow | undefined> {
  return readSessionMetadata(deps, sessionId)
}

/** A child's row here only marks it as a child, since the catalog never
 *  lists one (`listedRow`), so a workflow agent's directory needs no read of
 *  its workflow: its detail resolves that through membership. */
async function readSessionMetadata(deps: FrontendProjectionDeps, sessionId: string): Promise<DurableSessionCatalogRow | undefined> {
  const session = await deps.manager.read(sessionId)
  return session && session.kind !== "workflow" ? durableCatalogRowFromSession(sessionId, session, recordedExecutionCwd(session, deps.projectRoot)) : undefined
}

/** `pendingLive` names the listed sessions whose store entry moved; undefined
 *  sweeps every live and formerly live row. */
async function diffSessionCatalog(
  deps: FrontendProjectionDeps,
  state: CatalogDiffState,
  pendingLive: ReadonlySet<string> | undefined,
  pendingMetadata: Set<string>,
  pendingRemovals: ReadonlySet<string>,
  pendingStats: Set<string>,
): Promise<SessionChange[]> {
  const changes: SessionChange[] = []
  const seen = new Set<string>()
  const liveIds = pendingLive ?? [...listedLiveIds(deps.sessionStore), ...state.liveIds]
  const ids = new Set([...liveIds, ...pendingMetadata, ...pendingRemovals, ...pendingStats, ...state.failedProjections])
  const metadataById = state.metadataById
  // Only rows whose metadata, summary, projection, or live membership changed
  // need a fresh scoped metadata read.
  const statIds = [...ids].filter((id) => !pendingRemovals.has(id)
    && (pendingMetadata.has(id)
      || pendingStats.has(id)
      || state.failedProjections.has(id)
      || state.liveIds.has(id) !== (deps.sessionStore.get(id)?.kind === "chat")))
  if (statIds.length > 0) {
    const catalog = await metadataForIds(deps, statIds)
    for (const id of statIds) metadataById.delete(id)
    for (const [id, metadata] of catalog) metadataById.set(id, metadata)
  }
  for (const id of ids) {
    const live = deps.sessionStore.has(id)
    if (pendingRemovals.has(id)) {
      metadataById.delete(id)
      pendingMetadata.delete(id)
      state.failedProjections.delete(id)
      if (live || state.children.delete(id)) seen.add(id)
      continue
    }
    let change: SessionChange | null
    try {
      const metadataDirty = pendingMetadata.has(id) || state.failedProjections.has(id)
      if (live || metadataById.has(id)) seen.add(id)
      change = changedCatalogRow(deps, state, metadataById, id, metadataDirty, pendingStats.has(id))
    } catch (err) {
      // One session's unprojectable row degrades that session only (the same
      // quarantine rule the metadata projection applies to corrupt facts). Its
      // previously published row stands, and every later flush retries it.
      if (!state.failedProjections.has(id)) {
        state.failedProjections.add(id)
        log.warn("session catalog row projection failed; row withheld until it heals", { sessionId: id, error: errorMessage(err), errorDetail: errorDetail(err) })
      }
      seen.add(id)
      continue
    }
    state.failedProjections.delete(id)
    pendingMetadata.delete(id)
    if (change) changes.push(change)
  }
  appendRemovedCatalogRows(state, ids, seen, changes, pendingRemovals)
  for (const id of pendingStats) {
    if (!state.failedProjections.has(id)) pendingStats.delete(id)
  }
  return changes
}

function changedCatalogRow(
  deps: FrontendProjectionDeps,
  state: CatalogDiffState,
  metadataById: ReadonlyMap<string, DurableSessionCatalogRow>,
  id: string,
  metadataDirty: boolean,
  statsDirty: boolean,
): SessionChange | null {
  const metadata = metadataById.get(id)
  const live = deps.sessionStore.get(id)
  if ((live && live.kind !== "chat") || (metadata && metadata.kind !== "chat")) {
    state.children.add(id)
    return null
  }
  const inputs = live ? catalogRowInputs(live) : undefined
  const isLive = live !== undefined
  const known = state.keyById.has(id)
  const unchanged = known
    && !statsDirty
    && !metadataDirty
    && sameInputs(state.inputsById.get(id), inputs)
    && state.liveIds.has(id) === isLive
  if (unchanged) return null

  const row = metadata
    ? listedRow(live
      ? withRuntimeSummary(projectEntrySummary(id, live, metadata), deps.summaries)
      : withRuntimeSummary(projectSessionCatalogRow(metadata), deps.summaries))
    : null
  if (!row) return null
  const key = JSON.stringify(row)
  if (inputs) state.inputsById.set(id, inputs)
  else state.inputsById.delete(id)
  if (isLive) state.liveIds.add(id)
  else state.liveIds.delete(id)
  if (state.keyById.get(id) === key) return null
  state.keyById.set(id, key)
  return { kind: known ? "updated" : "added", row }
}

function appendRemovedCatalogRows(
  state: CatalogDiffState,
  ids: ReadonlySet<string>,
  seen: ReadonlySet<string>,
  changes: SessionChange[],
  pendingRemovals: ReadonlySet<string>,
): void {
  const removed = new Set<string>()
  for (const id of ids) {
    if (seen.has(id) || !state.keyById.has(id)) continue
    removed.add(id)
  }
  // A signalled deletion the sweep cannot see: the session only ever existed
  // as durable metadata, so the diff never keyed it. Ids still present are
  // skipped (a live entry lingering until its actor drops it); the sweep
  // emits those when the store change lands.
  for (const id of pendingRemovals) {
    if (!seen.has(id)) removed.add(id)
  }
  for (const id of removed) {
    state.keyById.delete(id)
    state.inputsById.delete(id)
    state.liveIds.delete(id)
    state.metadataById.delete(id)
    state.children.delete(id)
    changes.push({ kind: "removed", sessionId: id })
  }
}


/** Projects one live session's row. `toolUseId` names the parent chat's tool
 *  call a workflow answers. */
export function projectSessionView(view: Extract<SessionView, { kind: "chat" }>, executionCwd: string, evidence?: SessionActionEvidence, toolUseId?: string): { readonly row: Extract<SessionRow, { kind: "chat" }> }
export function projectSessionView(view: Extract<SessionView, { kind: "subagent" }>, executionCwd: string, evidence?: SessionActionEvidence, toolUseId?: string): { readonly row: Extract<SessionRow, { kind: "subagent" }> }
export function projectSessionView(view: Extract<SessionView, { kind: "workflow-agent" }>, executionCwd: string, evidence?: SessionActionEvidence, toolUseId?: string): { readonly row: Extract<SessionRow, { kind: "workflow-agent" }> }
export function projectSessionView(view: SessionView, executionCwd: string, evidence?: SessionActionEvidence, toolUseId?: string): ProjectedSession
export function projectSessionView(view: SessionView, executionCwd: string, evidence: SessionActionEvidence = {}, _toolUseId?: string): ProjectedSession {
  const common = {
    id: view.id,
    title: view.description,
    executionCwd,
    lifecycleState: view.lifecycleState,
    notices: evidence.capacityNotice && !view.notices.some(({ id }) => id === evidence.capacityNotice?.id) ? [...view.notices, evidence.capacityNotice] : view.notices,
    lastUpdated: new Date(view.startedAt).toISOString(),
    totalsLoading: true,
    ...(view.shortDescription !== undefined ? { shortTitle: view.shortDescription } : {}),
  } as const
  const stoppedBy = view.kind === "subagent" ? subagentStoppedBy(evidence.childRun) : evidence.childCall?.stoppedBy
  const stopped = stoppedBy !== undefined ? { stoppedBy } : {}
  const row: SessionRow = view.kind === "workflow-agent"
    ? { ...common, kind: view.kind, inputMode: { kind: "message" }, workflowMembership: view.workflowMembership, admittedActions: evidence.memberActive ? ["session.send", ...chatSessionActions(view.kind, view.lifecycleState, evidence.chatTurnEnd, evidence.continuationOwed)] : ["session.delete"] }
    : view.kind === "subagent"
      ? { ...common, kind: "subagent", inputMode: { kind: "message" }, admittedActions: subagentSessionActions(view.lifecycleState, evidence.childRun, evidence.continuationOwed), ...subagentRunOutcome(evidence.childRun), ...stopped }
      : { ...common, kind: "chat", inputMode: { kind: "chat" }, admittedActions: chatSessionActions("chat", view.lifecycleState, evidence.chatTurnEnd, evidence.continuationOwed, evidence.retainedInput) }

  return { row }
}


function projectEntrySummary(id: string, entry: SessionEntry, metadata: DurableSessionCatalogRow): SessionRow {
  return mergeListMetadata(entrySummary(id, entry, metadata), metadata)
}

/** The entry values `entrySummary` reads. Notices are replaced, never
 *  mutated, so identity tells a change. */
function catalogRowInputs(entry: SessionEntry): readonly unknown[] {
  return [entry.description, entry.shortDescription, entry.notices, entryActivity(entry), entry.startedAt]
}

function sameInputs(a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean {
  return a === b || (a !== undefined && b !== undefined && a.length === b.length && a.every((value, index) => value === b[index]))
}

function entrySummary(id: string, entry: SessionEntry, metadata?: DurableSessionCatalogRow): CatalogRowWithoutExecutionCwd {
  const common = {
    id,
    title: entry.description,
    lifecycleState: "active",
    notices: entry.notices,
    lastUpdated: new Date(entry.startedAt).toISOString(),
    activity: entryActivity(entry),
    totalsLoading: true,
    ...(entry.shortDescription !== undefined ? { shortTitle: entry.shortDescription } : {}),
  } as const
  // SAFETY: commitWorkflow publishes member metadata and immutable membership before child execution resources attach a live entry.
  return entry.kind === "workflow-agent"
    ? { ...common, kind: "workflow-agent", inputMode: { kind: "message" }, workflowMembership: metadata!.workflowMembership!, admittedActions: [] }
    : entry.kind === "subagent"
      // A live entry's summary lists the catalog, which holds no child; a
      // child's own detail read projects its row with its run evidence.
      ? { ...common, kind: "subagent", inputMode: { kind: "message" }, admittedActions: subagentSessionActions(common.lifecycleState) }
      // Listed without turn-end evidence: an active chat admits Interrupt
      // here, and the detail read adds Resume once the turn has ended.
      : { ...common, kind: "chat", inputMode: { kind: "chat" }, admittedActions: chatSessionActions("chat", common.lifecycleState) }
}

async function metadataForIds(deps: FrontendProjectionDeps, sessionIds: readonly string[]): Promise<Map<string, DurableSessionCatalogRow>> {
  return catalogMetadataById((await deps.manager.listForIds(sessionIds)).sessions)
}

function withRuntimeSummary<Row extends SessionRow>(row: Row, summaries?: RuntimeSummaryProjection): Row {
  return replaceCatalogTotals(row, (summaries ?? LOADING_SUMMARIES).view(row.id))
}
