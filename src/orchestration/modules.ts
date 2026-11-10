import { createModuleToolHistoryReader } from "./session/module-tool-history.js"
import { errorMessage } from "../infra/error-message.js"
import { remoteModule } from "./modules/remote/module.js"
import type { RetiredServiceInstallation } from "./app-service/account-service-installation.js"
import { composeModules, type ModuleDescriptor, type ModuleComposition } from "../infra/module-descriptor.js"
import type { ModuleRuntimeHandle, ModuleRuntimes } from "../infra/module-runtime.js"
import type { ChatModuleHostContribution } from "./chat-module-host.js"
import type { TerminalRemoteContribution } from "./terminal-remote.js"
import type { ModuleServiceHandle, ModuleServices } from "../infra/module-service.js"
import type { NotificationEpisodeInput } from "../infra/notification-episode.js"
import { canonicalModuleIds, EMPTY_MODULE_IDS, MODULE_IDS, type ModuleId as WireModuleId } from "../protocol/module-ids.js"
import type { ModuleProtocolRow, ModuleProviderSetting, ModuleSetting, ModuleSettingControl, WorkflowsMode } from "../protocol/module-protocol-types.js"
import type { ToolDeclaration } from "./agent-runtime/tools/tool-registry.js"
import { credentialSlotClassifier } from "./auth/credential-slot-classifier.js"
import type { KernelToolDeps } from "./agent-runtime/tools/kernel-tool-deps.js"
import type { RuntimeTool } from "./agent-runtime/tools/types.js"
import type { ModuleRuntimeServices } from "./agent-runtime/module-runtime-services.js"
import type { AccessProviderDefinition } from "../infra/llm/access-provider.js"
import type { AuthContext, ProviderConnection } from "../infra/auth/auth-context.js"
import type { CredentialSlotClassifier } from "../infra/auth/auth-store-types.js"
import type { WebProviderDefinition } from "../infra/auth/web-providers.js"
import type { SubscriptionUsageReader } from "../infra/llm/subscription-usage.js"
import type { WebSearchProvider, WebSearchProviderId } from "./agent-runtime/web-search/types.js"
import type { CommandMenuPosition, CommandOutcome, CommandReading, CommandSurfaceTarget } from "../protocol/command-catalog-protocol-types.js"
import type { ModuleHealthCheck } from "./module-health.js"
import type { CliNounContribution } from "./cli-contribution.js"
import type { CommandHost } from "./app-service/command-host.js"
import type { AccountModuleProtocolServices, ModuleProtocolContribution } from "./app-service/module-protocol-host.js"
import type { AccountModuleService, AccountModuleServiceInputs, AccountModuleServiceOptions, AccountProjectModuleServices, ModuleProcessServices, ModuleServiceInstance, PortableModuleServices } from "./app-service/module-service-host.js"
import type { ModuleConfigSection } from "./config/config-section.js"
import type { DefinitionBundle } from "../workflows/loader.js"
import { installedDefinitionBundles, installedModules, publishShippedOtherModules, validateModuleFactPrefixes } from "./module-catalog.js"
import { CREDENTIAL_PROVIDER_MODULES } from "./credential-provider-modules.js"
import type { AnyFactSchema } from "../infra/event-registry.js"
import type { AuthProviderStatus } from "../protocol/auth-status-protocol-types.js"
import { moduleRequirementsForContribution } from "./module-requirements.js"
import type { DefinitionReconciliationInput, ModuleChildSessionHistory, ModuleDefinitionReconciliation, ModuleMaintenance, ModuleMaintenanceInput, ManagedPackageWrites, MemoryContribution, ModuleChatObserver, ModuleChatObserverContext, ModuleRetainedOperationContribution, ModuleRuntimeInvocationTool, ModuleSessionHistory, ModuleSessionAdmission, ModuleSessionDeletion, ModuleChildSession, QuestionDecisionContribution, SessionHistoryRecoveryInput, SessionToolSummaryReader, SkillChildGrantContribution, SupersededFactInvalidationResult, WorkspaceMigration } from "./module-seams.js"
import type { ModuleRetainedDiagnostics } from "./module-diagnostics.js"
import type { ModuleAgentTasks } from "./module-agent-tasks.js"
import type { DEVELOPMENT_MODULES } from "./development-modules.js"
import { askUserModule } from "./modules/ask-user.js"
import { backgroundCommandsModule } from "./modules/background-commands.js"
import { bashModule } from "./modules/bash/module.js"
import { bugReportsModule } from "./modules/bug-reports/module.js"
import { codeModeModule } from "./modules/code-mode/module.js"
import { definitionOverridesModule } from "./modules/definition-overrides.js"
import { discoveryModule } from "./modules/discovery.js"
import { experimentsModule } from "./modules/experiments.js"
import { fileToolsModule } from "./modules/file-tools.js"
import { learningModule } from "./modules/learning.js"
import { subscriptionUsageModule } from "./modules/subscription-usage/module.js"
import { mcpModule } from "./modules/mcp/module.js"
import { customProviderModules } from "./custom-provider-modules.js"
import { customProviderGeneration } from "../infra/llm/custom-provider-registry.js"
import { recallModule } from "./modules/recall.js"
import { papercutsModule } from "./modules/papercuts.js"
import { projectNotificationsModule } from "./modules/project-notifications/module.js"
import { skillsModule } from "./modules/skills.js"
import { sideQuestionModule } from "./modules/side-question/module.js"
// oxlint-disable-next-line import/no-cycle -- the installed catalog is the retained reader registry for disabled modules.
import { subagentsModule } from "./modules/subagents.js"
import { webModule } from "./modules/web.js"
import { webChatgptModule } from "./modules/web-chatgpt.js"
import { workflowsModule } from "./modules/workflows.js"

