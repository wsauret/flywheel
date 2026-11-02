import { Schema } from "effect";
import { DurableFollowUpInputSchema } from "../../infra/chat-input-schema.js";
import { DefinitionIdentityV1Schema, DefinitionIdentityV2Schema } from "./historical-identity-codecs.js";
import type { DecodedWorkflowProposalEvent, WorkflowProposalEncoding } from "./events.js";
import { ArtifactContractSchema } from "../artifact-contracts.js";
import { FieldMapSchema } from "../output-contract/grammar.js";

// Frozen wire contracts. Nothing in this file derives from the current graph,
// control, event, or definition identity schemas, so a change to those
// schemas cannot change how a stored historical fact decodes. Strict decoding
// comes first; one pure normalization in `historical-normalization.ts` then
// maps each decoded value to the current internal shape. Only the durable follow-up input, the artifact
// contract, and the field map of a pinned join contract stay shared, because
// each has its own versioned owner, and a group of graph version 5 reads the
// output contract of its registered reducer version, which never changes.
// The frozen definition identities are in `historical-identity-codecs.ts`,
// and the attempt shapes before measured operations in
// `historical-attempt-codecs.ts`.

const Id = Schema.NonEmptyString;
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Positive = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const AuthoredIterationLimit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 }));

// Graph version 3: the graph that every root through initialized v4 and
// recovered v4, every committed event through v5, and every reassessment
// change hold. The `task` ownership arm, the `all_required` join, and the
// counter budgets have no producer, but stored bytes may name them.

const FieldRefV3Schema = Schema.Struct({ step: Id, field: Id });

const OwnershipV3Schema = Schema.Union([
  Schema.TaggedStruct("workflow", { workflowDefinitionId: Id }),
  Schema.TaggedStruct("phase", { workflowDefinitionId: Id, phaseId: Id, parentNodeId: Id }),
  Schema.TaggedStruct("task", { workflowDefinitionId: Id, phaseId: Id, taskId: Id, parentNodeId: Id }),
]);

const NodeStateV3Schema = Schema.Union([
  Schema.TaggedStruct("pending", {}),
  Schema.TaggedStruct("ready", {}),
  Schema.TaggedStruct("running", {}),
  Schema.TaggedStruct("completed", {}),
  Schema.TaggedStruct("failed", { reason: Schema.String }),
  Schema.TaggedStruct("blocked", { reason: Schema.String, causedBy: Schema.Array(Id) }),
  Schema.TaggedStruct("cancelled", { reason: Schema.String, causedBy: Schema.Array(Id) }),
  Schema.TaggedStruct("superseded", { reason: Schema.String, replacementNodeId: Schema.NullOr(Id) }),
]);

const AttemptStateV3Schema = Schema.Union([
  Schema.TaggedStruct("pending", {}),
  Schema.TaggedStruct("running", {}),
  Schema.TaggedStruct("completed", {}),
  Schema.TaggedStruct("blocked", { reason: Schema.String }),
  Schema.TaggedStruct("failed", { reason: Schema.String }),
  Schema.TaggedStruct("skipped", { reason: Schema.String }),
]);

const StepPositionV3Schema = Schema.Struct({ step: Id });

interface StepFollowUpV3 {
  readonly step: string;
  readonly when: string | null;
  readonly then: StepFollowUpV3 | null;
}

const StepFollowUpV3Schema: Schema.Codec<StepFollowUpV3> = Schema.suspend(
  (): Schema.Codec<StepFollowUpV3> => Schema.Struct({
    ...StepPositionV3Schema.fields,
    when: Schema.NullOr(Schema.String),
    then: Schema.NullOr(StepFollowUpV3Schema),
  }),
);

const ProvenanceV3Schema = Schema.Union([
  Schema.TaggedStruct("authored", {}),
  Schema.TaggedStruct("while", {}),
  Schema.TaggedStruct("for", { itemIndex: Count }),
  Schema.TaggedStruct("retry", {}),
  Schema.TaggedStruct("then", {}),
  Schema.TaggedStruct("reassessment", {}),
]);

const NodeV3Fields = {
  id: Id,
  workflowDefinitionId: Id,
  order: Count,
  ownership: OwnershipV3Schema,
  state: NodeStateV3Schema,
};

