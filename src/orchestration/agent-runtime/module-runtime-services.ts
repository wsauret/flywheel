import type { LearningReviewRun } from "./review-types.js";
/**
 * The per-runner kernel service bag a module runtime factory is built from.
 * Runtime assembly names every field it closes over once, so a module reads
 * the same authorities the kernel does without receiving `AgentOptions`
 * wholesale. Every field is a kernel authority; a module-owned value lives in
 * that module's runtime instance instead.
 */

import type { AgentDefinition } from "../../infra/agent-definition.js";
import type { AsyncEventStateReadSurface, StoredFact } from "../../infra/event-store-types.js";
import type { ModelFamily } from "../../infra/llm/model-family.js";
import type { ProviderRequestOptions } from "../../infra/llm/provider-options.js";
import type { UsageEntry } from "../../infra/llm/usage-entry.js";
import type { OwnedCommandRunner } from "../../infra/owned-command.js";
import type { LauncherScope } from "../../infra/process-supervisor.js";
import { NO_MODULE_SERVICES, type ModuleServices } from "../../infra/module-service.js";
import type { RuntimeEvent } from "../../infra/runtime-event-types.js";
import type { ProjectDefinitionRegistry } from "../../workflows/definition-registry.js";
import type { SkillRegistryRevision } from "../../workflows/skill-schema.js";
import type { RoleResolver } from "../config/roles.js";
import type { FirstPartyModuleSnapshot } from "../modules.js";
import type { AskUserController } from "../runner/ask-user-controller.js";
import type { ProviderRequestAuditFact } from "../session/provider-request-audit-facts.js";
import type { RecallPort } from "../../protocol/conversation-recall.js"
import type { SessionFactWriter } from "../session/session-fact-writer.js";
import type { WorkflowsMode } from "../../protocol/module-protocol-types.js";
import type { BackgroundExecutionOwner } from "./background-execution-owner.js";
import type { ForegroundBashHoldController } from "./foreground-bash-hold.js";
import type { CaptureProviderConnection, LLMClientFactory } from "./factory.js";
import type { ProviderRequestAuditWriter } from "./llm/provider-request-audit.js";
import type { CaptureRuntimeConfig } from "./request-config.js";
import type { ChildSlotRegistry } from "./child-slot-registry.js";
import type { PromptKind } from "./system-prompt.js";
import type { ExternalSkillChildGrant } from "./tools/skill.js";
import type { ShellRuntimeClient } from "./tools/shell-runtime-types.js";
import type { UsageSettlement } from "./usage-settlement.js";
import type { Agent, AgentOptions, AgentPurpose, CreateChildConversation, RuntimeToolSurfaces, RunnableAgentOptions } from "./types.js";
import type { CapabilityAccess } from "./tools/types.js";
import type { ServingModel } from "./tools/kernel-tool-deps.js";
import type { RuntimeConversation } from "./runtime-conversation.js";
import { deriveChildRuntimeSurfaces } from "./tools/tool-registry.js";
import { ownedCommandRunner } from "../../infra/owned-command.js";
import type { ChildSessionAuthority } from "../module-seams.js";