import type { ToolExecutionGate } from "./agent-runtime/tools/tool-dispatch.js"
import type { CapabilityCheck } from "../infra/capability-text.js"
import type { TurnReminderStatement, TurnReminderText } from "./agent-runtime/turn-reminders.js"

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
  readonly definition: "skills" | "web"
  readonly visibility: "model-invocable"
}

type DefinitionContribution =
  | { readonly kind: "skills"; readonly retainInstalled: true }
  /** `disabledTypes` reads the agent types that a configuration turns off (ARCH-STRUCTURE-044). */
  | { readonly kind: "subagents"; readonly roles: true; readonly retainInstalled: true; readonly disabledTypes: (config: { readonly [section: string]: unknown }) => readonly string[] }
  | { readonly kind: "workflows" }
  /** A module-owned definition root. The registry loads its skills and retains
   *  its workflow directory for file brief resolution (ARCH-STRUCTURE-031). */
  | { readonly kind: "bundle"; readonly root: string }

/** A set of tools that exist only inside the code projection: a module builds
 *  them per request from `{ kernel, modules }`, the planner adds them to the
 *  code catalog when code is selected, and they are admitted through the code
 *  registration. A module that owns no such tools that request returns none. */
interface CodeToolsContribution {
  readonly create: (deps: { readonly kernel: KernelToolDeps; readonly modules: ModuleRuntimes }) => readonly RuntimeTool[]
  /** The namespaces the contribution serves, known before their tools arrive. The Code Mode catalog names each one
   *  from the first request, so tools that arrive later leave the system prompt and its prompt cache unchanged. */
  readonly namespaces?: (deps: { readonly kernel: KernelToolDeps; readonly modules: ModuleRuntimes }) => readonly string[]
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
    { readonly definition: AccessProviderDefinition; readonly createClient: import("./agent-runtime/llm/client-factory.js").AccessProviderFactory; readonly usageReader?: SubscriptionUsageReader; readonly resetConsumer?: import("../infra/llm/subscription-usage.js").SubscriptionUsageResetConsumer; readonly affordability?: import("./agent-runtime/llm/provider-affordability.js").ProviderAffordabilityFactory; readonly allowance?: import("./agent-runtime/llm/provider-availability-types.js").ProviderAllowanceFactory }
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

type WorkflowObserverFactory = (context: WorkflowObserverContext) => import("./agent-runtime/batch-observers.js").BatchObserver

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
interface FirstPartyTransformerMap {
  readonly modelContext: (value: string) => string
  readonly startupLabel: (value: string) => string
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

export type FirstPartyModule = ModuleDescriptor<FirstPartyContributionMap, FirstPartyObserverMap, FirstPartyTransformerMap, FirstPartyGateMap> & {
  readonly runtime?: ModuleRuntimeDeclaration<unknown>
  /** The type prefixes of the durable fact families this module owns. The
   *  retention registry names the owner per family; the prefixes are the
   *  module's namespace claim, and `bun run lint:fact-retention` fails a family
   *  the registry gives this module that carries none of them (ARCH-STRUCTURE-023). */
  readonly facts?: {
    readonly prefixes: readonly string[]
    readonly sessionSchemas?: () => readonly AnyFactSchema[]
    readonly invalidateSuperseded?: (dbPath: string) => SupersededFactInvalidationResult
  }
  readonly workspaceMigrations?: readonly WorkspaceMigration[]
  readonly definitionReconciliation?: ModuleDefinitionReconciliation
  readonly maintenance?: readonly ModuleMaintenance[]
  readonly sessionHistory?: ModuleSessionHistory
  /** Installed child-session semantics stay available for durable history even when dispatch is disabled. */
  readonly childSessionHistory?: ModuleChildSessionHistory
  readonly sessionDeletion?: ModuleSessionDeletion
  /** Installed for durable history even when the module is disabled. */
  readonly runtimeInvocationTool?: ModuleRuntimeInvocationTool
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
    readonly service?: ModuleServiceDeclaration<ModuleServiceInstance, import("./app-service/module-service-host.js").ControlModuleServices>
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

export type FirstPartyModuleComposition = ModuleComposition<FirstPartyContributionMap, FirstPartyObserverMap, FirstPartyTransformerMap, FirstPartyGateMap>
export type FirstPartyModuleSnapshot = () => FirstPartyModuleComposition

/** The composition one realm's selection enables. Same value as
 *  `composeFirstPartyModules` for the selection's disabled set, so two realms
 *  with one selection share one object. */
export function composeRealmModuleSnapshot(
  state: { readonly moduleIds: readonly string[] },
  modules: readonly FirstPartyModule[] = installedModules(),
): FirstPartyModuleComposition {
  const selected = new Set(state.moduleIds)
  const installed = new Set(modules.map((module) => module.id))
  return composeFirstPartyModules(modules, MODULE_IDS.filter((id) => installed.has(id) && !selected.has(id)))
}


/** Every shipped module that claims no credential provider id. The credential
 *  provider registry lists the others, so auth reads them without loading
 *  these. A source run adds the development catalog to this half through
 *  `installModuleCatalog`; nothing here names that catalog by value, so a
 *  release bundle never contains it. */
export const SHIPPED_OTHER_MODULES = [askUserModule, backgroundCommandsModule, bashModule, bugReportsModule, codeModeModule, definitionOverridesModule, discoveryModule, experimentsModule, fileToolsModule, learningModule, mcpModule, papercutsModule, projectNotificationsModule, recallModule, remoteModule, sideQuestionModule, skillsModule, subagentsModule, subscriptionUsageModule, webModule, webChatgptModule, workflowsModule] as const satisfies readonly FirstPartyModule[]
publishShippedOtherModules(SHIPPED_OTHER_MODULES)

/** The catalog every release composes from. */
export const SHIPPED_MODULES = [...CREDENTIAL_PROVIDER_MODULES, ...SHIPPED_OTHER_MODULES] as const satisfies readonly FirstPartyModule[]

/** The definition bundles every release ships: the build embeds them, and the
 *  bundled-default catalog holds their packages, so an override of one still
 *  diffs. A source run loads the development bundle too, but never ships it. */
export function shippedDefinitionBundles(): readonly DefinitionBundle[] {
  return installedDefinitionBundles(SHIPPED_MODULES)
}

/** Every service registration a module retired, for the account service installer to remove. */
export function retiredServiceInstallations(composition: FirstPartyModuleComposition = composeFirstPartyModules()): readonly RetiredServiceInstallation[] {
  return composition.contributions
    .filter((contribution) => contribution.domain === "accountServices")
    .flatMap((contribution) => contribution.value.retiredInstallation ? [contribution.value.retiredInstallation] : [])
}

type CatalogModuleId = (typeof SHIPPED_MODULES)[number]["id"] | (typeof DEVELOPMENT_MODULES)[number]["id"]
/** The module vocabulary every orchestration type names. It is the wire
 *  vocabulary, not the registry-derived one: a descriptor's factory types
 *  reach the capability boundary, so deriving the id from the catalog would
 *  make the catalog's own type circular. The proof below keeps both equal. */
export type ModuleId = WireModuleId

/** Both directions against the wire vocabulary in `protocol/module-ids.ts`,
 *  so a module registered without its id there, and an id there with no module
 *  behind it, are each a compile error at their own source rather than a
 *  decode failure at the first wire frame that carries them. The proof lives
 *  on this side of the boundary because the protocol package never names an
 *  orchestration path, and the type-only imports are erased before they can
 *  drag the registry into the wire schema's value-import closure, or the
 *  development catalog into a release bundle. */
type RegistryStatesVocabulary = CatalogModuleId extends WireModuleId ? true : never
type VocabularyStatesRegistry = WireModuleId extends CatalogModuleId ? true : never
const _registryStatesVocabulary: RegistryStatesVocabulary = true; const _vocabularyStatesRegistry: VocabularyStatesRegistry = true
// IDs shipped after the retired `modules` snapshot format. A retired snapshot
// cannot state a decision about them, so migration and reads treat them as enabled.
const DEFAULT_ENABLED_SINCE_MODULES_SNAPSHOT: readonly ModuleId[] = [
  "definition-overrides", "experiments", "mcp", "papercuts", "project-notifications", "side-question",
  "provider-anthropic-api", "provider-chatgpt", "provider-claude-agent-sdk", "provider-deepseek", "provider-github-copilot", "provider-google-api",
  "provider-google-vertex", "provider-openai-api", "provider-opencode-go", "provider-openrouter", "provider-supergrok",
]

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

/** Declared settings in UI-safe module sections. The registry validates
 *  the section owner before the host projects or writes one of these keys. */
export function installedModuleConfigSettings(modules: readonly FirstPartyModule[] = installedModules()) {
  return modules.flatMap((module) => module.contributions.flatMap((contribution) => {
    if (contribution.domain !== "settings" || !(contribution.value.control === "config-number-list" || (contribution.value.control === "config-boolean" && "section" in contribution.value))) return []
    const setting = contribution.value
    const section = module.contributions.find((entry) => entry.domain === "config" && entry.value.key === setting.section)
    if (section?.domain !== "config" || section.value.protocolExposure !== "ui-safe") throw new Error(`Module ${module.id} must own UI-safe config section ${setting.section}`)
    return [{ moduleId: module.id, section: section.value, setting }]
  }))
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
        installed: module.availability.kind === "available",
        effective: module.availability.kind === "available" && selected.has(id) && missing.length === 0,
        dependencies,
        ...(missing.length === 0 ? {} : { dependencyError: `${id} requires ${missing.join(", ")}` }),
        ...(setting === undefined ? {} : { setting }),
        ...(providerSettings.length === 0 ? {} : { providerSettings }),
        ...(configSettings.length === 0 ? {} : { configSettings }),
      }
    })
    .toSorted((left, right) => left.id.localeCompare(right.id))
}