const LogicalNodeV3Schema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("step"),
    ...NodeV3Fields,
    definitionId: Id,
    name: Id,
    then: Schema.NullOr(StepFollowUpV3Schema),
    retry: Schema.NullOr(Schema.Struct({ maxIterations: AuthoredIterationLimit, detectStuck: Schema.Boolean })),
  }),
  Schema.Struct({
    kind: Schema.Literal("while"),
    ...NodeV3Fields,
    evaluator: FieldRefV3Schema,
    body: Schema.NonEmptyArray(StepPositionV3Schema),
    maxIterations: AuthoredIterationLimit,
    detectStuck: Schema.Boolean,
    iteration: Positive,
    priorNormalizedSignal: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("for"),
    ...NodeV3Fields,
    source: FieldRefV3Schema,
    body: Schema.NonEmptyArray(StepPositionV3Schema),
  }),
]);

const AttemptV3Schema = Schema.Struct({
  id: Id,
  logicalNodeId: Id,
  workflowDefinitionId: Id,
  definitionId: Id,
  sequence: Positive,
  iteration: Positive,
  resumeRevertCount: Count,
  provenance: ProvenanceV3Schema,
  ownership: OwnershipV3Schema,
  state: AttemptStateV3Schema,
  parentAttemptId: Schema.NullOr(Id),
  conversationId: Schema.NullOr(Id),
  handoff: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
  priorRetryFeedback: Schema.NullOr(Schema.String),
  forItem: Schema.Json,
});

const DependencyEdgeV3Schema = Schema.Struct({ nodeId: Id, dependsOn: Id });

const AllRequiredJoinV3Schema = Schema.Struct({
  kind: Schema.Literal("all_required"),
  nodeId: Id,
  requiredNodeIds: Schema.NonEmptyArray(Id),
});

const BudgetCounterV3Schema = Schema.Struct({ used: Count, limit: Positive });

const WorkflowGraphV3Schema = Schema.Struct({
  nodes: Schema.Array(LogicalNodeV3Schema),
  dependencies: Schema.Array(DependencyEdgeV3Schema),
  joins: Schema.Array(AllRequiredJoinV3Schema),
  budgets: Schema.Array(Schema.Struct({
    parentNodeId: Id,
    expansion: BudgetCounterV3Schema,
    remediation: BudgetCounterV3Schema,
  })),
});

// Graph version 4: the phase graph that initialized v5 and recovered v5 hold.
// Ownership is `workflow` or `phase`, nodes add the phase container, and a
// budget states declared limits. The `all_required` join has no producer, but
// stored bytes may name it.

const OwnershipV4Schema = Schema.Union([
  Schema.TaggedStruct("workflow", { workflowDefinitionId: Id }),
  Schema.TaggedStruct("phase", { workflowDefinitionId: Id, phaseId: Id, parentNodeId: Id }),
]);

const NodeV4Fields = { ...NodeV3Fields, ownership: OwnershipV4Schema };

const LogicalNodeV4Schema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("step"),
    ...NodeV4Fields,
    definitionId: Id,
    name: Id,
    then: Schema.NullOr(StepFollowUpV3Schema),
    retry: Schema.NullOr(Schema.Struct({ maxIterations: AuthoredIterationLimit, detectStuck: Schema.Boolean })),
  }),
  Schema.Struct({
    kind: Schema.Literal("while"),
    ...NodeV4Fields,
    evaluator: FieldRefV3Schema,
    body: Schema.NonEmptyArray(StepPositionV3Schema),
    maxIterations: AuthoredIterationLimit,
    detectStuck: Schema.Boolean,
    iteration: Positive,
    priorNormalizedSignal: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal("for"),
    ...NodeV4Fields,
    source: FieldRefV3Schema,
    body: Schema.NonEmptyArray(StepPositionV3Schema),
  }),
  Schema.Struct({
    kind: Schema.Literal("phase"),
    ...NodeV4Fields,
    phaseId: Id,
    name: Id,
  }),
]);

const AttemptV4Schema = Schema.Struct({ ...AttemptV3Schema.fields, ownership: OwnershipV4Schema });

const WorkflowGraphV4Schema = Schema.Struct({
  nodes: Schema.Array(LogicalNodeV4Schema),
  dependencies: Schema.Array(DependencyEdgeV3Schema),
  joins: Schema.Array(AllRequiredJoinV3Schema),
  budgets: Schema.Array(Schema.Struct({
    parentNodeId: Id,
    limits: Schema.Struct({ nodes: Schema.optionalKey(Positive), depth: Schema.optionalKey(Positive) }),
  })),
});

export type OwnershipV3 = typeof OwnershipV3Schema.Type;
export type LogicalNodeV3 = typeof LogicalNodeV3Schema.Type;
export type AttemptV3 = typeof AttemptV3Schema.Type;
export type AllRequiredJoinV3 = typeof AllRequiredJoinV3Schema.Type;
export type GraphV3 = typeof WorkflowGraphV3Schema.Type;
export type GraphV4 = typeof WorkflowGraphV4Schema.Type;

