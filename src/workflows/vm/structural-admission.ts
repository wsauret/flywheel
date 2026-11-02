import { isDeepStrictEqual } from "node:util";
import { Schema } from "effect";
import { DEFAULT_COUNTED_LIST_MAX, MAX_ATTEMPTS_CEILING } from "../workflow-schema.js";
import type { CommittedWorkflowControl } from "./committed-control.js";
import { findDependencyCycles } from "./frontier.js";
import { isContainerNode, listJoin, rerunSupersededIds } from "./graph-changes.js";
import { inRound, listAgentCount, repeatRun, roundOfNodeId, type ListNode, type LogicalNode, type RepeatNode, type WorkflowGraph, type WorkflowOwnership } from "./graph-types.js";
import type { WorkflowVerificationFinding } from "./verify-types.js";

/** The control that structural admission reads. It never reads node or
 *  attempt states, so a graph admitted once stays admitted while it runs, and
 *  a proposal is judged by the structure it adds. */
type AdmittedStructure = Pick<CommittedWorkflowControl, "graph" | "attempts" | "guardrails"> & {
  readonly definitionIdentity: Pick<CommittedWorkflowControl["definitionIdentity"], "workflowDefinitionId">;
};

/** What a subtree holds, derived from the graph and never stored. `nodes`
 *  counts the logical nodes below the root of the subtree. `depth` counts the
 *  containers on the deepest path from the root to an agent, the root included
 *  when it is a container. A list that has not expanded counts at its worst
 *  case: its items, its declared width times its votes, each with one agent
 *  for each phase. A repeat also counts each round that it can still add. */
export interface SubtreeUsage {
  readonly nodes: number;
  readonly depth: number;
}

/** The nodes that each node owns, without the nodes of earlier runs
 *  (`rerunSupersededIds`), which count toward no limit. */
function children(graph: WorkflowGraph): ReadonlyMap<string, readonly LogicalNode[]> {
  const owned = new Map<string, LogicalNode[]>();
  const superseded = rerunSupersededIds(graph);
  for (const node of graph.nodes) {
    if (node.ownership._tag === "workflow" || superseded.has(node.id)) continue;
    owned.set(node.ownership.parentNodeId, [...owned.get(node.ownership.parentNodeId) ?? [], node]);
  }
  return owned;
}

/** The agents of each phase of one list that a count reads: the items of
 *  an expanded list, else the items that it will expand to. A list of a
 *  later round whose source sits outside its repeat expands over the items
 *  of round 1 (refer to `laterRoundItems`), so it counts them once round 1
 *  expanded; any other list counts its worst case, its declared width times
 *  its votes. */
function listItems(graph: WorkflowGraph, node: ListNode, measure: "current" | "worstCase"): number {
  const join = listJoin(graph, node.id);
  if (measure === "current" && join !== undefined) return join.requiredNodeIds.length;
  const round1 = measure === "current" ? roundOneList(node) : undefined;
  const first = round1 === undefined ? undefined : listJoin(graph, round1);
  return first === undefined ? listAgentCount(node) : first.requiredNodeIds.length;
}

/** The id of the round 1 copy of a list of a later round whose source sits
 *  outside its repeat, or undefined for any other list. */
function roundOneList(node: ListNode): string | undefined {
  if (node.ownership._tag !== "round" || node.ownership.round === 1) return undefined;
  const place = roundOfNodeId(node.id);
  if (place === null || roundOfNodeId(node.source.nodeId)?.repeatNodeId === place.repeatNodeId) return undefined;
  return inRound(`${place.repeatNodeId}:round:1${place.rest}`, place.repeatNodeId, 1, place.run);
}

/** The rounds of the current run of a repeat that exist. */
function roundsHeld(graph: WorkflowGraph, repeat: RepeatNode): number {
  const run = repeatRun(graph, repeat.id);
  return graph.nodes.reduce((latest, node) =>
    node.ownership._tag === "round" && node.ownership.parentNodeId === repeat.id && (roundOfNodeId(node.id)?.run ?? 1) === run ? Math.max(latest, node.ownership.round) : latest, 0);
}

