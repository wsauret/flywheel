import { Array as Arr } from "effect";
import type { CommittedWorkflowControl } from "./committed-control.js";
import type { Attempt, ExpansionChange, LogicalNode, RetryControl, WorkflowOwnership } from "./graph-types.js";
import type {
  AllRequiredJoinV3, AttemptV3, AttemptV8, ControlV10, ControlV3, ControlV4, ControlV5, ControlV6, ControlV7, ControlV8, ControlV9,
  ExpansionChangeV8, GraphChangeV5, GraphV3, GraphV4, GraphV8, HistoricalWorkflowControlV2, LogicalNodeV3, LogicalNodeV8, OwnershipV3, OwnershipV8,
} from "./historical-codecs.js";
import { collectOutput } from "../reducers/collect.js";
import { coverageOutput } from "../reducers/coverage.js";
import type { FieldMap } from "../output-contract/grammar.js";

// The one pure normalization of each strictly decoded historical control to
// control version 11. Every graph before version 8 first maps to
// graph version 8, the last graph before phases, and graph version 8 then
// maps to the graph of control version 11. Every stored id stays, so a
// resumed run keeps its node ids. The frozen wire contracts that decode the
// stored bytes are in `historical-codecs.ts`.

/** Map an ownership of graph version 3 to an ownership of graph version 8.
 *  No producer ever wrote a `task` owner. Its meaning, work owned by the
 *  container node `parentNodeId`, is what a `phase` owner states, so it reads
 *  as one. */
function normalizeOwnershipV3(ownership: OwnershipV3): OwnershipV8 {
  if (ownership._tag !== "task") return ownership;
  const { workflowDefinitionId, phaseId, parentNodeId } = ownership;
  return { _tag: "phase", workflowDefinitionId, phaseId, parentNodeId };
}

/** Map an ownership of graph version 8 to the ownership of control version
 *  11: a group owns its items as a list, a branch owns its agents as an
 *  item, and a loop over a map owns each round's group as a repeat owns its
 *  round. */
function normalizeOwnershipV8(ownership: OwnershipV8): WorkflowOwnership {
  switch (ownership._tag) {
    case "workflow":
    case "phase": return ownership;
    case "group": return { _tag: "list", workflowDefinitionId: ownership.workflowDefinitionId, outputId: ownership.mapId, parentNodeId: ownership.parentNodeId };
    case "branch": return { _tag: "item", workflowDefinitionId: ownership.workflowDefinitionId, outputId: ownership.mapId, key: ownership.key, parentNodeId: ownership.parentNodeId };
    case "rounds": return { _tag: "round", workflowDefinitionId: ownership.workflowDefinitionId, parentNodeId: ownership.parentNodeId, round: ownership.round };
  }
}

function normalizeRetryV8(retry: { readonly maxIterations: number; readonly detectStuck: boolean } | null): RetryControl | null {
  return retry === null ? null : { max: retry.maxIterations, stuck: retry.detectStuck };
}

/** Map one node of graph version 8 to the node of control version 11. A
 *  step is an agent that keeps its `then` chain as a history arm, a group is
 *  a list whose phases share the group's one retry, a branch is an item, and
 *  a loop over a map is a repeat whose round 1 body is the group of its
 *  first round. `while` and `for` keep their history arms. */
function normalizeLogicalNodeV8(node: LogicalNodeV8): LogicalNode {
  const ownership = normalizeOwnershipV8(node.ownership);
  switch (node.kind) {
    case "step": {
      const { then, retry, ...rest } = node;
      return { ...rest, ownership, retry: normalizeRetryV8(retry), condition: null, ...(then === null ? {} : { followUpV10: then }), kind: "agent" };
    }
    case "while":
    case "for": return { ...node, ownership };
    case "branch": return { ...node, ownership, kind: "item" };
    case "phase": return { ...node, ownership, condition: null, join: null };
    case "group": {
      const { mapId, stages, retry, ...rest } = node;
      return {
        ...rest,
        kind: "list",
        ownership,
        outputId: mapId,
        phases: Arr.map(stages, ({ step, name }): ListPhase => ({ definitionId: step, name, retry: normalizeRetryV8(retry) })),
        condition: null,
      };
    }
    case "rounds": {
      const { mapId, field, maxIterations, ...rest } = node;
      return {
        ...rest,
        kind: "repeat",
        ownership,
        name: mapId,
        loop: { _tag: "while", evaluator: `${node.id}:round:1`, field, max: maxIterations, stuck: false, priorSignal: null },
      };
    }
  }
}

