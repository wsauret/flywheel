import { contentEvidence } from "../../infra/content-evidence.js";
import { requireReducer, runReducer } from "../reducers/registry.js";
import type { WorkflowTreeJoin } from "../../protocol/workflow-view-protocol-types.js";
import type { EarlierRound, HandoffReference, ReducerInput, ReducerInputSlot, ReducerOutput, SourceOutput } from "../reducers/reducer.js";
import { ITEM_POSITION_KEY, WORKFLOW_INPUT_SOURCE_ID } from "../workflow-schema.js";
import type { CommittedWorkflowControl } from "./committed-control.js";
import { listJoin } from "./graph-changes.js";
import { graphTopology } from "./graph-topology.js";
import { inRound, repeatRun, roundOfNodeId, type Attempt, type ItemNode, type ListNode, type LogicalNode, type NodeCondition, type PhaseNode, type RepeatNode } from "./graph-types.js";
import { isNonEmpty } from "./loop-signal.js";

// The outputs of the nodes of committed control: the handoff of an agent,
// the join output of a list or of a phase with a join, and the outputs of
// the rounds of a repeat. Expansion, conditions, repeats, reads, the tree,
// and the context entries of joins all read them here, so each reads the
// same value. Every output folds again from committed control alone.

/** A node whose join folds its agents' outputs: a list, or a phase of named
 *  agents with a join. */
export type JoinNode = ListNode | (PhaseNode & { readonly join: NonNullable<PhaseNode["join"]> });

export function isJoinNode(node: LogicalNode): node is JoinNode {
  return node.kind === "list" || (node.kind === "phase" && node.join !== null);
}

/** The reducer, the write, and the settlement of a join node. */
export function joinOf(node: JoinNode): { readonly reducer: ListNode["reducer"]; readonly write: ListNode["write"]; readonly settlement: ListNode["settlement"] } {
  return node.kind === "list" ? node : node.join;
}

/** The node states that end a node. */
export const TERMINAL: ReadonlySet<LogicalNode["state"]["_tag"]> = new Set(["completed", "failed", "blocked", "cancelled", "superseded", "skipped"]);

export function nodeById(control: Pick<CommittedWorkflowControl, "graph">, id: string): LogicalNode | undefined {
  const index = graphTopology(control.graph).position.get(id);
  return index === undefined ? undefined : control.graph.nodes[index];
}

export function requireItem(control: Pick<CommittedWorkflowControl, "graph">, id: string): ItemNode {
  const node = nodeById(control, id);
  if (node?.kind !== "item") throw new Error(`Workflow invariant rejected missing item node "${id}"`);
  return node;
}

export function requireList(control: Pick<CommittedWorkflowControl, "graph">, id: string): ListNode {
  const node = nodeById(control, id);
  if (node?.kind !== "list") throw new Error(`Workflow invariant rejected missing list node "${id}"`);
  return node;
}

/** The nodes that `ownerId` owns directly, in graph order. */
export function ownedNodes(control: Pick<CommittedWorkflowControl, "graph">, ownerId: string): readonly LogicalNode[] {
  return graphTopology(control.graph).owned.get(ownerId)?.flatMap((index) => control.graph.nodes[index] ?? []) ?? [];
}

/** The attempt id and content sha256 of a completed attempt's handoff, which
 *  its `handoff.written` fact records. */
function handoffReference(attempt: Attempt): HandoffReference {
  return { stepId: attempt.id, sha256: contentEvidence(JSON.stringify(attempt.handoff)).sha256 }; // stored key of control v11 join slots
}

/** The latest completed attempt with a handoff of each node. */
function completedHandoffs(control: Pick<CommittedWorkflowControl, "attempts">): ReadonlyMap<string, Attempt> {
  const handoffs = new Map<string, Attempt>();
  for (const attempt of control.attempts) {
    if (attempt.state._tag === "completed" && attempt.handoff !== null) handoffs.set(attempt.logicalNodeId, attempt);
  }
  return handoffs;
}

/** The handoff of the latest completed attempt of an agent node, or null. */
function agentHandoff(control: Pick<CommittedWorkflowControl, "attempts">, nodeId: string): { readonly [key: string]: unknown } | null {
  return control.attempts.findLast((attempt) => attempt.logicalNodeId === nodeId && attempt.state._tag === "completed" && attempt.handoff !== null)?.handoff ?? null;
}

