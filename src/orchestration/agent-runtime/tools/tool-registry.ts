import type { ToolAction } from "../../../infra/workflow-types.js";
import type { ModuleRuntimes } from "../../../infra/module-runtime.js";
import { canonicalModuleIds, MODULE_IDS, moduleDisabledReason, type ModuleId } from "../../../protocol/module-ids.js";
import type { FirstPartyModuleComposition } from "../../modules.js";
import type { RuntimeToolSurfaces, RunnerToolSurfaces } from "../types.js";
import type { ToolInteractionContract } from "../model-interaction-profile.js";
import type { KernelToolDeps } from "./kernel-tool-deps.js";
import { createHandoffTool, handoffDefinition } from "./handoff.js";
import { createListSessionsTool, LIST_SESSIONS_TOOL_DEFINITION } from "./list-sessions.js";
import { createModelsTool, MODELS_TOOL_DEFINITION } from "./models.js";
import { createMessageSessionTool, MESSAGE_SESSION_TOOL_DEFINITION } from "./message-session.js";
import { createProcessTool, PROCESS_TOOL_DEFINITION } from "./process.js";
import { checkpointToolDefinition, createCheckpointTool, type CheckpointToolKind } from "./session-checkpoint.js";
import type { AdvertisedTool, RuntimeTool, RuntimeToolInput, ShellCommand } from "./types.js";

/** core: the normal coding surface, participates in explicit selection.
 *  ambient: runtime context, inspection, or settlement surfaces that an
 *  ordinary selected-tool allowlist does not remove.
 *  opt-in: requires explicit selection plus declared runtime dependencies. */
type ToolExposureCategory = "core" | "ambient" | "opt-in";

/** What every tool factory receives: the request's kernel facts and the
 *  runtimes of the enabled modules, read through typed handles. */
interface ToolDeps {
  readonly kernel: KernelToolDeps;
  readonly modules: ModuleRuntimes;
}

/** A tool's final form once every registration is constructed: the tool it
 *  settles on given the planned set, or the reason it withdraws. */
type RefinedTool =
  | { readonly tool: RuntimeTool; readonly reason?: undefined }
  | { readonly tool?: undefined; readonly reason: string };

/** Builds a tool over the request's final eligible set, after every other
 *  registration and every module's code-only tools are planned, with the
 *  namespaces the modules declare before their tools arrive. It reports
 *  the eligible tools it cannot carry as named omissions. */
export type DeferredToolFactory = (eligible: ReadonlyMap<string, RuntimeTool>, namespaces: ReadonlySet<string>) => {
  readonly tool: RuntimeTool;
  readonly omissions: readonly { readonly name: string; readonly reason: string }[];
};

export interface ToolFactoryResult {
  readonly tool?: RuntimeTool;
  /** The tool is omitted for this reason. */
  readonly reason?: string;
  /** The tool's per-agent surface is missing. A tree-hosted runner advertises
   *  `tool` and refuses its call with `reason`; any other runner omits it with
   *  `reason`. The definition names no surface, so its bytes are the same
   *  whether the agent holds the surface (see `KernelToolDeps.treeHosted`). */
  readonly unusable?: { readonly tool: AdvertisedTool; readonly reason: string };
  /** Named sub-omissions a present tool reports, such as one input it cannot advertise. */
  readonly omissions?: readonly { readonly name: string; readonly reason: string }[];
  /** The registration's tool is built last, over the final eligible set. Its
   *  presence admits the modules' code-only tools, whose capability
   *  authority it becomes. One request plans at most one. */
  readonly deferred?: DeferredToolFactory;
  /** Runs after every registration is constructed, with the planned set. */
  readonly refine?: (planned: ReadonlyMap<string, RuntimeTool>) => RefinedTool;
}

/** What a tool is outside the engine. Settings, persona grants, the selected
 *  allowlist, clone inheritance, and the audit read the tool by its name, so
 *  one tool states this policy once, whatever registrations serve it. */
