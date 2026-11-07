import { assertNever } from "../../infra/assert-never.js";
import type { SkillDefinition } from "../../workflows/skill-schema.js";
import type { ProjectDefinitionRegistryRevision } from "../../workflows/definition-registry.js";
import { definitionAvailabilityOf } from "../app-service/definition-availability.js";
import { canonicalModuleIds } from "../../protocol/module-ids.js";
import { contributedToolIdentities, treeCapabilityCheck } from "./capability-checks.js";
import type { CapabilityAccess } from "./tools/types.js";
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
    case "unattended-chat":
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
 *  its configuration capture, the shell write guard that its tool bytes state, its definition revision, its serving
 *  model, and its file-edit contract. */
export interface KernelRequestFacts {
  readonly moduleSnapshot: FirstPartyModuleComposition;
  readonly live: FirstPartyModuleComposition;
  readonly runtimeConfig: RuntimeConfigRequestCapture;
  /** The described shell write guard: the tree's captured value for a tree-hosted request, else the request's
   *  configuration (`SharedTreeCapture`). */
  readonly shellWriteGuard: boolean;
  /** The persistent-process policy that the shell schema states: the tree's captured value for a tree-hosted
   *  request, else the request's configuration (`SharedTreeCapture`). */
  readonly persistentProcessesAdvertised: boolean;
  /** The definitions this request advertises and executes, read once when the request is planned. */
  readonly definitions: ProjectDefinitionRegistryRevision;
  /** Absent for a capability plan, which plans the run's tools with no model route (`planRunCapabilities`). */
  readonly servingModel?: KernelToolDeps["servingModel"];
  /** Absent for a capability plan, like `servingModel`; the tools then plan the default contract's registration. */
  readonly fileEditContract?: ModelInteractionProfile["fileEditContract"];
}

/** What an agent's own selection holds now: a module that `live` enables and its capability access admits, and the
 *  definitions those modules make available. */
function liveSelection(live: FirstPartyModuleComposition, capabilityAccess: CapabilityAccess | undefined, definitions: ProjectDefinitionRegistryRevision) {
  const moduleIds = new Set(live.enabledModuleIds);
  const available = (capability: ModuleId): boolean => moduleIds.has(capability) && (capabilityAccess?.available(capability) ?? true);
  return { available, definitions: definitionAvailabilityOf(definitions, canonicalModuleIds(live.enabledModuleIds).filter(available)) };
}

/** The kernel facts of one request (`KernelToolDeps`). A run builds them per request, not per turn, because the tools
 *  that a request advertises reflect the capabilities in force when that request is made. A prompt dump builds them
 *  from the same facts, so it advertises what a live request advertises. */
export function requestKernel(run: KernelRunFacts, request: KernelRequestFacts): KernelToolDeps {
  const { options, surfaces } = run;
  const { available, definitions: live } = liveSelection(request.live, options.capabilityAccess, request.definitions);
  const tree = definitionAvailabilityOf(request.definitions, request.moduleSnapshot.enabledModuleIds);
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
    shellWriteGuard: request.shellWriteGuard,
    ...(surfaces.enforcedShellWriteGuard ? { enforcedShellWriteGuard: surfaces.enforcedShellWriteGuard } : {}),
    persistentProcessesAdvertised: request.persistentProcessesAdvertised,
    ...(request.fileEditContract ? { fileEditContract: request.fileEditContract } : {}),
    capabilities: { available },
    definitionAvailability: { tree, live },
    treeCapabilities: treeCapabilityCheck(request.moduleSnapshot, tree, contributedToolIdentities(request.moduleSnapshot)),
    skills: request.definitions.skills,
    ...(run.onSkillLoad ? { onSkillLoad: run.onSkillLoad } : {}),
    ...(surfaces.externalSkillChildGrant ? { externalSkillChildGrant: surfaces.externalSkillChildGrant } : {}),
    moduleSnapshot: request.moduleSnapshot,
    runtimeConfig: request.runtimeConfig,
    purpose: options.purpose,
    ...(run.treeHosted ? { treeHosted: true } : {}),
    ...(surfaces.headless ? { headless: true } : {}),
    ...(options.readOnly ? { readOnly: true } : {}),
    personas: run.personas,
    ...(options.allowedSubagentTypes ? { allowedSubagentTypes: options.allowedSubagentTypes } : {}),
    ...(request.servingModel ? { servingModel: request.servingModel } : {}),
  };
}
