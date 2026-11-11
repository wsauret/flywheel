import { buildHandoffValidatedFact, buildHandoffWrittenFact } from "../output-contract/facts.js";
import { joinEntryId } from "../context-bundle/context.js";
import type { ArtifactContractSchema } from "../artifact-contracts.js";
import { buildContextAccumulatedFact, buildContextInputAddedFact, type AddressedAddendum, type HandoffEntry, type RequestAddendumMessage } from "../context-bundle/context-facts.js";
import { queueFactsForState } from "../view/view-diff.js";
import type { WorkflowView } from "../view/types.js";
import type { ResolvedAgent } from "../agent-resolution.js";
import type { WorkflowTransitionResult } from "./commands.js";
import type { CommittedWorkflowControl } from "./committed-control.js";
import type { Attempt } from "./graph-types.js";
import { itemScopeOf, lastBodyNode, writesRepeatEntry } from "./list-transitions.js";
import { isJoinNode, joinOf, roundsOutput, type JoinNode } from "./node-outputs.js";
import { composeWorkflowProposal } from "./proposal-composition.js";
import { restateWorkflowView, workflowViewForProposal } from "./view-flatten.js";
import { parseWorkflowSessionFact, type WorkflowSessionFact } from "./session-facts.js";

export interface WorkflowCompanionInput {
  readonly queue: WorkflowView | null;
  /** Resolved agents of this workflow, keyed by definition id. */
  readonly resolvedAgents: ReadonlyMap<string, ResolvedAgent>;
  readonly timestamp: number;
  /** The parent messages that the settled attempt read and that no earlier
   *  commit recorded, in reading order. Only a commit that settles an attempt
   *  carries them (`settledAttempt`); any other commit carries none. */
  readonly addenda: readonly RequestAddendumMessage[];
  /** The held messages to the workflow, each with its address, that no
   *  earlier commit recorded. Any commit carries them, so an agent that has
   *  not started holds them before the commit that starts it is applied.
   *  Absent means none. */
  readonly addressed?: readonly AddressedAddendum[];
}

type CommittedEvent = Extract<WorkflowSessionFact, { type: "workflow.control.committed" }>["payload"]["event"];
type SettlingEvent = Extract<CommittedEvent, { type: "ATTEMPT_SUCCEEDED" | "ATTEMPT_FAILED" }>;

interface SettledAttempt {
  readonly event: SettlingEvent;
  /** The attempt as committed control held it before the event settled it. */
  readonly attempt: Attempt;
  /** Committed control before the event. */
  readonly previous: CommittedWorkflowControl;
}

/** The attempt that a commit settles: the attempt of its `ATTEMPT_SUCCEEDED`
 *  or `ATTEMPT_FAILED` event. Null for a commit of any other event. */
export function settledAttempt(proposal: WorkflowTransitionResult): SettledAttempt | null {
  if (proposal.command.kind !== "commit") return null;
  const pending = proposal.state.context.pending;
  if (!pending) throw new Error("Workflow companion builder requires matching pending control");
  const terminal = proposal.command.proposal.facts.at(-1);
  if (terminal?.type !== "workflow.control.committed") {
    throw new Error("Workflow companion builder requires a terminal control commit fact");
  }
  const event = terminal.payload.event;
  if (event.type !== "ATTEMPT_SUCCEEDED" && event.type !== "ATTEMPT_FAILED") return null;
  const attemptId = event.type === "ATTEMPT_SUCCEEDED" ? event.outcome.attemptId : event.failure.attemptId;
  const attempt = pending.previousCommitted.attempts.find(({ id }) => id === attemptId);
  if (!attempt) throw new Error(`Workflow companion builder rejected unknown attempt "${attemptId}"`);
  return { event, attempt, previous: pending.previousCommitted };
}

/** One write of a context entry, from an agent's or a join's artifact
 *  contract. The entry holds its own copy of the superseded ids. */
function entryWrite(contract: typeof ArtifactContractSchema.Type): HandoffEntry["writes"][number] {
  return contract.lifetime === "durable"
    ? { id: contract.id, lifetime: contract.lifetime, supersedes: [...contract.supersedes] }
    : { id: contract.id, lifetime: contract.lifetime };
}

