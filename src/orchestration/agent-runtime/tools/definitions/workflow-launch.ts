/** What one model `workflow` call states and what it reads back: the
 *  trusted call context and the launch intent that the host binds
 *  (ARCH-WORKFLOWS-015, ARCH-WORKFLOWS-016), the approval question that
 *  `ask_user` asks for a workflow file, and the refusal words the model
 *  reads. The host that resolves and admits a launch reads this contract. */

import type { WorkflowCallSource, WorkflowLaunchSource } from "../../../../infra/substrate/output/tools/workflow-call-source.js"
import type { WorkflowLaunchApprovalSource } from "../../../session/agent-input/agent-input-facts.js"
import type { LaunchingSessionAuthority } from "../../../workflow-host/lifecycle/path-workflow.js"
import type { CapabilityAccess } from "../types.js"

/** Why a session without a scratch directory launches no workflow file. */
export const NO_WORKFLOW_DIRECTORY = "This session has no scratch directory, so it cannot launch a workflow file."

export type WorkflowLaunchConfirmation =
  | { readonly kind: "supplied"; readonly confirmationId: string }
  | { readonly kind: "absent" }

/** Trusted call context of one model `workflow` call, plus the untrusted
 *  confirmation value that call carried. */
export interface ModelWorkflowLaunchContext {
  readonly conversationId: string
  readonly toolUseId: string
  readonly confirmation: WorkflowLaunchConfirmation
  /** The tools and personas of the calling session, which a workflow file
   *  may grant its agents. The tool derives it from its runner's planned
   *  tools. */
  readonly authority: LaunchingSessionAuthority
  /** The capability boundary of the calling agent, as its tool call holds it.
   *  The launch records its ceiling and whether a person reads the tree with
   *  the run, so the workflow's agents keep them in every start of the run
   *  (PI-AGENT-121).
   *  Absent when the call's context holds no capability policy. */
  readonly capabilityAccess?: CapabilityAccess
}

/** The intent one model launch states. The tool saves
 *  the content of a content call first, so a launch names the saved file. */
export interface ModelWorkflowLaunchIntent {
  readonly source: WorkflowLaunchSource
  readonly summary?: string
  readonly description: string
  readonly launchCwd?: string
  /** The bytes saved by this content call, carried only until definition admission. */
  readonly savedContent?: string
}

const APPROVE_CHOICE_ID = "approve"
const INLINE_CHOICE_ID = "inline"
const DECISION_HEADER = "Workflow"

/** The file definition that the approval question shows. */
export interface WorkflowLaunchTarget {
    readonly source: Extract<WorkflowLaunchApprovalSource, { kind: "path" }>
    readonly name: string
    readonly description?: string
  }

/** The target one approval names, or why it cannot be approved. A path
 *  target reads the file through the path pipeline, so the question shows
 *  the definition that the approval binds. A content target saves and judges
 *  those bytes as the launch does, retaining the file's path, so a launch of
 *  the same content, or of the saved file, matches the approval. */
export type ResolveWorkflowLaunchTarget = (source: WorkflowCallSource) => Promise<WorkflowLaunchTarget | WorkflowLaunchRefusal>

/** Approval choices name the file and state what its definition says it does. */
function launchChoices(target: WorkflowLaunchTarget, approveLabel: string) {
  return [
    { kind: "option", choiceId: APPROVE_CHOICE_ID, label: approveLabel, description: `Run the workflow file ${target.source.path}${target.description ? `: ${target.description}` : "."}` },
    { kind: "option", choiceId: INLINE_CHOICE_ID, label: "Do the work inline", description: "Do not start the workflow file, and do the work in this chat." },
  ] as const
}

/** Compose the one question a model-originated launch is decided by. The user
 *  reads the workflow name and answers with Flywheel's own choices; the launch
 *  intent itself is already legible in the conversation that proposed it. */
export function workflowLaunchDecision(target: WorkflowLaunchTarget) {
  const approve = { choiceId: APPROVE_CHOICE_ID, label: `Start the ${target.name} workflow` }
  const choices = launchChoices(target, approve.label)
  const reject = { choiceId: INLINE_CHOICE_ID, label: choices[1].label }
  const question = `Launch the ${target.name} workflow?`
  return {
    decision: { kind: "workflow_launch", source: target.source, question, approve, reject },
    question: {
      question,
      header: DECISION_HEADER,
      choices: [...choices, { kind: "freeform", label: "Other" }],
      multiSelect: false,
    },
  }
}

/** A refused model-originated launch. `error` is the complete reason, the
 *  words a person reads on the launch card. `recovery` is the one path the
 *  model takes next, which the model reads after the reason. */
export interface WorkflowLaunchRefusal {
  readonly error: string
  /** Each located problem of a workflow file, for the agent that repairs it. */
  readonly problems?: readonly string[]
  readonly recovery?: string
}

/** A refusal as the words the agent reads: the reason, each located
 *  problem on its own line, then the recovery. A reason that spans lines
 *  ends on a line of its own, so its recovery takes a line of its own. */
export function workflowRefusalText(refusal: WorkflowLaunchRefusal): string {
  const reason = [refusal.error, ...(refusal.problems ?? []).map((problem) => `- ${problem}`)].join("\n")
  return refusal.recovery === undefined ? reason : `${reason}${reason.includes("\n") ? "\n" : " "}${refusal.recovery}`
}

export interface ModelPair {
  readonly model: string
  readonly effort: string
}

/** A temporary launch preview, not persisted request policy. */
export interface WorkflowAgentModels {
  readonly pairs: readonly (ModelPair & { readonly definitionIds: readonly string[] })[]
  readonly unavailable?: readonly { readonly definitionId: string; readonly reason: "no-selection" | "access-pending" }[]
  readonly personas: readonly { readonly persona: string; readonly agentIds: readonly string[] }[]
}
