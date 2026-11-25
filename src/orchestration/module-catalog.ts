import { createModuleCatalogSlot, type ModuleComposition, type ModuleDescriptor } from "../infra/module-descriptor.js"
import type { DefinitionBundle } from "../workflows/definitions/loader.js"
import type { AnyFactSchema } from "../infra/event-registry.js"
import type { AsyncEventReadSurface, AsyncEventStateReadSurface } from "../infra/store/event-store-types.js"
import type { WorkflowRunReader, WorkflowRunWriter } from "./session/metadata/workflow-run-record.js"
import type { SessionManager } from "./session/manager.js"
import { errorMessage } from "../infra/error-message.js"
import { MODULE_IDS, type ModuleId as WireModuleId } from "../protocol/runtime/module-ids.js"
import type { RetiredServiceInstallation } from "./app-service/account/installation/account-service-platform.js"
import type { ModuleRuntimeHandle, ModuleRuntimes } from "../infra/module-runtime.js"
import type { ChatModuleHostContribution } from "./chat/chat-module-host.js"
import type { TerminalRemoteContribution } from "./terminal-remote.js"
import type { ModuleServiceHandle, ModuleServices } from "../infra/module-service.js"
import type { NotificationEpisodeInput } from "../infra/notification-episode.js"
import type { ModuleProtocolRow, ModuleProviderSetting, ModuleSetting, ModuleSettingControl } from "../protocol/runtime/module-protocol-types.js"
import type { KernelToolDeps } from "./agent-runtime/tools/kernel-tool-deps.js"
import type { RuntimeTool } from "./agent-runtime/tools/types.js"
import type { ModuleRuntimeServices } from "./agent-runtime/request/module-services/module-runtime-services.js"
import type { AccessProviderDefinition } from "../infra/llm/access/access-provider.js"
import type { AuthContext, ProviderConnection } from "../infra/auth/auth-context.js"
import type { CredentialSlot, CredentialSlotClassifier } from "../infra/auth/store/auth-store-types.js"
import type { WebProviderDefinition } from "../infra/auth/web-providers.js"
import type { SubscriptionUsageReader } from "../infra/llm/usage/subscription-usage.js"
import type { WebSearchProvider, WebSearchProviderId } from "./agent-runtime/web-search/types.js"
import type { CommandMenuPosition, CommandOutcome, CommandReading, CommandSurfaceTarget } from "../protocol/commands/command-catalog-protocol-types.js"
import type { ModuleHealthCheck } from "./app-service/definitions/commands/module-health.js"
import type { CliNounContribution } from "./cli-contribution.js"
import type { CommandHost } from "./app-service/definitions/commands/command-host.js"
import type { AccountModuleProtocolServices, ModuleProtocolContribution } from "./app-service/module-protocol-host.js"
import type { AccountModuleService, AccountModuleServiceInputs, AccountModuleServiceOptions, AccountProjectModuleServices, ModuleProcessServices, ModuleServiceInstance, PortableModuleServices } from "./app-service/executor/execution/module-service-host.js"
import type { ModuleConfigSection } from "./config/schema/config-section.js"
import type { AuthProviderStatus } from "../protocol/auth/auth-status-protocol-types.js"
import type { DefinitionContribution, DefinitionReconciliationInput, ToolDeclaration, ModuleChildSessionHistory, ModuleDefinitionReconciliation, ModuleMaintenance, ModuleMaintenanceInput, ManagedPackageWrites, MemoryContribution, ModuleChatObserver, ModuleChatObserverContext, ModuleRetainedOperationContribution, ModuleSessionHistory, ModuleSessionAdmission, ModuleSessionDeletion, ModuleChildSession, QuestionDecisionContribution, SessionHistoryRecoveryInput, SkillChildGrantContribution, SupersededFactInvalidationResult, WorkspaceMigration, ModuleRuntimeInvocationTool } from "./module-seams.js"
import type { ModuleRetainedDiagnostics } from "./module-diagnostics.js"
import type { ModuleAgentTasks } from "./module-agent-tasks.js"
import type { ToolExecutionGate } from "./agent-runtime/tools/dispatch/tool-dispatch.js"
import type { CapabilityCheck } from "../infra/capability-text.js"
import type { TurnReminderStatement, TurnReminderText } from "./agent-runtime/request/prompt/turn-reminders.js"

/** What every installed module declares for its durable history. The catalog
 *  reads it whether or not a project enables the module, because history that
 *  a disabled module wrote still replays. */
export interface InstalledModuleHistory {
  /** The type prefixes of the durable fact families this module owns. The
   *  retention registry names the owner per family; the prefixes are the
   *  module's namespace claim, and `bun run lint:fact-retention` fails a family
   *  the registry gives this module that carries none of them (ARCH-STRUCTURE-023). */
  readonly facts?: {
    readonly prefixes: readonly string[]
    readonly sessionSchemas?: () => readonly AnyFactSchema[]
    readonly invalidateSuperseded?: (dbPath: string) => SupersededFactInvalidationResult
  }
  /** Fact types that delete a session's conversation without a
   *  `session.deleted` fact, so a derived transcript index drops that
   *  session's rows. */
  readonly conversationDeletionFacts?: readonly string[]
  readonly runtimeInvocationTool?: ModuleRuntimeInvocationTool
}

