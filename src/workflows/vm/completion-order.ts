import type { WorkflowGraph } from "./graph-types.js";

// The run-before order of a compiled graph. Expansion freezes the context
// that a list's items share from the nodes that complete before the list
// starts, and the verifier proves that every source completes before its
// reader.

/** Whether one node completes before another can start: the relation of
 *  {@link completedBefore}, answered for many pairs of one graph. The
 *  verifier asks it once for each source, so it costs one pass over the
 *  graph for each distinct earlier node, not one for each question. */
export type CompletesBefore = (earlierId: string, laterId: string) => boolean;

/** The {@link CompletesBefore} relation of one graph. A node starts after
 *  `earlier` completes when it, or a container that owns it, depends on a
 *  node that holds `earlier` or that itself starts after it; a container
 *  that holds such a node completes after it too. */
export function completionOrder(graph: WorkflowGraph): CompletesBefore {
  const owner = new Map<string, string>();
  const owned = new Map<string, string[]>();
  for (const node of graph.nodes) {
    if (node.ownership._tag === "workflow") continue;
    owner.set(node.id, node.ownership.parentNodeId);
    pushInto(owned, node.ownership.parentNodeId, node.id);
  }
  const dependents = new Map<string, string[]>();
  for (const edge of graph.dependencies) pushInto(dependents, edge.dependsOn, edge.nodeId);
  const startsAfter = new Map<string, ReadonlySet<string>>();
  return (earlierId, laterId) => {
    let later = startsAfter.get(earlierId);
    if (later === undefined) {
      later = nodesStartingAfter(earlierId, owner, owned, dependents);
      startsAfter.set(earlierId, later);
    }
    return later.has(laterId);
  };
}

function pushInto(index: Map<string, string[]>, key: string, value: string): void {
  const known = index.get(key);
  if (known) known.push(value);
  else index.set(key, [value]);
}

/** The least fixed point of two facts: a node holds `earlier` once it is
 *  `earlier`, starts after it, or owns a node that holds it; a node starts
 *  after it once it depends on a holder or its owner starts after it. */
function nodesStartingAfter(earlierId: string, owner: ReadonlyMap<string, string>, owned: ReadonlyMap<string, readonly string[]>, dependents: ReadonlyMap<string, readonly string[]>): ReadonlySet<string> {
  const holds = new Set<string>();
  const after = new Set<string>();
  const pending: { readonly id: string; readonly fact: "holds" | "after" }[] = [{ id: earlierId, fact: "holds" }];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { id, fact } = next;
    if (fact === "holds") {
      if (holds.has(id)) continue;
      holds.add(id);
      const parent = owner.get(id);
      if (parent !== undefined) pending.push({ id: parent, fact: "holds" });
      for (const dependent of dependents.get(id) ?? []) pending.push({ id: dependent, fact: "after" });
    } else {
      if (after.has(id)) continue;
      after.add(id);
      pending.push({ id, fact: "holds" });
      for (const child of owned.get(id) ?? []) pending.push({ id: child, fact: "after" });
    }
  }
  return after;
}

/** The nodes that complete before `targetId` can start: the prerequisites
 *  of the target and of each container that owns it, every node those
 *  prerequisites own, and the same again for each prerequisite. */
export function completedBefore(graph: WorkflowGraph, targetId: string): ReadonlySet<string> {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const prerequisites = new Map<string, string[]>();
  for (const edge of graph.dependencies) pushInto(prerequisites, edge.nodeId, edge.dependsOn);
  const owned = new Map<string, string[]>();
  for (const node of graph.nodes) {
    if (node.ownership._tag !== "workflow") pushInto(owned, node.ownership.parentNodeId, node.id);
  }
  const done = new Set<string>();
  const addSubtree = (id: string): void => {
    if (done.has(id)) return;
    done.add(id);
    for (const child of owned.get(id) ?? []) addSubtree(child);
    chain(id);
  };
  const seenChains = new Set<string>();
  const chain = (id: string): void => {
    for (let current = byId.get(id); current !== undefined && !seenChains.has(current.id);) {
      seenChains.add(current.id);
      for (const prerequisite of prerequisites.get(current.id) ?? []) addSubtree(prerequisite);
      current = current.ownership._tag === "workflow" ? undefined : byId.get(current.ownership.parentNodeId);
    }
  };
  chain(targetId);
  return done;
}