// Graph version 5: the map graph that initialized v6 and recovered v6 hold.
// It adds the group and branch containers, their owners, the branch
// provenance of a stage attempt, and the `collect_all` join of a group. A
// group names its reducer without the output contract that the current
// graph pins on it. A map expansion records its branch and stage nodes in
// these shapes in every encoding.

const OwnershipV5Schema = Schema.Union([
  ...OwnershipV4Schema.members,
  Schema.TaggedStruct("group", { workflowDefinitionId: Id, mapId: Id, parentNodeId: Id }),
  Schema.TaggedStruct("branch", { workflowDefinitionId: Id, mapId: Id, key: Id, parentNodeId: Id }),
]);

const ProvenanceV5Schema = Schema.Union([...ProvenanceV3Schema.members, Schema.TaggedStruct("branch", { ordinal: Positive })]);

const NodeV5Fields = { ...NodeV3Fields, ownership: OwnershipV5Schema };

const CollectAllJoinV5Schema = Schema.Struct({ kind: Schema.Literal("collect_all"), nodeId: Id, requiredNodeIds: Schema.Array(Id) });

const RetryControlV3Schema = Schema.Struct({ maxIterations: AuthoredIterationLimit, detectStuck: Schema.Boolean });

const LogicalNodeV5Schema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("step"), ...NodeV5Fields, definitionId: Id, name: Id, then: Schema.NullOr(StepFollowUpV3Schema), retry: Schema.NullOr(RetryControlV3Schema) }),
  Schema.Struct({
    kind: Schema.Literal("while"), ...NodeV5Fields, evaluator: FieldRefV3Schema, body: Schema.NonEmptyArray(StepPositionV3Schema),
    maxIterations: AuthoredIterationLimit, detectStuck: Schema.Boolean, iteration: Positive, priorNormalizedSignal: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({ kind: Schema.Literal("for"), ...NodeV5Fields, source: FieldRefV3Schema, body: Schema.NonEmptyArray(StepPositionV3Schema) }),
  Schema.Struct({ kind: Schema.Literal("phase"), ...NodeV5Fields, phaseId: Id, name: Id }),
  Schema.Struct({
    kind: Schema.Literal("group"),
    ...NodeV5Fields,
    mapId: Id,
    name: Id,
    source: Schema.Struct({ nodeId: Id, field: Id }),
    key: Id,
    label: Schema.NullOr(Id),
    width: Positive,
    stages: Schema.NonEmptyArray(Schema.Struct({ step: Id, name: Id })),
    retry: Schema.NullOr(RetryControlV3Schema),
    reducer: Schema.Struct({ id: Id, version: Positive, params: Schema.Record(Schema.String, Schema.Json) }),
    write: ArtifactContractSchema,
    admittedContext: Schema.NullOr(Schema.Array(Id)),
    settlement: Schema.NullOr(Schema.Struct({ total: Count, completed: Count, failed: Count })),
  }),
  Schema.Struct({ kind: Schema.Literal("branch"), ...NodeV5Fields, key: Id, label: Id, ordinal: Positive, item: Schema.Json }),
]);

/** One graph change of a map expansion in graph version 5 shapes, which
 *  `group.expanded` records in every encoding (refer to `GraphChangeSchema`
 *  in events.ts). */
export const GraphChangeV5Schema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("add_node"), node: LogicalNodeV5Schema, forItem: Schema.Json }),
  Schema.Struct({ kind: Schema.Literal("add_dependency"), dependency: DependencyEdgeV3Schema }),
  Schema.Struct({ kind: Schema.Literal("add_join"), join: CollectAllJoinV5Schema }),
]);

const AttemptV5Schema = Schema.Struct({ ...AttemptV3Schema.fields, ownership: OwnershipV5Schema, provenance: ProvenanceV5Schema });

const WorkflowGraphV5Schema = Schema.Struct({
  nodes: Schema.Array(LogicalNodeV5Schema),
  dependencies: Schema.Array(DependencyEdgeV3Schema),
  joins: Schema.Array(CollectAllJoinV5Schema),
  budgets: WorkflowGraphV4Schema.fields.budgets,
});

// Graph version 6: graph version 5 where each group pins the output contract
// of its reducer. Initialized v7 and recovered v7 hold it. Graph version 7
// adds the loop over a map, its node kind, and the ownership of its rounds,
// and graph version 8 adds the votes of a map, so each graph of version 6 is
// also a current graph.
const [StepNodeV5Schema, WhileNodeV5Schema, ForNodeV5Schema, PhaseNodeV5Schema, GroupNodeV5Schema, BranchNodeV5Schema] = LogicalNodeV5Schema.members;
const LogicalNodeV6Schema = Schema.Union([
  StepNodeV5Schema, WhileNodeV5Schema, ForNodeV5Schema, PhaseNodeV5Schema,
  Schema.Struct({ ...GroupNodeV5Schema.fields, reducer: Schema.Struct({ ...GroupNodeV5Schema.fields.reducer.fields, contract: FieldMapSchema }) }),
  BranchNodeV5Schema,
]);

