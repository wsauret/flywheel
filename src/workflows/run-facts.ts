import { Schema } from "effect"
import { defineFact, factTypes } from "../infra/event-registry.js"
import { RoleAssignmentSnapshotSchema } from "../infra/role-settings.js"

export const WorkflowLaunchBindingSchema = Schema.Struct({
  parentSessionId: Schema.NonEmptyString,
  conversationId: Schema.NonEmptyString,
  toolUseId: Schema.NonEmptyString,
  workflowDefinitionId: Schema.optionalKey(Schema.NonEmptyString),
  description: Schema.optionalKey(Schema.String),
})

/** The capability boundary of the agent that launched a run, which every start of the run keeps (PI-AGENT-121).
 *  `ceiling` names the only modules the run may use; without it, the run may use every module. `unattended` marks a
 *  run that no person reads. The ceiling holds plain strings, so a module id that a later version removes leaves the
 *  fact readable and admits nothing. */
export const WorkflowCapabilityBoundarySchema = Schema.Struct({
  ceiling: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  unattended: Schema.optionalKey(Schema.Literal(true)),
})
export type WorkflowCapabilityBoundary = typeof WorkflowCapabilityBoundarySchema.Type

/** Run configuration survives control-root replacement. Registration records the original request and binding once. */
export const WorkflowRunSettingsSchema = Schema.Struct({
  workflowDefinitionId: Schema.NonEmptyString,
  label: Schema.String,
  shortLabel: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  userNamed: Schema.optionalKey(Schema.Literal(true)),
  createdAt: Schema.String,
  lastUpdated: Schema.String,
  executionCwd: Schema.optionalKey(Schema.String),
  authProfileId: Schema.optionalKey(Schema.NonEmptyString),
  roleAssignments: RoleAssignmentSnapshotSchema,
  /** Immutable source scope for indivisible historical accounting and damaged units. */
  historicalResidualAggregateId: Schema.optionalKey(Schema.NonEmptyString),
})

const WorkflowRunRegisteredSchema = defineFact({
  type: "workflow.run.registered", version: 1, actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    settings: WorkflowRunSettingsSchema,
    request: Schema.NullOr(Schema.String),
    launchedFrom: WorkflowLaunchBindingSchema,
    /** Absent in every run registered before launches recorded their boundary, and in every run whose launcher had
     *  the whole boundary. Absence is the whole boundary, so the earlier shape needs no conversion. */
    capabilityBoundary: Schema.optionalKey(WorkflowCapabilityBoundarySchema),
  }),
})
const WorkflowRunSettingsUpdatedSchema = defineFact({
  type: "workflow.run.settings.updated", version: 1, actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({ settings: WorkflowRunSettingsSchema, labelSource: Schema.Literals(["user", "generated", "configuration"]) }),
})
const WorkflowRunAdoptedSchema = defineFact({
  type: "workflow.run.adopted", version: 1, actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({ launchedFrom: WorkflowLaunchBindingSchema, lastUpdated: Schema.String }),
})
const WorkflowRunDeletedSchema = defineFact({
  type: "workflow.run.deleted", version: 1, actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({ lastUpdated: Schema.String }),
})
const WorkflowRunCutUpdatedSchema = defineFact({
  type: "workflow.run.cut.updated", version: 1, actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({ cut: Schema.NullOr(Schema.Struct({ by: Schema.Literals(["person", "agent", "runtime", "replacement"]), timestamp: Schema.Number })) }),
})
export const WorkflowRunFactSchemas = [
  WorkflowRunRegisteredSchema, WorkflowRunSettingsUpdatedSchema, WorkflowRunAdoptedSchema, WorkflowRunDeletedSchema, WorkflowRunCutUpdatedSchema,
] as const
/** Run facts share the workflow aggregate with control history but belong to
 * no control epoch, so they never prove or replace a control root. A run that
 * the agent-session conversion registered from a workflow written before
 * control facts existed holds only these facts. */
export const WORKFLOW_RUN_FACT_TYPES = factTypes(WorkflowRunFactSchemas)
const WorkflowRunFactSchema = Schema.Union(WorkflowRunFactSchemas)
export type WorkflowRunFact = typeof WorkflowRunFactSchema.Type

/** Strict decoder for current run writes and the run projection. */
export function parseWorkflowRunFact(value: unknown): WorkflowRunFact {
  return Schema.decodeUnknownSync(WorkflowRunFactSchema, { onExcessProperty: "error" })(value)
}
