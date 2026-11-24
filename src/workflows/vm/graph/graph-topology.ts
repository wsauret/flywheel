import type { LogicalNode, WorkflowGraph } from "./graph-types.js";

/** The structure of one graph: where each node sits, what each node owns,
 *  what each node requires, which nodes read each node's state, and the
 *  order in which node states derive. A change of node states keeps it, so
 *  a transition reads the structure that an earlier transition built, and
 *  only a change that adds a node or an edge builds it again. Each entry
 *  names a node by its position in `graph.nodes`. */
export interface GraphTopology {
  /** The position of the node with each id. */
  readonly position: ReadonlyMap<string, number>;
  /** The positions of the nodes that each node owns directly, in `order`. */
  readonly owned: ReadonlyMap<string, readonly number[]>;
  /** Every position in stable graph order: by `order`, then by id. */
  readonly stable: readonly number[];
  /** The place of each position in `stable`. */
  readonly stableRank: readonly number[];
  /** Whether `graph.nodes` is in stable graph order already. */
  readonly inStableOrder: boolean;
  /** The ids that each node requires, by position, without repeats, in
   *  stable graph order. An id that names no node stays, so the derivation
   *  can block on it. A join is not a prerequisite: the list node it folds
   *  owns the items it requires, and that node settles only when its join
   *  folds. A successor of a phase over a list depends on that node. */
  readonly prerequisites: readonly (readonly string[])[];
  /** The positions whose derivation reads each node's state, by position:
   *  the nodes that require it and the nodes that it owns. */
  readonly dependents: readonly (readonly number[])[];
  /** Every position after its owner and its prerequisites, or "cyclic" for
   *  a graph with a dependency cycle, which has no such order. */
  readonly derivation: readonly number[] | "cyclic";
  /** The place of each position in `derivation`, empty for a cyclic graph. */
  readonly derivationRank: readonly number[];
}

/** The node edits that made one nodes array from another of the same
 *  structure: the positions whose nodes differ. */
export interface GraphEdit {
  readonly base: readonly LogicalNode[];
  readonly changed: readonly number[];
}

interface KnownGraph {
  readonly dependencies: WorkflowGraph["dependencies"];
  readonly topology: GraphTopology;
}

// Control is immutable: a changed graph is a new nodes array, so a topology
// keyed by the array it read can never describe a different structure.
const topologies = new WeakMap<readonly LogicalNode[], KnownGraph>();
// An edit holds its base only until a derivation of the edited array is
// recorded (`forgetGraphEdit`), so a chain of edits never outlives the next
// derivation.
const edits = new WeakMap<readonly LogicalNode[], GraphEdit>();

function ownerOf(node: LogicalNode): string | null {
  return node.ownership._tag === "workflow" ? null : node.ownership.parentNodeId;
}

/** Whether a node edit keeps the graph's structure: the node keeps its id,
 *  its place in graph order, and its owner. */
export function keepsStructure(before: LogicalNode, after: LogicalNode): boolean {
  return before.id === after.id && before.order === after.order && ownerOf(before) === ownerOf(after);
}

/** The structure of `graph`, built once for each structure. */
export function graphTopology(graph: Pick<WorkflowGraph, "nodes" | "dependencies">): GraphTopology {
  const known = topologies.get(graph.nodes);
  if (known?.dependencies === graph.dependencies) return known.topology;
  const topology = buildTopology(graph);
  topologies.set(graph.nodes, { dependencies: graph.dependencies, topology });
  return topology;
}

/** The structure last built or inherited for `nodes`, without building one. */
export function knownGraphTopology(nodes: readonly LogicalNode[]): GraphTopology | undefined {
  return topologies.get(nodes)?.topology;
}

/** Record that `next` has the structure of `previous` and differs from it
 *  only in the nodes at `changed`. The caller changed node states, or made
 *  a copy: every node of `next` sits where it sat in `previous`,
 *  `keepsStructure` holds for it, and the dependencies of `next` are those
 *  of `previous` or a copy of them. A strict decode copies every node, so
 *  the copy names no change and keeps what was known of its source. */
