/**
 * The system prompt options of one request: the run's prompt kind and stance, its module prompt fragments, and its
 * memory. A run's request inputs build every request's prompt from them, and so does the prompt dump
 * (scripts/dump-prompt.ts), so the dump shows the prompt that a request sends.
 */

import type { ModuleRuntimes } from "../../infra/module-runtime.js";
import type { SessionIdentity } from "../session/session-messaging.js";
import type { FirstPartyModuleComposition } from "../modules.js";
import { promptKindForPurpose } from "./agent-purpose.js";
import type { ModelInteractionProfile } from "./model-interaction-profile.js";
import type { BuildSystemPromptOptions } from "./system-prompt.js";
import { treeCapabilityCheck } from "./capability-checks.js";
import type { KernelToolDeps } from "./tools/kernel-tool-deps.js";
import type { RuntimeTool } from "./tools/types.js";
import type { AgentOptions } from "./types.js";

/** A chat side call answers beside its chat, so it keeps the chat's prompting and reply behavior. */
export function isChatFacing(options: Pick<AgentOptions, "purpose">): boolean {
  return options.purpose.kind === "interactive-chat" || options.purpose.kind === "chat-side-call";
}

/** The memory that the memory contributions of `moduleSnapshot` render for the project and account, or null when
 *  they render none. */
export function readModuleMemory(moduleSnapshot: FirstPartyModuleComposition, directories: Pick<AgentOptions, "projectRoot" | "accountHome">): string | null {
  return moduleSnapshot.contributions
    .flatMap((entry) => entry.domain === "memory" ? [entry.value.snapshot({ projectRoot: directories.projectRoot, accountHome: directories.accountHome })] : [])
    .filter((value): value is string => value !== null)
    .join("\n\n") || null;
}

/** What one request's system prompt is built from. */
export interface RequestPromptFacts {
  readonly purpose: AgentOptions["purpose"];
  readonly corePrompt: string | undefined;
  readonly engineeringDoctrine: string | undefined;
  readonly agentsMd: string | undefined;
  readonly envBlock: string | undefined;
  readonly scratchDir: string | undefined;
  /** Whether the run keeps a checkpoint. */
  readonly checkpoint: boolean;
  /** Whether the run's conversation lives in a store that `flywheel events search` reads. */
  readonly selfDebug: boolean;
  readonly sessionIdentity: SessionIdentity | undefined;
  readonly interactionProfile: ModelInteractionProfile;
  /** The request's module snapshot, its advertised tools, and the logical identity of each advertised tool. */
  readonly moduleSnapshot: FirstPartyModuleComposition;
  readonly tools: ReadonlyMap<string, RuntimeTool>;
  readonly registrationIdentities: ReadonlyMap<string, string>;
  readonly kernel: KernelToolDeps;
  readonly modules: ModuleRuntimes;
  /** The memory of the run, read only for a request that carries memory. */
  readonly memory: (moduleSnapshot: FirstPartyModuleComposition) => string | null;
}

/** The options that build the system prompt of one request (`buildSystemPrompt`). The prompt and the enabled
 *  modules' prompt fragments render from the tree check of the request's advertised tools, so every agent of a tree
 *  renders the same text (ARCH-CONTEXT-033). The fragments render in contribution order. A request that does not hold Learning carries no memory, and subagents and
 *  persona benchmarks never carry memory. */
export async function requestSystemPromptOptions(facts: RequestPromptFacts): Promise<BuildSystemPromptOptions> {
  const { purpose, moduleSnapshot, tools } = facts;
  const memoryExcluded = purpose.kind === "subagent" || purpose.kind === "persona-benchmark";
  const memorySnapshot = memoryExcluded || !moduleSnapshot.contributions.some((contribution) => contribution.domain === "memory") ? null : facts.memory(moduleSnapshot);
  const capabilities = treeCapabilityCheck(moduleSnapshot, facts.kernel.definitionAvailability.tree, [...tools.keys()].map((name) => facts.registrationIdentities.get(name) ?? name));
  const fragmentInput = { kernel: facts.kernel, modules: facts.modules, tools, memorySnapshot, capabilities };
  const fragments = moduleSnapshot.contributions
    .flatMap((contribution) => contribution.domain === "promptFragments" ? [contribution.value] : [])
    .toSorted((left, right) => left.order - right.order);
  const moduleFragments = (await Promise.all(fragments.map((fragment) => fragment.render(fragmentInput))))
    .filter((fragment): fragment is string => fragment !== undefined);
  return {
    corePrompt: facts.corePrompt ?? "",
    ...(facts.engineeringDoctrine ? { engineeringDoctrine: facts.engineeringDoctrine } : {}),
    agentsMd: facts.agentsMd,
    tools: [...tools.values()],
    ...(facts.envBlock ? { envBlock: facts.envBlock } : {}),
    scratchDir: facts.scratchDir,
    ...(facts.checkpoint ? { checkpointAvailable: true } : {}),
    promptKind: promptKindForPurpose(purpose),
    purpose,
    ...(isChatFacing({ purpose }) ? { chatHost: { communication: true as const } } : {}),
    // Agents of a workflow and subagents both work unattended toward a handoff, so they
    // share one stable tier and its prompt cache. An unattended chat works unattended toward its final reply.
    ...(purpose.kind === "workflow-agent" || purpose.kind === "subagent" || purpose.kind === "unattended-chat" ? { unattended: true as const } : {}),
    // Self-debugging is host-level work: a chat and the agents of a workflow investigate their realm's sessions. A
    // subagent runs one brief, and an unattended chat has no installed command to run (PI-AGENT-121).
    ...(facts.selfDebug && (isChatFacing({ purpose }) || purpose.kind === "workflow-agent") ? { selfDebug: true as const } : {}),
    capabilities,
    moduleFragments,
    ...(facts.sessionIdentity ? { sessionIdentity: facts.sessionIdentity } : {}),
    ...(facts.interactionProfile.chatGuidance ? { chatGuidance: facts.interactionProfile.chatGuidance } : {}),
  };
}
