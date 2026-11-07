/**
 * The assembly of one request's tools and system prompt, the way a live request assembles them, for the prompt
 * dump (scripts/dump-prompt.ts) and the render matrix test.
 *
 * The tool catalog comes from the production planner (`planToolExposure`) over a module capture, so it advertises
 * what a live request advertises, and the system prompt comes from the options a live request builds it from
 * (`requestSystemPromptOptions`), with its module prompt fragments and memory. Host surfaces the planner needs are
 * stubbed at their seams: ask_user answers nothing, recall finds nothing, the subagent and workflow module runtimes
 * carry the real persona registry and workflow summaries but cannot dispatch, and the handoff schema is the agent's
 * or the subagent's. With `hosts`, every optional module that needs a host to build its tool gets one that builds
 * but never runs: a web search provider, one MCP server with one tool, the Code Mode service, an unresolved
 * definition override, and the development tooling. Known approximations: the memory and skill_manage tools need a
 * live store and are omitted, and the environment block, which a live run reads with git, is absent.
 */

import { join } from "node:path";
import type { AgentDefinition } from "../src/infra/agent-definition.js";
import type { CapabilityCheck } from "../src/infra/capability-text.js";
import { composeModuleRuntimes, type ModuleRuntimes } from "../src/infra/module-runtime.js";
import { composeModuleServices } from "../src/infra/module-service.js";
import { createBackgroundWorkRegistry } from "../src/orchestration/agent-runtime/background-work.js";
import { agentCapabilityCheck } from "../src/orchestration/agent-runtime/capability-checks.js";
import { createChildSlotRegistry } from "../src/orchestration/agent-runtime/child-slot-registry.js";
import { resolveModelInteractionProfile } from "../src/orchestration/agent-runtime/model-interaction-profile.js";
import type { RuntimeConfigRequestCapture } from "../src/orchestration/agent-runtime/request-config.js";
import { requestKernel, sharesTreeHost } from "../src/orchestration/agent-runtime/request-kernel.js";
import { requestSystemPromptOptions } from "../src/orchestration/agent-runtime/request-system-prompt.js";
import { buildSystemPromptParts, type SystemPromptPart } from "../src/orchestration/agent-runtime/system-prompt.js";
import type { KernelToolDeps } from "../src/orchestration/agent-runtime/tools/kernel-tool-deps.js";
import { planToolExposure, type ToolExposurePlan } from "../src/orchestration/agent-runtime/tools/tool-exposure-planner.js";
import type { CapabilityAccess, RuntimeTool } from "../src/orchestration/agent-runtime/tools/types.js";
import type { AgentPurpose } from "../src/orchestration/agent-runtime/types.js";
import type { FirstPartyModuleComposition } from "../src/orchestration/modules.js";
import { createCodeModeRuntime } from "../src/orchestration/modules/code-mode/runtime.js";
import { createCodeModeService } from "../src/orchestration/modules/code-mode/service.js";
import type { BenchmarkAdmissionDeps } from "../src/orchestration/modules/development/benchmark/admission.js";
import { createIosSimulatorTool } from "../src/orchestration/modules/development/ios-simulator-tool.js";
import { createMcpRuntime } from "../src/orchestration/modules/mcp/runtime.js";
import type { DefinitionOverrideOperations } from "../src/workflows/definitions/override-staleness.js";
import type { SubagentDispatchDeps } from "../src/orchestration/modules/subagents/execution/dispatch-deps.js";
import type { WorkflowsMode } from "../src/protocol/module-protocol-types.js";
import { workflowLaunchTargets } from "../src/orchestration/workflow-host/launch-origin.js";
import type { ProjectDefinitionRegistryRevision } from "../src/workflows/definition-registry.js";
import type { SessionIdentity, SessionMessaging } from "../src/orchestration/session/session-messaging.js";

/** What every request of one assembly shares: its roots, its definitions, its configuration, and the module
 *  capture of its chat tree. `live` is the agent's own selection, which differs from `capture` only for an agent
 *  that a chat tree hosts after a live disable. */
export interface PromptAssembly {
  readonly projectRoot: string;
  readonly userDataRoot: string;
  readonly accountHome: string;
  /** Stand-in for the live per-session scratch directory (structure fidelity only). */
  readonly scratchDir: string;
  readonly definitions: ProjectDefinitionRegistryRevision;
  readonly runtimeConfig: RuntimeConfigRequestCapture;
  readonly capture: FirstPartyModuleComposition;
  readonly live: FirstPartyModuleComposition;
  readonly workflowsMode: WorkflowsMode;
  /** The model that serves every request, which selects its interaction profile: the chat body and the edit tool. */
  readonly servingModel: NonNullable<KernelToolDeps["servingModel"]>;
  /** Whether each optional module that needs a host to build its tool gets a stand-in one. */
  readonly hosts: boolean;
}

