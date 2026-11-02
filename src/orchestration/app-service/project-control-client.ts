import { errorMessage } from "../../infra/error-message.js"
import { createSessionPlacements } from "../session/session-metadata-store.js"
import type { ProjectDirectories } from "../../infra/directory-authorities.js"
import { createOrderedLane } from "../../infra/ordered-lane.js"
import { isActiveActivity, type FrontendEvent, type FrontendMutation, type MutationResult, type RuntimeChatDefault, type RuntimeClient, type RuntimeExecutorState, type RuntimeQuery, type RuntimeQueryResult, type RuntimeServiceState, type SessionCatalogError, type SessionCatalogRow, type SessionRow } from "../../protocol/app-service-types.js"
import { mergeCatalogRow } from "../../protocol/client/known-totals.js"
import { withDetailEvidence } from "../../protocol/client/session-controls.js"
import { sessionCursor, workspaceDomainCursor, type RuntimeSessionViewEntry, type RuntimeSessionViewsResult } from "../../protocol/runtime-ui-protocol-types.js"
import { budgetCursor } from "../../protocol/budget-protocol-types.js"
import type { AuthProfileManager } from "../auth/auth-profile-manager.js"
import { resolveSessionAuthProfile } from "../session/session-auth-profile.js"
import { projectSessionCatalogRow, replaceCatalogTotals } from "../session/session-catalog-row.js"
import { editedSessionLabels } from "../session/session-label.js"
import type { DurableSessionCatalogRow } from "../session/session-catalog-types.js"
import type { ProjectStateClient } from "./project-state-client.js"
import type { ProjectExecutorWaiter } from "./project-executor-client.js"
import { executionAskerOf, readAskerOf } from "./project-executor-generations.js"
import { createRuntimeUiBus, type RuntimeUiBus } from "./runtime-ui-bus.js"
import { runtimeReadAnchor } from "./runtime-ui-patch-sequencer.js"
import type { AccountModuleProtocolRoutes } from "./module-protocol-host.js"
import { ProjectExecutionChannelDetached, type ProjectExecutionClient } from "./project-execution-channel.js"
import { ExecutorGenerationChangedError } from "../../protocol/runtime-protocol-schemas.js"
import { serveRuntimeBackgroundQuery, type RuntimeBackgroundLane } from "./runtime-background-lane.js"
import { budgetViewFromRuntimeSummary, createRuntimeSummaryProjection, SUMMARY_ERROR_SCOPES } from "./runtime-summary-projection.js"
import { createPublicOutputSettlement } from "./public-output-settlement.js"
import { settingsWriteResult } from "./settings-mutations.js"
import { createSessionHolds, type SessionHoldGrace, type SessionHolder, type SessionHoldsOptions } from "./session-holds.js"
import { updatesCursor } from "../../protocol/update-protocol-types.js"
import { createSessionDetailPublisher } from "./session-detail-publisher.js"
import type { AccountUpdates } from "../update/account-updates.js"
import { createGitProjection } from "./git-projection.js"
import { replaceOwnedCatalogErrors } from "./catalog-error-ownership.js"
import { gitCursor } from "../../protocol/git-protocol-types.js"

/** The account's update coordinator, as one project serves it. */
export type ProjectUpdates = Pick<AccountUpdates, "status" | "setAutoInstall" | "subscribe">

/** What the account service reports about itself, as one project serves it. */
export interface ProjectServiceState {
  readonly state: () => RuntimeServiceState
  subscribe(listener: (state: RuntimeServiceState) => void): () => void
}

export interface ProjectControlClientOptions {
  readonly state: Pick<ProjectStateClient, "onStored" | "capturePosition" | "readPage"> & {
    readonly sessions: Pick<ProjectStateClient["sessions"], "allocateId" | "createChat" | "listForIds" | "read" | "updateLabel" | "updateLifecycleState" | "subscribe" | "interruptOwed">
  }
  readonly executor: ProjectControlExecutor | Promise<ProjectControlExecutor>
  /** A closed generation has no live activity and selection cannot reactivate it. */
  readonly executionPaused?: () => boolean
  /** Whether explicit input has scheduled the restart of a paused project:
   *  work sent now waits for, and reaches, the generation that restart starts. */
  readonly restartScheduled?: () => boolean
  /** Invalidates private coordinates at generation close and replacement. */
  readonly onExecutionReset?: (listener: () => void) => () => void
  readonly directories: Pick<ProjectDirectories, "projectRoot">
  readonly executionCwd: string
  readonly runtimeVersion: string
  readonly runtimeBuildId: string | null
  readonly chatDefault: () => RuntimeChatDefault
  readonly setChatDefault: (value: RuntimeChatDefault) => void
  readonly authProfiles: Pick<AuthProfileManager, "inspect">
  /** An injected bus remains owned by its caller. Executor buses must not be supplied here. */
  readonly bus?: RuntimeUiBus
  /** Records a failed adoption or catalog refresh that no caller waits on. Must not throw. */
  readonly onError: (error: unknown) => void
  /** Registers a person's interrupt as waiting for the executor that serves
   *  it, independently of its RPC lane, so that an executor proven wedged
   *  while it waits is ended: no heartbeat for the wedge bound, the one
   *  evidence that lets an interrupt end it. Resolves once that end and its
   *  recovery have settled. Never resolves for an executor that answers; the
   *  signal withdraws the wait. */
  readonly endIfWedged: (input: { readonly signal: AbortSignal; readonly waiter: ProjectExecutorWaiter }) => Promise<void>
  /** What a person should know about the executor, for the snapshot; its
   *  changes are published on the `executor` workspace domain. */
  readonly executorState: () => RuntimeExecutorState
  readonly accountModules?: AccountModuleProtocolRoutes
  /** Durable account-history reads, gated by the current executor generation's recovery. */
  readonly history: RuntimeBackgroundLane
  readonly awaitGenerationRecovery: () => Promise<void>
  /** Public client demand starts optional presentation work only after the
   * transport can deliver its result. */
  readonly onPublicSubscriptionChange?: (active: boolean) => void
  /** Update state is account-wide: this facade answers it from the account's
   *  one coordinator and publishes each view it hears, and never asks the
   *  executor (ARCH-PROTOCOL-043). */
  readonly updates: ProjectUpdates
  /** The account service's report about itself is account-wide too: this
   *  facade answers it in the snapshot and publishes each report it hears on
   *  the `service` workspace domain. */
  readonly service: ProjectServiceState
  /** The grace of the session holds of a connection that ended. A test
   *  passes its own timer. */
  readonly sessionHolds: SessionHoldGrace & Pick<SessionHoldsOptions, "setTimer">
}

