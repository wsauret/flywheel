import { Schema } from "effect";
import { ArtifactContractSchema } from "../artifact-contracts.js";
import { FieldMapSchema } from "../output-contract/grammar.js";
import { VotesSchema } from "../workflow-schema.js";

// The graph of committed workflow control, version 11. Its node
// kinds are `agent`, `phase`, `list`, `item`, and `repeat`; `while` and
// `for` remain only as history arms of control that a build before phases
// launched, which strict replay and Resume still execute.

const IdSchema = Schema.NonEmptyString;
const NonNegativeIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const PositiveIntSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const AuthoredIterationLimitSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 }));

// The owner of a node or an attempt. Every arm except `workflow` names the
// owning container node `parentNodeId`. `phase` is a phase of named agents,
// or a phase container of control from before phases; `phaseId` is its id.
// `list` owns the item nodes of one phase over a list, and `outputId` names
// the phase whose output the list's join is. `item` owns the agent nodes of
// one item, and `key` is the item key. `round` owns the nodes of one round
// of a repeat, and `round` is the 1-based number of that round. Control
// states the round here, so no reader parses it out of an id.
const WorkflowOwnershipSchema = Schema.Union([
  Schema.TaggedStruct("workflow", {
    workflowDefinitionId: IdSchema,
  }),
  Schema.TaggedStruct("phase", {
    workflowDefinitionId: IdSchema,
    phaseId: IdSchema,
    parentNodeId: IdSchema,
  }),
  Schema.TaggedStruct("list", {
    workflowDefinitionId: IdSchema,
    outputId: IdSchema,
    parentNodeId: IdSchema,
  }),
  Schema.TaggedStruct("item", {
    workflowDefinitionId: IdSchema,
    outputId: IdSchema,
    key: IdSchema,
    parentNodeId: IdSchema,
  }),
  Schema.TaggedStruct("round", {
    workflowDefinitionId: IdSchema,
    parentNodeId: IdSchema,
    round: PositiveIntSchema,
  }),
]);

// `skipped` is a phase whose `if` was false, a node inside a skipped
// container, or the rest of a round after its repeat stopped. It satisfies
// the order of the nodes after it, and it is never a failure.
const GraphNodeStateSchema = Schema.Union([
  Schema.TaggedStruct("pending", {}),
  Schema.TaggedStruct("ready", {}),
  Schema.TaggedStruct("running", {}),
  Schema.TaggedStruct("completed", {}),
  Schema.TaggedStruct("failed", { reason: Schema.String }),
  Schema.TaggedStruct("blocked", {
    reason: Schema.String,
    causedBy: Schema.Array(IdSchema),
  }),
  Schema.TaggedStruct("cancelled", {
    reason: Schema.String,
    causedBy: Schema.Array(IdSchema),
  }),
  Schema.TaggedStruct("superseded", {
    reason: Schema.String,
    replacementNodeId: Schema.NullOr(IdSchema),
  }),
  Schema.TaggedStruct("skipped", {
    reason: Schema.String,
    causedBy: Schema.Array(IdSchema),
  }),
]);

// A blocked attempt is durable and immutable: its handoff is the canonical
// evidence for why the work stopped, and only a lineage-linked corrective
// attempt can settle the logical node it belongs to.
const AttemptStateSchema = Schema.Union([
  Schema.TaggedStruct("pending", {}),
  Schema.TaggedStruct("running", {}),
  Schema.TaggedStruct("completed", {}),
  Schema.TaggedStruct("blocked", { reason: Schema.String }),
  Schema.TaggedStruct("failed", { reason: Schema.String }),
  Schema.TaggedStruct("skipped", { reason: Schema.String }),
]);

// One executable position of a history node: the record it runs.
const StepPositionSchema = Schema.Struct({
  step: IdSchema, // stored key of control v10
});

type StepPosition = typeof StepPositionSchema.Type;

/** The `then` chain of an agent node of control from before phases: the
 *  record that ran after the node's own attempt, when its `when` field was
 *  not empty. History only. Remove after 2027-04-30. */
export interface FollowUpV10 extends StepPosition {
  readonly when: string | null;
  readonly then: FollowUpV10 | null;
}

const FollowUpV10Schema: Schema.Codec<FollowUpV10> = Schema.suspend(
  (): Schema.Codec<FollowUpV10> => Schema.Struct({
    ...StepPositionSchema.fields,
    when: Schema.NullOr(Schema.String),
    then: Schema.NullOr(FollowUpV10Schema),
  }),
);

/** How often an agent's failed handoff tries again, and whether it stops
 *  when the failure repeats word for word. */
