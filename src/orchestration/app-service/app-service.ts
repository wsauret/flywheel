import { dispatchAuthMutation, isAuthMutation } from "./auth-mutations.js"
import { ACCOUNT_UPDATES_ONLY, dispatchSettingsMutation, isSettingsMutation } from "./settings-mutations.js"
import { readAppVersion } from "../../infra/app-version.js"
import { runningDisplayBuildId } from "./runtime-executable.js"
import type { MutationResult, FrontendMutation, FrontendEvent, RuntimeClient, RuntimeQuery, RuntimeQueryResult, SessionCatalogRow, Unsubscribe } from "../../protocol/app-service-types.js"
import { mergeCatalogRow } from "../../protocol/client/known-totals.js"
import { commandCatalogCursor } from "../../protocol/command-catalog-protocol-types.js"
import type { CommandCatalogProjection } from "./command-catalog-projection.js"
import { authStatusCursor } from "../../protocol/auth-status-protocol-types.js"
import type { AuthStatusProjection } from "./auth-status-projection.js"
import { capabilitiesCursor } from "../../protocol/module-protocol-types.js"
import type { ModuleProjection } from "./module-projection.js"
import type { RuntimeConfigProjection } from "./runtime-config-projection.js"
import { runtimeConfigCursor } from "../../protocol/runtime-config-protocol-types.js"
import { isProtocolModuleQuery, moduleMutationRefusal } from "../../protocol/modules.js"
import type { ModuleProtocolRoutes } from "./module-protocol-host.js"
import type { SessionDetailProjection } from "./session-detail-projection.js"
import type { ProjectFilesService } from "./project-files.js"
import type { BudgetProtocolProjection } from "./budget-protocol-projection.js"
import type { RuntimeSummaryProjection } from "./runtime-summary-projection.js"
import type { QuestionProtocolProjection } from "./question-protocol-projection.js"
import type { RoleProtocolProjection } from "./role-protocol-projection.js"
import { dispatchFrontendMutation } from "./mutation-handler.js"
import type { CommandInvokeService } from "./command-invoke-service.js"
import type { FrontendProjection, SessionChange } from "./frontend-projection.js"
import type { OutputProjection } from "./output-projection.js"
import type { StatusProjection } from "./status-projection.js"
import { outputCursor } from "../../protocol/output-protocol-types.js"
import type { RuntimeUiBus } from "./runtime-ui-bus.js"
import { runtimeReadAnchor } from "./runtime-ui-patch-sequencer.js"
import { sessionCursor, type RuntimeSessionViewsResult, type RuntimeUiPatch, type RuntimeUiPatchInput } from "../../protocol/runtime-ui-protocol-types.js"
import type { RuntimeSupervisor } from "./runtime-supervisor-types.js"
import type { AdmittedModelAssignmentService } from "./model-assignment-admission.js"
import type { AuthLoginService } from "./auth-login-service.js"
import type { RuntimeAuthProfileSelectionService } from "./auth-profile-selection-service.js"
import { startupTrace } from "../../infra/startup-trace.js"
import type { RuntimeBackgroundLane } from "./runtime-background-lane.js"
import { Log } from "../../infra/log.js"
import { ADMISSION_CLOSED_ERROR, createMutationAdmission, type CommandAdmission } from "./mutation-admission.js"
import { withLoggedFlywheelAppService } from "./app-service-logging.js"
import { shutdownOwner, type RuntimeShutdownRequest } from "./runtime-shutdown.js"
import type { RuntimeModelCatalogRefreshScope, ProviderModelTarget, ProviderModelView, RuntimeDeselectAllProviderModelsMutation, RuntimeProviderModelHiddenResult, RuntimeRecheckProviderModelsMutation, RuntimeSetProviderAutoEnableNewModelsMutation, RuntimeSetProviderAutoEnableNewModelsResult, RuntimeSetProviderFreeRoutesMutation, RuntimeSetProviderModelMutation, RuntimeSetProviderModelResult } from "../../protocol/provider-model-preference-protocol-types.js"