type ListPhase = Extract<LogicalNode, { readonly kind: "list" }>["phases"][number];

/** Map one logical node of graph version 3 to the node of control version
 *  11. Every node kind of version 3 is also a kind of version 8. */
export function normalizeLogicalNodeV3(node: LogicalNodeV3): LogicalNode {
  return normalizeLogicalNodeV8({ ...node, ownership: normalizeOwnershipV3(node.ownership) });
}

/** Map the provenance of an attempt of graph version 8: a `while` round and
 *  a `for` item each name their round, a `then` follow-up keeps its history
 *  tag, and a branch's stage names its item. */
function normalizeProvenanceV8(attempt: AttemptV8): Attempt["provenance"] {
  const { provenance } = attempt;
  switch (provenance._tag) {
    case "authored":
    case "retry":
    case "reassessment": return provenance;
    case "while": return { _tag: "round", index: attempt.iteration };
    case "for": return { _tag: "round", index: provenance.itemIndex + 1 };
    case "then": return { _tag: "followUpV10" };
    case "branch": return { _tag: "item", ordinal: provenance.ordinal };
  }
}

function normalizeAttemptV8(attempt: AttemptV8): Attempt {
  const { forItem, ...rest } = attempt;
  return { ...rest, ownership: normalizeOwnershipV8(attempt.ownership), provenance: normalizeProvenanceV8(attempt), item: forItem };
}

/** The dependency edges that stand for `all_required` joins. Such a join
 *  made its node wait for every required node, which is what a dependency
 *  edge states, and the current join is the fan-in of a list only. No
 *  producer wrote one, so the edges keep the stored meaning. An edge that the
 *  graph already states is not repeated. */
export function allRequiredJoinEdges(
  dependencies: GraphV8["dependencies"],
  joins: readonly (AllRequiredJoinV3)[],
): GraphV8["dependencies"] {
  const edges = [...dependencies];
  for (const join of joins) {
    for (const dependsOn of join.requiredNodeIds) {
      if (!edges.some((edge) => edge.nodeId === join.nodeId && edge.dependsOn === dependsOn)) edges.push({ nodeId: join.nodeId, dependsOn });
    }
  }
  return edges;
}

/** Map graph version 3 to graph version 8. The counter budgets of version 3
 *  had no producer and no reader, and a later budget states declared limits
 *  that version 3 cannot express, so a version 3 budget has no meaning and
 *  reads as absent. */
function normalizeGraphV3(graph: GraphV3): GraphV8 {
  return {
    nodes: graph.nodes.map((node) => ({ ...node, ownership: normalizeOwnershipV3(node.ownership) })),
    dependencies: allRequiredJoinEdges(graph.dependencies, graph.joins),
    joins: [],
    budgets: [],
  };
}

/** Map graph version 4 to graph version 8. Every node, owner, and budget of
 *  version 4 is also one of version 8. */
function normalizeGraphV4(graph: GraphV4): GraphV8 {
  return {
    nodes: graph.nodes,
    dependencies: allRequiredJoinEdges(graph.dependencies, graph.joins),
    joins: [],
    budgets: graph.budgets,
  };
}

function normalizeAttemptsV3(attempts: readonly (AttemptV3)[]): readonly AttemptV8[] {
  return attempts.map((attempt) => ({ ...attempt, ownership: normalizeOwnershipV3(attempt.ownership) }));
}

