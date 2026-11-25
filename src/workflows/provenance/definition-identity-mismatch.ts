import { Schema, SchemaTransformation } from "effect"

const IdSchema = Schema.NonEmptyString

const AgentAspectSchema = Schema.Literals(["policy", "content", "output"])

/** A changed agent record: its policy, its brief content, or its output. */
const AgentMismatchSchema = Schema.Struct({
  component: Schema.Literal("agent"),
  definitionId: IdSchema,
  aspect: AgentAspectSchema,
  recorded: Schema.String,
  current: Schema.String,
})

/** One difference between a recorded and a current definition identity. */
export const DefinitionIdentityMismatchSchema = Schema.Union([
  Schema.Struct({
    component: Schema.Literal("workflow"),
    definitionId: IdSchema,
    recorded: Schema.String,
    current: Schema.String,
  }),
  Schema.Struct({
    component: Schema.Literal("graph"),
    definitionId: IdSchema,
    recorded: Schema.String,
    current: Schema.String,
  }),
  Schema.Struct({
    component: Schema.Literal("phase"),
    phaseId: IdSchema,
    recorded: Schema.String,
    current: Schema.String,
  }),
  AgentMismatchSchema,
  // A changed record, as builds before the agent lexicon recorded it in
  // adoption and drift facts. It reads as the `agent` change it is, so a
  // replay compares it with the evidence that a current build computes.
  // Remove after 2027-04-30.
  Schema.Struct({
    component: Schema.Literal("step"), // stored kind of adoption and drift evidence
    stepId: IdSchema, // stored key of adoption and drift evidence
    aspect: AgentAspectSchema,
    recorded: Schema.String,
    current: Schema.String,
  }).pipe(Schema.decodeTo(AgentMismatchSchema, SchemaTransformation.transform({
    decode: ({ stepId, component: _retired, ...change }) => ({ component: "agent" as const, definitionId: stepId, ...change }), // stored key
    encode: ({ definitionId, component: _current, ...change }) => ({ component: "step" as const, stepId: definitionId, ...change }), // stored kind and key
  }))),
  Schema.Struct({
    component: Schema.Literal("version"),
    recorded: Schema.String,
    current: Schema.String,
  }),
  Schema.Struct({
    component: Schema.Literal("skill"),
    skillId: IdSchema,
    recorded: Schema.String,
    current: Schema.String,
  }),
  Schema.Struct({
    component: Schema.Literal("persona"),
    personaName: IdSchema,
    recorded: Schema.String,
    current: Schema.String,
  }),
  // Evidence that builds before the brief cutover recorded, in
  // adoption and drift facts. Readable, never produced for a current
  // identity. Remove after 2027-04-30.
  Schema.Struct({
    component: Schema.Literal("binding"),
    bindingId: IdSchema,
    recorded: Schema.String,
    current: Schema.String,
  }),
  Schema.Struct({
    component: Schema.Literal("registry"),
    handoffType: IdSchema,
    recorded: Schema.String,
    current: Schema.String,
  }),
])
export type DefinitionIdentityMismatch = typeof DefinitionIdentityMismatchSchema.Type
