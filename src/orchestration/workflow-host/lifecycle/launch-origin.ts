/** Trusted model launch context and file approval bindings (ARCH-WORKFLOWS-015, ARCH-WORKFLOWS-016).
 *  The host attests the parent, conversation, and call ids. The runtime
 *  composes approval choices from the file and binds its path and hash,
 *  so model input cannot supply its own approval authority. */

import type { DecisionRefusal } from "../../session/agent-input/agent-input-decision.js"
import type { AgentInputDecision, WorkflowLaunchApprovalSource } from "../../session/agent-input/agent-input-facts.js"
import type { ProjectDefinitionRegistryRevision } from "../../../workflows/definitions/definition-registry.js"
import { describeDefinitionRefusal, readPathWorkflow, workflowFileName } from "./path-workflow.js"
import { stageWorkflowSource } from "../../agent-runtime/tools/definitions/workflow-staging.js"
import { NO_WORKFLOW_DIRECTORY, type ModelWorkflowLaunchContext, type ModelWorkflowLaunchIntent, type ResolveWorkflowLaunchTarget, type WorkflowLaunchRefusal } from "../../agent-runtime/tools/definitions/workflow-launch.js"

/** What every refusal of a model-originated launch ends with. The model cannot
 *  recover from prose, so each refusal names the one recovery path for each
 *  role. Only a root chat asks the person (PI-AGENT-024). A child that planned
 *  `workflow` under On mode still reaches this refusal when the person sets
 *  Ask before its call lands, because the mode is read at the call. */
const WORKFLOW_LAUNCH_RETRY_INSTRUCTION = "Call ask_user with a workflow_launch decision naming the same source. After the user approves, retry workflow with the confirmation_id returned by ask_user. A child session has no ask_user: message your parent with message_session to ask it for the launch."

export interface ModelWorkflowLaunchOrigin extends ModelWorkflowLaunchContext {
  readonly kind: "model"
  /** Parent chat session, stamped by the host that owns the runner. */
  readonly chatSessionId: string
}

/** A model's launch: it answers with the live run its tool call follows.
 *  `input` is the structured launch input as the tool call passed it, before
 *  the workflow's input contract decodes it. A runtime launch is stored as
 *  a durable intent before it prepares, so only this launch carries input. */
export interface ModelWorkflowLaunchRequest extends ModelWorkflowLaunchIntent {
  readonly origin: ModelWorkflowLaunchOrigin
  readonly input?: unknown
}

export function modelWorkflowLaunchOrigin(chatSessionId: string, context: ModelWorkflowLaunchContext): ModelWorkflowLaunchOrigin {
  return { kind: "model", chatSessionId, ...context }
}

/** The target resolver of one chat session. A path source reads the file through the
 *  path pipeline, so the approval binds the resolved path and the hash of
 *  the definition that the question shows. */
export function workflowLaunchTargets(input: {
  /** The definitions a launch would capture now. The question reads a
   *  workflow file against them, so the file it shows is the file that a
   *  launch admits. */
  readonly revision: () => ProjectDefinitionRegistryRevision
  /** The calling session's directory; a session without one has no scratch
   *  directory and launches no workflow file. */
  readonly sessionDir: string | undefined
  /** The agent's working directory, from which a relative workflow file path resolves first. */
  readonly executionCwd: string
}): ResolveWorkflowLaunchTarget {
  return async (source) => {
    const revision = input.revision()
    if (input.sessionDir === undefined) return { error: NO_WORKFLOW_DIRECTORY }
    const staged = stageWorkflowSource(source, input.sessionDir, input.executionCwd)
    if ("error" in staged) return staged
    const { path } = staged
    const read = await readPathWorkflow({ path, sessionDir: input.sessionDir, revision, ...(staged.savedContent === undefined ? {} : { savedContent: staged.savedContent }) })
    if (!read.ok) return { ...describeDefinitionRefusal(`The workflow file ${workflowFileName(path, input.sessionDir)} cannot be approved: `, read), ...(read.recovery ? { recovery: read.recovery } : {}) }
    return {
      source: { kind: "path", path: read.file, definitionSha256: read.definitionSha256 },
      name: read.workflow.name,
      ...(read.workflow.description ? { description: read.workflow.description } : {}),
    }
  }
}

