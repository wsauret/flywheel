import { Schema } from "effect"
import { createFactParser, defineFact } from "../../infra/event-registry.js"
import {
  AttemptRowSchema,
  AttemptStatusSchema,
  MutationLogEntrySchema,
  MutationLogEntryV9Schema,
  QueueV9Schema,
  StepRowV9Schema,
  WorkflowPlanSchema,
  WorkflowRowsSchema,
  WorkflowStateSchema,
  WorkflowTreeV1Schema,
  WorkflowTreeV3Schema,
  WorkflowTreeNodeSchema,
  WorkflowTreeSchema,
} from "./schemas.js"

// v10 names the rows of attempts in the agent lexicon: `attempts`,
// `briefId`, `item`, `attemptIds`, and `maxAttempts`. v9 stored retired names;
// readers convert v9 rows, which the earlier queue passes also rebuild every
// v4 to v8 row to. Older facts remain unregistered so incompatible persisted
// state fails explicitly.
const QueueCreatedV9FactSchema = defineFact({
  type: "queue.created",
  version: 9,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({ queue: QueueV9Schema }),
})

const QueueCreatedFactSchema = defineFact({
  type: "queue.created",
  version: 10,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({ rows: WorkflowRowsSchema }),
})

const QueueDeletedFactSchema = defineFact({
  type: "queue.deleted",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({}),
})

// queue.mutated versions with queue.created because its inserted rows embed
// the row schema. Remove v9 after 2027-04-30.
const QueueMutatedV9FactSchema = defineFact({
  type: "queue.mutated",
  version: 9,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    mutation: MutationLogEntryV9Schema,
    insertedSteps: Schema.optionalKey(Schema.mutable(Schema.Array(StepRowV9Schema))),
    insertIndex: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    removedStepIds: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.String))),
  }),
})

// v10 placed all inserted rows in one run at `insertIndex`, so it could not
// store a mutation that inserts rows in more than one place, such as a
// Resume that reruns an item and a later phase. Remove v10 after 2027-04-30.
const QueueMutatedV10FactSchema = defineFact({
  type: "queue.mutated",
  version: 10,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    mutation: MutationLogEntrySchema,
    insertedAttempts: Schema.optionalKey(Schema.Array(AttemptRowSchema)),
    insertIndex: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    removedAttemptIds: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
})

// Each insertion names the index of its row in the rows after the mutation.
// The reader removes rows first, then inserts in stored order, which is
// ascending by index.
const QueueMutatedFactSchema = defineFact({
  type: "queue.mutated",
  version: 11,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    mutation: MutationLogEntrySchema,
    insertions: Schema.optionalKey(Schema.Array(Schema.Struct({
      index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      attempt: AttemptRowSchema,
    }))),
    removedAttemptIds: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
})

// v1 named the attempt limit `maxSteps`. Remove v1 after 2027-04-30.
const QueueStateChangedV1FactSchema = defineFact({
  type: "queue.state.changed",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    status: WorkflowStateSchema,
    cursor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    maxSteps: Schema.optionalKey(Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)))),
  }),
})

const QueueStateChangedFactSchema = defineFact({
  type: "queue.state.changed",
  version: 2,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    status: WorkflowStateSchema,
    cursor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    maxAttempts: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  }),
})

// The plan was one live value per workflow, replaced whole when it changed.
// No build writes it now: the tree holds what is planned. A reader keeps the
// last one only to rebuild the tree of a run whose control it cannot read.
// v2 stores the seat of each planned row by the stored key `contentId` in place of
// `skillId`; the stored `step-row-content-id` pass rewrites every v1 row before a
// reader opens the store, so v1 stays unregistered. Remove after 2027-04-30.
const QueuePlanChangedFactSchema = defineFact({
  type: "queue.plan.changed",
  version: 2,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({ plan: WorkflowPlanSchema }),
})

const QueueTreeChangedV1FactSchema = defineFact({
  type: "queue.tree.changed",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({ tree: WorkflowTreeV1Schema }),
})

// Trees before version 4 stored the retired kinds of the step grammar. The reader
// rebuilds each from control. Remove v1 to v3 after 2027-04-30.
const QueueTreeChangedV2FactSchema = defineFact({
  type: "queue.tree.changed",
  version: 2,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({ tree: WorkflowTreeV3Schema }),
})

const QueueTreeChangedV3FactSchema = defineFact({
  type: "queue.tree.changed",
  version: 3,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({ tree: WorkflowTreeV3Schema }),
})

// Every loaded workflow publishes its tree of phases, agents, and repeats.
const QueueTreeChangedFactSchema = defineFact({
  type: "queue.tree.changed",
  version: 4,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({ tree: WorkflowTreeSchema }),
})

