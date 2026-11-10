/**
 * The inputs of a run's requests: what a send's loop and a pre-start's preparation both read. Building them
 * resolves the model selection and its route, reads the environment, the instructions, and memory, plans the tools,
 * and builds the system prompt, the turn reminders, the request context, and the conversation's seed. The resources
 * of a send's turn (usage, request audit, the model-fallback notice, the checkpoint notes' legacy import, lifecycle
 * hooks) are built around them in runtime-assembly.ts.
 */

import { Effect, Scope } from "effect";
import { resolveConversationResources } from "../session/conversation-resources.js";
import { ownedCommandRunner } from "../../infra/owned-command.js";
import { loadEngineeringDoctrine, loadSystemPrompt } from "../../infra/agent-assets/system-prompt.js";
import { canonicalize } from "../../infra/canonical-name.js";
import { REASONING_EFFORTS, type ReasoningEffort } from "../../infra/llm/models.js";
import { composeModuleRuntimes, type ModuleRuntimes } from "../../infra/module-runtime.js";
import type { AgentLoopOptions } from "./agent-loop-types.js";
import type { ConversationMessage, ModelClient, ProviderSessionLifetime, ServingAttempt } from "./llm/types.js";
import { stableSystemPrompt, type SystemPromptTiers } from "./llm/system-prompt-tiers.js";
import { promptKindForPurpose } from "./agent-purpose.js";
import type { CaptureModelRuntime, LLMClientFactory } from "./factory.js";
import type { RuntimeConfigRequestCapture } from "./request-config.js";
import type { ProjectDefinitionRegistry, ProjectDefinitionRegistryRevision } from "../../workflows/definition-registry.js";
import type { AgentDefinition } from "../../infra/agent-definition.js";
import type { SkillDefinition } from "../../workflows/skill-schema.js";
import type { FirstPartyModule, FirstPartyModuleComposition } from "../modules.js";
import { createToolRegistry } from "../tool-catalog.js";
import { disabledAgentTypes, installedModules } from "../module-catalog.js";
import { skillLoadedFact } from "../../workflows/skill-facts.js";
import { selectedToolNames } from "./tools/tool-dispatch.js";
import { callerToolGrant, planToolExposure, type ToolGrant } from "./tools/tool-exposure-planner.js";
import { deriveChildRuntimeSurfaces, learningReviewToolNames, toolRegistryFromComposition } from "./tools/tool-registry.js";
import type { RecallPort } from "../../protocol/conversation-recall.js";
import type { KernelToolDeps, ServingModel } from "./tools/kernel-tool-deps.js";
import { requestKernel, sharesTreeHost, type KernelRequestFacts, type KernelRunFacts } from "./request-kernel.js";
import type { CapabilityCheck } from "../../infra/capability-text.js";
import { createModuleRuntimeServices, type ChildCapabilityRun } from "./module-runtime-services.js";
import { createRequestToolSurface, requestCapabilities, requestModelSelectionKey, type PlannedRequest, type RequestModelSelection, type RequestProviderRuntime } from "./request-tool-surface.js";
import { resolveModelInteractionProfile } from "./model-interaction-profile.js";
import type { Agent, AgentOptions, RunnableAgentOptions, RuntimeToolSurfaces } from "./types.js";
import { createChildSlotRegistry } from "./child-slot-registry.js";
import { loadAgentInstructions } from "./project-instructions.js";
import { buildSystemPrompt } from "./system-prompt.js";
import { readModuleMemory, requestSystemPromptOptions } from "./request-system-prompt.js";
import { turnReminders, type TurnReminderState } from "./turn-reminders.js";
import { budgetStreamIdOf, prepareRuntimeUsage } from "./runtime-usage.js";
import { ProviderRuntimeCache, providerRuntimeRoutingKey } from "./provider-runtime-cache.js";
import { createRuntimeRequestAudit, type RuntimeConversation } from "./runtime-conversation.js";
import { withTurnRequestScope } from "./turn-request-model-client.js";
import { modelRequestRoute } from "./active-request-context.js";
import { assembleInitialRequestContextWithSessionNotes, createRuntimeSessionNotes, importLegacyRuntimeSessionNotes } from "./runtime-session-notes.js";
import { resolveCapturedRole } from "../config/role-resolution.js";
import { createModelFallbackNotice } from "./model-fallback-notice.js";
import { ModelUnavailable } from "./errors.js";
import { commitToolNotice, toolNotice } from "./tool-notice.js";
import { createCapabilityNarrowing, narrowingStatements, recordingNarrowings } from "./capability-narrowing.js";
import { agentTypesTurnedOffSince } from "../app-service/definition-availability.js";
import { holdSharedTree, treeLogin, type SharedTree, type SharedTreeCapture } from "./shared-tree.js";

