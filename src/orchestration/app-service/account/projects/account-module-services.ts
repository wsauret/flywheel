import type { Schema } from "effect"
import type { ProjectStorage } from "./project-storage.js"
import type { LauncherContext } from "../../../../infra/process-supervisor.js"
import type { AsyncEventStateReadSurface } from "../../../../infra/store/event-store-types.js"
import { errorMessage } from "../../../../infra/error-message.js"
import type { AccountModuleRequest } from "../../../../protocol/runtime/account-attach.js"
import type { FirstPartyModule, FirstPartyModuleComposition } from "../../../module-contract/module-catalog.js"
import { composeServiceInstances, type ComposedModuleServices, type ModuleProcessServices } from "../../executor/execution/module-service-host.js"
import type { RuntimeFaultReporter } from "../../executor/runtime-fault-reporting.js"
import type { AccountProjectClone } from "../account-project-clone.js"
import type { AccountProjectRegistry } from "../account-project-registry.js"
import type { AccountService } from "../account-service.js"
import type { SettledControlUiAssetState } from "../web-serving/control-ui-assets.js"

/** Account-side project ports. Notifications cross to their owning authority;
 * no session store, runner, auth runtime, or writable database is available. */
export type AccountProjectModuleServices = Pick<ModuleProcessServices,
  "transports" | "onFrontendEvent" | "onSelectionChanged" | "notify" |
  "directories" | "publish" | "snapshotPosition" | "launcher" | "modules" | "enabled" | "eventWriter" | "onStored" | "projectionReader"> & {
    readonly eventStore: AsyncEventStateReadSurface
    /** The project's store usage and its Reclaim storage command (ARCH-RUNTIME-083). */
    readonly storage: ProjectStorage
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

export type AccountModuleRequestServer = (request: AccountModuleRequest, answer: (payload: Schema.Json) => Promise<void>, withdrawn: AbortSignal) => Promise<void>

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
    async serveRequest(module: string, request: AccountModuleRequest, answer: (payload: Schema.Json) => Promise<void>, withdrawn: AbortSignal): Promise<void> {
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

/** State-backed control services run in the account when attached, or in
 *  the standalone host, such as a headless run, where the account's ports,
 *  such as `storage`, are absent. */
export type ControlModuleServices = Pick<ModuleProcessServices, "projectionReader" | "eventWriter" | "onStored" | "publish" | "notify"> & Partial<Pick<AccountProjectModuleServices, "storage">>

/** Constructs only account-placed services from the installed module catalog. */
export function composeAccountProjectModuleServices(modules: readonly FirstPartyModule[], enabledModuleIds: () => readonly string[], kernel: Omit<AccountProjectModuleServices, "modules" | "enabled">): ComposedModuleServices {
  return composeServiceInstances(modules, enabledModuleIds, (module, services, enabled) =>
    module.host === "account" || module.host === "control" ? module.service?.create({ ...kernel, modules: services, enabled }) : undefined)
}
