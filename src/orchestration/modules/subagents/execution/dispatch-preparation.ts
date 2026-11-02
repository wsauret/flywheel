import { canonicalDirectory, resolveExecutionDirectoryInput } from "../../../../infra/directory-authorities.js"
import { errorMessage } from "../../../../infra/error-message.js"
import type { ConversationMessage } from "../../../agent-runtime/llm/types.js"
import { grantCovers, NO_CAPABILITY_ACCESS, refuseDisabledToolCall, withCapabilityGrant, type CapabilityAccess } from "../../../agent-runtime/tools/types.js"
import { buildSubagentTask, forkAssignment, validateDispatchInput } from "./prompts.js"
import { resolveDispatchModel, resolveChildRole, type ResolvedDispatchModel } from "./dispatch-configuration.js"
import type { ContinuationTarget, SubagentContext, SubagentInput, SubagentResult } from "./control-actions.js"
import type { SubagentDispatchDeps } from "./dispatch-deps.js"
import type { AgentDefinition } from "../../../../infra/agent-definition.js"
import type { ProviderRequestOptions } from "../../../../infra/llm/provider-options.js"
import type { AgentOptions } from "../../../agent-runtime/types.js"
import { cloneInheritedToolNames, toolRegistryFromComposition, toolModuleRequirements } from "../../../agent-runtime/tools/tool-registry.js"
import { grantedSubagentTypes, personaToolNames } from "../../../../workflows/agents/subagent-reachability.js"
import { personaInstructions } from "../../../../workflows/agents/persona-instructions.js"
import type { PromptKind } from "../../../agent-runtime/system-prompt.js"
import { CHECKPOINT_TOOL_NAMES } from "../../../../infra/agent-assets/session-notes.js"

interface PreparedDispatch {
  readonly ok: true
  readonly executionCwd: string
  readonly agentType: string
  readonly prompt: string
  readonly agent: AgentDefinition
  readonly fork: boolean
  /** The parent conversation that a fork starts from. */
  readonly forkHistory?: ConversationMessage[]
  /** The words the child works on: the prompt, which a fork prefixes. */
  readonly assignment: string
  readonly access: CapabilityAccess
  readonly model?: string
  readonly effort?: AgentOptions["effort"]
  readonly providerOptions?: ProviderRequestOptions
}

type DispatchPreparation = PreparedDispatch | { readonly ok: false; readonly error: SubagentResult }

export function prepareSubagentTools(input: {
  readonly agent: AgentDefinition
  readonly context: SubagentContext
  readonly deps: SubagentDispatchDeps
  readonly childDepth: number
  readonly continuation?: ContinuationTarget
}): {
  readonly ok: true
  readonly toolNames: string[]
  /** Ambient tools that the grant would leave callable and the child may not call. */
  readonly withheldTools: readonly string[]
  readonly promptKind: PromptKind
  readonly task: string
  readonly maxTurns: number
  readonly grantedTypes: ReadonlySet<string>
} | { readonly ok: false; readonly error: SubagentResult } {
  const { agent, context, deps, childDepth, continuation } = input
  const grantedTypes = grantedSubagentTypes(agent, deps.agentRegistry)
  const allowNestedDispatch = childDepth < 3
  const promptKind: PromptKind = agent.kind === "general" ? deps.parentPromptKind : "subagent"
  // The deepest child sees the dispatch and process tools and has their calls
  // refused. `process` is ambient, so the grant withholds it by name.
  const withheldTools = allowNestedDispatch ? [] : ["process"]
  // A continuation reopens the recorded run: its tool surface and task are
  // the durable ones, never re-derived from the parent's live surface. The
  // checkpoint tools are part of every child's surface, not a grant, so a run
  // recorded without them still compacts; the recorded list stays as it is.
  if (continuation) {
    return {
      ok: true,
      toolNames: [...new Set([...continuation.toolNames, ...CHECKPOINT_TOOL_NAMES])],
      withheldTools,
      promptKind,
      task: continuation.task,
      maxTurns: continuation.maxTurns,
      grantedTypes,
    }
  }
  // `toolNames` is the child's grant for both kinds: every agent of a chat
  // tree is advertised the same tools, so a general clone and a persona
  // differ only in which of them their calls may reach.
  let toolNames: string[]
  let instructions: string
  if (agent.kind === "general") {
    if (!context.availableTools) {
      return { ok: false, error: { content: "The 'general' subagent derives its tools from your registry-approved tool surface, but this context does not expose that surface. Dispatch a persona subagent instead.", outcome: "error" } }
    }
    toolNames = [...cloneInheritedToolNames(context.availableTools, toolRegistryFromComposition(deps.moduleSelection())), "handoff", ...CHECKPOINT_TOOL_NAMES]
    if (grantedTypes.size > 0) toolNames.push("subagent", "process")
    // A general clone works from its assignment alone: the parent's prompt
    // states what it needs.
    instructions = ""
  } else {
    toolNames = personaToolNames(agent, deps.agentRegistry)
    instructions = personaInstructions(agent, deps.skills)
  }
  if (!allowNestedDispatch) toolNames = toolNames.filter((name) => name !== "subagent" && name !== "process")
  return {
    ok: true,
    toolNames,
    withheldTools,
    promptKind,
    task: buildSubagentTask(instructions, toolNames, agent.maxTurns),
    maxTurns: agent.maxTurns,
    grantedTypes,
  }
}