// The catalog has two halves, and each registry publishes its own tuple into
// this light authority when it loads. The credential provider registry lists
// every module that claims a credential provider id; the module registry lists
// every other module and composes both. A login reads only the first half, so
// it never loads a tool. Catalog consumers never import a registry back, and an
// entry can install its lazy override of either half before any catalog read.
const credentialProviderSlot = createModuleCatalogSlot<FirstPartyModule>()
const otherModuleSlot = createModuleCatalogSlot<FirstPartyModule>()

/** Replaces one or both halves of the catalog every composition in this
 *  process reads. Only a source or test entry calls it: the source entry adds
 *  the development catalog to the other modules, and a test or bench entry
 *  replaces a credential provider. A release runs the shipped halves alone. */
export function installModuleCatalog(loaders: {
  readonly credentialProviders?: () => readonly FirstPartyModule[]
  readonly otherModules?: () => readonly FirstPartyModule[]
}): void {
  if (loaders.credentialProviders) credentialProviderSlot.install(loaders.credentialProviders)
  if (loaders.otherModules) otherModuleSlot.install(loaders.otherModules)
}

/** The credential provider registry publishes its shipped tuple after its
 *  descriptors load. Publication leaves an override and the read lock unchanged. */
export const publishShippedCredentialProviders: (modules: readonly FirstPartyModule[]) => void = credentialProviderSlot.publish

/** The module registry publishes its shipped tuple of every other module. */
export const publishShippedOtherModules: (modules: readonly FirstPartyModule[]) => void = otherModuleSlot.publish

let customProviders: (() => readonly FirstPartyModule[]) | undefined

/** The credential provider registry publishes, beside its shipped tuple, how
 *  it materializes one module per `[custom_providers]` entry. */
export function publishCustomProviderModules(materialize: () => readonly FirstPartyModule[]): void {
  if (customProviders) throw new Error("The custom provider modules are already published")
  customProviders = materialize
}

/** One module per `[custom_providers]` entry of the loaded config. They join
 *  the credential provider half, so a read of them reads that half first,
 *  which lets an installed loader publish them. */
export function installedCustomProviderModules(): readonly FirstPartyModule[] {
  installedCredentialProviderModules()
  if (!customProviders) throw new Error("The credential provider registry has not initialized this realm")
  return customProviders()
}

/** The module ids that the decoding of a stated module selection converts
 *  (`config/module-descriptor.ts`). The module registry states them, because
 *  only a registry names a module id (`bun run lint:module-containment`). */
export interface ModuleSelectionVocabulary {
  /** The module whose selection is the Workflows mode. */
  readonly workflowsModuleId: ModuleId
  /** Retired module-id spellings and their canonical ids. */
  readonly retiredSpellings: ReadonlyMap<string, ModuleId>
  /** The token of each module that the retired `features` selection named. */
  readonly legacyFeatureTokens: ReadonlyMap<ModuleId, string>
  /** Retired aggregate ids of the retired `modules` snapshot and the modules each stood for. */
  readonly retiredExpansions: ReadonlyMap<string, readonly ModuleId[]>
  /** Modules shipped after the retired `modules` snapshot, which it cannot turn off. */
  readonly enabledSinceModulesSnapshot: readonly ModuleId[]
  /** The opt-in modules that the retired `enabled_modules` list could name. */
  readonly retiredOptInModuleIds: ReadonlySet<string>
}

let selectionVocabulary: ModuleSelectionVocabulary | undefined

export function publishModuleSelectionVocabulary(vocabulary: ModuleSelectionVocabulary): void {
  if (selectionVocabulary) throw new Error("The module selection vocabulary is already published")
  selectionVocabulary = vocabulary
}

export function moduleSelectionVocabulary(): ModuleSelectionVocabulary {
  // The read lets an installed loader load the module registry, which publishes.
  if (!selectionVocabulary) installedModules()
  if (!selectionVocabulary) throw new Error("The module registry has not initialized this realm")
  return selectionVocabulary
}

/** The catalog every release ships: the tuples both registries published,
 *  without what a source or test entry installed over them. */
export function shippedModules(): readonly FirstPartyModule[] {
  // The read lets an installed loader load the registries, which publish.
  installedModules()
  const credentialProviders = credentialProviderSlot.shipped()
  const others = otherModuleSlot.shipped()
  if (!credentialProviders || !others) throw new Error("The module registries have not published the shipped catalog in this realm")
  return [...credentialProviders, ...others]
}

/** The definition bundles every release ships: the build embeds them, and the
 *  bundled-default catalog holds their packages, so an override of one still
 *  diffs. A source run loads the development bundle too, but never ships it. */
export function shippedDefinitionBundles(): readonly DefinitionBundle[] {
  return installedDefinitionBundles(shippedModules())
}

/** Every installed module that claims a credential provider id, whether or not
 *  a project enables it. Reading it loads no other module. Missing bootstrap is
 *  an ownership error; a reader never substitutes an empty vocabulary. */
