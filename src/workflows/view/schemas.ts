import { Schema, SchemaTransformation } from "effect";
import { CanonicalToolScopingSchema } from "../../infra/workflow-types.js";
import { ArtifactIdsSchema } from "../artifact-contracts.js";
import type { WorkflowTree, WorkflowTreeNode } from "../../protocol/workflow-view-protocol-types.js";
import type { AttemptRow, StepThen } from "./types.js";

export const AttemptStatusSchema = Schema.Union([
  Schema.Literal("pending"),
  Schema.Literal("running"),
  Schema.Literal("completed"),
  Schema.Literal("blocked"),
  Schema.Literal("failed"),
  Schema.Literal("skipped"),
]);

const BriefPersonaSlotSchema = Schema.Struct({
  role: Schema.String,
  personas: Schema.mutable(Schema.Array(Schema.String)),
});

const OptionalStringValueSchema = Schema.UndefinedOr(Schema.String);
const HistoricalToolScopingSchema = Schema.Struct({
  read: Schema.Boolean,
  bash: Schema.Boolean,
  search: Schema.Boolean,
  list: Schema.Boolean,
  write: Schema.Boolean,
  edit: Schema.Boolean,
  subagent: Schema.Boolean,
  replace: Schema.optionalKey(Schema.Boolean),
});

const RecoveredToolScopingSchema = HistoricalToolScopingSchema.pipe(Schema.decodeTo(
  CanonicalToolScopingSchema,
  SchemaTransformation.transform({
    decode: ({ replace: _retired, ...current }) => current,
    encode: (current) => current,
  }),
));


const StepThenSchema: Schema.Codec<StepThen> = Schema.suspend((): Schema.Codec<StepThen> =>
  Schema.Struct({
    step: Schema.String, // stored key of a retired version
    when: Schema.optionalKey(OptionalStringValueSchema),
    then: Schema.optionalKey(StepThenSchema),
  })
);

const LoopBodyPositionSchema = Schema.Struct({ step: Schema.NonEmptyString }); // stored key of a retired version

/** The stored attempt row of `queue.created` and `queue.mutated` version 9 and of
 *  `workflow.compiled` versions 8 to 10, frozen as those builds wrote it.
 *  Readers convert it to {@link AttemptRowSchema}. Remove after 2027-04-30. */
export const StepRowV9Schema = Schema.Struct({
  id: Schema.String,
  definitionId: Schema.NonEmptyString,
  contentId: Schema.NonEmptyString, // stored key of a retired version
  workflowDefinitionId: Schema.NonEmptyString,
  name: Schema.String,
  status: Schema.mutableKey(AttemptStatusSchema),
  description: Schema.mutableKey(Schema.optionalKey(OptionalStringValueSchema)),
  forItem: Schema.mutableKey(Schema.optionalKey(Schema.Unknown)),
  subagents: Schema.mutableKey(Schema.optionalKey(Schema.mutable(Schema.Array(BriefPersonaSlotSchema)))),
  writes: Schema.mutableKey(Schema.mutable(ArtifactIdsSchema)),
  toolScoping: Schema.mutableKey(Schema.optionalKey(RecoveredToolScopingSchema)),
  lastConversationId: Schema.mutableKey(Schema.optionalKey(OptionalStringValueSchema)),
  resumeRevertCount: Schema.mutableKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  startedAt: Schema.mutableKey(Schema.optionalKey(Schema.Number)),
  completedAt: Schema.mutableKey(Schema.optionalKey(Schema.Number)),
  toolUses: Schema.mutableKey(Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))),

  then: Schema.mutableKey(Schema.optionalKey(StepThenSchema)),
  retry: Schema.mutableKey(Schema.optionalKey(Schema.Struct({
    maxIterations: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
    detectStuck: Schema.Boolean,
    iteration: Schema.optionalKey(Schema.UndefinedOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)))),
    previousFeedback: Schema.optionalKey(OptionalStringValueSchema),
  }))),
  loop: Schema.mutableKey(Schema.optionalKey(Schema.Struct({
    field: Schema.NonEmptyString,
    body: Schema.NonEmptyArray(LoopBodyPositionSchema),
    maxIterations: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
    detectStuck: Schema.Boolean,
    iteration: Schema.optionalKey(Schema.UndefinedOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)))),
    previousSignal: Schema.optionalKey(OptionalStringValueSchema),
  }))),
});