/** What one launch would start, as an approval binds it. A workflow file
 *  that the loader converted from the retired step grammar also names the
 *  hash of its record in that retired grammar, which an approval asked before phases
 *  bound, so that approval still admits the file it showed. Remove the
 *  member after 2027-04-30. */
export type WorkflowApprovalBinding = Extract<WorkflowLaunchApprovalSource, { kind: "path" }> & { readonly retiredDefinitionSha256?: string }

/** Why this approval does not authorize this launch, or undefined when it does.
 *  The binding names one source; approval of one source never authorizes a
 *  launch of another, approval of a workflow file never authorizes the file
 *  after an edit, and an ordinary answered question authorizes nothing.
 *  `describe` names a source for the model. */
export function workflowLaunchMismatch(input: {
  readonly decision: AgentInputDecision
  /** Conversation the approved question was asked in. */
  readonly conversationId: string
  readonly origin: ModelWorkflowLaunchOrigin
  /** What this launch would start, as its approval binds it. */
  readonly source: WorkflowApprovalBinding
  readonly describe: (source: WorkflowLaunchApprovalSource) => string
}): string | undefined {
  const { decision, source } = input
  if (decision.kind !== "workflow_launch") return "That confirmation carries no workflow_launch decision, and an ordinary answered question is not approval."
  if (input.conversationId !== input.origin.conversationId) return "That confirmation was answered in another conversation."
  const approved = decision.source
  // Pending named approvals cannot authorize a file. Remove after 2027-04-30.
  if (approved.kind === "registered") return `That confirmation approves the retired ${approved.definitionId} workflow, which Flywheel no longer launches, not ${input.describe(source)}.`
  const same = approved.path === source.path
  if (!same) return `That confirmation approves ${input.describe(approved)}, not ${input.describe(source)}.`
  if (approved.kind === "path" && source.kind === "path" && approved.definitionSha256 !== source.definitionSha256 && approved.definitionSha256 !== source.retiredDefinitionSha256) {
    return `That confirmation approves the workflow file ${source.path} as it was when the question was asked, and the file changed after that. Ask again to approve the file as it is now.`
  }
  return undefined
}

/** One approval refusal the model can act on: the specific reason, then the
 *  one recovery path. Prompt guidance describes the normal path; this is the
 *  boundary. */
export function approvalRefusal(reason: string): WorkflowLaunchRefusal {
  return { error: reason, recovery: WORKFLOW_LAUNCH_RETRY_INSTRUCTION }
}

export function workflowLaunchRefusal(reason: DecisionRefusal, confirmationId: string): WorkflowLaunchRefusal {
  return approvalRefusal(claimRefusalReason(reason, confirmationId))
}

function claimRefusalReason(reason: DecisionRefusal, confirmationId: string): string {
  switch (reason.kind) {
    case "missing":
      return `No question ${confirmationId} exists in this session, so nothing approved this launch.`
    case "not-answered":
      return `Question ${confirmationId} is ${reason.state}, not answered.`
    case "no-decision":
      return `Question ${confirmationId} carries no workflow_launch decision, and an ordinary answered question is not approval.`
    case "mismatched":
      return reason.detail
    case "rejected":
      return `The user did not approve this launch (answer: ${reason.answer}).`
    case "consumed":
      return `Confirmation ${confirmationId} was already used, and one approval launches one workflow.`
    case "writer-disposed":
      return "The confirmation could not be claimed durably because this session stopped recording, so no workflow started."
    case "sequence-contended":
      return "The confirmation could not be claimed because the session is writing too fast."
  }
}