/** What builds the inputs of a run's requests: the same for a send and for a pre-start. */
export interface RequestInputsSource {
  /** Completion is in the type: runtime surfaces are attached by the runner
   *  before assembly, never guessed here. */
  options: RunnableAgentOptions;
  /** Definition owner of this runner's project: its briefs, its workflow
   *  summaries, and the live skill revision the model-callable tools read. */
  definitions: ProjectDefinitionRegistry;
  conversation: RuntimeConversation;
  /** Personas this runner may dispatch, captured once for its whole lifetime.
   *  Assembly never reads the persona tree itself: a turn must compose from the
   *  same registry the run started with. */
  personas: ReadonlyMap<string, AgentDefinition>;
  loadedSkillIds?: Set<string>;
  loadedBundledSkillIds?: Set<string>;
  captureModelRuntime: CaptureModelRuntime;
  createRunner: (options: RunnableAgentOptions) => Agent;
  providerRuntimeCache?: ProviderRuntimeCache<ModelClient>;
  providerSessionLifetime: ProviderSessionLifetime;
  /** The scope that closes when this run ends, when its provider lifetime outlives it (`AgentOptions.providerSession`).
   *  What only the run needs, such as its hold of its chat tree's shared state, ends with it. Absent when the provider
   *  lifetime is the run's own. */
  runScope?: Scope.Scope;
}

/** The resources of a send's turn that its request inputs read while they are built: the usage that scopes each
 *  request's client, the transcript's model-fallback notice, and the hooks that announce a captured configuration
 *  and a new module runtime generation. A pre-start has none of them, because it sends no request. */
interface TurnHooks {
  readonly usage: Awaited<ReturnType<typeof prepareRuntimeUsage>>;
  readonly auxiliaryRequestAudit: ReturnType<typeof createRuntimeRequestAudit>;
  readonly recordServingSelection: ReturnType<typeof createModelFallbackNotice>;
}

/** How the request inputs are built: for a send with its turn's hooks, or for a pre-start, which `signal` stops. */
export type RequestInputsUse =
  | { readonly kind: "send"; readonly turn: TurnHooks }
  | { readonly kind: "prestart"; readonly signal: AbortSignal };

/** What a run's requests are made of: the model selection and its route, the environment, the instructions and
 *  memory, the tool plan, the system prompt, the turn reminders, the request context, and the conversation's seed.
 *  A send's loop reads them (`AgentLoopOptions`), and so does a pre-start (`prepareRequest`). */
export type RequestInputs = Pick<AgentLoopOptions,
  | "client" | "initialPlannedAttempt" | "initialInteractionProfile" | "tools" | "systemPrompt" | "turnReminders"
  | "literalSystemPrompt" | "initialRequestContext" | "executionCwd" | "seed" | "persistence" | "reasoningEffort"
  | "providerOptions" | "cacheRetention" | "providerSessionKey" | "promptCacheKey" | "sessionId" | "conversationId"
  | "sessionEventStore" | "sessionEventReader">;

interface AssembledRequestInputs {
  readonly request: RequestInputs;
  /** The serving attempt that the run's first request plans. */
  readonly planned: ServingAttempt;
  readonly moduleRuntimes: ModuleRuntimes;
  readonly checkpoint: AgentLoopOptions["checkpoint"];
  readonly scratchDir: string | undefined;
  /** Writes the checkpoint notes that a build before the checkpoint kept as files, once. A durable write, so only a
   *  send's turn runs it. */
  readonly importLegacyNotes: () => Promise<void>;
  /** Reloads memory and project instructions at the person's next turn. */
  readonly onPersonTurn: (() => void) | undefined;
}

// A learning review calls only the tools its registrations mark, ambient ones
// included; every other tool stays advertised and refuses its call.
const LEARNING_REVIEW_GRANT: ToolGrant = { tools: learningReviewToolNames(createToolRegistry()), ambient: false };
// A side call answers in text: it is advertised its tree's tools and calls none.
const SIDE_CALL_GRANT: ToolGrant = { tools: new Set(), ambient: false };

// Runner options carry effort as free-form config text (external boundary);
// the provider request takes the canonical vocabulary or nothing.
function mapEffort(effort: string | undefined): ReasoningEffort | undefined {
  if (!effort) return undefined;
  const normalized = canonicalize(effort);
  return REASONING_EFFORTS.find((tier) => tier === normalized);
}

function learningReview(options: AgentOptions) {
  return options.purpose.kind === "chat-learning-review" ? options.purpose.review : undefined;
}

/** What the runner may call: a side call's fixed grant, or the caller's (`callerToolGrant`). */
function toolGrantOf(options: AgentOptions): ToolGrant | undefined {
  switch (options.purpose.kind) {
    case "chat-learning-review":
      return LEARNING_REVIEW_GRANT;
    case "session-title":
    case "learning-review-audit":
    case "chat-side-call":
    case "subagent-failure-summary":
      return SIDE_CALL_GRANT;
    default:
      return options.toolGrant && callerToolGrant(options.toolGrant, options.withheldTools);
  }
}

/** The shared tree that each owner scope holds. A scope holds its tree once, however many assemblies read it, such as
 *  the turns of one run or the pre-starts of one shown session. */
const treeHolds = new WeakMap<Scope.Scope, SharedTree>();

/** The provider lifetime of a runner of the chat tree rooted at `rootSessionId`. Every such runner, the tree's chat
 *  included, prefers the login of the tree's live host; only a tree-hosted runner shares that host, and it holds the
 *  tree's shared state until its owner scope closes: its run's scope (`runScope`), or else the scope of its provider
 *  lifetime, such as the provider session of a shown session, which a pre-start takes. A host that the run opened
 *  holds the tree while it lives. */
