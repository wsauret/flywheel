import { Schema } from "effect"
import { contentEvidence } from "../../infra/content-evidence.js"
import { defineFact } from "../../infra/event-registry.js"

/** The durable record of each agent output: `handoff.written` holds the
 *  payload an attempt submitted, and `handoff.validated` holds the verdict
 *  of the handoff boundary on it. */

const HandoffIssueSchema = Schema.Struct({
  path: Schema.String,
  message: Schema.String,
  hint: Schema.optionalKey(Schema.String),
})

// Version 1, the stored shape that builds before the agent lexicon wrote: `stepId` held the
// attempt id and the stored key `stepName` the agent's name. Readers name both by their
// value. Remove after 2027-04-30.
const HandoffBaseV1Schema = Schema.Struct({
  stepId: Schema.String, // stored key of version 1
  stepName: Schema.String, // stored key of version 1
  definitionId: Schema.String,
  workflowDefinitionId: Schema.String,
  // History only: builds before the brief cutover named the agent's
  // handoff type here. No current writer sets it. A stored fact keeps it, an
  // excess key is a decode error, and event search prints it when a fact
  // carries it. Remove after 2027-04-30.
  handoffType: Schema.optionalKey(Schema.String),
})

/** The attempt and definitions one output fact belongs to. */
const HandoffBaseSchema = Schema.Struct({
  attemptId: Schema.String,
  agentName: Schema.String,
  definitionId: Schema.String,
  workflowDefinitionId: Schema.String,
})

const WrittenFields = {
  content: Schema.Record(Schema.String, Schema.Unknown),
  bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  sha256: Schema.String,
  preview: Schema.String,
}

const ValidatedFields = {
  status: Schema.Union([Schema.Literal("passed"), Schema.Literal("failed")]),
  issues: Schema.mutable(Schema.Array(HandoffIssueSchema)),
}

const HandoffWrittenV1FactSchema = defineFact({
  type: "handoff.written",
  version: 1,
  actor: Schema.Literal("worker"),
  payload: HandoffBaseV1Schema.pipe(Schema.fieldsAssign(WrittenFields)),
})

const HandoffValidatedV1FactSchema = defineFact({
  type: "handoff.validated",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: HandoffBaseV1Schema.pipe(Schema.fieldsAssign(ValidatedFields)),
})

const HandoffWrittenFactSchema = defineFact({
  type: "handoff.written",
  version: 2,
  actor: Schema.Literal("worker"),
  payload: HandoffBaseSchema.pipe(Schema.fieldsAssign(WrittenFields)),
})

const HandoffValidatedFactSchema = defineFact({
  type: "handoff.validated",
  version: 2,
  actor: Schema.Literal("flywheel"),
  payload: HandoffBaseSchema.pipe(Schema.fieldsAssign(ValidatedFields)),
})

export const HandoffFactSchemas = [
  HandoffWrittenV1FactSchema,
  HandoffValidatedV1FactSchema,
  HandoffWrittenFactSchema,
  HandoffValidatedFactSchema,
] as const

const StoredHandoffFactSchema = Schema.Union(HandoffFactSchemas)
const CurrentHandoffFactSchema = Schema.Union([HandoffWrittenFactSchema, HandoffValidatedFactSchema])

/** A handoff fact in the current shape. A reader receives a version 1 fact
 *  in this shape too. */
export type HandoffFact = typeof CurrentHandoffFactSchema.Type
export type HandoffIssue = typeof HandoffIssueSchema.Type

/** Decode a stored handoff fact of any version into the current shape. */
export function parseHandoffFact(value: unknown): HandoffFact {
  const fact = Schema.decodeUnknownSync(StoredHandoffFactSchema, { onExcessProperty: "error" })(value)
  if (fact.version === 2) return fact
  if (fact.type === "handoff.written") {
    const { stepId, stepName, handoffType: _retired, ...rest } = fact.payload // stored keys of version 1
    return { ...fact, version: 2, payload: { attemptId: stepId, agentName: stepName, ...rest } } // stored keys of version 1
  }
  const { stepId, stepName, handoffType: _retired, ...rest } = fact.payload // stored keys of version 1
  return { ...fact, version: 2, payload: { attemptId: stepId, agentName: stepName, ...rest } } // stored keys of version 1
}

type HandoffIdentity = typeof HandoffBaseSchema.Type

export interface HandoffWrittenInput extends HandoffIdentity {
  readonly content: { readonly [key: string]: unknown }
}

export interface HandoffValidationInput extends HandoffIdentity {
  readonly status: "passed" | "failed"
  readonly issues: readonly HandoffIssue[]
}

export function buildHandoffWrittenFact(input: HandoffWrittenInput): HandoffFact {
  return parseHandoffFact({
    type: "handoff.written",
    version: 2,
    actor: "worker",
    payload: {
      ...identityPayload(input),
      content: input.content,
      ...contentEvidence(JSON.stringify(input.content)),
    },
  })
}

export function buildHandoffValidatedFact(input: HandoffValidationInput): HandoffFact {
  return parseHandoffFact({
    type: "handoff.validated",
    version: 2,
    actor: "flywheel",
    payload: {
      ...identityPayload(input),
      status: input.status,
      issues: [...input.issues],
    },
  })
}

function identityPayload(input: HandoffIdentity): HandoffIdentity {
  return {
    attemptId: input.attemptId,
    agentName: input.agentName,
    definitionId: input.definitionId,
    workflowDefinitionId: input.workflowDefinitionId,
  }
}
