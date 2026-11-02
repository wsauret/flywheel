import type { Schema } from "effect"
import type { ChatInputLike } from "../../infra/chat-input.js"
import type { AsyncEventStateReadSurface, AsyncEventWriter, EventReader, StoredFact } from "../../infra/event-store-types.js"
import type { ModuleServices } from "../../infra/module-service.js"
import type { ProtocolBackgroundDomain, ProtocolBackgroundSnapshot, ProtocolModuleMutation, ProtocolModuleMutationResult, ProtocolModuleMutationType, ProtocolModuleQuery, ProtocolModuleQueryResult, ProtocolModuleQueryType, ProtocolRegistryModule } from "../../protocol/modules.js"
import type { BackgroundSnapshotOf, ProtocolDomainQuery, ProtocolDomainSnapshot, ProtocolModule, ProtocolMutationOf, ProtocolMutationRequest, ProtocolMutationResult, ProtocolQueryOf, ProtocolQueryRequest, ProtocolQueryResult } from "../../protocol/protocol-module.js"
import type { RuntimeUiPatch, RuntimeUiPatchInput } from "../../protocol/runtime-ui-protocol-types.js"
import type { RuntimeUiPatchSequencer } from "./runtime-ui-patch-sequencer.js"
import type { ProjectDefinitionRegistry } from "../../workflows/definition-registry.js"
import type { FirstPartyModule } from "../modules.js"
import type { SessionStore } from "../session-store/types.js"
import type { SessionManager } from "../session/manager.js"
import type { SessionKind } from "../session/types.js"
import type { ChatRunner } from "../chat/runner-types.js"

/** What the runtime hands a module that serves protocol domains: the kernel
 *  authorities its projections read and publish through, and the module
 *  services composition built. Every other field is a kernel authority; a
 *  module-owned value lives in the module's own service or runtime. */
export interface ModuleProtocolServices {
  readonly eventStore: AsyncEventStateReadSurface
  readonly projectionReader: AsyncEventStateReadSurface
  readonly eventWriter: AsyncEventWriter
  readonly manager: Pick<SessionManager, "read" | "createChatFromContext">
  readonly sessionStore: SessionStore
  /** A person's Interrupt of a session, the one Interrupt of every session
   *  (`RuntimeSupervisor.interruptSession`). Answers whether anything was
   *  interrupted. */
  readonly interruptSession: (sessionId: string) => Promise<boolean>
  /** The project's definition registry, the same one every runner reads. */
  readonly definitions: ProjectDefinitionRegistry
  /** The store's post-commit broadcast. */
  readonly onStored: (listener: (facts: readonly StoredFact[]) => void) => () => void
  readonly publish: (input: RuntimeUiPatchInput) => RuntimeUiPatch | undefined
  readonly snapshotPosition: RuntimeUiPatchSequencer["snapshotPosition"]
  readonly hasLiveSession: (sessionId: string) => boolean
  /** Attaches a chat session's runner, idle, activating the session first
   *  when no client holds it open (ARCH-SESSIONS-038); undefined when the session cannot
   *  be activated. Module work that continues under a parent session, such as
   *  a child's resume, runs through the parent's runner. */
  readonly openChatRunner?: (sessionId: string) => Promise<ChatRunner | undefined>
  /** Durable history for a session that is not live, read on the background
   *  Worker through the module's own background reader. */
  readonly background: <Domain extends ProtocolBackgroundDomain>(domain: Domain, sessionId: string) => Promise<ProtocolBackgroundSnapshot<Domain>>
  /** The process-scoped module services; a module reads its own through its handle. */
  readonly modules: ModuleServices
  /** Whether this module is in the live selection. A module whose views must
   *  vanish when it is turned off answers empty and refuses its mutations while
   *  this is false; one that renders durable history serves regardless (ARCH-RUNTIME-068, ARCH-STRUCTURE-029). */
  readonly enabled: () => boolean
}

/** Account module protocols read their service and publish through account UI sequencing. */
export type AccountModuleProtocolServices = Pick<ModuleProtocolServices, "modules" | "enabled" | "publish" | "snapshotPosition">

type DomainsOf<M extends ProtocolModule> = M["domains"][number]
type SnapshotsOf<M extends ProtocolModule> = ProtocolDomainQuery<DomainsOf<M>>
type QueriesOf<M extends ProtocolModule> = ProtocolQueryOf<readonly [M]>
type MutationsOf<M extends ProtocolModule> = ProtocolMutationOf<readonly [M]>
type BackgroundDomainsOf<M extends ProtocolModule> = Extract<DomainsOf<M>, { readonly snapshot: { readonly background: Schema.Top } }>

/** One server per read the module's contract declares: each domain's
 *  snapshot query and each module query. A declared read without a server is
 *  a compile error, which is what makes a domain complete only when its
 *  module can answer it. */