// Retired module-id spellings mapped to their canonical ids; a selection
// stored under an old spelling keeps selecting the same capability.
// `benchmark` became one contribution of the development module.
export const RETIRED_MODULE_ID_SPELLINGS: ReadonlyMap<string, ModuleId> = new Map([["background_commands", "background-commands"], ["benchmark", "development"]])
function canonicalModuleIdSpelling(id: string): string {
  return RETIRED_MODULE_ID_SPELLINGS.get(id) ?? id
}
const LEGACY_MODULE_IDS: ReadonlySet<string> = new Set(["workflows", "skills", "subagents", "learning", "background_commands"])
const RETIRED_MODULE_EXPANSIONS = {
  "core-tools": ["bash", "discovery", "file-tools"],
  "runtime-tools": ["ask-user", "recall"],
} as const

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

export function workflowsModeOf(selected: readonly ModuleId[], confirmationRequired: boolean): WorkflowsMode {
  if (!selected.includes(workflowsModule.id)) return "off"
  return confirmationRequired ? "ask" : "on"
}

export const MODULE_PRESETS = {
  minimal: { moduleIds: EMPTY_MODULE_IDS, workflowsMode: "off" },
  full: { moduleIds: MODULE_IDS, workflowsMode: "on" },
} as const


export type ModuleSelection =
  | { readonly ok: true; readonly moduleIds: readonly ModuleId[]; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly error: string }