export function installedCredentialProviderModules(): readonly FirstPartyModule[] {
  const installed = credentialProviderSlot.installed()
  if (!installed) throw new Error("The credential provider registry has not initialized this realm")
  const silent = installed.find((module) => !claimsCredentialProvider(module))
  if (silent) throw new Error(`Credential provider module ${silent.id} claims no credential provider id`)
  return installed
}

let catalog: readonly FirstPartyModule[] | undefined

/** Read the whole catalog initialized by this realm's composition: one frozen
 *  value for the process, because every composition cache keys on it. Missing
 *  bootstrap is an ownership error; a session writer never substitutes an
 *  empty registry. */
export function installedModules(): readonly FirstPartyModule[] {
  if (catalog) return catalog
  // The other half first. Each registry publishes its own half when it
  // loads; a process entry loads both (`importComposing`), and the test
  // preload installs lazy loaders for both.
  const others = otherModuleSlot.installed()
  if (!others) throw new Error("The module registry has not initialized this realm")
  const claimant = others.find(claimsCredentialProvider)
  if (claimant) throw new Error(`Module ${claimant.id} claims a credential provider id outside the credential provider registry`)
  catalog = Object.freeze([...installedCredentialProviderModules(), ...others])
  return catalog
}

/** Reads retained runs from the installed catalog, independent of admission. */
export function workflowRunReader(reader: AsyncEventStateReadSurface): WorkflowRunReader {
  return workflowRunOwner().create(reader)
}

/** Where the retained workflows of `reader` sit in the session tree, independent of admission. */
export function workflowPlacements(reader: AsyncEventReadSurface): import("./module-seams.js").WorkflowPlacements {
  return workflowRunOwner().placements(reader)
}

/** Binds aggregate settings to the state authority that fences structural writes. */
export function workflowRunWriter(reader: AsyncEventStateReadSurface, commit: SessionManager["commitWorkflow"]): WorkflowRunWriter {
  return workflowRunOwner().writer(reader, commit)
}

let runOwner: import("./module-seams.js").ModuleWorkflowRuns | undefined

/** The installed workflow owner contributes run operations even while new
 *  admission is disabled. The catalog is frozen for the process, so the owner
 *  is found once: the summary replay asks for it once per fact. */
export function workflowRunOwner(): import("./module-seams.js").ModuleWorkflowRuns {
  if (runOwner) return runOwner
  const owners = installedModules().flatMap((module) => module.contributions.flatMap((contribution) =>
    contribution.domain === "workflowRuns" ? [contribution.value] : []))
  if (owners.length !== 1 || !owners[0]) throw new Error("The installed catalog must contain one workflow run owner")
  runOwner = owners[0]
  return runOwner
}

/** A credential provider id names an access provider or a web auth provider. */
function claimsCredentialProvider(module: FirstPartyModule): boolean {
  return module.contributions.some((contribution) => contribution.domain === "providers" || contribution.domain === "webAuthProviders")
}


/** The tool that runtime invocations record. Exactly one installed module
 *  owns it, whether or not a project enables that module, because history
 *  that a disabled module wrote still replays. */
export function installedRuntimeInvocationTool(modules: readonly FirstPartyModule[] = installedModules()): ModuleRuntimeInvocationTool {
  const [tool, ...others] = modules.flatMap((module) => module.runtimeInvocationTool ? [module.runtimeInvocationTool] : [])
  if (!tool || others.length > 0) throw new Error(`Expected one installed runtime invocation tool, found ${others.length + (tool ? 1 : 0)}`)
  return tool
}

/** The fact types beyond `session.deleted` that delete a session's
 *  conversation, from every installed module: a disabled module's deletions
 *  are still history that the transcript index must honor. */
export function installedConversationDeletionFacts(modules: readonly FirstPartyModule[] = installedModules()): readonly string[] {
  return modules.flatMap((module) => module.conversationDeletionFacts ?? [])
}

/** Every definition bundle the installed catalog contributes, whether or not
 *  a project enables the owner: the registry loads them all, and availability
 *  hides a bundle's definitions while its owner is off. */
export function installedDefinitionBundles(modules: readonly FirstPartyModule[] = installedModules()): readonly DefinitionBundle[] {
  return modules.flatMap((module) => module.contributions.flatMap((contribution) =>
    contribution.domain === "definitions" && contribution.value.kind === "bundle" ? [{ id: contribution.id, root: contribution.value.root }] : []))
}

/** The agent types that `config` turns off, as the installed module that owns dispatch reads them: a decoded
 *  configuration, or the module sections of a request capture. Only the inputs of the availability owner read
 *  them (ARCH-STRUCTURE-044). */
export function disabledAgentTypes(config: { readonly [section: string]: unknown }, modules: readonly FirstPartyModule[] = installedModules()): readonly string[] {
  return modules.flatMap((module) => module.contributions.flatMap((contribution) =>
    contribution.domain === "definitions" && "disabledTypes" in contribution.value ? contribution.value.disabledTypes(config) : []))
}

/** Two modules cannot share a fact namespace: a prefix that is itself a
 *  prefix of another module's claim would give one family two owners. */
