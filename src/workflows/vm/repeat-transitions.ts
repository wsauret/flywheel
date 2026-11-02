import type { CommittedWorkflowControl } from "./committed-control.js";
import type { WorkflowProposalEncoding } from "./events.js";
import { applyGraphChanges, listJoin, replaceNode, withNodeState, type GraphChange } from "./graph-changes.js";
import { inRound, repeatRun, roundOfNodeId, type Attempt, type LogicalNode, type RepeatNode } from "./graph-types.js";
import { isNonEmpty, normalizedSignal } from "./loop-signal.js";
import { WORKFLOW_INPUT_SOURCE_ID } from "../workflow-schema.js";
import { isJoinNode, joinOf, nodeById, nodeOutput, outputAsRead, requireItem, TERMINAL } from "./node-outputs.js";
import { admitStructureChange, queuedAttempts } from "./structural-admission.js";

// Pure repeat transitions. A repeat owns, in each round, a copy of its body:
// round 1 is compiled, and each later round copies round 1 once the round
// before it finishes. A `while` repeat decides when its evaluator settles; an
// `each` repeat runs one round for each item of its frozen list. They run
// inside `prepareExecution`, so strict replay derives them again from the
// committed events.

/** The node states that mean the work did not complete. */
const UNFINISHED: ReadonlySet<LogicalNode["state"]["_tag"]> = new Set(["failed", "blocked"]);

/** The round of a repeat that a node sits in, or undefined outside every
 *  round. A node that a round owns names it; any other node of a round, such
 *  as a named agent or an item, inherits it from its owner. */
function roundOf(control: CommittedWorkflowControl, node: LogicalNode): { readonly repeatNodeId: string; readonly run: number; readonly round: number } | undefined {
  for (let current: LogicalNode | undefined = node; current !== undefined;) {
    if (current.ownership._tag === "round") return { repeatNodeId: current.ownership.parentNodeId, run: roundOfNodeId(current.id)?.run ?? 1, round: current.ownership.round };
    if (current.ownership._tag === "workflow") return undefined;
    current = nodeById(control, current.ownership.parentNodeId);
  }
  return undefined;
}

/** Every node of one round of a run of a repeat, in graph order. */
function roundNodes(control: CommittedWorkflowControl, repeatNodeId: string, round: number, run: number): readonly LogicalNode[] {
  return control.graph.nodes
    .filter((node) => {
      const place = roundOf(control, node);
      return place?.repeatNodeId === repeatNodeId && place.run === run && place.round === round;
    })
    .toSorted((left, right) => left.order - right.order);
}

/** The latest round of the current run of a repeat that exists. */
export function latestRound(control: CommittedWorkflowControl, repeat: RepeatNode): number {
  const run = repeatRun(control.graph, repeat.id);
  return control.graph.nodes.reduce((latest, node) =>
    node.ownership._tag === "round" && node.ownership.parentNodeId === repeat.id && (roundOfNodeId(node.id)?.run ?? 1) === run ? Math.max(latest, node.ownership.round) : latest, 0);
}

/** The nodes of the first run's round 1 that each later round of every run
 *  copies: the nodes that the round owns and the named agents of its phases.
 *  A list's items are not copied, because each round's list expands again. */
function templateNodes(control: CommittedWorkflowControl, repeat: RepeatNode): readonly LogicalNode[] {
  const template = new Set<string>();
  const nodes = control.graph.nodes.toSorted((left, right) => left.order - right.order);
  for (const node of nodes) {
    const { ownership } = node;
    if ((ownership._tag === "round" && ownership.parentNodeId === repeat.id && ownership.round === 1 && roundOfNodeId(node.id)?.run === 1)
      || (ownership._tag === "phase" && template.has(ownership.parentNodeId))) template.add(node.id);
  }
  return nodes.filter(({ id }) => template.has(id));
}

/** One node of round 1 as round `round` of run `run` holds it: its ids,
 *  owner, and references moved to the round, its state pending, and its
 *  join and expansion not started. */
