import { resolveAuthContext, type AuthContext } from "../../infra/auth/auth-context.js"
import type { KeyResolver } from "../../infra/auth/resolve-key.js"
import { createEnvCaptureResolver, type EnvCaptureResolver } from "../../infra/env-detection.js"
import { Log } from "../../infra/log.js"
import { ownedCommandRunner, type OwnedCommandRunner } from "../../infra/owned-command.js"
import type { ModelFamily } from "../../infra/llm/model-family.js"
import type { ModelInfo, ModelsClient } from "../../infra/llm/models.js"
import type { AccountDirectories } from "../../infra/directory-authorities.js"
import { authDir } from "../../infra/paths.js"
import { createAgentRuntime, type CaptureProviderConnection, type CaptureSubscriptionAdmission, type LLMClientFactory } from "../agent-runtime/factory.js"
import type { EffectiveProviderConnection, RecordModelRefusal } from "../agent-runtime/llm/client-factory.js"
import type { CaptureRuntimeConfig } from "../agent-runtime/request-config.js"
import type { AgentFactory, AgentOptions } from "../agent-runtime/types.js"
import type { CapabilityPlanner, RequestPreparer } from "../agent-runtime/request-preparation.js"
import type { ProjectDefinitionRegistry, ProjectDefinitionRegistryRevision } from "../../workflows/definition-registry.js"
import type { NotificationEpisodeInput } from "../../infra/notification-episode.js"
import { getSharedModelsClient } from "../config/llm-clients.js"
import { resolveEnabledProviderModelCatalog } from "../config/model-assignment-providers.js"
import type { WorkerProviderModelEligibility } from "../config/provider-model-eligibility.js"
import { capabilityAccessFor, type CapabilityAccess } from "../agent-runtime/tools/types.js"
import type { ModulePolicy } from "../config/module-policy.js"
import type { FirstPartyModuleComposition, FirstPartyModuleSnapshot } from "../modules.js"
import { installedCredentialProviderIds } from "../credential-provider-modules.js"

import type { ModuleServices } from "../../infra/module-service.js"
import type { LauncherScope } from "../../infra/process-supervisor.js"
import type { CommandHandoverAuthority } from "../agent-runtime/command-handover.js"
import type { ChildSessionControl } from "../session/child-session-control.js"
import type { PersistentProcessClient } from "../../infra/persistent-process-manager.js"
import type { BridgedPersistentProcessClient } from "../../infra/persistent-process-bridge.js"
import type { GitAiAttributionService } from "../agent-runtime/git-ai-attribution-service.js"
import type { StreamingEditValidationService } from "../agent-runtime/tools/streaming-edit-validation.js"
import type { AuthConditionOwner } from "../auth/auth-condition-owner.js"
import type { UsageAuthorityGeneration } from "../agent-runtime/usage-settlement.js"

import { credentialSlotClassifier } from "../auth/credential-slot-classifier.js"
import { accessProviderRegistry } from "../agent-runtime/llm/access-provider-registry.js"
const log = Log.create({ service: "workflow-deps" })