export function validateModuleFactPrefixes(modules: readonly FirstPartyModule[]): void {
  const claims = modules.flatMap((module) => (module.facts?.prefixes ?? []).map((prefix) => ({ prefix, module: module.id })))
  for (const claim of claims) {
    const overlapping = claims.find((other) => other.module !== claim.module && other.prefix.startsWith(claim.prefix))
    if (overlapping) throw new Error(`Fact prefix ${claim.prefix} is claimed by both ${claim.module} and ${overlapping.module} (${overlapping.prefix})`)
  }
}

/** The module vocabulary every orchestration type names. It is the wire
 *  vocabulary, not the registry-derived one: a descriptor's factory types
 *  reach the capability boundary, so deriving the id from the catalog would
 *  make the catalog's own type circular. The registry (`modules.ts`) proves
 *  both equal. */
export type ModuleId = WireModuleId


/** What a system prompt fragment renders from: the request's kernel facts and
 *  module runtimes, the tools it advertises, the memory bytes it carries, and
 *  the tree check of its advertised tools (ARCH-CONTEXT-033). */
interface PromptFragmentInput {
  readonly kernel: KernelToolDeps
  readonly modules: ModuleRuntimes
  readonly tools: ReadonlyMap<string, RuntimeTool>
  readonly memorySnapshot: string | null
  readonly capabilities: CapabilityCheck
}

/** A standing mode that a module states beside the person's turns: `on`
 *  when the mode starts to hold, `still` after `every` person turns, and
 *  `off` once when it stops holding. Each is a hidden
 *  system reminder in the conversation, marked with the contribution id and
 *  its statement (turn-reminders.ts). The runtime reads the contribution of a
 *  disabled module too, so `off` reaches the model after the person turns the
 *  module off. */
interface TurnReminderContribution {
  readonly on: TurnReminderText
  readonly still: TurnReminderText
  readonly off: TurnReminderText
  readonly every: number
  /** Whether the mode holds for this request; read only while the module is enabled. */
  readonly holds: (input: Pick<PromptFragmentInput, "kernel" | "tools" | "modules">) => boolean
  /** Message content of an earlier statement shape, with the statement it made. */
  readonly retired?: { readonly [content: string]: TurnReminderStatement }
}

interface PromptFragmentContribution {
  /** Position among the enabled fragments, ascending. */
  readonly order: number
  /** The fragment for this request, or undefined when it has nothing to say. */
  readonly render: (input: PromptFragmentInput) => Promise<string | undefined> | string | undefined
}

/** What the tool exposure gate reads before construction: it returns tool
 *  name to omission reason for tools the request must not advertise. */
interface ToolExposureGateInput {
  readonly kernel: KernelToolDeps
  readonly modules: ModuleRuntimes
}
export type ToolExposureGate = (input: ToolExposureGateInput) => Promise<ReadonlyMap<string, string>> | ReadonlyMap<string, string>

interface PromptRosterContribution {
  /** The module whose definitions the roster lists. */
  readonly definition: ModuleId
  readonly visibility: "model-invocable"
}

/** A set of tools that exist only inside the code projection: a module builds
 *  them per request from `{ kernel, modules }`, the planner adds them to the
 *  code catalog when code is selected, and they are admitted through the code
 *  registration. A module that owns no such tools that request returns none. */
interface CodeToolsContribution {
  readonly create: (deps: { readonly kernel: KernelToolDeps; readonly modules: ModuleRuntimes }) => readonly RuntimeTool[]
  /** The namespaces the contribution serves, known before their tools arrive. The Code Mode catalog names each one
   *  from the first request, so tools that arrive later leave the system prompt and its prompt cache unchanged. */
  readonly namespaces?: (deps: { readonly kernel: KernelToolDeps; readonly modules: ModuleRuntimes }) => readonly string[]
  /** Advances whenever `create` or `namespaces` can return a different list, so a request preparation that holds
   *  what they returned reads them again only when it changed. A contribution without it is read on every request. */
  readonly generation?: (deps: { readonly kernel: KernelToolDeps; readonly modules: ModuleRuntimes }) => number
}
export interface WebBackendContribution {
  readonly id: WebSearchProviderId
  readonly create: (options: { readonly authDir: string; readonly getAuth: () => AuthContext; readonly connection?: ProviderConnection; readonly credentialSlotClassifier: CredentialSlotClassifier }) => WebSearchProvider
}
interface FirstPartyContributionMap {
  readonly workflowRuns: import("./module-seams.js").ModuleWorkflowRuns
  readonly accountServices: AccountModuleServiceContribution
  readonly agentTasks: ModuleAgentTasks
  readonly providers:
    { readonly definition: AccessProviderDefinition; readonly createClient: import("./agent-runtime/llm/routing/client-factory.js").AccessProviderFactory; readonly usageReader?: SubscriptionUsageReader; readonly resetConsumer?: import("../infra/llm/usage/subscription-usage.js").SubscriptionUsageResetConsumer; readonly affordability?: import("./agent-runtime/llm/routing/provider-affordability.js").ProviderAffordabilityFactory; readonly allowance?: import("./agent-runtime/llm/routing/provider-availability-types.js").ProviderAllowanceFactory }
  readonly tools: { readonly kind: "tool"; readonly name: string; readonly declaration: ToolDeclaration<string>; readonly associatedPromptRosterIds?: readonly PromptRosterContribution["definition"][] }
  readonly promptFragments: PromptFragmentContribution
  readonly turnReminders: TurnReminderContribution
  readonly promptRosters: PromptRosterContribution
  readonly definitions: DefinitionContribution
  readonly memory: MemoryContribution
  readonly skillChildGrants: SkillChildGrantContribution
  readonly questionDecisions: QuestionDecisionContribution
  readonly managedPackageWrites: { readonly create: (modules: ModuleRuntimes) => ManagedPackageWrites | undefined }
  readonly chatHosts: ChatModuleHostContribution
  readonly shellOperations: { readonly background: true }
  readonly settings: ModuleSettingControl
  /** Registered model roles this module makes visible in settings. */
  readonly modelRoles: readonly string[]
  readonly commands: ModuleCommandMetadata
  readonly health: ModuleHealthCheck
  readonly webBackends: WebBackendContribution
  readonly webAuthProviders: WebProviderDefinition & Pick<AuthProviderStatus, "group">
  readonly cli: CliNounContribution
  /** A retained section of `flywheel.toml` the module owns; the contribution id is the section key. */
  readonly config: ModuleConfigSection
  readonly codeTools: CodeToolsContribution
  /** How the terminal opens a project on another machine. At most one module
   *  contributes it. */
  readonly terminalRemote: TerminalRemoteContribution
}