// Graph version 7: graph version 6 with the loop over a map, its rounds node,
// and the ownership of the group of each of its rounds. Initialized v8,
// recovered v8, initialized v9, and recovered v9 hold it. Graph version 8
// adds only the optional votes of a group and the optional vote of a
// branch, so its value widens to the current graph without change.
const OwnershipV7Schema = Schema.Union([
  ...OwnershipV5Schema.members,
  Schema.TaggedStruct("rounds", { workflowDefinitionId: Id, parentNodeId: Id, round: Positive }),
]);
const NodeV7Fields = { ...NodeV5Fields, ownership: OwnershipV7Schema };
const GroupNodeV6Schema = LogicalNodeV6Schema.members[4];
const LogicalNodeV7Schema = Schema.Union([
  Schema.Struct({ ...StepNodeV5Schema.fields, ...NodeV7Fields }),
  Schema.Struct({ ...WhileNodeV5Schema.fields, ...NodeV7Fields }),
  Schema.Struct({ ...ForNodeV5Schema.fields, ...NodeV7Fields }),
  Schema.Struct({ ...PhaseNodeV5Schema.fields, ...NodeV7Fields }),
  Schema.Struct({ ...GroupNodeV6Schema.fields, ...NodeV7Fields }),
  Schema.Struct({ ...BranchNodeV5Schema.fields, ...NodeV7Fields }),
  Schema.Struct({ kind: Schema.Literal("rounds"), ...NodeV7Fields, mapId: Id, field: Id, maxIterations: AuthoredIterationLimit }),
]);

// Graph version 8: graph version 7 with the optional votes of a group and
// the optional vote of a branch. Initialized v10 and recovered v10 hold it,
// and `group.expanded@2` records its branch and stage nodes. It is the last
// graph before phases: every older graph normalizes to it first, and it then
// normalizes to the graph of control version 11 (refer to
// `historical-normalization.ts`). History only; remove after 2027-04-30.
const VoteV8Schema = Schema.Struct({ number: Positive, itemKey: Id, itemLabel: Id });
const [StepNodeV7Schema, WhileNodeV7Schema, ForNodeV7Schema, PhaseNodeV7Schema, GroupNodeV7Schema, BranchNodeV7Schema, RoundsNodeV7Schema] = LogicalNodeV7Schema.members;
// The fields keep the order of the last build that wrote them, which names
// `votes` after `width`.
const { stages: stagesV7, retry: retryV7, reducer: reducerV7, write: writeV7, admittedContext: admittedContextV7, settlement: settlementV7, ...groupHeadV7 } = GroupNodeV7Schema.fields;
const GroupNodeV8Schema = Schema.Struct({
  ...groupHeadV7,
  votes: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 2, maximum: 10 }))),
  stages: stagesV7, retry: retryV7, reducer: reducerV7, write: writeV7, admittedContext: admittedContextV7, settlement: settlementV7,
});
const BranchNodeV8Schema = Schema.Struct({ ...BranchNodeV7Schema.fields, vote: Schema.optionalKey(VoteV8Schema) });
const LogicalNodeV8Schema = Schema.Union([StepNodeV7Schema, WhileNodeV7Schema, ForNodeV7Schema, PhaseNodeV7Schema, GroupNodeV8Schema, BranchNodeV8Schema, RoundsNodeV7Schema]);
const AttemptV8Schema = Schema.Struct({ ...AttemptV5Schema.fields, ownership: OwnershipV7Schema });
const WorkflowGraphV8Schema = Schema.Struct({ ...WorkflowGraphV5Schema.fields, nodes: Schema.Array(LogicalNodeV8Schema) });

/** One graph change of a map expansion in graph version 8 shapes, which
 *  `group.expanded@2` records. History only; remove after 2027-04-30. */
export const ExpansionChangeV8Schema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("add_node"), node: Schema.Union([BranchNodeV8Schema, StepNodeV7Schema]), forItem: Schema.Json }),
  Schema.Struct({ kind: Schema.Literal("add_dependency"), dependency: DependencyEdgeV3Schema }),
  Schema.Struct({ kind: Schema.Literal("add_join"), join: CollectAllJoinV5Schema }),
]);