const RetryControlSchema = Schema.Struct({
  max: AuthoredIterationLimitSchema,
  stuck: Schema.Boolean,
});

/** Why an attempt exists: compile queued it, it retries another, a
 *  reassessment added it, an expansion added it for an item (`ordinal` is
 *  the 1-based manifest position of the item), a repeat added it for a round
 *  (`index` is the 1-based round), or a history `then` chain added it. */
export const AttemptProvenanceSchema = Schema.Union([
  Schema.TaggedStruct("authored", {}),
  Schema.TaggedStruct("retry", {}),
  Schema.TaggedStruct("continuation", {
    reason: Schema.Literals(["overflow", "reopen", "rerun"]),
    chargeAttemptId: IdSchema,
    sourceConversationId: Schema.NullOr(IdSchema),
  }),
  Schema.TaggedStruct("reassessment", {}),
  Schema.TaggedStruct("item", { ordinal: PositiveIntSchema }),
  Schema.TaggedStruct("round", { index: PositiveIntSchema }),
  // History only: the next record of a `then` chain or of a `for` body in
  // control from before phases. Remove after 2027-04-30.
  Schema.TaggedStruct("followUpV10", {}),
]);

/** When a phase runs: when a node completed, or when a field of its output
 *  is not empty. A skipped node never completed. */
const ConditionSchema = Schema.Union([
  Schema.TaggedStruct("completed", { nodeId: IdSchema }),
  Schema.TaggedStruct("field", { nodeId: IdSchema, field: IdSchema }),
]);

const LogicalNodeFields = {
  id: IdSchema,
  workflowDefinitionId: IdSchema,
  order: NonNegativeIntSchema,
  ownership: WorkflowOwnershipSchema,
  state: GraphNodeStateSchema,
};

const AgentNodeSchema = Schema.Struct({
  kind: Schema.Literal("agent"),
  ...LogicalNodeFields,
  /** The agent record this node runs. */
  definitionId: IdSchema,
  name: IdSchema,
  retry: Schema.NullOr(RetryControlSchema),
  condition: Schema.NullOr(ConditionSchema),
  /** The `then` chain of a node of control from before phases. History
   *  only; absent on every node a phase-grammar compile emits. */
  followUpV10: Schema.optionalKey(FollowUpV10Schema),
});

// A `while` loop of control from before phases: every body record runs as
// an attempt of this one node. History only; remove after 2027-04-30.
const WhileNodeV10Schema = Schema.Struct({
  kind: Schema.Literal("while"),
  ...LogicalNodeFields,
  evaluator: Schema.Struct({ step: IdSchema, field: IdSchema }), // stored key of control v10
  body: Schema.NonEmptyArray(StepPositionSchema),
  maxIterations: AuthoredIterationLimitSchema,
  detectStuck: Schema.Boolean,
  iteration: PositiveIntSchema,
  priorNormalizedSignal: Schema.NullOr(Schema.String),
});

// A `for` loop of control from before phases: the body runs as attempts of
// this one node, once for each item. History only; remove after 2027-04-30.
const ForNodeV10Schema = Schema.Struct({
  kind: Schema.Literal("for"),
  ...LogicalNodeFields,
  source: Schema.Struct({ step: IdSchema, field: IdSchema }), // stored key of control v10
  body: Schema.NonEmptyArray(StepPositionSchema),
});

/** The counts a settled join keeps in control. The full reducer output is
 *  in the `group.settled` fact and in the post-join context entry. */
export const ReducerSummarySchema = Schema.Struct({
  total: NonNegativeIntSchema,
  completed: NonNegativeIntSchema,
  failed: NonNegativeIntSchema,
});

/** The reducer that folds a join: its registered id and version, its
 *  decoded parameters, and the output contract that compilation derived
 *  from the parameters and the contracts around the join. Control pins the
 *  contract because a fold cannot read the definition: strict replay
 *  re-derives every fold from the stored facts alone, and a resumed run
 *  folds against the contract that it launched with. */
const JoinReducerSchema = Schema.Struct({
  id: IdSchema,
  version: PositiveIntSchema,
  params: Schema.Record(Schema.String, Schema.Json),
  contract: FieldMapSchema,
});

/** The join of a phase of named agents: it folds one slot for each agent
 *  once every agent is terminal, and writes one artifact. */
const PhaseJoinSchema = Schema.Struct({
  reducer: JoinReducerSchema,
  write: ArtifactContractSchema,
  settlement: Schema.NullOr(ReducerSummarySchema),
});

