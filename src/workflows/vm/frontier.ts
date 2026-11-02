import { isDeepStrictEqual } from "node:util";
import type { CommittedWorkflowControl } from "./committed-control.js";
import { isContainerNode, withNodeState } from "./graph-changes.js";
import { forgetGraphEdit, graphEdit, graphTopology, inheritGraphTopology, knownGraphTopology, type GraphTopology } from "./graph-topology.js";
import type {
  Attempt,
  GraphNodeState,
  LogicalNode,
  WorkflowGraph,
} from "./graph-types.js";

export interface FrontierCalculation {
  readonly graph: WorkflowGraph;
  readonly readyNodeIds: readonly string[];
}

export interface DependencyCycle {
  readonly nodeIds: readonly string[];
}

/** Find dependency cycles without deciding workflow transitions. */
export function findDependencyCycles(graph: WorkflowGraph): readonly DependencyCycle[] {
  const { position, stable, prerequisites } = graphTopology(graph);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const cycles: DependencyCycle[] = [];

  const visit = (id: string): void => {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      cycles.push({ nodeIds: [...stack.slice(start), id] });
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    stack.push(id);
    for (const dependency of prerequisites[position.get(id) ?? -1] ?? []) {
      if (position.has(dependency)) visit(dependency);
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  };

  for (const index of stable) {
    const node = graph.nodes[index];
    if (node) visit(node.id);
  }
  return cycles;
}

/** One derived node state and the depth at which it settled. A state that
 *  was not derived settled at depth 0. A derived terminal state settled one
 *  level deeper than the earliest input that caused it, and a node still
 *  waiting never settles. */
interface Derivation {
  readonly state: GraphNodeState;
  readonly depth: number;
}

/** The depth at which each input settled. */
type SettledDepth = (nodeId: string) => number;

/** The node of the graph with an id, or undefined for an id that names none. */
type NodeLookup = (nodeId: string) => LogicalNode | undefined;

const CAUSE_STATES: ReadonlySet<GraphNodeState["_tag"]> = new Set(["superseded", "cancelled", "blocked", "failed"]);

/** The gate a container owner places on one node. A node owned by a phase,
 *  a list, an item, or a round of a repeat waits until that container opens.
 *  A skipped owner skips the node, and any other terminal owner that did not
 *  complete passes its outcome down as a failed prerequisite would. The gate
 *  comes before every prerequisite. */
function ownerGate(node: LogicalNode, lookup: NodeLookup, settled: SettledDepth): Derivation | "open" {
  if (node.ownership._tag === "workflow") return "open";
  const ownerId = node.ownership.parentNodeId;
  const owner = lookup(ownerId);
  if (!owner) return { state: { _tag: "blocked", reason: "Missing owner", causedBy: [ownerId] }, depth: 1 };
  const depth = settled(owner.id) + 1;
  switch (owner.state._tag) {
    case "running":
    case "completed": return "open";
    case "pending":
    case "ready": return { state: { _tag: "pending" }, depth: Number.POSITIVE_INFINITY };
    case "superseded": return { state: { _tag: "superseded", reason: "Its owner was superseded", replacementNodeId: owner.state.replacementNodeId }, depth };
    case "cancelled": return { state: { _tag: "cancelled", reason: "Its owner was cancelled", causedBy: [owner.id] }, depth };
    case "skipped": return { state: { _tag: "skipped", reason: "Its owner was skipped", causedBy: [owner.id] }, depth };
    case "blocked":
    case "failed": return { state: { _tag: "blocked", reason: "Its owner cannot complete", causedBy: [owner.id] }, depth };
  }
}

/** The state of one node from its owner and prerequisites. A waiting node
 *  takes the outcome of the prerequisites that settled earliest, so its
 *  cause names the inputs nearest the original failure, as whole-graph sweeps
 *  would find them. */
function derivedState(
  node: LogicalNode,
  prerequisites: readonly string[],
  lookup: NodeLookup,
  settled: SettledDepth,
): Derivation {
  if (node.state._tag !== "pending" && node.state._tag !== "ready") return { state: node.state, depth: 0 };

  const gate = ownerGate(node, lookup, settled);
  if (gate !== "open") return gate;

  const resolved = prerequisites.flatMap((id) => lookup(id) ?? []);
  const missing = prerequisites.filter((id) => lookup(id) === undefined);
  if (missing.length > 0) {
    return { state: { _tag: "blocked", reason: "Missing required dependency", causedBy: missing }, depth: 1 };
  }

  const causes = resolved.filter((dependency) => CAUSE_STATES.has(dependency.state._tag));
  if (causes.length === 0) {
    // A skipped prerequisite satisfies order: the phases after a skipped
    // phase run (PI-AGENT-029).
    const waiting = resolved.some((dependency) => dependency.state._tag !== "completed" && dependency.state._tag !== "skipped");
    return { state: waiting ? { _tag: "pending" } : { _tag: "ready" }, depth: Number.POSITIVE_INFINITY };
  }
  const earliest = Math.min(...causes.map(({ id }) => settled(id)));
  const visible = causes.filter(({ id }) => settled(id) === earliest);
  const depth = earliest + 1;

  const superseded = visible.find((dependency) => dependency.state._tag === "superseded");
  if (superseded?.state._tag === "superseded") {
    return {
      state: { _tag: "superseded", reason: "A required dependency was superseded", replacementNodeId: superseded.state.replacementNodeId },
      depth,
    };
  }

  const cancelled = visible.filter((dependency) => dependency.state._tag === "cancelled");
  if (cancelled.length > 0) {
    return {
      state: { _tag: "cancelled", reason: "A required dependency was cancelled", causedBy: cancelled.map(({ id }) => id) },
      depth,
    };
  }

  return {
    state: { _tag: "blocked", reason: "A required dependency cannot complete", causedBy: visible.map(({ id }) => id) },
    depth,
  };
}

/** Derived nodes with what their derivation left. */
interface DerivedNodes {
  readonly nodes: readonly LogicalNode[];
  readonly frontier: FrontierState;
}

/** A derived graph with what its derivation left. */
interface DerivedGraph {
  readonly graph: WorkflowGraph;
  readonly frontier: FrontierState;
}

/** What a derivation of the frontier left: the positions of the ready work
 *  nodes in stable graph order, their ids in the same order, and the
 *  positions of the skipped nodes. */
interface FrontierState {
  readonly ready: readonly number[];
  readonly readyIds: readonly string[];
  readonly skipped: ReadonlySet<number>;
}

// Each derived nodes array with what its derivation left. A later array that
// edits it (`graphEdit`) derives from the changed nodes alone.
const frontiers = new WeakMap<readonly LogicalNode[], FrontierState>();

function isReadyWork(node: LogicalNode): boolean {
  return !isContainerNode(node) && node.state._tag === "ready";
}

function isOpen(state: GraphNodeState): boolean {
  return state._tag === "pending" || state._tag === "ready";
}

/** The depth at which a node that no change reached settles: a node still
 *  waiting never settles, and a node that does not derive settled at 0. */
function restingDepth(state: GraphNodeState): number {
  return isOpen(state) ? Number.POSITIVE_INFINITY : 0;
}

function frontierState(nodes: readonly LogicalNode[], stable: Iterable<number>): FrontierState {
  const ready: number[] = [];
  const readyIds: string[] = [];
  const skipped = new Set<number>();
  for (const index of stable) {
    // SAFETY: `stable` indexes `nodes`.
    const node = nodes[index]!;
    if (isReadyWork(node)) {
      ready.push(index);
      readyIds.push(node.id);
    }
    if (node.state._tag === "skipped") skipped.add(index);
  }
  return { ready, readyIds, skipped };
}

/** Derive every node state in one pass over the derivation order, so each
 *  node reads the final state, and the settling depth, of its prerequisites
 *  and its owner. The result equals the whole-graph sweeps that derived
 *  states before phases, at linear cost. A node whose state stays is the
 *  node it was, and a graph whose states all stay is the graph it was. */
function derivedNodes(input: readonly LogicalNode[], topology: GraphTopology, order: readonly number[]): readonly LogicalNode[] {
  let nodes: LogicalNode[] | undefined;
  const lookup: NodeLookup = (id) => {
    const index = topology.position.get(id);
    return index === undefined ? undefined : (nodes ?? input)[index];
  };
  const depths = new Map<string, number>();
  const settled: SettledDepth = (nodeId) => depths.get(nodeId) ?? 0;
  for (const index of order) {
    // SAFETY: the derivation order indexes the nodes it was built from.
    const node = (nodes ?? input)[index]!;
    if (!isOpen(node.state)) continue;
    const { state, depth } = derivedState(node, topology.prerequisites[index] ?? [], lookup, settled);
    depths.set(node.id, depth);
    if (isDeepStrictEqual(state, node.state)) continue;
    nodes ??= [...input];
    nodes[index] = withNodeState(node, state);
  }
  return nodes ?? input;
}

/** Positions in increasing rank, each at most once while it waits. */
function rankedQueue(rank: readonly number[]) {
  const heap: number[] = [];
  const queued = new Set<number>();
  // SAFETY: every caller passes a place below `heap.length`.
  const entry = (place: number) => heap[place]!;
  const before = (left: number, right: number) => (rank[entry(left)] ?? 0) < (rank[entry(right)] ?? 0);
  const swap = (left: number, right: number) => {
    [heap[left], heap[right]] = [entry(right), entry(left)];
  };
  return {
    push(index: number) {
      if (queued.has(index)) return;
      queued.add(index);
      heap.push(index);
      for (let at = heap.length - 1; at > 0;) {
        const parent = (at - 1) >> 1;
        if (!before(at, parent)) break;
        swap(at, parent);
        at = parent;
      }
    },
    pop(): number | undefined {
      const top = heap[0];
      const last = heap.pop();
      if (top === undefined || last === undefined) return undefined;
      queued.delete(top);
      if (heap.length > 0) {
        heap[0] = last;
        for (let at = 0; ;) {
          const [left, right] = [2 * at + 1, 2 * at + 2];
          let least = at;
          if (left < heap.length && before(left, least)) least = left;
          if (right < heap.length && before(right, least)) least = right;
          if (least === at) break;
          swap(at, least);
          at = least;
        }
      }
      return top;
    },
  };
}

/** The derivation of `input` from `base`, a derived array of the same
 *  structure that differs from `input` only at `changed`. Only a changed
 *  node, and each node that reads a node whose state or settling depth the
 *  derivation moved, derives again, in derivation order, so a transition
 *  costs the nodes it reached and not the size of the graph. Every other
 *  node keeps its state and settles at its resting depth, as a whole
 *  derivation of `input` finds it, because `base` already derived. */
function advancedNodes(
  input: readonly LogicalNode[],
  topology: GraphTopology & { readonly derivation: readonly number[] },
  base: readonly LogicalNode[],
  derived: FrontierState,
  changed: Iterable<number>,
): DerivedNodes {
  let nodes: LogicalNode[] | undefined;
  const current = (index: number): LogicalNode | undefined => (nodes ?? input)[index];
  const lookup: NodeLookup = (id) => {
    const index = topology.position.get(id);
    return index === undefined ? undefined : current(index);
  };
  const depths = new Map<number, number>();
  const settled: SettledDepth = (nodeId) => {
    const index = topology.position.get(nodeId);
    if (index === undefined) return 0;
    const depth = depths.get(index);
    // SAFETY: `position` indexes the nodes of this structure.
    return depth ?? restingDepth(current(index)!.state);
  };
  const queue = rankedQueue(topology.derivationRank);
  for (const index of changed) queue.push(index);
  const reached: number[] = [];
  for (let index = queue.pop(); index !== undefined; index = queue.pop()) {
    // SAFETY: every queued position indexes the nodes of this structure.
    const node = current(index)!;
    const { state, depth } = derivedState(node, topology.prerequisites[index] ?? [], lookup, settled);
    depths.set(index, depth);
    reached.push(index);
    if (!isDeepStrictEqual(state, node.state)) {
      nodes ??= [...input];
      nodes[index] = withNodeState(node, state);
    }
    // SAFETY: `base` shares the structure of `input`, so every queued position indexes it.
    const before = base[index]!;
    if (isDeepStrictEqual(state, before.state) && depth === restingDepth(before.state)) continue;
    for (const dependent of topology.dependents[index] ?? []) queue.push(dependent);
  }
  const output = nodes ?? input;
  return { nodes: output, frontier: advancedFrontier(derived, base, output, topology, reached) };
}

/** The frontier state of `nodes` from `derived`, the frontier state of
 *  `base`, with each reached position that entered or left the ready or
 *  skipped nodes inserted or removed. A position finds its place in the
 *  ready nodes by its stable rank, so a change costs the positions it
 *  reached and never reads the nodes that stay ready. */
function advancedFrontier(derived: FrontierState, base: readonly LogicalNode[], nodes: readonly LogicalNode[], topology: GraphTopology, reached: readonly number[]): FrontierState {
  const rank = (index: number) => topology.stableRank[index] ?? 0;
  let ready: number[] | undefined;
  let readyIds: string[] | undefined;
  let skipped: Set<number> | undefined;
  for (const index of reached) {
    // SAFETY: every reached position indexes `nodes` and `base`, which share a structure.
    const [node, before] = [nodes[index]!, base[index]!];
    const isReady = isReadyWork(node);
    if (isReady !== isReadyWork(before)) {
      ready ??= [...derived.ready];
      readyIds ??= [...derived.readyIds];
      const place = rankPlace(ready, rank, rank(index));
      if (isReady) {
        ready.splice(place, 0, index);
        readyIds.splice(place, 0, node.id);
      } else {
        ready.splice(place, 1);
        readyIds.splice(place, 1);
      }
    }
    if ((node.state._tag === "skipped") !== (before.state._tag === "skipped")) {
      skipped ??= new Set(derived.skipped);
      if (node.state._tag === "skipped") skipped.add(index);
      else skipped.delete(index);
    }
  }
  if (!ready && !skipped) return derived;
  return { ready: ready ?? derived.ready, readyIds: readyIds ?? derived.readyIds, skipped: skipped ?? derived.skipped };
}

/** The first place in `positions`, which ascend by `rank`, whose rank is not below `target`. */
function rankPlace(positions: readonly number[], rank: (index: number) => number, target: number): number {
  let [low, high] = [0, positions.length];
  while (low < high) {
    const middle = (low + high) >> 1;
    // SAFETY: `low <= middle < high <= positions.length`.
    if (rank(positions[middle]!) < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** The base derivation that `nodes` edits, with every position the edits
 *  changed since that derivation, or undefined when no derivation of the
 *  same structure precedes it. */
function editedDerivation(nodes: readonly LogicalNode[], topology: GraphTopology) {
  const changed = new Set<number>();
  for (let edited = nodes, edit = graphEdit(edited); edit; edited = edit.base, edit = graphEdit(edited)) {
    for (const index of edit.changed) changed.add(index);
    const derived = frontiers.get(edit.base);
    // A change of edges keeps the nodes array and builds a new structure,
    // under which the base's derivation does not hold.
    if (derived) return knownGraphTopology(edit.base) === topology ? { base: edit.base, derived, changed } : undefined;
  }
  return undefined;
}

/** A graph with a dependency cycle has no derivation order. Its states derive
 *  in whole-graph sweeps, each reading the states of the sweep before, until
 *  a sweep changes nothing; the node count bounds the sweeps. Structural
 *  admission refuses such a graph, so only the verifier's exploration of a
 *  defective graph reaches this. */
function cyclicDerivedNodes(input: readonly LogicalNode[], topology: GraphTopology): readonly LogicalNode[] {
  const previousSweep: SettledDepth = () => 0;
  const sweep = (current: readonly LogicalNode[]): readonly LogicalNode[] => {
    const lookup: NodeLookup = (id) => {
      const index = topology.position.get(id);
      return index === undefined ? undefined : current[index];
    };
    return current.map((node, index) => withNodeState(node, derivedState(node, topology.prerequisites[index] ?? [], lookup, previousSweep).state));
  };
  const unchanged = (before: readonly LogicalNode[], after: readonly LogicalNode[]): boolean =>
    after.every((node, position) => isDeepStrictEqual(node.state, before[position]?.state));
  let nodes = input;
  for (let count = 0; count <= input.length; count += 1) {
    const next = sweep(nodes);
    const settled = unchanged(nodes, next);
    nodes = next;
    if (settled) break;
  }
  return nodes;
}

/** The derived graph in stable graph order and what its derivation left. A
 *  graph that edits a derived graph of the same structure derives from its
 *  changed nodes; any other graph derives whole. */
function derivedGraph(graph: WorkflowGraph): DerivedGraph {
  const known = frontiers.get(graph.nodes);
  if (known) return { graph, frontier: known };
  const topology = graphTopology(graph);
  const { derivation } = topology;
  const edited = derivation === "cyclic" ? undefined : editedDerivation(graph.nodes, topology);
  if (edited && derivation !== "cyclic") {
    const advanced = advancedNodes(graph.nodes, { ...topology, derivation }, edited.base, edited.derived, edited.changed);
    return recorded(graph, advanced.nodes, advanced.frontier);
  }
  const derived = derivation === "cyclic" ? cyclicDerivedNodes(graph.nodes, topology) : derivedNodes(graph.nodes, topology, derivation);
  if (!topology.inStableOrder) {
    // A graph out of stable order derives once into stable order, whose
    // structure the next derivation builds.
    const nodes = topology.stable.flatMap((index) => derived[index] ?? []);
    return { graph: { ...graph, nodes }, frontier: frontierState(nodes, nodes.keys()) };
  }
  return recorded(graph, derived, frontierState(derived, topology.stable));
}

/** Records `frontier` for the derived nodes, which keep the structure of
 *  `graph`, and releases the edits that led to them. */
function recorded(graph: WorkflowGraph, nodes: readonly LogicalNode[], frontier: FrontierState): DerivedGraph {
  const next = nodes === graph.nodes ? graph : { ...graph, nodes };
  if (next !== graph) inheritGraphTopology(graph, next, []);
  frontiers.set(nodes, frontier);
  forgetGraphEdit(nodes);
  return { graph: next, frontier };
}

function capped(frontier: FrontierState, cap: number | null): readonly string[] {
  return cap === null || frontier.readyIds.length <= cap ? frontier.readyIds : frontier.readyIds.slice(0, cap);
}

/** Derive propagated node states and select the stable ready executable
 *  nodes, at most `cap` of them, or all of them when `cap` is null. A
 *  container is not work: a ready phase, list, item, or repeat opens in the same
 *  preparation sweep, so it never holds a frontier slot. The derived graph
 *  holds its nodes in stable graph order. */
export function calculateFrontier(graph: WorkflowGraph, cap: number | null): FrontierCalculation {
  if (cap !== null && (!Number.isInteger(cap) || cap < 1)) throw new RangeError("Workflow frontier cap must be a positive integer");
  const derived = derivedGraph(graph);
  return { graph: derived.graph, readyNodeIds: capped(derived.frontier, cap) };
}

/** The control with every node state derived again and its frontier. The
 *  frontier holds every ready node, or as many as the author's
 *  `max_parallel` admits. A node that derives as skipped, because its owner
 *  was skipped, skips each pending attempt it holds in the same transition,
 *  as a node that its own `if` skips does. */
export function refreshFrontier(control: CommittedWorkflowControl): CommittedWorkflowControl {
  const { graph, frontier } = derivedGraph(control.graph);
  const skipped = new Map([...frontier.skipped].flatMap((index) => {
    const node = graph.nodes[index];
    return node?.state._tag === "skipped" ? [[node.id, node.state.reason] as const] : [];
  }));
  const attempts = skipped.size === 0 ? control.attempts : control.attempts.map((attempt) => {
    const reason = attempt.state._tag === "pending" ? skipped.get(attempt.logicalNodeId) : undefined;
    return reason === undefined ? attempt : { ...attempt, state: { _tag: "skipped" as const, reason } };
  });
  return { ...control, graph, attempts, frontier: capped(frontier, control.guardrails.maxParallel ?? null) };
}

/** The number of attempts that run now. */
export function runningAttemptCount(control: CommittedWorkflowControl): number {
  return control.attempts.reduce((count, attempt) => attempt.state._tag === "running" ? count + 1 : count, 0);
}

/** The ready work nodes that no attempt runs on: the attempts that the
 *  author's `max_parallel` holds back once admission stops. */
export function waitingAttemptCount(control: Pick<CommittedWorkflowControl, "graph">): number {
  return control.graph.nodes.filter((node) => !isContainerNode(node) && node.state._tag === "ready").length
}

/** Whether the author's `max_parallel` admits one more running attempt. No
 *  cap applies by default. */
export function admitsAnotherAttempt(control: CommittedWorkflowControl): boolean {
  const { maxParallel } = control.guardrails;
  return maxParallel === undefined || runningAttemptCount(control) < maxParallel;
}

/** The next attempt to run: the first pending attempt of the first runnable
 *  node in graph order whose own attempt does not run now. Each logical node
 *  runs at most one attempt at a time, so a retry and a reassessment keep
 *  their order, while independent nodes and the items of a list each admit
 *  their own attempt. Graph order is the
 *  authored preorder, so the attempt array's order can never select a
 *  different worker. An explicit attempt id selects that attempt when its
 *  node is runnable and runs no other attempt. */
export function readyAttempt(control: CommittedWorkflowControl, explicitAttemptId?: string): Attempt | undefined {
  const busy = new Set(control.attempts.flatMap((attempt) => attempt.state._tag === "running" ? [attempt.logicalNodeId] : []));
  const runnable = control.graph.nodes
    .filter((node) => !isContainerNode(node) && !busy.has(node.id) && (node.state._tag === "ready" || node.state._tag === "running"))
    .toSorted((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  for (const node of runnable) {
    const selected = control.attempts.find((attempt) => attempt.state._tag === "pending" && attempt.logicalNodeId === node.id
      && (explicitAttemptId === undefined || attempt.id === explicitAttemptId));
    if (selected) return selected;
  }
  if (explicitAttemptId === undefined) return undefined;
  const explicit = control.attempts.find(({ id }) => id === explicitAttemptId);
  if (explicit !== undefined && busy.has(explicit.logicalNodeId)) {
    throw new Error(`Workflow invariant rejected attempt start "${explicitAttemptId}": its node "${explicit.logicalNodeId}" runs another attempt`);
  }
  throw new Error(`Workflow invariant rejected attempt start "${explicitAttemptId}": attempt is not ready`);
}