export type GraphV8 = typeof WorkflowGraphV8Schema.Type;
export type LogicalNodeV8 = typeof LogicalNodeV8Schema.Type;
export type AttemptV8 = typeof AttemptV8Schema.Type;
export type OwnershipV8 = typeof OwnershipV7Schema.Type;
export type ExpansionChangeV8 = typeof ExpansionChangeV8Schema.Type;
export type GraphChangeV5 = typeof GraphChangeV5Schema.Type;

// Inert control fields. No producer ever wrote an issue or a seal, but every
// stored root through version 3 carries both lists.
const IssueV3Schema = Schema.TaggedStruct("issue", {
  id: Id,
  ownerNodeId: Id,
  gate: Schema.Union([Schema.Literal("none"), Schema.Literal("node"), Schema.Literal("workflow")]),
  status: Schema.Union([Schema.Literal("open"), Schema.Literal("resolved"), Schema.Literal("superseded")]),
  summary: Schema.NonEmptyString,
  evidence: Schema.Array(Schema.String),
  createdAt: Schema.Number,
  resolvedAt: Schema.NullOr(Schema.Number),
});

const SealV3Schema = Schema.TaggedStruct("seal", {
  id: Id,
  checkpointNodeId: Id,
  outcome: Schema.Union([
    Schema.Literal("sealed"),
    Schema.Literal("failed"),
    Schema.Literal("overridden"),
    Schema.Literal("superseded"),
  ]),
  evidence: Schema.Array(Schema.String),
  versionRefs: Schema.Array(Id),
  issuedAt: Schema.Number,
  supersededBy: Schema.NullOr(Id),
});

const GuardrailsV3Schema = Schema.Struct({
  maxQueueLength: Positive,
  maxMutationsPerAttempt: Positive,
  maxSessionInserts: Count,
  sessionInsertsUsed: Count,
  attemptMutationsUsed: Schema.Array(Schema.Struct({ attemptId: Id, used: Count })),
});

const ControlStatusV3Schema = Schema.Literals(["ready", "executing", "paused", "follow_up", "completed", "failed"]);

const IdentifiedFollowUpIdentityV3Schema = Schema.Struct({ kind: Schema.Literal("identified"), inputID: Id });
const FollowUpIdentityV3Schema = Schema.Union([
  IdentifiedFollowUpIdentityV3Schema,
  Schema.Struct({ kind: Schema.Literal("historical") }),
]);

const InertControlV3Fields = {
  issues: Schema.Array(IssueV3Schema),
  seals: Schema.Array(SealV3Schema),
};

/** The control of initialized v2 and recovered v2: prompt-only follow-up input. */
export const HistoricalWorkflowControlV2Schema = Schema.Struct({
  definitionIdentity: DefinitionIdentityV1Schema,
  workflowName: Id,
  graph: WorkflowGraphV3Schema,
  attempts: Schema.Array(AttemptV3Schema),
  frontier: Schema.Array(Id),
  ...InertControlV3Fields,
  guardrails: GuardrailsV3Schema,
  status: ControlStatusV3Schema,
  followUp: Schema.NullOr(Schema.Struct({ conversationId: Id, requestSequence: Positive, pendingPrompt: Schema.NullOr(Id) })),
  aggregateSeq: Count,
});
export const RecoveredWorkflowControlV1Schema = HistoricalWorkflowControlV2Schema.check(Schema.makeFilter(
  (control) => control.status === "paused"
    && control.followUp === null
    && control.frontier.length === 0
    && control.attempts.filter(({ state }) => state._tag === "pending").length <= 1
    && control.attempts.every(({ state }) => state._tag !== "running")
    || "recovered control must be paused with at most one pending continuation",
));

/** The control of initialized v3 and recovered v3: identified follow-up input
 *  and the inert lists. History only; remove after 2027-04-09. */
export const WorkflowControlV3Schema = Schema.Struct({
  definitionIdentity: DefinitionIdentityV1Schema,
  workflowName: Id,
  graph: WorkflowGraphV3Schema,
  attempts: Schema.Array(AttemptV3Schema),
  frontier: Schema.Array(Id),
  ...InertControlV3Fields,
  guardrails: GuardrailsV3Schema,
  status: ControlStatusV3Schema,
  followUp: Schema.NullOr(Schema.Struct({
    conversationId: Id,
    requestSequence: Positive,
    identity: FollowUpIdentityV3Schema,
    pendingInput: Schema.NullOr(DurableFollowUpInputSchema),
  })),
  aggregateSeq: Count,
});

/** The control of initialized v4 and recovered v4: graph version 3 without
 *  the inert lists. History only; remove after 2027-04-09. */