// A phase of named agents, or a phase container of control from before
// phases. It holds no attempt. It opens when its prerequisites complete,
// which lets its agents run, and it settles when every agent is terminal: a
// phase with a join completes when its join folds, and any other phase fails
// when an agent failed.
const PhaseNodeSchema = Schema.Struct({
  kind: Schema.Literal("phase"),
  ...LogicalNodeFields,
  phaseId: IdSchema,
  name: IdSchema,
  condition: Schema.NullOr(ConditionSchema),
  join: Schema.NullOr(PhaseJoinSchema),
});

/** One phase of the stream that a list runs for each item: the record it
 *  runs, its display name, and its own retry. */
const ListPhaseSchema = Schema.Struct({
  definitionId: IdSchema,
  name: IdSchema,
  retry: Schema.NullOr(RetryControlSchema),
});

// A list is the container of one stream: a phase over a list and the
// stream phases after it. It holds no attempt. When it is ready, expansion
// reads the source list, adds one item node for each item with one agent
// for each phase of the stream, freezes the shared context that every item
// reads, and starts the list running. When every item is terminal, the
// reducer folds the join and the list completes, whatever the item
// dispositions are. `admittedContext` and `settlement` are null until
// expansion and settlement.
const ListNodeSchema = Schema.Struct({
  kind: Schema.Literal("list"),
  ...LogicalNodeFields,
  /** The phase whose output the join is: the last phase of the stream. */
  outputId: IdSchema,
  name: IdSchema,
  /** The node whose output list the list reads: an agent node, a list
   *  node, a phase node with a join, or a repeat whose rounds hold the
   *  list. */
  source: Schema.Struct({ nodeId: IdSchema, field: IdSchema }),
  /** The item field that gives each item its identity, or
   *  `ITEM_POSITION_KEY` for a list that declares no `unique` key. */
  key: IdSchema,
  /** The item field that gives each item its display name. */
  label: Schema.NullOr(IdSchema),
  /** The most items expansion admits: the declared `max` of the source
   *  list, or, for a list of the launch input that declares none, the
   *  length of the list that the launch passed. */
  width: PositiveIntSchema,
  /** The author's `votes`: how many agents vote on each item. */
  votes: Schema.optionalKey(VotesSchema),
  /** The phases each item runs, in order. */
  phases: Schema.NonEmptyArray(ListPhaseSchema),
  reducer: JoinReducerSchema,
  /** The one artifact the join writes. */
  write: ArtifactContractSchema,
  /** The context entry ids that every item shares, in recorded order. */
  admittedContext: Schema.NullOr(Schema.Array(IdSchema)),
  settlement: Schema.NullOr(ReducerSummarySchema),
  condition: Schema.NullOr(ConditionSchema),
});

// One vote of an item of a list with votes: its number, from 1 to the
// list's `votes`, and the key and display label of the item it votes on.
const ItemVoteSchema = Schema.Struct({
  number: PositiveIntSchema,
  itemKey: IdSchema,
  itemLabel: IdSchema,
});

// An item is the container of the agents of one item, or of one vote on one
// item. It completes when every agent completes, and it fails when an agent
// fails.
const ItemNodeSchema = Schema.Struct({
  kind: Schema.Literal("item"),
  ...LogicalNodeFields,
  /** The item's unique key: the item key, and for a vote the item key and
   *  `#<vote>`, such as `src/a.ts:42#2`. */
  key: IdSchema,
  /** The display name: the item's label, and for a vote ` #<vote>`. */
  label: IdSchema,
  /** The 1-based position of the item in the manifest. The votes of one
   *  item follow its position, vote 1 first. */
  ordinal: PositiveIntSchema,
  item: Schema.Json,
  vote: Schema.optionalKey(ItemVoteSchema),
});

/** The loop of a repeat. `while` reads `field` of the output of the round's
 *  `evaluator`, named by its round 1 node id; `priorSignal` is the field of
 *  the round before, which `stuck` compares. `each` reads the items of
 *  `source` once, when the repeat opens, and runs one round for each item;
 *  `reassess` names, by its round 1 node id, the agent whose reassessment
 *  edits the items after the current round. A repeat over the launch input
 *  holds its items from launch, because control does not keep the input. */