/** One slot per item of a list, in manifest order: the item's disposition
 *  and the handoff of its last agent, with that handoff's recorded content,
 *  the item, and the vote of an item of a list with votes. The last agent is
 *  the agent of the item's last phase, which the item owns last in graph
 *  order, so no reader parses a node id. */
function listSlots(control: CommittedWorkflowControl, itemIds: readonly string[]): readonly ReducerInputSlot[] {
  // One pass over the nodes and the attempts, so a fold stays linear in the
  // size of control however many items the list holds.
  const items = new Map<string, ItemNode>();
  const lastAgent = new Map<string, LogicalNode>();
  for (const node of control.graph.nodes) {
    if (node.kind === "item") items.set(node.id, node);
    if (node.kind === "agent" && node.ownership._tag === "item") {
      const last = lastAgent.get(node.ownership.parentNodeId);
      if (last === undefined || node.order > last.order) lastAgent.set(node.ownership.parentNodeId, node);
    }
  }
  const handoffs = completedHandoffs(control);
  return itemIds.map((itemId) => {
    const item = items.get(itemId);
    if (!item) throw new Error(`Workflow invariant rejected missing item node "${itemId}"`);
    const completed = item.state._tag === "completed";
    const agent = lastAgent.get(item.id);
    const attempt = completed && agent !== undefined ? handoffs.get(agent.id) : undefined;
    if (completed && attempt === undefined) throw new Error(`Workflow invariant rejected completed item "${item.id}" without a handoff`);
    return {
      ordinal: item.ordinal,
      key: item.key,
      branchNodeId: item.id,
      disposition: completed ? "completed" : "failed",
      handoff: attempt === undefined ? null : handoffReference(attempt),
      content: attempt?.handoff ?? null,
      item: item.item,
      ...(item.vote === undefined ? {} : { vote: item.vote }),
    };
  });
}

/** One slot per named agent of a phase, in authored order, keyed by the
 *  agent's id, which the file declares once. Agents that share a brief share
 *  its name, so the name only labels the agent. A phase holds no items, so
 *  each slot's item is null. */
function phaseSlots(control: CommittedWorkflowControl, phase: PhaseNode): readonly ReducerInputSlot[] {
  const handoffs = completedHandoffs(control);
  return ownedNodes(control, phase.id).map((agent, index) => {
    const completed = agent.state._tag === "completed";
    const attempt = completed ? handoffs.get(agent.id) : undefined;
    if (completed && attempt === undefined) throw new Error(`Workflow invariant rejected completed agent "${agent.id}" without a handoff`);
    return {
      ordinal: index + 1,
      key: agent.kind === "agent" ? agent.definitionId : agent.id,
      branchNodeId: agent.id,
      disposition: completed ? "completed" : "failed",
      handoff: attempt === undefined ? null : handoffReference(attempt),
      content: attempt?.handoff ?? null,
      item: null,
    };
  });
}

/** The ids of the nodes that a join node's join folds, once they exist: the
 *  items of an expanded list, or the agents of a phase. Undefined for a list
 *  that has not expanded. */
export function joinedNodeIds(control: CommittedWorkflowControl, node: JoinNode): readonly string[] | undefined {
  return node.kind === "list" ? listJoin(control.graph, node.id)?.requiredNodeIds : ownedNodes(control, node.id).map(({ id }) => id);
}

/** What one join's reducer reads from committed control. An expanded list
 *  has frozen its shared context, so its source is the one it expanded from.
 *  A join in a round of a repeat also reads the join outputs of the same
 *  join in the rounds before. */
export function reducerInput(control: CommittedWorkflowControl, node: JoinNode, earlierRounds: readonly EarlierRound[]): ReducerInput {
  if (node.kind === "phase") {
    return { slots: phaseSlots(control, node), key: ITEM_POSITION_KEY, source: null, contract: node.join.reducer.contract, earlierRounds };
  }
  const join = listJoin(control.graph, node.id);
  if (node.admittedContext === null || join === undefined) throw new Error(`Workflow invariant rejected the fold of unexpanded list "${node.id}"`);
  return {
    slots: listSlots(control, join.requiredNodeIds),
    key: node.key,
    source: sourceOutput(control, node, node.admittedContext),
    contract: node.reducer.contract,
    earlierRounds,
    ...(node.votes === undefined ? {} : { votes: node.votes }),
  };
}

/** The reducer output of a settled join, folded again from committed control
 *  with the outputs of the rounds before it. */