function completionFacts(
  proposal: WorkflowTransitionResult,
  input: WorkflowCompanionInput,
): WorkflowSessionFact[] {
  const settled = settledAttempt(proposal);
  if (!settled) {
    if (input.addenda.length > 0) throw new Error("Workflow companion builder received request addenda for a commit that settles no attempt");
    return [];
  }
  const { event, attempt, previous } = settled;
  const node = previous.graph.nodes.find(({ id }) => id === attempt.logicalNodeId);
  const agent = input.resolvedAgents.get(attempt.definitionId);
  if (!node || !agent) throw new Error(`Workflow companion builder rejected incomplete provenance for attempt "${attempt.id}"`);
  const identity = {
    attemptId: attempt.id,
    agentName: node.kind === "agent" && attempt.definitionId === node.definitionId ? node.name : agent.name,
    definitionId: attempt.definitionId,
    workflowDefinitionId: attempt.workflowDefinitionId,
  };
  const scope = itemScopeOf(previous, attempt);
  const addenda = addendumFacts(input.addenda, identity, attempt.conversationId);
  if (event.type === "ATTEMPT_FAILED") {
    if (event.failure.kind !== "invalid_handoff") return addenda;
    return [
      ...addenda,
      ...[
        buildHandoffWrittenFact({ ...identity, content: event.failure.content }),
        buildHandoffValidatedFact({ ...identity, status: "failed", issues: event.failure.issues }),
      ].map(parseWorkflowSessionFact),
    ];
  }
  const handoff = event.outcome.handoff;
  // Only the current outcome shape holds issues; a stored historical one never does.
  const issues = "issues" in event.outcome ? event.outcome.issues : undefined;
  const contextEntry = {
    entryId: identity.attemptId,
    agentName: identity.agentName,
    definitionId: identity.definitionId,
    workflowDefinitionId: identity.workflowDefinitionId,
    recipientAttemptId: null,
    writes: agent.writes.map(entryWrite),
    timestamp: input.timestamp,
    handoff,
  };
  return [
    ...addenda,
    ...[
      buildHandoffWrittenFact({ ...identity, content: handoff }),
      // A handoff delivered after its correction ran out did not pass its
      // contract, and every reader of its validation learns why.
      buildHandoffValidatedFact({ ...identity, ...(issues === undefined ? { status: "passed", issues: [] } : { status: "failed", issues }) }),
      buildContextAccumulatedFact(contextEntry, scope),
    ].map(parseWorkflowSessionFact),
  ];
}

/** The one workflow-scope context entry of each join that the proposal
 *  settles: the reducer output, which references the agents' handoffs,
 *  under the artifact that the join writes. Then the entry of each repeat
 *  that the proposal completes and whose last phase is a join, after the
 *  join of its last round: the output of every round, under the same
 *  artifact. It is the latest entry, so the phase after the repeat receives
 *  the whole repeat as its prior handoff, and an agent that reads the phase
 *  reads it. */