/** Decodes an external module selection against the wire vocabulary. */
export function normalizeModuleSelection(value: unknown): ModuleSelection {
  if (value === undefined) return selectedCapabilityModules(MODULE_IDS)
  if (!Array.isArray(value)) return { ok: false, error: 'Invalid config value "modules": expected an array of registered module ids' }
  if (!value.every((member) => typeof member === "string")) return { ok: false, error: 'Invalid config value "modules": every member must be a registered module id' }
  const selected = new Set(value.map(canonicalModuleIdSpelling))
  const unknown = [...selected].filter((id) => !MODULE_ID_SET.has(id)).sort()
  if (unknown.length > 0) return { ok: false, error: `Unknown module id(s): ${unknown.join(", ")}` }
  return selectedCapabilityModules(MODULE_IDS.filter((id) => selected.has(id)))
}

/** The id of the retired add-on that let agents write workflows; the workflows module absorbed it. */
const RETIRED_WORKFLOWS_ADD_ON = "adhoc-workflows"

/** The persisted opt-out list: the default-on modules that the person turned off. */
function persistedDisabledModules(value: unknown): ModuleSelection {
  if (value === undefined) return { ok: true, moduleIds: [], warnings: [] }
  if (!Array.isArray(value)) return { ok: false, error: 'Invalid config value "disabled_modules": expected an array of registered module ids' }
  if (!value.every((member) => typeof member === "string")) return { ok: false, error: 'Invalid config value "disabled_modules": every member must be a registered module id' }
  // The opt-out of the retired add-on module becomes Workflows Off. Remove after 2027-04-30.
  const converted = value.includes(RETIRED_WORKFLOWS_ADD_ON)
  const members = new Set(value.map((id) => canonicalModuleIdSpelling(id === RETIRED_WORKFLOWS_ADD_ON ? "workflows" : id)))
  const unknown = [...members].filter((id) => !MODULE_ID_SET.has(id)).sort()
  if (unknown.length > 0) return { ok: false, error: `Unknown disabled_modules id(s): ${unknown.join(", ")}` }
  return { ok: true, moduleIds: MODULE_IDS.filter((id) => members.has(id)), warnings: converted ? ['flywheel.toml disabled_modules names "adhoc-workflows", the retired Ad hoc workflows module. Flywheel reads it as "workflows", so Workflows is Off. The next settings change writes "workflows" in its place.'] : [] }
}

