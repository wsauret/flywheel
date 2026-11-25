import type { ToolAction } from "../../../../infra/workflow/workflow-types.js";
import { canonicalModuleIds, MODULE_IDS, moduleDisabledReason, type ModuleId } from "../../../../protocol/runtime/module-ids.js";
import type { RegisteredTool, ToolDeclaration, ToolDeps, ToolExposureCategory, ToolFactoryResult, ToolPolicy, ToolRegistration } from "../../../module-seams.js";
import type { FirstPartyModuleComposition } from "../../../modules.js";
import type { RuntimeToolSurfaces, RunnerToolSurfaces } from "../../types.js";
import { createHandoffTool, handoffDefinition } from "../sessions/handoff.js";
import { createListSessionsTool, LIST_SESSIONS_TOOL_DEFINITION } from "../sessions/list-sessions.js";
import { createMessageSessionTool, messageSessionToolDefinition } from "../sessions/message-session.js";
import { createProcessTool, processToolDefinition } from "../sessions/process.js";
import { checkpointToolDefinition, createCheckpointTool, type CheckpointToolKind } from "../sessions/session-checkpoint.js";
import type { RuntimeTool } from "../types.js";

function sessionCheckpoint(kind: CheckpointToolKind, registryOrder: number): ToolDeclaration<ModuleId> {
  return {
    ...kernelPolicy("ambient", "ui_meta", "reconstruct", false, registryOrder),
    learningReviewExecutable: true,
    registrations: {
      [`checkpoint_${kind}`]: { capabilities: [], create: ({ kernel }) => kernel.checkpoint
        ? { tool: createCheckpointTool(kind, kernel.checkpoint) }
        : { unusable: { tool: checkpointToolDefinition(kind), reason: "no owning conversation checkpoint available" } } },
    },
  };
}

/** Whether the tree's kernel tool text names workflow targets. Only an unattended tree whose capture has no workflow
 *  tool can never reach a workflow; in an attended tree a peer can message a live workflow even with Workflows off
 *  (PI-INTERACTION-050), so its text keeps them. Read from the tree check, so every agent of a tree agrees
 *  (ARCH-CONTEXT-018, ARCH-CONTEXT-033). */
function workflowTargets(kernel: ToolDeps["kernel"]): boolean {
  return kernel.unattendedTree !== true || kernel.treeCapabilities("workflow");
}

function nativeProcess({ kernel }: ToolDeps): ToolFactoryResult {
  const unattendedChat = kernel.unattendedTree === true;
  const workflows = workflowTargets(kernel);
  if (!kernel.backgroundTasks) return { unusable: { tool: processToolDefinition(unattendedChat, workflows), reason: "no background execution owner available" } };
  const producers = canonicalModuleIds(kernel.moduleSnapshot.backgroundWorkProducerIds);
  if (producers.some((capability) => kernel.capabilities.available(capability)) || kernel.backgroundTasks.activeTaskCount() > 0) {
    return { tool: createProcessTool(kernel.backgroundTasks, kernel.sessions?.children, unattendedChat, workflows) };
  }
  return { unusable: { tool: processToolDefinition(unattendedChat, workflows), reason: `no background task is running, and ${moduleDisabledReason(producers)}` } };
}

/** An unattended chat is the root of its tree and serves no person (PI-AGENT-121), so it coordinates with no peer
 *  chat: the only sessions it can reach are the children it starts, through a tool whose action starts one. */
const UNATTENDED_CHAT_PEERS = "this unattended run omits peer-session discovery";

// The declaration's action, not the built tool's: the workflow tool starts sessions but renders as `ui_meta`.
function startsChildSession(planned: ReadonlyMap<string, RuntimeTool>, registry: ToolRegistry): boolean {
  return [...planned.keys()].some((name) => registrationNamed(name, registry)?.action === "task_subagent");
}