type ModuleQueryServers<M extends ProtocolModule> =
  & { readonly [Type in SnapshotsOf<M>["type"]]: (query: Extract<SnapshotsOf<M>, { readonly type: Type }>) => Promise<ProtocolDomainSnapshot<Extract<DomainsOf<M>, { readonly snapshot: { readonly query: Type } }>>> }
  & { readonly [Type in QueriesOf<M>["query"]]: (query: Extract<ProtocolQueryRequest<QueriesOf<M>>, { readonly type: Type }>) => Promise<ProtocolQueryResult<Extract<QueriesOf<M>, { readonly query: Type }>>> }

/** One handler per mutation the module's contract declares. */
type ModuleMutationServers<M extends ProtocolModule> = {
  readonly [Type in MutationsOf<M>["type"]]: (mutation: Extract<ProtocolMutationRequest<MutationsOf<M>>, { readonly type: Type }>) => Promise<ProtocolMutationResult<Extract<MutationsOf<M>, { readonly type: Type }>>>
}

/** The kinds of session a module can own: every kind but the kernel's chat. */
type ModuleSessionKind = Exclude<SessionKind, "chat">

/** How a module answers a person's message to one of its sessions. */
type SessionSendAnswer = { readonly ok: true; readonly confirmedSubmissionIds?: readonly string[]; readonly inTranscript?: boolean } | { readonly ok: false; readonly error: string; readonly kind?: "handing_off" }

/** A person's message to a session of the kind this module owns: the kernel
 *  mutation `session.send` routes here by the kind of the session. The
 *  module delivers through the kernel delivery operation and starts the work
 *  of an interrupted session again (PI-INTERACTION-050). */
interface ModuleSessionSend {
  readonly kind: ModuleSessionKind
  send(sessionId: string, input: ChatInputLike): Promise<SessionSendAnswer>
}

/** The live half: constructed once per runtime composition, answers the
 *  module's reads and mutations and publishes its patches until disposed. A
 *  module without mutations states an empty `mutate`, so a declared mutation
 *  without a handler is a compile error the same way a read is. */
export interface ModuleProtocolRuntime<M extends ProtocolModule> {
  readonly serve: ModuleQueryServers<M>
  readonly mutate: ModuleMutationServers<M>
  /** The message handler of the kind of session this module owns, if any. */
  readonly send?: ModuleSessionSend
  dispose(): void
}

/** The durable half: one reader per domain that declares a background codec,
 *  constructed on the read-only background Worker where no session is live. */
export type ModuleBackgroundReaders<M extends ProtocolModule> = {
  readonly [Name in BackgroundDomainsOf<M>["domain"]]: (sessionId: string) => Promise<BackgroundSnapshotOf<ProtocolDomainSnapshot<Extract<BackgroundDomainsOf<M>, { readonly domain: Name }>>>>
}

type ModuleProtocolDeclaration<M extends ProtocolRegistryModule, Services> =
  & {
    readonly contract: M
    readonly create: (services: Services) => ModuleProtocolRuntime<M>
  }
  & ([BackgroundDomainsOf<M>] extends [never]
    ? { readonly background?: undefined }
    : { readonly background: (reader: EventReader, context: { readonly projectRoot: string }) => ModuleBackgroundReaders<M> })

/** Any module read the registry declares, any mutation answer, and any background answer. */
type ModuleReadAnswer = ProtocolModuleQueryResult<ProtocolModuleQueryType>
type ModuleMutationAnswer = ProtocolModuleMutationResult<ProtocolModuleMutationType>
type ModuleBackgroundAnswer = ProtocolBackgroundSnapshot<ProtocolBackgroundDomain>

/** The declaration as composition reads it, with the per-query, per-mutation,
 *  and per-domain keys erased: composition routes by discriminant and never
 *  names a module. */
export interface ModuleProtocolContribution<Services = ModuleProtocolServices> {
  readonly contract: ProtocolModule
  readonly create: (services: Services) => {
    readonly serve: { readonly [query: string]: (query: never) => Promise<ModuleReadAnswer> }
    readonly mutate: { readonly [type: string]: (mutation: never) => Promise<ModuleMutationAnswer> }
    readonly send?: ModuleSessionSend
    dispose(): void
  }
  readonly background?: (reader: EventReader, context: { readonly projectRoot: string }) => { readonly [domain: string]: (ownerId: string) => Promise<ModuleBackgroundAnswer> }
}

/** Types a module's protocol declaration against its own contract, which must
 *  be in the registry, so the servers, handlers, and readers it writes are
 *  checked read by read, mutation by mutation, and domain by domain, and
 *  hands composition the erased contribution. */
export function moduleProtocol<M extends ProtocolRegistryModule, Services = ModuleProtocolServices>(declaration: ModuleProtocolDeclaration<M, Services>): ModuleProtocolContribution<Services> {
  return declaration
}