/** One attempt of an agent of the workflow, as the view rows record it. */
export const AttemptRowSchema: Schema.Codec<AttemptRow> = Schema.Struct({
  id: Schema.String,
  definitionId: Schema.NonEmptyString,
  briefId: Schema.NonEmptyString,
  workflowDefinitionId: Schema.NonEmptyString,
  name: Schema.String,
  status: AttemptStatusSchema,
  description: Schema.optionalKey(Schema.String),
  item: Schema.optionalKey(Schema.Unknown),
  subagents: Schema.optionalKey(Schema.Array(BriefPersonaSlotSchema)),
  writes: Schema.Array(Schema.String),
  lastConversationId: Schema.optionalKey(Schema.String),
  resumeRevertCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  startedAt: Schema.optionalKey(Schema.Number),
  completedAt: Schema.optionalKey(Schema.Number),
  toolUses: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});

/** A stored version 9 row as an attempt row. The row's `then`, `retry`,
 *  `loop`, and `toolScoping` described control that the tree now shows, so
 *  nothing reads them. Remove after 2027-04-30. */
export function attemptRowFromV9(row: typeof StepRowV9Schema.Type): AttemptRow {
  return {
    id: row.id,
    definitionId: row.definitionId,
    briefId: row.contentId, // stored key of a retired version
    workflowDefinitionId: row.workflowDefinitionId,
    name: row.name,
    status: row.status,
    writes: row.writes,
    resumeRevertCount: row.resumeRevertCount,
    ...(row.description === undefined ? {} : { description: row.description }),
    ...(row.forItem === undefined ? {} : { item: row.forItem }),
    ...(row.subagents === undefined ? {} : { subagents: row.subagents }),
    ...(row.lastConversationId === undefined ? {} : { lastConversationId: row.lastConversationId }),
    ...(row.startedAt === undefined ? {} : { startedAt: row.startedAt }),
    ...(row.completedAt === undefined ? {} : { completedAt: row.completedAt }),
    ...(row.toolUses === undefined ? {} : { toolUses: row.toolUses }),
  };
}

export const WorkflowStateSchema = Schema.Union([
  Schema.Literal("idle"),
  Schema.Literal("running"),
  Schema.Literal("completed"),
  Schema.Literal("failed"),
  Schema.Literal("paused"),
]);

export const MutationLogEntrySchema = Schema.Struct({
  timestamp: Schema.Number,
  action: Schema.String,
  actor: Schema.String,
  reason: Schema.String,
  attemptIds: Schema.Array(Schema.String),
});

/** The mutation log entry of version 9 rows. Remove after 2027-04-30. */
export const MutationLogEntryV9Schema = Schema.Struct({
  timestamp: Schema.Number,
  action: Schema.String,
  actor: Schema.String,
  reason: Schema.String,
  stepIds: Schema.mutable(Schema.Array(Schema.String)), // stored key of a retired version
});

/** The rows of a workflow view: one per attempt, with the run's state. */
export const WorkflowRowsSchema = Schema.Struct({
  attempts: Schema.Array(AttemptRowSchema),
  cursor: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  status: WorkflowStateSchema,
  mutationLog: Schema.Array(MutationLogEntrySchema),
  maxAttempts: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  followUpConversationId: Schema.optionalKey(Schema.String),
});

/** The rows of `queue.created` version 9. Remove after 2027-04-30. */
export const QueueV9Schema = Schema.Struct({
  steps: Schema.mutableKey(Schema.mutable(Schema.Array(StepRowV9Schema))), // stored key of a retired version
  cursor: Schema.mutableKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  status: Schema.mutableKey(WorkflowStateSchema),
  mutationLog: Schema.mutableKey(Schema.mutable(Schema.Array(MutationLogEntryV9Schema))),
  maxSteps: Schema.mutableKey(Schema.optionalKey(Schema.UndefinedOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))))),
  followUpConversationId: Schema.mutableKey(Schema.optionalKey(OptionalStringValueSchema)),
});

/** A version 9 mutation log entry in the current shape. Remove after
 *  2027-04-30. */