function messageSession({ kernel }: ToolDeps): ToolFactoryResult {
  const unattendedTree = kernel.unattendedTree === true;
  const workflows = workflowTargets(kernel);
  if (!kernel.sessions) return { unusable: { tool: messageSessionToolDefinition(unattendedTree, workflows), reason: "no session messaging available" } };
  const tool = createMessageSessionTool(kernel.sessions, kernel.backgroundTasks, unattendedTree, workflows);
  // Only the root reaches no session that it did not start; a child keeps the channel to its parent.
  if (kernel.purpose.kind !== "unattended-chat") return { tool };
  const registry = toolRegistryFromComposition(kernel.moduleSnapshot);
  return { tool, refine: (planned) => startsChildSession(planned, registry) ? { tool } : { reason: `${UNATTENDED_CHAT_PEERS}, and no planned tool starts a child session` } };
}

const KERNEL_TOOLS = {
  checkpoint_read: sessionCheckpoint("read", 11),
  checkpoint_replace: sessionCheckpoint("replace", 12),
  checkpoint_decide: sessionCheckpoint("decide", 13),
  handoff: {
    ...kernelPolicy("ambient", "handoff_write", "reconstruct", true, 8, 10),
    registrations: {
      // The agent's output contract validates its input but never changes its
      // advertised bytes, so the generic definition stands for every agent.
      handoff: { capabilities: [], create: ({ kernel }) => !kernel.handoff
        ? { unusable: { tool: handoffDefinition, reason: "no handoff capture configured" } }
        : { tool: kernel.handoff.schema ? createHandoffTool({ schema: kernel.handoff.schema }) : handoffDefinition } },
    },
  },
  process: {
    ...kernelPolicy("ambient", "ui_meta", "reconstruct", true, 10, 9),
    registrations: {
      "process.native": { capabilities: [], exposedName: "process", create: nativeProcess },
    },
  },
  // The channel between sessions is ambient, so no binding, persona, or
  // module setting removes the only way a child reaches its parent.
  message_session: {
    ...kernelPolicy("ambient", "ui_meta", "reconstruct", false, 21),
    shortForm: { trees: "unattended", summary: "Send one message to another session, such as your parent or a child that you started." },
    registrations: {
      message_session: { capabilities: [], create: messageSession },
    },
  },
  // It lists only sessions that the caller did not start, which an unattended chat never reaches.
  list_sessions: {
    ...kernelPolicy("ambient", "ui_meta", "reconstruct", false, 22),
    registrations: {
      list_sessions: { capabilities: [], create: ({ kernel }) => kernel.purpose.kind === "unattended-chat"
        ? { reason: UNATTENDED_CHAT_PEERS }
        : kernel.sessions
          ? { tool: createListSessionsTool(kernel.sessions) }
          : { unusable: { tool: LIST_SESSIONS_TOOL_DEFINITION, reason: "no session messaging available" } } },
    },
  },
} as const satisfies { readonly [name: string]: ToolDeclaration<ModuleId> };

function kernelPolicy(
  category: ToolExposureCategory,
  action: ToolAction,
  cloneInheritance: ToolPolicy["cloneInheritance"],
  personaBaseline: boolean,
  registryOrder: number,
  personaOrder?: number,
): ToolPolicy {
  return {
    category, action, cloneInheritance,
    learningReviewExecutable: false, semanticBundle: null, personaBaseline,
    ...(personaOrder === undefined ? {} : { personaOrder }), registryOrder,
  };
}

/** One registry per composition value: the composition is already the
 *  identity every request keys on, so the registry derived from it is held
 *  beside it rather than rebuilt by each planner and dispatcher read. */
const registries = new WeakMap<FirstPartyModuleComposition, ToolRegistry>();

/** Every registration of the composition's tools, keyed by registration id, in
 *  registry order. */
export type ToolRegistry = ReadonlyMap<string, RegisteredTool>;

export function toolRegistryFromComposition(composition: FirstPartyModuleComposition): ToolRegistry {
  const held = registries.get(composition);
  if (held !== undefined) return held;
  const registry = buildToolRegistry(composition);
  registries.set(composition, registry);
  return registry;
}

function buildToolRegistry(composition: FirstPartyModuleComposition): ToolRegistry {
  const declared: readonly (readonly [string, ToolDeclaration])[] = [
    ...composition.contributions.flatMap((contribution) => contribution.domain === "tools" ? [[contribution.value.name, contribution.value.declaration] as const] : []),
    ...Object.entries(KERNEL_TOOLS),
  ];
  const entries = declared.flatMap(([tool, { registrations, ...policy }]) => Object.entries(registrations).map(([registrationId, registration]): readonly [string, RegisteredTool] =>
    [registrationId, { ...policy, ...registration, tool, capabilities: registrationCapabilities(registration) }]));
  return new Map(entries.toSorted(([, left], [, right]) => left.registryOrder - right.registryOrder));
}

