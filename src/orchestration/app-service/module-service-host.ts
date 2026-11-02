import type { Schema } from "effect"
import type { ModuleTransports } from "./module-transports.js"
import type { FrontendEvent } from "../../protocol/app-service-types.js"
import type { AuthRuntime } from "./auth-runtime.js"
import type { RuntimeConfigProjection } from "./runtime-config-projection.js"
import type { StartupDirectories } from "../../infra/directory-authorities.js"
import type { AsyncEventStateReadSurface, AsyncEventWriter, StoredFact } from "../../infra/event-store-types.js"
import { composeModuleServices, type ModuleServices } from "../../infra/module-service.js"
import type { NotificationEpisodeInput } from "../../infra/notification-episode.js"
import { Log } from "../../infra/log.js"
import { errorMessage } from "../../infra/error-message.js"
import type { LauncherContext, LauncherScope } from "../../infra/process-supervisor.js"
import type { RuntimeUiPatch, RuntimeUiPatchInput } from "../../protocol/runtime-ui-protocol-types.js"
import type { RuntimeUiPatchSequencer } from "./runtime-ui-patch-sequencer.js"
import type { RuntimeConfigOwner } from "../config/runtime-config-owner.js"
import type { FirstPartyModule, FirstPartyModuleComposition, FirstPartyModuleSnapshot } from "../modules.js"
import type { SessionManager } from "../session/manager.js"
import type { SessionStore } from "../session-store/types.js"
import type { AccountProjectClone } from "./account-project-clone.js"
import type { AccountProjectRegistry } from "./account-project-registry.js"
import type { AccountService } from "./account-service.js"
import type { SettledControlUiAssetState } from "./web-serving/control-ui-assets.js"
import type { SessionAuthAdmission } from "../session/session-auth-profile.js"
import type { WorkflowDeps } from "../workflow-host/deps.js"
import type { RecallInput, RecallResult } from "../../protocol/conversation-recall.js"
import type { AttachChildSessionProjection, ParentNotificationDelivery } from "../module-seams.js"
import type { ChatRunner } from "../chat/runner-types.js"
import type { RuntimeFaultReporter } from "./runtime-fault-reporting.js"
import type { AccountModuleRequest } from "../../protocol/account-attach.js"

/** Request-time execution authorities. Reading this port does not activate a session. */
interface ModuleExecutionEnvironment {
  readonly openChatRunner: (sessionId: string) => Promise<ChatRunner | undefined>
  readonly authAdmission: SessionAuthAdmission<WorkflowDeps>
  readonly recall: (conversationId: string, input: RecallInput) => Promise<RecallResult>
  readonly attachProjection: AttachChildSessionProjection
  readonly deliverNotification: ParentNotificationDelivery
}

/** What the runtime hands a module that declares a process-scoped service:
 *  the kernel authorities composition already threads to its projections, and
 *  the services of the modules built before it. Every field is a kernel
 *  authority; a module-owned value lives in the module's own service. */