interface AccountModuleServiceContribution {
  /** The configuration values the service's constructor reads. Unchanged values
   * retain the live service and its resources across unrelated configuration writes. */
  readonly configuration: (config: { readonly [key: string]: unknown }) => AccountModuleServiceInputs
  create<Runtime extends { dispose(): Promise<void> }>(options: AccountModuleServiceOptions<Runtime>): AccountModuleService
  /** A service registration an earlier release of this module installed on
   *  its own; installing the account service removes it. */
  readonly retiredInstallation?: RetiredServiceInstallation
}

interface WorkflowObserverContext {
  readonly getBudgetInfo: () => Promise<{ readonly remainingCalls: number; readonly remainingTokens: number } | null>
  readonly getContextPercent: () => Promise<number>
}

type WorkflowObserverFactory = (context: WorkflowObserverContext) => import("./agent-runtime/loop/batch-observers.js").BatchObserver

interface FirstPartyObserverMap {
  readonly workflow: WorkflowObserverFactory
  readonly chat: (context: ModuleChatObserverContext) => ModuleChatObserver
  /** The notify seam: a kernel producer states a condition it observed, and the
   *  module that owns durable notifications records it. The seam hands the
   *  observer the process services so it reaches its own through its handle,
   *  and settles once the observer has, so a producer can order work after
   *  the commit; with no observer enabled the call settles at once (ARCH-STRUCTURE-040). */
  readonly notify: (episode: NotificationEpisodeInput, modules: ModuleServices) => Promise<void> | void
}
interface FirstPartyGateMap {
  readonly toolExecution: ToolExecutionGate
  readonly toolExposure: ToolExposureGate
}

/** One module's optional per-runner runtime. Composition calls `create` once
 *  per runner for each enabled module that declares one; a factory that
 *  returns undefined declines to build for that runner. The handle carries the
 *  declared instance type, so the module reads its own instance back typed
 *  and the kernel never names it. */
interface ModuleRuntimeDeclaration<Instance> {
  readonly handle: ModuleRuntimeHandle<Instance>
  /** Undefined declines to build for this runner; the module's tools then omit themselves. */
  readonly create: (services: ModuleRuntimeServices) => Instance | undefined
}

/** One module's optional process-scoped service, the sibling of `runtime`.
 *  Composition calls `create` once per process for each enabled module that
 *  declares one, in dependency order, so a module reaches another module's
 *  service through that module's exported handle after listing it as a
 *  dependency. The instance owes composition one disposal. */
interface ModuleServiceDeclaration<Instance extends ModuleServiceInstance, Services = ModuleProcessServices> {
  readonly handle: ModuleServiceHandle<Instance>
  readonly create: (services: Services) => Instance
}

/** A process service whose factory reads only the portable kernel. Every
 *  composition that builds runners can construct it, a headless run included,
 *  through the same activation walk. */
type PortableServiceDeclaration<Instance extends ModuleServiceInstance> = ModuleServiceDeclaration<Instance, PortableModuleServices> & { readonly portable: true }

