import { hashDefinition } from "../definition-hash.js";
import { requireReducer, runReducer } from "../reducers/registry.js";
import type { ItemScope, RecipientScope } from "../context-bundle/context-facts.js";
import { joinEntryId } from "../context-bundle/context.js";
import { WORKFLOW_INPUT_SOURCE_ID } from "../workflow-schema.js";
import type { CommittedWorkflowControl } from "./committed-control.js";
import { completedBefore } from "./completion-order.js";
import type { WorkflowProposalEncoding } from "./events.js";
import { applyGraphChanges, isContainerNode, listJoin, replaceNode, rerunSupersededIds, withNodeState, type GraphChange } from "./graph-changes.js";
import { roundOfNodeId, type Attempt, type CollectAllJoin, type ExpansionNode, type ItemNode, type ListNode, type LogicalNode } from "./graph-types.js";
import { expansionChanges, itemProvenance, manifestOf, type ManifestItem } from "./list-expansion.js";
import {
  conditionHolds,
  earlierRoundOutputs,
  isJoinNode,
  joinedNodeIds,
  joinOf,
  nodeById,
  ownedNodes,
  reducerInput,
  requireItem,
  requireList,
  sourceOutput,
  TERMINAL,
  type JoinNode,
} from "./node-outputs.js";
import { advanceRepeat, laterRoundItems, openRepeat } from "./repeat-transitions.js";
import type { WorkflowControlFactDraft } from "./session-facts.js";
import { buildGroupExpandedFact, buildGroupExpansionRejectedFact, buildGroupSettledFact, buildWorkflowFailedFact } from "./fact-drafts.js";
import { admitStructureChange, WorkflowStructureRejectedError } from "./structural-admission.js";

// Pure container transitions: a ready node's `if` decides whether it runs,
// phases, items, and repeats open and settle, a list expands into its items
// and folds its join once every item is terminal, and a phase of named
// agents with a join folds it once every agent is terminal. They run inside
// `prepareExecution`, so strict replay derives them again from the committed
// events and compares their facts like every other proposal fact.

interface ContainerTransition {
  readonly control: CommittedWorkflowControl;
  readonly facts: readonly WorkflowControlFactDraft[];
  /** The expansion was refused: the control failed the workflow and holds no
   *  graph change from the expansion. */
  readonly rejected: boolean;
}

/** The manifest of a ready list that has not expanded, or why its source
 *  cannot feed it. The source list is a field of the source output, and the
 *  list's reducer admits the rest of that output. A list over the launch
 *  input expands at launch, so one that reaches here has no list to read. */
function sourceManifest(control: CommittedWorkflowControl, node: ListNode, admitted: readonly string[], earlier: readonly ItemNode[]): readonly ManifestItem[] | string {
  if (node.source.nodeId === WORKFLOW_INPUT_SOURCE_ID) {
    // A Resume that runs a list over the launch input again expands it over
    // the items of its earlier run, because control does not keep the input.
    if (earlier.length > 0) return [...new Map(earlier.map(({ key, label, item, vote }) => vote === undefined ? [key, { key, label, item }] : [vote.itemKey, { key: vote.itemKey, label: vote.itemLabel, item }])).values()];
    return `source "${WORKFLOW_INPUT_SOURCE_ID}.${node.source.field}" was not expanded at launch`;
  }
  const source = sourceOutput(control, node, admitted);
  const items = manifestOf(source?.[node.source.field], node);
  if (typeof items === "string") return items;
  const reducer = requireReducer(node.reducer.id, node.reducer.version);
  return reducer.admit(node.reducer.params, source, items.map(({ key }) => key), node.key) ?? items;
}

/** The context entry ids of the nodes that `include` selects, in the order
 *  in which a serial run records them: each attempt that recorded a handoff
 *  at its node's place in graph order, and the post-join entry of a settled
 *  join or a completed repeat after every node that it owns. An item's own
 *  records stay local to its list, so a node that an item owns adds none.
 *  `exceptAttemptId` names an attempt whose own entry is left out. */