export function mutationFromV9({ stepIds, ...entry }: typeof MutationLogEntryV9Schema.Type): typeof MutationLogEntrySchema.Type { // stored key of a retired version
  return { ...entry, attemptIds: stepIds }; // stored key of a retired version
}

/** Version 9 rows in the current shape. Remove after 2027-04-30. */
export function workflowRowsFromV9(queue: typeof QueueV9Schema.Type): typeof WorkflowRowsSchema.Type {
  return {
    attempts: queue.steps.map(attemptRowFromV9), // stored key of a retired version
    cursor: queue.cursor,
    status: queue.status,
    mutationLog: queue.mutationLog.map(mutationFromV9),
    ...(queue.maxSteps === undefined ? {} : { maxAttempts: queue.maxSteps }),
    ...(queue.followUpConversationId === undefined ? {} : { followUpConversationId: queue.followUpConversationId }),
  };
}

const PlannedStepSchema = Schema.Struct({
  id: Schema.String,
  after: Schema.String,
  definitionId: Schema.NonEmptyString,
  contentId: Schema.NonEmptyString, // stored key of a retired version
  name: Schema.String,
  status: Schema.Literals(["conditional", "pending", "skipped"]),
});

export const WorkflowPlanSchema = Schema.Struct({
  conditionalStepIds: Schema.Array(Schema.String),
  steps: Schema.Array(PlannedStepSchema), // stored key of a retired version
});

const TreeCountSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const TreeUsageSchema = Schema.Struct({ declared: TreeCountSchema, used: TreeCountSchema });

const TreeRoundSchema = Schema.Struct({ number: TreeCountSchema, outcome: Schema.optionalKey(Schema.Literals(["next", "dry", "bound"])) });
const TreeJoinSchema = Schema.Struct({
  reducer: Schema.NonEmptyString,
  state: Schema.Literals(["pending", "settled"]),
  slots: TreeCountSchema,
  completed: TreeCountSchema,
  failed: TreeCountSchema,
  pending: TreeCountSchema,
  missing: TreeCountSchema,
  coverage: Schema.optionalKey(Schema.Struct({
    status: Schema.Literals(["full", "partial", "empty"]),
    required: Schema.Struct({ surveyed: TreeCountSchema, total: TreeCountSchema }),
    unsurveyed: Schema.Array(Schema.String),
  })),
  selection: Schema.optionalKey(Schema.Struct({
    verb: Schema.Literals(["kept", "passed"]),
    kept: TreeCountSchema,
    dropped: TreeCountSchema,
  })),
});
const WorkflowTreeLoopSchema = Schema.Struct({
  iteration: TreeCountSchema,
  maxIterations: TreeCountSchema,
  outcome: Schema.optionalKey(Schema.Literals(["dry", "bound", "stuck"])),
});

const TreeNodeFields = {
  id: Schema.NonEmptyString,
  label: Schema.String,
  parentId: Schema.NullOr(Schema.NonEmptyString),
  disposition: Schema.Literals(["pending", "conditional", "running", "completed", "failed", "skipped"]),
  reason: Schema.optionalKey(Schema.String),
};

/** Current trees: phases, their agents, and repeats. */
/** One node of the operational tree. */
export const WorkflowTreeNodeSchema: Schema.Codec<WorkflowTreeNode> = Schema.Union([
    Schema.Struct({
      ...TreeNodeFields,
      kind: Schema.Literal("phase"),
      form: Schema.Literals(["single", "parallel", "list"]),
      phaseId: Schema.NonEmptyString,
      round: Schema.optionalKey(TreeRoundSchema),
      list: Schema.optionalKey(Schema.Struct({ id: Schema.NonEmptyString, expanded: Schema.Boolean })),
      join: Schema.optionalKey(TreeJoinSchema),
    }),
    Schema.Struct({
      ...TreeNodeFields,
      kind: Schema.Literal("agent"),
      definitionId: Schema.NonEmptyString,
      attempts: TreeCountSchema,
      currentAttemptId: Schema.optionalKey(Schema.NonEmptyString),
      evidence: Schema.optionalKey(Schema.Struct({ summary: Schema.optionalKey(Schema.String) })),
      item: Schema.optionalKey(Schema.Struct({ nodeId: Schema.NonEmptyString, key: Schema.NonEmptyString, label: Schema.String, ordinal: TreeCountSchema, text: Schema.String })),
      nodeId: Schema.optionalKey(Schema.NonEmptyString),
      waitsOn: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
    }),
    Schema.Struct({ ...TreeNodeFields, kind: Schema.Literal("repeat"), loop: WorkflowTreeLoopSchema }),
  ]);

