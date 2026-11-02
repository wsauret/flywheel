import { Result, Schema } from "effect"
import type { AgentInputAnswer } from "../../protocol/question-protocol-types.js"
import type { AgentInputDecision } from "../session/agent-input-facts.js"
import { migrateFactVersions, type FactMigrationResult } from "./engine.js"

interface AgentInputAnswers {
  [question: string]: AgentInputAnswer
}

const DecisionChoiceSchema = Schema.Struct({ choiceId: Schema.String, label: Schema.String })

/** The decision binding that versions 1 and 2 of `agent_input.requested`
 *  recorded. A workflow launch bound its workflow by a top-level id; the
 *  summary and hashes are fields of a still earlier whole-intent binding,
 *  which no reader compares. Version 3 binds a launch by its source. Remove
 *  this conversion after 2027-04-30. */
const RequestedV2DecisionSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("global_skill_mutation"), proposalId: Schema.String, question: Schema.String, approve: DecisionChoiceSchema, reject: DecisionChoiceSchema }),
  Schema.Struct({ kind: Schema.Literal("definition_override"), preparationId: Schema.String, question: Schema.String, approve: DecisionChoiceSchema, reject: DecisionChoiceSchema }),
  Schema.Struct({
    kind: Schema.Literal("workflow_launch"),
    workflowDefinitionId: Schema.String,
    question: Schema.String,
    approve: DecisionChoiceSchema,
    reject: DecisionChoiceSchema,
    summary: Schema.optionalKey(Schema.String),
    descriptionSha256: Schema.optionalKey(Schema.String),
    definitionSha256: Schema.optionalKey(Schema.String),
  }),
])

const RequestedV1ChoiceSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("option"), choiceId: Schema.optionalKey(Schema.String), label: Schema.String, description: Schema.optionalKey(Schema.String), recommended: Schema.optionalKey(Schema.Boolean), requiresText: Schema.optionalKey(Schema.Boolean) }),
  Schema.Struct({ kind: Schema.Literal("freeform"), label: Schema.String, placeholder: Schema.optionalKey(Schema.String) }),
])
const RequestedV1PayloadSchema = Schema.Struct({
  interactionId: Schema.String,
  conversationId: Schema.String,
  toolUseId: Schema.String,
  request: Schema.Array(Schema.Struct({ question: Schema.String, header: Schema.optionalKey(Schema.String), choices: Schema.Array(RequestedV1ChoiceSchema), multiSelect: Schema.Boolean })),
  decision: Schema.optionalKey(RequestedV2DecisionSchema),
})

/** Version 2 gave every option a stable choice id. */
const RequestedV2ChoiceSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("option"), choiceId: Schema.String, label: Schema.String, description: Schema.optionalKey(Schema.String), recommended: Schema.optionalKey(Schema.Boolean), requiresText: Schema.optionalKey(Schema.Boolean) }),
  Schema.Struct({ kind: Schema.Literal("freeform"), label: Schema.String, placeholder: Schema.optionalKey(Schema.String) }),
])
const RequestedV2PayloadSchema = Schema.Struct({
  interactionId: Schema.String,
  conversationId: Schema.String,
  toolUseId: Schema.String,
  request: Schema.Array(Schema.Struct({ question: Schema.String, header: Schema.optionalKey(Schema.String), choices: Schema.Array(RequestedV2ChoiceSchema), multiSelect: Schema.Boolean })),
  decision: Schema.optionalKey(RequestedV2DecisionSchema),
})

/** The pass id changes whenever an upgrade joins the pass. The engine scans
 *  only above the watermark of a pass id, so a store that ran the earlier id
 *  must scan from the start again to find rows the new upgrade reads. */
const AGENT_INPUT_MIGRATION_ID = "agent-input-contract-v4"