import type { SubscriptionSpendConsentMutation, SubscriptionSpendConsentMutationResult } from "../../protocol/subscription-spend-consent-protocol-types.js"
import { gitAiAttributionCursor } from "../../protocol/git-ai-attribution-protocol-types.js"
import type { GitAiAttributionProjection } from "./git-ai-attribution-projection.js"
import { commandUsageCursor } from "../../protocol/command-usage-protocol-types.js"
import type { CommandUsageProjection } from "./command-usage-projection.js"
import { changesCursor } from "../../protocol/session-changes-protocol-types.js"
import { backgroundCursor } from "../../protocol/background-index-protocol-types.js"
import type { BackgroundIndex } from "./background-index.js"
import type { MutationEvidenceService } from "./mutation-evidence-service.js"
import type { SessionChangesService } from "./session-changes-service.js"
import type { AsyncEventStateReadSurface } from "../../infra/event-store-types.js"

/** Why an executor refuses a held detail read or its release: only the
 *  account facade holds and publishes `session_detail` (C5). */
const ACCOUNT_SESSION_DETAIL_ONLY = "Session detail is held through the account service, never through a project executor"
/** A connection states the output it watches to the account service, which
 *  sends the executor the union of every connection's set on its private
 *  channel (`watchOutput`). */
const ACCOUNT_OUTPUT_WATCH_ONLY = "Output watches are stated through the account service, never to a project executor"

const log = Log.create({ service: "app-service" })

export interface ProviderModelPreferenceService {
  query(profileId: string, target: ProviderModelTarget): Promise<ProviderModelView>
  set(mutation: RuntimeSetProviderModelMutation): Promise<RuntimeSetProviderModelResult>
  deselectAll(mutation: RuntimeDeselectAllProviderModelsMutation): Promise<ProviderModelView | RuntimeProviderModelHiddenResult>
  recheck(mutation: RuntimeRecheckProviderModelsMutation): Promise<ProviderModelView | RuntimeProviderModelHiddenResult>
  setAutoEnableNewModels(mutation: RuntimeSetProviderAutoEnableNewModelsMutation): Promise<RuntimeSetProviderAutoEnableNewModelsResult>
  setFreeRoutes(mutation: RuntimeSetProviderFreeRoutesMutation): Promise<ProviderModelView | RuntimeProviderModelHiddenResult>
}
/** The server-side face of the runtime protocol: the client contract plus the
 *  two obligations only the hosting runtime holds. Clients compile against
 *  `RuntimeClient` in the protocol package; this extension never crosses the
 *  wire. */
export interface FlywheelAppService extends RuntimeClient {
  /** The single ordered-patch publish path: the cursor mints `position`/
   *  `prevPosition` and the patch fans out to every subscriber, so no publisher
   *  invents local ordering or its own delivery channel. */
  publish(input: RuntimeUiPatchInput): RuntimeUiPatch
  /** This service's own contribution to the single runtime shutdown barrier: the
   *  admission it closes and the resource owners it contributes per phase. A host
   *  that owns more of the same phase extends these owner arrays rather than
   *  running a second barrier. TUI cache cleanup must use unsubscribe/close. */
  readonly shutdown: RuntimeShutdownRequest
  /** The admission gate's occupancy, which the replacement blocker report
   *  reads: an admitted call that has not returned is a `call` blocker. */
  readonly admission: Pick<CommandAdmission, "inFlight" | "onOccupancyChange">
  /** Whether this executor's session store holds the session, so its runner
   *  is resident here. The replacement blocker report reads it to find the
   *  chats this executor owns. It reads the store only and admits no summary,
   *  so it never starts the background Worker. */
  hasLiveSession(sessionId: string): boolean
  /** The account's union of the sessions whose live output some client
   *  watches, stated whole on the private execution channel. Until the first
   *  statement every session's output ships; from then on only the stated
   *  sessions' does (`OutputProjection.watch`). */
  watchOutput(sessionIds: readonly string[]): void
  /** No client of the account shows the session while its hold waits for a
   *  reattach, stated on the private execution channel
   *  (`RuntimeSupervisor.hideSession`). */
  hideSession(sessionId: string): Promise<void>
}

