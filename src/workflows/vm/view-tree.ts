import { summaryLine } from "../../infra/summary-line.js";
import type { WorkflowTree, WorkflowTreeAgent, WorkflowTreeDisposition, WorkflowTreeJoin, WorkflowTreeLoop, WorkflowTreeNode, WorkflowTreePhase } from "../../protocol/workflow-view-protocol-types.js";
import { followUpForAttempt, forBodyRemainder } from "./attempt-continuation.js";
import { whileOutcome } from "./loop-signal.js";
import type { CommittedWorkflowControl } from "./committed-control.js";
import { CURRENT_PROPOSAL_ENCODING } from "./events.js";
import { readyAttempt } from "./frontier.js";
import { isContainerNode, listJoin, rerunSupersededIds } from "./graph-changes.js";
import { inRound, roundOfNodeId, type AgentNode, type Attempt, type FollowUpV10, type GraphNodeState, type LogicalNode, type RepeatNode } from "./graph-types.js";
import { isJoinNode, nodeById, ownedNodes, settledJoinProjections, type JoinNode } from "./node-outputs.js";
import { evaluatorDecision, latestRound, roundOutcome } from "./repeat-transitions.js";

// The tree of committed control: the phases of the workflow in run order,
// each with its agents, and the repeats that hold the phases of each round.
// A phase of one agent and a phase of named agents are one phase each, and a
// list is one phase for each phase of its stream. History nodes of control
// from before phases project into the same kinds: each execution of a `then`
// chain or a `for` body is its own phase of one agent, a `while` is a
// repeat, and agents that an `after` order lets run at once share one
// parallel phase. Remove those history arms after 2027-04-30.

/** Whether committed control has made the node unreachable, or its `if`
 *  or its repeat skipped it. */
function nodeIsSkipped(state: GraphNodeState): state is Extract<GraphNodeState, { readonly _tag: "blocked" | "cancelled" | "superseded" | "skipped" }> {
  return state._tag === "blocked" || state._tag === "cancelled" || state._tag === "superseded" || state._tag === "skipped";
}

function treeDisposition(node: LogicalNode, attempts: readonly Attempt[]): WorkflowTreeDisposition {
  if (nodeIsSkipped(node.state)) return "skipped";
  switch (node.state._tag) {
    case "pending":
    case "ready": return "pending";
    case "running": return isContainerNode(node) || attempts.some(({ state }) => state._tag === "running") ? "running" : "pending";
    case "completed": return "completed";
    case "failed": return "failed";
  }
}

function treeReason(node: LogicalNode, current: Attempt | undefined, leafReasons: ReadonlyMap<string, string>): string | undefined {
  if (current?.state._tag === "failed") return current.state.reason;
  if (node.state._tag === "failed" && isContainerNode(node)) return leafReasons.get(node.id) ?? node.state.reason;
  return "reason" in node.state ? node.state.reason : undefined;
}

/** The slots of a join: the items of an expanded list, or the agents of a
 *  phase. Undefined for a list that has not expanded. */
function joinSlots(control: CommittedWorkflowControl, node: JoinNode): readonly string[] | undefined {
  return node.kind === "list" ? listJoin(control.graph, node.id)?.requiredNodeIds : ownedNodes(control, node.id).map(({ id }) => id);
}

function treeJoin(control: CommittedWorkflowControl, node: JoinNode, dispositions: ReadonlyMap<string, WorkflowTreeDisposition>): WorkflowTreeJoin | undefined {
  const slots = joinSlots(control, node);
  if (slots === undefined) return undefined;
  const counts = { completed: 0, failed: 0, pending: 0, missing: 0 };
  for (const slotId of slots) {
    const disposition = dispositions.get(slotId);
    if (disposition === undefined) counts.missing += 1;
    else if (disposition === "completed") counts.completed += 1;
    else if (disposition === "failed") counts.failed += 1;
    else counts.pending += 1;
  }
  const { reducer, settlement } = node.kind === "list" ? node : node.join;
  return {
    reducer: `${reducer.id}@${reducer.version}`,
    state: settlement === null ? "pending" : "settled",
    slots: slots.length,
    ...counts,
    ...settledJoinProjections(control, node),
  };
}

// Keep replace-latest tree facts bounded even for large manifests.
const TREE_TEXT_LIMIT = 240;

function oneLine(text: string): string {
  return bounded(text.split("\n").map((part) => part.trim()).find((part) => part.length > 0) ?? "");
}

