import { AsyncLocalStorage } from "node:async_hooks"
import type { AsyncEventWriter, AsyncEventStateReadSurface } from "../../infra/event-store-types.js"
import type { KeyResolver } from "../../infra/auth/resolve-key.js"
import { authDir } from "../../infra/paths.js"
import type { ModelAssignmentRow, RuntimeGlobalDefaultRolesResult, RuntimeModelAssignmentScope, RuntimeModelAssignmentWriteScope, RuntimeSessionModelPlanQuery, RuntimeSessionModelPlanResult } from "../../protocol/model-assignment-protocol-types.js"
import { canonicalModelId } from "../../infra/llm/model-id.js"
import { TRAINING_ROUTES_REQUIRED } from "../../protocol/provider-model-preference-protocol-types.js"
import type { RuntimeConfigOwner } from "../config/runtime-config-owner.js"
import type { FirstPartyModuleSnapshot } from "../modules.js"
import { ensureSessionAuthProfile, resolveSessionAuthProfile, type SessionAuthAdmission, type SessionAuthProfileSelection, type SessionAuthProfileMaterializer } from "../session/session-auth-profile.js"
import type { SessionManager } from "../session/manager.js"
import type { SessionStore } from "../session-store/types.js"
import type { WorkflowDeps } from "../workflow-host/deps.js"
import type { DefinitionAvailabilityOwner } from "./definition-availability.js"
import { createRuntimeModelAssignmentService, type RuntimeModelAssignmentService } from "./model-assignment-service.js"
import type { RuntimeProviderModelEligibilityState } from "./provider-model-preference-service.js"
import type { SelectedModelRoute } from "../config/model-assignment-types.js"
import { enabledModelInfos } from "../config/model-assignment-providers.js"
import { accessProviderRegistry } from "../agent-runtime/llm/access-provider-registry.js"
import { enabledModelsFromEligibility } from "../config/session-role-resolver.js"
import { isModelTierReference } from "../../protocol/model-tier-reference.js"
import type { RoleCaptureStore } from "../config/model-assignment-controller.js"
import type { RuntimeChatDefault } from "../../protocol/app-service-types.js"
import type { AuthProfileManager } from "../auth/auth-profile-manager.js"
import type { EligibilityPreparation } from "./eligibility-preparation.js"
import { candidateCredentialLineage, captureAccountConnection } from "../agent-runtime/llm/client-factory.js"
import type { CaptureSubscriptionAdmission, ProviderConnectionCapture } from "../agent-runtime/factory.js"
import type { AuthContext } from "../../infra/auth/auth-context.js"
import { accessProviderCandidateKey, candidateProviderId, type AccessProviderCandidate, type AccessProviderId, type AdmittedFailoverPlan, type FailoverPlan } from "../../infra/llm/access-provider.js"
import type { ProviderAvailabilityOwner, RequestAdmission } from "../agent-runtime/llm/provider-availability-types.js"
import { getSharedProviderAvailability } from "../agent-runtime/llm/shared-provider-availability.js"
import { candidateReadiness } from "../agent-runtime/llm/failover-client.js"
import { requestAdmissionFromCaptures } from "../subscription-spend-consent/admission-capture.js"
import { errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"

const log = Log.create({ service: "model-assignment-admission" })

interface ModelAssignmentAdmissionDeps {
  readonly userDataRoot: string
  readonly projectRoot: string
  readonly manager: RoleCaptureStore & Pick<SessionManager, "read" | "createChat">
  readonly sessionStore: Pick<SessionStore, "get">
  readonly eventReader: AsyncEventStateReadSurface
  readonly eventWriter: AsyncEventWriter
  readonly availability: Pick<DefinitionAvailabilityOwner, "snapshot">
  readonly runtimeConfig: Pick<RuntimeConfigOwner, "snapshot" | "refresh">
  readonly resolveKey: KeyResolver
  readonly moduleSelection: FirstPartyModuleSnapshot
  readonly sessionAuthAdmission: SessionAuthAdmission<WorkflowDeps>
  readonly activeProfileId: () => string
  readonly prepareEligibility: (profileId: string) => Promise<void>
  readonly eligibilityState: (profileId: string) => RuntimeProviderModelEligibilityState
  readonly readAdmission: (scope: RuntimeModelAssignmentScope) => Promise<ModelAssignmentReadAdmission>
  /** Overrides the process-wide availability owner. Tests only. */
  readonly providerAvailability?: ProviderAvailabilityOwner
}

interface ModelAssignmentReadAdmission {
  readonly auth: AuthContext
  readonly profile: SessionAuthProfileSelection
  readonly modelAssignmentEligibility: RuntimeProviderModelEligibilityState
  readonly capture: Pick<ProviderConnectionCapture, "connection" | "providers" | "eligibility"> & {
    readonly allowTrainingRoutes: boolean
    /** Captures the allowance and paid-use state that a request on these candidates would be admitted with. */
    readonly requestAdmission: (candidates: readonly AccessProviderCandidate[]) => Promise<RequestAdmission>
  }
}

/** Resolves the durable profile without request initialization, then captures current exact-account selection inputs. */
export function createModelAssignmentReadAdmission(deps: {
  readonly userDataRoot: string
  readonly manager: Pick<SessionManager, "read" | "captureAuthProfileIfAbsent">
  readonly authProfiles: Pick<AuthProfileManager, "inspect">
  readonly materialize: SessionAuthProfileMaterializer
  readonly prepareEligibility: EligibilityPreparation
  readonly runtimeConfig: Pick<RuntimeConfigOwner, "snapshot">
  /** Captures allowance and paid-use consent for one profile, as a request on its candidates would be admitted with. */
  readonly captureSubscriptionAdmission: (profileId: string, profileDirectory: string) => CaptureSubscriptionAdmission
}): ModelAssignmentAdmissionDeps["readAdmission"] {
  return async (scope) => {
    const profile = scope.kind === "defaults"
      ? resolveSessionAuthProfile({}, deps.authProfiles.inspect())
      : await ensureSessionAuthProfile({ ...deps, sessionId: scope.sessionId })
    const directory = authDir(deps.userDataRoot, profile.effectiveId)
    return deps.prepareEligibility.capture({ id: profile.effectiveId, directory }, (state, auth, composition) => {
      const providers = accessProviderRegistry(composition)
      const connection = captureAccountConnection(auth, directory, providers, profile.effectiveId)
      const settings = deps.runtimeConfig.snapshot().config.profiles[profile.effectiveId]
      return {
        auth,
        profile,
        modelAssignmentEligibility: state,
        capture: {
          providers,
          connection,
          eligibility: state.worker,
          allowTrainingRoutes: settings?.allow_training_routes ?? false,
          requestAdmission: async (candidates) => requestAdmissionFromCaptures(
            await deps.captureSubscriptionAdmission(profile.effectiveId, directory)(candidates, settings?.providers ?? {}),
            connection,
          ),
        },
      }
    }, undefined, "saved-only")
  }
}

export interface ChatDefaultRefreshOwner {
  current(): RuntimeChatDefault
  start(): void
  refresh(): Promise<void>
  dispose(): Promise<void>
}

/** Owns the resolved global chat assignment across asynchronous replacement.
 * A replacement remains invisible until its complete model and effort pair is
 * current, and an older completion can never replace a newer request. */
export function createChatDefaultRefreshOwner(options: {
  readonly initial: RuntimeChatDefault
  readonly resolve: () => Promise<RuntimeGlobalDefaultRolesResult>
  readonly publish: (value: RuntimeChatDefault) => void
  readonly onError: (error: unknown) => void
}): ChatDefaultRefreshOwner {
  let value = options.initial
  let started = false
  let dirty = false
  let closed = false
  let drain: Promise<void> | undefined
  const run = async (): Promise<void> => {
    while (dirty) {
      if (!started || closed) return
      dirty = false
      try {
        const result = await options.resolve()
        if (closed || dirty) continue
        const next: RuntimeChatDefault = result.chat && !isModelTierReference(result.chat.model)
          ? { kind: "model", model: result.chat.model, effort: result.chat.effort }
          : { kind: "none" }
        if (!sameChatDefault(value, next)) {
          value = next
          options.publish(value)
        }
      } catch (error) {
        if (!closed && !dirty) options.onError(error)
      }
    }
  }
  const ensureDrain = (): Promise<void> => {
    if (!drain) {
      drain = run().finally(() => {
        drain = undefined
        if (started && dirty && !closed) void ensureDrain()
      })
    }
    return drain
  }
  const refresh = (): Promise<void> => {
    if (closed) return Promise.resolve()
    dirty = true
    return started ? ensureDrain() : Promise.resolve()
  }
  return {
    current: () => value,
    start() {
      if (closed || started) return
      started = true
      dirty = true
      void ensureDrain()
    },
    refresh,
    async dispose() {
      closed = true
      dirty = false
      await drain
    },
  }
}

type ModelAssignmentAdmission = {
  readonly profile: SessionAuthProfileSelection
  readonly auth?: AuthContext
  readonly selectedModelRoutes?: Pick<ReadonlyMap<string, SelectedModelRoute>, "get" | "keys">
  readonly modelAssignmentEligibility?: RuntimeProviderModelEligibilityState
}

export interface AdmittedModelAssignmentService extends RuntimeModelAssignmentService {
  /** Reads resolved session assignments and the automatic candidate order without constructing a client or sending a request. */
  loadSessionModelPlan(query: RuntimeSessionModelPlanQuery): Promise<RuntimeSessionModelPlanResult>
}

/** Binds model-assignment reads and writes to one admitted auth profile. */
export function createAdmittedModelAssignmentService(deps: ModelAssignmentAdmissionDeps): AdmittedModelAssignmentService {
  const admissionStorage = new AsyncLocalStorage<ModelAssignmentAdmission>()
  const service = createRuntimeModelAssignmentService({
    roleCaptureStore: deps.manager,
    sessionStore: deps.sessionStore,
    projectRoot: deps.projectRoot,
    eventStore: deps.eventReader,
    eventWriter: deps.eventWriter,
    availability: deps.availability,
    moduleSelection: deps.moduleSelection,
    config: () => deps.runtimeConfig.snapshot().config,
    refreshConfig: async () => (await deps.runtimeConfig.refresh()).config,
    prepareModelEligibility: () => {
      const admission = admissionStorage.getStore()
      if (!admission) throw new Error("model assignment profile has not been admitted")
      if (admission.modelAssignmentEligibility !== undefined) return Promise.resolve()
      return deps.prepareEligibility(admission.profile.effectiveId)
    },
    configDepsForScope: () => {
      const admission = admissionStorage.getStore()
      if (!admission) throw new Error("model assignment profile has not been admitted")
      const profileId = admission.profile.effectiveId
      const state = admission.modelAssignmentEligibility ?? deps.eligibilityState(profileId)
      const ranks = new Map(accessProviderRegistry(deps.moduleSelection()).selection.definitions.map((definition) => [definition.id, definition.rank]))
      const catalogInfos = enabledModelInfos(state.enabledCandidates, (providerId) => ranks.get(providerId) ?? Number.MAX_SAFE_INTEGER)
      return {
        userDataRoot: deps.userDataRoot,
        authDirectory: () => authDir(deps.userDataRoot, profileId),
        authProfileId: () => profileId,
        resolveKey: deps.resolveKey,
        auth: admission.auth,
        moduleSelection: deps.moduleSelection,
        providerModelCatalogs: () => state.catalogs,
        providerModelEligibility: () => state.picker,
        // The enabled models are the picker's servable entries: the same
        // derivation a profile selection captures roles from, so defaults
        // never re-list the catalog or re-read credentials to learn them.
        get availableModels() {
          const available = enabledModelsFromEligibility(state.picker)
          return admission.selectedModelRoutes === undefined ? available : new Map([...available].map(([family, models]) => [
            family, new Set([...models].filter((model) => admission.selectedModelRoutes?.get(model)?.wireModelId !== undefined)),
          ]))
        },
        eligibilityRevision: state.revision,
        modelInfos: admission.selectedModelRoutes === undefined
          ? catalogInfos
          : {
              keys: () => catalogInfos.keys(),
              get: (model: string) => {
                const route = admission.selectedModelRoutes?.get(model)
                return (route?.reason === undefined ? route?.metadata : undefined) ?? catalogInfos.get(model)
              },
            },
        selectedModelRoutes: admission.selectedModelRoutes,
        get config() { return deps.runtimeConfig.snapshot().config },
      }
    },
  })

  const admit = (scope: RuntimeModelAssignmentScope) =>
    scope.kind === "defaults"
      ? deps.sessionAuthAdmission.admitDefaults()
      : deps.sessionAuthAdmission.admit(scope.sessionId)

  const withAdmission = async <T>(scope: RuntimeModelAssignmentScope, operation: () => Promise<T>): Promise<T> =>
    admissionStorage.run(await admit(scope), operation)

  /** Runs `operation` under one read admission. With `serving`, every model's route also states which provider
   *  would serve it now, read once from live state when the operation starts. */
  const withReadAdmission = async <T>(scope: RuntimeModelAssignmentScope, operation: (admission: ModelAssignmentReadAdmission) => Promise<T>, serving = false): Promise<T> => {
    const admission = await deps.readAdmission(scope)
    const { capture, modelAssignmentEligibility: state } = admission
    const canonicalModels = new Set<string>()
    for (const candidate of state.enabledCandidates.values()) {
      if (!candidate.configured || !candidate.currentConnection || candidate.enabledOfferings === null) continue
      for (const model of candidate.enabledOfferings.keys()) canonicalModels.add(model)
    }
    const plans = new Map<string, FailoverPlan>()
    const planFor = (model: string): FailoverPlan => {
      const existing = plans.get(model)
      if (existing) return existing
      const plan = capture.providers.selection.plan(model, capture.connection, capture.eligibility, capture.allowTrainingRoutes)
      plans.set(model, plan)
      return plan
    }
    const servingProviders = serving
      ? await servingProvidersNow(admission, [...canonicalModels].map(planFor).filter((plan) => plan.kind === "admitted"))
      : new Map<string, AccessProviderId>()
    const routes = new Map<string, SelectedModelRoute>()
    const selectedModelRoutes = {
      keys: () => canonicalModels.keys(),
      get(model: string): SelectedModelRoute | undefined {
        if (!canonicalModels.has(model)) return undefined
        const existing = routes.get(model)
        if (existing) return existing
        const plan = planFor(model)
        if (plan.kind === "admitted") {
          const selected = plan.candidateAttributions[0]
          if (selected !== undefined) {
            const providerHint = capture.providers.selection.catalogId(selected.candidate.providerId) ?? plan.family
            routes.set(model, Object.freeze({
              wireModelId: selected.wireModelId,
              dataUse: selected.dataUse,
              providerHint,
              providers: [...new Set(plan.candidates.map((candidate) => candidate.providerId))].map((providerId) => ({
                name: capture.providers.selection.displayName(providerId),
                shortName: capture.providers.selection.shortName(providerId),
                serving: servingProviders.get(plan.model) === providerId,
              })),
              ...(selected.resolvedModelMetadata === undefined ? {} : { metadata: selected.resolvedModelMetadata }),
            }))
          }
          return routes.get(model)
        }
        routes.set(model, Object.freeze({
          reason: hasOnlyContributorRoutes(state, model)
            ? TRAINING_ROUTES_REQUIRED
            : plan.reason,
        }))
        return routes.get(model)
      },
    }
    return admissionStorage.run({
      ...admission,
      selectedModelRoutes,
      modelAssignmentEligibility: state,
    }, () => operation(admission))
  }

  /** The provider that would serve each plan's model now, by the readiness rule a request walk applies: the first
   *  ready candidate, else the first that waits on a recheck. The availability binding is new, so it reads the shared
   *  authority once, now. A model that no candidate can serve has no entry. */
  const servingProvidersNow = async (admission: ModelAssignmentReadAdmission, plans: readonly AdmittedFailoverPlan[]): Promise<ReadonlyMap<string, AccessProviderId>> => {
    const serving = new Map<string, AccessProviderId>()
    const candidates = [...new Map(plans.flatMap((plan) => plan.candidates).map((candidate) => [accessProviderCandidateKey(candidate), candidate])).values()]
    if (candidates.length === 0) return serving
    const { connection } = admission.capture
    try {
      const requestAdmission = await admission.capture.requestAdmission(candidates)
      const availability = (deps.providerAvailability ?? getSharedProviderAvailability()).forCandidates(admission.profile.effectiveId, candidates)
      availability.refreshProjection()
      for (const plan of plans) {
        const inputs = {
          availability,
          family: plan.family,
          conditions: connection.auth.conditions ?? [],
          credentialLineage: (candidate: AccessProviderCandidate) => candidateCredentialLineage(connection, candidate),
          subscriptionSpendAuthorizationFor: requestAdmission.subscriptionSpendAuthorizationFor,
          ...(requestAdmission.subscriptionAllowanceFor === undefined ? {} : { subscriptionAllowanceFor: requestAdmission.subscriptionAllowanceFor }),
        }
        const readiness = plan.candidateAttributions.map(({ candidate }) => ({ candidate, readiness: candidateReadiness(candidate, inputs) }))
        const chosen = readiness.find((entry) => entry.readiness.kind === "ready") ?? readiness.find((entry) => entry.readiness.kind === "pending")
        if (chosen !== undefined) serving.set(plan.model, candidateProviderId(chosen.candidate))
      }
    } catch (error) {
      // A request on these accounts would refuse for the same reason; the picker still lists the models and marks none.
      log.warn("model picker could not read which providers serve now", { profileId: admission.profile.effectiveId, error: errorMessage(error) })
      serving.clear()
    }
    return serving
  }

  const writeScope = (scope: RuntimeModelAssignmentWriteScope): RuntimeModelAssignmentScope =>
    scope.kind === "defaults-and-session" ? { kind: "session", sessionId: scope.sessionId } : scope

  return {
    async loadSessionModelPlan(query) {
      const scope = { kind: "session", sessionId: query.sessionId } as const
      return withReadAdmission(scope, async ({ profile, capture }) => {
        const assignments = await service.loadAssignments({ scope, slots: query.slots })
        const plans = [...new Set(assignments.map((row) => canonicalModelId(row.model)))].map((model): RuntimeSessionModelPlanResult["plans"][number] => {
          const plan = capture.providers.selection.plan(model, capture.connection, capture.eligibility, capture.allowTrainingRoutes)
          if (plan.kind === "unavailable") return { kind: "unavailable", model, reason: plan.reason, missing: plan.missing }
          return {
            kind: "available", model,
            candidates: plan.candidateAttributions.map(({ candidate, wireModelId }) => candidate.kind === "subscription"
              ? { kind: candidate.kind, providerId: candidate.providerId, instanceId: candidate.instanceId, spendMode: candidate.spendMode, wireModelId }
              : { kind: candidate.kind, providerId: candidate.providerId, spendMode: candidate.spendMode, wireModelId }),
          }
        })
        return { sessionId: query.sessionId, profile, assignments, plans }
      })
    },
    loadAssignments: (query) => withReadAdmission(query.scope, () => service.loadAssignments(query)),
    listModelOptions: (query) => withReadAdmission(query.scope, () => service.listModelOptions(query), true),
    listEffortOptions: (query) => withReadAdmission(query.scope, () => service.listEffortOptions(query)),
    // A saved choice is kept even when it cannot serve, so the result says
    // what serves instead: the seat read again under the same capture that a
    // request of the serving scope resolves through.
    async saveEffort(command) {
      const scope = writeScope(command.scope)
      const saved = await withAdmission(scope, () => service.saveEffort(command))
      const [row] = await withReadAdmission(scope, () => service.loadAssignments({ scope, slots: [command.slot] }))
      const warning = [saved.warning, servingWarning(saved.label, row)].filter((text) => text !== undefined).join(" ")
      return warning === "" ? saved : { ...saved, warning }
    },
    resetDefaults: (command) => withAdmission(writeScope(command.scope), () => service.resetDefaults(command)),
    globalDefaultRoles: () => withReadAdmission({ kind: "defaults" }, () => service.globalDefaultRoles()),
    modelRoles: () => service.modelRoles(),
  }
}

/** Undefined when the seat's saved model serves; otherwise what serves until it can. */
function servingWarning(label: string, row: ModelAssignmentRow | undefined): string | undefined {
  if (row === undefined) return `Saved ${label}, but no model can serve now.`
  if (row.savedModel === undefined) return undefined
  return `Saved ${label}, but ${row.savedModel} cannot serve now. ${row.model} at ${row.effort} effort serves until it can.`
}

function sameChatDefault(left: RuntimeChatDefault, right: RuntimeChatDefault): boolean {
  return left.kind === right.kind
    && (left.kind !== "model" || (right.kind === "model" && left.model === right.model && left.effort === right.effort))
}

function hasOnlyContributorRoutes(state: RuntimeProviderModelEligibilityState, model: string): boolean {
  let contributor = false
  for (const candidate of state.enabledCandidates.values()) {
    if (!candidate.configured || !candidate.currentConnection) continue
    const offerings = candidate.enabledOfferings?.get(model)
    if (offerings?.some(({ dataUse }) => dataUse === "standard")) return false
    if (offerings?.some(({ dataUse }) => dataUse === "contributor")) contributor = true
  }
  return contributor
}