const RepeatLoopSchema = Schema.Union([
  Schema.TaggedStruct("while", {
    evaluator: IdSchema,
    field: IdSchema,
    max: AuthoredIterationLimitSchema,
    stuck: Schema.Boolean,
    priorSignal: Schema.NullOr(Schema.String),
  }),
  Schema.TaggedStruct("each", {
    source: Schema.Struct({ nodeId: IdSchema, field: IdSchema }),
    /** The most items the source list holds: its declared `max`, or the
     *  length of the list that the launch passed. Null when a registered
     *  workflow's list declares no `max`: the repeat then holds as many
     *  items as the list has when it opens, and the attempt limit bounds
     *  them, as it bounded a `for` of a build before phases. */
    width: Schema.NullOr(NonNegativeIntSchema),
    reassess: Schema.NullOr(IdSchema),
    items: Schema.NullOr(Schema.Array(Schema.Json)),
  }),
]);

// A repeat owns, in each round, a copy of its body: the nodes of round 1,
// which compile emits, with round 1's id prefix replaced (refer to
// `roundPrefix`). A round starts after the round before it finishes.
const RepeatNodeSchema = Schema.Struct({
  kind: Schema.Literal("repeat"),
  ...LogicalNodeFields,
  name: IdSchema,
  loop: RepeatLoopSchema,
});

const LogicalNodeSchema = Schema.Union([
  AgentNodeSchema,
  PhaseNodeSchema,
  ListNodeSchema,
  ItemNodeSchema,
  RepeatNodeSchema,
  WhileNodeV10Schema,
  ForNodeV10Schema,
]);

/** One problem of a handoff, located by its dotted JSON path. */
export const HandoffIssueSchema = Schema.Struct({
  path: Schema.String,
  message: Schema.String,
  hint: Schema.optionalKey(Schema.String),
});

export const AttemptSchema = Schema.Struct({
  id: IdSchema,
  logicalNodeId: IdSchema,
  workflowDefinitionId: IdSchema,
  /** The agent record this attempt runs. */
  definitionId: IdSchema,
  sequence: PositiveIntSchema,
  iteration: PositiveIntSchema,
  resumeRevertCount: NonNegativeIntSchema,
  provenance: AttemptProvenanceSchema,
  ownership: WorkflowOwnershipSchema,
  state: AttemptStateSchema,
  parentAttemptId: Schema.NullOr(IdSchema),
  conversationId: Schema.NullOr(IdSchema),
  handoff: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)),
  /** The problems that remain in a completed attempt's handoff that the
   *  runtime delivered after the agent's handoff correction ran out. Absent
   *  for a handoff that its contract accepted, and in every attempt that
   *  control recorded before 2026-11-11. */
  handoffIssues: Schema.optionalKey(Schema.Array(HandoffIssueSchema)),
  priorRetryFeedback: Schema.NullOr(Schema.String),
  /** The item of an attempt of a repeat over items, or of a `for` loop of
   *  control from before phases. */
  item: Schema.Json,
});

const ATTEMPT_ID_INFIX = ":attempt:";

/** The id of a node's attempt with the given sequence. Compilation,
 *  insertion, retry, and expansion name every attempt this way; only a
 *  reassessment of control from before phases names its own attempts. */
export function attemptIdOf(nodeId: string, sequence: number): string {
  return `${nodeId}${ATTEMPT_ID_INFIX}${sequence}`;
}

/** The node id that an attempt id from {@link attemptIdOf} names, or null
 *  when the id has no such form. A reader of the stored facts uses it to
 *  find the node of a handoff's attempt. */
export function attemptNodeIdOf(attemptId: string): string | null {
  const at = attemptId.lastIndexOf(ATTEMPT_ID_INFIX);
  return at < 0 ? null : attemptId.slice(0, at);
}

// The last round segment of an id: `<repeat>:round:<round>` in a repeat's
// first run, and `<repeat>:run:<run>:round:<round>` in a run that a Resume
// started again.
const ROUND_SEGMENT = /^(.+?)(?::run:([1-9][0-9]*))?:round:([1-9][0-9]*)(?=$|:)(?!.*:round:[1-9])/;

/** The repeat, its run, and the round that a node id of a round names, or
 *  null for the id of any other node. A reader of the context entries, which
 *  carry ids only, finds the rounds of a repeat with it. Rounds of distinct
 *  runs of one repeat share its id and differ in `run`. */
export function roundOfNodeId(nodeId: string): { readonly repeatNodeId: string; readonly run: number; readonly round: number; readonly rest: string } | null {
  const match = ROUND_SEGMENT.exec(nodeId);
  if (match?.[1] === undefined || match[3] === undefined) return null;
  return { repeatNodeId: match[1], run: match[2] === undefined ? 1 : Number(match[2]), round: Number(match[3]), rest: nodeId.slice(match[0].length) };
}

/** The id of the node of round `round` of run `run` that is a copy of the
 *  first run's round 1 node `templateId`, which the compiler wrote. An id
 *  outside the repeat stays as it is. */