/** The most rounds that a repeat runs: `max` for a `while` repeat, and for
 *  an `each` repeat its items, or before it froze them its declared width,
 *  and in the worst case each item that a reassessment can insert. A repeat
 *  over a list without a width counts the items it froze, or before then
 *  the rounds it holds, and its opening refuses items that the attempt
 *  limit cannot hold. */
function roundsAllowed(graph: WorkflowGraph, repeat: RepeatNode, maxInserts: number, measure: "current" | "worstCase"): number {
  const { loop } = repeat;
  if (loop._tag === "while") return loop.max;
  const declared = loop.width ?? loop.items?.length ?? roundsHeld(graph, repeat);
  const items = measure === "current" && loop.items !== null ? loop.items.length : declared;
  return items + (measure === "worstCase" && loop.reassess !== null ? maxInserts : 0);
}

/** What one round of a repeat holds: its nodes and its attempts, each with
 *  the attempt count of every declared retry. A round copies round 1, so
 *  round 1's nodes give every count. */
interface RoundCost {
  readonly nodes: number;
  readonly attempts: number;
  readonly retries: number;
}

function roundCost(graph: WorkflowGraph, repeat: RepeatNode, measure: "current" | "worstCase"): RoundCost {
  const owned = children(graph);
  const firstRound = graph.nodes.filter((node) => node.ownership._tag === "round" && node.ownership.parentNodeId === repeat.id && node.ownership.round === 1 && roundOfNodeId(node.id)?.run === 1);
  let nodes = 0;
  let attempts = 0;
  let retries = 0;
  const visit = (node: LogicalNode): void => {
    nodes += 1;
    if (node.kind === "agent") {
      attempts += 1;
      retries += (node.retry?.max ?? 1) - 1;
    } else if (node.kind === "list") {
      const items = listItems(graph, node, measure);
      nodes += items * (1 + node.phases.length);
      attempts += items * node.phases.length;
      retries += items * node.phases.reduce((total, phase) => total + (phase.retry?.max ?? 1) - 1, 0);
      return;
    }
    for (const child of owned.get(node.id) ?? []) visit(child);
  };
  for (const node of firstRound) visit(node);
  return { nodes, attempts, retries };
}

interface FutureRounds {
  readonly rounds: number;
  readonly cost: RoundCost;
}

/** The rounds that a repeat can still add, and what each holds. Each later
 *  round copies round 1, so a round that the repeat adds moves its attempts
 *  from this count to its own nodes, and no total changes. It reads no node
 *  state, so a repeat that stopped keeps the rounds that it did not run
 *  counted, as launch admitted them. */
function futureRounds(graph: WorkflowGraph, repeat: RepeatNode, maxInserts: number, measure: "current" | "worstCase"): FutureRounds {
  return { rounds: Math.max(0, roundsAllowed(graph, repeat, maxInserts, measure) - roundsHeld(graph, repeat)), cost: roundCost(graph, repeat, measure) };
}

/** The usage of the subtree under one node. A node on an ownership cycle is
 *  counted once; admission reports the cycle as an ownership defect. With
 *  `worstCase`, every list counts at its worst case, expanded or not, which
 *  is the bound the compiler derives from the authored phases. Admission and
 *  inspection read usage here, so both report the same numbers. */
export function subtreeUsage(graph: WorkflowGraph, nodeId: string, measure: "current" | "worstCase" = "current", maxInserts = 0): SubtreeUsage {
  const owned = children(graph);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const seen = new Set<string>();
  const usage = (id: string): SubtreeUsage => {
    if (seen.has(id)) return { nodes: 0, depth: 0 };
    seen.add(id);
    const node = byId.get(id);
    if (node?.kind === "list" && (measure === "worstCase" || listJoin(graph, node.id) === undefined)) {
      return { nodes: listAgentCount(node) * (1 + node.phases.length), depth: 2 };
    }
    const below = (owned.get(id) ?? []).map((child) => usage(child.id));
    if (node?.kind === "repeat") {
      const future = futureRounds(graph, node, maxInserts, measure);
      if (future.rounds > 0) below.push({ nodes: future.rounds * future.cost.nodes - 1, depth: 2 });
    }
    const nodes = below.reduce((total, child) => total + 1 + child.nodes, 0);
    const deepest = below.reduce((maximum, child) => Math.max(maximum, child.depth), 0);
    return { nodes, depth: node !== undefined && isContainerNode(node) ? deepest + 1 : deepest };
  };
  return usage(nodeId);
}

