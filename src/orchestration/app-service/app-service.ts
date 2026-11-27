import { dispatchAuthMutation, isAuthMutation, type AuthMutationDeps } from "./auth/login/auth-mutations.js"
import { ACCOUNT_UPDATES_ONLY, dispatchSettingsMutation, isSettingsMutation, type SettingsMutationDeps } from "./mutations/settings-mutations.js"
import type { RuntimeAuthProfileSelectionService } from "./auth/auth-profile-selection-service.js"
import type { ModuleProjection } from "./projections/module-projection.js"
import type { RuntimeConfigProjection } from "./projections/runtime-config-projection.js"
import type { ProviderModelPreferenceService } from "./auth/models/provider-model-preference-service.js"
import { readAppVersion } from "../../infra/update/distribution/app-version.js"
import { runningDisplayBuildId } from "../../infra/update/distribution/running-build.js"
import { isUnreadChatsMutation } from "../../protocol/session/unread-protocol-types.js"
import type { MutationResult, FrontendMutation, FrontendEvent, RuntimeClient, RuntimeQuery, RuntimeQueryOptions, RuntimeQueryResult, SessionCatalogRow, Unsubscribe } from "../../protocol/runtime/app-service-types.js"
import { mergeCatalogRow } from "../../protocol/client/session/known-totals.js"
import { commandCatalogCursor } from "../../protocol/commands/command-catalog-protocol-types.js"
import type { CommandCatalogProjection } from "./definitions/commands/command-catalog-projection.js"
import { authStatusCursor } from "../../protocol/auth/auth-status-protocol-types.js"
import type { AuthStatusProjection } from "./auth/auth-status-projection.js"
import { capabilitiesCursor } from "../../protocol/runtime/module-protocol-types.js"
import { runtimeConfigCursor } from "../../protocol/settings/runtime-config-protocol-types.js"
import { isProtocolModuleQuery, moduleMutationRefusal } from "../../protocol/modules.js"
import type { ModuleProtocolRoutes } from "./module-protocol-host.js"
import type { SessionDetailProjection } from "./projections/session-detail-projection.js"
import type { ProjectFilesService } from "./projections/project-files.js"
import type { BudgetProtocolProjection } from "./projections/catalog/budget-protocol-projection.js"
import type { RuntimeSummaryProjection } from "./projections/catalog/runtime-summary-projection.js"
import type { QuestionProtocolProjection } from "./projections/catalog/question-protocol-projection.js"
import type { RoleProtocolProjection } from "./auth/models/role-protocol-projection.js"
import { dispatchFrontendMutation } from "./mutations/mutation-handler.js"
import type { CommandInvokeService } from "./definitions/commands/command-invoke-service.js"
import type { FrontendProjection, SessionChange } from "./projections/frontend-projection.js"
import type { OutputProjection } from "./projections/output/output-projection.js"
import type { StatusProjection } from "./projections/catalog/status-projection.js"
import { outputCursor } from "../../protocol/transcript/output-protocol-types.js"
import type { RuntimeUiBus } from "./projections/runtime-ui-bus.js"
import { runtimeReadAnchor } from "./projections/runtime-ui-patch-sequencer.js"
import { sessionCursor, type RuntimeSessionViewsResult, type RuntimeUiPatch, type RuntimeUiPatchInput } from "../../protocol/runtime/runtime-ui-protocol-types.js"
import type { RuntimeSupervisor } from "./supervisor/runtime-supervisor-types.js"
import type { AdmittedModelAssignmentService } from "./auth/models/model-assignment-admission.js"
import { startupTrace } from "../../infra/diagnostics/startup-trace.js"
import type { RuntimeBackgroundLane } from "./background/runtime-background-lane.js"
import { Log } from "../../infra/diagnostics/log.js"
import { createMutationAdmission, type CommandAdmission } from "./mutations/mutation-admission.js"
import { ADMISSION_CLOSED_ERROR } from "../../infra/process/shutdown-signals.js"
import { withLoggedAppServiceClient } from "./runtime/app-service-logging.js"
import { shutdownOwner, type RuntimeShutdownRequest } from "./runtime/runtime-shutdown.js"

