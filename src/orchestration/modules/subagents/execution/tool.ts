import { canonicalModuleIds } from "../../../../protocol/module-ids.js";
import { prepareSessionFactAppend } from "../../../session/session-fact-writer.js";
import { buildDurableSubagentCreated, buildSubagentPrompted } from "../history/subagent-run-fact-writers.js";
import { scopedAgentRegistry } from "./dispatch-configuration.js";
import { DEFAULT_BUDGET, toBudgetLimits } from "../../../../workflows/budget.js";
import { resumeSubagentSession, type ContinuationTarget, type SubagentContext, type SubagentInput, type SubagentResult } from "./control-actions.js";
import { prepareSubagentDispatch, prepareSubagentTools } from "./dispatch-preparation.js";
import type { SubagentDispatchDeps } from "./dispatch-deps.js";
import { roleModelDefault } from "../../../config/role-model-defaults.js";
import { resolveSubagentRole } from "../../../config/role-selection.js";
import type { RoleSettings } from "../../../session/schemas.js";
import { createChildExecution } from "./child-execution.js";

/** The dispatch surface the runtime `subagent` tool wraps: the execute and
 *  resume handlers over the scoped agent registry. Tool identity, schema,
 *  description, and prompt guidance live with the RuntimeTool construction in
 *  `subagents/tool.ts`. */
export interface SubagentDispatch {
  execute: (input: SubagentInput, context: SubagentContext) => Promise<SubagentResult>;
  /** Resumes a direct child without a new parent tool call, from its saved run. */
  resume: (childSessionId: string, context: SubagentContext) => Promise<SubagentResult>;
}