export interface ModuleProcessServices {
  readonly transports: Pick<ModuleTransports, "addListener">
  readonly onFrontendEvent: (listener: (event: FrontendEvent) => void) => () => void
  /** Profile accounting and admission evidence remain kernel authorities. Read only from a service start hook or a later request, after auth composition. */
  readonly profileAccounting: () => Pick<AuthRuntime, "subscriptionUsage" | "refreshSubscriptionSpendConsent">
  /** Resolve only after auth composition. Account and self-contained hosts do not receive this port. */
  readonly executionEnvironment: () => ModuleExecutionEnvironment
  readonly configView: () => ReturnType<RuntimeConfigProjection["view"]>
  readonly moduleSelection: FirstPartyModuleSnapshot
  /** Runs after the validated selection changes. Synchronous effects apply in the publication turn; asynchronous failures are contained by composition. */
  readonly onSelectionChanged: (listener: () => void | Promise<void>) => () => void | Promise<void>
  /** Complete installed access-provider vocabulary, including disabled providers. */
  readonly notify: (episode: NotificationEpisodeInput) => Promise<void>
  readonly interactive: boolean
  readonly directories: StartupDirectories
  readonly eventStore: AsyncEventStateReadSurface
  readonly projectionReader: AsyncEventStateReadSurface
  readonly eventWriter: AsyncEventWriter
  /** The store's post-commit broadcast. */
  readonly onStored: (listener: (facts: readonly StoredFact[]) => void) => () => void
  readonly publish: (input: RuntimeUiPatchInput) => RuntimeUiPatch | undefined
  readonly snapshotPosition: RuntimeUiPatchSequencer["snapshotPosition"]
  readonly sessionManager: SessionManager
  readonly sessionStore: SessionStore
  /** The runtime's one configuration authority: the live snapshot and its change stream. */
  readonly config: Pick<RuntimeConfigOwner, "snapshot" | "subscribe" | "mutateSection">
  readonly launcher: LauncherScope
  /** The services of the modules constructed before this one, in dependency order. */
  readonly modules: ModuleServices
  /** Whether this module is in the live selection. The instance lives for the
   *  process; a service whose effect must stop when the module is turned off
   *  reads this when the selection changes (ARCH-RUNTIME-068). */
  readonly enabled: () => boolean
}

/** The kernel authorities every composition that builds runners holds, a
 *  headless run included: the directory authorities, the configuration
 *  authority, the launcher, the live selection, and the portable services of
 *  the modules built before this one. A service whose factory reads only these
 *  declares itself portable, and every such composition constructs it through
 *  the same activation walk. */
export type PortableModuleServices = Pick<ModuleProcessServices, "directories" | "config" | "launcher" | "onSelectionChanged" | "modules" | "enabled">

/** Account-side project ports. Notifications cross to their owning authority;
 * no session store, runner, auth runtime, or writable database is available. */
export type AccountProjectModuleServices = Pick<ModuleProcessServices,
  "transports" | "onFrontendEvent" | "onSelectionChanged" | "notify" |
  "directories" | "publish" | "snapshotPosition" | "launcher" | "modules" | "enabled" | "eventWriter" | "onStored" | "projectionReader"> & {
    readonly eventStore: AsyncEventStateReadSurface
    readonly projectRegistry: Omit<AccountProjectRegistry, "dispose">
    /** The account's one web client resolution. Absent in a composition no
     *  account serves, which serves no client. */
    readonly webClient?: () => Promise<SettledControlUiAssetState>
    /** The account's report of the module services it could not start.
     *  Absent in a composition no account serves. */
    readonly accountModuleFaults?: AccountModuleFaults
    /** Reads the current episode's failed report without broadcasting its content. */
    readonly readFaultReport?: (source: "executor" | "service") => string | undefined
  }

export interface AccountModuleService {
  /** An enabled module may report a runtime fault, without delaying fault publication. */
  readonly reportFault?: RuntimeFaultReporter
  /** Settles this module's dormant project resources before a live owner starts. */
  prepareProject?(projectRoot: string): Promise<void>
  /** The module's Keep Awake For Phone references, one per project a phone
   *  woke. `held` answers whether it holds one for a project, which a planned
   *  replacement's cut records for a project that hands commands over; `hold`
   *  takes one for an open project until the project closes, which the
   *  successor does for a project its handoff names so. */
  readonly phoneKeepAwake?: { held(projectRoot: string): boolean; hold(projectRoot: string): Promise<void> }
  /** Serves one request that a client sends this module on an account
   *  attach, which opens no project: sends each answer through `answer` and
   *  settles when the request ends. `withdrawn` aborts when the client
   *  leaves first. A rejection is the failure the client reads. */
  readonly serveRequest?: AccountModuleRequestServer
  dispose(): Promise<void>
}

export type AccountModuleRequestServer = (request: AccountModuleRequest, answer: (payload: unknown) => Promise<void>, withdrawn: AbortSignal) => Promise<void>