function entriesInGraphOrder(control: CommittedWorkflowControl, include: (node: LogicalNode) => boolean, exceptAttemptId?: string): readonly string[] {
  const nodes = control.graph.nodes.toSorted((left, right) => left.order - right.order);
  // The last preorder position of each node's subtree, and its depth, so a
  // container's entry follows its subtree and an inner container's entry
  // precedes the entry of the container that owns it.
  const end = new Map(nodes.map((node) => [node.id, node.order]));
  for (const node of nodes.toReversed()) {
    if (node.ownership._tag === "workflow") continue;
    const owner = node.ownership.parentNodeId;
    end.set(owner, Math.max(end.get(owner) ?? 0, end.get(node.id) ?? node.order));
  }
  const depth = new Map<string, number>();
  for (const node of nodes) depth.set(node.id, node.ownership._tag === "workflow" ? 0 : (depth.get(node.ownership.parentNodeId) ?? 0) + 1);
  const attemptsOf = Map.groupBy(control.attempts, ({ logicalNodeId }) => logicalNodeId);
  const keyed: { readonly at: number; readonly depth: number; readonly id: string }[] = [];
  // The work of an earlier run of a list or a repeat is history that its
  // new run replaces, so no bundle reads it.
  const superseded = rerunSupersededIds(control.graph);
  for (const node of nodes) {
    if (!include(node) || superseded.has(node.id)) continue;
    if ((isJoinNode(node) && joinOf(node).settlement !== null) || (node.kind === "repeat" && node.state._tag === "completed" && writesRepeatEntry(control, node.id))) {
      keyed.push({ at: (end.get(node.id) ?? node.order) + 0.5, depth: -(depth.get(node.id) ?? 0), id: joinEntryId(node.id) });
    }
    if (node.ownership._tag === "item") continue;
    for (const attempt of attemptsOf.get(node.id) ?? []) {
      if (attempt.id !== exceptAttemptId && attempt.handoff !== null && (attempt.state._tag === "completed" || attempt.state._tag === "blocked")) keyed.push({ at: node.order, depth: 0, id: attempt.id });
    }
  }
  return keyed.toSorted((left, right) => left.at - right.at || left.depth - right.depth).map(({ id }) => id);
}

/** Whether a completed repeat records one context entry of its own: the
 *  output of its last body phase in every round, when that phase is a join.
 *  The entries of an agent's rounds already hold each round's handoff. */
export function writesRepeatEntry(control: CommittedWorkflowControl, repeatNodeId: string): boolean {
  const last = lastBodyNode(control, repeatNodeId);
  return last !== undefined && isJoinNode(last);
}

/** The last node of the first run's round 1 of a repeat, in graph order. */
export function lastBodyNode(control: CommittedWorkflowControl, repeatNodeId: string): LogicalNode | undefined {
  return control.graph.nodes
    .filter(({ id, ownership }) => ownership._tag === "round" && ownership.parentNodeId === repeatNodeId && ownership.round === 1 && roundOfNodeId(id)?.run === 1)
    .toSorted((left, right) => left.order - right.order)
    .at(-1);
}

/** Whether a node sits in a round before the round of `reader` of its
 *  repeat. */
function inEarlierRound(control: CommittedWorkflowControl, node: LogicalNode, reader: LogicalNode): boolean {
  const place = roundOfNodeId(reader.id);
  if (place === null) return false;
  for (let current: LogicalNode | undefined = node; current !== undefined;) {
    if (current.ownership._tag === "round") return current.ownership.parentNodeId === place.repeatNodeId && current.ownership.round < place.round;
    if (current.ownership._tag === "workflow") return false;
    current = nodeById(control, current.ownership.parentNodeId);
  }
  return false;
}

/** The ids of the context entries that every item of a list shares. A
 *  proposal at encoding 7 or later freezes the entries of the nodes that
 *  complete before the list can start, and the entries of each earlier round
 *  of its repeat, in the order of `entriesInGraphOrder`, so the bundle never
 *  depends on the order in which parallel attempts finished. An earlier
 *  encoding froze the entries of every completed node in graph order, and
 *  its items read them in recorded order, which a serial run decided. A
 *  later round shares the entries of each earlier round, so each of its
 *  agents reads what the repeat already found as already reported (refer to
 *  `AccumulatedContext.earlierRounds`). */
function admittedContext(control: CommittedWorkflowControl, node: ListNode, encoding: WorkflowProposalEncoding): readonly string[] {
  if (encoding < 7) return legacyAdmittedContext(control);
  const before = completedBefore(control.graph, node.id);
  return entriesInGraphOrder(control, (candidate) => before.has(candidate.id)
    || (node.ownership._tag === "round" && inEarlierRound(control, candidate, node)));
}