export interface FlywheelAppServiceDeps {
  readonly projectionReader: AsyncEventStateReadSurface
  /** The account-held public projection's resolved assignment. Snapshot reads
   * use this explicit input and never query the executor during render. */
  readonly chatDefault: () => import("../../protocol/app-service-types.js").RuntimeChatDefault
  readonly sessionChanges: () => Promise<SessionChangesService>
  readonly mutationEvidence: () => Promise<MutationEvidenceService>
  /** The background index of each chat, read only while a client shows it. */
  readonly backgroundIndex: BackgroundIndex
  readonly projection: FrontendProjection
  /** The project directory this runtime opened, published as workspace state so
   *  a client shows project identity without resolving a directory itself. */
  readonly projectRoot: string
  /** The single output publish path: observes SessionStore output mutations and
   *  mints `output.delta` through the same bus. Owned here so the app-service
   *  disposes it with the rest of the runtime. */
  readonly outputProjection: OutputProjection
  readonly statusProjection: StatusProjection
  readonly budgetProjection: BudgetProtocolProjection
  readonly summaries: RuntimeSummaryProjection
  /** The protocol runtimes of every installed module, routed by read and
   *  mutation discriminant; the app service names no module domain. */
  readonly moduleProtocol: ModuleProtocolRoutes
  readonly questionProjection: QuestionProtocolProjection
  readonly roleProjection: RoleProtocolProjection
  readonly authStatusProjection: AuthStatusProjection
  /** The inline-command roster and the runtime's one skill watcher. It owns
   *  definition resolution, so no client ever renders a package body. */
  readonly commandCatalog: CommandCatalogProjection
  readonly historyProjection: SessionDetailProjection
  /** The project's files for a person to mention; absent in a composition
   *  without a project tree (a test double), which answers none. */
  readonly projectFiles?: ProjectFilesService
  readonly modelAssignments?: AdmittedModelAssignmentService
  readonly providerModels?: ProviderModelPreferenceService
  /** Read-only optimization for durable queries. This lane returns unpositioned
   * domain data; the app-service bus remains the publication authority. */
  readonly backgroundLane: RuntimeBackgroundLane

  readonly authProfileSelection?: Pick<RuntimeAuthProfileSelectionService, "mutate" | "refresh" | "previewDelete"> & { settle(profileId: string, operationId: string): Promise<void> }
  /** Present when this host can connect providers without a terminal. */
  readonly authLogin?: AuthLoginService
  readonly scheduleCatalogRefresh?: (scope: RuntimeModelCatalogRefreshScope) => Promise<void>
  readonly subscriptionSpendConsent?: { mutate(mutation: SubscriptionSpendConsentMutation): Promise<SubscriptionSpendConsentMutationResult> }
  /** The runtime's one capability publication and mutation owner. Required: the
   *  client holds no selection of its own, so a runtime without this projection
   *  could not answer a Settings row. */
  readonly capabilities: ModuleProjection
  readonly config: RuntimeConfigProjection
  readonly gitAiAttribution: GitAiAttributionProjection
  /** Account-global slash-command use counts, the ranking every client shares. */
  readonly commandUsage: CommandUsageProjection
  /** Executes built-in commands in this composition, the one that published their descriptors. */
  readonly commandInvoke: CommandInvokeService
  readonly runtimeSupervisor: RuntimeSupervisor
  /** Optional tool preparation, shared with initial background warming and
   * joined by the mutation shutdown barrier. */
  readonly warmTools?: () => Promise<void>
  /** Optional machine-owned reference files, published by the initial warm
   * after runtime readiness and joined by the mutation shutdown barrier. */
  readonly publishReferences?: () => Promise<void>
  /** The hoisted patch transport. The session store and runtime supervisor
   *  publish output through the same bus, so the app-service closes over it for
   *  snapshot/subscribe/publish rather than minting a second sequencer. */
  readonly bus: RuntimeUiBus<RuntimeUiPatch>
}

