import { remoteProtocol } from "./modules/remote.js"
import { bugReportsProtocol } from "./modules/bug-reports.js"
import { sideQuestionProtocol } from "./modules/side-question.js"
import { subscriptionUsageProtocol } from "./modules/subscription-usage.js"
import type { ModuleId } from "./module-ids.js"
import type { Schema } from "effect"
import { definitionOverridesProtocol } from "./modules/definition-overrides.js"
import { experimentsProtocol } from "./modules/experiments.js"
import { mcpProtocol } from "./modules/mcp.js"
import { papercutsProtocol } from "./modules/papercuts.js"
import { projectNotificationsProtocol } from "./modules/project-notifications.js"
import { subagentsProtocol } from "./modules/subagents.js"
import { workflowsProtocol } from "./modules/workflows.js"
import {
  protocolBackgroundDomains,
  protocolDomainNames,
  protocolDomains,
  protocolModuleRows,
  protocolModuleComposerStatus,
  type ModuleComposerStatus,
  protocolMutations,
  protocolMutationSchema,
  protocolReads,
  protocolReadSchema,
  type BackgroundSnapshotOf,
  type DomainReader,
  type ModuleRow,
  type ModuleRowSlot,
  type ProtocolDomainOf,
  type ProtocolDomainPatch,
  type ProtocolDomainQuery,
  type ProtocolDomainSnapshot,
  type ProtocolDomainView,
  type ProtocolModule,
  type ProtocolMutationOf,
  type ProtocolMutationRequest,
  type ProtocolMutationResult,
  type ProtocolQueryOf,
  type ProtocolQueryRequest,
  type ProtocolQueryResult,
} from "./protocol-module.js"

/** The one registry of module runtime UI contracts in the protocol layer. The
 *  cursor schemas, delivery policies, query, mutation, and patch unions,
 *  result codecs, deadline and call-policy tiers, client intake bindings,
 *  editor coverage, and the client slot rows all compose from it, so a
 *  module declares a domain, a query, or a mutation once, in its protocol home.
 *
 *  Its value-import closure is pure schema: the module homes name no
 *  orchestration path and reach no Bun API, which is what lets a Node-hosted
 *  editor extension and a browser hold the whole contract (ARCH-PROTOCOL-033). */
export const PROTOCOL_MODULES = [bugReportsProtocol, definitionOverridesProtocol, experimentsProtocol, mcpProtocol, papercutsProtocol, projectNotificationsProtocol, remoteProtocol, sideQuestionProtocol, subagentsProtocol, subscriptionUsageProtocol, workflowsProtocol] as const satisfies readonly ProtocolModule[]

/** A contract the registry holds; the runtime serves no other. */
export type ProtocolRegistryModule = (typeof PROTOCOL_MODULES)[number]
export type ProtocolModuleDomain = ProtocolDomainOf<typeof PROTOCOL_MODULES>
export type ProtocolModuleDomainName = ProtocolModuleDomain["domain"]
export type ProtocolModuleEntry<Name extends ProtocolModuleDomainName> = Extract<ProtocolModuleDomain, { readonly domain: Name }>
export type ProtocolModuleSessionDomain = Extract<ProtocolModuleDomain, { readonly scope: "session" }>["domain"]
export type ProtocolModuleWorkspaceDomain = Extract<ProtocolModuleDomain, { readonly scope: "workspace" }>["domain"]
export type ProtocolModuleWorkflowDomain = Extract<ProtocolModuleDomain, { readonly scope: "workflow" }>["domain"]
type ProtocolModuleQueryDeclaration = ProtocolQueryOf<typeof PROTOCOL_MODULES>
type ProtocolModuleMutationDeclaration = ProtocolMutationOf<typeof PROTOCOL_MODULES>
/** Every read a module answers: each domain's snapshot and each module query. */
export type ProtocolModuleQuery = ProtocolDomainQuery<ProtocolModuleDomain> | ProtocolQueryRequest<ProtocolModuleQueryDeclaration>
export type ProtocolModuleQueryType = ProtocolModuleQuery["type"]
export type ProtocolModuleQueryResult<Type extends ProtocolModuleQueryType> =
  Type extends ProtocolModuleDomain["snapshot"]["query"] ? ProtocolDomainSnapshot<Extract<ProtocolModuleDomain, { readonly snapshot: { readonly query: Type } }>>
    : ProtocolQueryResult<Extract<ProtocolModuleQueryDeclaration, { readonly query: Type }>>
export type ProtocolModuleMutation = ProtocolMutationRequest<ProtocolModuleMutationDeclaration>
export type ProtocolModuleMutationType = ProtocolModuleMutation["type"]
export type ProtocolModuleMutationResult<Type extends ProtocolModuleMutationType> = ProtocolMutationResult<Extract<ProtocolModuleMutationDeclaration, { readonly type: Type }>>
export type ProtocolModulePatchPayload = ProtocolDomainPatch<ProtocolModuleDomain>
export type ProtocolModuleView<Domain extends ProtocolModuleDomainName> = ProtocolDomainView<ProtocolModuleEntry<Domain>>
export type ProtocolBackgroundDomain = Extract<ProtocolModuleDomain, { readonly snapshot: { readonly background: Schema.Top } }>["domain"]
export type ProtocolBackgroundSnapshot<Domain extends ProtocolBackgroundDomain> = BackgroundSnapshotOf<ProtocolDomainSnapshot<ProtocolModuleEntry<Domain>>>