/** The admitted context that a proposal before encoding 7 froze. History
 *  only; remove with encoding 6. */
function legacyAdmittedContext(control: CommittedWorkflowControl): readonly string[] {
  const ids: string[] = [];
  for (const node of control.graph.nodes.toSorted((left, right) => left.order - right.order)) {
    if ((isJoinNode(node) && joinOf(node).settlement !== null) || (node.kind === "repeat" && node.state._tag === "completed")) ids.push(joinEntryId(node.id));
    if (node.ownership._tag === "item") continue;
    for (const attempt of control.attempts) {
      if (attempt.logicalNodeId === node.id && attempt.handoff !== null && (attempt.state._tag === "completed" || attempt.state._tag === "blocked")) ids.push(attempt.id);
    }
  }
  return ids;
}

/** The frozen context view of one workflow-scope attempt: an allow-list of
 *  the entries of the nodes that complete before its node can start, and of
 *  the earlier attempts of its own node, such as a retry's failed attempt.
 *  A parallel sibling's output reaches an attempt only once a later node
 *  waits on that sibling, so what an attempt reads never depends on the
 *  order in which parallel attempts finished or on when it reads. An
 *  attempt in a later round of a repeat also reads the earlier rounds. A
 *  rerun reads none of its node's earlier results, because it runs again
 *  on what changed before it (`reopenFailedNodes`). */
function workflowBundle(control: CommittedWorkflowControl, attempt: Attempt): Extract<RecipientScope, { _tag: "workflow" }> {
  const before = completedBefore(control.graph, attempt.logicalNodeId);
  const node = nodeById(control, attempt.logicalNodeId);
  const rerun = attempt.provenance._tag === "continuation" && attempt.provenance.reason === "rerun";
  return {
    _tag: "workflow",
    sharedEntryIds: entriesInGraphOrder(control, (candidate) => (candidate.id === attempt.logicalNodeId && !rerun) || before.has(candidate.id)
      || (node !== undefined && inEarlierRound(control, candidate, node)), attempt.id),
  };
}

function rejectExpansion(control: CommittedWorkflowControl, node: ListNode, reason: string): ContainerTransition {
  return {
    control: { ...control, status: "failed", frontier: [] },
    facts: [buildGroupExpansionRejectedFact(node.id, reason), buildWorkflowFailedFact()],
    rejected: true,
  };
}

/** The expansion that the launch applied to a list over the launch input,
 *  as control holds it: each item, then its agents and the edges between
 *  them, then the join. It has the shape of the changes that a list over an
 *  agent records when it expands, so `group.expanded` names the agent nodes
 *  of every list the same way. */
function launchExpansion(control: CommittedWorkflowControl, join: CollectAllJoin): readonly GraphChange[] {
  const changes: GraphChange[] = [];
  for (const itemId of join.requiredNodeIds) {
    const item = requireItem(control, itemId);
    changes.push({ kind: "add_node", item: null, node: item });
    // An item owns only the agents of its phases.
    const agents = ownedNodes(control, itemId).filter((node): node is Extract<ExpansionNode, { kind: "agent" }> => node.kind === "agent" && node.ownership._tag === "item");
    for (const [position, agent] of agents.entries()) {
      changes.push({ kind: "add_node", item: item.item, node: agent });
      const previous = agents[position - 1];
      if (previous !== undefined) changes.push({ kind: "add_dependency", dependency: { nodeId: agent.id, dependsOn: previous.id } });
    }
  }
  changes.push({ kind: "add_join", join });
  return changes;
}

/** Expand the first ready list whose `if` holds. It reads the source list,
 *  checks each key and the declared width, adds one item with its agents per
 *  item and one join over the items, freezes the shared context, and starts
 *  the list running. Structural admission judges the prospective control. A
 *  refused expansion changes no graph: it fails the workflow and records
 *  only `group.expansion_rejected`. An empty manifest adds an empty join, so
 *  the list settles in the same preparation. Expansion is bounded by the
 *  declared width and the attempt limit, and is not charged to the insert
 *  guardrail. A list over the launch input expanded at launch, so here it
 *  only freezes its shared context and starts running, and its
 *  `group.expanded` records the expansion that the launch applied. */