function foldSettled(control: CommittedWorkflowControl, node: JoinNode, earlierRounds: readonly EarlierRound[]): ReducerOutput {
  const { reducer, settlement } = joinOf(node);
  if (settlement === null) throw new Error(`Workflow invariant rejected the output of unsettled join "${node.id}"`);
  return runReducer(requireReducer(reducer.id, reducer.version), reducer.params, reducerInput(control, node, earlierRounds));
}

/** The id of the copy of `nodeId` in each round of one run of its repeat
 *  that exists, round 1 first, with the round number: the run that `nodeId`
 *  names, or with `current` the repeat's current run. A node outside every
 *  repeat has one copy, itself, in round 0. */
function roundCopies(control: Pick<CommittedWorkflowControl, "graph">, nodeId: string, current = false): readonly { readonly round: number; readonly id: string }[] {
  const place = roundOfNodeId(nodeId);
  if (place === null) return [{ round: 0, id: nodeId }];
  const repeat = nodeById(control, place.repeatNodeId);
  if (repeat?.kind !== "repeat") return [{ round: place.round, id: nodeId }];
  const run = current ? repeatRun(control.graph, repeat.id) : place.run;
  const ids = new Set(control.graph.nodes.map(({ id }) => id));
  const template = `${place.repeatNodeId}:round:1${place.rest}`;
  const copies: { readonly round: number; readonly id: string }[] = [];
  for (let round = 1; ids.has(inRound(template, place.repeatNodeId, round, run)); round += 1) copies.push({ round, id: inRound(template, place.repeatNodeId, round, run) });
  return copies;
}

/** The settled join output of each round of a join in a repeat, up to round
 *  `through`, in round order. Each round folds with the outputs of the
 *  rounds before it, which this fold computed once each, so the seen set of
 *  `dedupe@2` comes from committed control alone. A round whose copy did
 *  not settle has no output. */
function settledRoundOutputs(control: CommittedWorkflowControl, nodeId: string, through: number): readonly EarlierRound[] {
  const outputs: EarlierRound[] = [];
  for (const copy of roundCopies(control, nodeId)) {
    if (copy.round > through) break;
    const node = nodeById(control, copy.id);
    if (node === undefined || !isJoinNode(node) || joinOf(node).settlement === null) continue;
    outputs.push({ round: copy.round, output: foldSettled(control, node, [...outputs]) });
  }
  return outputs;
}

/** The settled outputs of the same join in the rounds before a join's
 *  round, round 1 first. Empty outside a repeat and in round 1. */
export function earlierRoundOutputs(control: CommittedWorkflowControl, node: JoinNode): readonly EarlierRound[] {
  const place = roundOfNodeId(node.id);
  return place === null ? [] : settledRoundOutputs(control, node.id, place.round - 1);
}

/** The reducer output of a settled join. The reducer is pure, so this equals
 *  the output that the join's `group.settled` fact records. */
function settledJoinOutput(control: CommittedWorkflowControl, node: JoinNode): ReducerOutput {
  return foldSettled(control, node, earlierRoundOutputs(control, node));
}

/** The output of one node: the latest handoff of an agent, the join output
 *  of a settled join node, or, for a repeat, the output of its last body
 *  phase in every round (refer to {@link roundsOutput}). Null when the node
 *  has no output yet. */
export function nodeOutput(control: CommittedWorkflowControl, node: LogicalNode): SourceOutput | null {
  if (node.kind === "agent") return agentHandoff(control, node.id);
  if (isJoinNode(node)) return joinOf(node).settlement === null ? null : settledJoinOutput(control, node);
  if (node.kind === "repeat") {
    const last = lastRoundOneNode(control, node);
    return last === undefined ? null : roundsOutput(control, last.id);
  }
  return null;
}

/** The last node of the first run's round 1 of a repeat in graph order. */
function lastRoundOneNode(control: CommittedWorkflowControl, repeat: RepeatNode): LogicalNode | undefined {
  return control.graph.nodes
    .filter((node) => node.ownership._tag === "round" && node.ownership.parentNodeId === repeat.id && node.ownership.round === 1 && roundOfNodeId(node.id)?.run === 1)
    .toSorted((left, right) => left.order - right.order)
    .at(-1);
}

/** The output of a body node of a repeat as a reader outside the repeat
 *  reads it: each list field of the node's output in every round of the
 *  repeat's current run that produced one, round 1 first, and every other field from the latest
 *  round. A round that skipped the node adds nothing. `dedupe@2` keeps an
 *  item in at most one round, so the kept items hold each key once. */
