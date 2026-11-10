import type { ConversationMessage } from "../../../agent-runtime/llm/types.js"
import type { CapabilityAccess } from "../../../agent-runtime/tools/types.js"
import type { CapabilityCheck } from "../../../../infra/capability-text.js"
import type { ContextAdmission } from "../../../agent-runtime/compaction/compaction-policy.js"
import type { ToolOutcome } from "../../../../infra/tool-outcome.js"
import { errorMessage } from "../../../../infra/error-message.js"
import { Schema } from "effect"
import type { ModuleId } from "../../../../protocol/module-ids.js"
import type { SubagentDispatchDeps } from "./dispatch-deps.js"
import type { ChildSessionResumeAttempt } from "../../../module-seams.js"
import { readSubagentRuns } from "../history/subagent-run-projection.js"

export interface SubagentInput {
  [key: string]: unknown
}

export interface SubagentResult {
  content: string
  outcome: ToolOutcome
  deferCompletion?: boolean
}

export interface SubagentContext {
  executionCwd: string
  projectRoot: string
  signal?: AbortSignal
  toolUseId?: string
  modelRequestId?: string
  parentToolUseId?: string
  conversationId?: string
  availableTools?: ReadonlySet<string>
  artifactScopeId: string
  snapshotConversation?: () => Promise<ConversationMessage[]>
  contextAdmission?: ContextAdmission
  capabilityAccess?: CapabilityAccess
  /** The dispatcher's agent check, for the text of a refusal that only it reads. */
  capabilities?: CapabilityCheck
}

/** The saved run that a Resume continues: the same run after a cut, or a
 *  new attempt after a run that settled without completing. */
export interface ContinuationTarget {
  readonly childSessionId: string
  readonly childConversationId: string
  readonly childRunId: string
  readonly attempt: ChildSessionResumeAttempt
  readonly interruptionReason?: "runtime_restarted"
  readonly task: string
  readonly toolNames: readonly string[]
  readonly personaKind: "general" | "persona"
  readonly capabilityGrant: NonNullable<CapabilityAccess["grant"]>
  readonly admittedModuleIds: readonly ModuleId[]
  readonly skillsRevision: number
  readonly maxTurns: number
  readonly maxTokens: number
}

type ContinueDispatch = (
  input: SubagentInput,
  context: SubagentContext,
  deps: SubagentDispatchDeps,
  continuation: ContinuationTarget,
) => Promise<SubagentResult>

/** Continues a non-completed direct child from its saved inputs and history.
 *  The parent's `process` Resume and a person's Resume control both retain
 *  the original parent binding. A settled attempt, such as a run that
 *  failed, gets a new run without replacing its result. */
export async function resumeSubagentSession(
  childSessionId: string,
  context: SubagentContext,
  deps: SubagentDispatchDeps,
  dispatch: ContinueDispatch,
): Promise<SubagentResult> {
  const saved = deps.sessionEventStore ? (await readSubagentRuns(deps.sessionEventStore, childSessionId)).at(-1) : undefined
  const parentConversationId = saved?.parentConversationId ?? context.conversationId
  if (!parentConversationId) throw new Error("Subagent resume requires a parent conversation id")
  const resume = await deps.subagentSessions.prepareResume({
    childSessionId,
    parentSessionId: deps.sessionId,
    parentConversationId,
  })
  if (!resume.ok) return { content: resume.error, outcome: "error" }
  try {
    if (!deps.agentRegistry.has(resume.run.agentType)) return { outcome: "error", content: `Subagent persona '${resume.run.agentType}' is not available to this caller` }
    const dispatched = await dispatch({
      persona: resume.run.agentType,
      description: resume.run.description,
      rationale: "Resume the direct child from its recorded context.",
      prompt: resume.run.prompt,
      cwd: resume.run.executionCwd,
    }, {
      ...context,
      conversationId: parentConversationId,
      toolUseId: resume.run.parentToolUseId,
      ...(resume.run.modelRequestId ? { modelRequestId: resume.run.modelRequestId } : {}),
    }, deps, {
      childSessionId,
      childConversationId: resume.run.conversationId,
      childRunId: resume.run.childRunId,
      attempt: resume.attempt,
      ...(resume.run.interruptionReason ? { interruptionReason: resume.run.interruptionReason } : {}),
      task: resume.run.task,
      toolNames: resume.run.promptToolNames,
      personaKind: resume.run.personaKind,
      capabilityGrant: resume.run.capabilityGrant,
      admittedModuleIds: resume.run.admittedModuleIds,
      skillsRevision: resume.run.skillsRevision,
      maxTurns: resume.run.maxTurns,
      maxTokens: resume.run.maxTokens,
    })
    // A refused dispatch is the answer; reporting "resumed" over it would
    // leave the caller waiting on a child that never started.
    if (dispatched.outcome !== "ok") return dispatched
    const acknowledgement = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.NonEmptyString }))(JSON.parse(dispatched.content))
    return { content: JSON.stringify({ status: "resumed", session_id: childSessionId, id: acknowledgement.id }), outcome: "ok" }
  } catch (error) {
    return { content: `Subagent resume was not admitted: ${errorMessage(error)}`, outcome: "error" }
  }
}