function copiedNode(node: LogicalNode, repeat: RepeatNode, round: number, run: number): LogicalNode {
  const move = (id: string): string => inRound(id, repeat.id, round, run);
  const ownership: LogicalNode["ownership"] = node.ownership._tag === "round"
    ? { ...node.ownership, round }
    : node.ownership._tag === "workflow" ? node.ownership : { ...node.ownership, parentNodeId: move(node.ownership.parentNodeId) };
  const base = { id: move(node.id), ownership, state: { _tag: "pending" } as const };
  switch (node.kind) {
    case "agent": return { ...node, ...base, condition: node.condition === null ? null : { ...node.condition, nodeId: move(node.condition.nodeId) } };
    case "phase": return {
      ...node,
      ...base,
      condition: node.condition === null ? null : { ...node.condition, nodeId: move(node.condition.nodeId) },
      join: node.join === null ? null : { ...node.join, settlement: null },
    };
    case "list": return {
      ...node,
      ...base,
      source: { ...node.source, nodeId: move(node.source.nodeId) },
      condition: node.condition === null ? null : { ...node.condition, nodeId: move(node.condition.nodeId) },
      admittedContext: null,
      settlement: null,
    };
    default: throw new Error(`Workflow invariant rejected a ${node.kind} node "${node.id}" in the body of repeat "${repeat.id}"`);
  }
}

/** The item of round `round` of an `each` repeat, or null for any other
 *  repeat. */
function roundItem(repeat: RepeatNode, round: number): Attempt["item"] {
  return repeat.loop._tag === "each" ? repeat.loop.items?.[round - 1] ?? null : null;
}

/** Add round `round` of run `run` of a repeat after the last node of the
 *  round before, or a new run's round 1 after the last node of the run
 *  before: a copy of round 1's nodes and of the edges that start at them,
 *  whose attempts carry the round's item. Structural admission counted every
 *  round at launch, so a round charges no insert, and admission of the new
 *  nodes only asserts that invariant. */
function startRound(control: CommittedWorkflowControl, repeat: RepeatNode, round: number, run = repeatRun(control.graph, repeat.id)): CommittedWorkflowControl {
  const template = templateNodes(control, repeat);
  const ids = new Set(template.map(({ id }) => id));
  const item = roundItem(repeat, round);
  const changes: GraphChange[] = [
    ...template.map((node): GraphChange => ({ kind: "add_node", node: copiedNode(node, repeat, round, run), item })),
    ...control.graph.dependencies.flatMap((edge): GraphChange[] => ids.has(edge.nodeId)
      ? [{ kind: "add_dependency", dependency: { nodeId: inRound(edge.nodeId, repeat.id, round, run), dependsOn: inRound(edge.dependsOn, repeat.id, round, run) } }]
      : []),
  ];
  const previous = round === 1
    ? control.graph.nodes.filter((node) => node.ownership._tag === "round" && node.ownership.parentNodeId === repeat.id)
    : roundNodes(control, repeat.id, round - 1, run);
  const after = lastInSubtrees(control, previous.map(({ id }) => id));
  const proposed = applyGraphChanges(control, changes, () => ({ _tag: "round", index: round }), after ?? repeat.id);
  admitStructureChange(control, proposed);
  return proposed;
}

/** Start the next run of a repeat with its round 1, after the nodes of its
 *  earlier runs. */
export function startRepeatRun(control: CommittedWorkflowControl, repeat: RepeatNode): CommittedWorkflowControl {
  return startRound(control, repeat, 1, repeatRun(control.graph, repeat.id) + 1);
}

/** The last node in graph order of the subtrees of `rootIds`. */
function lastInSubtrees(control: CommittedWorkflowControl, rootIds: readonly string[]): string | undefined {
  const subtree = new Set(rootIds);
  let last: string | undefined;
  for (const node of control.graph.nodes.toSorted((left, right) => left.order - right.order)) {
    if (!subtree.has(node.id) && (node.ownership._tag === "workflow" || !subtree.has(node.ownership.parentNodeId))) continue;
    subtree.add(node.id);
    last = node.id;
  }
  return last;
}

/** How the evaluator of a `while` repeat decided its round: `dry` when the
 *  field is empty, `stuck` when it equals the round before, and `live`
 *  otherwise. A list evaluator, or a phase evaluator with a join, is dry
 *  only when every agent completed and the join kept nothing, because a
 *  failed agent did not search. An evaluator that its `if` skipped gives no
 *  signal, so the repeat stops as if dry. Undefined while the evaluator has
 *  not settled. */
