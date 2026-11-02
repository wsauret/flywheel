import type { CommittedWorkflowControl } from "./committed-control.js";
import { CURRENT_PROPOSAL_ENCODING, type WorkflowProposalEncoding, type WorkflowProposalEvent } from "./events.js";
import { attemptNodeIdOf, inRound, roundOfNodeId, type Attempt, type LogicalNode, type RepeatNode } from "./graph-types.js";
import { startRepeatRun } from "./repeat-transitions.js";
import { WORKFLOW_INPUT_SOURCE_ID } from "../workflow-schema.js";
import { continuationAttempt, lastRunAttempt, retriableFailedNodes } from "./attempt-continuation.js";
import { isContainerNode, rerunSupersededIds, withGraphOrderedEdges, withNodeState } from "./graph-changes.js";
import { completedBefore } from "./completion-order.js";
import { attemptScope, lastBodyNode } from "./list-transitions.js";
import { joinedListNodeId } from "../context-bundle/context.js";

/** What each agent record reads and passes on, by record id
 *  (`RESUME.readers`). */
type AgentReaders = Extract<WorkflowProposalEvent, { type: "RESUME" }>["readers"];

/** Reopens failed nodes with successor executions while preserving failed
 *  history, charged allocations, retry iteration, and mutation usage. From
 *  encoding 14 it also reopens the failed agents of items. The list of such
 *  an agent runs again with its expansion kept and folds its join again, and
 *  each finished agent that reads an output that changes runs again in a
 *  fresh conversation (`rerunReaders`). */
export function reopenFailedNodes(control: CommittedWorkflowControl, encoding: WorkflowProposalEncoding = CURRENT_PROPOSAL_ENCODING, readers: AgentReaders = {}): CommittedWorkflowControl {
  const retried = new Map(retriableFailedNodes(control, encoding).map((node) => [node.id, lastRunAttempt(control, node.id)]));
  if (retried.size === 0) throw new Error("Workflow invariant rejected a Resume of a failed run that holds no failed agent to run again");
  const reopened = new Set(retried.keys());
  const refolded = new Set<string>();
  const rerun = new Set<string>();
  const causedByReopened = (node: LogicalNode): boolean => (node.state._tag === "blocked" && node.state.causedBy.some((id) => reopened.has(id)))
    || (isContainerNode(node) && node.state._tag === "failed" && control.graph.nodes.some(({ id, ownership }) => ownership._tag !== "workflow" && ownership.parentNodeId === node.id && reopened.has(id)));
  for (let grew = true; grew;) {
    const caused = control.graph.nodes.filter((node) => !reopened.has(node.id) && causedByReopened(node));
    for (const { id } of caused) reopened.add(id);
    const reruns = encoding < 14 ? [] : rerunReaders(control, encoding, reopened, refolded, rerun, readers);
    for (const id of reruns) {
      reopened.add(id);
      rerun.add(id);
    }
    grew = caused.length > 0 || reruns.length > 0;
  }
  // A list or a repeat that runs again does so as a new run. The items of
  // the list, or the round nodes of the repeat, from its runs before, and
  // every node that they hold, turn to history: each names the list or the
  // repeat as its replacement (`rerunSupersededIds`), and no agent among
  // them runs again.
  const rerunLists = new Set([...rerun].filter((id) => control.graph.nodes.some((node) => node.id === id && node.kind === "list")));
  const history = new Map<string, { readonly owner: string; readonly reason: string }>();
  for (const node of control.graph.nodes.toSorted((left, right) => left.order - right.order)) {
    if (node.ownership._tag === "workflow" || node.state._tag === "superseded") continue;
    const owner = node.ownership.parentNodeId;
    const held = history.get(owner);
    if (held !== undefined) history.set(node.id, held);
    else if (rerun.has(owner) && (node.ownership._tag === "round" || (node.ownership._tag === "list" && rerunLists.has(owner)))) {
      history.set(node.id, { owner, reason: node.ownership._tag === "round" ? "Its repeat ran again" : "Its list ran again" });
    }
  }
  const attempts = control.attempts.flatMap((attempt, index): readonly Attempt[] => {
    if (history.has(attempt.logicalNodeId)) return [attempt];
    if (rerun.has(attempt.logicalNodeId)) return attempt === lastRunAttempt(control, attempt.logicalNodeId) ? [attempt, continuationAttempt(control, attempt, true)] : [attempt];
    const failed = retried.get(attempt.logicalNodeId);
    if (failed === undefined || index < control.attempts.indexOf(failed)) return [attempt];
    // Remove the old replay arm after 2027-10-17. Historical Resume commits
    // re-pend their failed attempt; current commits retain it as evidence.
    if (encoding < 13 || attempt !== failed) return [{ ...attempt, state: { _tag: "pending" } }];
    return [attempt, continuationAttempt(control, attempt)];
  });
  const reopenedControl: CommittedWorkflowControl = {
    ...control,
    attempts,
    guardrails: { ...control.guardrails, attemptMutationsUsed: attempts.map((attempt) => {
      const existing = control.guardrails.attemptMutationsUsed.find(({ attemptId }) => attemptId === attempt.id);
      const predecessor = control.guardrails.attemptMutationsUsed.find(({ attemptId }) => attemptId === attempt.parentAttemptId);
      return existing ?? { attemptId: attempt.id, used: predecessor?.used ?? 0 };
    }) },
    graph: { ...control.graph, joins: control.graph.joins.filter(({ nodeId }) => !rerunLists.has(nodeId)), nodes: control.graph.nodes.map((node) => {
      // A list that reads changed work runs again as a new run: it expands
      // again from what it reads now, beside the items of its earlier run,
      // which name it as their replacement (`rerunSupersededIds`).
      if (node.kind === "list" && rerunLists.has(node.id)) return { ...node, state: { _tag: "pending" }, admittedContext: null, settlement: null };
      const earlier = history.get(node.id);
      if (earlier !== undefined) return withNodeState(node, { _tag: "superseded", reason: earlier.reason, replacementNodeId: earlier.owner });
      // A list that only a failed item reopens keeps its expansion, which
      // never changes: it runs again with its items and its frozen context,
      // and settles once its items do.
      if (node.kind === "list" && refolded.has(node.id)) return { ...node, state: { _tag: "running" }, settlement: null };
      return reopened.has(node.id) ? withNodeState(node, { _tag: "pending" }) : node;
    }) },
  };
  const restarted = [...rerun].flatMap((id) => {
    const repeat = reopenedControl.graph.nodes.find((candidate) => candidate.id === id);
    return repeat?.kind === "repeat" ? [repeat] : [];
  }).reduce(rerunRepeat, reopenedControl);
  return rerun.size === 0 ? restarted : waitForChangedWork(restarted, rerun, new Set([...reopened, ...refolded]));
}

