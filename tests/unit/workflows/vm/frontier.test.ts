import { describe, expect, it } from "bun:test";
import type {
  GraphNodeState,
  LogicalNode,
  WorkflowGraph,
} from "../../../../src/workflows/vm/graph-types.js";
import { calculateFrontier, findDependencyCycles } from "../../../../src/workflows/vm/frontier.js";
import { replaceNode, withNodeState } from "../../../../src/workflows/vm/graph-changes.js";

const ownership = { _tag: "workflow", workflowDefinitionId: "workflow" } as const;

function node(id: string, order: number, state: GraphNodeState = { _tag: "pending" }): LogicalNode {
  return {
    kind: "agent",
    id,
    workflowDefinitionId: "workflow",
    order,
    ownership,
    state,
    definitionId: `step.${id}`,
    name: id,
    condition: null,
    retry: null,
  };
}

function graph(
  nodes: readonly LogicalNode[],
  dependencies: WorkflowGraph["dependencies"] = [],
  joins: WorkflowGraph["joins"] = [],
): WorkflowGraph {
  return { nodes, dependencies, joins, budgets: [] };
}

describe("deterministic workflow frontier", () => {
  it("uses stable graph order and applies the execution cap", () => {
    const input = graph([node("third", 2), node("first", 0), node("second", 1)]);

    expect(calculateFrontier(input, 1).readyNodeIds).toEqual(["first"]);
    expect(calculateFrontier(input, 2).readyNodeIds).toEqual(["first", "second"]);
    expect(calculateFrontier(input, 3)).toEqual(calculateFrontier(input, 3));
  });

  it("waits for dependsOn prerequisites, and a collect_all join gates no node", () => {
    const waiting = graph(
      [node("left", 0, { _tag: "completed" }), node("right", 1), node("join", 2)],
      [{ nodeId: "right", dependsOn: "left" }, { nodeId: "join", dependsOn: "left" }, { nodeId: "join", dependsOn: "right" }],
    );
    const first = calculateFrontier(waiting, 3);
    expect(first.readyNodeIds).toEqual(["right"]);
    expect(first.graph.nodes.find((candidate) => candidate.id === "join")?.state._tag).toBe("pending");

    const completed = graph(
      [node("left", 0, { _tag: "completed" }), node("right", 1, { _tag: "completed" }), node("join", 2)],
      waiting.dependencies,
    );
    expect(calculateFrontier(completed, 1).readyNodeIds).toEqual(["join"]);

    // The group that a join folds owns its branches, so the join is no
    // prerequisite: the named node is ready while the required ones wait.
    const folded = graph([node("pending-branch", 0), node("folder", 1)], [], [
      { kind: "collect_all", nodeId: "folder", requiredNodeIds: ["pending-branch"] },
    ]);
    expect(calculateFrontier(folded, 2).readyNodeIds).toEqual(["pending-branch", "folder"]);
  });

  it("reports dependency cycles in stable graph order", () => {
    const input = graph(
      [node("join", 2), node("last", 3), node("first", 0), node("second", 1)],
      [
        { nodeId: "last", dependsOn: "join" },
        { nodeId: "first", dependsOn: "second" },
        { nodeId: "second", dependsOn: "first" },
        { nodeId: "join", dependsOn: "last" },
      ],
    );

    expect(findDependencyCycles(input)).toEqual([
      { nodeIds: ["first", "second", "first"] },
      { nodeIds: ["join", "last", "join"] },
    ]);
  });

  it("propagates blocked state through dependency chains", () => {
    const result = calculateFrontier(graph(
      [node("failed", 0, { _tag: "failed", reason: "worker failed" }), node("child", 1), node("grandchild", 2)],
      [
        { nodeId: "child", dependsOn: "failed" },
        { nodeId: "grandchild", dependsOn: "child" },
      ],
    ), 1);

    expect(result.readyNodeIds).toEqual([]);
    expect(result.graph.nodes.map((candidate) => candidate.state._tag)).toEqual(["failed", "blocked", "blocked"]);
  });

  it("propagates cancellation and supersession", () => {
    const result = calculateFrontier(graph(
      [
        node("cancelled", 0, { _tag: "cancelled", reason: "operator", causedBy: [] }),
        node("cancelled-child", 1),
        node("superseded", 2, { _tag: "superseded", reason: "replanned", replacementNodeId: "replacement" }),
        node("superseded-child", 3),
      ],
      [
        { nodeId: "cancelled-child", dependsOn: "cancelled" },
        { nodeId: "superseded-child", dependsOn: "superseded" },
      ],
    ), 4);

    expect(result.graph.nodes.find((candidate) => candidate.id === "cancelled-child")?.state._tag).toBe("cancelled");
    expect(result.graph.nodes.find((candidate) => candidate.id === "superseded-child")?.state._tag).toBe("superseded");
  });

  it("gates a contained node on its owner before its prerequisites", () => {
    const phase = (state: GraphNodeState): LogicalNode => ({
      kind: "phase", id: "phase", workflowDefinitionId: "workflow", order: 0, ownership, state, phaseId: "build", name: "build", condition: null, join: null,
    });
    const child = (id: string, order: number): LogicalNode => ({
      ...node(id, order),
      ownership: { _tag: "phase", workflowDefinitionId: "workflow", phaseId: "build", parentNodeId: "phase" },
    });
    const children = (state: GraphNodeState) => {
      const result = calculateFrontier(graph([phase(state), child("left", 1), child("right", 2)]), 4);
      return [result.readyNodeIds, result.graph.nodes.slice(1).map(({ state: derived }) => derived._tag)];
    };

    // A ready phase is a container, not work, so it never enters the frontier.
    expect(children({ _tag: "pending" })).toEqual([[], ["pending", "pending"]]);
    expect(calculateFrontier(graph([phase({ _tag: "pending" })]), 1).readyNodeIds).toEqual([]);
    expect(children({ _tag: "running" })).toEqual([["left", "right"], ["ready", "ready"]]);
    expect(children({ _tag: "cancelled", reason: "operator", causedBy: [] })).toEqual([[], ["cancelled", "cancelled"]]);
    expect(children({ _tag: "superseded", reason: "replanned", replacementNodeId: "next" })).toEqual([[], ["superseded", "superseded"]]);
    expect(children({ _tag: "failed", reason: "child failed" })).toEqual([[], ["blocked", "blocked"]]);
    const orphan = calculateFrontier(graph([child("left", 1)]), 1).graph.nodes[0]?.state;
    expect(orphan).toMatchObject({ _tag: "blocked", causedBy: ["phase"] });
  });

  it("derives the same states as the round fixpoint it replaced over flat graphs", () => {
    const random = seeded(0x5eed);
    const states: readonly GraphNodeState[] = [
      { _tag: "pending" }, { _tag: "pending" }, { _tag: "pending" }, { _tag: "ready" }, { _tag: "running" },
      { _tag: "completed" }, { _tag: "completed" }, { _tag: "failed", reason: "f" },
      { _tag: "blocked", reason: "b", causedBy: [] }, { _tag: "cancelled", reason: "c", causedBy: [] },
      { _tag: "superseded", reason: "s", replacementNodeId: "r" },
    ];
    const graphs: WorkflowGraph[] = [];
    for (let sample = 0; sample < 400; sample += 1) {
      const size = 1 + Math.floor(random() * 12);
      const ids = Array.from({ length: size }, (_, index) => `n${index}`);
      // Shuffled orders prove the derivation does not lean on the array order.
      const orders = ids.map((_, index) => index).sort(() => random() - 0.5);
      const nodes = ids.map((id, index) => node(id, orders[index] ?? index, states[Math.floor(random() * states.length)]));
      const dependencies: { nodeId: string; dependsOn: string }[] = [];
      for (const [index, id] of ids.entries()) {
        for (let other = 0; other < size; other += 1) {
          // Mostly earlier nodes, so most samples are acyclic; a few edges
          // point later and close cycles, and a few name a missing node.
          const roll = random();
          if (other < index && roll < 0.3) dependencies.push({ nodeId: id, dependsOn: ids[other] ?? id });
          else if (other > index && roll < 0.03) dependencies.push({ nodeId: id, dependsOn: ids[other] ?? id });
        }
        if (random() < 0.05) dependencies.push({ nodeId: id, dependsOn: "missing" });
        const [required, ...more] = ids.slice(0, index - 1);
        // A historical all-required join replays as these dependency edges.
        if (required !== undefined && random() < 0.1) dependencies.push(...[required, ...more].map((dependsOn) => ({ nodeId: id, dependsOn })));
      }
      graphs.push(graph(nodes, dependencies));
    }
    expect(graphs.some((candidate) => findDependencyCycles(candidate).length > 0)).toBe(true);
    for (const candidate of graphs) {
      for (const cap of [1, 3]) expect(calculateFrontier(candidate, cap)).toEqual(roundFixpointFrontier(candidate, cap));
    }
  });

  it("derives an edited graph from the nodes that the edits reach to the states that a whole derivation finds", () => {
    const random = seeded(0xed17);
    const states: readonly GraphNodeState[] = [
      { _tag: "pending" }, { _tag: "ready" }, { _tag: "running" }, { _tag: "completed" }, { _tag: "skipped", reason: "s", causedBy: [] },
      { _tag: "failed", reason: "f" }, { _tag: "cancelled", reason: "c", causedBy: [] }, { _tag: "superseded", reason: "s", replacementNodeId: "r" },
    ];
    const pick = <T,>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
    for (let sample = 0; sample < 200; sample += 1) {
      const size = 2 + Math.floor(random() * 10);
      const nodes: LogicalNode[] = [];
      const dependencies: { nodeId: string; dependsOn: string }[] = [];
      for (let index = 0; index < size; index += 1) {
        const id = `n${index}`;
        // An earlier phase can own a node, so a change reaches owned nodes as well as successors.
        const owner = nodes.filter(({ kind }) => kind === "phase").find(() => random() < 0.4);
        const base = node(id, index, pick(states));
        const owned = owner ? { ...base, ownership: { _tag: "phase" as const, workflowDefinitionId: "workflow", phaseId: owner.id, parentNodeId: owner.id } } : base;
        nodes.push(random() < 0.25
          ? { kind: "phase", id, workflowDefinitionId: "workflow", order: index, ownership: owned.ownership, state: owned.state, phaseId: id, name: id, condition: null, join: null }
          : owned);
        for (let other = 0; other < index; other += 1) if (random() < 0.3) dependencies.push({ nodeId: id, dependsOn: `n${other}` });
      }
      let current = calculateFrontier(graph(nodes, dependencies), null).graph;
      for (let edit = 0; edit < 6; edit += 1) {
        const edited = replaceNode({ graph: current }, pick(current.nodes).id, (candidate) => withNodeState(candidate, pick(states))).graph;
        const advanced = calculateFrontier(edited, 3);
        // A copy of the nodes carries no edit, so it derives whole.
        expect(advanced).toEqual(calculateFrontier({ ...edited, nodes: [...edited.nodes] }, 3));
        current = advanced.graph;
      }
    }
  });

  it("derives a node's edit from the nodes it reaches, whatever the size of the graph", () => {
    /** The reads of the state and the id of every other node that deriving
     *  the frontier makes after one node starts and after it returns to
     *  ready, which removes it from the ordered ready nodes and inserts it. */
    const readsOfOthers = (size: number) => {
      let reads = 0;
      const nodes = Array.from({ length: size }, (_, index): LogicalNode => {
        const plain = node(`n${index}`, index, { _tag: "ready" });
        if (index === 0) return plain;
        return Object.defineProperties({ ...plain }, {
          state: { get: () => { reads += 1; return plain.state; }, enumerable: true },
          id: { get: () => { reads += 1; return plain.id; }, enumerable: true },
        });
      });
      const ids = Array.from({ length: size }, (_, index) => `n${index}`);
      const derived = calculateFrontier(graph(nodes), null).graph;
      reads = 0;
      const started = calculateFrontier(replaceNode({ graph: derived }, "n0", (candidate) => withNodeState(candidate, { _tag: "running" })).graph, null);
      const returned = calculateFrontier(replaceNode({ graph: started.graph }, "n0", (candidate) => withNodeState(candidate, { _tag: "ready" })).graph, 3);
      const counted = reads;
      expect(started.readyNodeIds).toEqual(ids.slice(1));
      expect(returned.readyNodeIds).toEqual(ids.slice(0, 3));
      return counted;
    };
    expect(readsOfOthers(200)).toBe(readsOfOthers(20));
  });
});