export async function prepareSubagentDispatch(
  input: SubagentInput,
  context: SubagentContext,
  deps: SubagentDispatchDeps,
  continuation?: ContinuationTarget,
): Promise<DispatchPreparation> {
  const validation = validateDispatchInput(input, deps.agentRegistry)
  if (!validation.ok) return { ok: false, error: validation.error }
  let executionCwd = context.executionCwd
  // The child's cwd is a per-agent value that never joins the tree's shared
  // agent host key: it travels in the agent file (`.meta.json` cwd), so
  // children in different directories share one Claude engine process. A new
  // per-agent launch value starts another process, so it belongs in
  // HOST_SPLIT_EXCEPTIONS (provider-claude-agent-sdk/agent-host/host-registry.ts)
  // with its reason.
  if (input.cwd !== undefined) {
    if (typeof input.cwd !== "string" || input.cwd.length === 0) {
      return { ok: false, error: { content: "cwd must be a non-empty string", outcome: "error" } }
    }
    try {
      executionCwd = canonicalDirectory(resolveExecutionDirectoryInput(context.executionCwd, input.cwd), "subagent execution directory")
    } catch (cause) {
      return { ok: false, error: { content: errorMessage(cause), outcome: "error" } }
    }
  }

  const { agentType, prompt, agent, fork } = validation.dispatch
  if (continuation) {
    if (agent.kind !== continuation.personaKind) return { ok: false, error: { content: `Subagent resume inputs no longer match the durable run: persona kind ${continuation.personaKind} is now ${agent.kind}`, outcome: "error" } }
    const composition = deps.moduleSelection()
    const registry = toolRegistryFromComposition(composition)
    for (const name of continuation.toolNames) {
      try {
        const required = toolModuleRequirements(name, registry)
        if (required.some((id) => !composition.enabledModuleIds.includes(id))) {
          return { ok: false, error: { outcome: "error", content: `Saved subagent tool '${name}' is unavailable under the current capability selection` } }
        }
      } catch (error) {
        return { ok: false, error: { outcome: "error", content: `Saved subagent tool '${name}' is unavailable: ${errorMessage(error)}` } }
      }
    }
  }

  let forkHistory: ConversationMessage[] | undefined
  if (fork) {
    if (!context.snapshotConversation) {
      return { ok: false, error: { content: "fork: true needs the parent conversation snapshot, which is not wired in this context. Resubmit the same dispatch without fork and include the needed context in the prompt.", outcome: "error" } }
    }
    try {
      forkHistory = await context.snapshotConversation()
    } catch (cause) {
      return { ok: false, error: { content: `Fork source could not be captured: ${errorMessage(cause)}`, outcome: "error" } }
    }
  }

  const access = context.capabilityAccess ?? NO_CAPABILITY_ACCESS
  let admittedAccess = access
  if (!grantCovers(access.grant, deps.capabilityRequirements)) {
    const admission = await access.admit({ operation: "the subagent tool", required: deps.capabilityRequirements })
    if (!admission.ok) return { ok: false, error: { content: refuseDisabledToolCall("subagent", admission.reason), outcome: "error" } }
    admittedAccess = withCapabilityGrant(access, admission.grant)
  }

  const childRole = continuation ? resolveChildRole(agent, await deps.subagentSessions.resolveRoles(continuation.childSessionId, await deps.captureProviderConnection?.()), deps.briefScope) : undefined
  const resolvedModel: ResolvedDispatchModel = continuation
    ? childRole ?? {}
    : await resolveDispatchModel(agent, deps)
  return {
    ok: true,
    executionCwd,
    agentType,
    prompt,
    agent,
    fork,
    ...(forkHistory ? { forkHistory } : {}),
    assignment: fork ? forkAssignment(prompt) : prompt,
    access: admittedAccess,
    model: resolvedModel.model,
    ...(resolvedModel.effort ? { effort: resolvedModel.effort } : {}),
    ...(resolvedModel.providerOptions ? { providerOptions: resolvedModel.providerOptions } : {}),
  }
}