export function roundsOutput(control: CommittedWorkflowControl, nodeId: string): SourceOutput | null {
  const outputs = roundCopies(control, nodeId, true).flatMap(({ id }) => {
    const copy = nodeById(control, id);
    const output = copy === undefined ? null : nodeOutput(control, copy);
    return output === null ? [] : [output];
  });
  if (outputs.length === 0) return null;
  const fields = [...new Set(outputs.flatMap((output) => Object.keys(output)))];
  return Object.fromEntries(fields.map((field) => {
    const values = outputs.map((output) => output[field]);
    return [field, values.every(Array.isArray) ? values.flat() : values.at(-1) ?? null];
  }));
}

/** Whether `readerId` sits in the same repeat as the round 1 node
 *  `sourceId`, so it reads the source's copy in its own round. */
function inSameRepeat(readerId: string, sourceId: string): boolean {
  const reader = roundOfNodeId(readerId);
  const source = roundOfNodeId(sourceId);
  return reader !== null && source !== null && reader.repeatNodeId === source.repeatNodeId;
}

/** The output of `sourceId` as `readerId` reads it: inside the source's
 *  repeat, the copy of its own round; outside, every round (refer to
 *  {@link roundsOutput}); anywhere else, the source's own output. */
export function outputAsRead(control: CommittedWorkflowControl, readerId: string, sourceId: string): SourceOutput | null {
  if (roundOfNodeId(sourceId) !== null && !inSameRepeat(readerId, sourceId)) return roundsOutput(control, sourceId);
  const source = nodeById(control, sourceId);
  return source === undefined ? null : nodeOutput(control, source);
}

/** Whether a ready node's `if` holds: the named node completed, or a field
 *  of its output is not empty. A skipped node never completed, and a failed
 *  node blocks every node after it, so a condition never reads one. */
export function conditionHolds(control: CommittedWorkflowControl, node: LogicalNode, condition: NodeCondition): boolean {
  const named = nodeById(control, condition.nodeId);
  if (named?.state._tag !== "completed") return false;
  if (condition._tag === "completed") return true;
  return isNonEmpty(outputAsRead(control, node.id, condition.nodeId)?.[condition.field]);
}

/** What a settled join's reducer output states beside its counts: the
 *  coverage of a coverage reducer, and the kept and dropped counts of a
 *  selecting reducer. Each projection reads the output that the join wrote,
 *  so the tree and the output agree, and no client computes them. Empty for
 *  a join that has not settled or a reducer that projects neither. */
export function settledJoinProjections(control: CommittedWorkflowControl, node: JoinNode): Pick<WorkflowTreeJoin, "coverage" | "selection"> {
  const { reducer } = joinOf(node);
  const { coverage, selection } = requireReducer(reducer.id, reducer.version);
  if ((coverage === undefined && selection === undefined) || joinOf(node).settlement === null) return {};
  const output = settledJoinOutput(control, node);
  const selected = selection?.(output, reducer.contract);
  return {
    ...(coverage === undefined ? {} : { coverage: coverage(output) }),
    ...(selected === undefined ? {} : { selection: { verb: selected.verb, kept: selected.kept.length, dropped: selected.dropped.length } }),
  };
}

/** The output that a list's source list comes from, as the list's frozen
 *  shared context names it: the handoff of the latest completed attempt of
 *  the source agent in `admitted`, or the output of a source join, repeat,
 *  or body node of a repeat. Null for the launch input, which control does
 *  not keep. Expansion passes the context that it freezes, so the fold reads
 *  the exact source that the expansion read. */
export function sourceOutput(control: CommittedWorkflowControl, node: ListNode, admitted: readonly string[]): SourceOutput | null {
  if (node.source.nodeId === WORKFLOW_INPUT_SOURCE_ID) return null;
  const source = nodeById(control, node.source.nodeId);
  if (source === undefined) throw new Error(`Workflow invariant rejected list source "${node.source.nodeId}"`);
  if (source.kind !== "agent" || (roundOfNodeId(source.id) !== null && !inSameRepeat(node.id, source.id))) return outputAsRead(control, node.id, source.id);
  const entries = new Set(admitted);
  return control.attempts.findLast((candidate) =>
    entries.has(candidate.id) && candidate.logicalNodeId === source.id && candidate.definitionId === source.definitionId
    && candidate.state._tag === "completed" && candidate.handoff !== null)?.handoff ?? null;
}