async function dispatchSubagent(
  input: SubagentInput,
  context: SubagentContext,
  deps: SubagentDispatchDeps,
  continuation?: ContinuationTarget,
): Promise<SubagentResult> {
  const toolUseId = context.toolUseId;
  if (!toolUseId) throw new Error("Subagent dispatch requires a parent tool-use id");
  const parentConversationId = context.conversationId;
  if (!parentConversationId) throw new Error("Subagent dispatch requires a parent conversation id");
  // Retired call shapes: the tool controlled a child before `process` did,
  // and a model that reads an older conversation can still send one. Remove
  // this refusal after 2027-04-08.
  if (!continuation && (input.kind === "resume" || input.kind === "retry")) {
    return { content: "The subagent tool only dispatches. Use process(action='resume') with the child's session_id to continue or retry a child.", outcome: "error" };
  }
  const modelRequestId = context.modelRequestId;
  const preparation = await prepareSubagentDispatch(input, context, deps, continuation);
  if (!preparation.ok) return preparation.error;
  const {
    executionCwd,
    agentType,
    prompt,
    agent,
    fork,
    forkHistory,
    assignment,
    access,
    model: modelString,
    effort: effortForRunner,
    providerOptions: providerOptionsForRunner,
  } = preparation;
  const childRunId = continuation?.attempt.kind === "same_run" ? continuation.childRunId : deps.subagentSessions.allocateId();
  const childSessionId = continuation?.childSessionId ?? deps.subagentSessions.allocateId();
  const childConversationId = continuation?.childConversationId ?? deps.subagentSessions.allocateId();
  const childDepth = await deps.subagentSessions.childDepth(deps.sessionId);
  const descriptionText = typeof input.description === "string" ? input.description : agentType;
  const tools = await prepareSubagentTools({ agent, context, deps, childDepth, ...(continuation ? { continuation } : {}) });
  if (!tools.ok) return tools.error;
  const { toolNames, task: subagentTask } = tools;
  const capabilityGrant = continuation ? continuation.capabilityGrant : access.grant;
  if (!capabilityGrant) throw new Error("Subagent dispatch admission returned no capability grant");
  const runtimeConfig = deps.captureRuntimeConfig();
  const budget = toBudgetLimits(runtimeConfig.budget ?? DEFAULT_BUDGET);
  const created = buildDurableSubagentCreated({
    childSessionId,
    childRunId,
    conversationId: childConversationId,
    parentSessionId: deps.sessionId,
    parentConversationId,
    parentToolCallId: toolUseId,
    ...(modelRequestId ? { modelRequestId } : {}),
    persona: { name: agentType, kind: continuation ? continuation.personaKind : agent.kind },
    capabilityGrant: {
      ...capabilityGrant,
      required: canonicalModuleIds(capabilityGrant.required),
      capabilities: canonicalModuleIds(capabilityGrant.capabilities),
      moduleIds: canonicalModuleIds(capabilityGrant.moduleIds),
    },
    admittedModuleIds: canonicalModuleIds(continuation ? continuation.admittedModuleIds : deps.moduleSelection().enabledModuleIds),
    skillsRevision: continuation ? continuation.skillsRevision : deps.skills.revision,
    model: modelString,
    ...(typeof effortForRunner === "string" ? { effort: effortForRunner } : {}),
    tools: toolNames,
    executionCwd,
    budget: continuation
      ? { maxTurns: continuation.maxTurns, maxTokens: continuation.maxTokens }
      : { maxTurns: agent.maxTurns, maxTokens: budget.max_tokens ?? 0 },
    parentDepth: childDepth - 1,
    description: descriptionText,
    ...(fork ? { fork: true as const } : {}),
  });
  const { roleAssignmentEntryFromSelection } = await import("../../../config/session-role-resolver.js")
  let initialRoles: RoleSettings = agent.kind === "general" && modelString !== undefined
    ? { chat: roleAssignmentEntryFromSelection({
      model: modelString, effort: typeof effortForRunner === "string" ? effortForRunner : roleModelDefault("chat").preferences[0].effort,
      providerOptions: providerOptionsForRunner,
    }) }
    : {}
  if (agent.kind === "persona" && !continuation) {
    const selected = resolveSubagentRole(agent.role, deps.briefScope, await deps.resolveRoles())
    const setting = selected?.setting
    if (selected?.settingScope === "session" && setting) {
      initialRoles = {
        [agent.role]: roleAssignmentEntryFromSelection({
          model: setting.model, effort: setting.effort, providerOptions: setting.providerOptions,
        }),
      }
    }
  }
  const publication = {
    childSessionId,
    childConversationId,
    parentSessionId: deps.sessionId,
    parentConversationId,
    parentToolUseId: toolUseId,
    description: descriptionText,
    executionCwd,
    authProfileId: deps.authProfileId,
    initialRoles,
    promptFact: prepareSessionFactAppend(childSessionId, buildSubagentPrompted({ childRunId, prompt, task: subagentTask, toolNames })),
    ...(forkHistory ? { forkHistory } : {}),
    assignment,
  };
  const freshAttempt = continuation?.attempt.kind === "new_attempt" ? continuation.attempt : undefined;
  if (context.signal?.aborted) return { outcome: "error", content: "Subagent execution was withdrawn before publication" };
  const published = continuation?.attempt.kind === "same_run"
    ? await deps.subagentSessions.publishResume({ ...publication, expectedSeq: continuation.attempt.expectedSeq })
    : freshAttempt
      ? await deps.subagentSessions.publishNewAttempt({
          ...publication,
          runBinding: {
            ...prepareSessionFactAppend(childSessionId, created),
            expectedSeq: freshAttempt.expectedSeq,
          },
          promptFact: {
            ...publication.promptFact,
            expectedSeq: freshAttempt.expectedSeq + 1,
          },
        })
      : await deps.subagentSessions.publish({
          ...publication,
          runBinding: prepareSessionFactAppend(childSessionId, created),
        });
  const acquisition = await createChildExecution({
    context, deps, preparation, tools, published, childRunId, childSessionId, childConversationId,
    parentConversationId, toolUseId, descriptionText,
    ...(continuation ? { continuation } : {}),
    acquireSlot: () => deps.childSlots.acquire(),
  });
  const guidance = acquisition.status === "queued"
    ? `This is only a queue acknowledgement. Every subagent slot is busy, so this dispatch is queued and starts automatically, in dispatch order, when a running subagent finishes. Do not re-dispatch it. Its result will arrive in a hidden subagent_notifications message when it finishes. If everything left depends on pending results, call process(action='wait') with soft_timeout seconds from your remaining-work estimate. Completion or expiry consumes that wait without stopping work. If an expiry or status check finds nothing that needs action or a reply, wait again with a fresh estimate and no visible text. Otherwise continue independent work. The process tool takes its session_id for its progress, an interrupt, a resume, or a stop.`
    : `This is only a launch acknowledgement. The subagent is running in the background and its result will arrive in a hidden subagent_notifications message when it finishes. Do not duplicate this subagent's assigned work. If everything left depends on pending results, call process(action='wait') with soft_timeout seconds from your remaining-work estimate. Completion or expiry consumes that wait without stopping work. If an expiry or status check finds nothing that needs action or a reply, wait again with a fresh estimate and no visible text. Otherwise continue independent work or dispatch more subagents. The process tool takes its session_id for its progress, an interrupt, a resume, or a stop.`;

  return {
    content: JSON.stringify({
      status: acquisition.status === "acquired" ? "running" : "queued",
      ...(acquisition.status === "queued" ? { queue_position: acquisition.position, concurrency_limit: acquisition.limit } : {}),
      result_available: false,
      id: childRunId,
      session_id: childSessionId,
      type: agentType,
      description: descriptionText,
      active_count: deps.backgroundTasks.activeSubagentCount(),
      result_delivery: "subagent_notifications",
      guidance,
    }),
    outcome: "ok",
    deferCompletion: true,
  };
}

export function createSubagentDispatch(deps: SubagentDispatchDeps): SubagentDispatch {
  const agentRegistry = scopedAgentRegistry(deps.agentRegistry, deps.allowedSubagentTypes);
  const scopedDeps = { ...deps, agentRegistry };

  return {
    async execute(input: SubagentInput, context: SubagentContext): Promise<SubagentResult> {
      return dispatchSubagent(input, context, scopedDeps);
    },
    resume: (childSessionId, context) => resumeSubagentSession(childSessionId, context, scopedDeps, dispatchSubagent),
  };
}