export function inheritGraphTopology(previous: Pick<WorkflowGraph, "nodes" | "dependencies">, next: Pick<WorkflowGraph, "nodes" | "dependencies">, changed: readonly number[]): void {
  const known = topologies.get(previous.nodes);
  if (known?.dependencies !== previous.dependencies) return;
  topologies.set(next.nodes, { dependencies: next.dependencies, topology: known.topology });
  if (next.nodes !== previous.nodes) edits.set(next.nodes, { base: previous.nodes, changed });
}

/** The edit that made `nodes`, if `inheritGraphTopology` recorded one. */
export function graphEdit(nodes: readonly LogicalNode[]): GraphEdit | undefined {
  return edits.get(nodes);
}

/** Release the base of the edit that made `nodes`. */
export function forgetGraphEdit(nodes: readonly LogicalNode[]): void {
  edits.delete(nodes);
}

function buildTopology({ nodes, dependencies }: Pick<WorkflowGraph, "nodes" | "dependencies">): GraphTopology {
  const position = new Map<string, number>();
  const owned = new Map<string, number[]>();
  for (const [index, node] of nodes.entries()) {
    if (!position.has(node.id)) position.set(node.id, index);
    const owner = ownerOf(node);
    if (owner === null) continue;
    const siblings = owned.get(owner);
    if (siblings) siblings.push(index);
    else owned.set(owner, [index]);
  }
  const orderAt = (index: number): number => nodes[index]?.order ?? Number.MAX_SAFE_INTEGER;
  for (const siblings of owned.values()) siblings.sort((left, right) => orderAt(left) - orderAt(right));
  const stable = nodes.map((_, index) => index).sort((left, right) =>
    orderAt(left) - orderAt(right) || (nodes[left]?.id ?? "").localeCompare(nodes[right]?.id ?? ""));
  const rank = new Map(stable.map((index, place) => [nodes[index]?.id, place]));
  const required = nodes.map(() => new Set<string>());
  for (const edge of dependencies) {
    const index = position.get(edge.nodeId);
    if (index !== undefined) required[index]?.add(edge.dependsOn);
  }
  const prerequisites = required.map((ids) => [...ids].sort((left, right) =>
    (rank.get(left) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right) ?? Number.MAX_SAFE_INTEGER) || left.localeCompare(right)));
  const dependents = nodes.map((): number[] => []);
  for (const [index, ids] of prerequisites.entries()) {
    for (const id of ids) {
      const input = position.get(id);
      if (input !== undefined) dependents[input]?.push(index);
    }
  }
  for (const [owner, children] of owned) {
    const index = position.get(owner);
    if (index !== undefined) dependents[index]?.push(...children);
  }
  const derivation = derivationOrder(nodes, position, stable, prerequisites);
  return {
    position, owned, stable, prerequisites, dependents, derivation,
    stableRank: placesOf(stable),
    inStableOrder: stable.every((index, place) => index === place),
    derivationRank: derivation === "cyclic" ? [] : placesOf(derivation),
  };
}

/** The place of each position in `order`. */
function placesOf(order: readonly number[]): number[] {
  const places = Array.from(order, () => 0);
  for (const [place, index] of order.entries()) places[index] = place;
  return places;
}

function derivationOrder(
  nodes: readonly LogicalNode[],
  position: ReadonlyMap<string, number>,
  stable: readonly number[],
  prerequisites: readonly (readonly string[])[],
): readonly number[] | "cyclic" {
  const state = new Map<number, "visiting" | "done">();
  const ordered: number[] = [];
  let cyclic = false;
  const visit = (index: number): void => {
    const seen = state.get(index);
    if (seen === "done") return;
    if (seen === "visiting") {
      cyclic = true;
      return;
    }
    state.set(index, "visiting");
    // SAFETY: every index comes from `stable` or `position`, which index `nodes`.
    const owner = ownerOf(nodes[index]!);
    for (const id of [...owner === null ? [] : [owner], ...prerequisites[index] ?? []]) {
      const input = position.get(id);
      if (input !== undefined) visit(input);
    }
    state.set(index, "done");
    ordered.push(index);
  };
  for (const index of stable) visit(index);
  return cyclic ? "cyclic" : ordered;
}