export interface WorkflowDeps extends AccountDirectories {
  /** Immutable auth captured for this admitted dependency set. */
  readonly auth: AuthContext
  /** Immutable model listing captured for this admitted dependency set. */
  readonly availableModels: ReadonlyMap<ModelFamily, ReadonlySet<string>>
  /** Immutable metadata from the same captured model listing. */
  readonly modelInfos: ReadonlyMap<string, ModelInfo>
  /** Shared public metadata client used outside tier resolution. */
  readonly modelsClient?: ModelsClient
  /** Captured auth profile id for this dependency set. */
  readonly activeProfileId?: string
  /** Definition owner of the project this run serves. */
  readonly definitions: ProjectDefinitionRegistry
  /** Immutable module composition captured by this runtime realm. */
  readonly moduleSelection: FirstPartyModuleSnapshot
  createAgent: AgentFactory
  /** Prepares the next request of a session's run without building its Agent, for a pre-start. */
  prepareRequest: RequestPreparer
  /** Answers the agent check of a session run's next request without sending it (`CapabilityPlanner`). */
  planCapabilities: CapabilityPlanner
  createLLMClient: LLMClientFactory
  /** The admitted runtime's guarded profile accounting authority. */
  readonly usageProfile?: AgentOptions["usageProfile"]
  /** Captures the account every client below this runtime spends, so an
   *  embedded child run (a benchmark) admits its whole matrix from one capture
   *  instead of resolving credentials again. */
  readonly captureProviderConnection: CaptureProviderConnection
  /** Capability boundary of the admitted operation this host settles (ARCH-RUNTIME-068):
   *  its grant, plus the policy anything it does not cover admits against. The
   *  root that admitted the launch or resume binds it, so every runner and tool
   *  below this host continues on that one grant. Absent when these deps were
   *  prepared with no policy (a test, an embedded host), and the host then
   *  admits nothing. */
  readonly capabilityAccess?: CapabilityAccess
  /** Runs one owned command for the git probes this host's handoff validation
   *  and artifact diffs make. */
  readonly runOwnedCommand: OwnedCommandRunner
  /** Resolves the `<env>` block every runner and compaction below shares. */
  readonly resolveEnvSnapshot: EnvCaptureResolver
  /** Captures current policy at each request or host-construction boundary. */
  readonly captureRuntimeConfig: CaptureRuntimeConfig
  /** Runtime-owned durable notification occurrence sink. */
  readonly onNotification?: (episode: NotificationEpisodeInput) => void
  /** The executor's command handover. Every agent's background owner that
   *  this host builds hands its commands over and adopts them through it.
   *  Absent where no account serves. */
  readonly commandHandover?: CommandHandoverAuthority
  /** The parent agent's controls of the children it started, which its
   *  `process` and `message_session` tools use, or nothing for a run
   *  without session authority (`PrepareWorkflowDepsInput.childSessions`). */
  readonly childSessions?: ChildSessionControl
  /** The run is headless (`PrepareWorkflowDepsInput.headless`): no client attaches, so its sessions keep their quick
   *  titles. */
  readonly headless?: true
  /** Resolves when the profile's model discovery, its access audit included, has settled; rejects when that
   *  discovery fails or `signal` aborts. An unattended run waits on it before it retries a model that is pending
   *  access. */
  readonly awaitModelAccessSettled: (signal: AbortSignal) => Promise<void>
}

/** A runnable workflow dependency set. Admission owns the required revision. */
export interface AdmittedWorkflowDeps extends WorkflowDeps {
  readonly definitionRevision: ProjectDefinitionRegistryRevision
}

interface SessionWorkflowDepsSource {
  capture(): Promise<WorkflowDeps>
  current(): WorkflowDeps
}

/** Binds every provider request below a runner to the owning session's latest
 * complete auth revision. The base retains project and lifecycle authorities;
 * only model-serving state is read through the session source. */
export function bindWorkflowDepsToSession(base: AdmittedWorkflowDeps, source: SessionWorkflowDepsSource): AdmittedWorkflowDeps
export function bindWorkflowDepsToSession(base: WorkflowDeps, source: SessionWorkflowDepsSource): WorkflowDeps
export function bindWorkflowDepsToSession(base: WorkflowDeps, source: SessionWorkflowDepsSource): WorkflowDeps {
  const captureModelRuntime = async () => {
    const current = await source.capture()
    return { generation: current, createLLMClient: current.createLLMClient, captureProviderConnection: current.captureProviderConnection }
  }
  return {
    ...base,
    get auth() { return source.current().auth },
    get availableModels() { return source.current().availableModels },
    get modelInfos() { return source.current().modelInfos },
    get modelsClient() { return source.current().modelsClient },
    get activeProfileId() { return source.current().activeProfileId },
    get usageProfile() { return source.current().usageProfile },
    captureRuntimeConfig: () => source.current().captureRuntimeConfig(),
    createAgent: (options) => base.createAgent({
      ...options,
      captureModelRuntime,
      captureProviderConnection: async () => (await source.capture()).captureProviderConnection(),
    }),
    prepareRequest: (options, preparation) => base.prepareRequest({
      ...options,
      captureModelRuntime,
      captureProviderConnection: async () => (await source.capture()).captureProviderConnection(),
    }, preparation),
    planCapabilities: (options) => base.planCapabilities({
      ...options,
      captureModelRuntime,
      captureProviderConnection: async () => (await source.capture()).captureProviderConnection(),
    }),
    createLLMClient: async (...args) => {
      const current = await source.capture()
      return current.createLLMClient(...args)
    },
    captureProviderConnection: async () => (await source.capture()).captureProviderConnection(),
  }
}

/** Dependency injection hooks for testing. Lives here (not in tests/) because
 *  prepareWorkflowDeps uses it as a parameter type. */
export interface WorkflowDepsOverrides {
  createAgent?: AgentFactory
  createLLMClient?: LLMClientFactory
  connection?: EffectiveProviderConnection
  availableModels?: ReadonlyMap<ModelFamily, ReadonlySet<string>>
  modelInfos?: ReadonlyMap<string, ModelInfo>
  moduleServices?: ModuleServices
}