export const PROTOCOL_MODULE_DOMAINS = protocolDomains(PROTOCOL_MODULES)
export const PROTOCOL_MODULE_SESSION_DOMAINS = protocolDomainNames(PROTOCOL_MODULE_DOMAINS, "session")
export const PROTOCOL_MODULE_WORKSPACE_DOMAINS = protocolDomainNames(PROTOCOL_MODULE_DOMAINS, "workspace")
export const PROTOCOL_MODULE_WORKFLOW_DOMAINS = protocolDomainNames(PROTOCOL_MODULE_DOMAINS, "workflow")
/** Every read the registry answers, keyed by discriminant in every read table. */
export const PROTOCOL_MODULE_READS = protocolReads(PROTOCOL_MODULES)
export const PROTOCOL_MODULE_MUTATIONS = protocolMutations(PROTOCOL_MODULES)
const BACKGROUND_DOMAINS = protocolBackgroundDomains(PROTOCOL_MODULE_DOMAINS)
export const PROTOCOL_BACKGROUND_DOMAINS: readonly ProtocolBackgroundDomain[] = BACKGROUND_DOMAINS.map((domain) => domain.domain)

const DOMAINS_BY_NAME: ReadonlyMap<string, ProtocolModuleDomain> = new Map(PROTOCOL_MODULE_DOMAINS.map((domain) => [domain.domain, domain]))
const READS_BY_QUERY: ReadonlySet<string> = new Set(PROTOCOL_MODULE_READS.map((read) => read.query))
const MUTATIONS_BY_TYPE: ReadonlyMap<string, ProtocolModuleMutationDeclaration> = new Map(PROTOCOL_MODULE_MUTATIONS.map((mutation) => [mutation.type, mutation]))

export function isProtocolModuleDomain(domain: string): domain is ProtocolModuleDomainName {
  return DOMAINS_BY_NAME.has(domain)
}

export function isProtocolModuleQuery(query: { readonly type: string }): query is ProtocolModuleQuery {
  return READS_BY_QUERY.has(query.type)
}

export function isProtocolModuleMutation(mutation: { readonly type: string }): mutation is ProtocolModuleMutation {
  return MUTATIONS_BY_TYPE.has(mutation.type)
}

/** A refused mutation keeps the result shape its module declares. */
export function moduleMutationRefusal(mutation: { readonly type: string }, message: string): ProtocolMutationResult<ProtocolModuleMutationDeclaration> | undefined {
  return MUTATIONS_BY_TYPE.get(mutation.type)?.refuse?.(message)
}

/** The wire codecs of every module read and mutation, typed by the unions the registry derives. */
export const PROTOCOL_MODULE_QUERY_SCHEMAS: readonly Schema.Codec<ProtocolModuleQuery>[] = PROTOCOL_MODULE_READS.map((read) => protocolReadSchema<ProtocolModuleQuery>(read))
export const PROTOCOL_MODULE_MUTATION_SCHEMAS: readonly Schema.Codec<ProtocolModuleMutation>[] = PROTOCOL_MODULE_MUTATIONS.map((mutation) => protocolMutationSchema<ProtocolModuleMutation>(mutation))

export function protocolDomain(domain: ProtocolModuleDomainName): ProtocolModuleDomain {
  const found = DOMAINS_BY_NAME.get(domain)
  if (!found) throw new Error(`No protocol module declares the ${domain} domain`)
  return found
}

/** The codec the background Worker's answer for `domain` decodes with. */
export function protocolBackgroundSchema<Domain extends ProtocolBackgroundDomain>(domain: Domain): Schema.Codec<ProtocolBackgroundSnapshot<Domain>> {
  const found = BACKGROUND_DOMAINS.find((candidate) => candidate.domain === domain)
  if (!found) throw new Error(`The ${domain} domain declares no background snapshot`)
  // SAFETY: the entry found under `domain` declared this codec, and `ProtocolBackgroundSnapshot` is that entry's declared background type; the search erases the per-domain correlation.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: registry lookup by domain name
  const erased: Schema.Codec<unknown> = found.snapshot.background
  // SAFETY: the domain lookup above selected this codec; the registry erases its domain/type correlation.
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: registry correlation is erased by the domain lookup
  return erased as Schema.Codec<ProtocolBackgroundSnapshot<Domain>>
}

/** The rows every registered module contributes to one client slot, in
 *  registry order, read through the client's own views. */
export function moduleRows(slot: ModuleRowSlot, read: DomainReader, enabled?: readonly ModuleId[]): readonly ModuleRow[] {
  return protocolModuleRows(PROTOCOL_MODULES, slot, read, enabled)
}

/** The snapshot query of one domain. A session-scoped domain needs the session id. */
export function protocolModuleQuery(domain: ProtocolModuleDomain, ownerId: string | undefined): ProtocolDomainQuery<ProtocolModuleDomain> {
  if (domain.scope === "workspace") return { type: domain.snapshot.query }
  if (ownerId === undefined) throw new Error(`The ${domain.domain} domain requires its ${domain.scope} id`)
  return domain.scope === "workflow" ? { type: domain.snapshot.query, workflowId: ownerId } : { type: domain.snapshot.query, sessionId: ownerId }
}

/** Declarative composer labels after the kernel's connection reading. */
export function moduleComposerStatus(read: DomainReader, enabled?: readonly ModuleId[], surface: "terminal" | "webview" = "terminal"): readonly ModuleComposerStatus[] {
  return protocolModuleComposerStatus(PROTOCOL_MODULES, read, enabled, surface)
}

/** Resolves one host integration to its declared module command. A missing or
 *  duplicate key is a catalog defect; runtime selection still owns admission. */
export function moduleHostCommand(key: string, modules: readonly ProtocolModule[] = PROTOCOL_MODULES): string {
  const matches = modules.flatMap((module) => module.hostCommands ?? []).filter((entry) => entry.key === key)
  const match = matches[0]
  if (matches.length !== 1 || !match) throw new Error(`Host command '${key}' requires one module declaration, found ${matches.length}`)
  return match.commandId
}