export const WorkflowControlV4Schema = Schema.Struct({
  definitionIdentity: DefinitionIdentityV1Schema,
  workflowName: Id,
  graph: WorkflowGraphV3Schema,
  attempts: Schema.Array(AttemptV3Schema),
  frontier: Schema.Array(Id),
  guardrails: GuardrailsV3Schema,
  status: ControlStatusV3Schema,
  followUp: WorkflowControlV3Schema.fields.followUp,
  aggregateSeq: Count,
});

/** The control of initialized v5 and recovered v5: graph version 4. The
 *  frozen roots of v6 to v9 reuse its fields, so it goes with the last of
 *  them. History only; remove after 2027-04-14. */
export const WorkflowControlV5Schema = Schema.Struct({
  definitionIdentity: DefinitionIdentityV2Schema,
  workflowName: Id,
  graph: WorkflowGraphV4Schema,
  attempts: Schema.Array(AttemptV4Schema),
  frontier: Schema.Array(Id),
  guardrails: GuardrailsV3Schema,
  status: ControlStatusV3Schema,
  followUp: WorkflowControlV3Schema.fields.followUp,
  aggregateSeq: Count,
});

/** The control of initialized v6 and recovered v6: graph version 5.
 *  History only; remove after 2026-12-15. */
export const WorkflowControlV6Schema = Schema.Struct({
  ...WorkflowControlV5Schema.fields,
  graph: WorkflowGraphV5Schema,
  attempts: Schema.Array(AttemptV5Schema),
});

/** The control of initialized v7 and recovered v7: graph version 6.
 *  History only; remove after 2027-01-10. */
export const WorkflowControlV7Schema = Schema.Struct({
  ...WorkflowControlV6Schema.fields,
  graph: Schema.Struct({ ...WorkflowGraphV5Schema.fields, nodes: Schema.Array(LogicalNodeV6Schema) }),
});

/** The control of initialized v8 and recovered v8: graph version 7, and
 *  guardrails without the author's `max_parallel`. History only; remove
 *  after 2027-04-10. */
export const WorkflowControlV8Schema = Schema.Struct({
  ...WorkflowControlV7Schema.fields,
  graph: Schema.Struct({ ...WorkflowGraphV5Schema.fields, nodes: Schema.Array(LogicalNodeV7Schema) }),
  attempts: Schema.Array(Schema.Struct({ ...AttemptV5Schema.fields, ownership: OwnershipV7Schema })),
});

/** The control of initialized v9 and recovered v9: graph version 7, whose
 *  groups and branches know no votes, and guardrails with the author's
 *  optional `max_parallel`. History only; remove after 2027-04-14. */
export const WorkflowControlV9Schema = Schema.Struct({
  ...WorkflowControlV8Schema.fields,
  guardrails: Schema.Struct({
    maxQueueLength: Positive,
    maxParallel: Schema.optionalKey(Positive),
    maxMutationsPerAttempt: Positive,
    maxSessionInserts: Count,
    sessionInsertsUsed: Count,
    attemptMutationsUsed: GuardrailsV3Schema.fields.attemptMutationsUsed,
  }),
});

/** The control of initialized v10 and recovered v10: graph version 8, the
 *  last control before phases. History only; remove after 2027-04-30. */
export const WorkflowControlV10Schema = Schema.Struct({
  ...WorkflowControlV9Schema.fields,
  graph: WorkflowGraphV8Schema,
  attempts: Schema.Array(AttemptV8Schema),
});
export type ControlV10 = typeof WorkflowControlV10Schema.Type;
export type HistoricalWorkflowControlV2 = typeof HistoricalWorkflowControlV2Schema.Type;
export type ControlV3 = typeof WorkflowControlV3Schema.Type;
export type ControlV4 = typeof WorkflowControlV4Schema.Type;
export type ControlV5 = typeof WorkflowControlV5Schema.Type;
export type ControlV6 = typeof WorkflowControlV6Schema.Type;
export type ControlV7 = typeof WorkflowControlV7Schema.Type;
export type ControlV8 = typeof WorkflowControlV8Schema.Type;
export type ControlV9 = typeof WorkflowControlV9Schema.Type;

// Historical field shape only: the retired learnings-injection path stamped
// injected pointers onto attempt outcomes and failures.
const InjectedLearningV3Schema = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  summary: Schema.String,
  kind: Schema.NonEmptyString,
});

const FailureV3Fields = {
  attemptId: Id,
  reason: Schema.NonEmptyString,
  conversationId: Schema.NullOr(Id),
  injectedLearnings: Schema.optionalKey(Schema.Array(InjectedLearningV3Schema)),
};