function bounded(line: string): string {
  return line.length <= TREE_TEXT_LIMIT ? line : `${line.slice(0, TREE_TEXT_LIMIT - 1)}…`;
}

// The problems of a delivered handoff that the card shows; the completion
// names every one.
const TREE_ISSUE_LINES = 3;

function treeEvidence(current: Attempt | undefined): WorkflowTreeAgent["evidence"] {
  if (current?.state._tag !== "completed") return undefined;
  const summary = current.handoff?.["summary"];
  const issues = current.handoffIssues ?? [];
  const evidence = {
    ...(typeof summary === "string" && summary.trim().length > 0 ? { summary: bounded(summaryLine(summary)) } : {}),
    ...(issues.length === 0 ? {} : { contractIssues: { count: issues.length, lines: issues.slice(0, TREE_ISSUE_LINES).map(({ path, message }) => oneLine(`${path}: ${message}`)) } }),
  };
  return Object.keys(evidence).length === 0 ? undefined : evidence;
}

function concurrentSpans(children: readonly LogicalNode[], prerequisites: ReadonlyMap<string, readonly string[]>): readonly (readonly LogicalNode[])[] {
  const remaining = new Set(children.map(({ id }) => id));
  const ancestors = new Map<string, Set<string>>();
  const ordered: LogicalNode[] = [];
  while (remaining.size > 0) {
    // SAFETY: Compilation and structural admission reject dependency cycles, so a remaining node is ready.
    const next = children.find(({ id }) => remaining.has(id) && (prerequisites.get(id) ?? []).every((before) => !remaining.has(before)))!;
    const closure = new Set<string>();
    for (const before of prerequisites.get(next.id) ?? []) {
      closure.add(before);
      for (const ancestor of ancestors.get(before) ?? []) closure.add(ancestor);
    }
    ancestors.set(next.id, closure);
    ordered.push(next);
    remaining.delete(next.id);
  }
  // A cut is valid only when every later node depends on the entire prefix.
  const prefixLengths = ordered.map((node) => {
    // SAFETY: The ordering loop records the ancestor closure of every ordered node.
    const closure = ancestors.get(node.id)!;
    return ordered.findIndex(({ id }) => !closure.has(id));
  });
  const suffixMinimum = [...prefixLengths];
  for (let index = suffixMinimum.length - 2; index >= 0; index -= 1) {
    // SAFETY: The loop visits existing elements with an existing successor.
    suffixMinimum[index] = Math.min(suffixMinimum[index]!, suffixMinimum[index + 1]!);
  }
  const spans: LogicalNode[][] = [];
  let start = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    // SAFETY: Both arrays have the ordered length, and the last index short-circuits the successor read.
    if (index + 1 !== ordered.length && suffixMinimum[index + 1]! < index + 1) continue;
    if (index > start) spans.push(ordered.slice(start, index + 1).toSorted((a, b) => a.order - b.order));
    start = index + 1;
  }
  return spans;
}

/** What several agents sum to: running while one runs, failed once one
 *  failed, completed when all completed, and skipped when the rest were
 *  skipped. */
function sumDisposition(members: readonly { readonly disposition: WorkflowTreeDisposition }[]): WorkflowTreeDisposition {
  if (members.some(({ disposition }) => disposition === "running")) return "running";
  if (members.some(({ disposition }) => disposition === "failed")) return "failed";
  if (members.every(({ disposition }) => disposition === "completed")) return "completed";
  if (members.every(({ disposition }) => disposition === "completed" || disposition === "skipped")) return "skipped";
  return "pending";
}

/** Whether an attempt runs its parent's execution again: a retry, or a
 *  continuation that reopens, overflows, or reruns it. */
function repeatsParent(attempt: Attempt): boolean {
  return attempt.provenance._tag === "retry" || attempt.provenance._tag === "continuation";
}

/** Retry and continuation edges keep one execution position; other
 * insertions create positions. Array order is queue order, which can differ
 * from attempt sequence order. */
function executionLineages(attempts: readonly Attempt[]): Attempt[][] {
  const lineages: Attempt[][] = [];
  const byAttempt = new Map<string, Attempt[]>();
  for (const attempt of attempts) {
    const parent = repeatsParent(attempt) && attempt.parentAttemptId !== null ? byAttempt.get(attempt.parentAttemptId) : undefined;
    const lineage = parent ?? [];
    if (parent === undefined) lineages.push(lineage);
    lineage.push(attempt);
    byAttempt.set(attempt.id, lineage);
  }
  return lineages;
}

