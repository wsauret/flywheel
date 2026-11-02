import type { CommittedWorkflowControl } from "./committed-control.js";
import { graphTopology, inheritGraphTopology, keepsStructure } from "./graph-topology.js";
import { attemptIdOf, type Attempt, type CollectAllJoin, type GraphNodeState, type LogicalNode, type WorkflowGraph } from "./graph-types.js";

/** The node with a new state. Each arm keeps its own kind, so the union stays
 *  discriminated. */
export function withNodeState(node: LogicalNode, state: GraphNodeState): LogicalNode {
  switch (node.kind) {
    case "agent": return { ...node, state };
    case "phase": return { ...node, state };
    case "list": return { ...node, state };
    case "item": return { ...node, state };
    case "repeat": return { ...node, state };
    case "while": return { ...node, state };
    case "for": return { ...node, state };
  }
}

/** The node at a new global preorder position. */
function withNodeOrder(node: LogicalNode, order: number): LogicalNode {
  switch (node.kind) {
    case "agent": return { ...node, order };
    case "phase": return { ...node, order };
    case "list": return { ...node, order };
    case "item": return { ...node, order };
    case "repeat": return { ...node, order };
    case "while": return { ...node, order };
    case "for": return { ...node, order };
  }
}

/** A container is not work: it holds no attempt, and it opens and settles
 *  through deterministic control only. */
export function isContainerNode(node: Pick<LogicalNode, "kind">): boolean {
  return node.kind === "phase" || node.kind === "list" || node.kind === "item" || node.kind === "repeat";
}

/** The join of a list that has expanded, or undefined before it expands.
 *  A list expands when it is ready, and a list over the launch input that no
 *  repeat holds expands at launch, because the input is known then. A list
 *  that has not expanded counts at its declared worst case. */
export function listJoin(graph: Pick<WorkflowGraph, "joins">, listNodeId: string): WorkflowGraph["joins"][number] | undefined {
  return graph.joins.find(({ nodeId }) => nodeId === listNodeId);
}

/** The ids of the nodes of earlier runs of a list or a repeat: the items of
 *  a list, or the round nodes of a repeat, that a Resume superseded when it
 *  ran their owner again as a new run (`reopenFailedNodes`), and every node
 *  that they hold. Such a node names its own owner as its replacement. They
 *  stay as history: no join requires them, and their attempts do not count
 *  against the limit. */
export function rerunSupersededIds(graph: Pick<WorkflowGraph, "nodes">): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const node of graph.nodes.toSorted((left, right) => left.order - right.order)) {
    if (node.ownership._tag === "workflow") continue;
    const owner = node.ownership.parentNodeId;
    if (ids.has(owner) || (node.state._tag === "superseded" && node.state.replacementNodeId === owner)) ids.add(node.id);
  }
  return ids;
}

/** The parts of control that a graph change edits. Launch expansion applies
 *  changes before the rest of control exists, so the change functions take
 *  only these parts and keep the rest of what they receive. */
export type GraphStructure = Pick<CommittedWorkflowControl, "graph" | "attempts" | "guardrails">;

/** The control with one node edited, or the control itself when no node has
 *  the id. An edit that keeps the node's id, place, and owner keeps the
 *  graph's structure, which the next transition reads again instead of
 *  building it, and names the one node that the next derivation of the
 *  frontier starts from. */
export function replaceNode<Control extends Pick<CommittedWorkflowControl, "graph">>(
  control: Control,
  nodeId: string,
  update: (node: LogicalNode) => LogicalNode,
): Control {
  const index = graphTopology(control.graph).position.get(nodeId);
  const node = index === undefined ? undefined : control.graph.nodes[index];
  if (index === undefined || !node) return control;
  const next = update(node);
  const nodes = [...control.graph.nodes];
  nodes[index] = next;
  const graph = { ...control.graph, nodes };
  if (keepsStructure(node, next)) inheritGraphTopology(control.graph, graph, [index]);
  return { ...control, graph };
}

/** One change to the graph in current shapes. List expansion and the start
 *  of a round are the producers, and `group.expanded` records the changes of
 *  an expansion. The model-facing reassessment vocabulary of control from
 *  before phases is the frozen version 3 change union in
 *  `historical-codecs.ts`, which this union does not replace. */
export type GraphChange =
  | { readonly kind: "add_node"; readonly node: LogicalNode; readonly item: Attempt["item"] }
  | { readonly kind: "add_dependency"; readonly dependency: WorkflowGraph["dependencies"][number] }
  | { readonly kind: "add_join"; readonly join: CollectAllJoin };

/** The attempts that a node added at run time starts with: one for an agent,
 *  and, for a history `while` node, one for each body record of its current
 *  round. A container and a history `for` node start with none.
 *  `provenance` says which producer added the node. */
export function initialAttempts(
  node: LogicalNode,
  item: Attempt["item"],
  provenance: Attempt["provenance"],
): readonly Attempt[] {
  const definitionIds = node.kind === "agent"
    ? [node.definitionId]
    : node.kind === "while" ? node.body.map(({ step }) => step) : []; // stored key of control v10
  return definitionIds.map((definitionId, index) => ({
    id: attemptIdOf(node.id, index + 1),
    logicalNodeId: node.id,
    workflowDefinitionId: node.workflowDefinitionId,
    definitionId,
    sequence: index + 1,
    iteration: node.kind === "while" ? node.iteration : 1,
    resumeRevertCount: 0,
    provenance,
    ownership: node.ownership,
    state: { _tag: "pending" },
    parentAttemptId: null,
    conversationId: null,
    handoff: null,
    priorRetryFeedback: null,
    item,
  }));
}