const FailureV3Schema = Schema.Union([
  Schema.Struct({
    ...FailureV3Fields,
    kind: Schema.Union([
      Schema.Literal("handoff"),
      Schema.Literal("transient"),
      Schema.Literal("context_overflow"),
      Schema.Literal("fatal"),
    ]),
  }),
  Schema.Struct({
    ...FailureV3Fields,
    kind: Schema.Literal("invalid_handoff"),
    content: Schema.Record(Schema.String, Schema.Unknown),
    issues: Schema.Array(Schema.Struct({ path: Schema.String, message: Schema.String, hint: Schema.optionalKey(Schema.String) })),
  }),
  Schema.Struct({
    ...FailureV3Fields,
    kind: Schema.Literal("missing_handoff"),
  }),
]);

/** The reassessment change vocabulary over graph version 3. It is frozen:
 *  every committed event and every `workflow.reassessed` fact, current and
 *  historical, holds these exact shapes. */
export const ReassessmentChangeV3Schema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("add_node"), node: LogicalNodeV3Schema, forItem: Schema.Json }),
  Schema.Struct({ kind: Schema.Literal("add_dependency"), dependency: DependencyEdgeV3Schema }),
  Schema.Struct({ kind: Schema.Literal("skip"), targetAttemptId: Id, reason: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("replace"), targetAttemptId: Id, attemptId: Id, forItem: Schema.Json, reason: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("insert_after"), targetAttemptId: Id, afterAttemptId: Id, attemptId: Id, forItem: Schema.Json, reason: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("add_join"), join: AllRequiredJoinV3Schema }),
  Schema.Struct({ kind: Schema.Literal("cancel_node"), nodeId: Id, reason: Schema.NonEmptyString }),
  Schema.Struct({ kind: Schema.Literal("supersede_node"), nodeId: Id, replacementNodeId: Id, reason: Schema.NonEmptyString }),
]);

export const ReassessmentProposalV3Schema = Schema.Struct({
  proposalId: Id,
  ownerNodeId: Id,
  reason: Schema.NonEmptyString,
  changes: Schema.NonEmptyArray(ReassessmentChangeV3Schema),
});

// `evidence` is inert: every producer wrote it empty, and no reader used it.
const AttemptOutcomeV3Schema = Schema.Struct({
  attemptId: Id,
  conversationId: Schema.NullOr(Id),
  handoff: Schema.Record(Schema.String, Schema.Unknown),
  evidence: Schema.Array(Schema.String),
  reassessment: Schema.NullOr(ReassessmentProposalV3Schema),
  injectedLearnings: Schema.optionalKey(Schema.Array(InjectedLearningV3Schema)),
});

/** The event arms that committed v2 through v5 share. Each version adds its
 *  own follow-up request arm, and v5 adds the follow-up transfer. */
export const SharedEventArmsV3 = [
  Schema.Struct({ type: Schema.Literal("START") }),
  Schema.Struct({ type: Schema.Literal("ADVANCE") }),
  Schema.Struct({ type: Schema.Literal("ATTEMPT_STARTED"), attemptId: Id, conversationId: Id }),
  Schema.Struct({ type: Schema.Literal("ATTEMPT_SUCCEEDED"), outcome: AttemptOutcomeV3Schema }),
  Schema.Struct({
    type: Schema.Literal("ATTEMPT_BLOCKED"),
    blocked: Schema.Struct({ attemptId: Id, conversationId: Schema.NullOr(Id), handoff: Schema.Record(Schema.String, Schema.Unknown) }),
    correctiveDefinitionId: Schema.NullOr(Id),
  }),
  Schema.Struct({ type: Schema.Literal("ATTEMPT_FAILED"), failure: FailureV3Schema }),
  Schema.Struct({ type: Schema.Literal("PAUSE"), reason: Schema.NonEmptyString }),
  Schema.Struct({ type: Schema.Literal("RESUME") }),
  Schema.Struct({ type: Schema.Literal("RECOVER") }),
  Schema.Struct({ type: Schema.Literal("ABORT"), reason: Schema.NonEmptyString }),
] as const;

export const FollowUpSettledArmsV3 = [
  Schema.Struct({ type: Schema.Literal("FOLLOW_UP_SUCCEEDED"), conversationId: Id, requestSequence: Positive }),
  Schema.Struct({ type: Schema.Literal("FOLLOW_UP_FAILED"), reason: Schema.NonEmptyString, conversationId: Id, requestSequence: Positive }),
  Schema.Struct({ type: Schema.Literal("REASSESSMENT_PROPOSED"), proposal: ReassessmentProposalV3Schema }),
] as const;

export const HistoricalFollowUpRequestV1Schema = Schema.Struct({ prompt: Id, conversationId: Id, requestSequence: Positive });