export interface PrepareWorkflowDepsInput extends AccountDirectories {
  readonly capturedAuth?: AuthContext
  /** Definition owner the composition root created for this project. */
  definitions: ProjectDefinitionRegistry
  /** Immutable module composition captured once by the calling runtime root. */
  moduleSelection: FirstPartyModuleComposition | FirstPartyModuleSnapshot
  /** The process-scoped services of the enabled modules, handed to every runner these deps build. */
  moduleServices?: ModuleServices
  /** Launch authority every runner these deps build hands to its tools. A
   *  runtime generation owns exactly one, so binding it here is what makes
   *  every runner and subagent below launch into that generation. */
  launcher?: LauncherScope
  /** The executor's command handover, handed to every host and runner these
   *  deps build, so a child inherits it as it inherits the launcher. */
  commandHandover?: CommandHandoverAuthority
  /** The parent agent's controls of the children it started, which its
   *  `process` and `message_session` tools use. Absent only for a run
   *  without session authority (no `SessionManager`), such as a headless
   *  task or a skill maintenance run, which starts no children and
   *  messages no session. */
  childSessions?: ChildSessionControl
  /** Resolves stored credentials, running the helper a `!` key names. */
  resolveKey: KeyResolver
  /** Captures the effective credential directory before provider-sensitive preparation. */
  authDirectory?: () => string
  /** Captures the active auth profile id before provider-sensitive preparation. */
  activeProfileId?: () => string
  /** Profile-keyed eligibility captured when each request plans its provider chain. */
  providerModelEligibility?: () => WorkerProviderModelEligibility | undefined
  /** Joins the existing eligibility readiness owner at every request boundary. */
  captureModelAccess?: () => Promise<{ readonly worker: WorkerProviderModelEligibility; readonly auth?: AuthContext }>
  /** Captures allowance and consent from one usage service at provider admission. */
  captureSubscriptionAdmission?: CaptureSubscriptionAdmission
  acquireUsageSettlementAuthority?: (profile: { readonly profileDir: string; readonly profileId: string }) => Promise<import("../agent-runtime/usage-settlement.js").UsageSettlementAuthorityLease>
  /** Immutable identity of the profile Usage authority admitted for this runtime generation. */
  usageAuthority?: UsageAuthorityGeneration
  persistentProcesses?: PersistentProcessClient | BridgedPersistentProcessClient
  allowPersistentProcesses?: () => boolean | Promise<boolean>
  enforcedShellWriteGuard?: () => Promise<boolean>
  gitAiAttribution?: GitAiAttributionService
  streamingEditValidation?: StreamingEditValidationService
  overrides?: WorkflowDepsOverrides
  /** Global capability authority of this process (ARCH-RUNTIME-066). The boundary these
   *  deps carry is derived from it, so nothing about Learning or any other
   *  optional capability is copied into the deps as a flag. Absent in focused
   *  tests, whose hosts admit nothing. */
  capabilities?: Pick<ModulePolicy, "admit" | "state">
  /** Captures the current immutable next-request policy revision. */
  captureRuntimeConfig: CaptureRuntimeConfig
  /** Runtime-owned durable notification occurrence sink: the composition's notify seam, which the provider clients of
   *  the runtime also receive (`AccessProviderBuild.notify`). A composition where no person reads notifications, such
   *  as a headless run, passes one that only logs. */
  onNotification: (episode: NotificationEpisodeInput) => void
  /** Runtime authority captured at each provider request. */
  authConditions?: Pick<AuthConditionOwner, "snapshot" | "observeMutation">
  /** Receives every refusal of a model that a request of this runtime proved. */
  recordModelRefusal?: RecordModelRefusal
  /** Enables account login waiting only for an interactive executor. */
  waitForLogin?: true
  /** No client reviews this runtime's file changes (`RuntimeToolSurfaces.headless`). */
  headless?: true
  /** The eligibility owner's wait for the profile's discovery to settle (`WorkflowDeps.awaitModelAccessSettled`). */
  awaitModelAccessSettled: (signal: AbortSignal) => Promise<void>
}