/** Run a completed repeat again as a new run, after its earlier runs'
 *  nodes turned to history: the new run starts at round 1 with no signal
 *  from the run before. A repeat over items reads them again when it opens,
 *  except over the launch input, which control does not keep, so it keeps
 *  the items that it froze. */
function rerunRepeat(control: CommittedWorkflowControl, repeat: RepeatNode): CommittedWorkflowControl {
  const loop: RepeatNode["loop"] = repeat.loop._tag === "while"
    ? { ...repeat.loop, priorSignal: null }
    : repeat.loop.source.nodeId === WORKFLOW_INPUT_SOURCE_ID ? repeat.loop : { ...repeat.loop, items: null };
  const reset: RepeatNode = { ...repeat, state: { _tag: "pending" }, loop };
  return startRepeatRun({ ...control, graph: { ...control.graph, nodes: control.graph.nodes.map((node) => node.id === repeat.id ? reset : node) } }, reset);
}

/** Make each rerun wait for the work before it that runs again. A rerun
 *  that reads a later output through a finished agent between them, which
 *  keeps its result, would otherwise start at once and read the earlier
 *  output. Each edge joins the top-level nodes that hold the two, and it
 *  repeats an order that the graph already implies, so it changes no
 *  bundle. */
function waitForChangedWork(control: CommittedWorkflowControl, rerun: ReadonlySet<string>, changed: ReadonlySet<string>): CommittedWorkflowControl {
  const byId = new Map(control.graph.nodes.map((node) => [node.id, node]));
  const topLevel = (id: string): string => {
    let current = byId.get(id);
    while (current !== undefined && current.ownership._tag !== "workflow") current = byId.get(current.ownership.parentNodeId);
    return current?.id ?? id;
  };
  const dependencies = [...control.graph.dependencies];
  const edges = new Set(dependencies.map(({ nodeId, dependsOn }) => `${nodeId}\u0000${dependsOn}`));
  for (const id of rerun) {
    const nodeId = topLevel(id);
    for (const before of completedBefore(control.graph, id)) {
      const dependsOn = topLevel(before);
      const key = `${nodeId}\u0000${dependsOn}`;
      if (!changed.has(before) || dependsOn === nodeId || edges.has(key)) continue;
      edges.add(key);
      dependencies.push({ nodeId, dependsOn });
    }
  }
  return withGraphOrderedEdges({ ...control, graph: { ...control.graph, dependencies } });
}

/** One pass of the Resume closure at encoding 14: record in `refolded` the
 *  completed list of each reopened agent of an item, and return each
 *  finished agent, list, or repeat outside every list and repeat that reads
 *  an output that changes, with the completed phase that holds it. An output
 *  changes when its agent runs again, or when its list, phase, or repeat
 *  runs or folds its join again. An agent reads an output that its record
 *  declares in `reads`, or that is the last entry of its bundle when that
 *  output has a transient write, which it read as its prior handoff
 *  (`priorOf` in the context accumulator). A list or a repeat reads what its
 *  source, its frozen context, and the agents that it holds read. An agent's
 *  durable artifacts reach every later agent, so they are no read that
 *  reruns it. A list or a repeat that reads changed work runs again in full
 *  as a new run, so the agents that it holds are not rerun one by one. */