/** The event of committed v2: prompt-only follow-up requests. */
export const HistoricalWorkflowProposalEventV2Schema = Schema.Union([
  ...SharedEventArmsV3,
  Schema.Struct({ type: Schema.Literal("FOLLOW_UP_REQUESTED"), ...HistoricalFollowUpRequestV1Schema.fields }),
  ...FollowUpSettledArmsV3,
]);

/** The event of committed v3 and v4. Release v0.0.12 reads exactly this union. */
export const WorkflowProposalEventV4Schema = Schema.Union([
  ...SharedEventArmsV3,
  Schema.Struct({
    type: Schema.Literal("FOLLOW_UP_REQUESTED"),
    input: DurableFollowUpInputSchema,
    identity: IdentifiedFollowUpIdentityV3Schema,
    conversationId: Id,
    requestSequence: Positive,
  }),
  ...FollowUpSettledArmsV3,
]);

/** The event of committed v5: the v4 union and the follow-up transfer. */
export const WorkflowProposalEventV5Schema = Schema.Union([
  WorkflowProposalEventV4Schema,
  Schema.Struct({
    type: Schema.Literal("FOLLOW_UP_TRANSFERRED"),
    source: Schema.Struct({ conversationId: Id, requestSequence: Positive, identity: FollowUpIdentityV3Schema }),
    destination: Schema.Struct({ parentSessionId: Id, parentConversationId: Id, inputEntryId: Id, turnEndEntryId: Id }),
    queuedMappings: Schema.Array(Schema.Struct({ sourceKey: Id, destinationEntryId: Id })),
  }),
]);

type HistoricalWorkflowEvent =
  | typeof HistoricalWorkflowProposalEventV2Schema.Type
  | typeof WorkflowProposalEventV5Schema.Type;

/** Normalize a strictly decoded historical event to the current event. A v2
 *  request keeps explicit historical identity, which current request parsing
 *  never admits. The inert outcome evidence and the retired injected learnings
 *  drop out. A RESUME before encoding 14 carried no reader map and a RECOVER
 *  named no progressed attempt; this conversion is removed after 2027-10-17,
 *  with the encodings 10 to 12 that it also serves. */
export function normalizeHistoricalWorkflowEvent(event: HistoricalWorkflowEvent): DecodedWorkflowProposalEvent {
  switch (event.type) {
    case "RESUME": return { type: "RESUME", readers: {} };
    case "RECOVER": return { type: "RECOVER", progressed: [] };
    case "FOLLOW_UP_REQUESTED": {
      if (!("prompt" in event)) return event;
      const { prompt, ...request } = event;
      return { ...request, identity: { kind: "historical" }, input: { text: prompt } };
    }
    case "ATTEMPT_SUCCEEDED": {
      const { evidence: _evidence, injectedLearnings: _learnings, ...outcome } = event.outcome;
      return { ...event, outcome };
    }
    case "ATTEMPT_FAILED": {
      const { injectedLearnings: _learnings, ...failure } = event.failure;
      return { ...event, failure };
    }
    default: return event;
  }
}

/** A current event put in the field shapes of a historical version. The
 *  version's frozen codec then parses it strictly, so an event that the
 *  version cannot hold fails there. */
type EncodedHistoricalWorkflowEvent = HistoricalWorkflowEvent | DecodedWorkflowProposalEvent;

/** Encode a current event at the historical version whose semantics a replay
 *  re-derives. Strict replay compares normalized values, so the inert evidence
 *  list takes the empty value that every historical producer wrote, a
 *  RESUME drops its reader map, and a RECOVER drops the progressed attempts,
 *  which no historical version holds. */
export function encodeHistoricalWorkflowEvent(event: DecodedWorkflowProposalEvent, version: Exclude<WorkflowProposalEncoding, 14>): EncodedHistoricalWorkflowEvent {
  if (event.type === "RESUME") return { type: "RESUME" };
  if (event.type === "RECOVER") return { type: "RECOVER" };
  if (version >= 6) return event;
  if (version === 2 && event.type === "FOLLOW_UP_REQUESTED") {
    return { type: event.type, prompt: event.input.text, conversationId: event.conversationId, requestSequence: event.requestSequence };
  }
  if (event.type === "ATTEMPT_SUCCEEDED") return { ...event, outcome: { ...event.outcome, evidence: [] } };
  return event;
}


/** Strictly decode the control of a stored initialized v2 or recovered v2 root.
 *  An ordered migration that rewrites such a root proves its result with this
 *  reader, because it is the reader that replay applies to the row. */
export function parseHistoricalWorkflowControlV2(value: unknown): HistoricalWorkflowControlV2 {
  return Schema.decodeUnknownSync(HistoricalWorkflowControlV2Schema, { onExcessProperty: "error" })(value);
}