function registrationCapabilities(registration: ToolRegistration): readonly ModuleId[] {
  return registration.capabilities.map((capability) => {
    const installed = MODULE_IDS.find((id) => id === capability);
    if (installed === undefined) throw new Error(`Unknown capability module id: ${capability}`);
    return installed;
  });
}

/** The provider-visible name of one registration. */
export function exposedToolName(registrationId: string, registration: Pick<ToolRegistration, "exposedName">): string {
  return registration.exposedName ?? registrationId;
}

/** One entry per tool, in persona order. */
export function personaToolEntries(registry: ToolRegistry): readonly { name: string; action: ToolAction; personaBaseline: boolean }[] {
  const entries = new Map<string, { name: string; action: ToolAction; personaBaseline: boolean }>();
  for (const registration of [...registry.values()].sort((left, right) => (left.personaOrder ?? Number.MAX_SAFE_INTEGER) - (right.personaOrder ?? Number.MAX_SAFE_INTEGER))) {
    if (!entries.has(registration.tool)) entries.set(registration.tool, { name: registration.tool, action: registration.action, personaBaseline: registration.personaBaseline });
  }
  return [...entries.values()];
}

/** The registration that a tool name or a registration id names. A tool
 *  served by several registrations resolves to the first in registry order. */
export function registrationNamed(name: string, registry: ToolRegistry): RegisteredTool | undefined {
  return registry.get(name) ?? [...registry.values()].find((registration) => registration.tool === name || registration.exposedName === name);
}

export function cloneInheritedToolNames(parentTools: ReadonlySet<string>, registry: ToolRegistry): string[] {
  return [...parentTools].filter((name) => registrationNamed(name, registry)?.cloneInheritance === "inherit");
}

/** Derives one child generation from inheritable authorities and child-local surfaces. */
export function deriveChildRuntimeSurfaces(
  parent: RuntimeToolSurfaces,
  local: RunnerToolSurfaces = {},
): RuntimeToolSurfaces {
  return {
    ...(parent.moduleServices ? { moduleServices: parent.moduleServices } : {}),
    ...(parent.webSearch ? { webSearch: parent.webSearch } : {}),
    ...(parent.launcher ? { launcher: parent.launcher } : {}),
    ...(parent.commandHandover ? { commandHandover: parent.commandHandover } : {}),
    ...(parent.persistentProcesses ? { persistentProcesses: parent.persistentProcesses } : {}),
    ...(parent.allowPersistentProcesses ? { allowPersistentProcesses: parent.allowPersistentProcesses } : {}),
    ...(parent.enforcedShellWriteGuard ? { enforcedShellWriteGuard: parent.enforcedShellWriteGuard } : {}),
    ...(parent.foregroundBashHold ? { foregroundBashHold: parent.foregroundBashHold } : {}),
    ...(parent.streamingEditValidation ? { streamingEditValidation: parent.streamingEditValidation } : {}),
    ...(parent.headless ? { headless: true } : {}),
    ...(parent.sessions ? { sessions: parent.sessions } : {}),
    ...(local.handoff ? { handoff: local.handoff } : {}),
    ...(local.background ? { background: local.background } : {}),
    ...(local.foregroundBashHold ? { foregroundBashHold: local.foregroundBashHold } : {}),
  };
}

/** Returns the capabilities declared by a registered tool by its logical id.
 *  Missing identity is denied. */
export function toolModuleRequirements(name: string, registry: ToolRegistry): readonly ModuleId[] {
  const registration = registrationNamed(name, registry)
  if (!registration) throw new Error(`Tool '${name}' is not registered`)
  return registration.capabilities
}

/** The tools, by allowlist identity, that a learning review may call. */
export function learningReviewToolNames(registry: ToolRegistry): ReadonlySet<string> {
  return new Set([...registry.values()].filter((entry) => entry.learningReviewExecutable).map((entry) => entry.tool));
}