export interface ModuleProtocolRoutes {
  serve<Q extends ProtocolModuleQuery>(query: Q): Promise<ProtocolModuleQueryResult<Q["type"]>>
  mutate<C extends ProtocolModuleMutation>(mutation: C): Promise<ProtocolModuleMutationResult<C["type"]>>
  /** A person's message to a session whose kind a module owns. */
  send(kind: ModuleSessionKind, sessionId: string, input: ChatInputLike): Promise<SessionSendAnswer>
  dispose(): void
}

export interface AccountModuleProtocolRoutes extends ModuleProtocolRoutes {
  /** Tests the registered discriminant without constructing an execution request.
   *  A request this account instance owns is, by registration, a module query or mutation. */
  owns<R extends { readonly type: string }>(request: R): request is R & (ProtocolModuleQuery | ProtocolModuleMutation)
}

/** Constructs the protocol runtime of every installed module that declares
 *  one and routes each module read and mutation to the handler registered
 *  under its discriminant. Installed, not enabled: a disabled module keeps its
 *  durable history readable (ARCH-STRUCTURE-029), so its domains stay served. */
export function composeModuleProtocolRuntimes(modules: readonly FirstPartyModule[], services: Omit<ModuleProtocolServices, "enabled">, enabledModuleIds: () => readonly string[], accountAttached = false): ModuleProtocolRoutes {
  const runtimes = modules.flatMap((module) => module.host !== "account" && !(accountAttached && module.host === "control") && module.protocol && module.availability.kind === "available"
    ? [module.protocol.create({ ...services, enabled: () => enabledModuleIds().includes(module.id) })]
    : [])
  return protocolRoutes(runtimes)
}

/** Account queries and mutations share the same account-side service instance. */
export function composeAccountModuleProtocolRuntimes(modules: readonly FirstPartyModule[], services: Omit<AccountModuleProtocolServices, "enabled">, enabledModuleIds: () => readonly string[]): AccountModuleProtocolRoutes {
  return protocolRoutes(modules.flatMap((module) => (module.host === "account" || module.host === "control") && module.protocol && module.availability.kind === "available"
    ? [module.protocol.create({ ...services, enabled: () => enabledModuleIds().includes(module.id) })]
    : []))
}

function protocolRoutes(runtimes: readonly ReturnType<ModuleProtocolContribution["create"]>[]): AccountModuleProtocolRoutes {
  const servers = new Map(runtimes.flatMap((runtime) => Object.entries(runtime.serve)))
  const handlers = new Map(runtimes.flatMap((runtime) => Object.entries(runtime.mutate)))
  const senders = new Map(runtimes.flatMap((runtime) => runtime.send ? [[runtime.send.kind, runtime.send] as const] : []))
  return {
    owns<R extends { readonly type: string }>(request: R): request is R & (ProtocolModuleQuery | ProtocolModuleMutation) {
      return servers.has(request.type) || handlers.has(request.type)
    },
    serve(query) {
      const serve = servers.get(query.type)
      if (!serve) throw new Error(`No installed module serves ${query.type}`)
      // SAFETY: the server registered under `query.type` is the one its module declared for exactly that read, so it accepts this query and answers that read's declared result; the map erases both.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: registry lookup by query discriminant
      return serve(query as never) as Promise<ProtocolModuleQueryResult<(typeof query)["type"]>>
    },
    mutate(mutation) {
      const handle = handlers.get(mutation.type)
      if (!handle) throw new Error(`No installed module handles ${mutation.type}`)
      // SAFETY: the handler registered under `mutation.type` is the one its module declared for exactly that mutation, so it accepts this request and answers that mutation's declared result; the map erases both.
      // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: registry lookup by mutation type
      return handle(mutation as never) as Promise<ProtocolModuleMutationResult<(typeof mutation)["type"]>>
    },
    async send(kind, sessionId, input) {
      const sender = senders.get(kind)
      return sender ? sender.send(sessionId, input) : { ok: false, error: `No installed module takes messages for a ${kind}` }
    },
    dispose() {
      for (const runtime of runtimes) runtime.dispose()
    },
  }
}

/** The background Worker's lookup: the durable reader every installed module
 *  declares for a domain, keyed by domain name. */
export function composeModuleBackgroundReaders(modules: readonly FirstPartyModule[], reader: EventReader, context: { readonly projectRoot: string }): (domain: ProtocolBackgroundDomain, sessionId: string) => Promise<ModuleBackgroundAnswer> {
  const readers = new Map(modules.flatMap((module) => module.protocol?.background && module.availability.kind === "available" ? Object.entries(module.protocol.background(reader, context)) : []))
  return (domain, sessionId) => {
    const read = readers.get(domain)
    if (!read) throw new Error(`No installed module serves the ${domain} domain from durable history`)
    return read(sessionId)
  }
}