export function expandReadyList(control: CommittedWorkflowControl, encoding: WorkflowProposalEncoding): ContainerTransition {
  const node = control.graph.nodes
    .toSorted((left, right) => left.order - right.order)
    .find((candidate): candidate is ListNode => candidate.kind === "list" && candidate.state._tag === "ready" && candidate.admittedContext === null);
  if (!node) return { control, facts: [], rejected: false };
  const shared = admittedContext(control, node, encoding);
  const start = (expanded: CommittedWorkflowControl): CommittedWorkflowControl =>
    replaceNode(expanded, node.id, (candidate) => candidate.kind === "list" ? { ...candidate, state: { _tag: "running" }, admittedContext: shared } : candidate);
  const launched = listJoin(control.graph, node.id);
  if (launched !== undefined) {
    return {
      control: start(control),
      facts: [buildGroupExpandedFact({ groupNodeId: node.id, itemCount: launched.requiredNodeIds.length / (node.votes ?? 1), changes: launchExpansion(control, launched), admittedContext: shared }, encoding)],
      rejected: false,
    };
  }
  // The items of the earlier runs of a list that a Resume runs again
  // (`reopenFailedNodes`). The new run follows them in graph order.
  const earlier = ownedNodes(control, node.id).filter((candidate): candidate is ItemNode => candidate.kind === "item").toSorted((left, right) => left.order - right.order);
  const items = laterRoundItems(control, node.id) ?? sourceManifest(control, node, shared, earlier);
  if (typeof items === "string") return rejectExpansion(control, node, items);
  const run = earlier.length === 0 ? 1 : nextRun(control, node.id);
  const { changes, ordinals } = expansionChanges(node, items, encoding, run);
  const lastEarlier = earlier.at(-1);
  const after = lastEarlier === undefined ? node.id : ownedNodes(control, lastEarlier.id).at(-1)?.id ?? lastEarlier.id;
  const proposed = start(applyGraphChanges(control, changes, itemProvenance(ordinals), after));
  try {
    admitStructureChange(control, proposed);
  } catch (error) {
    if (error instanceof WorkflowStructureRejectedError) return rejectExpansion(control, node, error.message);
    throw error;
  }
  return {
    control: proposed,
    facts: [buildGroupExpandedFact({ groupNodeId: node.id, itemCount: items.length, changes, admittedContext: shared }, encoding)],
    rejected: false,
  };
}

/** The first run number from 2 that no item of the list holds yet. */
function nextRun(control: CommittedWorkflowControl, listNodeId: string): number {
  let run = 2;
  while (control.graph.nodes.some(({ id }) => id.startsWith(`${listNodeId}:run:${run}:`))) run += 1;
  return run;
}

/** Fold the join of one running list whose items are all terminal, or of a
 *  running phase whose agents are all terminal. The reducer reads one slot
 *  per item or agent. A list completes with failures in its summary; a phase
 *  fails when an agent failed or is blocked. `group.settled` records the exact ordered
 *  slot references and their sha256. Every other value the reducer reads is
 *  a reference that control already records: each item is in
 *  `group.expanded`, the source is the attempt or join entry that the list's
 *  frozen context names, and the outputs of the earlier rounds of a repeat
 *  are in their own `group.settled`. Strict replay folds the join again and
 *  compares the output. Returns null while a joined node is unsettled. */
function settleJoin(control: CommittedWorkflowControl, node: JoinNode, encoding: WorkflowProposalEncoding): Omit<ContainerTransition, "rejected"> | null {
  const joined = joinedNodeIds(control, node);
  if (joined === undefined) return null;
  if (!joined.every((id) => TERMINAL.has(nodeById(control, id)?.state._tag ?? "pending"))) return null;
  const { reducer: pinned } = joinOf(node);
  const reducer = requireReducer(pinned.id, pinned.version);
  const { slots, ...rest } = reducerInput(control, node, earlierRoundOutputs(control, node));
  const output = runReducer(reducer, pinned.params, { slots, ...rest });
  const input = slots.map(({ content: _content, item: _item, vote: _vote, ...slot }) => slot);
  const summary = {
    total: slots.length,
    completed: slots.filter(({ disposition }) => disposition === "completed").length,
    failed: slots.filter(({ disposition }) => disposition === "failed").length,
  };
  return {
    control: replaceNode(control, node.id, (candidate) => {
      if (candidate.kind === "list") return { ...candidate, state: { _tag: "completed" }, settlement: summary };
      if (candidate.kind === "phase" && candidate.join !== null) {
        const unfinished = encoding < 12 ? [] : ownedNodes(control, candidate.id).filter(({ state }) => UNFINISHED_NODE_STATES.has(state._tag));
        return {
          ...candidate,
          state: unfinished.length === 0 ? { _tag: "completed" } : { _tag: "failed", reason: `Phase work did not complete: ${unfinished.map(({ id }) => id).join(", ")}` },
          join: { ...candidate.join, settlement: summary },
        };
      }
      return candidate;
    }),
    facts: [buildGroupSettledFact({
      groupNodeId: node.id,
      reducer: { id: reducer.id, version: reducer.version },
      input,
      inputSha256: hashDefinition(input).sha256,
      output,
      summary,
    })],
  };
}