// A change of one node of the tree whose nodes, their ids, and their order
// stay. It replaces the node with its id in the tree that the newest
// `queue.tree.changed` stored, and states the tree's current agent, null for
// none. A tree whose structure changes is stored whole, so one node's change
// stores one node, whatever the size of the tree.
const QueueTreeNodeChangedFactSchema = defineFact({
  type: "queue.tree.node.changed",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({ node: WorkflowTreeNodeSchema, currentAgentNodeId: Schema.NullOr(Schema.NonEmptyString) }),
})

// Version 1 of each attempt fact stored the attempt id as `stepId`. Remove v1
// after 2027-04-30.
const StepStatusChangedV1FactSchema = defineFact({
  type: "step.status.changed",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    stepId: Schema.String, // stored key of version 1
    status: AttemptStatusSchema,
    previousStatus: Schema.optionalKey(AttemptStatusSchema),
    reason: Schema.optionalKey(Schema.String),
  }),
})

const StepStatusChangedFactSchema = defineFact({
  type: "step.status.changed",
  version: 2,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    attemptId: Schema.String,
    status: AttemptStatusSchema,
    previousStatus: Schema.optionalKey(AttemptStatusSchema),
    reason: Schema.optionalKey(Schema.String),
  }),
})

const StepResumeStateRecordedV1FactSchema = defineFact({
  type: "step.resume_state.recorded",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    stepId: Schema.String, // stored key of version 1
    conversationId: Schema.NullOr(Schema.String),
  }),
})

const StepResumeStateRecordedFactSchema = defineFact({
  type: "step.resume_state.recorded",
  version: 2,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    attemptId: Schema.String,
    conversationId: Schema.NullOr(Schema.String),
  }),
})

// Persists the poison-cap counter so resume recovery's re-drive count survives
// restart; without a durable fact the in-memory count resets to 0 each restart
// and the cap is bypassed. Retention keeps the latest row of each attempt, so
// the resume-revert-attempt-id pass rewrites every v1 row to v2 before
// retention reads the new key; v1 stays registered for the facts that pass
// leaves unreadable.
const StepResumeRevertRecordedV1FactSchema = defineFact({
  type: "step.resume_revert.recorded",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    stepId: Schema.String, // stored key of version 1
    count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
})

const StepResumeRevertRecordedFactSchema = defineFact({
  type: "step.resume_revert.recorded",
  version: 2,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    attemptId: Schema.String,
    count: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
})

// Run-level analogue of `step.resume_state.recorded`: the conversation after
// the workflow completes has no attempt to hang a conversationId on, so its
// durable tree key lives on the run itself.
const FollowUpResumeStateRecordedFactSchema = defineFact({
  type: "follow_up.resume_state.recorded",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    conversationId: Schema.NullOr(Schema.String),
  }),
})

export const WorkflowQueueFactSchemas = [
  QueueCreatedV9FactSchema,
  QueueCreatedFactSchema,
  QueueDeletedFactSchema,
  QueueMutatedV9FactSchema,
  QueueMutatedV10FactSchema,
  QueueMutatedFactSchema,
  QueueStateChangedV1FactSchema,
  QueueStateChangedFactSchema,
  QueuePlanChangedFactSchema,
  QueueTreeChangedV1FactSchema,
  QueueTreeChangedV2FactSchema,
  QueueTreeChangedV3FactSchema,
  QueueTreeChangedFactSchema,
  QueueTreeNodeChangedFactSchema,
  StepStatusChangedV1FactSchema,
  StepStatusChangedFactSchema,
  StepResumeStateRecordedV1FactSchema,
  StepResumeStateRecordedFactSchema,
  StepResumeRevertRecordedV1FactSchema,
  StepResumeRevertRecordedFactSchema,
  FollowUpResumeStateRecordedFactSchema,
] as const

const WorkflowQueueFactSchema = Schema.Union(WorkflowQueueFactSchemas)
const parseWorkflowQueueFactFromRegistry = createFactParser(WorkflowQueueFactSchemas)

export type WorkflowQueueFact = typeof WorkflowQueueFactSchema.Type

/** The attempt that an attempt fact names: the stored `stepId` in version 1, which
 *  held the attempt id. Remove the version 1 arm after 2027-04-30. */
export function attemptIdOf(fact: { readonly payload: { readonly stepId: string } | { readonly attemptId: string } }): string { // stored key of version 1
  return "attemptId" in fact.payload ? fact.payload.attemptId : fact.payload.stepId // stored key of version 1
}

export function parseWorkflowQueueFact(value: unknown): WorkflowQueueFact {
  return parseWorkflowQueueFactFromRegistry<WorkflowQueueFact>(value)
}

/** Builds the queue companion that the session owner commits atomically with deletion. */
export function buildQueueDeletedFact(): typeof QueueDeletedFactSchema.Type {
  return Schema.decodeUnknownSync(QueueDeletedFactSchema, { onExcessProperty: "error" })({
    type: "queue.deleted", version: 1, actor: "flywheel", payload: {},
  })
}