export function createFlywheelAppService(deps: FlywheelAppServiceDeps): FlywheelAppService {
  const { bus, statusProjection, budgetProjection, questionProjection, authStatusProjection, historyProjection } = deps
  let projectionUnsubscribe: Unsubscribe | null = null
  let backgroundWarm: Promise<void> | undefined
  const admission = createMutationAdmission()




  /** Runtime-lifetime derived catalog rows. A cold summary snapshot contributes
   * metadata immediately and exact totals only when its derived index is ready. */
  const catalogRows = new Map<string, SessionCatalogRow>()
  const remember = (row: SessionCatalogRow): void => { catalogRows.set(row.id, mergeCatalogRow(catalogRows.get(row.id), row)) }

  function ensureCatalogSubscription(): void {
    projectionUnsubscribe ??= deps.projection.subscribe(broadcastChanges)
  }

  function broadcastChanges(changes: readonly SessionChange[]): void {
    for (const change of changes) {
      if (change.kind === "removed") catalogRows.delete(change.sessionId)
      else remember(change.row)
      bus.publish(changeToPatch(change))
    }
  }

  async function publishSessionCatalogRow(sessionId: string, kind: "session.added" | "session.updated"): Promise<(MutationResult & { ok: true; sessionId: string }) | undefined> {
    const row = await deps.projection.liveCatalogRow(sessionId) ?? await deps.projection.catalogRow(sessionId)
    if (!row) return
    bus.publish({ cursor: sessionCursor(sessionId), payload: { kind, row } })
    return { ok: true, sessionId, sessionCatalogRow: row }
  }

  /** One read of a session-scoped domain for several sessions. The anchor is
   *  taken before the views, so a patch published while a view is read carries
   *  a position past the anchor and the client applies it over that view. */
  async function sessionViews<View>(
    sessionIds: readonly string[],
    domain: "status" | "budget" | "question" | "roles",
    read: (sessionId: string) => Promise<View | null> | View | null,
  ): Promise<RuntimeSessionViewsResult<View>> {
    const snapshotPosition = bus.snapshotPosition({ kind: "workspace", domains: [domain] })
    const views = await Promise.all(sessionIds.map(async (sessionId) => ({ sessionId, view: await read(sessionId) })))
    return { snapshotPosition, views }
  }

  function query<Q extends RuntimeQuery>(request: Q): Promise<RuntimeQueryResult<Q>>
  async function query(request: RuntimeQuery): Promise<RuntimeQueryResult<RuntimeQuery>> {
    if (isProtocolModuleQuery(request)) return deps.moduleProtocol.serve(request)
    switch (request.type) {
      case "sessionChanges": return (await deps.sessionChanges()).list(request)
      case "sessionChangeSummary": {
        const snapshotPosition = bus.snapshotPosition({ kind: "cursor", cursor: changesCursor(request.sessionId) })
        const summary = await deps.backgroundLane.sessionChangeSummary(request.sessionId)
        return { ...summary, snapshotPosition }
      }
      case "sessionChangeDiff": return (await deps.sessionChanges()).diff(request)
      case "mutationFiles": return (await deps.mutationEvidence()).files(request)
      case "mutationPatchWindow": return (await deps.mutationEvidence()).patchWindow(request)
      case "sessionBackgroundWork": {
        const snapshotPosition = bus.snapshotPosition({ kind: "cursor", cursor: backgroundCursor(request.sessionId) })
        return { snapshotPosition, rows: await deps.backgroundIndex.rows(request.sessionId) }
      }
      case "snapshot": {
        const snapshotPosition = bus.snapshotPosition(runtimeReadAnchor(request.type))
        const local = await deps.projection.snapshot()
        return { ...local, rows: local.rows.map((row) => mergeCatalogRow(catalogRows.get(row.id), row)), snapshotPosition, projectRoot: deps.projectRoot, runtimeVersion: await runtimeVersion, runtimeBuildId: runningDisplayBuildId(), chatDefault: deps.chatDefault(),
          // A runtime that answers this read is the process serving the
          // sessions; only the account that owns its generations, and serves
          // this process, states more.
          executor: { kind: "serving" }, service: { kind: "serving" } }
      }
      case "outputWindow": return { snapshotPosition: bus.snapshotPosition({ kind: "cursor", cursor: outputCursor(request.sessionId) }), ...await historyProjection.outputWindow(request.sessionId, request.request.range) }
      case "outputRange": return historyProjection.outputRange(request.sessionId, request.request)
      case "transcriptSearch": return deps.backgroundLane.transcriptSearch(request.request)
      case "projectFiles": return deps.projectFiles?.search(request.request) ?? { entries: [], total: 0 }
      case "outputGroupChildren": return historyProjection.outputGroupChildren(request.sessionId, request.request)
      case "outputBlockBody": return historyProjection.outputBlockBody(request.sessionId, request.request)
      case "statusSnapshot": return sessionViews(request.sessionIds, "status", (sessionId) => statusProjection.snapshot(sessionId))
      // The account publisher alone holds detail: it knows which client holds
      // which session and publishes each change once for all of them.
      case "sessionDetailSnapshot": throw new Error(ACCOUNT_SESSION_DETAIL_ONLY)
      case "budgetSnapshot": return sessionViews(request.sessionIds, "budget", async (sessionId) => {
        const live = await budgetProjection.snapshot(sessionId)
        if (live) return live
        const budget = (await historyProjection.sessionDetail(sessionId)).view?.budget
        return budget ?? null
      })
      case "questionSnapshot": return sessionViews(request.sessionIds, "question", (sessionId) => questionProjection.snapshot(sessionId))
      case "roleSnapshot": return sessionViews(request.sessionIds, "roles", (sessionId) => deps.roleProjection.snapshot(sessionId))
      case "authStatusSnapshot": {
        const snapshotPosition = bus.snapshotPosition({ kind: "cursor", cursor: authStatusCursor(request.scope) })
        return { auth: await authStatusProjection.snapshot(request.scope), snapshotPosition }
      }
      case "authProfileDeletionPreview": {
        if (!deps.authProfileSelection) throw new Error("Auth profile selection is unavailable")
        return deps.authProfileSelection.previewDelete(request.id)
      }
      // Updates are account-wide work, so the account service answers them and
      // never forwards them to a project executor (ARCH-PROTOCOL-043).
      case "updateSnapshot": throw new Error(ACCOUNT_UPDATES_ONLY)
      case "moduleSnapshot": return { capabilities: deps.capabilities.view(), snapshotPosition: bus.snapshotPosition({ kind: "cursor", cursor: capabilitiesCursor() }) }
      case "configSnapshot": return { config: deps.config.view(), snapshotPosition: bus.snapshotPosition({ kind: "cursor", cursor: runtimeConfigCursor() }) }
      case "gitAiAttributionSnapshot": return { status: deps.gitAiAttribution.view(), snapshotPosition: bus.snapshotPosition({ kind: "cursor", cursor: gitAiAttributionCursor() }) }
      case "gitSnapshot": throw new Error("Git directories are held through the account service, never through a project executor")
      case "commandUsageSnapshot": return { usage: deps.commandUsage.view(), snapshotPosition: bus.snapshotPosition({ kind: "cursor", cursor: commandUsageCursor() }) }
      case "sessionDetail": {
        const localResult = await historyProjection.sessionDetail(request.sessionId)
        if (localResult.view !== null) {
          const status = await statusProjection.snapshot(request.sessionId)
          if (status !== null) return { view: { ...localResult.view, status } }
        }
        return localResult.view || await deps.projection.liveCatalogRow(request.sessionId) ? localResult : deps.backgroundLane ? deps.backgroundLane.sessionDetail(request) : localResult
      }
      case "recallQueuedMessage": return deps.runtimeSupervisor.recallQueuedMessage(request.sessionId)
      case "commandCatalog": return { ...deps.commandCatalog.snapshot(), snapshotPosition: bus.snapshotPosition({ kind: "cursor", cursor: commandCatalogCursor() }) }
      case "modelAssignments": return requireModelAssignments(deps).loadAssignments(request)
      case "sessionModelPlan": return requireModelAssignments(deps).loadSessionModelPlan(request)
      case "modelOptions": return requireModelAssignments(deps).listModelOptions(request)
      case "effortOptions": return requireModelAssignments(deps).listEffortOptions(request)
      case "modelRoles": return requireModelAssignments(deps).modelRoles()
      case "provider_models.query": return requireProviderModels(deps).query(request.profileId, request.target)
    }
  }

  function dispatch<C extends FrontendMutation>(mutation: C): Promise<MutationResult<C>>
  async function dispatch(mutation: FrontendMutation): Promise<MutationResult<FrontendMutation>> {
    if (mutation.type === "session.claim_composer_returns") return admission.admit(() => deps.runtimeSupervisor.claimComposerReturns(mutation.sessionId, mutation.submissionIds)) ?? { ok: false, error: ADMISSION_CLOSED_ERROR }
    if (mutation.type === "background.warm") {
      backgroundWarm ??= admission.admit(async () => {
        ensureCatalogSubscription()
        deps.backgroundLane.start()
        const results = await Promise.allSettled([deps.runtimeSupervisor.warmChatRunner(), deps.warmTools?.()])
        const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
        if (failures.length === 1) throw failures[0]
        if (failures.length > 1) throw new AggregateError(failures, "Runtime warm failed")
        await deps.publishReferences?.()
      })?.catch((error: unknown) => {
        backgroundWarm = undefined
        throw error
      })
      return backgroundWarm
    }
    if (mutation.type === "subscription_spend_consent.save") {
      return admission.admit(async () => {
        if (!deps.subscriptionSpendConsent) return { kind: "storage-failure" }
        return deps.subscriptionSpendConsent.mutate(mutation)
      }) ?? { kind: "contention" }
    }
    if (mutation.type === "command_usage.record") return admission.admit(async () => (deps.commandUsage.record(mutation.name) ? { ok: true } : { ok: false, error: `"/${mutation.name}" is not a slash command` })) ?? { ok: false, error: ADMISSION_CLOSED_ERROR }
    if (mutation.type === "model.save_effort") return admission.admit(() => requireModelAssignments(deps).saveEffort(mutation)) ?? Promise.reject(new Error(ADMISSION_CLOSED_ERROR))
    if (mutation.type === "model.reset_assignments") return admission.admit(() => requireModelAssignments(deps).resetDefaults(mutation)) ?? Promise.reject(new Error(ADMISSION_CLOSED_ERROR))
    if (mutation.type === "provider_model.set") return admission.admit(() => requireProviderModels(deps).set(mutation)) ?? Promise.reject(new Error(ADMISSION_CLOSED_ERROR))
    if (mutation.type === "provider_models.deselect_all") return admission.admit(() => requireProviderModels(deps).deselectAll(mutation)) ?? Promise.reject(new Error(ADMISSION_CLOSED_ERROR))
    if (mutation.type === "provider_models.recheck") return admission.admit(() => requireProviderModels(deps).recheck(mutation)) ?? Promise.reject(new Error(ADMISSION_CLOSED_ERROR))
    if (mutation.type === "provider_models.set_auto_enable") return admission.admit(() => requireProviderModels(deps).setAutoEnableNewModels(mutation)) ?? Promise.reject(new Error(ADMISSION_CLOSED_ERROR))
    if (mutation.type === "provider_free_routes.set") return admission.admit(() => requireProviderModels(deps).setFreeRoutes(mutation)) ?? Promise.reject(new Error(ADMISSION_CLOSED_ERROR))
    if (mutation.type === "session.changes.set_viewed") return admission.admit(async () => (await deps.sessionChanges()).setViewed(mutation)) ?? { status: "refused", message: "Runtime is closing" }
    if (mutation.type === "session.changes.undo") return admission.admit(() => dispatchMutation(mutation)) ?? { status: "refused", message: "Runtime is closing" }
    return admission.admit(() => dispatchMutation(mutation)) ?? moduleMutationRefusal(mutation, ADMISSION_CLOSED_ERROR) ?? { ok: false, error: ADMISSION_CLOSED_ERROR }
  }

  const service: FlywheelAppService = {
    query,
    dispatch,
    publish: bus.publish,
    subscribe(listener: (event: FrontendEvent) => void): Unsubscribe {
      // A closed admission acquires no projection subscription: this client
      // is leaving, not attaching.
      if (admission.closed) return () => {}
      startupTrace("app-service subscribe start")
      bus.addListener(listener)
      // The underlying subscription is acquired before this returns, so a
      // patch published the instant the subscriber is registered cannot fall
      // into a lazy-subscribe race.
      ensureCatalogSubscription()
      startupTrace("app-service subscribe connected")
      return () => {
        bus.removeListener(listener)
      }
    },
    async close(): Promise<void> {},
    admission,
    hasLiveSession: deps.projection.hasLiveSession,
    watchOutput: deps.outputProjection.watch,
    hideSession: async (sessionId) => { await admission.admit(() => deps.runtimeSupervisor.hideSession(sessionId)) },
    shutdown: {
      closeAdmission: () => {
        admission.close()
        projectionUnsubscribe?.()
        projectionUnsubscribe = null
      },
      owners: {
        "stop-runners": [
          shutdownOwner("mutation-admission", () => admission.settled()),
          shutdownOwner("session-runners", () => deps.runtimeSupervisor.disposeAll()),
        ],
        "flush-durable-state": [shutdownOwner("history-projection", () => historyProjection.dispose())],
        "drain-clients": [shutdownOwner("runtime-ui-bus", () => bus.drain())],
        "close-client-streams": [shutdownOwner("frontend-projection", async () => {
          deps.outputProjection.dispose()
          statusProjection.dispose()
          budgetProjection.dispose()
          deps.summaries?.dispose()
          questionProjection.dispose()
          await deps.roleProjection.dispose()
          deps.moduleProtocol.dispose()
          deps.gitAiAttribution.dispose()
          deps.commandUsage.dispose()
          await deps.commandCatalog.dispose()
          await bus.clear()
          deps.projection.dispose()
        })],
      },
    },
  }

  return withLoggedFlywheelAppService(service, log)

  async function dispatchMutation(mutation: FrontendMutation): Promise<MutationResult<FrontendMutation>> {
    if (mutation.type === "session.claim_composer_returns") return deps.runtimeSupervisor.claimComposerReturns(mutation.sessionId, mutation.submissionIds)
    startupTrace(`app-service dispatch ${mutation.type} start`)
    if (isAuthMutation(mutation)) return dispatchAuthMutation(deps, mutation)
    if (isSettingsMutation(mutation)) return dispatchSettingsMutation(deps, mutation)
    if (mutation.type === "session_detail.release") throw new Error(ACCOUNT_SESSION_DETAIL_ONLY)
    if (mutation.type === "output.watch") throw new Error(ACCOUNT_OUTPUT_WATCH_ONLY)
    if (mutation.type === "command_usage.record" || mutation.type === "model.save_effort" || mutation.type === "model.reset_assignments" || mutation.type === "provider_model.set" || mutation.type === "provider_models.deselect_all" || mutation.type === "provider_models.recheck" || mutation.type === "provider_models.set_auto_enable" || mutation.type === "provider_free_routes.set" || mutation.type === "background.warm" || mutation.type.startsWith("auth.profile.") || mutation.type === "subscription_spend_consent.save" || mutation.type === "session.changes.set_viewed") {
      throw new Error(`Mutation ${mutation.type} reached the basic mutation dispatcher`)
    }
    const targetSessionId = mutationSessionId(mutation)
    const wasKnown = targetSessionId ? await deps.projection.liveCatalogRow(targetSessionId) !== null || await deps.projection.catalogRow(targetSessionId) !== null : false
    const result = await dispatchFrontendMutation(mutation, { chat: { supervisor: deps.runtimeSupervisor }, send: { supervisor: deps.runtimeSupervisor, modules: deps.moduleProtocol }, commands: deps.commandInvoke, modules: deps.moduleProtocol })
    startupTrace(`app-service dispatch ${mutation.type} done`)
    // A command that created a session answers only its id; the row it needs
    // is published here, as a fork's is, so the client can foreground it at once.
    if ("kind" in result && result.kind === "focus-session") await publishSessionCatalogRow(result.sessionId, "session.added")
    if ("ok" in result && result.ok && "sessionId" in result && result.sessionId) {
      const published = await publishSessionMutationResult(mutation, result.sessionId, wasKnown)
      startupTrace(`app-service dispatch ${mutation.type} done`)
      return published ?? result
    }
    startupTrace(`app-service dispatch ${mutation.type} done`)
    return result
  }

  async function publishSessionMutationResult(
    mutation: FrontendMutation,
    sessionId: string,
    wasKnown: boolean,
  ): Promise<(MutationResult & { ok: true; sessionId: string }) | undefined> {
    if (mutationDeletesSession(mutation)) {
      // No publish here: manager.delete fires the projection's change signal,
      // and the projection diff is the single removal authority. It also covers
      // deletions that never pass through dispatch (stale-chat recovery,
      // corrupt-metadata cleansing).
      return undefined
    }
    if (mutation.type === "session.discard_transient") return undefined

    const published = await publishSessionCatalogRow(sessionId, mutation.type === "session.fork" ? "session.added" : wasKnown ? "session.updated" : "session.added")
    if (published) return published

    return undefined
  }
}