/** One agent that a node of control from before phases still plans to run:
 *  its record, and whether a condition gates it. */
interface PlannedUnit {
  readonly definitionId: string;
  readonly gated: boolean;
}

function chainUnits(followUp: FollowUpV10 | null): PlannedUnit[] {
  const units: PlannedUnit[] = [];
  for (let next = followUp; next; next = next.then) units.push({ definitionId: next.step, gated: next.when !== null }); // stored key of control v10
  return units;
}

function canRun(control: CommittedWorkflowControl, node: LogicalNode, current: Attempt | undefined): boolean {
  return (control.status === "ready" || control.status === "executing" || control.status === "paused")
    && !nodeIsSkipped(node.state)
    && node.state._tag !== "completed" && node.state._tag !== "failed"
    && (current === undefined || current.state._tag === "pending" || current.state._tag === "running");
}

/** Whether control started a node: it runs or ran. */
function started(state: GraphNodeState): boolean {
  return state._tag === "running" || state._tag === "completed" || state._tag === "failed";
}

/** Whether a node of round `round` of a repeat comes after the evaluator of
 *  that round, so it runs only when the evaluator keeps the repeat going. */
function afterEvaluator(control: CommittedWorkflowControl, repeat: RepeatNode, node: LogicalNode, round: number): boolean {
  if (repeat.loop._tag !== "while") return false;
  const evaluatorId = inRound(repeat.loop.evaluator, repeat.id, round, roundOfNodeId(node.id)?.run);
  const evaluator = control.graph.nodes.find(({ id }) => id === evaluatorId);
  return evaluator !== undefined && node.order > evaluator.order;
}

/** The round that a node of round `round` of a repeat shows. A node of a
 *  `while` repeat shows the round of the check that it leads to, so a node
 *  after the evaluator, which repairs what that evaluator found, shows the
 *  next round. A run before encoding 11 also repaired after the check of
 *  round `max`, so that repair shows round `max` + 1, whose check never
 *  ran. */
function shownRound(control: CommittedWorkflowControl, repeat: RepeatNode, node: LogicalNode, round: number): number {
  return afterEvaluator(control, repeat, node, round) ? round + 1 : round;
}

/** Whether a phase of a `while` repeat leads to no check, so the tree
 *  leaves it out: it comes after the evaluator of the last round, `max`,
 *  where the repeat ends. A phase there that started stays, as a run before
 *  encoding 11 repaired after the check of its last round. */
function leadsToNoCheck(control: CommittedWorkflowControl, repeat: RepeatNode, node: LogicalNode): boolean {
  const { ownership } = node;
  return repeat.loop._tag === "while" && ownership._tag === "round" && ownership.round >= repeat.loop.max
    && !started(node.state) && afterEvaluator(control, repeat, node, ownership.round);
}

/** The loop state of a repeat: the round of its current phase, or else of
 *  the phase that ran last, the most rounds it can run, and, once a `while`
 *  repeat completed, how its last round ended. No round of a `while`
 *  repeat past `max` runs a check, so a repair after the check of round
 *  `max` counts as round `max`. An `each` repeat ends when it runs out of items, which is no
 *  outcome. */
function repeatLoop(control: CommittedWorkflowControl, node: RepeatNode, current: Attempt | undefined, superseded: ReadonlySet<string>): WorkflowTreeLoop {
  const latest = Math.max(1, latestRound(control, node));
  const { loop } = node;
  const maxIterations = loop._tag === "while" ? loop.max : Math.max(1, loop.items?.length ?? loop.width ?? 1);
  const shown = control.graph.nodes.reduce((round, candidate) => {
    const { ownership } = candidate;
    const reached = started(candidate.state) || candidate.id === current?.logicalNodeId;
    return ownership._tag === "round" && ownership.parentNodeId === node.id && reached && !superseded.has(candidate.id) ? Math.max(round, shownRound(control, node, candidate, ownership.round)) : round;
  }, latest);
  const round = loop._tag === "while" ? Math.min(loop.max, shown) : shown;
  if (node.state._tag !== "completed" || loop._tag === "each") return { iteration: round, maxIterations };
  const decided = evaluatorDecision(control, node, latest)?.decision;
  return { iteration: round, maxIterations, outcome: decided === "dry" || decided === "stuck" ? decided : "bound" };
}