/** A small deterministic generator, so a failing sample reproduces. */
function seeded(seed: number): () => number {
  // Park and Miller's minimal standard generator stays exact in doubles.
  let state = seed % 2147483647 || 1;
  return () => {
    state = (state * 48271) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

// The frontier derivation before phase containers, copied verbatim: a
// whole-graph round repeated until no state changes. A workflow-owned flat
// graph must derive exactly the same states through the topological pass.
function roundFixpointFrontier(input: WorkflowGraph, cap: number): ReturnType<typeof calculateFrontier> {
  const compare = (a: LogicalNode, b: LogicalNode): number => a.order - b.order || a.id.localeCompare(b.id);
  const stableNodes = [...input.nodes].sort(compare);
  const order = new Map(stableNodes.map((candidate, index) => [candidate.id, index]));
  const prerequisites = new Map<string, string[]>();
  for (const candidate of stableNodes) prerequisites.set(candidate.id, []);
  for (const edge of input.dependencies) prerequisites.get(edge.nodeId)?.push(edge.dependsOn);
  for (const join of input.joins) prerequisites.get(join.nodeId)?.push(...join.requiredNodeIds);
  for (const ids of prerequisites.values()) {
    const unique = [...new Set(ids)];
    unique.sort((a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b));
    ids.splice(0, ids.length, ...unique);
  }
  const derive = (candidate: LogicalNode, required: readonly string[], byId: ReadonlyMap<string, LogicalNode>): GraphNodeState => {
    if (candidate.state._tag !== "pending" && candidate.state._tag !== "ready") return candidate.state;
    const resolved = required.map((id) => byId.get(id));
    const missing = required.filter((_, index) => resolved[index] === undefined);
    if (missing.length > 0) return { _tag: "blocked", reason: "Missing required dependency", causedBy: missing };
    const superseded = resolved.find((dependency) => dependency?.state._tag === "superseded");
    if (superseded?.state._tag === "superseded") {
      return { _tag: "superseded", reason: "A required dependency was superseded", replacementNodeId: superseded.state.replacementNodeId };
    }
    const cancelled = resolved.filter((dependency) => dependency?.state._tag === "cancelled");
    if (cancelled.length > 0) {
      return { _tag: "cancelled", reason: "A required dependency was cancelled", causedBy: cancelled.map((dependency) => dependency?.id).filter((id) => id !== undefined) };
    }
    const blocked = resolved.filter((dependency) => dependency?.state._tag === "blocked" || dependency?.state._tag === "failed");
    if (blocked.length > 0) {
      return { _tag: "blocked", reason: "A required dependency cannot complete", causedBy: blocked.map((dependency) => dependency?.id).filter((id) => id !== undefined) };
    }
    return resolved.every((dependency) => dependency?.state._tag === "completed") ? { _tag: "ready" } : { _tag: "pending" };
  };
  let nodes = stableNodes;
  for (let pass = 0; pass <= nodes.length; pass += 1) {
    const byId = new Map(nodes.map((candidate) => [candidate.id, candidate]));
    const next = nodes.map((candidate) => withNodeState(candidate, derive(candidate, prerequisites.get(candidate.id) ?? [], byId)));
    let unchanged = true;
    for (const [index, candidate] of next.entries()) {
      if (JSON.stringify(candidate.state) !== JSON.stringify(nodes[index]?.state)) {
        unchanged = false;
        break;
      }
    }
    nodes = next;
    if (unchanged) break;
  }
  return {
    graph: { ...input, nodes },
    readyNodeIds: nodes.filter((candidate) => candidate.state._tag === "ready").slice(0, cap).map((candidate) => candidate.id),
  };
}