/** The configuration values an account service's constructor reads. */
export type AccountModuleServiceInputs = Schema.Json

/** `webClient` is the account's one web client resolution: the identity and
 *  build the service serves to every surface, the phone's included. */
export interface AccountModuleServiceOptions<Runtime extends { dispose(): Promise<void> }> extends Required<Pick<AccountProjectModuleServices, "webClient">> {
  readonly userDataRoot: string
  readonly version: string
  readonly registry: AccountProjectRegistry
  readonly projects: AccountService<Runtime>
  /** The account's one owner of project creation from a repository. */
  readonly projectClone: Pick<AccountProjectClone, "clone">
  readonly launcher: LauncherContext
  readonly config: { readonly [key: string]: unknown }
}

/** The account-lifetime module services one start brought up, and each
 *  module whose service threw as it started, by module id, with what it
 *  threw. */
export interface AccountModuleServicesStart {
  readonly services: readonly AccountModuleService[]
  readonly failures: ReadonlyMap<string, unknown>
}

/** Why each module's account-lifetime service could not start, by module id,
 *  from that start until a later start of the module's service succeeds. The
 *  account service keeps one report for the account and hands it to every
 *  project it opens, so a module states its own account service's failure
 *  where the module's state already shows. */
export interface AccountModuleFaults {
  fault(moduleId: string): string | undefined
  /** Hears each change of the report until the returned function runs. */
  subscribe(listener: () => void): () => void
}

/** Reconcile admitted account services on the caller's serialized configuration lane.
 * Only changed constructor inputs or selection replace a service. Constructor failures
 * stay isolated to their module until its inputs change. Disposal joins all live services. */
export function createAccountModuleServiceOwner<Runtime extends { dispose(): Promise<void> }>(options: Omit<AccountModuleServiceOptions<Runtime>, "config"> & {
  readonly onStartFailure: (module: string, error: unknown) => void
}) {
  type Entry = { readonly inputs: AccountModuleServiceInputs; readonly module: string } & (
    | { readonly kind: "ready"; readonly service: AccountModuleService }
    | { readonly kind: "failed"; readonly error: unknown }
  )
  const entries = new Map<string, Entry>()
  return {
    async reconcile(composition: FirstPartyModuleComposition, config: AccountModuleServiceOptions<Runtime>["config"]): Promise<AccountModuleServicesStart> {
      const desired = composition.contributions.filter((contribution) => contribution.domain === "accountServices").map((contribution) => ({
        contribution,
        key: `${contribution.module}:${contribution.id}`,
        inputs: contribution.value.configuration(config),
      }))
      const desiredInputs = new Map(desired.map((entry) => [entry.key, entry.inputs]))
      const obsolete = [...entries].filter(([key, entry]) => !desiredInputs.has(key) || !Bun.deepEquals(desiredInputs.get(key), entry.inputs, true))
      await Promise.all(obsolete.map(async ([key, entry]) => {
        if (entry.kind === "ready") await entry.service.dispose()
        entries.delete(key)
      }))
      for (const { key, inputs, contribution } of desired) {
        if (entries.has(key)) continue
        try {
          entries.set(key, { kind: "ready", inputs, module: contribution.module, service: contribution.value.create({ ...options, config }) })
        } catch (error) {
          entries.set(key, { kind: "failed", inputs, module: contribution.module, error })
          options.onStartFailure(contribution.module, error)
        }
      }
      return {
        services: [...entries.values()].flatMap((entry) => entry.kind === "ready" ? [entry.service] : []),
        failures: new Map([...entries.values()].flatMap((entry) => entry.kind === "failed" ? [[entry.module, entry.error]] : [])),
      }
    },
    /** Serves a `module` attach through the request server of `module`'s
     *  live account service. Rejects with the reason the client prints when
     *  the module is off for the account or its service could not start. */
    async serveRequest(module: string, request: AccountModuleRequest, answer: (payload: unknown) => Promise<void>, withdrawn: AbortSignal): Promise<void> {
      const entry = [...entries.values()].find((candidate) => candidate.module === module && (candidate.kind === "failed" || candidate.service.serveRequest !== undefined))
      if (entry?.kind === "failed") throw new Error(`The ${module} module's account service could not start: ${errorMessage(entry.error)}`)
      if (entry?.service.serveRequest === undefined) throw new Error(`The ${module} module is off for this account.`)
      await entry.service.serveRequest(request, answer, withdrawn)
    },
    async dispose() {
      await Promise.all([...entries.values()].map((entry) => entry.kind === "ready" ? entry.service.dispose() : undefined))
      entries.clear()
    },
  }
}