function treeLifetime(lifetime: ProviderSessionLifetime, runScope: Scope.Scope | undefined, rootSessionId: string | undefined, treeHosted: boolean, capture: () => SharedTreeCapture): ProviderSessionLifetime {
  if (rootSessionId === undefined) return lifetime;
  const routed: ProviderSessionLifetime = { ...lifetime, treeLogin: () => treeLogin(rootSessionId) };
  if (!treeHosted) return routed;
  const owner = runScope ?? lifetime.scope;
  let tree = treeHolds.get(owner);
  if (tree === undefined) {
    const hold = holdSharedTree(rootSessionId, capture);
    Effect.runSync(Scope.addFinalizer(owner, Effect.sync(hold.release)));
    tree = hold.tree;
    treeHolds.set(owner, tree);
  }
  return { ...routed, sharedHost: tree };
}

/** The fixed prompt of a run whose purpose carries one: a headless task, a learning review's audit, a session title, or
 *  a failure summary. */
function headlessPromptOf(purpose: AgentOptions["purpose"]) {
  return "prompt" in purpose ? purpose.prompt : undefined;
}

/** What plans the tools of a run's requests: the run's source, its session identity, the shared state of its chat
 *  tree when it is tree-hosted, and its turn when it sends. */
interface RunToolsSource {
  readonly input: Omit<RequestInputsSource, "providerRuntimeCache" | "providerSessionLifetime" | "runScope">;
  readonly runtimeIdentity: Awaited<ReturnType<NonNullable<RuntimeToolSurfaces["sessions"]>["identity"]>> | undefined;
  readonly tree: SharedTree | undefined;
  readonly turn?: TurnHooks;
  /** The serving model that the module runtimes read; absent for a capability plan. */
  readonly servingModel?: ServingModel;
  /** What a request's provider runtime gives its kernel: its serving model and its file-edit contract. A capability
   *  plan has no provider runtime and gives neither. */
  readonly serving: (providerRuntime: RequestProviderRuntime | undefined) => Pick<KernelRequestFacts, "servingModel" | "fileEditContract">;
}

/** The modules that a request's plan admits, and the modules that its own selection enables (`live`). A tree-hosted
 *  request plans from the tree's capture and narrows to its own selection. */
function requestModulesOf(options: RunnableAgentOptions, tree: SharedTree | undefined) {
  return {
    requestModules: tree === undefined ? options.moduleSelection : () => tree.modules,
    liveModules: (requestModuleSnapshot: FirstPartyModuleComposition): FirstPartyModuleComposition => tree === undefined ? requestModuleSnapshot : options.moduleSelection(),
  };
}

function treeCaptureOf(options: RunnableAgentOptions): SharedTreeCapture {
  const config = options.captureRuntimeConfig();
  return { modules: options.moduleSelection(), shellWriteGuard: config.shellWriteGuard, allowPersistentProcesses: config.allowPersistentProcesses, disabledTypes: disabledAgentTypes(config.moduleSections) };
}

async function runtimeIdentityOf(options: RunnableAgentOptions, sessionId: string | undefined): Promise<RunToolsSource["runtimeIdentity"]> {
  return sessionId && options.runtimeSurfaces.sessions ? await options.runtimeSurfaces.sessions.identity(sessionId) : undefined;
}

// The surfaces that a child gets once it is published: its own handoff, background owner, and recall. A capability
// plan reads only that they are there, and calls none of them.
const PLANNED_CHILD_HANDOFF: NonNullable<RuntimeToolSurfaces["handoff"]> = { onContent: () => { throw new Error("A capability plan runs no tool.") } };
const PLANNED_CHILD_RECALL: RecallPort = () => Promise.reject(new Error("A capability plan runs no tool."));

/** The options that the first request of a child that `options` start plans from: this run's options with the
 *  child's purpose and grant, and the runtime surfaces that a child gets (`deriveChildRuntimeSurfaces`). */
export function childRunOptions(options: RunnableAgentOptions, child: ChildCapabilityRun): RunnableAgentOptions {
  const { toolNames: _names, toolActions: _actions, toolProfile: _profile, toolGrant: _grant, withheldTools: _withheld, readOnly: _readOnly, allowedSubagentTypes: _types, ...run } = options;
  const surfaces = options.runtimeSurfaces;
  return {
    ...run, ...child,
    runtimeSurfaces: {
      ...deriveChildRuntimeSurfaces(surfaces, { handoff: PLANNED_CHILD_HANDOFF, ...(surfaces.background ? { background: surfaces.background } : {}) }),
      recall: PLANNED_CHILD_RECALL,
    },
  };
}

/** Plans the tools of a run's requests: the one path that a send, a pre-start, and a capability plan
 *  (`planRunCapabilities`) take. It builds the run's module runtimes and its kernel for each request. */