export function evaluatorDecision(control: CommittedWorkflowControl, repeat: RepeatNode, round: number): { readonly decision: "dry" | "stuck" | "live"; readonly signal: string | null } | undefined {
  if (repeat.loop._tag !== "while") return undefined;
  const evaluator = nodeById(control, inRound(repeat.loop.evaluator, repeat.id, round, repeatRun(control.graph, repeat.id)));
  if (evaluator === undefined || !TERMINAL.has(evaluator.state._tag)) return undefined;
  if (evaluator.state._tag === "skipped") return { decision: "dry", signal: null };
  if (evaluator.state._tag !== "completed") return { decision: "live", signal: null };
  const value = nodeOutput(control, evaluator)?.[repeat.loop.field];
  const signal = normalizedSignal(value);
  if (isJoinNode(evaluator) && (joinOf(evaluator).settlement?.failed ?? 0) > 0) return { decision: "live", signal };
  if (!isNonEmpty(value)) return { decision: "dry", signal };
  if (repeat.loop.stuck && repeat.loop.priorSignal !== null && repeat.loop.priorSignal === signal) return { decision: "stuck", signal };
  return { decision: "live", signal };
}

/** Skip every node of a round that has not started, and each pending
 *  attempt that it holds: the repeat stopped. */
function skipRestOfRound(control: CommittedWorkflowControl, nodes: readonly LogicalNode[], reason: string): CommittedWorkflowControl {
  const open = new Set(nodes.filter((node) => node.state._tag === "pending" || node.state._tag === "ready").map(({ id }) => id));
  if (open.size === 0) return control;
  const skipped = control.graph.nodes.map((node) => open.has(node.id) ? withNodeState(node, { _tag: "skipped", reason, causedBy: [] }) : node);
  return {
    ...control,
    graph: { ...control.graph, nodes: skipped },
    attempts: control.attempts.map((attempt) => open.has(attempt.logicalNodeId) && attempt.state._tag === "pending"
      ? { ...attempt, state: { _tag: "skipped", reason } }
      : attempt),
  };
}

/** Open a ready repeat. An `each` repeat freezes its items, unless the
 *  launch froze them, and gives round 1's attempts the first item; a repeat
 *  over no items skips round 1 and completes. A source list longer than its
 *  declared width is refused as a list's source is. A list without a width
 *  is refused when the rounds of its items need more attempts than the
 *  attempt limit holds. */
export function openRepeat(control: CommittedWorkflowControl, repeat: RepeatNode): CommittedWorkflowControl | string {
  const running = replaceNode(control, repeat.id, (node) => withNodeState(node, { _tag: "running" }));
  if (repeat.loop._tag !== "each") return running;
  const { loop } = repeat;
  const items = loop.items ?? outputAsRead(control, repeat.id, loop.source.nodeId)?.[loop.source.field];
  const named = `source "${loop.source.nodeId}.${loop.source.field}"`;
  if (!Array.isArray(items)) return `${named} is not a list`;
  if (loop.width !== null && items.length > loop.width) return `${named} holds ${items.length} items, more than its declared max of ${loop.width}`;
  const frozen = replaceNode(running, repeat.id, (node) => node.kind === "repeat" && node.loop._tag === "each" ? { ...node, loop: { ...node.loop, items } } : node);
  const { maxAttempts } = frozen.guardrails;
  if (loop.width === null && queuedAttempts(frozen) > maxAttempts) return `${named} holds ${items.length} items, whose rounds need more attempts than the attempt limit of ${maxAttempts}`;
  const first = roundNodes(frozen, repeat.id, 1, repeatRun(frozen.graph, repeat.id));
  if (items.length === 0) {
    const skipped = skipRestOfRound(frozen, first, "The repeat has no items");
    return replaceNode(skipped, repeat.id, (node) => withNodeState(node, { _tag: "completed" }));
  }
  const ids = new Set(first.map(({ id }) => id));
  return {
    ...frozen,
    attempts: frozen.attempts.map((attempt) => ids.has(attempt.logicalNodeId) && attempt.state._tag === "pending" ? { ...attempt, item: items[0] ?? null } : attempt),
  };
}

/** Advance one running repeat. When the evaluator of a `while` repeat stops
 *  it, the rest of the round is skipped. From encoding 11 the evaluator of
 *  the last round, `max`, also stops it, so the repeat ends on its check and
 *  never on a repair that no check follows; before it, the rest of that
 *  round ran. Once the latest round is terminal, the repeat fails when the
 *  round did not complete, completes when it stopped, reached `max`, or ran
 *  its last item, and otherwise starts the next round. */