export type FirstPartyModule = ModuleDescriptor<FirstPartyContributionMap, FirstPartyObserverMap, FirstPartyGateMap> & InstalledModuleHistory & {
  readonly runtime?: ModuleRuntimeDeclaration<unknown>
  readonly workspaceMigrations?: readonly WorkspaceMigration[]
  readonly definitionReconciliation?: ModuleDefinitionReconciliation
  readonly maintenance?: readonly ModuleMaintenance[]
  readonly sessionHistory?: ModuleSessionHistory
  /** Installed child-session semantics stay available for durable history even when dispatch is disabled. */
  readonly childSessionHistory?: ModuleChildSessionHistory
  readonly sessionDeletion?: ModuleSessionDeletion
  readonly childSession?: ModuleChildSession
  readonly sessionAdmission?: ModuleSessionAdmission
  /** Durable module work restored only by an explicit consuming command. */
  readonly retainedOperations?: readonly ModuleRetainedOperationContribution[]
  readonly retainedDiagnostics?: ModuleRetainedDiagnostics
  readonly headless?: { readonly order: number }
  /** The module serves a person who reads the conversation, so an unattended chat leaves it out (PI-AGENT-121). */
  readonly attended?: true
  readonly selectionPolicy?: (input: { readonly moduleIds: readonly ModuleId[]; readonly requireWorkflowConfirmation: boolean }) => string | undefined
  readonly retiredConfig?: readonly { readonly section: string; readonly key: string; readonly label: string }[]
} & (
  | {
    readonly host?: "execution"
    readonly service?: ModuleServiceDeclaration<ModuleServiceInstance> | PortableServiceDeclaration<ModuleServiceInstance>
    readonly protocol?: ModuleProtocolContribution
  }
  | {
    readonly host: "account"
    readonly service?: ModuleServiceDeclaration<ModuleServiceInstance, AccountProjectModuleServices>
    readonly protocol?: ModuleProtocolContribution<AccountModuleProtocolServices>
  }
  | {
    readonly host: "control"
    readonly service?: ModuleServiceDeclaration<ModuleServiceInstance, import("./app-service/executor/execution/module-service-host.js").ControlModuleServices>
    readonly protocol?: ModuleProtocolContribution<AccountModuleProtocolServices>
  }
)
/** One built-in command a module contributes. The descriptor fields publish
 *  through the command catalog. Either `execute` runs in the runtime
 *  composition that published them, against the kernel command host, and
 *  answers one closed outcome the client presents; or the command's whole
 *  effect is opening the client surface `opens`, which the catalog publishes
 *  so that every client opens it without asking the runtime, and so also
 *  while the runtime does not answer, at `target` inside it. */
export type ModuleCommandMetadata = ModuleCommandIdentity & (
  | { readonly execute: (host: CommandHost, argument: string | undefined) => Promise<CommandOutcome> }
  | { readonly opens: string; readonly target?: CommandSurfaceTarget }
)

export interface ModuleCommandIdentity {
  readonly id: string
  /** The command's one name, in sentence case, which is also the heading of the surface it opens. */
  readonly title: string
  readonly description: string
  readonly aliases: readonly string[]
  /** The owner's own placement of the command in the command menu. */
  readonly menu?: CommandMenuPosition
  /** The reading a client shows beside a command that opens no surface. */
  readonly reading?: CommandReading
}

export type FirstPartyModuleComposition = ModuleComposition<FirstPartyContributionMap, FirstPartyObserverMap, FirstPartyGateMap>
export type FirstPartyModuleSnapshot = () => FirstPartyModuleComposition

/** One `flywheel <noun>` from the installed catalog and the module that owns it. */
export interface InstalledCliNoun extends CliNounContribution {
  readonly module: string
}

/** Every `flywheel <noun>` the installed catalog contributes, keyed by noun,
 *  whether or not a project enables the owner: the command line recognizes a
 *  noun before it knows a project and refuses it at dispatch when the owner is
 *  off there. A catalog other than the installed one is a test's. */
export function installedCliNouns(modules: readonly FirstPartyModule[] = installedModules()): ReadonlyMap<string, InstalledCliNoun> {
  const nouns = new Map<string, InstalledCliNoun>()
  for (const module of modules) {
    for (const contribution of module.contributions) {
      if (contribution.domain === "cli") nouns.set(contribution.id, { module: module.id, ...contribution.value })
    }
  }
  return nouns
}

/** The installed catalog's way for the terminal to open a project on another
 *  machine, whether or not a project enables its owner: a terminal pairs as a
 *  device of a remote machine, which this machine's own remote access setting
 *  does not govern. */
export function installedTerminalRemote(modules: readonly FirstPartyModule[] = installedModules()): TerminalRemoteContribution | undefined {
  for (const module of modules) {
    for (const contribution of module.contributions) {
      if (contribution.domain === "terminalRemote") return contribution.value
    }
  }
  return undefined
}

/** Every provider-scoped numeric setting the installed catalog declares,
 *  whether or not a project enables the owner: the config view carries each
 *  key with its default so a stored value keeps its meaning while the module
 *  is off, and the writer accepts only a declared key. */
export function installedProviderSettings(modules: readonly FirstPartyModule[] = installedModules()): readonly ModuleProviderSetting[] {
  return modules.flatMap((module) => {
    const providerId = module.contributions.find((contribution) => contribution.domain === "providers")?.id
    if (providerId === undefined) return []
    return module.contributions.flatMap((contribution) => contribution.domain === "settings" && contribution.value.control === "number" ? [{ ...contribution.value, providerId }] : [])
  })
}