function runToolPlanner(source: RunToolsSource) {
  const { input, runtimeIdentity, tree, turn } = source;
  const { options, definitions, conversation, createRunner } = input;
  const promptKind = promptKindForPurpose(options.purpose);
  const sessionId = conversation.sessionId;
  const review = learningReview(options);
  const { liveModules } = requestModulesOf(options, tree);
  // Module auxiliary work can outlive this run. Its caller supplies any retained provider lifetime.
  const createLLMClient: LLMClientFactory = async (model, moduleSnapshot, runtimeConfig, lifetime) => {
    const capture = await input.captureModelRuntime();
    return capture.createLLMClient(model, moduleSnapshot, runtimeConfig, lifetime);
  };
  const runtimeSurfaces = options.runtimeSurfaces;
  const background = runtimeSurfaces.background;
  const childSlots = options.childSlots ?? createChildSlotRegistry();
  const registry = input.personas;
  const selected = selectedToolNames(options);
  const granted = toolGrantOf(options);
  // Dispatching a subagent starts work that outlives this turn, so it takes a
  // host that owns it. No owner, no dispatch surface.
  const dispatchOwner = registry.size > 0 ? background : undefined;
  const resources = resolveConversationResources(options.sessionDir, conversation.aggregateId, review?.reviewRunId, runtimeIdentity?.importedResources);
  const checkpointOwner = conversation.requestAccounting?.owner ?? (sessionId ? { kind: "session" as const, sessionId } : undefined);
  const checkpointConversationId = review?.reviewRunId ?? conversation.aggregateId;
  const checkpoint = createRuntimeSessionNotes(options, checkpointConversationId, checkpointOwner);

  // Loads survive every wake of this retained runner. Learning review needs all
  // loaded IDs, while execution policy trusts bundled package authority only.
  const { loadedSkillIds = new Set<string>(), loadedBundledSkillIds = new Set<string>() } = input;

  // A child plans from this run's conversation: the tree it shares and the
  // checkpoint it gets are this run's tree and a checkpoint of its own.
  const planChildCapabilities = (child: ChildCapabilityRun): Promise<CapabilityCheck> => planRunCapabilities({
    options: childRunOptions(options, child), definitions, conversation, personas: registry,
    captureModelRuntime: input.captureModelRuntime, createRunner,
  });
  const services = createModuleRuntimeServices({
    options, conversation, definitions, promptKind, personas: registry, childSlots,
    ...(source.servingModel ? { servingModel: source.servingModel } : {}),
    createRunner, planChildCapabilities, createLLMClient, loadedSkillIds,
    budgetStreamId: budgetStreamIdOf(conversation),
    auxiliaryRequestAudit: turn?.auxiliaryRequestAudit ?? createRuntimeRequestAudit(options, conversation),
    ...(turn?.usage.usageSettlement ? { usageSettlement: turn.usage.usageSettlement } : {}),
    ...(review ? { review } : {}),
    ...(dispatchOwner ? { dispatchOwner } : {}),
  });
  // Module runtimes follow each request's module snapshot (ARCH-STRUCTURE-027). A
  // module's runtime is built the first time a request finds the module
  // enabled and lives as long as the runner; a module that was never enabled
  // never runs its factory. Each generation holds only the modules its
  // request enables, and the host hears every new generation before the
  // request that planned it is sent.
  const runtimeInstances = new Map<string, unknown>();
  let runtimeGeneration: { readonly key: string; readonly modules: ModuleRuntimes } | undefined;
  const moduleRuntimesFor = async (requestModuleSnapshot: FirstPartyModuleComposition): Promise<ModuleRuntimes> => {
    const enabledModuleIds = new Set(requestModuleSnapshot.enabledModuleIds);
    const enabled = installedModules().flatMap((module: FirstPartyModule) => module.runtime && enabledModuleIds.has(module.id) ? [{ id: module.id, runtime: module.runtime }] : []);
    const key = enabled.map(({ id }) => id).join("\u0000");
    if (runtimeGeneration?.key === key) return runtimeGeneration.modules;
    for (const { id, runtime } of enabled) if (!runtimeInstances.has(id)) runtimeInstances.set(id, runtime.create(services));
    const modules = composeModuleRuntimes(enabled.map(({ id }) => [id, runtimeInstances.get(id)] as const));
    runtimeGeneration = { key, modules };
    if (turn) await options.lifecycle.onRuntimeAssembled?.({ modules });
    return modules;
  };
  // Tool execution reads the generation that its request planned.
  const moduleRuntimes: ModuleRuntimes = { get: (handle) => runtimeGeneration?.modules.get(handle) };

  const onSkillLoad = async (skill: SkillDefinition): Promise<void> => {
    if (review && !options.sessionEventWriter) throw new Error("self-review skill loads require a durable fact writer");
    if (options.sessionEventWriter) {
      const stored = await options.sessionEventWriter.record(skillLoadedFact({ name: skill.id }));
      if (!stored) throw new Error("skill load fact writer was disposed before the load landed");
    }
    loadedSkillIds.add(skill.id);
    if (skill.source.authority === "bundled") loadedBundledSkillIds.add(skill.id);
  };
  // What every request of the run gives its kernel (`requestKernel`).
  const kernelRun: KernelRunFacts = {
    options,
    surfaces: runtimeSurfaces,
    personas: registry,
    ...(background ? { backgroundTasks: background.tasks } : {}),
    ...(checkpoint ? { checkpoint } : {}),
    treeHosted: sharesTreeHost(options.purpose),
    captureProviderConnection: async () => {
      const runtime = await input.captureModelRuntime();
      if (!runtime.captureProviderConnection) throw new Error("This runtime has no model access capture.");
      return runtime.captureProviderConnection();
    },
    onSkillLoad,
  };
  const kernelOf = (
    requestModuleSnapshot: FirstPartyModuleComposition,
    runtimeConfig: RuntimeConfigRequestCapture,
    providerRuntime: RequestProviderRuntime | undefined,
    definitionRevision: ProjectDefinitionRegistryRevision,
    live: FirstPartyModuleComposition = liveModules(requestModuleSnapshot),
  ): KernelToolDeps => requestKernel(kernelRun, {
    moduleSnapshot: requestModuleSnapshot, live, runtimeConfig, definitions: definitionRevision,
    shellWriteGuard: tree?.shellWriteGuard ?? runtimeConfig.shellWriteGuard,
    persistentProcessesAdvertised: tree?.allowPersistentProcesses ?? runtimeConfig.allowPersistentProcesses,
    treeDisabledTypes: tree?.disabledTypes ?? disabledAgentTypes(runtimeConfig.moduleSections),
    ...source.serving(providerRuntime),
  });
  const planRequestTools = async (
    requestModuleSnapshot: FirstPartyModuleComposition,
    runtimeConfig: RuntimeConfigRequestCapture,
    providerRuntime: RequestProviderRuntime | undefined,
  ): Promise<PlannedRequest> => {
    const live = liveModules(requestModuleSnapshot);
    // Read now, not captured at assembly: the skill tool must observe the
    // revision published when this request is planned.
    const kernel = kernelOf(requestModuleSnapshot, runtimeConfig, providerRuntime, definitions.captureRevision(), live);
    const plan = await planToolExposure({
      kernel,
      modules: await moduleRuntimesFor(requestModuleSnapshot),
      registry: toolRegistryFromComposition(requestModuleSnapshot),
      ...(live === requestModuleSnapshot ? {} : { live }),
      ...(selected ? { selected } : {}),
      ...(granted ? { granted } : {}),
      ...(options.toolProfile ? { profile: options.toolProfile } : {}),
    });
    return { ...plan, definitionAvailability: kernel.definitionAvailability, ...(kernel.allowedSubagentTypes ? { allowedSubagentTypes: kernel.allowedSubagentTypes } : {}) };
  };
  return { planRequestTools, kernelOf, moduleRuntimesFor, moduleRuntimes, checkpoint, checkpointOwner, checkpointConversationId, resources };
}