export interface PlanInput {
  readonly personas: ReadonlyMap<string, AgentDefinition>;
  readonly purpose: AgentPurpose;
  readonly handoffSchema?: KernelToolDeps["handoff"];
  readonly askUser: boolean;
  /** The agent's capability boundary, as its runner holds it; absent, every module of `live` is available. */
  readonly capabilityAccess?: CapabilityAccess;
  /** The project's session messaging authority, which a live runner holds; absent, the message tools are omitted. */
  readonly sessions?: SessionMessaging;
}

/** One planned request: its kernel, its module runtimes, its tools, and the logical identity of each tool. */
export interface PlannedRequest {
  readonly kernel: KernelToolDeps;
  readonly modules: ModuleRuntimes;
  readonly tools: Map<string, RuntimeTool>;
  readonly registrationIdentities: ToolExposurePlan["registrationIdentities"];
  /** The planned tools whose call this agent may make (`ToolExposurePlan.usable`). */
  readonly usable: ToolExposurePlan["usable"];
  /** The planned tools with the code-only tools that the Code Mode catalog lists (`ToolExposurePlan.eligibleTools`). */
  readonly eligibleTools: ToolExposurePlan["eligibleTools"];
  /** The modules whose advertised tools this agent's calls are refused as turned off (`ToolExposurePlan.turnedOff`). */
  readonly turnedOff: ToolExposurePlan["turnedOff"];
}

const noop = (): void => {};
const notDispatched = (): never => { throw new Error("Prompt assembly does not dispatch subagents."); };

/** The planner's catalog for one request. The kernel facts come from the production builder (`requestKernel`)
 *  over stub surfaces; the module runtimes carry only what tool construction and prompt fragments read (the
 *  persona registry and the workflow launch seam), because an assembly never executes a tool. */
export async function planPromptRequest(assembly: PromptAssembly, input: PlanInput): Promise<PlannedRequest> {
  // The workflow and process tools both manage one task registry, exactly as a live runner's do.
  const backgroundTasks = createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: noop });
  const kernel = requestKernel({
    options: { userDataRoot: assembly.userDataRoot, purpose: input.purpose, ...(input.capabilityAccess ? { capabilityAccess: input.capabilityAccess } : {}) },
    surfaces: {
      ...(input.handoffSchema ? { handoff: { ...input.handoffSchema, onContent: noop } } : {}),
      ...(input.askUser ? { askUser: { ask: async () => ({ kind: "cancelled" as const }), answerQuestion: noop, cancelQuestion: noop, suspendAll: () => false } } : {}),
      recall: async () => ({ hits: [] }),
      ...(input.sessions ? { sessions: input.sessions } : {}),
    },
    personas: input.personas,
    backgroundTasks,
    checkpoint: {
      read: async () => undefined,
      replace: async () => { throw new Error("Prompt assembly does not execute tools."); },
      decide: async () => { throw new Error("Prompt assembly does not execute tools."); },
    },
    treeHosted: sharesTreeHost(input.purpose),
  }, {
    moduleSnapshot: assembly.capture,
    live: assembly.live,
    runtimeConfig: assembly.runtimeConfig,
    shellWriteGuard: assembly.runtimeConfig.shellWriteGuard,
    persistentProcessesAdvertised: assembly.runtimeConfig.allowPersistentProcesses,
    definitions: assembly.definitions,
    servingModel: assembly.servingModel,
    fileEditContract: interactionProfile(assembly).fileEditContract,
  });
  // Tool construction reads only the persona registry (the description comes
  // from it); every authority below it refuses, because an assembly never dispatches.
  const subagentDeps: SubagentDispatchDeps = {
    userDataRoot: assembly.userDataRoot,
    accountHome: assembly.accountHome,
    agentRegistry: input.personas,
    capabilityRequirements: [],
    skills: assembly.definitions.skills,
    definitionAvailability: kernel.definitionAvailability.live,
    modelFamily: assembly.servingModel.modelFamily,
    parentModel: assembly.servingModel.model,
    parentPromptKind: "chat",
    resolveRoles: notDispatched,
    onRenderEvent: noop,
    onChildRenderEvent: noop,
    backgroundTasks,
    childSlots: createChildSlotRegistry(),
    sessionId: "assembly-session",
    providerSessionKey: "assembly-session",
    createRunner: notDispatched,
    planChildCapabilities: notDispatched,
    authProfileId: "default",
    captureRuntimeConfig: () => assembly.runtimeConfig,
    awaitModelAccessSettled: async () => {},
    inheritableRuntimeSurfaces: {},
    moduleSelection: () => assembly.live,
    subagentSessions: {
      resolveRoles: notDispatched,
      allocateId: notDispatched,
      childDepth: notDispatched,
      publish: notDispatched,
      reconcileParentCompletion: notDispatched,
      settleReconciliation: notDispatched,
      registerLiveControl: notDispatched,
      settleUnreadMessages: notDispatched,
      deactivate: notDispatched,
      publishNewAttempt: notDispatched,
      prepareResume: notDispatched,
      publishResume: notDispatched,
    },
  };
  const sessionDir = join(assembly.scratchDir, "..");
  // Only a chat runner starts workflows: a child or an agent of a workflow gets no workflow starter, so its
  // planner omits the workflow tool, as a live child's does.
  const runtimes: (readonly [string, unknown])[] = [["subagents", { toolDeps: () => subagentDeps }]];
  if (input.purpose.kind === "interactive-chat") runtimes.push(["workflows", {
      deps: () => ({
        startWorkflow: async () => ({ error: "prompt assembly stub: workflow launch is not wired" }),
        onRenderEvent: noop,
        sessionDir,
        executionCwd: assembly.projectRoot,
        mode: assembly.workflowsMode,
        resolveLaunchTarget: workflowLaunchTargets({ revision: () => assembly.definitions, sessionDir, executionCwd: assembly.projectRoot }),
      }),
      // Authority bounds what a launched file may grant its steps, which only a launch reads.
      authority: () => ({ toolActions: new Set(), personas: new Set() }),
    }]);
  if (assembly.hosts) runtimes.push(...hostRuntimes(input.purpose));
  const modules = composeModuleRuntimes(runtimes);
  // An agent that plans from its tree's capture keeps a tool its own selection turned off advertised and unusable.
  const plan = await planToolExposure({ kernel, modules, ...(assembly.live === assembly.capture ? {} : { live: assembly.live }) });
  return { kernel, modules, tools: new Map(plan.tools), registrationIdentities: plan.registrationIdentities, usable: plan.usable, eligibleTools: plan.eligibleTools, turnedOff: plan.turnedOff };
}