/** Normalize a strictly decoded v2 root control, without changing its bytes. */
export function normalizeHistoricalWorkflowControl(control: HistoricalWorkflowControlV2): CommittedWorkflowControl {
  const { issues: _issues, seals: _seals, graph, attempts, followUp, ...rest } = control;
  return normalizeWorkflowControlV10({
    ...rest,
    graph: normalizeGraphV3(graph),
    attempts: normalizeAttemptsV3(attempts),
    followUp: followUp === null ? null : {
      conversationId: followUp.conversationId,
      requestSequence: followUp.requestSequence,
      identity: { kind: "historical" },
      pendingInput: followUp.pendingPrompt === null ? null : { text: followUp.pendingPrompt },
    },
  });
}

/** Normalize a strictly decoded v3 root control: the inert lists drop out. */
export function normalizeWorkflowControlV3(control: ControlV3): CommittedWorkflowControl {
  const { issues: _issues, seals: _seals, ...rest } = control;
  return normalizeWorkflowControlV4(rest);
}

/** Normalize a strictly decoded v4 root control. */
export function normalizeWorkflowControlV4(control: ControlV4): CommittedWorkflowControl {
  const { graph, attempts, ...rest } = control;
  return normalizeWorkflowControlV10({ ...rest, graph: normalizeGraphV3(graph), attempts: normalizeAttemptsV3(attempts) });
}

/** Normalize a strictly decoded v5 root control. */
export function normalizeWorkflowControlV5(control: ControlV5): CommittedWorkflowControl {
  return normalizeWorkflowControlV10({ ...control, graph: normalizeGraphV4(control.graph) });
}

/** The output contract that a group of graph version 5 folds against. Only
 *  `collect@1` and `coverage@1` existed before control pinned the contract,
 *  and neither reads a contract around its join, so each converts to exactly
 *  the contract that compilation pins today. Remove after 2026-12-15. */
function unpinnedJoinContract({ id, version }: { readonly id: string; readonly version: number }, width: number): FieldMap {
  if (id === "collect" && version === 1) return collectOutput(width);
  if (id === "coverage" && version === 1) return coverageOutput(width);
  throw new Error(`Workflow invariant rejected stored group reducer "${id}@${version}" without a pinned output contract`);
}

/** Normalize a strictly decoded v6 root control: each group pins the output
 *  contract of its reducer. Remove after 2026-12-15. */
export function normalizeWorkflowControlV6(control: ControlV6): CommittedWorkflowControl {
  const nodes = control.graph.nodes.map((node): LogicalNodeV8 => node.kind === "group"
    ? { ...node, reducer: { ...node.reducer, contract: unpinnedJoinContract(node.reducer, node.width) } }
    : node);
  return normalizeWorkflowControlV10({ ...control, graph: { ...control.graph, nodes } });
}

/** Normalize a strictly decoded v7 root control. Graph version 6 is a
 *  subset of graph version 8. Remove after 2027-01-10. */
export function normalizeWorkflowControlV7(control: ControlV7): CommittedWorkflowControl {
  return normalizeWorkflowControlV10(control);
}

/** Normalize a strictly decoded v8 root control. Graph version 7 widens to
 *  graph version 8, and a run before `max_parallel` declared no cap, so it
 *  admits every ready attempt at once, as a run without the key does.
 *  Remove after 2027-04-10. */
export function normalizeWorkflowControlV8(control: ControlV8): CommittedWorkflowControl {
  return normalizeWorkflowControlV10(control);
}

/** Normalize a strictly decoded v9 root control. Graph version 7 widens to
 *  graph version 8: a group without `votes` runs one lane for each item,
 *  which is what every group of a root before votes means. Remove after
 *  2027-04-14. */
export function normalizeWorkflowControlV9(control: ControlV9): CommittedWorkflowControl {
  return normalizeWorkflowControlV10(control);
}