/** The loop state of a `while` node of control from before phases. */
function whileLoop(node: Extract<LogicalNode, { kind: "while" }>, lineages: readonly Attempt[][]): WorkflowTreeLoop {
  const latestEvaluator = lineages.flatMap((lineage) => lineage.slice(-1)).findLast((attempt) => attempt.definitionId === node.evaluator.step && attempt.state._tag === "completed"); // stored key of control v10
  const evaluations = lineages.filter((lineage) => lineage[0]?.definitionId === node.evaluator.step); // stored key of control v10
  const evaluated = latestEvaluator === undefined ? undefined : evaluations.findIndex((lineage) => lineage.includes(latestEvaluator)) + 1;
  // SAFETY: each evaluation lineage contains its evaluator and evaluated indexes that same array.
  const previousHandoff = evaluated !== undefined && evaluated > 1 ? evaluations[evaluated - 2]!.at(-1)!.handoff : null;
  const outcome = latestEvaluator?.handoff === null || latestEvaluator === undefined || evaluated === undefined
    ? undefined
    : whileOutcome(node, latestEvaluator.handoff, evaluated, previousHandoff);
  return { iteration: Math.max(1, Math.ceil(lineages.length / node.body.length)), maxIterations: node.maxIterations, ...(outcome === undefined ? {} : { outcome }) };
}

/** Whether an agent that has not started runs only on a decision that no
 *  agent has made yet, so the tree shows it as "if needed": a phase with
 *  `if` whose prerequisite has not settled, or a phase of a round of a while
 *  repeat after the agent whose field decides whether the round goes on. */
function awaitsDecision(control: CommittedWorkflowControl, node: AgentNode): boolean {
  if (node.state._tag !== "pending") return false;
  if (node.condition !== null) return true;
  const { ownership } = node;
  if (ownership._tag !== "round") return false;
  const repeat = control.graph.nodes.find(({ id }) => id === ownership.parentNodeId);
  return repeat?.kind === "repeat" && afterEvaluator(control, repeat, node, ownership.round) && evaluatorDecision(control, repeat, ownership.round) === undefined;
}

/** Whether an agent node projects as a `chain` that holds its executions:
 *  it has a `then` chain of control from before phases, or more than one
 *  execution position. */
function agentChains(node: AgentNode, attempts: readonly Attempt[]): boolean {
  return node.followUpV10 !== undefined || executionLineages(attempts).length > 1;
}


/** The agents of a control node that runs agents: its executions, each
 *  with its retries, and, for a `then` chain or the body of a `for` or a
 *  `while` of control from before phases, the agents that it has planned
 *  but not started. An agent node with one execution is one agent whose id
 *  is the node's; an execution of a node that runs several takes the id of
 *  its first attempt, and names its node in `nodeId`. `parentId` is the
 *  phase that each wrapper gives it. */