/** State-backed control services run in the account when attached, or in the standalone host. */
export type ControlModuleServices = Pick<ModuleProcessServices, "projectionReader" | "eventWriter" | "onStored" | "publish">

/** What every module service instance owes composition: one disposal that
 *  settles admitted work and releases what the service holds. Composition runs
 *  it in the durable-state flush, before the event store writer closes, and
 *  calls `closeAdmission` first when shutdown begins. */
export interface ModuleServiceInstance {
  /** Starts optional work after every kernel authority is available. */
  start?(): void
  /** Resolves once the work `start` began has settled, success or failure,
   *  with one sentence for each condition a person must act on. A composition
   *  that must not admit its first request before then, a headless run, awaits
   *  it; the interactive runtime never waits on it. */
  settleStartup?(): Promise<readonly string[]>
  closeAdmission?(): void
  dispose(): Promise<void> | void
}

export interface ComposedModuleServices {
  readonly services: ModuleServices
  /** Construct newly selected services. Call only after the owner is registered. */
  reconcile(): void
  /** Mark kernel authorities ready and start selected service hooks once. */
  start(): void
  /** Every constructed instance's startup notices, in construction order. A
   *  settlement that fails is logged and contributes no notice. */
  settleStartup(): Promise<readonly string[]>
  closeAdmission(): void
  dispose(): Promise<void>
  /** The constructed instances in construction order, including later activations. */
  readonly instances: readonly (readonly [moduleId: string, instance: ModuleServiceInstance])[]
}

/** Owns service activation for the process. The composition root registers this
 *  owner before its first reconcile, so a constructor failure still disposes
 *  every dependency already built. Disabled factories never run; a later valid
 *  selection activates them through the same dependency walk. */
export function composeModuleProcessServices(modules: readonly FirstPartyModule[], enabledModuleIds: () => readonly string[], kernel: Omit<ModuleProcessServices, "modules" | "enabled">, accountAttached = false): ComposedModuleServices {
  return composeServiceInstances(modules, enabledModuleIds, (module, services, enabled) =>
    module.host !== "account" && !(accountAttached && module.host === "control") ? module.service?.create({ ...kernel, modules: services, enabled }) : undefined)
}

/** Constructs only the portable execution services, over the portable
 *  kernel, for a composition that holds no runtime kernel, such as a headless
 *  run. Every other module's service, and so every effect it starts, stays
 *  absent there. */
export function composePortableModuleServices(modules: readonly FirstPartyModule[], enabledModuleIds: () => readonly string[], kernel: Omit<PortableModuleServices, "modules" | "enabled">): ComposedModuleServices {
  return composeServiceInstances(modules, enabledModuleIds, (module, services, enabled) =>
    module.host !== "account" && module.host !== "control" && module.service && "portable" in module.service ? module.service.create({ ...kernel, modules: services, enabled }) : undefined)
}

/** Constructs only account-placed services from the installed module catalog. */
export function composeAccountProjectModuleServices(modules: readonly FirstPartyModule[], enabledModuleIds: () => readonly string[], kernel: Omit<AccountProjectModuleServices, "modules" | "enabled">): ComposedModuleServices {
  return composeServiceInstances(modules, enabledModuleIds, (module, services, enabled) =>
    module.host === "account" || module.host === "control" ? module.service?.create({ ...kernel, modules: services, enabled }) : undefined)
}