function requireModelAssignments(deps: FlywheelAppServiceDeps): AdmittedModelAssignmentService {
  if (!deps.modelAssignments) throw new Error("Model assignment service is unavailable")
  return deps.modelAssignments
}

function requireProviderModels(deps: FlywheelAppServiceDeps): ProviderModelPreferenceService {
  if (!deps.providerModels) throw new Error("Provider-model preference service is unavailable")
  return deps.providerModels
}


/** A capability mutation's outcome as the client reports it. A durability
 *  failure committed, so the change IS in effect and the runtime already
 *  republished it; the client is told the one thing it could not otherwise know,
 *  that the change may not survive a crash. */
/** Read once per process: the version cannot change while the runtime runs. */
const runtimeVersion = readAppVersion()


function mutationSessionId(mutation: FrontendMutation): string | undefined {
  return "sessionId" in mutation ? mutation.sessionId : undefined
}

function mutationDeletesSession(mutation: FrontendMutation): boolean {
  return mutation.type === "session.delete"
}

function changeToPatch(change: SessionChange): RuntimeUiPatchInput {
  if (change.kind === "removed") {
    return { cursor: sessionCursor(change.sessionId), payload: { kind: "session.removed" } }
  }
  return {
    cursor: sessionCursor(change.row.id),
    payload: { kind: change.kind === "added" ? "session.added" : "session.updated", row: change.row },
  }
}
