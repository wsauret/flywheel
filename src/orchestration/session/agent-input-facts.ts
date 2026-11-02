import { Schema } from "effect"
import { defineFact } from "../../infra/event-registry.js"
import { AgentInputAnswerSchema } from "../../protocol/question-protocol-types.js"


const CurrentQuestionChoiceSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("option"),
    choiceId: Schema.String,
    label: Schema.String,
    description: Schema.optionalKey(Schema.String),
    recommended: Schema.optionalKey(Schema.Boolean),
    requiresText: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({ kind: Schema.Literal("freeform"), label: Schema.String, placeholder: Schema.optionalKey(Schema.String) }),
])

const CurrentQuestionEntrySchema = Schema.Struct({ question: Schema.String, header: Schema.optionalKey(Schema.String), choices: Schema.mutable(Schema.Array(CurrentQuestionChoiceSchema)), multiSelect: Schema.Boolean })

/** Typed decision binding of one question. The interaction is bound to the exact
 *  intent it decides and to the two stable choice ids that answer it, so a later
 *  claimant reads approval from the recorded binding instead of interpreting free
 *  text. An arbitrary answered question carries no binding and can never approve
 *  anything. */
const DecisionChoiceSchema = Schema.Struct({ choiceId: Schema.String, label: Schema.String })

const GlobalSkillMutationDecisionSchema = Schema.Struct({
  kind: Schema.Literal("global_skill_mutation"),
  /** Store-prepared whole-package mutation identity this question decides. */
  proposalId: Schema.String,
  /** The question text the answers record is keyed by. */
  question: Schema.String,
  approve: DecisionChoiceSchema,
  reject: DecisionChoiceSchema,
})

const DefinitionOverrideDecisionSchema = Schema.Struct({
  kind: Schema.Literal("definition_override"),
  preparationId: Schema.String,
  question: Schema.String,
  approve: DecisionChoiceSchema,
  reject: DecisionChoiceSchema,
})

/** What one launch approval binds. A recorded named workflow binds its id. A
 *  workflow file binds its resolved path and the canonical definition hash
 *  of the file that the question showed, so an approval never covers a file
 *  edited after the question. */
const WorkflowLaunchApprovalSourceSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("registered"), definitionId: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("path"), path: Schema.String, definitionSha256: Schema.String }),
])

export type WorkflowLaunchApprovalSource = typeof WorkflowLaunchApprovalSourceSchema.Type

/** One model-originated workflow launch the user approved
 *  (ARCH-WORKFLOWS-016). The approval binds the source it launches; the summary and
 *  description are launch inputs the conversation already made legible to
 *  the user, not approval content. */
const WorkflowLaunchDecisionSchema = Schema.Struct({
  kind: Schema.Literal("workflow_launch"),
  source: WorkflowLaunchApprovalSourceSchema,
  question: Schema.String,
  approve: DecisionChoiceSchema,
  reject: DecisionChoiceSchema,
})

const AgentInputDecisionSchema = Schema.Union([GlobalSkillMutationDecisionSchema, DefinitionOverrideDecisionSchema, WorkflowLaunchDecisionSchema])

const AgentInputRequestedSchema = defineFact({
  type: "agent_input.requested",
  version: 3,
  actor: Schema.Literal("agent"),
  payload: Schema.Struct({
    interactionId: Schema.String,
    conversationId: Schema.String,
    toolUseId: Schema.String,
    request: Schema.Array(CurrentQuestionEntrySchema),
    decision: Schema.optionalKey(AgentInputDecisionSchema),
  }),
})

const AgentInputAnsweredSchema = defineFact({
  type: "agent_input.answered",
  version: 3,
  actor: Schema.Literal("user"),
  payload: Schema.Struct({
    interactionId: Schema.String,
    answers: Schema.Record(Schema.String, AgentInputAnswerSchema),
  }),
})

const AgentInputCancelledSchema = defineFact({
  type: "agent_input.cancelled",
  version: 1,
  actor: Schema.Literal("user"),
  payload: Schema.Struct({
    interactionId: Schema.String,
    reason: Schema.String,
  }),
})

/** History only: an earlier build wrote this when a planned replacement cut
 *  a turn that waited on a question. The question closed without an answer
 *  from anyone; the ask still reads as an interrupted tool call, so a turn
 *  resumed over it asks again. No current writer produces it (PI-REMOTE-012). */
const AgentInputWithdrawnV1Schema = defineFact({
  type: "agent_input.withdrawn",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    interactionId: Schema.String,
    reason: Schema.Literal("runtime_interrupted"),
  }),
})

/** A question that Flywheel closed because no answer can still act on it.
 *  `child_question_retired`: an agent of a workflow asked it in a build before
 *  such agents stopped asking the person (PI-AGENT-024). The workflow
 *  withdraws it when it resumes, and the ask settles with a result that tells
 *  the agent to message its parent instead. The withdrawal that writes it is
 *  removed after 2027-04-03.
 *  `workflow_launch_retired`: it asks to launch a workflow by name, which no
 *  workflow can be now. Recovery withdraws it, and the ask settles with a
 *  result that names the retired workflow. The withdrawal that writes it is
 *  removed after 2027-04-30. The fact stays readable as history. */
const AgentInputWithdrawnSchema = defineFact({
  type: "agent_input.withdrawn",
  version: 2,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    interactionId: Schema.String,
    reason: Schema.Literals(["child_question_retired", "workflow_launch_retired"]),
  }),
})

/** Single use of one answered decision. The claim is the durable authority:
 *  it is appended under an `expectedSeq` guard, so exactly one claimant wins
 *  and no parallel uniqueness row exists. */
const AgentInputConsumedSchema = defineFact({
  type: "agent_input.consumed",
  version: 1,
  actor: Schema.Literal("agent"),
  payload: Schema.Struct({
    interactionId: Schema.String,
    /** The mutation that consumed the answer; a second mutation is refused. */
    claimId: Schema.String,
  }),
})

export const AgentInputFactSchemas = [AgentInputRequestedSchema, AgentInputAnsweredSchema, AgentInputCancelledSchema, AgentInputWithdrawnV1Schema, AgentInputWithdrawnSchema, AgentInputConsumedSchema] as const
const AgentInputFactSchema = Schema.Union(AgentInputFactSchemas)
export type AgentInputFact = typeof AgentInputFactSchema.Type
export type AgentInputDecision = typeof AgentInputDecisionSchema.Type

export function parseAgentInputFact(value: unknown): AgentInputFact {
  return Schema.decodeUnknownSync(AgentInputFactSchema, { onExcessProperty: "error" })(value)
}

export const AGENT_INPUT_FACT_TYPES = ["agent_input.requested", "agent_input.answered", "agent_input.cancelled", "agent_input.withdrawn", "agent_input.consumed"] as const

export function agentInputConsumedFact(payload: { interactionId: string; claimId: string }): AgentInputFact {
  return { type: "agent_input.consumed", version: 1, actor: "agent", payload }
}