function joinFacts(proposal: WorkflowTransitionResult, input: WorkflowCompanionInput): WorkflowSessionFact[] {
  const pending = proposal.state.context.pending;
  if (proposal.command.kind !== "commit" || !pending) return [];
  const proposed = pending.proposedCommitted;
  const entry = (node: JoinNode, entryId: string, handoff: HandoffEntry["handoff"]): WorkflowSessionFact => parseWorkflowSessionFact(buildContextAccumulatedFact({
    entryId,
    agentName: node.name,
    definitionId: node.kind === "list" ? node.outputId : node.phaseId,
    workflowDefinitionId: node.workflowDefinitionId,
    recipientAttemptId: null,
    writes: [entryWrite(joinOf(node).write)],
    timestamp: input.timestamp,
    handoff,
  }));
  const joins = proposal.command.proposal.facts.flatMap((fact) => {
    if (fact.type !== "group.settled") return [];
    const node = proposed.graph.nodes.find(({ id }) => id === fact.payload.groupNodeId);
    if (node === undefined || !isJoinNode(node)) throw new Error(`Workflow companion builder rejected unknown join "${fact.payload.groupNodeId}"`);
    return [entry(node, joinEntryId(node.id), fact.payload.output)];
  });
  const completed = new Set(pending.previousCommitted.graph.nodes.flatMap(({ kind, id, state }) => kind === "repeat" && state._tag === "completed" ? [id] : []));
  const repeats = proposed.graph.nodes.flatMap((repeat) => {
    if (repeat.kind !== "repeat" || repeat.state._tag !== "completed" || completed.has(repeat.id) || !writesRepeatEntry(proposed, repeat.id)) return [];
    const last = lastBodyNode(proposed, repeat.id);
    if (last === undefined || !isJoinNode(last)) throw new Error(`Workflow companion builder rejected repeat "${repeat.id}" without a join as its last phase`);
    return [entry(last, joinEntryId(repeat.id), roundsOutput(proposed, last.id) ?? {})];
  });
  return [...joins, ...repeats];
}

/** The addendum facts of a settled attempt, named by the attempt that read
 *  them. They precede the handoff facts, so a later agent's context holds
 *  each addendum before it holds the handoff of the agent that read it. A message
 *  to the workflow is recorded from its address before any agent reads it,
 *  so a reading records only a parent's message that a build before
 *  addresses accepted. Such a message had no targets, so it is workflow
 *  scope at once, also when the attempt of an item read it. */
function addendumFacts(
  addenda: readonly RequestAddendumMessage[],
  reader: { readonly attemptId: string; readonly agentName: string },
  conversationId: string | null,
): WorkflowSessionFact[] {
  if (addenda.length === 0) return [];
  if (conversationId === null) throw new Error(`Workflow companion builder received request addenda for attempt "${reader.attemptId}", which has no conversation`);
  return addenda.map((addendum) => parseWorkflowSessionFact(buildContextInputAddedFact({
    ...addendum,
    readBy: { attemptId: reader.attemptId, agentName: reader.agentName, conversationId },
  })));
}

/** Build all non-control facts that must commit atomically with one VM proposal. */
function workflowCompanionsForProposal(
  proposal: WorkflowTransitionResult,
  input: WorkflowCompanionInput,
): WorkflowSessionFact[] {
  if (proposal.command.kind !== "commit") return [];
  const pending = proposal.state.context.pending;
  if (!pending) throw new Error("Workflow companion builder requires matching pending control");
  const terminal = proposal.command.proposal.facts.at(-1);
  if (terminal?.type !== "workflow.control.committed") {
    throw new Error("Workflow companion builder requires a terminal control commit fact");
  }
  const queue = workflowViewForProposal(input.queue, pending.proposedCommitted, input.resolvedAgents, input.timestamp);
  return [
    // First, so the context holds each addressed message before any handoff
    // of this commit, as it holds a read addendum before its reader's handoff.
    ...(input.addressed ?? []).map((message) => parseWorkflowSessionFact(buildContextInputAddedFact(message))),
    ...completionFacts(proposal, input),
    ...joinFacts(proposal, input),
    ...queueFactsForState(input.queue, queue),
  ];
}

/** Compose projection companions before control facts and preserve the terminal commit marker. */
export function composeWorkflowCompanions(
  proposal: WorkflowTransitionResult,
  input: WorkflowCompanionInput,
): WorkflowTransitionResult {
  return composeWorkflowProposal(proposal, workflowCompanionsForProposal(proposal, input));
}

/** Compose the queue companions of a commit that changes no attempt, such as
 *  a follow-up transfer: the current queue restated from the proposed
 *  control. A workflow with no queue view has nothing to restate. */
export function composeControlRestatement(
  proposal: WorkflowTransitionResult,
  queue: WorkflowView | null,
): WorkflowTransitionResult {
  const pending = proposal.state.context.pending;
  if (!queue || !pending) return proposal;
  return composeWorkflowProposal(proposal, queueFactsForState(queue, restateWorkflowView(queue, pending.proposedCommitted)));
}