export function inRound(templateId: string, repeatNodeId: string, round: number, run = 1): string {
  const prefix = `${repeatNodeId}:round:1`;
  if (templateId !== prefix && !templateId.startsWith(`${prefix}:`)) return templateId;
  return `${repeatNodeId}${run === 1 ? "" : `:run:${run}`}:round:${round}${templateId.slice(prefix.length)}`;
}

/** The run of a repeat whose rounds count: 1, or the run that the latest
 *  Resume started when the repeat read work that ran again. The rounds of
 *  earlier runs stay as superseded history. */
export function repeatRun(graph: { readonly nodes: readonly { readonly id: string; readonly ownership: WorkflowOwnership }[] }, repeatNodeId: string): number {
  return graph.nodes.reduce((run, node) =>
    node.ownership._tag === "round" && node.ownership.parentNodeId === repeatNodeId ? Math.max(run, roundOfNodeId(node.id)?.run ?? 1) : run, 1);
}

const DependencyEdgeSchema = Schema.Struct({
  nodeId: IdSchema,
  dependsOn: IdSchema,
});

// The join of one list: `requiredNodeIds` are its item node ids in manifest
// order, and an empty manifest has none. The join is not a frontier
// prerequisite: the list settles when every required item is terminal.
const CollectAllJoinSchema = Schema.Struct({
  kind: Schema.Literal("collect_all"),
  nodeId: IdSchema,
  requiredNodeIds: Schema.Array(IdSchema),
});

// The structural limits that a phase container of control from before
// phases declared. History only: no phase-grammar compile emits a budget,
// so only a graph that normalized from control of version 10 or earlier
// holds `budgets`. Remove after 2027-04-30.
const ParentBudgetSchema = Schema.Struct({
  parentNodeId: IdSchema,
  limits: Schema.Struct({
    nodes: Schema.optionalKey(PositiveIntSchema),
    depth: Schema.optionalKey(PositiveIntSchema),
  }),
});

export const WorkflowGraphSchema = Schema.Struct({
  nodes: Schema.Array(LogicalNodeSchema),
  dependencies: Schema.Array(DependencyEdgeSchema),
  joins: Schema.Array(CollectAllJoinSchema),
  budgets: Schema.optionalKey(Schema.Array(ParentBudgetSchema)),
});

/** One graph change of a list expansion, which `group.expanded@3` records
 *  (refer to `GraphChange` in graph-changes.ts). An expansion adds only item
 *  nodes, their agents, the edges between the agents, and the list's join. */
export const ExpansionChangeSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("add_node"), node: Schema.Union([ItemNodeSchema, AgentNodeSchema]), item: Schema.Json }),
  Schema.Struct({ kind: Schema.Literal("add_dependency"), dependency: DependencyEdgeSchema }),
  Schema.Struct({ kind: Schema.Literal("add_join"), join: CollectAllJoinSchema }),
]);

export type ExpansionChange = typeof ExpansionChangeSchema.Type;
export type WorkflowOwnership = typeof WorkflowOwnershipSchema.Type;
export type GraphNodeState = typeof GraphNodeStateSchema.Type;
export type NodeCondition = typeof ConditionSchema.Type;
export type LogicalNode = typeof LogicalNodeSchema.Type;
export type AgentNode = typeof AgentNodeSchema.Type;
export type PhaseNode = typeof PhaseNodeSchema.Type;
export type ListNode = typeof ListNodeSchema.Type;
export type ItemNode = typeof ItemNodeSchema.Type;
export type RepeatNode = typeof RepeatNodeSchema.Type;
export type RetryControl = typeof RetryControlSchema.Type;

/** The most agents of one phase of a list: one for each item of its width,
 *  times its votes. Admission, the worst case, and the verifier count them
 *  here, so each counts a list with votes the same way. */
export function listAgentCount(list: Pick<ListNode, "width" | "votes">): number {
  return list.width * (list.votes ?? 1);
}

/** The nodes that a list expansion adds: each item, which its list owns,
 *  and its agents, which the item owns. */
export type ExpansionNode =
  | (ItemNode & { readonly ownership: Extract<WorkflowOwnership, { readonly _tag: "list" }> })
  | (AgentNode & { readonly ownership: Extract<WorkflowOwnership, { readonly _tag: "item" }> });
export type CollectAllJoin = typeof CollectAllJoinSchema.Type;
export type Attempt = typeof AttemptSchema.Type;
export type WorkflowGraph = typeof WorkflowGraphSchema.Type;
