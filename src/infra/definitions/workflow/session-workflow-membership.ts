import { Schema } from "effect"

const Id = Schema.NonEmptyString
/** Immutable conversation membership, shared by storage and the published session contract. */
export const WorkflowMembershipSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("attempt"), workflowId: Id, attemptId: Id }),
  Schema.Struct({ kind: Schema.Literal("historical-generation"), workflowId: Id, attemptId: Id, generation: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) }),
  Schema.Struct({ kind: Schema.Literal("historical-follow-up"), workflowId: Id, followUpId: Id }),
])
export type WorkflowMembership = typeof WorkflowMembershipSchema.Type