export const WorkflowTreeSchema: Schema.Codec<WorkflowTree> = Schema.Struct({
  nodes: Schema.Array(WorkflowTreeNodeSchema),
  currentAgentNodeId: Schema.optionalKey(Schema.NonEmptyString),
});

/** The node fields of trees before version 4, which stored the retired kinds
 *  and fields of the step grammar (`stages`, `stageIds`, `mapId`), branches,
 *  chains, and rounds. Readers rebuild such a tree from
 *  control, and convert it only when control is not readable. Remove after
 *  2027-04-30. */
const TreeNodeV3Fields = {
  ...TreeNodeFields,
  attempts: TreeCountSchema,
  currentAttemptId: Schema.optionalKey(Schema.NonEmptyString),
  evidence: Schema.optionalKey(Schema.Struct({ summary: Schema.optionalKey(Schema.String) })),
  key: Schema.optionalKey(Schema.NonEmptyString),
  ordinal: Schema.optionalKey(TreeCountSchema),
  item: Schema.optionalKey(Schema.String),
  stages: Schema.optionalKey(Schema.Array(Schema.String)), // stored key of a retired version
  mapId: Schema.optionalKey(Schema.String),
  stageIds: Schema.optionalKey(Schema.Array(Schema.String)),
  round: Schema.optionalKey(TreeRoundSchema),
  concurrent: Schema.optionalKey(Schema.Literal(true)),
  waitsOn: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  limits: Schema.optionalKey(Schema.Struct({ nodes: Schema.optionalKey(TreeUsageSchema), depth: Schema.optionalKey(TreeUsageSchema) })),
  worstCase: Schema.optionalKey(Schema.Struct({ nodes: TreeCountSchema, depth: TreeCountSchema })),
  join: Schema.optionalKey(TreeJoinSchema),
  // A group's `joinsInto`, the label of the node that waited on its join,
  // which builds before 2026-10-15 wrote.
  joinsInto: Schema.optionalKey(Schema.String),
};

/** v2 and v3 trees stored control in the words of the retired step grammar;
 *  v2 trees predate the retired concurrent containers. Remove after 2027-04-30. */
export const WorkflowTreeV3Schema = Schema.Struct({
  nodes: Schema.Array(Schema.Union([
    Schema.Struct({ ...TreeNodeV3Fields, kind: Schema.Literal("step"), stepId: Schema.NonEmptyString }), // stored kind and key of a retired version
    Schema.Struct({ ...TreeNodeV3Fields, kind: Schema.Literal("rounds"), loop: WorkflowTreeLoopSchema }),
    Schema.Struct({ ...TreeNodeV3Fields, kind: Schema.Literals(["phase", "group", "branch", "chain"]) }),
  ])),
  currentLeafId: Schema.optionalKey(Schema.NonEmptyString),
});

/** v1 facts can lack the stored record identity and loop state. Accept additive fields
 *  so a historical reader retains all available evidence for conversion.
 *  Every tree before version 4 decodes into this shape for that reader.
 *  Remove after 2027-04-30. */
export const WorkflowTreeV1Schema = Schema.Struct({
  nodes: Schema.Array(Schema.Struct({
    ...TreeNodeV3Fields,
    kind: Schema.Literals(["phase", "group", "branch", "step", "rounds", "chain"]), // stored kinds of a retired version
    stepId: Schema.optionalKey(Schema.NonEmptyString), // stored key of a retired version
    loop: Schema.optionalKey(WorkflowTreeLoopSchema),
  })),
  currentLeafId: Schema.optionalKey(Schema.NonEmptyString),
});

/** A normalized current view. */
export const WorkflowViewSchema = Schema.Struct({
  ...WorkflowRowsSchema.fields,
  tree: WorkflowTreeSchema,
});
