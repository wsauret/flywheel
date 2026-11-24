import type { WorkflowGraph } from "./graph-types.js";

// The run-before order of a compiled graph. Expansion freezes the context
// that a list's items share from the nodes that complete before the list
// starts, and a rerun on resume waits for the changed work before it.

function pushInto(index: Map<string, string[]>, key: string, value: string): void {
  const known = index.get(key);
  if (known) known.push(value);
  else index.set(key, [value]);
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