function executionAgents(control: CommittedWorkflowControl, node: Extract<LogicalNode, { kind: "agent" | "for" | "while" }>, attempts: readonly Attempt[], agentName: (id: string) => string): (WorkflowTreeAgent & { readonly round?: number })[] {
  const lineages = executionLineages(attempts);
  const several = node.kind !== "agent" || agentChains(node, attempts);
  const parents = new Set(attempts.filter((attempt) => !repeatsParent(attempt)).map(({ parentAttemptId }) => parentAttemptId));
  const evaluatorIndex = node.kind === "while" ? node.body.findIndex(({ step }) => step === node.evaluator.step) : -1; // stored key of control v10
  const conditional = new Set<string>();
  // A run that can no longer go on never makes the decision, so its
  // undecided agents read skipped.
  const undecided = new Set<string>();
  if (node.kind === "agent" && awaitsDecision(control, node)) {
    for (const attempt of attempts) {
      if (attempt.state._tag === "pending") (canRun(control, node, attempt) ? conditional : undecided).add(attempt.id);
    }
  }
  if (node.kind === "while") {
    for (const evaluator of attempts.filter((attempt) => attempt.provenance._tag === "authored" && attempt.definitionId === node.evaluator.step && canRun(control, node, attempt))) { // stored key of control v10
      for (const attempt of attempts) {
        if (attempt.provenance._tag === "authored" && attempt.sequence > evaluator.sequence && attempt.state._tag === "pending") conditional.add(attempt.id);
      }
    }
  }
  const nodeReason = "reason" in node.state ? node.state.reason : undefined;
  const planned = (anchor: string, units: readonly PlannedUnit[], reachable: boolean): WorkflowTreeAgent[] => {
    let gated = false;
    return units.map((unit, index) => {
      gated ||= unit.gated;
      return {
        id: `${anchor}:planned:${index + 1}`, kind: "agent", definitionId: unit.definitionId, nodeId: node.id,
        label: agentName(unit.definitionId), parentId: null, attempts: 0,
        disposition: !reachable ? "skipped" : gated ? "conditional" : "pending",
        ...(nodeReason === undefined ? {} : { reason: nodeReason }),
      };
    });
  };
  if (lineages.length === 0 && node.kind === "for") return planned(node.id, node.body.map(({ step }) => ({ definitionId: step, gated: false })), canRun(control, node, undefined)); // stored key of control v10
  const agents = lineages.flatMap((lineage, position): (WorkflowTreeAgent & { readonly round?: number })[] => {
    // SAFETY: executionLineages creates each lineage with its first attempt.
    const first = lineage[0]!;
    // SAFETY: executionLineages never emits an empty lineage.
    const current = lineage.find(({ state }) => state._tag === "running") ?? lineage.at(-1)!;
    const skipped = nodeIsSkipped(node.state) && current.state._tag === "pending";
    const disposition: WorkflowTreeDisposition = skipped || nodeIsSkipped(node.state) || current.state._tag === "blocked" || current.state._tag === "skipped" || undecided.has(current.id) ? "skipped"
      : conditional.has(current.id) ? "conditional" : current.state._tag;
    const reason = skipped ? nodeReason : "reason" in current.state ? current.state.reason : undefined;
    const evidence = treeEvidence(current);
    const agent: WorkflowTreeAgent & { readonly round?: number } = {
      id: several ? first.id : node.id, kind: "agent", definitionId: current.definitionId,
      label: node.kind === "agent" && first.definitionId === node.definitionId ? node.name : agentName(current.definitionId),
      parentId: null, disposition, attempts: lineage.length, currentAttemptId: current.id,
      ...(several ? { nodeId: node.id } : {}),
      ...(reason === undefined ? {} : { reason }), ...(evidence === undefined ? {} : { evidence }),
      ...(node.kind === "while" ? { round: Math.floor(position / node.body.length) + 1 } : {}),
    };
    if (!several || parents.has(current.id)) return [agent];
    let units: PlannedUnit[] = [];
    if (node.kind === "agent") units = chainUnits(followUpForAttempt(control, node, current, CURRENT_PROPOSAL_ENCODING));
    else if (node.kind === "for") units = forBodyRemainder(control, node, current).map(({ step }) => ({ definitionId: step, gated: false })); // stored key of control v10
    else if (current.definitionId === node.evaluator.step) { // stored key of control v10
      const compiledTail = attempts.some((attempt) => current.provenance._tag === "authored" && attempt.provenance._tag === "authored" && attempt.sequence > current.sequence);
      if (!compiledTail) units = node.body.slice(evaluatorIndex + 1).map(({ step }) => ({ definitionId: step, gated: true })); // stored key of control v10
    }
    const round = node.kind === "while" ? { round: Math.floor(position / node.body.length) + 1 } : {};
    return [agent, ...planned(first.id, units, canRun(control, node, current)).map((next) => ({ ...next, ...round }))];
  });
  return agents;
}

/** The round of a node that a round of a repeat owns, as every surface
 *  shows it: the number of the round whose check the node leads to
 *  (`shownRound`), and how that round ended once the repeat decided. Every
 *  run reaches round 1 of a `while` repeat, so it shows no round there,
 *  except on a list that is its own evaluator, whose join line names the
 *  round that each of its runs decides. */
function treeRound(control: CommittedWorkflowControl, node: LogicalNode): WorkflowTreePhase["round"] {
  if (node.ownership._tag !== "round") return undefined;
  const repeat = nodeById(control, node.ownership.parentNodeId);
  if (repeat?.kind !== "repeat") throw new Error(`Workflow invariant rejected round node "${node.id}" outside a repeat`);
  const number = shownRound(control, repeat, node, node.ownership.round);
  const { loop } = repeat;
  if (number === 1 && loop._tag === "while" && !(node.kind === "list" && inRound(loop.evaluator, repeat.id, 1, roundOfNodeId(node.id)?.run) === node.id)) return undefined;
  const outcome = roundOutcome(control, repeat, number);
  return { number, ...(outcome === undefined ? {} : { outcome }) };
}

/** The id that round `number` of the same run gives the round 1 node
 *  `nodeId` of a repeat. */
function toRound(nodeId: string, repeatNodeId: string, number: number): string {
  const place = roundOfNodeId(nodeId);
  return place === null ? nodeId : inRound(`${repeatNodeId}:round:1${place.rest}`, repeatNodeId, number, place.run);
}