const MODULE_ID_SET: ReadonlySet<string> = new Set(MODULE_IDS)

function isModuleId(id: string): id is ModuleId {
  return MODULE_ID_SET.has(id)
}

/** Projects the complete vocabulary against the installed catalog and one
 *  effective selection, in deterministic id order. An id the vocabulary knows
 *  but this catalog does not install (the development module in a release) is
 *  a row that is not installed: a stored selection that names it keeps its
 *  meaning, and no setting is offered for it. */
export function moduleProtocolRows(moduleIds: readonly ModuleId[], modules: readonly FirstPartyModule[] = installedModules()): readonly ModuleProtocolRow[] {
  const selected = new Set(moduleIds)
  const installed = new Map(modules.map((module) => [module.id, module]))
  return MODULE_IDS
    .map((id): ModuleProtocolRow => {
      const module = installed.get(id)
      if (!module) return { id, installed: false, effective: false, dependencies: [] }
      const dependencies = module.dependencies.filter(isModuleId).filter((dependency) => installed.has(dependency))
      const missing = dependencies.filter((dependency) => !selected.has(dependency))
      const declaredSettings = module.contributions.flatMap((contribution) => contribution.domain === "settings" ? [contribution.value] : [])
      const declaredSetting = declaredSettings.find((control): control is ModuleSettingControl & { readonly control: "binary" | "workflow-mode" } => control.control === "binary" || control.control === "workflow-mode")
      const providerId = module.contributions.find((contribution) => contribution.domain === "providers" || contribution.domain === "webBackends")?.id
      const setting: ModuleSetting | undefined = declaredSetting === undefined
        ? undefined
        : { ...declaredSetting, ...(providerId === undefined ? {} : { providerId }) }
      // A numeric setting is provider-scoped: it lives under the provider's
      // table in every profile, so the row needs the provider id to find it.
      const providerSettings: ModuleProviderSetting[] = providerId === undefined
        ? []
        : declaredSettings.flatMap((control) => control.control === "number" ? [{ ...control, providerId }] : [])
      const configSettings = declaredSettings.flatMap((control) => control.control === "config-boolean" || control.control === "config-number-list" ? [control] : [])
      return {
        id,
        installed: true,
        effective: selected.has(id) && missing.length === 0,
        dependencies,
        ...(missing.length === 0 ? {} : { dependencyError: `${id} requires ${missing.join(", ")}` }),
        ...(setting === undefined ? {} : { setting }),
        ...(providerSettings.length === 0 ? {} : { providerSettings }),
        ...(configSettings.length === 0 ? {} : { configSettings }),
      }
    })
    .toSorted((left, right) => left.id.localeCompare(right.id))
}

/** The modules that run under one stated selection: a module whose installed
 *  dependency the selection leaves off is off too, and comes back with it
 *  (ARCH-STRUCTURE-025). The stated selection stays what the person chose, so turning
 *  a dependency off and on again restores the dependent module as it was. */
export function effectiveModuleIds(stated: readonly ModuleId[], modules: readonly FirstPartyModule[] = installedModules()): readonly ModuleId[] {
  const dependencies = new Map(modules.map((module) => [module.id, module.dependencies]))
  const effective = new Set<string>(stated)
  let changed = true
  while (changed) {
    changed = false
    for (const id of effective) {
      if ((dependencies.get(id) ?? []).some((dependency) => !effective.has(dependency))) {
        effective.delete(id)
        changed = true
      }
    }
  }
  return stated.filter((id) => effective.has(id))
}

/** Migrations run by declared semantic order, independent of live selection. */
export function installedWorkspaceMigrations(phase: WorkspaceMigration["phase"], otherOwnersLive = false, modules: readonly FirstPartyModule[] = installedModules(), context?: Parameters<WorkspaceMigration["run"]>[0]): readonly WorkspaceMigration[] {
  const declared: readonly WorkspaceMigration[] = modules.flatMap((module) => module.workspaceMigrations ?? []).filter((migration) => migration.phase === phase)
  if (otherOwnersLive) {
    for (const migration of declared) {
      if (migration.requiresExclusiveOwner && migration.requiredWhen && (!context || migration.requiredWhen(context))) {
        throw new Error(`Cannot upgrade ${migration.label} while another process owns this project's state`)
      }
    }
  }
  const migrations = declared.filter((migration) => !otherOwnersLive || !migration.requiresExclusiveOwner)
  const orders = new Set<number>()
  for (const migration of migrations) {
    if (orders.has(migration.order)) throw new Error(`Workspace migration order ${migration.order} is declared twice in ${phase}`)
    orders.add(migration.order)
  }
  return migrations.toSorted((left, right) => left.order - right.order)
}

export async function recoverSessionHistory(input: SessionHistoryRecoveryInput, modules: readonly FirstPartyModule[] = installedModules()): Promise<void> {
  const results = await Promise.allSettled(modules.map(async (module) => { await module.sessionHistory?.recover?.(input) }))
  const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
  if (errors.length) throw new AggregateError(errors, `Module session history recovery failed: ${errors.map((error) => error instanceof Error ? error.message : String(error)).join("; ")}`)
}