import type { SubscriptionSpendConsentMutation, SubscriptionSpendConsentMutationResult } from "../../protocol/auth/subscription-spend-consent-protocol-types.js"
import { gitAiAttributionCursor } from "../../protocol/git/git-ai-attribution-protocol-types.js"
import type { GitAiAttributionProjection } from "./projections/changes/git-ai-attribution-projection.js"
import { commandUsageCursor } from "../../protocol/commands/command-usage-protocol-types.js"
import type { CommandUsageProjection } from "./definitions/commands/command-usage-projection.js"
import { changesCursor } from "../../protocol/session/session-changes-protocol-types.js"
import type { BackgroundIndexOwner } from "./background/background-index-publisher.js"
import type { MutationEvidenceService } from "./projections/changes/mutation-evidence-service.js"
import type { SessionChangesService } from "./projections/changes/session-changes-service.js"
import type { AsyncEventStateReadSurface } from "../../infra/substrate/store/event-store-types.js"

/** Why an executor refuses a held detail read or its release: only the
 *  account facade holds and publishes `session_detail` (C5). */
const ACCOUNT_SESSION_DETAIL_ONLY = "Session detail is held through the account service, never through a project executor"
/** A connection states the output it watches to the account service, which
 *  sends the executor the union of every connection's set on its private
 *  channel (`watchOutput`). */
const ACCOUNT_OUTPUT_WATCH_ONLY = "Output watches are stated through the account service, never to a project executor"
/** A restart moves the account service, so only that service answers it. */
const ACCOUNT_RESTART_ONLY = "A restart is answered by the account service, never by a project executor"
const ACCOUNT_UNREAD_ONLY = "Read state is held through the account service, never through a project executor"

const log = Log.create({ service: "app-service" })

/** Mutations that `dispatch` admits and answers itself, each with its own
 *  answer once admission closed. None of them reaches `dispatchMutation`. */
type AdmittedMutationType =
  | "background.warm" | "subscription_spend_consent.save" | "command_usage.record" | "model.save_effort" | "model.reset_assignments"
  | "provider_model.set" | "provider_models.deselect_all" | "provider_models.recheck" | "provider_models.set_auto_enable" | "provider_free_routes.set"
  | "session.changes.set_viewed" | "session.claim_composer_returns"