function finding(name: string, target: string | null, message: string): WorkflowVerificationFinding {
  return { name, target, message, witness: [], noPathReason: null };
}

function sameOwnership(left: WorkflowOwnership, right: WorkflowOwnership): boolean {
  return isDeepStrictEqual(left, right);
}

/** Why a node's owner record does not name a container that can own it, or
 *  undefined when it does. A phase owns its named agents, or any node in
 *  control from before phases; a list owns its items; an item owns the
 *  agents of its own item; and a repeat owns the nodes of each round. */
function ownerDefect(node: LogicalNode, parent: LogicalNode | undefined): string | undefined {
  const ownership = node.ownership;
  switch (ownership._tag) {
    case "workflow": return undefined;
    case "phase": return parent?.kind === "phase" && parent.phaseId === ownership.phaseId
      ? undefined
      : `Node "${node.id}" names owner "${ownership.parentNodeId}", which is not phase "${ownership.phaseId}".`;
    case "list": return parent?.kind === "list" && parent.outputId === ownership.outputId && node.kind === "item"
      ? undefined
      : `Node "${node.id}" names owner "${ownership.parentNodeId}", which is not the list of phase "${ownership.outputId}" or does not own an item.`;
    case "item": return parent?.kind === "item" && parent.key === ownership.key && parent.ownership._tag === "list"
      && parent.ownership.outputId === ownership.outputId && node.kind === "agent"
      ? undefined
      : `Node "${node.id}" names owner "${ownership.parentNodeId}", which is not item "${ownership.key}" of phase "${ownership.outputId}" or does not own an agent.`;
    case "round": return parent?.kind === "repeat" && (node.kind === "agent" || node.kind === "phase" || node.kind === "list")
      ? undefined
      : `Node "${node.id}" names owner "${ownership.parentNodeId}", which is not a repeat or does not own a phase of a round.`;
  }
}

function ownerKey(ownership: WorkflowOwnership): string {
  return ownership._tag === "workflow" ? "workflow" : ownership.parentNodeId;
}

function ownershipFindings(structure: AdmittedStructure): WorkflowVerificationFinding[] {
  const findings: WorkflowVerificationFinding[] = [];
  const byId = new Map(structure.graph.nodes.map((node) => [node.id, node]));
  for (const node of structure.graph.nodes) {
    if (node.ownership._tag === "workflow") continue;
    const parent = byId.get(node.ownership.parentNodeId);
    const defect = ownerDefect(node, parent);
    if (defect !== undefined) {
      findings.push(finding("invalid_parent_ownership", node.id, defect));
    } else if (parent !== undefined && parent.order >= node.order) {
      findings.push(finding("invalid_parent_ownership", node.id, `Node "${node.id}" comes before its owner "${parent.id}" in graph order.`));
    }
  }
  for (const attempt of structure.attempts) {
    const owner = byId.get(attempt.logicalNodeId);
    if (!owner || !sameOwnership(owner.ownership, attempt.ownership)) {
      findings.push(finding("invalid_parent_ownership", attempt.id, `Attempt "${attempt.id}" does not match its logical node ownership.`));
    } else if (isContainerNode(owner)) {
      findings.push(finding("invalid_parent_ownership", attempt.id, `Attempt "${attempt.id}" belongs to container "${owner.id}", which holds no attempts.`));
    }
  }
  for (const budget of structure.graph.budgets ?? []) {
    if (byId.get(budget.parentNodeId)?.kind !== "phase") {
      findings.push(finding("invalid_parent_ownership", budget.parentNodeId, `Budget parent "${budget.parentNodeId}" is not a phase node.`));
    }
  }
  return findings;
}