/** The project executor, as the account facade reaches it. */
export type ProjectControlExecutor = RuntimeClient & Pick<ProjectExecutionClient, "hideSession"> & Partial<Pick<ProjectExecutionClient, "onOutputGap">>

/** The account facade that every client connection of one project reaches.
 *  A connection names itself with each mutation it sends, so the facade
 *  knows which sessions each connection shows: a `session.activate` holds
 *  the session and its detail until a `session.release`, a detail snapshot
 *  holds the detail of the sessions it reads until a
 *  `session_detail.release`, and the end of the connection lets go of its
 *  detail holds at once and of its session holds after a grace, while the
 *  executor hides at once each session that no connection shows. Each
 *  release ends only its own hold, so a client that lets go of a detail it
 *  read keeps the runner of a tab it shows. A session
 *  that no connection holds has its runner ended once its turn is at rest
 *  (ARCH-RUNTIME-023), and its detail is no longer read. */
export interface ProjectControlClient extends RuntimeClient {
  /** A detail snapshot holds its sessions for `connection` until a
   *  `session_detail.release` from it or its end. */
  query<Q extends RuntimeQuery>(query: Q, connection?: SessionHolder): Promise<RuntimeQueryResult<Q>>
  dispatch<C extends FrontendMutation>(command: C, connection?: SessionHolder): Promise<MutationResult<C>>
  /** The connection ended. Its session holds wait out their grace, and its
   *  detail holds end at once. */
  disconnect(connection: SessionHolder): void
}

/** Errors the targeted metadata read states: a summary read owns the rest. */
const TARGETED_ERROR_SCOPES: ReadonlySet<SessionCatalogError["scope"]> = new Set(["metadata"])

/** Account-owned control and public sequencing. Durable mutations remain on the state port;
 * execution stays on the private executor port. Close releases only this facade's resources. */
