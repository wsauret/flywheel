import type { ModuleTransports } from "./module-transports.js"
import type { FrontendEvent } from "../../../../protocol/runtime/app-service-types.js"
import type { AuthRuntime } from "../../auth/auth-runtime.js"
import type { RuntimeConfigProjection } from "../../projections/runtime-config-projection.js"
import type { StartupDirectories } from "../../../../infra/platform/files/directory-authorities.js"
import type { AsyncEventStateReadSurface, AsyncEventWriter, StoredFact } from "../../../../infra/substrate/store/event-store-types.js"
import { composeModuleServices, type ModuleServices } from "../../../../infra/definitions/modules/module-service.js"
import type { NotificationEpisodeInput } from "../../../../infra/substrate/events/notification-episode.js"
import { Log } from "../../../../infra/diagnostics/log.js"
import type { LauncherScope } from "../../../../infra/process-supervisor.js"
import type { RuntimeUiPatch, RuntimeUiPatchInput } from "../../../../protocol/runtime/runtime-ui-protocol-types.js"
import type { RuntimeUiPatchSequencer } from "../../projections/runtime-ui-patch-sequencer.js"
import type { RuntimeConfigOwner } from "../../../config/runtime-config-owner.js"
import type { FirstPartyModule, FirstPartyModuleSnapshot } from "../../../module-contract/module-catalog.js"
import type { SessionManager } from "../../../session/manager.js"
import type { SessionStore } from "../../../session-store/types.js"
import type { SessionAuthAdmission } from "../../../auth/session-auth-profile.js"
import type { WorkflowDeps } from "../../../agent-runtime/runner/workflow-deps.js"
import type { RecallInput, RecallResult } from "../../../../protocol/transcript/conversation-recall.js"
import type { AttachChildSessionProjection, ParentNotificationDelivery } from "../../../module-contract/module-seams.js"
import type { ChatRunner } from "../../../chat/runner-types.js"

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

/** The one activation walk of every module service composition: it
 *  constructs each enabled module that `create` places, after its
 *  dependencies, and owns their start, settlement, and disposal. */
export function composeServiceInstances(modules: readonly FirstPartyModule[], enabledModuleIds: () => readonly string[], create: (module: FirstPartyModule, services: ModuleServices, enabled: () => boolean) => ModuleServiceInstance | undefined): ComposedModuleServices {
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