/** The item scope of an agent attempt of a list, or null for any other
 *  attempt. */
export function itemScopeOf(control: CommittedWorkflowControl, attempt: Attempt): ItemScope | null {
  if (attempt.ownership._tag !== "item") return null;
  const item = requireItem(control, attempt.ownership.parentNodeId);
  if (item.ownership._tag !== "list") throw new Error(`Workflow invariant rejected item "${item.id}" outside a list`);
  return { _tag: "item", listNodeId: item.ownership.parentNodeId, itemNodeId: item.id, key: item.key };
}

/** The vote that an agent attempt of a list with votes casts on its item:
 *  its item's vote number and the list's vote count. Undefined for every
 *  other attempt. */
export function attemptVote(control: CommittedWorkflowControl, attempt: Attempt): { readonly number: number; readonly count: number } | undefined {
  const scope = itemScopeOf(control, attempt);
  if (scope === null) return undefined;
  const { vote } = requireItem(control, scope.itemNodeId);
  const { votes } = requireList(control, scope.listNodeId);
  return vote === undefined || votes === undefined ? undefined : { number: vote.number, count: votes };
}

/** The context view of one attempt that a proposal at `encoding` started:
 *  its item with the entries its list froze at admission, or the workflow
 *  scope. From encoding 7 a workflow-scope attempt reads its frozen bundle
 *  (refer to `workflowBundle`) and every attempt reads its shared entries in
 *  bundle order. An attempt that an earlier encoding started read every
 *  workflow-scope entry in recorded order, which a serial run decided. */
export function attemptScope(control: CommittedWorkflowControl, attempt: Attempt, encoding: WorkflowProposalEncoding): RecipientScope {
  const scope = itemScopeOf(control, attempt);
  if (scope === null) return encoding < 7 ? { _tag: "workflow" } : workflowBundle(control, attempt);
  const list = requireList(control, scope.listNodeId);
  // An agent attempt of a list exists only after its list's expansion froze
  // the shared context.
  if (list.admittedContext === null) throw new Error(`Workflow invariant rejected attempt "${attempt.id}" of unexpanded list "${list.id}"`);
  return encoding < 7 ? { ...scope, sharedEntryIds: list.admittedContext } : { ...scope, sharedEntryIds: list.admittedContext, bundleOrder: true };
}

/** The node states that mean the work did not complete. */
export const UNFINISHED_NODE_STATES: ReadonlySet<LogicalNode["state"]["_tag"]> = new Set(["failed", "blocked"]);

/** Whether a failure left the run without work that it needs, once nothing
 *  more can run. The run needs each node outside every list that depends on
 *  other work, and its last top-level node, whose output is the result that
 *  the parent reads. A failed node that no node depends on and that is not
 *  the result leaves the run complete, with the failure in its record,
 *  because no later work reads its missing output. A blocked agent
 *  or item of a list is its own failure, which its join records. From
 *  encoding 14 a failed agent of an item also fails the run once nothing
 *  more can run, so a Resume can run it again (`reopenFailedNodes`). */
export function needsFailedWork(nodes: readonly LogicalNode[], encoding: WorkflowProposalEncoding): boolean {
  const result = nodes.reduce<LogicalNode | undefined>((last, node) =>
    node.ownership._tag === "workflow" && (last === undefined || node.order > last.order) ? node : last, undefined);
  return (result !== undefined && UNFINISHED_NODE_STATES.has(result.state._tag))
    || nodes.some((node) => node.state._tag === "blocked" && (node.ownership._tag === "workflow" || node.ownership._tag === "phase" || node.ownership._tag === "round"))
    || (encoding >= 14 && nodes.some((node) => node.kind === "agent" && node.state._tag === "failed" && node.ownership._tag === "item"));
}