/** A phase of one agent around `agent`. */
function singlePhase(agent: WorkflowTreeAgent, parentId: string | null, round: WorkflowTreePhase["round"]): WorkflowTreeNode[] {
  const id = `${agent.id}:phase`;
  const phase: WorkflowTreePhase = {
    id, kind: "phase", form: "single", phaseId: agent.definitionId, label: agent.label, parentId,
    disposition: agent.disposition, ...(agent.reason === undefined ? {} : { reason: agent.reason }),
    ...(round === undefined ? {} : { round }),
  };
  return [phase, { ...agent, parentId: id }];
}

/** Project committed control into its complete operational hierarchy.
 * Names resolve from the same agents as attempt rows; this function writes no facts. */
export function workflowTree(control: CommittedWorkflowControl, agentName: (definitionId: string) => string): WorkflowTree {
  const { graph } = control;
  const running = control.attempts.find(({ state }) => state._tag === "running");
  const open = control.status === "ready" || control.status === "executing" || control.status === "paused";
  const current = running ?? (open ? readyAttempt(control) : undefined);
  const nodes = graph.nodes.toSorted((a, b) => a.order - b.order);
  const attemptsByNode = Map.groupBy(control.attempts, ({ logicalNodeId }) => logicalNodeId);
  const attemptsOf = (id: string): readonly Attempt[] => attemptsByNode.get(id) ?? [];
  const currentAttempt = (id: string): Attempt | undefined => {
    const attempts = attemptsOf(id);
    return attempts.find(({ state }) => state._tag === "running") ?? attempts.at(-1);
  };
  const dispositions = new Map(nodes.map((node) => [node.id, treeDisposition(node, attemptsOf(node.id))]));
  const parentOf = new Map(nodes.map((node) => [node.id, node.ownership._tag === "workflow" ? null : node.ownership.parentNodeId]));
  // The tree shows the current run of each list and repeat; the nodes of
  // their earlier runs are history that it leaves out.
  const superseded = rerunSupersededIds(graph);
  const owned = Map.groupBy(nodes.filter(({ id }) => !superseded.has(id)), ({ id }) => parentOf.get(id) ?? null);
  const before = new Map([...Map.groupBy(graph.dependencies, ({ nodeId }) => nodeId)].map(([id, edges]) => [id, edges.map(({ dependsOn }) => dependsOn)]));
  const leafReasons = new Map<string, string>();
  for (const node of nodes) {
    const failed = currentAttempt(node.id)?.state;
    if (isContainerNode(node) || failed?._tag !== "failed") continue;
    for (let owner = parentOf.get(node.id); owner; owner = parentOf.get(owner)) {
      if (!leafReasons.has(owner)) leafReasons.set(owner, failed.reason);
    }
  }
  /** A phase or a list whose `if` has not decided reads as conditional. */
  const containerDisposition = (node: LogicalNode): WorkflowTreeDisposition => {
    const own = dispositions.get(node.id) ?? "pending";
    return own === "pending" && "condition" in node && node.condition !== null && canRun(control, node, undefined) ? "conditional" : own;
  };
  const reasonOf = (node: LogicalNode) => {
    const reason = treeReason(node, undefined, leafReasons);
    return reason === undefined ? {} : { reason };
  };
  /** The one agent of an agent node that runs a single execution, or
   *  undefined for a node whose executions are phases of their own. */
  const plainAgent = (node: LogicalNode): WorkflowTreeAgent | undefined => {
    if (node.kind !== "agent" || agentChains(node, attemptsOf(node.id))) return undefined;
    const [agent] = executionAgents(control, node, attemptsOf(node.id), agentName);
    if (agent !== undefined) return agent;
    const disposition = awaitsDecision(control, node) ? canRun(control, node, undefined) ? "conditional" : "skipped" : treeDisposition(node, []);
    return { id: node.id, kind: "agent", definitionId: node.definitionId, label: node.name, parentId: null, disposition, attempts: 0, ...reasonOf(node) };
  };

  const listPhases = (list: Extract<LogicalNode, { kind: "list" }>, parentId: string | null): WorkflowTreeNode[] => {
    const join = treeJoin(control, list, dispositions);
    const expanded = listJoin(graph, list.id) !== undefined;
    const own = expanded || canRun(control, list, undefined) ? containerDisposition(list) : "skipped";
    const items = (owned.get(list.id) ?? []).filter((node): node is Extract<LogicalNode, { kind: "item" }> => node.kind === "item").toSorted((a, b) => a.ordinal - b.ordinal);
    const round = treeRound(control, list);
    return list.phases.flatMap(({ definitionId, name }, place): WorkflowTreeNode[] => {
      const id = `${list.id}:phase:${place + 1}`;
      const agents = items.flatMap((item): WorkflowTreeAgent[] => {
        const node = (owned.get(item.id) ?? []).filter(({ kind }) => kind === "agent")[place];
        const agent = node === undefined ? undefined : plainAgent(node);
        if (agent === undefined) return [];
        const text = oneLine(typeof item.item === "string" ? item.item : JSON.stringify(item.item));
        return [{ ...agent, parentId: id, item: { nodeId: item.id, key: item.key, label: item.label, ordinal: item.ordinal, text } }];
      });
      const last = place === list.phases.length - 1;
      const disposition = !expanded || own === "skipped" ? own
        : last && (own === "completed" || own === "failed") ? own
          : agents.length > 0 && agents.every(({ disposition: one }) => one === "completed" || one === "failed" || one === "skipped") ? "completed"
            : agents.some(({ disposition: one }) => one === "running" || one === "completed" || one === "failed") ? "running"
              : agents.length > 0 && agents.every(({ disposition: one }) => one === "conditional") ? "conditional" : "pending";
      const phase: WorkflowTreePhase = {
        id, kind: "phase", form: "list", phaseId: definitionId, label: name, parentId, disposition,
        ...(disposition === "skipped" || disposition === "failed" ? reasonOf(list) : {}),
        ...(round === undefined ? {} : { round }),
        list: { id: list.id, expanded },
        ...(last && join !== undefined ? { join } : {}),
      };
      return [phase, ...agents];
    });
  };

  /** The phases of the nodes that one owner holds in order. Agents that an
   *  `after` order of control from before phases lets run at once share
   *  one parallel phase; control of phases orders every phase after the one
   *  before, so it has none. */
  const flowPhases = (flow: readonly LogicalNode[], parentId: string | null): WorkflowTreeNode[] => {
    const spans = new Map<string, readonly LogicalNode[]>();
    for (const span of concurrentSpans(flow, before)) {
      if (span.every((member) => plainAgent(member) !== undefined)) {
        // SAFETY: concurrentSpans emits only spans with at least two nodes.
        spans.set(span[0]!.id, span);
      }
    }
    const inSpan = new Set([...spans.values()].flat().map(({ id }) => id));
    return flow.flatMap((node): WorkflowTreeNode[] => {
      const span = spans.get(node.id);
      if (span !== undefined) return parallelPhase(`${node.id}:span`, "parallel", "Parallel agents", span, parentId, undefined, treeRound(control, node));
      if (inSpan.has(node.id)) return [];
      return nodePhases(node, parentId);
    });
  };

  const parallelPhase = (id: string, phaseId: string, label: string, members: readonly LogicalNode[], parentId: string | null, container: Extract<LogicalNode, { kind: "phase" }> | undefined, round: WorkflowTreePhase["round"]): WorkflowTreeNode[] => {
    const memberIds = new Set(members.map((member) => member.id));
    const agents = members.map((member): WorkflowTreeAgent => {
      // SAFETY: a parallel phase holds only nodes that plainAgent projects.
      const agent = plainAgent(member)!;
      const waitsOn = (before.get(member.id) ?? []).filter((prior) => memberIds.has(prior));
      return { ...agent, parentId: id, ...(waitsOn.length === 0 ? {} : { waitsOn }) };
    });
    const join = container === undefined || !isJoinNode(container) ? undefined : treeJoin(control, container, dispositions);
    const disposition = container === undefined ? sumDisposition(agents) : containerDisposition(container);
    const phase: WorkflowTreePhase = {
      id, kind: "phase", form: "parallel", phaseId, label, parentId, disposition,
      ...(container === undefined || (disposition !== "failed" && disposition !== "skipped") ? {} : reasonOf(container)),
      ...(round === undefined ? {} : { round }),
      ...(join === undefined ? {} : { join }),
    };
    return [phase, ...agents];
  };

  const nodePhases = (node: LogicalNode, parentId: string | null): WorkflowTreeNode[] => {
    const round = treeRound(control, node);
    switch (node.kind) {
      case "agent": {
        const agent = plainAgent(node);
        if (agent !== undefined) return singlePhase(agent, parentId, round);
        return executionAgents(control, node, attemptsOf(node.id), agentName).flatMap((execution) => singlePhase(execution, parentId, round));
      }
      case "for":
        return executionAgents(control, node, attemptsOf(node.id), agentName).flatMap((execution) => singlePhase(execution, parentId, round));
      case "while": {
        const lineages = executionLineages(attemptsOf(node.id));
        const repeat: WorkflowTreeNode = {
          id: node.id, kind: "repeat", label: node.body.map(({ step }) => agentName(step)).join(" → "), parentId, // stored key of control v10
          disposition: dispositions.get(node.id) ?? "pending", ...reasonOf(node), loop: whileLoop(node, lineages),
        };
        return [repeat, ...executionAgents(control, node, attemptsOf(node.id), agentName).flatMap(({ round: number, ...execution }) =>
          singlePhase(execution, node.id, number === undefined ? undefined : { number }))];
      }
      case "phase": {
        const children = owned.get(node.id) ?? [];
        if (children.length > 0 && children.every((child) => plainAgent(child) !== undefined)) {
          return parallelPhase(node.id, node.phaseId, node.name, children, parentId, node, round);
        }
        // A phase container of control from before phases that holds more
        // than agents shows its contents as phases of their own.
        return flowPhases(children, parentId);
      }
      case "list":
        return listPhases(node, parentId);
      case "repeat": {
        const repeat: WorkflowTreeNode = {
          id: node.id, kind: "repeat", label: node.name, parentId,
          disposition: dispositions.get(node.id) ?? "pending", ...reasonOf(node), loop: repeatLoop(control, node, current, superseded),
        };
        // Each round runs after the round before, which no dependency edge
        // states, so each round is a flow of its own.
        const reached = (owned.get(node.id) ?? []).filter((child) => !leadsToNoCheck(control, node, child));
        const rounds = Map.groupBy(reached, (child) => child.ownership._tag === "round" ? child.ownership.round : 0);
        return [repeat, ...[...rounds.values()].flatMap((children) => flowPhases(children, node.id)), ...plannedRounds(node)];
      }
      case "item":
        // An item is never in a flow: its list projects its agents.
        return [];
    }
  };

  /** The rounds of a repeat over items that no round has started yet, with
   *  the phases of round 1 under the ids that each round will give them, so
   *  the tree shows every item that the repeat can still reach. A repeat
   *  that reads its items when it opens plans none until then. */
  const plannedRounds = (repeat: RepeatNode): WorkflowTreeNode[] => {
    if (repeat.loop._tag !== "each" || repeat.loop.items === null) return [];
    const rounds = owned.get(repeat.id) ?? [];
    const latest = rounds.reduce((round, candidate) => candidate.ownership._tag === "round" ? Math.max(round, candidate.ownership.round) : round, 0);
    const template = rounds.filter((candidate) => candidate.ownership._tag === "round" && candidate.ownership.round === 1);
    const disposition: WorkflowTreeDisposition = canRun(control, repeat, undefined) ? "pending" : "skipped";
    return repeat.loop.items.slice(latest).flatMap((_, index) => {
      const number = latest + index + 1;
      const round = { number };
      return template.flatMap((node): WorkflowTreeNode[] => {
        const id = toRound(node.id, repeat.id, number);
        const planned = (agent: LogicalNode & { readonly kind: "agent" }, phaseId: string): WorkflowTreeAgent => ({
          id: toRound(agent.id, repeat.id, number), kind: "agent", definitionId: agent.definitionId, label: agent.name, parentId: phaseId, disposition, attempts: 0,
        });
        switch (node.kind) {
          case "agent": return singlePhase(planned(node, ""), repeat.id, round);
          case "phase": {
            const agents = (owned.get(node.id) ?? []).flatMap((child) => child.kind === "agent" ? [planned(child, id)] : []);
            return [{ id, kind: "phase", form: "parallel", phaseId: node.phaseId, label: node.name, parentId: repeat.id, disposition, round }, ...agents];
          }
          case "list":
            return node.phases.map(({ definitionId, name }, place): WorkflowTreeNode => ({
              id: `${id}:phase:${place + 1}`, kind: "phase", form: "list", phaseId: definitionId, label: name, parentId: repeat.id, disposition, round,
              list: { id, expanded: false },
            }));
          default: return [];
        }
      });
    });
  };

  const projected = flowPhases(owned.get(null) ?? [], null);
  const currentAgentNodeId = current === undefined ? undefined : projected.find((node) => node.kind === "agent" && node.currentAttemptId === current.id)?.id;
  return { nodes: projected, ...(currentAgentNodeId === undefined ? {} : { currentAgentNodeId }) };
}