export function advanceRepeat(control: CommittedWorkflowControl, repeat: RepeatNode, encoding: WorkflowProposalEncoding): CommittedWorkflowControl {
  const round = latestRound(control, repeat);
  if (round === 0) return replaceNode(control, repeat.id, (node) => withNodeState(node, { _tag: "completed" }));
  const decided = evaluatorDecision(control, repeat, round);
  const lastCheck = encoding >= 11 && repeat.loop._tag === "while" && round >= repeat.loop.max;
  const stopped = decided !== undefined && (decided.decision !== "live" || lastCheck);
  const run = repeatRun(control.graph, repeat.id);
  let current = stopped ? skipRestOfRound(control, roundNodes(control, repeat.id, round, run), "The repeat stopped") : control;
  const nodes = roundNodes(current, repeat.id, round, run);
  if (!nodes.every(({ state }) => TERMINAL.has(state._tag))) return current;
  const finish = (state: LogicalNode["state"]): CommittedWorkflowControl => replaceNode(current, repeat.id, (node) => withNodeState(node, state));
  const unfinished = nodes.filter(({ state, ownership }) => UNFINISHED.has(state._tag) && ownership._tag === "round");
  if (unfinished.length > 0) return finish({ _tag: "failed", reason: `Repeat work did not complete: ${unfinished.map(({ id }) => id).join(", ")}` });
  const { loop } = repeat;
  const last = loop._tag === "while" ? stopped || round >= loop.max : round >= (loop.items?.length ?? 0);
  if (last) return finish({ _tag: "completed" });
  if (loop._tag === "while") {
    current = replaceNode(current, repeat.id, (node) => node.kind === "repeat" && node.loop._tag === "while"
      ? { ...node, loop: { ...node.loop, priorSignal: decided?.signal ?? null } }
      : node);
  }
  const advanced = nodeById(current, repeat.id);
  if (advanced?.kind !== "repeat") throw new Error(`Workflow invariant rejected missing repeat node "${repeat.id}"`);
  return startRound(current, advanced, round + 1);
}

/** The items that a list of a later round expands over when its source sits
 *  outside the repeat: the items of its run's round 1 copy, which control
 *  holds, so a round over the launch input needs no input that control does
 *  not keep. Round 1 of a later run over the launch input takes the items of
 *  the first run's round 1. Undefined for the first run's round 1, for a
 *  later run's round 1 over another source, which expands from it again,
 *  and for a list whose source is in its round. */
export function laterRoundItems(control: CommittedWorkflowControl, listNodeId: string): readonly { readonly key: string; readonly label: string; readonly item: Attempt["item"] }[] | undefined {
  const node = nodeById(control, listNodeId);
  if (node?.kind !== "list" || node.ownership._tag !== "round") return undefined;
  const repeatNodeId = node.ownership.parentNodeId;
  if (roundOfNodeId(node.source.nodeId)?.repeatNodeId === repeatNodeId) return undefined;
  const place = roundOfNodeId(node.id);
  if (place === null) throw new Error(`Workflow invariant rejected list "${node.id}" of a round without a round id`);
  const firstRound = node.ownership.round === 1;
  if (firstRound && (place.run === 1 || node.source.nodeId !== WORKFLOW_INPUT_SOURCE_ID)) return undefined;
  const firstId = inRound(`${repeatNodeId}:round:1${place.rest}`, repeatNodeId, 1, firstRound ? 1 : place.run);
  const first = listJoin(control.graph, firstId);
  if (first === undefined) throw new Error(`Workflow invariant rejected round ${node.ownership.round} of "${repeatNodeId}" before round 1 expanded`);
  return first.requiredNodeIds.flatMap((id) => {
    const { key, label, item, vote } = requireItem(control, id);
    if (vote !== undefined && vote.number !== 1) return [];
    return [vote === undefined ? { key, label, item } : { key: vote.itemKey, label: vote.itemLabel, item }];
  });
}

/** How round `round` of a repeat ended, once the repeat decided: `next`
 *  when a later round exists, `dry` when its evaluator stopped the repeat,
 *  and `bound` when the repeat completed on it without such a stop.
 *  Undefined while the round or the repeat is open, and for a round that
 *  the repeat never started. */
export function roundOutcome(control: CommittedWorkflowControl, repeat: RepeatNode, round: number): "next" | "dry" | "bound" | undefined {
  const latest = latestRound(control, repeat);
  if (latest > round) return "next";
  if (latest < round || repeat.state._tag !== "completed") return undefined;
  const decided = evaluatorDecision(control, repeat, round);
  return decided !== undefined && decided.decision !== "live" ? "dry" : "bound";
}