/** The interaction profile of the assembly's serving model. */
function interactionProfile(assembly: PromptAssembly) {
  return resolveModelInteractionProfile(assembly.servingModel.model, assembly.servingModel.modelFamily);
}

/** The stand-in hosts of the optional modules whose tool needs one, keyed by module id. Each builds its tool the way
 *  production does and refuses to run it. A benchmark belongs to a chat alone, as in production. */
function hostRuntimes(purpose: AgentPurpose): (readonly [string, unknown])[] {
  const overrides: DefinitionOverrideOperations = {
    available: () => true,
    list: notDispatched, subscribe: () => noop, diff: notDispatched, prepare: notDispatched, apply: notDispatched,
    refresh: notDispatched, proposal: () => undefined, finalizeSkillPublication: notDispatched,
  };
  const mcp = { ports: { servers: () => ["docs"], tools: () => [{ server: "docs", name: "lookup", inputSchema: { type: "object" } }], call: notDispatched } };
  const services = composeModuleServices([["code-mode", createCodeModeService({ openWorker: notDispatched })], ["mcp", mcp]]);
  return [
    ["web", () => ({ available: () => true, run: notDispatched })],
    ["definition-overrides", overrides],
    ["code-mode", createCodeModeRuntime({ modules: services })],
    ["mcp", createMcpRuntime({ modules: services })],
    // SAFETY: tool construction reads no field of the benchmark deps; only a launch does.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: a stand-in host that never launches
    ["development", { iosSimulator: createIosSimulatorTool({ execute: notDispatched }), ...(purpose.kind === "interactive-chat" ? { benchmark: {} as BenchmarkAdmissionDeps } : {}) }],
  ];
}

/** The agent check of a planned request, as its request surface derives it from the usable tools left in it. */
export function plannedCapabilities(planned: PlannedRequest): CapabilityCheck {
  const usable = [...planned.usable].filter((name) => planned.tools.has(name));
  return agentCapabilityCheck(new Set(usable.map((name) => planned.registrationIdentities.get(name) ?? name)), planned.kernel.definitionAvailability.live);
}

/** The text sources of a system prompt that live outside the module capture. */
export interface PromptSources {
  readonly corePrompt: string;
  readonly engineeringDoctrine: string;
  readonly agentsMd: string | undefined;
  readonly memory: Parameters<typeof requestSystemPromptOptions>[0]["memory"];
  /** Who the session is, which a live run reads from its session messaging; absent, the section is left out. */
  readonly sessionIdentity?: SessionIdentity;
}

/** The system prompt parts of one planned request, built by the options a live request builds it from
 *  (`requestSystemPromptOptions`), so its module fragments, its memory, and its stance are the request's. The
 *  assembled run is a durable session: it keeps a checkpoint and its facts are searchable. */
export async function promptParts(assembly: PromptAssembly, purpose: AgentPurpose, planned: PlannedRequest, sources: PromptSources): Promise<SystemPromptPart[]> {
  return buildSystemPromptParts(await requestSystemPromptOptions({
    purpose,
    corePrompt: sources.corePrompt,
    engineeringDoctrine: sources.engineeringDoctrine,
    agentsMd: sources.agentsMd,
    envBlock: undefined,
    scratchDir: assembly.scratchDir,
    checkpoint: true,
    selfDebug: true,
    sessionIdentity: sources.sessionIdentity,
    interactionProfile: interactionProfile(assembly),
    moduleSnapshot: assembly.capture,
    tools: planned.tools,
    registrationIdentities: planned.registrationIdentities,
    kernel: planned.kernel,
    modules: planned.modules,
    memory: sources.memory,
  }));
}