/** A launch bound by a top-level id approved a registered workflow. */
function requestedV3Decision(decision: typeof RequestedV2DecisionSchema.Type): AgentInputDecision {
  if (decision.kind !== "workflow_launch") return decision
  return {
    kind: "workflow_launch",
    source: { kind: "registered", definitionId: decision.workflowDefinitionId },
    question: decision.question,
    approve: decision.approve,
    reject: decision.reject,
  }
}

const AnsweredV1PayloadSchema = Schema.Struct({
  interactionId: Schema.String,
  answers: Schema.Record(Schema.String, Schema.String),
})

const AnsweredV2PayloadSchema = Schema.Struct({
  interactionId: Schema.String,
  answers: Schema.Record(Schema.String, Schema.Union([
    Schema.Struct({ kind: Schema.Literal("choice"), choiceIds: Schema.Array(Schema.String), text: Schema.String }),
    Schema.Struct({ kind: Schema.Literal("freeform"), text: Schema.String }),
  ])),
})

/** Adopts historical requests and answers into the current strict contracts. */
export function migrateAgentInputAnswers(dbFile: string): FactMigrationResult {
  return migrateFactVersions(dbFile, AGENT_INPUT_MIGRATION_ID, [
    {
      type: "agent_input.requested",
      fromVersion: 1,
      rebuild: (payload, storedActor) => {
        const decoded = Schema.decodeUnknownResult(RequestedV1PayloadSchema, { onExcessProperty: "error" })(payload)
        if (Result.isFailure(decoded) || storedActor !== "agent") return { kind: "unreadable" }
        const { decision, ...legacy } = decoded.success
        return {
          version: 3,
          actor: "agent",
          payload: {
            ...legacy,
            request: legacy.request.map((question) => {
              let ordinal = 0
              return {
                ...question,
                choices: question.choices.map((choice) => {
                  if (choice.kind === "freeform") return choice
                  ordinal += 1
                  return choice.choiceId ? choice : { ...choice, choiceId: `choice-${ordinal}` }
                }),
              }
            }),
            ...(decision ? { decision: requestedV3Decision(decision) } : {}),
          },
        }
      },
    },
    {
      type: "agent_input.requested",
      fromVersion: 2,
      rebuild: (payload, storedActor) => {
        const decoded = Schema.decodeUnknownResult(RequestedV2PayloadSchema, { onExcessProperty: "error" })(payload)
        if (Result.isFailure(decoded) || storedActor !== "agent") return { kind: "unreadable" }
        const { decision, ...legacy } = decoded.success
        return { version: 3, actor: "agent", payload: { ...legacy, ...(decision ? { decision: requestedV3Decision(decision) } : {}) } }
      },
    },
    {
      type: "agent_input.answered",
      fromVersion: 1,
      rebuild: (payload, storedActor) => {
        const decoded = Schema.decodeUnknownResult(AnsweredV1PayloadSchema, { onExcessProperty: "error" })(payload)
        if (Result.isFailure(decoded) || storedActor !== "user") return { kind: "unreadable" }
        const legacy = decoded.success
        const answers: AgentInputAnswers = {}
        for (const [question, text] of Object.entries(legacy.answers)) answers[question] = { kind: "freeform", text }
        return { version: 3, actor: "user", payload: { interactionId: legacy.interactionId, answers } }
      },
    },
    {
      type: "agent_input.answered",
      fromVersion: 2,
      rebuild: (payload, storedActor) => {
        const decoded = Schema.decodeUnknownResult(AnsweredV2PayloadSchema, { onExcessProperty: "error" })(payload)
        if (Result.isFailure(decoded) || storedActor !== "user") return { kind: "unreadable" }
        const legacy = decoded.success
        const answers: AgentInputAnswers = {}
        for (const [question, answer] of Object.entries(legacy.answers)) {
          answers[question] = answer.kind === "choice"
            ? { kind: "choice", selections: answer.choiceIds.map((choiceId) => ({ choiceId })), text: answer.text }
            : answer
        }
        return { version: 3, actor: "user", payload: { interactionId: legacy.interactionId, answers } }
      },
    },
  ])
}