export async function prepareWorkflowDeps(input: PrepareWorkflowDepsInput): Promise<WorkflowDeps> {
  const overrides = input.overrides
  const capturedProfileId = input.activeProfileId?.() ?? "default"
  const capturedAuthDirectory = input.authDirectory?.() ?? authDir(input.userDataRoot, capturedProfileId)
  const authDirectory = () => capturedAuthDirectory

  // One runner and one environment resolver per set of deps: every host, runner
  // and compaction built below probes this environment once and shares it.
  const runOwnedCommand = input.launcher ? ownedCommandRunner(input.launcher) : noLaunchAuthority
  const resolveEnvSnapshot = createEnvCaptureResolver(runOwnedCommand)

  const initialAuthDirectory = authDirectory()
  const initialModuleSelection = typeof input.moduleSelection === "function" ? input.moduleSelection() : input.moduleSelection
  const currentAuth = overrides?.connection?.auth ?? input.capturedAuth ?? await resolveAuthContext({ authDir: initialAuthDirectory, resolveKey: input.resolveKey, credentialProviderIds: installedCredentialProviderIds(), credentialSlotClassifier: credentialSlotClassifier(initialModuleSelection), definitions: accessProviderRegistry(initialModuleSelection).selection.definitions })
  const listedModelCatalog = overrides?.availableModels !== undefined
    ? { enabledModels: overrides.availableModels, modelInfos: overrides.modelInfos ?? new Map<string, ModelInfo>() }
    : overrides?.connection
      ? { enabledModels: new Map<ModelFamily, ReadonlySet<string>>(), modelInfos: new Map<string, ModelInfo>() }
      : await resolveEnabledProviderModelCatalog({
          userDataRoot: input.userDataRoot,
          authDirectory,
          moduleSelection: () => initialModuleSelection,
          auth: currentAuth,
        })
  const modelsClient = getSharedModelsClient(input.userDataRoot)

  const runtime = createAgentRuntime({
    getAuth: () => currentAuth,
    definitions: input.definitions,
    moduleSelection: input.moduleSelection,
    authDirectory,
    profileId: capturedProfileId,
    connection: overrides?.connection,
    userDataRoot: input.userDataRoot,
    modelsClient,
    moduleServices: overrides?.moduleServices ?? input.moduleServices,
    launcher: input.launcher,
    commandHandover: input.commandHandover,
    resolveEnvSnapshot,
    persistentProcesses: input.persistentProcesses,
    allowPersistentProcesses: input.allowPersistentProcesses,
    enforcedShellWriteGuard: input.enforcedShellWriteGuard,
    getProviderModelEligibility: input.providerModelEligibility,
    captureModelAccess: input.captureModelAccess,
    captureSubscriptionAdmission: input.captureSubscriptionAdmission,
    acquireUsageSettlementAuthority: input.acquireUsageSettlementAuthority,
    usageAuthority: input.usageAuthority,
    gitAiAttribution: input.gitAiAttribution,
    ...(input.streamingEditValidation ? { streamingEditValidation: input.streamingEditValidation } : {}),
    captureRuntimeConfig: input.captureRuntimeConfig,
    authConditions: input.authConditions,
    ...(input.recordModelRefusal === undefined ? {} : { recordModelRefusal: input.recordModelRefusal }),
    ...(input.waitForLogin === undefined ? {} : { waitForLogin: input.waitForLogin }),
    ...(input.headless ? { headless: true } : {}),
    notify: input.onNotification,
    awaitModelAccessSettled: input.awaitModelAccessSettled,
  })

  return {
    userDataRoot: input.userDataRoot,
    accountHome: input.accountHome,
    auth: currentAuth,
    availableModels: listedModelCatalog.enabledModels,
    modelInfos: listedModelCatalog.modelInfos,
    modelsClient,
    get activeProfileId() { return capturedProfileId },
    definitions: input.definitions,
    moduleSelection: runtime.moduleSelection,
    runOwnedCommand,
    resolveEnvSnapshot,
    captureRuntimeConfig: input.captureRuntimeConfig,
    createAgent: overrides?.createAgent ?? runtime.createAgent,
    prepareRequest: runtime.prepareRequest,
    planCapabilities: runtime.planCapabilities,
    createLLMClient: overrides?.createLLMClient ?? runtime.createLLMClient,
    ...(runtime.usageProfile ? { usageProfile: runtime.usageProfile } : {}),
    captureProviderConnection: runtime.captureProviderConnection,
    onNotification: input.onNotification,
    ...(input.capabilities ? { capabilityAccess: capabilityAccessFor(input.capabilities) } : {}),
    ...(input.commandHandover ? { commandHandover: input.commandHandover } : {}),
    ...(input.childSessions ? { childSessions: input.childSessions } : {}),
    ...(input.headless ? { headless: true } : {}),
    awaitModelAccessSettled: input.awaitModelAccessSettled,
  }
}

/** What every owned command reports for a host that was built with no launch
 *  authority: the command did not run. The git probes above already treat a
 *  non-zero exit as "git could not answer", so this host degrades exactly the
 *  way one on a machine without git does, and never launches anything. */
const noLaunchAuthority: OwnedCommandRunner = (command) => {
  log.warn("workflow host has no launch authority; a command was not run", { command: command[0] })
  return Promise.resolve({ exitCode: null, stdoutBytes: new Uint8Array(), stdout: "", stderr: "", timedOut: false })
}