/** The modules that the retired `enabled_modules` list could name: the opt-in modules there were, each of which is
 *  now either on by default (`provider-claude-agent-sdk`) or replaced by one that is (`provider-claude-subscription`,
 *  replaced by the Agent SDK provider). Every module is on by default now, so such a list states the default
 *  selection. A read takes it as no difference, and startup and the next selection write remove it. Any other value
 *  is invalid, as it was. Remove the conversion after 2027-04-08. */
const RETIRED_OPT_IN_MODULE_IDS: ReadonlySet<unknown> = new Set(["provider-claude-agent-sdk", "provider-claude-subscription"])
const RETIRED_ENABLED_MODULES_ERROR = 'Invalid config value "enabled_modules": every module is on unless disabled_modules names it, so remove enabled_modules'

/** Decodes one parsed config's sole module-selection authority. */
export function moduleSelectionFromConfig(parsed: {
  readonly modules?: unknown
  readonly capability_modules?: unknown // retired spelling of modules; remove the conversion after 2026-12-18
  readonly disabled_modules?: unknown
  readonly enabled_modules?: unknown
}): ModuleSelection {
  const hasDisabled = Object.hasOwn(parsed, "disabled_modules")
  const hasModules = Object.hasOwn(parsed, "modules")
  const hasCapabilityModules = Object.hasOwn(parsed, "capability_modules")
  if (hasDisabled && (hasModules || hasCapabilityModules)) return { ok: false, error: 'Cannot state both "disabled_modules" and a retired spelling ("modules" or "capability_modules")' }
  if (Object.hasOwn(parsed, "enabled_modules") && (hasModules || hasCapabilityModules)) return { ok: false, error: 'Cannot state "enabled_modules" with a retired spelling ("modules" or "capability_modules")' }
  if (hasModules || hasCapabilityModules) {
    const migrated = migrateModuleSelection(hasModules ? parsed.modules : parsed.capability_modules) // retired spelling
    if (!migrated.ok) return migrated
    return selectedCapabilityModules(canonicalModuleIds([...migrated.moduleIds, ...DEFAULT_ENABLED_SINCE_MODULES_SNAPSHOT]))
  }
  const disabled = persistedDisabledModules(parsed.disabled_modules)
  if (!disabled.ok) return disabled
  const enabled = parsed.enabled_modules
  if (enabled !== undefined && !(Array.isArray(enabled) && enabled.every((id) => RETIRED_OPT_IN_MODULE_IDS.has(id)))) return { ok: false, error: RETIRED_ENABLED_MODULES_ERROR }
  return selectedCapabilityModules(MODULE_IDS.filter((id) => !disabled.moduleIds.includes(id)), disabled.warnings)
}