interface ToolPolicy {
  /** What the tool does, for policy: workflow `toolScoping` grants and
   *  persona `excludeActions` read it. Clients never see it;
   *  they render and group by the display action in the tool display
   *  registry, which can differ on purpose. */
  readonly action: ToolAction;
  readonly category: ToolExposureCategory;
  readonly cloneInheritance: "inherit" | "reconstruct";
  readonly learningReviewExecutable: boolean;
  readonly semanticBundle: "file-media" | null;
  readonly personaBaseline: boolean;
  readonly personaOrder?: number;
  readonly registryOrder: number;
}

/** One executable form of a tool. Its id is the registration id that
 *  conversation history and the request audit record, so it never changes. */
export interface ToolRegistration<Capability extends string = string> {
  readonly capabilities: readonly Capability[];
  /** Planned only when the serving model selects this presentation contract. */
  readonly interactionContract?: ToolInteractionContract;
  /** Provider-visible name when it differs from the registration id. */
  readonly exposedName?: string;
  /** A shell registration's command and the absolute directory it runs in,
   *  so a rule judges a call, live or recorded, whatever input names this
   *  registration gives them. The tool's own execution starts in the same
   *  directory. Pure: it reads only the input and the execution directory.
   *  Undefined when the input carries no command string. */
  readonly shellCommand?: (input: Readonly<RuntimeToolInput>, executionCwd: string) => ShellCommand | undefined;
  readonly create: (deps: ToolDeps) => ToolFactoryResult;
}

/** A tool as its owner declares it: its policy once, and the registrations
 *  the serving model's interaction profile selects among. */
export interface ToolDeclaration<Capability extends string = string> extends ToolPolicy {
  readonly registrations: { readonly [registrationId: string]: ToolRegistration<Capability> };
}

/** One registry entry: a registration with the name and policy of its tool. */
export interface RegisteredTool<Capability extends string = ModuleId> extends ToolPolicy, ToolRegistration<Capability> {
  readonly tool: string;
}

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

function nativeProcess({ kernel }: ToolDeps): ToolFactoryResult {
  if (!kernel.backgroundTasks) return { unusable: { tool: PROCESS_TOOL_DEFINITION, reason: "no background execution owner available" } };
  const producers = canonicalModuleIds(kernel.moduleSnapshot.backgroundWorkProducerIds);
  if (producers.some((capability) => kernel.capabilities.available(capability)) || kernel.backgroundTasks.activeTaskCount() > 0) {
    return { tool: createProcessTool(kernel.backgroundTasks, kernel.sessions?.children) };
  }
  return { unusable: { tool: PROCESS_TOOL_DEFINITION, reason: `no background task is running, and ${moduleDisabledReason(producers)}` } };
}

const KERNEL_TOOLS = {
  models: {
    ...kernelPolicy("ambient", "ui_meta", "reconstruct", false, 23),
    registrations: {
      models: { capabilities: [], create: ({ kernel }) => kernel.captureProviderConnection
        ? { tool: createModelsTool(kernel.captureProviderConnection, kernel.userDataRoot) }
        : { unusable: { tool: MODELS_TOOL_DEFINITION, reason: "no live model access capture available" } } },
    },
  },
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
    registrations: {
      message_session: { capabilities: [], create: ({ kernel }) => kernel.sessions
        ? { tool: createMessageSessionTool(kernel.sessions, kernel.backgroundTasks) }
        : { unusable: { tool: MESSAGE_SESSION_TOOL_DEFINITION, reason: "no session messaging available" } } },
    },
  },
  list_sessions: {
    ...kernelPolicy("ambient", "ui_meta", "reconstruct", false, 22),
    registrations: {
      list_sessions: { capabilities: [], create: ({ kernel }) => kernel.sessions
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
    ...(parent.foregroundBashHold ? { foregroundBashHold: parent.foregroundBashHold } : {}),
    ...(parent.streamingEditValidation ? { streamingEditValidation: parent.streamingEditValidation } : {}),
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