function dependencyFindings(graph: WorkflowGraph): WorkflowVerificationFinding[] {
  const findings: WorkflowVerificationFinding[] = [];
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const edge of graph.dependencies) {
    const target = byId.get(edge.nodeId);
    const dependency = byId.get(edge.dependsOn);
    if (!target) findings.push(finding("invalid_dependency_target", edge.nodeId, `Dependency owner "${edge.nodeId}" does not exist.`));
    if (!dependency) findings.push(finding("invalid_dependency_target", edge.dependsOn, `Dependency target "${edge.dependsOn}" does not exist.`));
    if (target && dependency && ownerKey(target.ownership) !== ownerKey(dependency.ownership)) {
      findings.push(finding("invalid_dependency_target", edge.nodeId, `Node "${edge.nodeId}" depends on "${edge.dependsOn}", which another container owns.`));
    }
  }
  for (const { nodeIds } of findDependencyCycles(graph)) {
    const containsWhile = nodeIds.some((id) => byId.get(id)?.kind === "while");
    findings.push(finding(
      "dependency_cycle",
      nodeIds[0] ?? null,
      `Dependency cycle ${nodeIds.join(" -> ")} prevents reachability${containsWhile ? "; a while bound does not bound dependency cycles" : ""}.`,
    ));
  }
  return findings;
}

/** The join of each list: one `collect_all` join on a list node, whose
 *  required ids are exactly that list's items. A join that names any other
 *  node, or an item of another list, can never fold. */
function joinFindings(graph: WorkflowGraph): WorkflowVerificationFinding[] {
  const findings: WorkflowVerificationFinding[] = [];
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const joined = new Set<string>();
  const superseded = rerunSupersededIds(graph);
  for (const join of graph.joins) {
    const list = byId.get(join.nodeId);
    if (list?.kind !== "list") {
      findings.push(finding("impossible_join", join.nodeId, `Join "${join.nodeId}" does not name a list node.`));
      continue;
    }
    if (joined.has(join.nodeId)) findings.push(finding("impossible_join", join.nodeId, `List "${join.nodeId}" has more than one join.`));
    joined.add(join.nodeId);
    // A list of an earlier run keeps the join of its own items.
    const items = graph.nodes.filter((node) => node.kind === "item" && node.ownership._tag === "list" && node.ownership.parentNodeId === list.id && (!superseded.has(node.id) || superseded.has(list.id))).map(({ id }) => id);
    if (!isDeepStrictEqual([...join.requiredNodeIds].toSorted(), items.toSorted())) {
      findings.push(finding("impossible_join", join.nodeId, `Join "${join.nodeId}" does not require exactly the items of its list.`));
    }
  }
  return findings;
}

/** The attempts that count against the attempt limit: every attempt in
 *  control except a continuation and an attempt of a rerun's superseded
 *  item (`rerunSupersededIds`), which its list's new run replaces, plus the
 *  worst case of each unexpanded list, where each of its items, its
 *  declared width times its votes, runs each phase once, and of each round
 *  that a repeat can still add. Admission and every runtime
 *  insertion guard count the same number, so a run that admitted a list or
 *  a repeat always has room to run it. */
export function queuedAttempts(structure: Pick<CommittedWorkflowControl, "graph" | "attempts" | "guardrails">): number {
  const { graph } = structure;
  const superseded = rerunSupersededIds(graph);
  return structure.attempts.filter(({ provenance, logicalNodeId }) => provenance._tag !== "continuation" && !superseded.has(logicalNodeId)).length + graph.nodes.reduce((total, node) => {
    if (superseded.has(node.id)) return total;
    if (node.kind === "list" && listJoin(graph, node.id) === undefined) return total + listItems(graph, node, "current") * node.phases.length;
    if (node.kind !== "repeat") return total;
    const future = futureRounds(graph, node, structure.guardrails.maxInserts, "current");
    return total + future.rounds * future.cost.attempts;
  }, 0);
}