type AdmittedMutations = { readonly [Type in AdmittedMutationType]: Extract<FrontendMutation, { readonly type: Type }> }
type AdmittedMutationHandlers = {
  readonly [Type in AdmittedMutationType]: (mutation: AdmittedMutations[Type]) => Promise<MutationResult<FrontendMutation>> | MutationResult<FrontendMutation>
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

export interface FlywheelAppServiceDeps extends AuthMutationDeps, SettingsMutationDeps {
  /** The auth mutations' port, with the reads this service answers itself. */
  readonly authProfileSelection: AuthMutationDeps["authProfileSelection"] & Pick<RuntimeAuthProfileSelectionService, "refresh" | "previewDelete">
  /** The settings mutations' ports, with the views this service snapshots. */
  readonly capabilities: ModuleProjection
  readonly config: RuntimeConfigProjection
  readonly projectionReader: AsyncEventStateReadSurface
  /** The account-held public projection's resolved assignment. Snapshot reads
   * use this explicit input and never query the executor during render. */
  readonly chatDefault: () => import("../../protocol/runtime/app-service-types.js").RuntimeChatDefault
  readonly sessionChanges: () => Promise<SessionChangesService>
  readonly mutationEvidence: () => Promise<MutationEvidenceService>
  /** The background index of each session a client follows, held from its
   *  first read until the account's `background.release` says that no client
   *  follows it. */
  readonly backgroundIndex: Pick<BackgroundIndexOwner, "snapshot" | "release">
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
  /** The project's files for a person to mention. */
  readonly projectFiles: ProjectFilesService
  readonly modelAssignments: AdmittedModelAssignmentService
  readonly providerModels: ProviderModelPreferenceService
  /** Read-only optimization for durable queries. This lane returns unpositioned
   * domain data; the app-service bus remains the publication authority. */
  readonly backgroundLane: RuntimeBackgroundLane

  readonly subscriptionSpendConsent: { mutate(mutation: SubscriptionSpendConsentMutation): Promise<SubscriptionSpendConsentMutationResult> }
  readonly gitAiAttribution: GitAiAttributionProjection
  /** Account-global slash-command use counts, the ranking every client shares. */
  readonly commandUsage: CommandUsageProjection
  /** Executes built-in commands in this composition, the one that published their descriptors. */
  readonly commandInvoke: CommandInvokeService
  readonly runtimeSupervisor: RuntimeSupervisor
  /** Tool preparation, shared with initial background warming and joined by
   *  the mutation shutdown barrier. */
  readonly warmTools: () => Promise<void>
  /** Machine-owned reference files, published by the initial warm after
   *  runtime readiness and joined by the mutation shutdown barrier. */
  readonly publishReferences: () => Promise<void>
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

  function query<Q extends RuntimeQuery>(request: Q, options?: RuntimeQueryOptions): Promise<RuntimeQueryResult<Q>>
  async function query(request: RuntimeQuery, options: RuntimeQueryOptions = {}): Promise<RuntimeQueryResult<RuntimeQuery>> {
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
      case "sessionBackgroundWork": return await deps.backgroundIndex.snapshot(request.sessionId)
      // Settlement reads the runners and live controls of the composition, which serves it around this client.
      case "chatSettlement": throw new Error("The runtime composition answers chat settlement")
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
      case "transcriptFind": return historyProjection.transcriptFind(request.sessionId, request.request)
      case "chatSearch": return deps.backgroundLane.findChats(request.request, options.signal)
      case "projectFiles": return deps.projectFiles.search(request.request)
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
      case "waitingSessionsSnapshot": throw new Error("The sessions that wait on a question are held through the account service, never through a project executor")
      case "unreadChatsSnapshot": throw new Error(ACCOUNT_UNREAD_ONLY)
      case "roleSnapshot": return sessionViews(request.sessionIds, "roles", (sessionId) => deps.roleProjection.snapshot(sessionId))
      case "authStatusSnapshot": {
        const snapshotPosition = bus.snapshotPosition({ kind: "cursor", cursor: authStatusCursor(request.scope) })
        return { auth: await authStatusProjection.snapshot(request.scope), snapshotPosition }
      }
      case "authProfileDeletionPreview": return deps.authProfileSelection.previewDelete(request.id)
      // Updates are account-wide work, so the account service answers them and
      // never forwards them to a project executor (ARCH-PROTOCOL-043).
      case "updateSnapshot": throw new Error(ACCOUNT_UPDATES_ONLY)
      case "restartReadiness": throw new Error(ACCOUNT_RESTART_ONLY)
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
        return localResult.view || await deps.projection.liveCatalogRow(request.sessionId) ? localResult : deps.backgroundLane.sessionDetail(request)
      }
      case "recallQueuedMessage": return deps.runtimeSupervisor.recallQueuedMessage(request.sessionId)
      case "commandCatalog": return { ...deps.commandCatalog.snapshot(), snapshotPosition: bus.snapshotPosition({ kind: "cursor", cursor: commandCatalogCursor() }) }
      case "modelAssignments": return deps.modelAssignments.loadAssignments(request)
      case "sessionModelPlan": return deps.modelAssignments.loadSessionModelPlan(request)
      case "modelOptions": return deps.modelAssignments.listModelOptions(request)
      case "effortOptions": return deps.modelAssignments.listEffortOptions(request)
      case "modelRoles": return deps.modelAssignments.modelRoles()
      case "provider_models.query": return deps.providerModels.query(request.profileId, request.target)
    }
  }

  const admittedMutations: AdmittedMutationHandlers = {
    "background.warm": () => {
      backgroundWarm ??= admission.admit(async () => {
        ensureCatalogSubscription()
        deps.backgroundLane.start()
        const results = await Promise.allSettled([deps.runtimeSupervisor.warmChatRunner(), deps.warmTools()])
        const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
        if (failures.length === 1) throw failures[0]
        if (failures.length > 1) throw new AggregateError(failures, "Runtime warm failed")
        await deps.publishReferences()
      })?.catch((error: unknown) => {
        backgroundWarm = undefined
        throw error
      })
      return backgroundWarm
    },
    "subscription_spend_consent.save": (mutation) => admission.admit(() => deps.subscriptionSpendConsent.mutate(mutation)) ?? { kind: "contention" },
    "command_usage.record": (mutation) => admission.admit(async () => (deps.commandUsage.record(mutation.name) ? { ok: true } : { ok: false, error: `"/${mutation.name}" is not a slash command` })) ?? { ok: false, error: ADMISSION_CLOSED_ERROR },
    "model.save_effort": (mutation) => admission.admit(() => deps.modelAssignments.saveEffort(mutation)) ?? Promise.reject(new Error(ADMISSION_CLOSED_ERROR)),
    "model.reset_assignments": (mutation) => admission.admit(() => deps.modelAssignments.resetDefaults(mutation)) ?? Promise.reject(new Error(ADMISSION_CLOSED_ERROR)),
    "provider_model.set": (mutation) => admission.admit(() => deps.providerModels.set(mutation)) ?? Promise.reject(new Error(ADMISSION_CLOSED_ERROR)),
    "provider_models.deselect_all": (mutation) => admission.admit(() => deps.providerModels.deselectAll(mutation)) ?? Promise.reject(new Error(ADMISSION_CLOSED_ERROR)),
    "provider_models.recheck": (mutation) => admission.admit(() => deps.providerModels.recheck(mutation)) ?? Promise.reject(new Error(ADMISSION_CLOSED_ERROR)),
    "provider_models.set_auto_enable": (mutation) => admission.admit(() => deps.providerModels.setAutoEnableNewModels(mutation)) ?? Promise.reject(new Error(ADMISSION_CLOSED_ERROR)),
    "provider_free_routes.set": (mutation) => admission.admit(() => deps.providerModels.setFreeRoutes(mutation)) ?? Promise.reject(new Error(ADMISSION_CLOSED_ERROR)),
    "session.changes.set_viewed": (mutation) => admission.admit(async () => (await deps.sessionChanges()).setViewed(mutation)) ?? { status: "refused", message: "Runtime is closing" },
    "session.claim_composer_returns": (mutation) => admission.admit(() => deps.runtimeSupervisor.claimComposerReturns(mutation.sessionId, mutation.submissionIds)) ?? { ok: false, error: ADMISSION_CLOSED_ERROR },
  }
  const isAdmittedMutation = (mutation: FrontendMutation): mutation is AdmittedMutations[AdmittedMutationType] => Object.hasOwn(admittedMutations, mutation.type)
  // A generic key pairs each mutation with its own handler, which a union key cannot.
  const dispatchAdmitted = <Type extends AdmittedMutationType>(type: Type, mutation: AdmittedMutations[Type]) => admittedMutations[type](mutation)

  function dispatch<C extends FrontendMutation>(mutation: C): Promise<MutationResult<C>>
  async function dispatch(mutation: FrontendMutation): Promise<MutationResult<FrontendMutation>> {
    if (isAdmittedMutation(mutation)) return dispatchAdmitted(mutation.type, mutation)
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

  return { ...service, ...withLoggedAppServiceClient(service, log) }

  async function dispatchMutation(mutation: FrontendMutation): Promise<MutationResult<FrontendMutation>> {
    startupTrace(`app-service dispatch ${mutation.type} start`)
    if (isAuthMutation(mutation)) return dispatchAuthMutation(deps, mutation)
    if (isSettingsMutation(mutation)) return dispatchSettingsMutation(deps, mutation)
    if (mutation.type === "session_detail.release") throw new Error(ACCOUNT_SESSION_DETAIL_ONLY)
    if (mutation.type === "output.watch") throw new Error(ACCOUNT_OUTPUT_WATCH_ONLY)
    if (mutation.type === "service.restart") throw new Error(ACCOUNT_RESTART_ONLY)
    if (isUnreadChatsMutation(mutation)) throw new Error(ACCOUNT_UNREAD_ONLY)
    // The account sends it once no client follows the session's index.
    if (mutation.type === "background.release") {
      deps.backgroundIndex.release(mutation.sessionId)
      return { ok: true }
    }
    if (isAdmittedMutation(mutation) || mutation.type.startsWith("auth.profile.")) {
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