export function invalidateSupersededModuleFacts(dbPath: string, modules: readonly FirstPartyModule[] = installedModules()): SupersededFactInvalidationResult {
  const results = modules.flatMap((module) => module.facts?.invalidateSuperseded ? [module.facts.invalidateSuperseded(dbPath)] : [])
  return { dbPath, storeFound: results.some((result) => result.storeFound), invalidated: results.flatMap((result) => result.invalidated), rowsDeleted: results.reduce((sum, result) => sum + result.rowsDeleted, 0), upgradable: [...new Set(results.flatMap((result) => result.upgradable))] }
}

export function moduleIdForSettingControl(control: ModuleSettingControl["control"], modules: readonly FirstPartyModule[] = installedModules()): ModuleId {
  const owners = modules.filter((module) => module.contributions.some((entry) => entry.domain === "settings" && entry.value.control === control))
  const id = owners[0]?.id
  if (owners.length !== 1 || id === undefined || !isModuleId(id)) throw new Error(`Setting control ${control} does not have one module owner`)
  return id
}

export function selectionPolicyError(moduleIds: readonly ModuleId[], input: { readonly requireWorkflowConfirmation: boolean }, modules: readonly FirstPartyModule[] = installedModules()): string | undefined {
  const selected = new Set<string>(moduleIds)
  for (const module of modules) {
    if (!selected.has(module.id)) continue
    const error = module.selectionPolicy?.({ ...input, moduleIds })
    if (error !== undefined) return error
  }
  return undefined
}

export function installedRetiredModuleConfig(modules: readonly FirstPartyModule[] = installedModules()): readonly { readonly moduleId: ModuleId; readonly section: string; readonly key: string; readonly label: string }[] {
  return modules.flatMap((module) => {
    const moduleId = module.id
    return isModuleId(moduleId) ? (module.retiredConfig ?? []).map((entry) => ({ ...entry, moduleId })) : []
  })
}

export function headlessModuleIds(modules: readonly FirstPartyModule[] = installedModules()): readonly ModuleId[] {
  return modules.flatMap((module) => module.headless ? [{ id: module.id, order: module.headless.order }] : []).toSorted((left, right) => left.order - right.order).map((module) => module.id).filter(isModuleId)
}

/** The capability ceiling of an unattended chat: every module that does not serve a person who reads the conversation. */
export function unattendedModuleIds(modules: readonly FirstPartyModule[] = installedModules()): readonly ModuleId[] {
  const attended = new Set<string>(modules.flatMap((module) => module.attended ? [module.id] : []))
  return MODULE_IDS.filter((id) => !attended.has(id))
}

/** Preserve one admission across preparation and the later consent-aware pass. */
export async function prepareDefinitionReconciliation(input: DefinitionReconciliationInput, modules: readonly FirstPartyModule[] = installedModules()): Promise<(reader?: AsyncEventStateReadSurface) => Promise<void>> {
  const prepared = await Promise.allSettled(modules.map(async (module) => module.definitionReconciliation?.prepare(input)))
  const errors = prepared.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
  // The members' messages travel in the message, because a start failure
  // crosses the executor boundary as text and its cause is read from it.
  if (errors.length) throw new AggregateError(errors, `Module definition reconciliation preparation failed: ${errors.map(errorMessage).join("; ")}`)
  const callbacks = prepared.flatMap((result) => result.status === "fulfilled" && result.value ? [result.value] : [])
  return async (reader) => {
    const failures: unknown[] = []
    for (const reconcile of callbacks) { try { await reconcile(reader) } catch (error) { failures.push(error) } }
    if (failures.length) throw new AggregateError(failures, "Module definition reconciliation failed")
  }
}

export async function runModuleMaintenance(phase: ModuleMaintenance["phase"], input: ModuleMaintenanceInput, modules: readonly FirstPartyModule[] = installedModules()): Promise<void> {
  const results = await Promise.allSettled(modules.flatMap((module) => (module.maintenance ?? []).filter((entry) => entry.phase === phase)).map(async (entry) => {
    input.signal.throwIfAborted()
    await entry.run(input)
  }))
  const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : [])
  if (errors.length) throw new AggregateError(errors, "Module maintenance failed")
}

/** Classifies retained credentials from the complete installed catalog, independent of provider admission. */
export function credentialSlotClassifier(composition: Pick<FirstPartyModuleComposition, "installedContributions">): CredentialSlotClassifier {
  const slots = new Map<string, CredentialSlot>()
  for (const contribution of composition.installedContributions) {
    const declaration = contribution.domain === "providers"
      ? { id: contribution.id, slot: contribution.value.definition.billing }
      : contribution.domain === "webAuthProviders"
        ? { id: contribution.id, slot: "metered" as const }
        : undefined
    if (declaration === undefined) continue
    const existing = slots.get(declaration.id)
    if (existing !== undefined && existing !== declaration.slot) {
      throw new Error(`Conflicting credential slot declarations for ${declaration.id}: ${existing} and ${declaration.slot}`)
    }
    slots.set(declaration.id, declaration.slot)
  }
  return (providerId) => slots.get(providerId) ?? "metered"
}