/** Expands retired aggregate IDs only when the complete selection is otherwise valid. */
function migrateModuleSelection(value: unknown): ModuleSelection {
  if (!Array.isArray(value) || !value.every((member) => typeof member === "string")) {
    return { ok: false, error: 'Invalid config value "modules": every member must be a registered or retired module id' }
  }
  const expanded = value.map(canonicalModuleIdSpelling).flatMap((id) => {
    if (MODULE_ID_SET.has(id)) return [id]
    if (id === "core-tools" || id === "runtime-tools") return RETIRED_MODULE_EXPANSIONS[id]
    return []
  })
  const unknown = value.map(canonicalModuleIdSpelling).filter((id) => !MODULE_ID_SET.has(id) && id !== "core-tools" && id !== "runtime-tools")
  if (unknown.length > 0) return { ok: false, error: `Unknown module id(s): ${[...new Set(unknown)].sort().join(", ")}` }
  const selected = new Set(expanded)
  return selectedCapabilityModules(MODULE_IDS.filter((id) => selected.has(id)))
}

/** Converts the retired five-choice selection without changing any former core module. */
export function migrateLegacyCapabilityModules(value: unknown): ModuleSelection {
  if (!Array.isArray(value) || !value.every((member) => typeof member === "string" && LEGACY_MODULE_IDS.has(member))) {
    return { ok: false, error: 'Invalid legacy config value "features": expected only workflows, skills, subagents, learning, and background_commands' }
  }
  const selectedLegacy = new Set(value)
  // The features vocabulary predates the kebab module ids: a module maps back
  // to its features token before membership decides whether it stays on.
  const featureToken = (id: string): string => (id === "background-commands" ? "background_commands" : id) // legacy features token
  return selectedCapabilityModules(MODULE_IDS.filter((id) => !LEGACY_MODULE_IDS.has(featureToken(id)) || selectedLegacy.has(featureToken(id))))
}