/** The most attempts that a run of this control can hold: the queued
 *  attempts of {@link queuedAttempts}, each retry that an agent or a phase of
 *  a list declares, also in each round that a repeat can add, each item that
 *  a reassessment can insert, and each attempt that a history `then` chain,
 *  `while`, or `for` of control from before phases can insert. The insert
 *  cap bounds the inserts, and a follow-up can retry, so each insert counts
 *  with the most retries of an agent that has a follow-up. A workflow file
 *  that declares no attempt limit runs with this count as its limit, so the
 *  runtime never refuses an attempt that the file declares. */
export function worstCaseAttempts(structure: Pick<CommittedWorkflowControl, "graph" | "attempts" | "guardrails">): number {
  const { graph, guardrails } = structure;
  let retries = 0;
  let extra = 0;
  let inserts = false;
  let insertIterations = 1;
  const superseded = rerunSupersededIds(graph);
  for (const node of graph.nodes) {
    if (superseded.has(node.id)) continue;
    if (node.kind === "agent") {
      const iterations = node.retry?.max ?? 1;
      retries += iterations - 1;
      if (node.followUpV10 !== undefined) {
        inserts = true;
        insertIterations = Math.max(insertIterations, iterations);
      }
    } else if (node.kind === "list" && listJoin(graph, node.id) === undefined) {
      retries += listItems(graph, node, "current") * node.phases.reduce((total, phase) => total + (phase.retry?.max ?? 1) - 1, 0);
    } else if (node.kind === "repeat") {
      const current = futureRounds(graph, node, guardrails.maxInserts, "current");
      const worst = futureRounds(graph, node, guardrails.maxInserts, "worstCase");
      retries += current.rounds * current.cost.retries;
      // The rounds that a reassessment can insert run beyond the items that
      // the queued count holds.
      extra += Math.max(0, worst.rounds - current.rounds) * (worst.cost.attempts + worst.cost.retries);
    } else if (node.kind === "while" || node.kind === "for") {
      inserts = true;
    }
  }
  return queuedAttempts(structure) + retries + extra + (inserts ? guardrails.maxInserts * insertIterations : 0);
}

function limitFindings(structure: AdmittedStructure): WorkflowVerificationFinding[] {
  const findings: WorkflowVerificationFinding[] = [];
  const graph = structure.graph;
  for (const budget of graph.budgets ?? []) {
    const usage = subtreeUsage(graph, budget.parentNodeId);
    const { nodes, depth } = budget.limits;
    const owner = graph.nodes.find(({ id }) => id === budget.parentNodeId);
    // Authors know a phase by its local id, not its compiled node id.
    const phase = owner?.kind === "phase" ? owner.phaseId : budget.parentNodeId;
    if (nodes !== undefined && usage.nodes > nodes) {
      findings.push(finding("parent_budget_overrun", budget.parentNodeId, `Phase "${phase}" holds ${usage.nodes} nodes, more than its declared limit of ${nodes}.`));
    }
    if (depth !== undefined && usage.depth > depth) {
      findings.push(finding("parent_budget_overrun", budget.parentNodeId, `Phase "${phase}" nests ${usage.depth} containers deep, more than its declared limit of ${depth}.`));
    }
  }
  // The attempt limit counts attempts. Compile queues one attempt for each
  // agent, and an unexpanded list and each future round of a repeat count at
  // their worst case. A retry and an inserted item each add attempts at run
  // time, and the runtime charges each one against the same limit when it
  // adds it. A declared limit and the setting stay within the ceiling, so
  // only a workflow file's worst case can pass it.
  const { maxAttempts } = structure.guardrails;
  const queued = queuedAttempts(structure);
  if (maxAttempts > MAX_ATTEMPTS_CEILING) {
    findings.push(finding("attempt_limit_overrun", null, `The workflow needs ${maxAttempts} attempts for its worst case, more than the ceiling of ${MAX_ATTEMPTS_CEILING}.`));
  } else if (queued > maxAttempts) {
    findings.push(finding("attempt_limit_overrun", null, `The workflow queues ${queued} attempts, more than its attempt limit of ${maxAttempts}.`));
  }
  return findings;
}