/** What a capability plan reads: the run's options and conversation and the authorities that build its runs. */
export type RunCapabilitySource = Pick<RequestInputsSource, "options" | "definitions" | "conversation" | "personas" | "captureModelRuntime" | "createRunner">;

/**
 * The agent check of the first request of the run that `options` describe (ARCH-CONTEXT-033): that request's tool
 * plan, through the path that the request takes, with no model route. It resolves no model and no provider client,
 * so it never waits for model access, and it sends no request and writes no fact. A tool's logical identity does not
 * depend on the serving model: the registrations that a model's interaction profile selects between, such as `edit`
 * and `apply_patch`, are one tool. A tree-hosted run plans from its chat tree's shared state and holds that state
 * only while it plans. The module runtimes that it creates end with the plan, and no `onRuntimeAssembled` announces
 * them. The text that only the run's agent reads, such as its opening turn, renders from the answer.
 */
export async function planRunCapabilities(input: RunCapabilitySource): Promise<CapabilityCheck> {
  const { options, conversation } = input;
  const runtimeIdentity = await runtimeIdentityOf(options, conversation.sessionId);
  const treeRoot = runtimeIdentity?.rootSessionId ?? options.treeRootSessionId;
  const hold = sharesTreeHost(options.purpose) && treeRoot !== undefined ? holdSharedTree(treeRoot, () => treeCaptureOf(options)) : undefined;
  try {
    const { planRequestTools } = runToolPlanner({ input, runtimeIdentity, tree: hold?.tree, serving: () => ({}) });
    const { requestModules } = requestModulesOf(options, hold?.tree);
    return requestCapabilities(await planRequestTools(requestModules(), options.captureRuntimeConfig(), undefined));
  } finally {
    hold?.release();
  }
}

/** The inputs of a run's requests, opened: the serving attempt that the run's first request plans, which the model
 *  selection and the resolve of the session's client decided, and the build of the rest. */
interface OpenedRequestInputs {
  readonly planned: ServingAttempt;
  /** Reads the environment, the conversation's seed, the instructions, and memory, plans the tools, and builds the
   *  system prompt and the turn reminders (`RequestInputs`). */
  build(): Promise<AssembledRequestInputs>;
}

/** Opens the inputs of a run's requests (`RequestInputs`): it resolves the model selection and the session's client,
 *  and builds the rest only when `build` is called, so a pre-start can stop before it reads the environment, the
 *  history, the tools, or the prompt. For a pre-start, the module runtimes that tool planning creates live only as long
 *  as the returned inputs, and no `onRuntimeAssembled` announces them: that hook announces a generation before a
 *  request that is sent, and a pre-start sends none. */