function selectedCapabilityModules(moduleIds: readonly ModuleId[], warnings: readonly string[] = []): ModuleSelection {
  try {
    const selected = new Set(moduleIds)
    composeFirstPartyModules(installedModules(), MODULE_IDS.filter((id) => !selected.has(id)))
    return { ok: true, moduleIds: Object.freeze([...moduleIds]), warnings: Object.freeze([...warnings]) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/** One composition value per catalog, disabled set, and custom-provider
 *  generation. The value is the identity every derived cache keys on (provider
 *  clients, request surfaces, tool registries), so equal inputs must return the
 *  same frozen object and a changed `[custom_providers]` section must return a
 *  new one. A composition that throws is not held; the next read retries. */
interface CompositionCache {
  readonly generation: number
  readonly byDisabled: Map<string, FirstPartyModuleComposition>
}
const compositions = new WeakMap<readonly FirstPartyModule[], CompositionCache>()

export function composeFirstPartyModules(
  modules: readonly FirstPartyModule[] = installedModules(),
  disabledModuleIds: readonly ModuleId[] = EMPTY_MODULE_IDS,
): FirstPartyModuleComposition {
  const generation = customProviderGeneration()
  let cache = compositions.get(modules)
  if (cache === undefined || cache.generation !== generation) {
    cache = { generation, byDisabled: new Map() }
    compositions.set(modules, cache)
  }
  // A disabled id the vocabulary knows but this catalog does not install (the
  // development module in a release) names nothing to remove, so it never
  // splits the value.
  const installed = new Set(modules.map((module) => module.id))
  const disabled = [...new Set(disabledModuleIds)].filter((id) => installed.has(id)).sort()
  const key = disabled.join("\0")
  const held = cache.byDisabled.get(key)
  if (held !== undefined) return held
  const composition = composeFirstPartyModulesUncached(modules, disabled)
  const composed = Object.freeze({
    enabledModuleIds: Object.freeze([...composition.enabledModuleIds]),
    backgroundWorkProducerIds: Object.freeze([...composition.backgroundWorkProducerIds]),
    installedContributions: Object.freeze([...composition.installedContributions]),
    contributions: Object.freeze([...composition.contributions]),
    observers: Object.freeze([...composition.observers]),
    transformers: Object.freeze([...composition.transformers]),
    gates: Object.freeze([...composition.gates]),
    warnings: Object.freeze([...composition.warnings]),
  })
  cache.byDisabled.set(key, composed)
  return composed
}

function composeFirstPartyModulesUncached(
  modules: readonly FirstPartyModule[],
  disabledModuleIds: readonly ModuleId[],
): FirstPartyModuleComposition {
  validateModuleFactPrefixes(modules)
  // Config-declared custom providers join every composition beside the
  // installed catalog. They carry no toggle in `modules`; the
  // config section's presence is their enablement.
  const composition = composeModules([...modules, ...customProviderModules()], { disabledModuleIds, warnWhenEmpty: ["providers"] })
  credentialSlotClassifier(composition)
  return composition.contributions.some((contribution) => contribution.domain === "tools")
    ? composition
    : { ...composition, warnings: [...composition.warnings, "No tools contributions are enabled"].sort() }
}

export function createWebSearchProviderResolver(options: {
  readonly authDir: string
  readonly getAuth: () => AuthContext
  readonly connection?: ProviderConnection
}): (composition: FirstPartyModuleComposition) => readonly WebSearchProvider[] {
  const providers = new Map<WebSearchProviderId, WebSearchProvider>()
  return (composition) => composition.contributions
    .filter((contribution) => contribution.domain === "webBackends")
    .map((contribution) => {
      if (contribution.id !== contribution.value.id) throw new Error(`Web backend contribution ${contribution.id} contains backend ${contribution.value.id}`)
      const existing = providers.get(contribution.value.id)
      if (existing) return existing
      const provider = contribution.value.create({ ...options, credentialSlotClassifier: credentialSlotClassifier(composition) })
      providers.set(provider.id, provider)
      return provider
    })
}

export function webAuthProviderDefinitions(composition: FirstPartyModuleComposition): readonly (WebProviderDefinition & Pick<AuthProviderStatus, "group">)[] {
  return composition.contributions
    .filter((contribution) => contribution.domain === "webAuthProviders")
    .map((contribution) => {
      if (contribution.id !== contribution.value.id) throw new Error(`Web auth contribution ${contribution.id} contains definition ${contribution.value.id}`)
      return contribution.value
    })
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

export function createSessionToolSummaryReader(reader: Parameters<NonNullable<ModuleSessionHistory["createToolSummaryReader"]>>[0], sessionId: string, modules: readonly FirstPartyModule[] = installedModules()): Required<SessionToolSummaryReader> {
  const readers = modules.flatMap((module) => module.sessionHistory?.createToolSummaryReader?.(reader, sessionId) ?? [])
  return createModuleToolHistoryReader(readers)
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

export function definitionModuleRequirements(modules: readonly FirstPartyModule[] = installedModules()) {
  const forKind = (kind: DefinitionContribution["kind"]): readonly ModuleId[] => canonicalModuleIds(modules.flatMap((module) => module.contributions.flatMap((entry) => entry.domain === "definitions" && entry.value.kind === kind ? moduleRequirementsForContribution("definitions", entry.id, modules) : [])))
  return { skills: forKind("skills"), subagents: forKind("subagents"), workflows: forKind("workflows") }
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
export function headlessModuleIds(modules: readonly FirstPartyModule[] = SHIPPED_MODULES): readonly ModuleId[] {
  return modules.flatMap((module) => module.headless ? [{ id: module.id, order: module.headless.order }] : []).toSorted((left, right) => left.order - right.order).map((module) => module.id).filter(isModuleId)
}
/** The capability ceiling of an unattended chat: every module that does not serve a person who reads the conversation. */
export function unattendedModuleIds(modules: readonly FirstPartyModule[] = installedModules()): readonly ModuleId[] {
  const attended = new Set<string>(modules.flatMap((module) => module.attended ? [module.id] : []))
  return MODULE_IDS.filter((id) => !attended.has(id))
}
/** Preserve one admission across preparation and the later consent-aware pass. */
export async function prepareDefinitionReconciliation(input: DefinitionReconciliationInput, modules: readonly FirstPartyModule[] = installedModules()): Promise<(reader?: import("../infra/event-store-types.js").AsyncEventStateReadSurface) => Promise<void>> {
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