function rerunReaders(control: CommittedWorkflowControl, encoding: WorkflowProposalEncoding, reopened: ReadonlySet<string>, refolded: Set<string>, rerun: ReadonlySet<string>, readers: AgentReaders): readonly string[] {
  const node = (id: string): LogicalNode | undefined => control.graph.nodes.find((candidate) => candidate.id === id);
  for (const id of reopened) {
    const agent = node(id);
    const item = agent?.ownership._tag === "item" ? node(agent.ownership.parentNodeId) : undefined;
    if (item?.ownership._tag === "list" && node(item.ownership.parentNodeId)?.state._tag === "completed") refolded.add(item.ownership.parentNodeId);
  }
  // A repeat that runs again changes the output of every node that its
  // rounds hold, and a node of any round changes the output of its repeat,
  // which holds every round.
  const changedNodes = [...reopened, ...refolded, ...control.graph.nodes.flatMap(({ id }) => {
    const place = roundOfNodeId(id);
    return place !== null && reopened.has(place.repeatNodeId) ? [id] : [];
  })];
  const changed = new Set(changedNodes.flatMap((id) => {
    const place = roundOfNodeId(id);
    return place === null ? [id] : [id, place.repeatNodeId];
  }));
  // A record declares a read of a node of a repeat by the id of its copy in
  // the first run's round 1, which the compiler wrote. A reader in the same
  // repeat reads the copy in its own round, and any other reader reads every
  // round.
  const changedCompiled = new Set(changedNodes.map((id) => {
    const place = roundOfNodeId(id);
    return place === null ? id : `${place.repeatNodeId}:round:1${place.rest}`;
  }));
  // The node of the entry that an agent read as its prior handoff, or null
  // when the entry writes nothing transient, so the agent read no prior.
  const priorSource = (entryId: string): string | null => {
    const source = node(attemptNodeIdOf(entryId) ?? joinedListNodeId(entryId) ?? "");
    if (source?.kind === "agent") return readers[source.definitionId]?.transient === true ? source.id : null;
    const body = source?.kind === "repeat" ? lastBodyNode(control, source.id) : source;
    const write = body?.kind === "list" ? body.write : body?.kind === "phase" ? body.join?.write : undefined;
    return source !== undefined && write?.lifetime === "transient" ? source.id : null;
  };
  const outsideListsAndRepeats = (candidate: LogicalNode): boolean => {
    for (let current: LogicalNode | undefined = candidate; current !== undefined; current = current.ownership._tag === "workflow" ? undefined : node(current.ownership.parentNodeId)) {
      if (current.ownership._tag !== "workflow" && current.ownership._tag !== "phase") return false;
    }
    return true;
  };
  const declares = (reader: LogicalNode, definitionId: string): boolean => {
    const place = roundOfNodeId(reader.id);
    return (readers[definitionId]?.reads ?? []).some((id) => place !== null && roundOfNodeId(id)?.repeatNodeId === place.repeatNodeId
      ? changed.has(inRound(id, place.repeatNodeId, place.round, place.run))
      : changedCompiled.has(id));
  };
  const readsPrior = (entryId: string | undefined): boolean => {
    const source = entryId === undefined ? null : priorSource(entryId);
    return source !== null && changed.has(source);
  };
  // A list reads its source list and the context that it froze for its
  // items, and its agents read what their records declare. An agent reads
  // what its record declares and its prior handoff.
  const reads = (candidate: LogicalNode): boolean => {
    if (candidate.kind === "list") return changed.has(candidate.source.nodeId) || candidate.phases.some(({ definitionId }) => declares(candidate, definitionId)) || readsPrior(candidate.admittedContext?.at(-1));
    if (candidate.kind !== "agent") return false;
    if (declares(candidate, candidate.definitionId)) return true;
    const attempt = lastRunAttempt(control, candidate.id);
    return readsPrior(attempt === undefined ? undefined : attemptScope(control, attempt, encoding).sharedEntryIds?.at(-1));
  };
  // A repeat reads its items' source and what the nodes of its current run
  // read.
  const superseded = rerunSupersededIds(control.graph);
  const repeatReads = (repeat: RepeatNode): boolean => (repeat.loop._tag === "each" && changed.has(repeat.loop.source.nodeId))
    || control.graph.nodes.some((candidate) => !superseded.has(candidate.id) && roundOfNodeId(candidate.id)?.repeatNodeId === repeat.id && reads(candidate));
  const reruns = control.graph.nodes.filter((candidate) => candidate.state._tag === "completed" && !rerun.has(candidate.id) && outsideListsAndRepeats(candidate)
    && (candidate.kind === "repeat" ? repeatReads(candidate) : reads(candidate))).map(({ id }) => id);
  const phases = reruns.flatMap((id) => {
    const owner = node(id)?.ownership;
    return owner?._tag === "phase" && node(owner.parentNodeId)?.state._tag === "completed" ? [owner.parentNodeId] : [];
  });
  return [...new Set([...reruns, ...phases])].filter((id) => !reopened.has(id));
}