/** Normalize a strictly decoded v10 root control, the last control before
 *  phases, to control version 11: each node and attempt takes its
 *  version 11 kind, owner, and provenance (refer to
 *  {@link normalizeLogicalNodeV8}), and the guardrails take their version 11
 *  names. Every stored id stays, so a resumed run keeps its node ids, and a
 *  `then` chain, a `while`, a `for`, a loop over a map, a shared stage
 *  retry, and a phase budget each run through their history arm. Remove
 *  after 2027-04-30. */
export function normalizeWorkflowControlV10(control: ControlV10): CommittedWorkflowControl {
  const { graph: { budgets, ...graph }, attempts, guardrails, ...rest } = control;
  const { maxQueueLength, maxSessionInserts, sessionInsertsUsed, ...kept } = guardrails;
  return {
    ...rest,
    // An empty list of budgets declares no limit, which a graph of control
    // version 11 states by holding no budgets.
    graph: { ...graph, nodes: graph.nodes.map(normalizeLogicalNodeV8), ...(budgets.length === 0 ? {} : { budgets }) },
    attempts: attempts.map(normalizeAttemptV8),
    guardrails: { ...kept, maxAttempts: maxQueueLength, maxInserts: maxSessionInserts, insertsUsed: sessionInsertsUsed },
  };
}

/** Normalize one change of a stored `group.expanded@1` or `group.expanded@2`
 *  to the change of control version 11. History only; remove after
 *  2027-04-30. */
export function normalizeExpansionChangeV8(change: ExpansionChangeV8 | GraphChangeV5): ExpansionChange {
  switch (change.kind) {
    case "add_node": {
      const stored = change.node;
      if (stored.kind !== "branch" && stored.kind !== "step") throw new Error(`Workflow invariant rejected stored expansion node "${stored.id}", which is neither a branch nor its stage`);
      const node = normalizeLogicalNodeV8(stored);
      if ((node.kind !== "item" || node.ownership._tag !== "list") && (node.kind !== "agent" || node.ownership._tag !== "item")) {
        throw new Error(`Workflow invariant rejected stored expansion node "${node.id}", which is neither a branch nor its stage`);
      }
      return { kind: "add_node", node, item: change.forItem };
    }
    case "add_dependency": return change;
    case "add_join": return change;
  }
}

/** Encode one expansion change of control version 11 in the graph version 8
 *  shapes that `group.expanded@1` and `@2` record, so strict replay of a run
 *  from before phases derives the bytes that it recorded. History only;
 *  remove after 2027-04-30. */
export function encodeExpansionChangeV8(change: ExpansionChange): ExpansionChangeV8 {
  if (change.kind !== "add_node") return change;
  const { node } = change;
  // An expansion adds pending nodes, and graph version 8 has no skipped
  // state, so a skipped node here is an invariant.
  const { state } = node;
  if (state._tag === "skipped") throw new Error(`Workflow invariant rejected skipped node "${node.id}" in an expansion`);
  if (node.kind === "item") {
    const { kind: _kind, ownership, state: _state, ...rest } = node;
    if (ownership._tag !== "list") throw new Error(`Workflow invariant rejected item "${node.id}" outside a list`);
    return { kind: "add_node", forItem: change.item, node: { ...rest, state, kind: "branch", ownership: { _tag: "group", workflowDefinitionId: ownership.workflowDefinitionId, mapId: ownership.outputId, parentNodeId: ownership.parentNodeId } } };
  }
  const { kind: _kind, ownership, retry, condition: _condition, followUpV10: _followUp, state: _state, ...rest } = node;
  if (ownership._tag !== "item") throw new Error(`Workflow invariant rejected agent "${node.id}" outside an item`);
  return {
    kind: "add_node",
    forItem: change.item,
    node: {
      ...rest,
      state,
      kind: "step",
      ownership: { _tag: "branch", workflowDefinitionId: ownership.workflowDefinitionId, mapId: ownership.outputId, key: ownership.key, parentNodeId: ownership.parentNodeId },
      then: null,
      retry: retry === null ? null : { maxIterations: retry.max, detectStuck: retry.stuck },
    },
  };
}