/** Every structural defect of one control: dependency targets and cycles,
 *  the ownership tree, list joins, declared phase limits of control from
 *  before phases, and the queued attempts against the attempt limit. Whether
 *  each node names the workflow of the definition identity is not
 *  structure: a renamed workflow's stored nodes keep the id they were
 *  written with, so only the verifier reports it. Compile, publish,
 *  reassessment, verification, and load-time validation all judge structure
 *  here, so one control gets one verdict. The readers differ only in the
 *  attempt limit of a named workflow that declares none: a launch
 *  applies the `workflow.max_attempts` setting, and a reader without a launch
 *  applies the ceiling. A workflow file that declares none takes its worst
 *  case as its limit in every reader. The findings use the verifier's
 *  shape. */
export function structuralFindings(structure: AdmittedStructure): readonly WorkflowVerificationFinding[] {
  return [
    ...dependencyFindings(structure.graph),
    ...ownershipFindings(structure),
    ...joinFindings(structure.graph),
    ...limitFindings(structure),
  ];
}

/** What an author can do about one finding. A defect that no authored
 *  workflow can produce names the compiler as its source. */
export function structuralRemedy(name: string): string {
  switch (name) {
    case "parent_budget_overrun": return "Raise the declared limits of the phase, or move work out of it.";
    case "attempt_limit_overrun": return `Raise guardrails.max_attempts (at most ${MAX_ATTEMPTS_CEILING}), remove phases, or declare a lower max on a list that a phase over a list, a repeat, or a join counts; a list of a workflow file that declares none counts as ${DEFAULT_COUNTED_LIST_MAX}. A workflow file that declares none uses its worst case: every queued attempt, each declared retry, and each item that a reassessment can insert.`;
    case "dependency_cycle": return "Remove the cycle so each phase can run after the phases before it.";
    default: return "Compiled control has a structural defect that no authored workflow produces; report it with the workflow file.";
  }
}

const StructuralFindingSchema = Schema.Struct({
  name: Schema.String,
  target: Schema.NullOr(Schema.String),
  message: Schema.String,
});

/** A graph that structural admission refused. It names each finding and
 *  what the author can do about it. */
export class WorkflowStructureRejectedError extends Schema.TaggedErrorClass<WorkflowStructureRejectedError>()(
  "WorkflowStructureRejectedError",
  {
    workflowDefinitionId: Schema.String,
    findings: Schema.NonEmptyArray(StructuralFindingSchema),
    message: Schema.String,
  },
) {}

function rejection(workflowDefinitionId: string, found: readonly WorkflowVerificationFinding[]): WorkflowStructureRejectedError | undefined {
  const [first, ...rest] = found.map(({ name, target, message }) => ({ name, target, message }));
  if (!first) return undefined;
  const findings = [first, ...rest] as const;
  return new WorkflowStructureRejectedError({
    workflowDefinitionId,
    findings,
    message: `Workflow "${workflowDefinitionId}" structure was rejected: ${findings.map(({ name, message }) => `${name}: ${message} ${structuralRemedy(name)}`).join(" ")}`,
  });
}

/** Admit one new control whose {@link structuralFindings} are `findings`,
 *  or throw {@link WorkflowStructureRejectedError}. */
export function admitStructure(workflowDefinitionId: string, findings: readonly WorkflowVerificationFinding[]): void {
  const rejected = rejection(workflowDefinitionId, findings);
  if (rejected) throw rejected;
}

/** Admit one proposed change to admitted control, or throw
 *  {@link WorkflowStructureRejectedError}. Only a finding that the previous
 *  control did not have refuses the change. Stored control can carry a
 *  finding that admission did not judge when it was written, such as a node
 *  whose workflow id predates a rename, and replay of that history must still
 *  re-derive every proposal it accepted. */
export function admitStructureChange(previous: AdmittedStructure, proposed: AdmittedStructure): void {
  const known = new Set(structuralFindings(previous).map(({ name, target }) => `${name}\u0000${target}`));
  const added = structuralFindings(proposed).filter(({ name, target }) => !known.has(`${name}\u0000${target}`));
  const rejected = rejection(proposed.definitionIdentity.workflowDefinitionId, added);
  if (rejected) throw rejected;
}