export interface ModuleRuntimeServices {
  readonly userDataRoot: string;
  readonly accountHome: string;
  readonly projectRoot: string;
  readonly executionCwd: string;
  readonly sessionDir?: string;
  readonly sessionId?: string;
  readonly conversation: {
    readonly providerSessionKey: string;
    readonly aggregateId?: string;
    readonly artifactScopeId: string;
    readonly awaitDurableFacts?: () => Promise<void>;
  };
  readonly purpose: AgentPurpose;
  readonly promptKind: PromptKind;
  readonly effort?: AgentOptions["effort"];
  readonly providerOptions?: ProviderRequestOptions;
  readonly model: string;
  /** The model the runner was assembled around, as the kernel serves it to tools. */
  readonly servingModel: ServingModel;
  readonly availableModels?: ReadonlyMap<ModelFamily, ReadonlySet<string>>;
  /** The capability boundary this runner was admitted on, for module work
   *  that starts outside a tool call and must still be admitted. */
  readonly capabilityAccess?: CapabilityAccess;
  readonly resolveRoles?: RoleResolver;
  readonly allowedSubagentTypes?: ReadonlySet<string>;
  readonly personas: ReadonlyMap<string, AgentDefinition>;
  readonly childSlots: ChildSlotRegistry;
  readonly definitions: ProjectDefinitionRegistry;
  /** Skill revision this runner's deterministic required-skill composition
   *  reads. A workflow passes the revision its host bound; absent, the
   *  current revision is captured at each dispatch. */
  readonly boundSkills?: SkillRegistryRevision;
  readonly createRunner: (options: RunnableAgentOptions) => Agent;
  readonly createLLMClient: LLMClientFactory;
  readonly captureRuntimeConfig: CaptureRuntimeConfig;
  readonly captureProviderConnection?: CaptureProviderConnection;
  readonly awaitModelAccessSettled: RunnableAgentOptions["awaitModelAccessSettled"];
  readonly usageProfile?: AgentOptions["usageProfile"];
  readonly activeProfileId?: string;
  readonly usageSettlement?: UsageSettlement;
  readonly budgetStreamId: string;
  readonly auxiliaryRequestAudit: ProviderRequestAuditWriter;
  readonly auditObserver?: (fact: ProviderRequestAuditFact) => void;
  readonly usageObserver?: (entry: UsageEntry) => void;
  readonly onEvent: (event: RuntimeEvent) => void;
  readonly onBackgroundEvent?: (event: RuntimeEvent) => void;
  readonly onChildEvent?: (childSessionId: string, event: RuntimeEvent) => void;
  readonly waitForEventCapacity?: AgentOptions["waitForEventCapacity"];
  readonly createChildConversation?: CreateChildConversation;
  readonly subagentSessions?: ChildSessionAuthority;
  readonly sessionEventWriter?: SessionFactWriter;
  readonly sessionEventStore?: AsyncEventStateReadSurface;
  readonly projectionReader?: AsyncEventStateReadSurface;
  readonly applyNestedStoredFact?: (event: StoredFact) => void | Promise<void>;
  /** The learning review this runner serves, when it is one. */
  readonly review?: LearningReviewRun;
  /** Skill ids loaded over every wake of this retained runner. */
  readonly loadedSkillIds: Set<string>;
  readonly moduleSelection: FirstPartyModuleSnapshot;
  readonly runOwnedCommand?: OwnedCommandRunner;
  readonly launcher?: LauncherScope;
  readonly background?: BackgroundExecutionOwner;
  /** The background owner a dispatch may hand work to. Absent when this
   *  runner has no persona to dispatch, so nothing can outlive its turn. */
  readonly dispatchOwner?: BackgroundExecutionOwner;
  readonly foregroundBashHold?: ForegroundBashHoldController;
  readonly shell?: ShellRuntimeClient;
  readonly startWorkflow?: RuntimeToolSurfaces["startWorkflow"];
  readonly workflowMode?: () => WorkflowsMode;
  readonly webSearch?: RuntimeToolSurfaces["webSearch"];
  readonly externalSkillChildGrant?: ExternalSkillChildGrant;
  readonly askUser?: AskUserController;
  readonly recall?: RecallPort;
  /** The process-scoped module services, so a per-runner runtime reads its own module's service through its handle. */
  readonly modules: ModuleServices;
  readonly inheritableRuntimeSurfaces: RuntimeToolSurfaces;
}

export interface ModuleRuntimeServicesInput {
  readonly options: RunnableAgentOptions;
  readonly servingModel: ServingModel;
  readonly conversation: RuntimeConversation;
  readonly definitions: ProjectDefinitionRegistry;
  readonly promptKind: PromptKind;
  readonly personas: ReadonlyMap<string, AgentDefinition>;
  readonly childSlots: ChildSlotRegistry;
  readonly createRunner: (options: RunnableAgentOptions) => Agent;
  readonly createLLMClient: LLMClientFactory;
  readonly usageSettlement?: UsageSettlement;
  readonly budgetStreamId: string;
  readonly auxiliaryRequestAudit: ProviderRequestAuditWriter;
  readonly review?: LearningReviewRun;
  readonly loadedSkillIds: Set<string>;
  readonly dispatchOwner?: BackgroundExecutionOwner;
}