/** Insert one node and its attempts. Without `afterNodeId` the node goes
 *  last. With it, the node goes immediately after that node and every node
 *  takes its new preorder position. The attempts go after the attempts of
 *  `afterNodeId`, else before the attempts of the first node that follows,
 *  so the attempt array keeps graph order. */
export function insertNode<Control extends GraphStructure>(
  control: Control,
  node: LogicalNode,
  attempts: readonly Attempt[],
  afterNodeId?: string,
): Control {
  return insertNodes(control, [node], attempts, afterNodeId);
}

function insertNodes<Control extends GraphStructure>(
  control: Control,
  added: readonly LogicalNode[],
  attempts: readonly Attempt[],
  afterNodeId?: string,
): Control {
  const positions = new Map(control.graph.nodes.map(({ id }, index) => [id, index]));
  const ids = new Set(positions.keys());
  for (const node of added) {
    if (ids.has(node.id)) throw new Error(`Workflow invariant rejected duplicate node "${node.id}"`);
    ids.add(node.id);
  }
  const nodeIndex = afterNodeId === undefined
    ? control.graph.nodes.length
    : (positions.get(afterNodeId) ?? -1) + 1;
  const nodes = [
    ...control.graph.nodes.slice(0, nodeIndex),
    ...added.map((node) => withNodeState(node, { _tag: "pending" })),
    ...control.graph.nodes.slice(nodeIndex),
  ].map(withNodeOrder);
  const targetAttemptIndexes = control.attempts
    .map((attempt, index) => attempt.logicalNodeId === afterNodeId ? index : -1)
    .filter((index) => index >= 0);
  const targetAttemptIndex = targetAttemptIndexes.at(-1);
  const followingAttemptIndex = control.attempts.findIndex((attempt) =>
    (positions.get(attempt.logicalNodeId) ?? Number.MAX_SAFE_INTEGER) >= nodeIndex
  );
  const attemptIndex = afterNodeId === undefined
    ? control.attempts.length
    : targetAttemptIndex === undefined
      ? followingAttemptIndex < 0 ? control.attempts.length : followingAttemptIndex
      : targetAttemptIndex + 1;
  return withAttemptOrderedAccounting({
    ...control,
    graph: { ...control.graph, nodes },
    attempts: [...control.attempts.slice(0, attemptIndex), ...attempts, ...control.attempts.slice(attemptIndex)],
    guardrails: {
      ...control.guardrails,
      attemptMutationsUsed: [
        ...control.guardrails.attemptMutationsUsed,
        ...attempts.map(({ id: attemptId }) => ({ attemptId, used: 0 })),
      ],
    },
  });
}

/** The control with its mutation accounting in the order of the attempts it
 *  counts. Attempts run in parallel, so the order in which their insertions
 *  land follows the order in which they finish; this order does not, so
 *  committed control is the same for every completion order. */
export function withAttemptOrderedAccounting<Control extends GraphStructure>(control: Control): Control {
  const position = new Map(control.attempts.map(({ id }, index) => [id, index]));
  const rank = (attemptId: string): number => position.get(attemptId) ?? Number.MAX_SAFE_INTEGER;
  return {
    ...control,
    guardrails: {
      ...control.guardrails,
      attemptMutationsUsed: control.guardrails.attemptMutationsUsed.toSorted((left, right) => rank(left.attemptId) - rank(right.attemptId)),
    },
  };
}

/** The graph with its edges and joins in graph order. Independent lists can
 *  expand in either order when their sources run in parallel, and this
 *  order is the same for both. No reader depends on the edge order. */
export function withGraphOrderedEdges<Control extends GraphStructure>(control: Control): Control {
  const position = new Map(control.graph.nodes.map(({ id }, index) => [id, index]));
  const rank = (nodeId: string): number => position.get(nodeId) ?? Number.MAX_SAFE_INTEGER;
  return {
    ...control,
    graph: {
      ...control.graph,
      dependencies: control.graph.dependencies.toSorted((left, right) => rank(left.nodeId) - rank(right.nodeId) || rank(left.dependsOn) - rank(right.dependsOn)),
      joins: control.graph.joins.toSorted((left, right) => rank(left.nodeId) - rank(right.nodeId)),
    },
  };
}

/** Apply graph changes in order. Each added node goes immediately after the
 *  node added before it, the first one after `afterNodeId`, so a list in
 *  preorder lands in preorder. Each added work node starts with its initial
 *  attempts under `provenance`; a container holds none. */
export function applyGraphChanges<Control extends GraphStructure>(
  control: Control,
  changes: readonly GraphChange[],
  provenance: (change: Extract<GraphChange, { kind: "add_node" }>) => Attempt["provenance"],
  afterNodeId: string,
): Control {
  const nodes: LogicalNode[] = [];
  const attempts: Attempt[] = [];
  const dependencies = [...control.graph.dependencies];
  const joins = [...control.graph.joins];
  for (const change of changes) {
    switch (change.kind) {
      case "add_node":
        nodes.push(change.node);
        if (!isContainerNode(change.node)) attempts.push(...initialAttempts(change.node, change.item, provenance(change)));
        break;
      case "add_dependency":
        dependencies.push(change.dependency);
        break;
      case "add_join":
        joins.push(change.join);
        break;
    }
  }
  const proposed = nodes.length === 0 ? control : insertNodes(control, nodes, attempts, afterNodeId);
  return withGraphOrderedEdges({ ...proposed, graph: { ...proposed.graph, dependencies, joins } });
}
