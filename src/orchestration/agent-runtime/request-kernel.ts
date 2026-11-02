import { assertNever } from "../../infra/assert-never.js";
import type { SkillDefinition, SkillRegistryRevision } from "../../workflows/skill-schema.js";
import type { AgentDefinition } from "../../infra/agent-definition.js";
import type { FirstPartyModuleComposition, ModuleId } from "../modules.js";
import type { BackgroundWorkRegistry } from "./background-work.js";
import type { ModelInteractionProfile } from "./model-interaction-profile.js";
import type { RuntimeConfigRequestCapture } from "./request-config.js";
import type { KernelToolDeps } from "./tools/kernel-tool-deps.js";
import type { AgentOptions, RunnableAgentOptions, RuntimeToolSurfaces } from "./types.js";

/** Whether a session may share its provider process with the other such sessions of its chat tree (ARCH-PROVIDERS-006):
 *  a workflow agent or a subagent, whatever children it can start, and every side call of the tree (a title, a learning
 *  review and its audit, a side question, a failure summary). A chat keeps its own engine process. The price: a side
 *  call carries the tree's full tool list (about 53 KB, about 13k tokens, measured 2026-10-26) so that it can share the
 *  host process. */
export function sharesTreeHost(purpose: AgentOptions["purpose"]): boolean {
  switch (purpose.kind) {
    case "workflow-agent":
    case "subagent":
    case "session-title":
    case "chat-learning-review":
    case "workflow-learning-review":
    case "learning-review-audit":
    case "chat-side-call":
    case "subagent-failure-summary":
      return true;
    case "interactive-chat":
    case "workflow-follow-up":
    case "headless-task":
    case "chat-routing-benchmark":
    case "persona-benchmark":
      return false;
    default:
      return assertNever(purpose);
  }
}

/** What every request of one run gives its kernel: the run's options and surfaces and the owners that the run holds. */
export interface KernelRunFacts {
  readonly options: Pick<RunnableAgentOptions, "userDataRoot" | "purpose" | "readOnly" | "allowedSubagentTypes" | "capabilityAccess">;
  readonly surfaces: RuntimeToolSurfaces;
  readonly personas: ReadonlyMap<string, AgentDefinition>;
  readonly backgroundTasks?: BackgroundWorkRegistry;
  readonly checkpoint?: KernelToolDeps["checkpoint"];
  readonly treeHosted: boolean;
  readonly captureProviderConnection?: KernelToolDeps["captureProviderConnection"];
  readonly onSkillLoad?: (skill: SkillDefinition) => void | Promise<void>;
}

/** What one request gives its kernel: its module snapshot and the modules that its own selection enables (`live`),
 *  its configuration capture, its skill revision, its serving model, and its file-edit contract. */
export interface KernelRequestFacts {
  readonly moduleSnapshot: FirstPartyModuleComposition;
  readonly live: FirstPartyModuleComposition;
  readonly runtimeConfig: RuntimeConfigRequestCapture;
  readonly skills: SkillRegistryRevision | undefined;
  readonly servingModel: KernelToolDeps["servingModel"];
  readonly fileEditContract: ModelInteractionProfile["fileEditContract"];
}

/** The kernel facts of one request (`KernelToolDeps`). A run builds them per request, not per turn, because the tools
 *  that a request advertises reflect the capabilities in force when that request is made. A prompt dump builds them
 *  from the same facts, so it advertises what a live request advertises. */
export function requestKernel(run: KernelRunFacts, request: KernelRequestFacts): KernelToolDeps {
  const { options, surfaces } = run;
  const moduleIds = new Set(request.live.enabledModuleIds);
  return {
    userDataRoot: options.userDataRoot,
    ...(run.captureProviderConnection ? { captureProviderConnection: run.captureProviderConnection } : {}),
    ...(run.checkpoint ? { checkpoint: run.checkpoint } : {}),
    ...(surfaces.handoff ? { handoff: surfaces.handoff } : {}),
    ...(surfaces.askUser ? { askUser: surfaces.askUser } : {}),
    ...(surfaces.recall ? { recall: surfaces.recall } : {}),
    ...(surfaces.sessions ? { sessions: surfaces.sessions } : {}),
    ...(run.backgroundTasks ? { backgroundTasks: run.backgroundTasks } : {}),
    ...(surfaces.foregroundBashHold ? { foregroundBashHold: surfaces.foregroundBashHold } : {}),
    ...(request.runtimeConfig.foregroundBashHoldSeconds !== undefined ? { foregroundBashHoldSeconds: request.runtimeConfig.foregroundBashHoldSeconds } : {}),
    persistentProcesses: request.runtimeConfig.allowPersistentProcesses,
    fileEditContract: request.fileEditContract,
    capabilities: {
      available: (capability: ModuleId) => moduleIds.has(capability) && (options.capabilityAccess?.available(capability) ?? true),
    },
    ...(request.skills ? { skills: request.skills } : {}),
    ...(run.onSkillLoad ? { onSkillLoad: run.onSkillLoad } : {}),
    ...(surfaces.externalSkillChildGrant ? { externalSkillChildGrant: surfaces.externalSkillChildGrant } : {}),
    moduleSnapshot: request.moduleSnapshot,
    runtimeConfig: request.runtimeConfig,
    purpose: options.purpose,
    ...(run.treeHosted ? { treeHosted: true } : {}),
    ...(options.readOnly ? { readOnly: true } : {}),
    personas: run.personas,
    ...(options.allowedSubagentTypes ? { allowedSubagentTypes: options.allowedSubagentTypes } : {}),
    servingModel: request.servingModel,
  };
}