/** Decide the `if` of every ready node that states one. A node whose
 *  condition does not hold is skipped with each pending attempt it holds;
 *  the nodes it owns derive as skipped from it, and the nodes after it run.
 *  A node whose condition holds stays ready, and deciding it again gives the
 *  same answer, because the node it names settled before it was ready. */
export function decideConditions(control: CommittedWorkflowControl): CommittedWorkflowControl {
  const skipped = control.graph.nodes.filter((node) => node.state._tag === "ready" && (node.kind === "agent" || node.kind === "phase" || node.kind === "list")
    && node.condition !== null && !conditionHolds(control, node, node.condition));
  if (skipped.length === 0) return control;
  const ids = new Set(skipped.map(({ id }) => id));
  return {
    ...control,
    graph: {
      ...control.graph,
      nodes: control.graph.nodes.map((node) => {
        if (!ids.has(node.id) || (node.kind !== "agent" && node.kind !== "phase" && node.kind !== "list") || node.condition === null) return node;
        return withNodeState(node, { _tag: "skipped", reason: "Its if condition does not hold", causedBy: [node.condition.nodeId] });
      }),
    },
    attempts: control.attempts.map((attempt) => ids.has(attempt.logicalNodeId) && attempt.state._tag === "pending"
      ? { ...attempt, state: { _tag: "skipped", reason: "Its if condition does not hold" } }
      : attempt),
  };
}

/** Open every ready phase, item, and repeat: it starts running, which lets
 *  the frontier release its children. A container holds no attempt, so
 *  opening it starts no worker. A ready list opens through its expansion. A
 *  repeat over items that cannot open fails the workflow as a refused
 *  expansion does. */
export function openReadyContainers(control: CommittedWorkflowControl): ContainerTransition {
  let opened = control;
  for (const node of control.graph.nodes) {
    if (node.state._tag !== "ready") continue;
    if (node.kind === "phase" || node.kind === "item") {
      opened = replaceNode(opened, node.id, (candidate) => withNodeState(candidate, { _tag: "running" }));
      continue;
    }
    if (node.kind !== "repeat") continue;
    const result = openRepeat(opened, node);
    if (typeof result === "string") {
      return { control: { ...opened, status: "failed", frontier: [] }, facts: [buildGroupExpansionRejectedFact(node.id, result), buildWorkflowFailedFact()], rejected: true };
    }
    opened = result;
  }
  return { control: opened, facts: [], rejected: false };
}

/** Settle every running container whose work is done, deepest first, so an
 *  agent settles its item, the items settle their list, and a list or a
 *  phase settles the repeat round that owns it. A phase or an item completes
 *  when every child completed or was cancelled, superseded, or skipped, and
 *  fails when a child failed or is blocked, also when the phase has a join.
 *  A list completes when its join folds, whatever the dispositions are, so
 *  a failed agent of a list never fails its phase. A repeat decides as its rounds
 *  settle (refer to `advanceRepeat`). */
export function settleContainers(control: CommittedWorkflowControl, encoding: WorkflowProposalEncoding): Omit<ContainerTransition, "rejected"> {
  const running = control.graph.nodes
    .filter((node) => isContainerNode(node) && node.state._tag === "running")
    .toSorted((a, b) => b.order - a.order);
  const facts: WorkflowControlFactDraft[] = [];
  const settled = running.reduce((current, container) => {
    const latest = nodeById(current, container.id) ?? container;
    if (isJoinNode(latest)) {
      const folded = settleJoin(current, latest, encoding);
      if (!folded) return current;
      facts.push(...folded.facts);
      return folded.control;
    }
    if (latest.kind === "repeat") return advanceRepeat(current, latest, encoding);
    const children = ownedNodes(current, latest.id);
    if (!children.every(({ state }) => TERMINAL.has(state._tag))) return current;
    const unfinished = children.filter(({ state }) => UNFINISHED_NODE_STATES.has(state._tag));
    const kind = latest.kind === "item" ? "Item" : "Phase";
    return replaceNode(current, latest.id, (node) => withNodeState(node, unfinished.length === 0
      ? { _tag: "completed" }
      : { _tag: "failed", reason: `${kind} work did not complete: ${unfinished.map(({ id }) => id).join(", ")}` }));
  }, control);
  return { control: settled, facts };
}