export async function openRequestInputs(input: RequestInputsSource, use: RequestInputsUse): Promise<OpenedRequestInputs> {
  const { options } = input;
  const conversation = input.conversation;
  const sessionId = conversation.sessionId;
  const conversationAggregateId = conversation.aggregateId;
  const headlessPrompt = headlessPromptOf(options.purpose);
  const turn = use.kind === "send" ? use.turn : undefined;

  const { runtimeSurfaces } = options;
  const providerRuntimeCache = input.providerRuntimeCache ?? new ProviderRuntimeCache<ModelClient>();
  const captureSelection = async (runtimeConfig: RuntimeConfigRequestCapture, moduleSnapshot: FirstPartyModuleComposition): Promise<RequestModelSelection> => {
    const runtime = await input.captureModelRuntime();
    const connection = await runtime.captureProviderConnection?.(runtimeConfig, liveModules(moduleSnapshot));
    const roles = await options.resolveRoles?.(connection) ?? new Map();
    const selected = options.requestSelection ? await options.requestSelection(roles) : {
      model: options.model,
      effort: typeof options.effort === "function" ? await options.effort() : options.effort,
      providerOptions: options.providerOptions,
    };
    return { ...selected, effort: mapEffort(selected.effort), capture: { runtime, connection } };
  };
  const prepareProviderRuntime = async (requestModuleSnapshot: FirstPartyModuleComposition, requestedConfig: RuntimeConfigRequestCapture, capturedSelection?: RequestModelSelection): Promise<RequestProviderRuntime> => {
    const authored = capturedSelection ?? await captureSelection(requestedConfig, requestModuleSnapshot);
    const modelRuntime = authored.capture?.runtime ?? await input.captureModelRuntime();
    const capture = authored.capture?.connection;
    const runtimeConfig = capture?.runtimeConfig ?? requestedConfig;
    if (turn && options.onRuntimeConfigCapture) await options.onRuntimeConfigCapture(runtimeConfig);
    const setting = authored.setting ?? authored;
    const resolved = capture && options.requestSelection
      ? await resolveCapturedRole(authored.roleId ?? "chat", {
        model: setting.model, effort: setting.effort, provider_options: setting.providerOptions, fixedEffort: authored.setting?.fixedEffort,
      }, { selection: capture.providers.selection, connection: capture.connection, eligibility: capture.eligibility, allowTrainingRoutes: runtimeConfig.allowTrainingRoutes }, options.userDataRoot)
      : undefined;
    if (resolved && resolved.kind !== "selected") throw new ModelUnavailable({
      missing: resolved.kind === "access-pending" ? "access" : "provider",
      message: resolved.kind === "access-pending" ? "Model access is still being checked." : "The active profile has no reachable model.",
    });
    const selection = resolved?.kind === "selected" ? { ...resolved.role, effort: mapEffort(resolved.role.effort) } : authored;
    if (resolved?.kind === "selected") await turn?.recordServingSelection?.({ saved: authored.setting?.model, model: resolved.role.model, effort: selection.effort });
    const { model, providerOptions } = selection;
    if (!model) throw new ModelUnavailable({ missing: "provider", message: "The active profile has no reachable model." });
    const capturedCreateLLMClient = resolved?.kind === "selected" && capture
      ? capture.admit(new Map([[model, resolved.plan]])).createLLMClient
      : modelRuntime.createLLMClient;
    const routingKey = providerRuntimeRoutingKey(model, providerOptions, runtimeConfig.providerSettings);
    const providerModules = liveModules(requestModuleSnapshot);
    // A pre-start that its owner stopped, as when the chat's turn started, never replaces the client that a send uses.
    if (use.kind === "prestart") use.signal.throwIfAborted();
    const cachedClient = await providerRuntimeCache.resolve(providerModules, modelRuntime.generation, routingKey, (lifetime) => capturedCreateLLMClient(model, providerModules, runtimeConfig, lifetime),
      { lifetime: providerSessionLifetime, eligibilityGeneration: capture?.eligibility });
    const client = turn ? withTurnRequestScope(cachedClient, turn.usage.usageTracker) : cachedClient;
    const interactionProfile = resolveModelInteractionProfile(cachedClient.model, cachedClient.modelFamily);
    const admittedRequest = await client.admitRequest();
    const plannedAttempt = await admittedRequest.plannedAttempt(providerOptions);
    const mainRoute = modelRequestRoute(client, providerOptions);
    return {
      mainRoute,
      plannedAttempt,
      admittedRequest,
      interactionProfile,
      role: { model, effort: selection.effort, providerOptions },
      selectionKey: requestModelSelectionKey(authored),
      selectionGeneration: capture ? modelRuntime.generation : undefined,
      selectionEligibility: capture?.eligibility,
      runtimeConfig,
    };
  };
  // Resolve independent prompt inputs before capturing the first request's
  // immutable auth, quota, and consent evidence. A pre-start reads the
  // environment only once it builds the rest of its request.
  const readEnvSnapshot = () => options.resolveEnvSnapshot?.({ projectRoot: options.projectRoot, executionCwd: options.executionCwd });
  const [sendEnvSnapshot, runtimeIdentity] = await Promise.all([
    use.kind === "send" ? readEnvSnapshot() : undefined,
    runtimeIdentityOf(options, sessionId),
  ]);
  // Memory and project instructions take effect when the run starts and, in a
  // chat, when the person starts a turn with a message or a Resume
  // (ARCH-LEARNING-009, PI-AGENT-037). The prompt build reads them, the first
  // build after the boundary loads the current bytes, and every later request
  // of that turn reuses them, so one turn keeps one system prompt. A
  // background notice starts no reload. An override is fixed by its owner and
  // never reloads, such as a workflow's frozen memory. A subagent takes no
  // override: it loads the chain for its own directory at its start, so an
  // edit reaches a child that starts later in the dispatcher's turn.
  let turnAgentsMd: { readonly value: string | undefined } | undefined;
  let turnMemory: { readonly value: string | null } | undefined;
  const agentsMd = (): string | undefined => options.agentsMd ?? (turnAgentsMd ??= {
    value: loadAgentInstructions({
      executionCwd: options.executionCwd,
      projectRoot: options.projectRoot,
      accountHome: options.accountHome,
      userDataRoot: options.userDataRoot,
      ...(runtimeSurfaces.launcher ? { runCommand: ownedCommandRunner(runtimeSurfaces.launcher) } : {}),
    }),
  }).value;
  // Participation is decided per request (`requestSystemPromptOptions`): a
  // request that does not hold Learning carries no memory, whatever the turn
  // captured.
  const memory = (requestModuleSnapshot: FirstPartyModuleComposition): string | null => options.memorySnapshot !== undefined
    ? options.memorySnapshot
    : (turnMemory ??= { value: readModuleMemory(requestModuleSnapshot, options) }).value;
  const refreshesAtPersonTurn = options.purpose.kind === "interactive-chat";
  const onPersonTurn = (): void => {
    turnAgentsMd = undefined;
    turnMemory = undefined;
  };
  const treeHosted = sharesTreeHost(options.purpose);
  // A tree-hosted runner holds its tree's shared state for its provider
  // lifetime and plans every request from the tree's capture, so its
  // tools match every other agent of the tree host byte for byte. Its own
  // selection (`live`) narrows what it may call and alone admits providers:
  // the capture fixes advertised tools, never provider admission
  // (ARCH-RUNTIME-068). The tree's first tree-hosted runner takes the capture,
  // whatever provider serves it, because a failover can move any request of
  // the tree onto the host, and the host must then see the same tools.
  const treeRoot = runtimeIdentity?.rootSessionId ?? options.treeRootSessionId;
  const providerSessionLifetime = treeLifetime(input.providerSessionLifetime, input.runScope, treeRoot, treeHosted, () => treeCaptureOf(options));
  const tree = providerSessionLifetime.sharedHost;
  const { requestModules, liveModules } = requestModulesOf(options, tree);
  const moduleSnapshot = requestModules();
  const initialProviderRuntime = await prepareProviderRuntime(moduleSnapshot, options.captureRuntimeConfig());
  return {
    planned: initialProviderRuntime.plannedAttempt,
    async build(): Promise<AssembledRequestInputs> {
      const envSnapshot = use.kind === "send" ? sendEnvSnapshot : await readEnvSnapshot();
      const initialRuntimeConfig = initialProviderRuntime.runtimeConfig ?? options.captureRuntimeConfig();
      const client = initialProviderRuntime.mainRoute.client;
      const planned = initialProviderRuntime.plannedAttempt;
      const { planRequestTools, kernelOf, moduleRuntimesFor, moduleRuntimes, checkpoint, checkpointOwner, checkpointConversationId, resources } = runToolPlanner({
        input, runtimeIdentity, tree, ...(turn ? { turn } : {}),
        servingModel: {
          model: client.model,
          modelFamily: client.modelFamily,
          ...(planned.availableModels ? { availableModels: planned.availableModels } : {}),
        },
        serving: (providerRuntime) => {
          const requestClient = providerRuntime?.mainRoute.client ?? client;
          const requestPlan = providerRuntime?.plannedAttempt ?? planned;
          return {
            fileEditContract: providerRuntime?.interactionProfile.fileEditContract ?? initialProviderRuntime.interactionProfile.fileEditContract,
            servingModel: {
              model: requestClient.model,
              modelFamily: requestClient.modelFamily,
              ...(providerRuntime?.role?.effort ? { effort: providerRuntime.role.effort } : {}),
              ...(providerRuntime?.mainRoute.providerOptions ? { providerOptions: providerRuntime.mainRoute.providerOptions } : {}),
              ...(requestPlan.availableModels ? { availableModels: requestPlan.availableModels } : {}),
            },
          };
        },
      });
      const { scratchDir } = resources;
      await moduleRuntimesFor(moduleSnapshot);

      const toolSurface = await createRequestToolSurface(
        planRequestTools,
        requestModules,
        options.captureRuntimeConfig,
        prepareProviderRuntime,
        captureSelection,
        { moduleSnapshot, runtimeConfig: initialRuntimeConfig, providerRuntime: initialProviderRuntime },
      );

      // Request-stable prompt ingredients are assembled and transformed once. The
      // serving attempt appends only provider interaction notes after transformation.
      const corePrompt = headlessPrompt?.kind === "assembled" ? headlessPrompt.corePrompt : loadSystemPrompt(options);
      const engineeringDoctrine = headlessPrompt?.kind === "literal" || options.engineeringDoctrine === false ? undefined : loadEngineeringDoctrine(options);
      const systemPrompt = async (_attempt: ServingAttempt, interactionProfile: ReturnType<typeof resolveModelInteractionProfile>): Promise<SystemPromptTiers> => {
        const request = toolSurface.current();
        if (headlessPrompt?.kind === "literal") return stableSystemPrompt(headlessPrompt.systemPrompt);
        return buildSystemPrompt(await requestSystemPromptOptions({
          purpose: options.purpose,
          corePrompt,
          engineeringDoctrine,
          agentsMd: agentsMd(),
          envBlock: envSnapshot?.envBlock,
          scratchDir,
          checkpoint: checkpoint !== undefined,
          selfDebug: Boolean(options.sessionEventStore && conversationAggregateId),
          // Read once for the runtime: the identity changes only when another parent
          // adopts the session, so every request of this runtime carries one text.
          sessionIdentity: runtimeIdentity,
          interactionProfile,
          moduleSnapshot: request.moduleSnapshot,
          tools: request.tools,
          registrationIdentities: request.registrationIdentities,
          kernel: kernelOf(request.moduleSnapshot, request.runtimeConfig, request.providerRuntime, request.definitionAvailability.tree.definitionRevision),
          modules: await moduleRuntimesFor(request.moduleSnapshot),
          memory,
        }));
      };

      // A literal headless prompt carries no module guidance, so it carries no
      // module reminder either. A disabled module's reminder still reads the
      // history, so its `off` statement reaches the model.
      const turnReminderStates = async (): Promise<readonly TurnReminderState[]> => {
        if (headlessPrompt?.kind === "literal") return [];
        const request = toolSurface.current();
        const reminderInput = {
          kernel: kernelOf(request.moduleSnapshot, request.runtimeConfig, request.providerRuntime, request.definitionAvailability.tree.definitionRevision),
          modules: await moduleRuntimesFor(request.moduleSnapshot),
          tools: request.tools,
        };
        return request.moduleSnapshot.installedContributions.flatMap((contribution) => contribution.domain === "turnReminders" ? [{
          ...contribution.value, id: contribution.id,
          holds: request.moduleSnapshot.enabledModuleIds.includes(contribution.module) && contribution.value.holds(reminderInput),
        }] : []);
      };

      // The resolved conversation owns seed and persistence together.
      const persistence = { ...conversation.persistence, history: recordingNarrowings(conversation.persistence.history, sessionId) };
      // A tree-hosted agent learns from its first plan which advertised tools it
      // may not call: committed once into a durable conversation's opening turn,
      // or request context for a conversation that keeps no history. A committed
      // notice also states the modules that the first plan turned off.
      const notice = treeHosted ? toolNotice(toolSurface.current(), options.readOnly === true) : undefined;
      // The narrowing reads the modules that the current request's plan refuses
      // as turned off, and the agent types that its live availability refuses
      // while the tree's text offers them, so the statement and the refusals of
      // one request agree.
      const narrowing = treeHosted ? createCapabilityNarrowing(() => toolSurface.current().moduleSnapshot) : undefined;
      const narrowingOf = (messages: readonly ConversationMessage[]) => {
        const request = toolSurface.current();
        const { definitionAvailability } = request;
        return narrowing?.due(messages, { moduleIds: request.turnedOff, types: agentTypesTurnedOffSince(definitionAvailability.tree, definitionAvailability.live) });
      };
      const opening = await conversation.seed();
      const seed = notice === undefined ? opening : await commitToolNotice(conversation, opening, notice, narrowingOf(opening.kind === "resume" ? opening.priorMessages : []));

      const sessionRequestContext = assembleInitialRequestContextWithSessionNotes(headlessPrompt, options.requestContext, checkpoint, toolSurface);
      const initialRequestContext = notice !== undefined && !persistence.committedTree
        ? [sessionRequestContext, notice].filter((text) => text !== undefined).join("\n\n")
        : sessionRequestContext;
      return {
        request: {
          client,
          initialPlannedAttempt: initialProviderRuntime.plannedAttempt,
          initialInteractionProfile: initialProviderRuntime.interactionProfile,
          tools: toolSurface,
          systemPrompt,
          turnReminders: async (messages) => [
            ...turnReminders(messages, await turnReminderStates(), toolSurface.current().capabilities),
            ...narrowingStatements(narrowingOf(messages)),
          ],
          ...(headlessPrompt?.kind === "literal" ? { literalSystemPrompt: true } : {}),
          ...(initialRequestContext !== undefined ? { initialRequestContext } : {}),
          executionCwd: options.executionCwd,
          seed,
          persistence,
          reasoningEffort: async () => mapEffort(typeof options.effort === "function" ? await options.effort() : options.effort),
          providerOptions: options.providerOptions,
          providerSessionKey: conversation.providerSessionKey,
          // A run outside any chat tree is a tree of its own.
          promptCacheKey: treeRoot ?? conversation.providerSessionKey,
          sessionId,
          conversationId: conversationAggregateId,
          sessionEventStore: options.sessionEventStore,
          sessionEventReader: options.sessionEventReader,
        },
        planned,
        moduleRuntimes,
        checkpoint,
        scratchDir,
        importLegacyNotes: () => importLegacyRuntimeSessionNotes(resources, options, checkpointConversationId, checkpointOwner),
        onPersonTurn: refreshesAtPersonTurn ? onPersonTurn : undefined,
      };
    },
  };
}