/** Names every kernel authority a runner's module runtimes may read, once. */
export function createModuleRuntimeServices(input: ModuleRuntimeServicesInput): ModuleRuntimeServices {
  const { options, conversation, definitions, promptKind, childSlots, createRunner, createLLMClient, usageSettlement, budgetStreamId, auxiliaryRequestAudit, review, loadedSkillIds, dispatchOwner, servingModel } = input;
  const registry = input.personas;
  const { runtimeSurfaces, moduleSelection } = options;
  const background = runtimeSurfaces.background;
  const sessionId = conversation.sessionId;
  const conversationAggregateId = conversation.aggregateId;
  const usageProfile = options.usageProfile;
  return {
    userDataRoot: options.userDataRoot,
    accountHome: options.accountHome,
    projectRoot: options.projectRoot,
    executionCwd: options.executionCwd,
    ...(options.sessionDir ? { sessionDir: options.sessionDir } : {}),
    ...(sessionId ? { sessionId } : {}),
    conversation: {
      providerSessionKey: conversation.providerSessionKey,
      ...(conversationAggregateId ? { aggregateId: conversationAggregateId } : {}),
      artifactScopeId: conversation.artifactScopeId,
      ...(conversation.awaitDurableFacts ? { awaitDurableFacts: conversation.awaitDurableFacts } : {}),
    },
    purpose: options.purpose,
    promptKind,
    ...(options.effort !== undefined ? { effort: options.effort } : {}),
    ...(options.providerOptions ? { providerOptions: options.providerOptions } : {}),
    model: servingModel.model,
    servingModel,
    ...(options.availableModels ? { availableModels: options.availableModels } : {}),
    ...(options.capabilityAccess ? { capabilityAccess: options.capabilityAccess } : {}),
    ...(options.resolveRoles ? { resolveRoles: options.resolveRoles } : {}),
    ...(options.allowedSubagentTypes ? { allowedSubagentTypes: options.allowedSubagentTypes } : {}),
    personas: registry,
    childSlots,
    definitions,
    ...(options.skills ? { boundSkills: options.skills } : {}),
    createRunner,
    createLLMClient,
    captureRuntimeConfig: options.captureRuntimeConfig,
    ...(options.captureProviderConnection ? { captureProviderConnection: options.captureProviderConnection } : {}),
    awaitModelAccessSettled: options.awaitModelAccessSettled,
    ...(usageProfile ? { usageProfile } : {}),
    ...(options.activeProfileId ? { activeProfileId: options.activeProfileId } : {}),
    ...(usageSettlement ? { usageSettlement } : {}),
    budgetStreamId,
    auxiliaryRequestAudit,
    ...(options.auditObserver ? { auditObserver: options.auditObserver } : {}),
    ...(options.usageObserver ? { usageObserver: options.usageObserver } : {}),
    onEvent: options.onEvent,
    ...(options.onBackgroundEvent ? { onBackgroundEvent: options.onBackgroundEvent } : {}),
    ...(options.onChildEvent ? { onChildEvent: options.onChildEvent } : {}),
    ...(options.waitForEventCapacity ? { waitForEventCapacity: options.waitForEventCapacity } : {}),
    ...(options.createChildConversation ? { createChildConversation: options.createChildConversation } : {}),
    ...(options.subagentSessions ? { subagentSessions: options.subagentSessions } : {}),
    ...(options.sessionEventWriter ? { sessionEventWriter: options.sessionEventWriter } : {}),
    ...(options.sessionEventStore ? { sessionEventStore: options.sessionEventStore } : {}),
    ...(options.sessionEventReader ? { projectionReader: options.sessionEventReader } : {}),
    ...(options.applyNestedStoredFact ? { applyNestedStoredFact: options.applyNestedStoredFact } : {}),
    ...(review ? { review } : {}),
    loadedSkillIds,
    moduleSelection,
    ...(runtimeSurfaces.launcher ? { runOwnedCommand: ownedCommandRunner(runtimeSurfaces.launcher), launcher: runtimeSurfaces.launcher } : {}),
    ...(background ? { background } : {}),
    ...(dispatchOwner ? { dispatchOwner } : {}),
    ...(runtimeSurfaces.foregroundBashHold ? { foregroundBashHold: runtimeSurfaces.foregroundBashHold } : {}),
    ...(runtimeSurfaces.shell ?? background?.shell ? { shell: runtimeSurfaces.shell ?? background?.shell } : {}),
    ...(runtimeSurfaces.startWorkflow ? { startWorkflow: runtimeSurfaces.startWorkflow } : {}),
    ...(runtimeSurfaces.workflowMode ? { workflowMode: runtimeSurfaces.workflowMode } : {}),
    ...(runtimeSurfaces.webSearch ? { webSearch: runtimeSurfaces.webSearch } : {}),
    ...(runtimeSurfaces.externalSkillChildGrant ? { externalSkillChildGrant: runtimeSurfaces.externalSkillChildGrant } : {}),
    ...(runtimeSurfaces.askUser ? { askUser: runtimeSurfaces.askUser } : {}),
    ...(runtimeSurfaces.recall ? { recall: runtimeSurfaces.recall } : {}),
    modules: runtimeSurfaces.moduleServices ?? NO_MODULE_SERVICES,
    inheritableRuntimeSurfaces: deriveChildRuntimeSurfaces(runtimeSurfaces),
  };
}