function composeServiceInstances(modules: readonly FirstPartyModule[], enabledModuleIds: () => readonly string[], create: (module: FirstPartyModule, services: ModuleServices, enabled: () => boolean) => ModuleServiceInstance | undefined): ComposedModuleServices {
  const byId = new Map(modules.map((module) => [module.id, module]))
  const built: (readonly [string, ModuleServiceInstance])[] = []
  const byInstanceId = new Map<string, ModuleServiceInstance>()
  let bindings = composeModuleServices(built)
  const services: ModuleServices = { get: (handle) => bindings.get(handle) }
  const started = new Set<ModuleServiceInstance>()
  const closeErrors: unknown[] = []
  let ready = false
  let closed = false
  let settlement: Promise<void> | undefined

  const reconcile = (): void => {
    if (closed) return
    const enabled = new Set(enabledModuleIds())
    const visited = new Set<string>()
    const visit = (id: string): void => {
      const module = byId.get(id)
      if (!module || visited.has(id) || !enabled.has(id)) return
      visited.add(id)
      for (const dependency of module.dependencies) visit(dependency)
      if (!module.service) return
      let instance = byInstanceId.get(id)
      if (!instance) {
        instance = create(module, services, () => enabledModuleIds().includes(id))
        if (!instance) return
        built.push([id, instance])
        byInstanceId.set(id, instance)
        bindings = composeModuleServices(built)
      }
      if (ready && !started.has(instance)) {
        instance.start?.()
        started.add(instance)
      }
    }
    for (const module of modules) visit(module.id)
  }
  const closeAdmission = (): void => {
    if (closed) return
    closed = true
    for (const [, instance] of built.toReversed()) {
      try { instance.closeAdmission?.() } catch (error) { closeErrors.push(error) }
    }
  }
  return {
    services,
    instances: built,
    reconcile,
    start() { if (!closed) { ready = true; reconcile() } },
    async settleStartup() {
      const settled = await Promise.all(built.map(async ([moduleId, instance]) => {
        try {
          return await instance.settleStartup?.() ?? []
        } catch (error) {
          log.error("module service startup settlement failed", { moduleId, error: error instanceof Error ? error.message : String(error) })
          return []
        }
      }))
      return settled.flat()
    },
    closeAdmission,
    dispose() {
      closeAdmission()
      settlement ??= (async () => {
        const errors = [...closeErrors]
        for (const [, instance] of built.toReversed()) {
          try { await instance.dispose() } catch (error) { errors.push(error) }
        }
        if (errors.length > 0) throw new AggregateError(errors, "Module services failed to settle")
      })()
      return settlement
    },
  }
}

const log = Log.create({ service: "module-service-host" })

/** The notify seam: every enabled module observing it receives the episode,
 *  read from the live selection so a module turned off hears nothing and a
 *  producer never names one. It is the one async observer seam (ARCH-STRUCTURE-040):
 *  the answer settles once every enabled observer has applied the input, and
 *  at once with none enabled, so a producer can order work after the commit.
 *  Every observer runs whatever another one does. The answer rejects when
 *  any observer failed to apply the episode, with that failure or an
 *  `AggregateError` of all of them, so a producer that must know whether
 *  the episode landed learns it; a producer that does not act on a failure
 *  contains it at its own boundary. */
export function createNotifySeam(moduleSelection: FirstPartyModuleSnapshot, services: () => ModuleServices): (episode: NotificationEpisodeInput) => Promise<void> {
  return async (episode) => {
    const modules = services()
    const outcomes = await Promise.allSettled(moduleSelection().observers.flatMap((declaration) =>
      declaration.seam === "notify" ? [(async () => { await declaration.observer(episode, modules) })()] : []))
    const failures = outcomes.flatMap((outcome) => outcome.status === "rejected" ? [outcome.reason] : [])
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, "Notification observers failed")
  }
}