export function createProjectControlClient(options: ProjectControlClientOptions): ProjectControlClient {
  const { state } = options
  const bus = options.bus ?? createRuntimeUiBus({ publishOnChange: true })
  const settlement = createPublicOutputSettlement(bus)
  // The sessions whose live truth the executor holds: it publishes a status
  // for each one, a held runner or a released session it still owes output
  // such as a kept command (status-projection.ts), and removes it when it
  // lets go. A session the catalog lists without a runner still reads from
  // the executor while it is held, so routing never waits on a history read.
  const executorHeld = new Set<string>()
  // A paused project holds no runner, and a new generation attaches only
  // the sessions that clients activate again.
  const toExecutor = (call: (client: ProjectControlExecutor, sessionId: string) => Promise<void>) => async (sessionId: string): Promise<void> => {
    if (closing || options.executionPaused?.()) return
    const client = await Promise.race([executor, closed.promise])
    if (client) await Promise.race([call(client, sessionId), closed.promise])
  }
  const holds = createSessionHolds({
    release: toExecutor(async (client, sessionId) => { await client.dispatch({ type: "session.release", sessionId }) }),
    hide: toExecutor((client, sessionId) => client.hideSession(sessionId)),
    own,
    ...options.sessionHolds,
  })
  const unsubscribeGeneration = options.onExecutionReset?.(() => {
    executorHeld.clear()
    details.reset()
    settlement.reset()
    bus.publish({ cursor: { scope: "workspace", domain: "runtime" }, payload: { kind: "runtime.invalidate", reason: "overflow" } })
  })
  const unsubscribeUpdates = options.updates.subscribe((update) => {
    bus.publish({ cursor: updatesCursor(), payload: { kind: "update.changed", update } })
  })
  const unsubscribeService = options.service.subscribe((service) => {
    bus.publish({ cursor: workspaceDomainCursor("service"), payload: { kind: "service.changed", service } })
  })
  const rows = new Map<string, SessionCatalogRow>()
  const listeners = new Set<(event: FrontendEvent) => void>()
  const tasks = new Set<Promise<void>>()
  const closed = Promise.withResolvers<void>()
  let closing = false
  let errors: readonly SessionCatalogError[] = []
  let unsubscribeExecutor: (() => void) | undefined
  let unsubscribeRecovery: (() => void) | undefined
  const executor = Promise.resolve(options.executor)
  // What a held chat's detail read admits. The listing cannot tell turn-end
  // evidence, such as Resume after an interrupt, and every chat a client
  // shows is held, so its catalog row carries the admission its detail read
  // found, and a root chat surface reads it from that row (C5).
  const admissions = new Map<string, SessionRow>()
  const git = createGitProjection({ projectRoot: options.directories.projectRoot, publish: bus.publish })
  const details = createSessionDetailPublisher({
    state, bus, own, closing: () => closing,
    read: (sessionId) => queryRaw({ type: "sessionDetail", sessionId }),
    // A close never waits for totals that a rebuild has not finished.
    totalsReady: (sessionId) => Promise.race([fromHistory(() => options.history.waitForTotals([sessionId])).then(() => {}), closed.promise]),
    onRead: (sessionId, row) => {
      if (row) git.holdSession(sessionId, row.executionCwd)
      else git.releaseSession(sessionId)
      admit(sessionId, row)
    },
    onReleased: (sessionId) => { admissions.delete(sessionId); git.releaseSession(sessionId) },
  })
  const summaries = createRuntimeSummaryProjection({
    context: { projectRoot: options.directories.projectRoot },
    background: {
      sessionSummaryImmediate: (sessionIds) => fromHistory(() => options.history.sessionSummaryImmediate(sessionIds)),
      waitForTotals: (sessionIds) => fromHistory(() => options.history.waitForTotals(sessionIds)),
    },
    sessionPlacements: createSessionPlacements(state),
    onStored: state.onStored,
  })

  /** A child is never a catalog row (ARCH-PROTOCOL-048): its metadata change reaches no
   *  client through the `session` domain, and a client that opens it reads
   *  `sessionDetail` through the executor. */
  function rememberMetadata(metadata: DurableSessionCatalogRow): SessionCatalogRow | undefined {
    const projected = projectSessionCatalogRow(metadata)
    if (projected.kind !== "chat") return undefined
    const prior = rows.get(metadata.id)
    const row = mergeCatalogRow(prior, projected)
    const presentation = keepPresentation(prior, row)
    const summary = summaries.view(metadata.id)
    const merged = withAdmission(prior && summary.totalsLoading ? presentation : replaceCatalogTotals(presentation, summary))
    rows.set(metadata.id, merged)
    return merged
  }

  function withAdmission(row: SessionCatalogRow): SessionCatalogRow {
    return withDetailEvidence(row, admissions.get(row.id))
  }

  /** Lays a held chat's admission over its catalog row, and publishes the
   *  row when what it admits changed. */
  function admit(sessionId: string, detail: SessionRow | null): void {
    if (detail?.kind !== "chat") {
      admissions.delete(sessionId)
      return
    }
    admissions.set(sessionId, detail)
    const prior = rows.get(sessionId)
    if (!prior) return
    const row = withAdmission(prior)
    if (JSON.stringify([row.admittedActions, row.stoppedBy]) === JSON.stringify([prior.admittedActions, prior.stoppedBy])) return
    rows.set(sessionId, row)
    bus.publish({ cursor: sessionCursor(sessionId), payload: { kind: "session.updated", row } })
  }

  function publishMetadata(metadata: DurableSessionCatalogRow): SessionCatalogRow | undefined {
    const kind = rows.has(metadata.id) ? "session.updated" : "session.added"
    const row = rememberMetadata(metadata)
    if (row) bus.publish({ cursor: sessionCursor(row.id), payload: { kind, row } })
    return row
  }

  /** Keeps over `row` the presentation that a live executor published more
   *  recently than the durable state `row` comes from. */
  function keepPresentation(prior: SessionCatalogRow | undefined, row: SessionCatalogRow): SessionCatalogRow {
    return prior ? { ...row, activity: options.executionPaused?.() ? "absent" : prior.activity, notices: prior.notices } : row
  }

  /** History has already projected workflow evidence and complete totals. */
  function rememberHistoryRow(next: SessionCatalogRow): void {
    const prior = rows.get(next.id)
    rows.set(next.id, withAdmission(keepPresentation(prior, mergeCatalogRow(prior, next))))
  }

  /** Replaces the errors that one owner states for `sessionIds` in its
   *  families, and invalidates a session whose errors changed so clients
   *  read the snapshot that carries them. */
  function replaceOwnedErrors(sessionIds: readonly string[], refreshed: readonly SessionCatalogError[], scopes: ReadonlySet<SessionCatalogError["scope"]>): void {
    const replaced = replaceOwnedCatalogErrors(errors, sessionIds, refreshed, scopes)
    if (!replaced) return
    errors = replaced.errors
    if (replaced.changedId !== undefined) bus.publish({ cursor: sessionCursor(replaced.changedId), payload: { kind: "runtime.invalidate", reason: "overflow" } })
  }

  // Subscribe before the initial history-worker read. Changes received during that
  // read run after the baseline, as in the frontend projection's pending baseline.
  let baselined = false
  const pendingMetadata = new Set<string>()
  const catalogWork = createOrderedLane()
  let queuedSync: Promise<void> | undefined
  /** Queues one step on the catalog chain, or answers the step already
   *  queued: the history baseline until one succeeds, then the metadata
   *  changes heard since. A failed baseline, such as one past its history
   *  deadline, keeps those changes queued, and the next step reads it again. */
  function syncCatalog(): Promise<void> {
    if (queuedSync) return queuedSync
    const step = catalogWork.run(async () => {
      queuedSync = undefined
      if (closing) return
      if (!baselined) {
        const catalog = await fromHistory(() => options.history.snapshot())
        if (closing) return
        errors = catalog.errors
        for (const row of catalog.rows) if (row.kind === "chat") rememberHistoryRow(row)
        baselined = true
      }
      if (pendingMetadata.size === 0) return
      const pending = [...pendingMetadata]
      pendingMetadata.clear()
      const sessions = await state.sessions.listForIds(pending)
      if (closing) return
      for (const row of sessions.sessions) publishMetadata(row)
      details.refresh(pending)
      replaceOwnedErrors(pending, sessions.errors, TARGETED_ERROR_SCOPES)
    })
    queuedSync = step
    return step
  }
  function refresh(ids: readonly string[]): void {
    for (const id of ids) pendingMetadata.add(id)
    if (!queuedSync) own(syncCatalog())
  }
  const unsubscribeState = state.sessions.subscribe((change) => {
    if (change.kind === "changed") refresh(change.sessionIds)
    else void catalogWork.run(() => {
      if (closing) return
      const listed = rows.delete(change.sessionId)
      settlement.remove(change.sessionId)
      const erred = errors.some((error) => error.sessionId === change.sessionId)
      errors = errors.filter((error) => error.sessionId !== change.sessionId)
      // A session whose record cannot be read is listed by its errors alone,
      // so it leaves through the snapshot that no longer carries them.
      if (listed || erred) bus.publish({ cursor: sessionCursor(change.sessionId), payload: listed ? { kind: "session.removed" } : { kind: "runtime.invalidate", reason: "overflow" } })
      details.remove(change.sessionId)
    }).catch(options.onError)
  })
  const unsubscribeSummaries = summaries.subscribe((sessionIds) => {
    for (const sessionId of sessionIds) {
      const prior = rows.get(sessionId)
      if (!prior) continue
      const summary = summaries.view(sessionId)
      const row = replaceCatalogTotals(prior, summary)
      rows.set(sessionId, row)
      bus.publish({ cursor: sessionCursor(sessionId), payload: { kind: "session.updated", row } })
      bus.publish({ cursor: budgetCursor(sessionId), payload: { kind: "budget.updated", budget: budgetViewFromRuntimeSummary(summary) } })
    }
    replaceOwnedErrors(sessionIds, sessionIds.flatMap((sessionId) => summaries.errors(sessionId)), SUMMARY_ERROR_SCOPES)
  })
  function mergeExecutionRow(prior: SessionCatalogRow, execution: SessionCatalogRow): SessionCatalogRow {
    // The executor's row carries the live presentation: notices, activity,
    // and the actions its runner admits; the prior row keeps the durable metadata.
    const presentation = {
      ...prior,
      notices: execution.notices,
      ...(execution.activity === undefined ? {} : { activity: execution.activity }),
      ...(execution.admittedActions === undefined ? {} : { admittedActions: execution.admittedActions }),
    }
    return withAdmission(replaceCatalogTotals(presentation, execution.totalsLoading
      ? { totalsLoading: true }
      : { totalsLoading: false, row: execution }))
  }

  // While the project is paused or a restart is scheduled, each session's
  // own input from a person waits for the generation the restart starts, in
  // the order it was sent. An interrupt of that session waits until it has
  // settled, which for an accepted input means its turn runs on that
  // generation, so the interrupt cuts it. An open tab's activation starts no
  // turn, so an interrupt never waits on it: during a planned replacement
  // it waits for a person's input or the close.
  const awaitingRestart = new Map<string, Promise<void>>()
  // A person's input makes its session live before the catalog says so. Its
  // output and image bodies exist only in the executor until that input
  // settles, so reads stay there for as long as any input is in flight.
  const sendingSessions = new Map<string, number>()
  /** Forwards a mutation to the executor. An answer that carries a catalog
   *  row is a read of that row, and the row is the executor's own, not the
   *  account's merged row. So the answer voids the row's publish-on-change
   *  baseline, and the account's next row reaches the caller even when it
   *  equals the last one published. */
  async function dispatchToExecutor<C extends FrontendMutation>(command: C): Promise<MutationResult<C>> {
    const result = await (await executor).dispatch(command)
    if (result && typeof result === "object" && "sessionCatalogRow" in result && result.sessionCatalogRow) bus.snapshotPosition({ kind: "cursor", cursor: sessionCursor(result.sessionCatalogRow.id) })
    return result
  }
  function send<C extends FrontendMutation>(command: C): Promise<MutationResult<C>> {
    const sessionId = "sessionId" in command ? command.sessionId : undefined
    const live = sessionId !== undefined && executionAskerOf(command) === "person"
    if (live) sendingSessions.set(sessionId, (sendingSessions.get(sessionId) ?? 0) + 1)
    const dispatched = dispatchToExecutor(command)
    const sent = live ? dispatched.finally(() => {
      const remaining = (sendingSessions.get(sessionId) ?? 1) - 1
      if (remaining === 0) sendingSessions.delete(sessionId)
      else sendingSessions.set(sessionId, remaining)
    }) : dispatched
    if (live && (options.executionPaused?.() || options.restartScheduled?.())) {
      const link: Promise<void> = Promise.allSettled([awaitingRestart.get(sessionId), sent]).then(() => {
        if (awaitingRestart.get(sessionId) === link) awaitingRestart.delete(sessionId)
      })
      awaitingRestart.set(sessionId, link)
    }
    return sent
  }

  function own(operation: Promise<void>): void {
    const task = operation.catch(options.onError).finally(() => tasks.delete(task))
    tasks.add(task)
  }
  own(syncCatalog())
  own(Promise.race([executor, closed.promise]).then((client) => {
    if (!client || closing) return
    // The executor never waits on this repair: output keeps arriving, and a
    // session whose chain shows a hole meanwhile is invalidated on its own.
    // Coverage resets at the one point every client is told to re-read. A
    // later gap supersedes an earlier repair still reading its snapshot, and a
    // generation change voids both.
    let latestRepair = 0
    unsubscribeRecovery = client.onOutputGap?.(async () => {
      const repair = ++latestRepair
      const generation = settlement.generation
      const snapshot = await client.query({ type: "snapshot" })
      // The gap may have swallowed status publications, so ownership is read
      // back from the status owner itself: a released session that still
      // runs a kept command has a status but an absent catalog activity.
      const statuses = await client.query({ type: "statusSnapshot", sessionIds: [...new Set([...snapshot.rows.map((row) => row.id), ...executorHeld])] })
      await catalogWork.settled()
      if (closing || repair !== latestRepair || generation !== settlement.generation) return
      options.setChatDefault(snapshot.chatDefault)
      executorHeld.clear()
      for (const { sessionId, view } of statuses.views) if (view !== null) executorHeld.add(sessionId)
      for (const execution of snapshot.rows) {
        const prior = rows.get(execution.id)
        if (!prior) continue
        rows.set(execution.id, mergeExecutionRow(prior, execution))
      }
      settlement.reset()
      bus.publish({ cursor: { scope: "workspace", domain: "runtime" }, payload: { kind: "runtime.invalidate", reason: "overflow" } })
    })
    unsubscribeExecutor = client.subscribe((event) => {
      if (closing) return
      if (event.type !== "patch") {
        for (const listener of listeners) listener(event)
        return
      }
      const { cursor, payload } = event.patch
      details.apply(event.patch)
      if (payload.kind === "chat_default.changed") options.setChatDefault(payload.chatDefault)
      if (payload.kind === "session.added" || payload.kind === "session.updated") {
        const prior = rows.get(payload.row.id)
        const merged = prior ? mergeExecutionRow(prior, payload.row) : payload.row
        rows.set(merged.id, merged)
        bus.publish({ cursor, payload: { ...payload, row: merged } })
      } else {
        const removedListedRow = payload.kind === "session.removed" && cursor.scope === "session" ? rows.delete(cursor.sessionId) : false
        if (cursor.scope === "session" && (payload.kind === "session.removed" || payload.kind === "status.removed")) {
          executorHeld.delete(cursor.sessionId)
          settlement.remove(cursor.sessionId)
        }
        if (payload.kind === "session.removed" && !removedListedRow) return
        if (cursor.scope === "session" && payload.kind === "status.updated") {
          executorHeld.add(cursor.sessionId)
          const status = settlement.status(cursor.sessionId, payload.status)
          if (status) bus.publish({ cursor, payload: { kind: "status.updated", status } })
        } else settlement.publish(event.patch)
      }
    })
  }))

  /** Attaches the session's runner in the executor. Runs in the session's
   *  lane, in order with the release of that runner. */
  async function attachRunner(sessionId: string): Promise<void> {
    const client = await Promise.race([executor, closed.promise])
    if (!client || closing) return
    const result = await Promise.race([client.dispatch({ type: "session.activate", sessionId }), closed.promise])
    if (!result) return
    if (!result.ok) throw new Error(result.error)
    // The runner is attached, so the executor holds the session from this
    // answer on, before its status publication arrives.
    executorHeld.add(sessionId)
  }

  type Activation = Extract<FrontendMutation, { type: "session.activate" }>

  /** A connection's activation of a session. The hold and the activation's
   *  place in the session's lane are both taken before the first await, so a
   *  release or a disconnect that follows reaches the executor only after
   *  this activation's durable work, a paused project's restart included,
   *  and the executor's attach of the runner. The durable work itself starts
   *  at once and answers the caller without waiting for the executor,
   *  which an earlier attach in the lane can still wait for. */
  function activate(command: Activation, connection: SessionHolder | undefined): Promise<MutationResult<Activation>> {
    if (connection !== undefined) holds.hold(connection, command.sessionId)
    details.hold(connection, [command.sessionId])
    const activation = activateDurably(command)
    own(holds.serialize(command.sessionId, async () => {
      // The caller hears a failure through its answer. A paused project's
      // activation waits on the restart, which a close never brings.
      const { attach } = await Promise.race([activation.catch(() => ({ attach: false })), closed.promise.then(() => ({ attach: false }))])
      if (attach) await attachRunner(command.sessionId)
    }))
    return activation.then(({ result }) => result)
  }

  async function activateDurably(command: Activation): Promise<{ readonly result: MutationResult<Activation>; readonly attach: boolean }> {
    const paused = options.executionPaused?.() ?? false
    if (paused) {
      const result = await send(command)
      if (!result.ok) return { result, attach: false }
    }
    const session = await state.sessions.read(command.sessionId)
    if (session?.kind !== "chat") return { result: paused ? { ok: true, sessionId: command.sessionId } : await dispatchToExecutor(command), attach: false }
    await state.sessions.updateLifecycleState(command.sessionId, "active")
    const row = await catalogRow(command.sessionId)
    if (!row) return { result: { ok: false, error: `Unable to activate ${command.sessionId}` }, attach: false }
    return { result: { ok: true, sessionId: command.sessionId, sessionCatalogRow: row }, attach: !paused }
  }

  function usesHistory(sessionId: string): boolean {
    const row = rows.get(sessionId)
    return !sendingSessions.has(sessionId) && (row === undefined || row.activity === "absent") && !executorHeld.has(sessionId)
  }

  async function fromHistory<A>(read: () => Promise<A>): Promise<A> {
    await options.awaitGenerationRecovery()
    return read()
  }

  const isSessionViews = (value: unknown): value is RuntimeSessionViewsResult<unknown> & { readonly views: readonly RuntimeSessionViewEntry<unknown>[] } =>
    typeof value === "object" && value !== null && "views" in value

  /** The targeted read, so a mutation answers with the row a listing shows:
   *  its degradation and workflow state included. */
  async function catalogRow(sessionId: string): Promise<SessionCatalogRow | undefined> {
    const catalog = await state.sessions.listForIds([sessionId])
    replaceOwnedErrors([sessionId], catalog.errors, TARGETED_ERROR_SCOPES)
    const metadata = catalog.sessions.find((session) => session.id === sessionId)
    return metadata && publishMetadata(metadata)
  }

  function query<Q extends RuntimeQuery>(request: Q, connection?: SessionHolder): Promise<RuntimeQueryResult<Q>>
  async function query(request: RuntimeQuery, connection?: SessionHolder): Promise<RuntimeQueryResult<RuntimeQuery>> {
    if (closing) throw new Error("Project control client is closed")
    if (request.type === "sessionDetailSnapshot") {
      return details.snapshot(connection, request.sessionIds, syncCatalog)
    }
    if (request.type === "sessionDetail") {
      const result = await queryRaw(request)
      // A caller's detail read can seed the session's catalog row, and the
      // answer has no position, so the read voids that row's baseline once it
      // is answered. The account's own detail reads use `queryRaw` and keep
      // the baseline, because no caller holds what they read.
      bus.snapshotPosition({ kind: "cursor", cursor: sessionCursor(request.sessionId) })
      return result
    }
    return queryRaw(request)
  }

  function queryRaw<Q extends RuntimeQuery>(request: Q): Promise<RuntimeQueryResult<Q>>
  async function queryRaw(request: RuntimeQuery): Promise<RuntimeQueryResult<RuntimeQuery>> {
    if (closing) throw new Error("Project control client is closed")
    if (request.type === "gitSnapshot") {
      return { git: git.view(), snapshotPosition: bus.snapshotPosition({ kind: "cursor", cursor: gitCursor() }) }
    }
    if (request.type === "snapshot") {
      await syncCatalog()
      // Admission reads the history, which a failed recovery refuses. It never
      // rejects: the recovery owner records that failure, the held totals
      // stay, and the next snapshot admits again.
      void summaries.admit([...rows.values()].filter((row) => row.activity === "absent").map((row) => row.id))
      const snapshotPosition = bus.snapshotPosition(runtimeReadAnchor(request.type))
      return { rows: [...rows.values()], activeRuntimeCount: [...rows.values()].filter((row) => isActiveActivity(row.activity)).length, errors, snapshotPosition, projectRoot: options.directories.projectRoot, runtimeVersion: options.runtimeVersion, runtimeBuildId: options.runtimeBuildId, chatDefault: options.chatDefault(), executor: options.executorState(), service: options.service.state() }
    }
    if (request.type === "updateSnapshot") {
      return { snapshotPosition: bus.snapshotPosition({ kind: "cursor", cursor: updatesCursor() }), update: options.updates.status() }
    }
    // Each read voids the public baselines of exactly the domains it seeds,
    // whichever owner answers it.
    const snapshotPosition = bus.snapshotPosition(runtimeReadAnchor(request))
    if (request.type === "statusSnapshot") {
      const generation = settlement.generation
      const historicalSessions = request.sessionIds.map(usesHistory)
      const historyIds = request.sessionIds.filter((_, index) => historicalSessions[index])
      const liveIds = request.sessionIds.filter((_, index) => !historicalSessions[index])
      const [historical, live] = await Promise.all([
        historyIds.length ? fromHistory(() => serveRuntimeBackgroundQuery(options.history, { ...request, sessionIds: historyIds }, snapshotPosition)) : undefined,
        liveIds.length ? executor.then((client) => client.query({ ...request, sessionIds: liveIds })) : undefined,
      ])
      if (generation !== settlement.generation) throw new ExecutorGenerationChangedError()
      const byId = new Map([
        ...(historical?.views ?? []),
        ...(live?.views.map((entry) => ({ ...entry, view: settlement.status(entry.sessionId, entry.view) })) ?? []),
      ].map((entry) => [entry.sessionId, entry]))
      return { snapshotPosition, views: request.sessionIds.flatMap((id) => {
        const entry = byId.get(id)
        return entry ? [entry] : []
      }) }
    }
    if ("sessionIds" in request) {
      // A domain read over several sessions splits by where each session's
      // truth lives: the history for a session with no runtime, the executor
      // for the rest, answered in the requested order under one anchor.
      const historicalSessions = request.sessionIds.map(usesHistory)
      const historyIds = request.sessionIds.filter((_, index) => historicalSessions[index])
      if (historyIds.length > 0) {
        const liveIds = request.sessionIds.filter((_, index) => !historicalSessions[index])
        const [historical, live] = await Promise.all([
          fromHistory(() => serveRuntimeBackgroundQuery(options.history, { ...request, sessionIds: historyIds }, snapshotPosition)),
          liveIds.length > 0 ? executor.then((client) => client.query({ ...request, sessionIds: liveIds })) : Promise.resolve(undefined),
        ])
        if (isSessionViews(historical)) {
          const byId = new Map([...historical.views, ...(isSessionViews(live) ? live.views : [])].map((entry) => [entry.sessionId, entry]))
          const views = request.sessionIds.flatMap((sessionId) => { const entry = byId.get(sessionId); return entry ? [entry] : [] })
          // SAFETY: the five session-view results share one shape and the request's discriminant selected which one; the merge keeps every entry's own view type.
          // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: the query result mapping cannot express a merge across two owners
          return { snapshotPosition, views } as RuntimeQueryResult<RuntimeQuery>
        }
      }
    }
    if ("workflowId" in request && options.executionPaused?.()) {
      const historical = await fromHistory(() => serveRuntimeBackgroundQuery(options.history, request, snapshotPosition))
      if (historical !== undefined) return historical
    }
    const sessionId = "sessionId" in request && typeof request.sessionId === "string" ? request.sessionId : undefined
    // Transcript and mutation-evidence reads never reach history: the executor answers them,
    // started for them when the project is paused (ARCH-RUNTIME-016).
    if (sessionId !== undefined && readAskerOf(request) === undefined && usesHistory(sessionId)) {
      const historical = await fromHistory(() => serveRuntimeBackgroundQuery(options.history, request, snapshotPosition))
      if (historical !== undefined) return historical
    }
    const result = options.accountModules?.owns(request)
      ? await options.accountModules.serve(request)
      : await (await executor).query(request)
    return result && typeof result === "object" && "snapshotPosition" in result ? { ...result, snapshotPosition } : result
  }

  function dispatch<C extends FrontendMutation>(command: C, connection?: SessionHolder): Promise<MutationResult<C>>
  async function dispatch(command: FrontendMutation, connection?: SessionHolder): Promise<MutationResult<FrontendMutation>> {
    if (closing) throw new Error("Project control client is closed")
    // Holds change before the first await, so a release that a connection
    // sends right after its activation always finds the hold.
    if (command.type === "session.release") {
      if (connection !== undefined) holds.release(connection, command.sessionId)
      details.release(connection, command.sessionId, "shown")
      return { ok: true }
    }
    if (command.type === "session_detail.release") {
      details.release(connection, command.sessionId, "read")
      return { ok: true }
    }
    if (command.type === "session.activate") return activate(command, connection)
    if (options.accountModules?.owns(command)) return options.accountModules.mutate(command)
    if (command.type === "settings.set_update_auto_install") return settingsWriteResult(await options.updates.setAutoInstall(command.expected, command.value))
    if (command.type === "chat.open" && command.initialMessage === undefined) {
      // This inspection precedes every await: later default changes cannot
      // change the profile chosen for this click. The chat records the profile
      // that serves it, so an environment selector's choice outlives this
      // process (PI-MODEL-033). Resolution refuses an unavailable profile.
      const { effectiveId: authProfileId } = resolveSessionAuthProfile({}, options.authProfiles.inspect())
      const sessionId = command.sessionId ?? state.sessions.allocateId()
      // A client names its chat so that it can send the open again when the
      // answer was lost with its connection. The chat is the record of the
      // open: a copy finds it and creates nothing. A copy that arrives while
      // the first open creates loses the guarded create, which writes only
      // to a session that does not exist, and then finds that chat.
      const exists = async (): Promise<boolean> => command.sessionId !== undefined && await state.sessions.read(sessionId) !== null
      if (!await exists()) await state.sessions.createChat({ id: sessionId, conversationId: state.sessions.allocateId(), name: "New Chat", executionCwd: options.executionCwd, initialState: options.executionPaused?.() ? "inactive" : "active", authProfileId }).catch(async (cause: unknown) => { if (!await exists()) throw cause })
      const row = await catalogRow(sessionId)
      if (!row) return { ok: false, error: `Session not found after creation: ${sessionId}` }
      // The client that shows the chat activates it under its own hold, so
      // the open attaches no runner that no connection would release.
      return { ok: true, sessionId, sessionCatalogRow: row }
    }
    if (command.type === "session.rename") {
      const current = await state.sessions.read(command.sessionId)
      const labels = current ? editedSessionLabels(command) : null
      if (!labels) return { ok: false, error: `Unable to rename ${command.sessionId}` }
      await state.sessions.updateLabel(command.sessionId, labels, "user")
      const row = await catalogRow(command.sessionId)
      return { ok: true, sessionId: command.sessionId, ...(row ? { sessionCatalogRow: row } : {}) }
    }
    if (options.executionPaused?.() && (command.type === "session.close" || command.type === "session.discard_transient")) {
      // Nothing is resident while execution is paused, so lifecycle is purely
      // durable metadata and never waits on an executor generation.
      if (command.type === "session.discard_transient") return { ok: true, sessionId: command.sessionId, sessionRemoved: false }
      const known = await state.sessions.read(command.sessionId) !== null
      if (!known) return { ok: true, sessionId: command.sessionId }
      await state.sessions.updateLifecycleState(command.sessionId, "inactive")
      const row = await catalogRow(command.sessionId)
      return { ok: true, sessionId: command.sessionId, ...(row ? { sessionCatalogRow: row } : {}) }
    }
    if (command.type === "chat.interrupt" || command.type === "workflow.interrupt") {
      const workId = command.type === "workflow.interrupt" ? command.workflowId : command.sessionId
      const interrupted: MutationResult<typeof command> = command.type === "workflow.interrupt" ? { kind: "interrupt", interrupted: true } : { ok: true, sessionId: command.sessionId }
      // An end of the generation cuts every turn it ran. An interrupt whose
      // call fails because its generation is ending waits for that end and
      // its recovery, and then the turn it asked to cut is cut
      // (PI-INTERACTION-042, PI-INTERACTION-043).
      const cutByEnd = async (): Promise<MutationResult<typeof command>> => {
        await options.awaitGenerationRecovery().catch(() => {})
        return interrupted
      }
      // An interrupt is idempotent, so one in flight when the channel detaches
      // is sent again and answered by the reattached executor. It stays
      // pending for as long as the executor answers heartbeats, however long
      // its turn takes to stop: ending the executor would end every other
      // session's turn to stop this one. Only an executor proven wedged is
      // ended, and its recovery records the person's interrupt.
      const cooperative = async (): Promise<MutationResult<typeof command>> => {
        for (;;) {
          try {
            return await dispatchToExecutor(command)
          } catch (error) {
            if (options.executionPaused?.()) return cutByEnd()
            if (!(error instanceof ProjectExecutionChannelDetached)) throw error
          }
        }
      }
      // The escalation is armed before the interrupt waits for the session's
      // input that waits for a restart: a generation that takes that input
      // and then stops answering never settles it, and only its end does.
      const withdraw = new AbortController()
      const escalation = options.endIfWedged({ signal: withdraw.signal, waiter: { kind: "interrupt", sessionId: workId } }).then(() => interrupted)
      try {
        const chain = awaitingRestart.get(workId)
        if (chain !== undefined && await Promise.race([chain.then(() => false), escalation.then(() => true)])) return interrupted
        // Nothing runs in a paused project, so there is nothing to interrupt.
        // While a restart is scheduled, the interrupt goes to the generation
        // it starts. With none scheduled, a session a successor owes its
        // continuation still takes the person's interrupt: the state Worker
        // records the person's turn end over the planned cut and retires the
        // session's row before the answer, so no generation resumes it.
        if (options.executionPaused?.() && !options.restartScheduled?.()) {
          await state.sessions.interruptOwed(workId)
          return interrupted
        }
        return await Promise.race([cooperative(), escalation])
      } catch (error) {
        // A refusal is the caller's answer, never a project alert.
        const reason = errorMessage(error)
        return command.type === "workflow.interrupt" ? { kind: "interrupt", interrupted: false, ...(reason ? { reason } : {}) } : { ok: false, error: reason }
      } finally { withdraw.abort() }
    }
    // A child's interrupt of a paused project with no restart scheduled
    // follows the same rule as a chat's or a workflow's: it holds, and a
    // child a successor owes its continuation takes the person's interrupt
    // through the state Worker first, so no generation resumes it.
    if (command.type === "subagent.interrupt" && options.executionPaused?.() && !options.restartScheduled?.()) {
      await state.sessions.interruptOwed(command.sessionId)
      return { ok: true }
    }
    return send(command)
  }

  return {
    query,
    dispatch,
    disconnect: (connection) => {
      holds.drop(connection)
      details.drop(connection)
    },
    subscribe(listener) {
      if (closing) throw new Error("Project control client is closed")
      const first = listeners.size === 0
      listeners.add(listener)
      bus.addListener(listener)
      if (first) options.onPublicSubscriptionChange?.(true)
      return () => {
        listeners.delete(listener)
        bus.removeListener(listener)
        if (listeners.size === 0) options.onPublicSubscriptionChange?.(false)
      }
    },
    async close() {
      if (closing) return
      closing = true
      closed.resolve()
      unsubscribeUpdates()
      unsubscribeService()
      unsubscribeState()
      details.dispose()
      git.dispose()
      holds.dispose()
      unsubscribeSummaries()
      summaries.dispose()
      unsubscribeExecutor?.()
      unsubscribeRecovery?.()
      unsubscribeGeneration?.()
      settlement.reset()
      const hadListeners = listeners.size > 0
      for (const listener of listeners) bus.removeListener(listener)
      listeners.clear()
      if (hadListeners) options.onPublicSubscriptionChange?.(false)
      // A not-yet-ready executor belongs to the account owner, not this facade.
      await Promise.all(tasks)
      await catalogWork.settled()
      if (!options.bus) await bus.clear()
    },
  }
}
