import { authoredContinuation, continuationAttempt, followUpForAttempt, forBodyRemainder } from "./attempt-continuation.js";
import { blockedWork } from "./blocked-work.js";
import { isNonEmpty, normalizedSignal, whileOutcome } from "./loop-signal.js";
import type { AttemptExecutionInput } from "./commands.js";
import type { CommittedWorkflowControl } from "./committed-control.js";
import type { VmLifecycle } from "./control-types.js";
import { CURRENT_PROPOSAL_ENCODING, type WorkflowProposalEvent, type WorkflowProposalEncoding } from "./events.js";
import { admitsAnotherAttempt, readyAttempt, refreshFrontier } from "./frontier.js";
import { attemptIdOf, type Attempt, type LogicalNode } from "./graph-types.js";
import { replaceNode, withAttemptOrderedAccounting, withNodeState } from "./graph-changes.js";
import { attemptScope, attemptVote, decideConditions, expandReadyList, needsFailedWork, openReadyContainers, settleContainers, UNFINISHED_NODE_STATES } from "./list-transitions.js";
import { applyReassessment, failNode, settleNode } from "./reassessment.js";
import { queuedAttempts } from "./structural-admission.js";
import type { WorkflowControlFactDraft } from "./session-facts.js";
import { buildAttemptBlockedFact, buildAttemptFailedFact, buildAttemptInsertionRejectedFact, buildAttemptResumeCapExceededFact, buildAttemptResumeRecoveredFact, buildAttemptRetryInsertedFact, buildAttemptRevertedFact, buildAttemptStartedFact, buildAttemptSucceededFact, buildForExpandedFact, buildForExpansionRejectedFact, buildWorkflowCompletedFact, buildWorkflowFailedFact, buildWorkflowPausedFact, buildWorkflowReassessedFact } from "./fact-drafts.js";

const RESUME_REVERT_CAP = 3;

export interface ProposedTransition {
  readonly committed: CommittedWorkflowControl;
  readonly nextLifecycle: VmLifecycle;
  readonly facts: readonly WorkflowControlFactDraft[];
  readonly eventKey: string;
}

interface PreparedExecution {
  readonly control: CommittedWorkflowControl;
  readonly facts: readonly WorkflowControlFactDraft[];
}

export function lifecycleFor(control: CommittedWorkflowControl): VmLifecycle {
  switch (control.status) {
    case "ready": return "ready";
    case "executing": return "executing";
    case "paused": return "paused";
    case "follow_up": return "follow_up";
    case "completed": return "completed";
    case "failed": return "failed";
  }
}

function replaceAttempt(
  control: CommittedWorkflowControl,
  attemptId: string,
  update: (attempt: Attempt) => Attempt,
): CommittedWorkflowControl {
  const found = control.attempts.some((attempt) => attempt.id === attemptId);
  if (!found) throw new Error(`Workflow invariant rejected unknown attempt "${attemptId}"`);
  return {
    ...control,
    attempts: control.attempts.map((attempt) => attempt.id === attemptId ? update(attempt) : attempt),
  };
}

function insertionGuard(
  control: CommittedWorkflowControl,
  ownerAttemptId: string,
  actor: string,
  insertCount: number,
  mutationCount: number,
): string | null {
  const accounting = control.guardrails;
  // Only the history arms insert attempts this way, so the refusal keeps the
  // words that strict replay of their runs compares.
  if (queuedAttempts(control) + insertCount > accounting.maxAttempts) {
    return `Workflow control "${actor}" rejected insert_after: max queue length (${accounting.maxAttempts})`;
  }
  if (accounting.insertsUsed + insertCount > accounting.maxInserts) {
    return `Workflow control "${actor}" rejected insert_after: max session inserts (${accounting.maxInserts})`;
  }
  const used = accounting.attemptMutationsUsed.find(({ attemptId }) => attemptId === ownerAttemptId)?.used;
  if (used === undefined) throw new Error(`Workflow invariant rejected missing guardrail accounting for attempt "${ownerAttemptId}"`);
  if (used + mutationCount > accounting.maxMutationsPerAttempt) {
    return `Workflow control "${actor}" rejected mutation: attempt "${ownerAttemptId}" exceeds mutation cap (${accounting.maxMutationsPerAttempt})`;
  }
  return null;
}

function rejectAttemptInsertion(
  control: CommittedWorkflowControl, attempt: Attempt, reason: string,
  facts: readonly WorkflowControlFactDraft[], eventKey: string,
): ProposedTransition {
  const failed = replaceNode(control, attempt.logicalNodeId, (node) => withNodeState(node, { _tag: "failed", reason }));
  return {
    committed: { ...failed, status: "failed", frontier: [] },
    nextLifecycle: "failed",
    facts: [...facts, buildAttemptInsertionRejectedFact(attempt.id, reason), buildWorkflowFailedFact()],
    eventKey,
  };
}

function chargeInsertion(
  control: CommittedWorkflowControl,
  ownerAttemptId: string,
  insertCount: number,
  mutationCount: number,
): CommittedWorkflowControl {
  return {
    ...control,
    guardrails: {
      ...control.guardrails,
      insertsUsed: control.guardrails.insertsUsed + insertCount,
      attemptMutationsUsed: control.guardrails.attemptMutationsUsed.map((entry) =>
        entry.attemptId === ownerAttemptId ? { ...entry, used: entry.used + mutationCount } : entry
      ),
    },
  };
}

function nextAttemptSequence(control: CommittedWorkflowControl, logicalNodeId: string): number {
  return control.attempts.reduce(
    (maximum, attempt) => attempt.logicalNodeId === logicalNodeId ? Math.max(maximum, attempt.sequence) : maximum,
    0,
  ) + 1;
}

function newAttempt(
  node: LogicalNode,
  definitionId: string,
  sequence: number,
  provenance: Attempt["provenance"],
  parentAttempt: Attempt | null,
  item: Attempt["item"] = null,
  iteration = 1,
  priorRetryFeedback: string | null = null,
): Attempt {
  return {
    id: attemptIdOf(node.id, sequence),
    logicalNodeId: node.id,
    workflowDefinitionId: node.workflowDefinitionId,
    definitionId,
    sequence,
    iteration,
    resumeRevertCount: 0,
    provenance,
    ownership: node.ownership,
    state: { _tag: "pending" },
    parentAttemptId: parentAttempt?.id ?? null,
    conversationId: null,
    handoff: null,
    priorRetryFeedback,
    item,
  };
}

function insertAttemptsAfter(
  control: CommittedWorkflowControl,
  anchorAttemptId: string,
  attempts: readonly Attempt[],
): CommittedWorkflowControl {
  const index = control.attempts.findIndex(({ id }) => id === anchorAttemptId);
  if (index < 0) throw new Error(`Workflow invariant rejected missing insertion anchor "${anchorAttemptId}"`);
  return withAttemptOrderedAccounting({
    ...control,
    attempts: [
      ...control.attempts.slice(0, index + 1),
      ...attempts,
      ...control.attempts.slice(index + 1),
    ],
    guardrails: {
      ...control.guardrails,
      attemptMutationsUsed: [
        ...control.guardrails.attemptMutationsUsed,
        ...attempts.map(({ id: attemptId }) => ({ attemptId, used: 0 })),
      ],
    },
  });
}

interface HandoffFields { readonly [key: string]: unknown; }

function readHandoffField(handoff: HandoffFields, field: string) {
  return handoff[field];
}

/** Expand a ready history `for` node: one attempt for each item of its
 *  source. History only; remove after 2027-04-30. */
function expandReadyForNode(control: CommittedWorkflowControl): PreparedExecution {
  const node = control.graph.nodes.find((candidate) =>
    candidate.kind === "for"
    && candidate.state._tag === "ready"
    && !control.attempts.some(({ logicalNodeId }) => logicalNodeId === candidate.id)
  );
  if (!node || node.kind !== "for") return { control, facts: [] };
  const sourceAttempt = control.attempts.findLast((attempt) =>
    attempt.definitionId === node.source.step && attempt.handoff !== null // stored key of control v10
  );
  if (!sourceAttempt?.handoff) throw new Error(`For-loop source attempt "${node.source.step}" is missing`); // stored key of control v10
  const source = readHandoffField(sourceAttempt.handoff, node.source.field);
  if (!Array.isArray(source)) {
    throw new TypeError(`For-loop source "${node.source.step}.${node.source.field}" is not an array`); // stored key of control v10
  }
  const reason = insertionGuard(control, sourceAttempt.id, "for", source.length, source.length === 0 ? 1 : 2);
  if (reason !== null) {
    return { control: { ...control, status: "paused" }, facts: [buildForExpansionRejectedFact(node.id, reason)] };
  }
  let expanded = replaceNode(control, node.id, (candidate) => withNodeState(
    candidate,
    source.length === 0 ? { _tag: "completed" } : { _tag: "running" },
  ));
  const bodyUnit = node.body[0];
  if (!bodyUnit) throw new Error(`Workflow invariant rejected empty for body "${node.id}"`);
  const firstSequence = nextAttemptSequence(expanded, node.id);
  const attempts = source.map((item, itemIndex) =>
    newAttempt(node, bodyUnit.step, firstSequence + itemIndex, { _tag: "round", index: itemIndex + 1 }, null, item) // stored key of control v10
  );
  expanded = insertAttemptsAfter(expanded, sourceAttempt.id, attempts);
  expanded = chargeInsertion(expanded, sourceAttempt.id, source.length, source.length === 0 ? 1 : 2);
  expanded = refreshFrontier(expanded);
  return { control: expanded, facts: [buildForExpandedFact(node.id, source.length)] };
}

/** The input of one attempt that a proposal at `encoding` started. The
 *  encoding decides the attempt's context scope (refer to `attemptScope`). */
export function executionInput(attempt: Attempt, control: CommittedWorkflowControl, encoding: WorkflowProposalEncoding = CURRENT_PROPOSAL_ENCODING): AttemptExecutionInput {
  if (!control.graph.nodes.some(({ id }) => id === attempt.logicalNodeId)) {
    throw new Error(`Workflow invariant rejected missing logical node "${attempt.logicalNodeId}"`);
  }
  const vote = attemptVote(control, attempt);
  return {
    attemptId: attempt.id,
    logicalNodeId: attempt.logicalNodeId,
    definitionId: attempt.definitionId,
    workflowDefinitionId: attempt.workflowDefinitionId,
    conversationId: attempt.conversationId,
    iteration: attempt.iteration,
    provenance: attempt.provenance,
    priorRetryFeedback: attempt.priorRetryFeedback,
    item: attempt.item,
    ...(vote === undefined ? {} : { vote }),
    scope: attemptScope(control, attempt, encoding),
  };
}

/** Advance deterministic control until a round changes nothing: expand a
 *  ready history `for` node, decide the `if` of ready nodes, open ready
 *  containers, expand a ready list, settle finished containers, and derive
 *  the frontier again. Then report the workflow outcome once nothing more
 *  can run. From encoding 8 the run fails only when a failure left it
 *  without work that it needs (`needsFailedWork`); before it, any unfinished
 *  node that the workflow owns failed the run, and a phase that fails stands
 *  for its children. A refused expansion ends the preparation with the
 *  failed workflow it records. */
export function prepareExecution(input: CommittedWorkflowControl, encoding: WorkflowProposalEncoding = CURRENT_PROPOSAL_ENCODING): PreparedExecution {
  let control = refreshFrontier(input);
  const facts: WorkflowControlFactDraft[] = [];
  // Each pass returns its input unchanged when it has nothing to do, so an
  // unchanged control ends the rounds.
  for (;;) {
    const expanded = expandReadyForNode(control);
    facts.push(...expanded.facts);
    if (expanded.control.status === "paused") return { control: expanded.control, facts };
    const opened = openReadyContainers(decideConditions(expanded.control));
    facts.push(...opened.facts);
    if (opened.rejected) return { control: opened.control, facts };
    const list = expandReadyList(opened.control, encoding);
    facts.push(...list.facts);
    if (list.rejected) return { control: list.control, facts };
    const settled = settleContainers(list.control, encoding);
    facts.push(...settled.facts);
    if (settled.control === control) break;
    control = refreshFrontier(settled.control);
  }
  if (control.attempts.some(({ state }) => state._tag === "running")) {
    return { control: { ...control, status: "executing" }, facts };
  }
  if (readyAttempt(control)) return { control: { ...control, status: "ready" }, facts };
  const failed = encoding >= 8
    ? needsFailedWork(control.graph.nodes, encoding)
    : control.graph.nodes.some(({ ownership, state }) => ownership._tag === "workflow" && UNFINISHED_NODE_STATES.has(state._tag));
  return {
    control: { ...control, status: failed ? "failed" : "completed" },
    facts: [...facts, failed ? buildWorkflowFailedFact() : buildWorkflowCompletedFact()],
  };
}

/** Start one ready attempt beside the attempts that run already. It refuses
 *  an attempt that is not ready, an attempt whose node runs another attempt,
 *  and a start past the author's `max_parallel`. */
export function startExecution(
  input: CommittedWorkflowControl,
  attemptId: string,
  conversationId: string,
  encoding: WorkflowProposalEncoding = CURRENT_PROPOSAL_ENCODING,
): PreparedExecution {
  const prepared = prepareExecution(input, encoding);
  if (!admitsAnotherAttempt(prepared.control)) {
    throw new Error(`Workflow invariant rejected attempt start "${attemptId}": max parallel (${prepared.control.guardrails.maxParallel}) attempts run`);
  }
  const selected = readyAttempt(prepared.control, attemptId);
  if (!selected) throw new Error(`Workflow invariant rejected attempt start "${attemptId}": attempt is not ready`);
  let control = replaceAttempt(prepared.control, selected.id, (attempt) => ({
    ...attempt,
    state: { _tag: "running" },
    conversationId,
  }));
  control = replaceNode(control, selected.logicalNodeId, (node) => withNodeState(node, { _tag: "running" }));
  return { control: { ...control, status: "executing" }, facts: [...prepared.facts, buildAttemptStartedFact(selected.id)] };
}

/** The input of the next attempt that admission may start now, or null
 *  when every ready attempt waits on another or the author's `max_parallel`
 *  admits no more. */
export function admissibleExecutionInput(control: CommittedWorkflowControl, encoding: WorkflowProposalEncoding = CURRENT_PROPOSAL_ENCODING): AttemptExecutionInput | null {
  const attempt = admitsAnotherAttempt(control) ? readyAttempt(control) : undefined;
  return attempt ? executionInput(attempt, control, encoding) : null;
}

export function completeAttempt(control: CommittedWorkflowControl, event: Extract<WorkflowProposalEvent, { type: "ATTEMPT_SUCCEEDED" }>, encoding: WorkflowProposalEncoding = CURRENT_PROPOSAL_ENCODING): ProposedTransition {
  const current = control.attempts.find(({ id }) => id === event.outcome.attemptId);
  if (!current || current.state._tag !== "running") {
    throw new Error(`Workflow invariant rejected completion for non-running attempt "${event.outcome.attemptId}"`);
  }
  let proposed = replaceAttempt(control, current.id, (attempt) => ({
    ...attempt,
    state: { _tag: "completed" },
    conversationId: event.outcome.conversationId,
    handoff: event.outcome.handoff,
    ...(event.outcome.issues === undefined ? {} : { handoffIssues: event.outcome.issues }),
  }));
  const node = proposed.graph.nodes.find(({ id }) => id === current.logicalNodeId);
  if (!node) throw new Error(`Workflow invariant rejected missing logical node "${current.logicalNodeId}"`);
  const insertions: Attempt[] = [];
  let mutationCount = 0;
  let insertionAnchorId = current.id;

  // The history arms of control from before phases: a `then` chain, the
  // body of a `for` item, and a `while` round run as attempts of one node.
  // Remove after 2027-04-30.
  if (node.kind === "agent" && node.followUpV10 !== undefined) {
    const followUp = followUpForAttempt(proposed, node, current, encoding);
    if (followUp && (followUp.when === null || isNonEmpty(readHandoffField(event.outcome.handoff, followUp.when)))) {
      insertions.push(newAttempt(node, followUp.step, nextAttemptSequence(proposed, node.id), { _tag: "followUpV10" }, current)); // stored key of control v10
      mutationCount += 1;
    }
  }

  if (node.kind === "for") {
    const [next] = forBodyRemainder(proposed, node, current);
    if (next) {
      insertions.push(newAttempt(node, next.step, nextAttemptSequence(proposed, node.id), { _tag: "followUpV10" }, current)); // stored key of control v10
      mutationCount += 1;
    }
  }

  if (node.kind === "while" && current.definitionId === node.evaluator.step) { // stored key of control v10
    const rawSignal = readHandoffField(event.outcome.handoff, node.evaluator.field);
    const signal = normalizedSignal(rawSignal);
    const outcome = whileOutcome(node, event.outcome.handoff, node.iteration);
    const halted = outcome === "dry" || outcome === "stuck";
    if (halted) {
      proposed = {
        ...proposed,
        attempts: proposed.attempts.map((attempt) =>
          attempt.logicalNodeId === node.id && attempt.state._tag === "pending"
            ? { ...attempt, state: { _tag: "skipped", reason: "While loop stopped" } }
            : attempt
        ),
      };
    } else {
      // The bound caps evaluator runs, not repairs: a bounded evaluation with a
      // live signal still gets the trailing body agents (the fix pass) before the
      // loop settles, so the final evaluation is never wasted.
      const bounded = node.iteration >= node.maxIterations;
      const evaluatorIndex = node.body.findIndex(({ step }) => step === node.evaluator.step); // stored key of control v10
      const definitions = bounded
        // At iteration 1 the compile-time pending body attempts are already queued.
        ? node.iteration === 1 ? [] : node.body.slice(evaluatorIndex + 1)
        : node.iteration === 1
          ? node.body.slice(0, evaluatorIndex + 1)
          : [...node.body.slice(evaluatorIndex + 1), ...node.body.slice(0, evaluatorIndex + 1)];
      if (node.iteration === 1) {
        const currentIndex = proposed.attempts.findIndex(({ id }) => id === current.id);
        const suffix = proposed.attempts.slice(currentIndex + 1).filter((attempt) =>
          attempt.logicalNodeId === node.id && attempt.state._tag === "pending"
        );
        insertionAnchorId = suffix.at(-1)?.id ?? current.id;
      }
      if (definitions.length > 0) {
        const firstSequence = nextAttemptSequence(proposed, node.id);
        insertions.push(...definitions.map((unit, index) =>
          newAttempt(node, unit.step, firstSequence + index, { _tag: "round", index: bounded ? node.iteration : node.iteration + 1 }, current, null, bounded ? node.iteration : node.iteration + 1) // stored key of control v10
        ));
        mutationCount += 1;
      }
      if (!bounded) {
        proposed = replaceNode(proposed, node.id, (candidate) => candidate.kind === "while"
          ? { ...candidate, iteration: candidate.iteration + 1, priorNormalizedSignal: signal }
          : candidate);
      }
    }
  }

  if (insertions.length > 0) {
    const reason = insertionGuard(proposed, current.id, node.kind === "while" ? "loop" : "then", insertions.length, mutationCount);
    if (reason !== null) {
      return rejectAttemptInsertion(
        { ...proposed, graph: control.graph }, current, reason,
        [buildAttemptSucceededFact(current.id, encoding, event.outcome.toolUses)], `attempt-succeeded:${current.id}`,
      );
    }
    proposed = insertAttemptsAfter(proposed, insertionAnchorId, insertions);
    proposed = chargeInsertion(proposed, current.id, insertions.length, mutationCount);
  }
  const reassessment = event.outcome.reassessment
    ? applyReassessment(proposed, event.outcome.reassessment, current)
    : null;
  if (reassessment) proposed = reassessment.control;
  proposed = settleNode(proposed, node.id);
  proposed = refreshFrontier(proposed);
  const prepared = prepareExecution(proposed, encoding);
  return {
    committed: prepared.control,
    nextLifecycle: lifecycleFor(prepared.control),
    facts: [
      buildAttemptSucceededFact(current.id, encoding, event.outcome.toolUses),
      ...(event.outcome.reassessment ? [buildWorkflowReassessedFact(
        event.outcome.reassessment.proposalId,
        reassessment?.acceptedChanges ?? [],
        encoding,
      )] : []),
      ...prepared.facts,
    ],
    eventKey: `attempt-succeeded:${current.id}`,
  };
}

/** Replay a blocked attempt that a build before blocked retirement committed,
 *  and route the block to its configured continuation. The attempt keeps its
 *  handoff as canonical evidence and never becomes a success. When no
 *  continuation exists, ordinary graph settlement closes the workflow as failed. No current
 *  writer proposes this event, so a stored corrective chain is the only input.
 *  Remove this replay arm after 2027-04-03. */
export function blockAttempt(
  control: CommittedWorkflowControl,
  event: Extract<WorkflowProposalEvent, { type: "ATTEMPT_BLOCKED" }>,
  encoding: WorkflowProposalEncoding = CURRENT_PROPOSAL_ENCODING,
): ProposedTransition {
  const current = control.attempts.find(({ id }) => id === event.blocked.attemptId);
  if (!current || current.state._tag !== "running") {
    throw new Error(`Workflow invariant rejected a block for non-running attempt "${event.blocked.attemptId}"`);
  }
  const node = control.graph.nodes.find(({ id }) => id === current.logicalNodeId);
  if (!node) throw new Error(`Workflow invariant rejected missing logical node "${current.logicalNodeId}"`);
  const blocker = blockedWork(event.blocked.handoff);
  const continuation = authoredContinuation(control, node, current, encoding);
  if (event.correctiveDefinitionId !== null && event.correctiveDefinitionId !== continuation) {
    throw new Error(
      `Workflow invariant rejected corrective continuation "${event.correctiveDefinitionId}" for blocked attempt "${current.id}": the authored continuation is ${continuation ? `"${continuation}"` : "absent"}`,
    );
  }
  let proposed = replaceAttempt(control, current.id, (attempt) => ({
    ...attempt,
    state: { _tag: "blocked", reason: blocker.reason },
    conversationId: event.blocked.conversationId,
    handoff: event.blocked.handoff,
  }));
  const blockedFact = buildAttemptBlockedFact(current.id, blocker.reason, blocker.evidence);
  const eventKey = `attempt-blocked:${current.id}`;
  if (event.correctiveDefinitionId === null || !continuation) {
    proposed = refreshFrontier(settleNode(proposed, node.id));
    if (encoding <= 3) {
      return {
        committed: { ...proposed, status: "paused" },
        nextLifecycle: "paused",
        facts: [blockedFact, buildWorkflowPausedFact(blocker.reason)],
        eventKey,
      };
    }
    const prepared = prepareExecution(proposed, encoding);
    return {
      committed: prepared.control,
      nextLifecycle: lifecycleFor(prepared.control),
      facts: [blockedFact, ...prepared.facts],
      eventKey,
    };
  }
  const inserted = newAttempt(node, continuation, nextAttemptSequence(proposed, node.id), { _tag: "followUpV10" }, current);
  const reason = insertionGuard(proposed, current.id, "then", 1, 1);
  if (reason !== null) return rejectAttemptInsertion(proposed, current, reason, [blockedFact], eventKey);
  proposed = insertAttemptsAfter(proposed, current.id, [inserted]);
  proposed = chargeInsertion(proposed, current.id, 1, 1);
  const prepared = prepareExecution(refreshFrontier(settleNode(proposed, node.id)), encoding);
  return {
    committed: prepared.control,
    nextLifecycle: lifecycleFor(prepared.control),
    facts: [blockedFact, ...prepared.facts],
    eventKey,
  };
}

export function failAttempt(control: CommittedWorkflowControl, event: Extract<WorkflowProposalEvent, { type: "ATTEMPT_FAILED" }>, encoding: WorkflowProposalEncoding = CURRENT_PROPOSAL_ENCODING): ProposedTransition {
  const current = control.attempts.find(({ id }) => id === event.failure.attemptId);
  if (!current || current.state._tag !== "running") {
    throw new Error(`Workflow invariant rejected failure for non-running attempt "${event.failure.attemptId}"`);
  }
  const node = control.graph.nodes.find(({ id }) => id === current.logicalNodeId);
  if (!node) throw new Error(`Workflow invariant rejected missing logical node "${current.logicalNodeId}"`);
  const handoffFailure = isAuthoredHandoffFailure(event.failure) ? event.failure : null;
  const signal = normalizedSignal(event.failure.reason);
  if (
    handoffFailure !== null
    && node.kind === "agent"
    && node.retry
    && current.iteration < node.retry.max
    && (!node.retry.stuck || current.priorRetryFeedback === null || current.priorRetryFeedback !== signal)
  ) {
    let proposed = replaceAttempt(control, current.id, (attempt) => ({
      ...attempt,
      state: { _tag: "failed", reason: event.failure.reason },
      conversationId: event.failure.conversationId,
    }));
    if (queuedAttempts(proposed) + 1 > proposed.guardrails.maxAttempts) {
      // A proposal of encoding 9 or earlier states the limit in the words
      // that strict replay of its run compares.
      const limit = encoding >= 10 ? "max attempts" : "max queue length";
      const refusal = `Workflow control "retry" rejected insert_after: ${limit} (${proposed.guardrails.maxAttempts})`;
      // An agent whose retry does not fit has no retry left, so it fails
      // only itself. Before encoding 8 only an agent of a list failed this
      // way, and any other agent failed the workflow.
      return current.ownership._tag === "item" || encoding >= 8
        ? failStep(control, current, handoffFailure, refusal, encoding)
        : rejectAttemptInsertion(proposed, current, refusal, [], `attempt-failed:${current.id}:${event.failure.kind}`);
    }
    const retry = newAttempt(
      node,
      current.definitionId,
      nextAttemptSequence(proposed, node.id),
      { _tag: "retry" },
      current,
      current.item,
      current.iteration + 1,
      signal,
    );
    proposed = insertAttemptsAfter(proposed, current.id, [retry]);
    const prepared = prepareExecution(proposed, encoding);
    return {
      committed: prepared.control,
      nextLifecycle: lifecycleFor(prepared.control),
      facts: [buildAttemptRetryInsertedFact(current.id, retry.id, signal, event.failure.toolUses, encoding), ...prepared.facts],
      eventKey: `attempt-retry:${current.id}:${retry.iteration}`,
    };
  }
  if (encoding >= 14 && event.failure.kind === "context_overflow" && (event.failure.toolUses ?? 0) > 0) {
    return continueOverflowedAttempt(control, current, event.failure, encoding);
  }
  if (encoding >= 8 || (handoffFailure !== null && current.ownership._tag === "item")) {
    return failStep(control, current, event.failure, null, encoding);
  }
  // Before encoding 8, any other failure paused the run, and the pause also
  // paused every attempt that ran beside this one (`proposedTransition`).
  const proposed = replaceAttempt(control, current.id, (attempt) => ({
    ...attempt,
    state: { _tag: "pending" },
    conversationId: event.failure.kind === "context_overflow" ? null : event.failure.conversationId,
  }));
  return {
    committed: { ...proposed, status: "paused" },
    nextLifecycle: "paused",
    facts: [buildAttemptRevertedFact(current.id, event.failure.reason, event.failure.kind === "context_overflow")],
    eventKey: `attempt-failed:${current.id}:${event.failure.kind}`,
  };
}

type AttemptFailure = Extract<WorkflowProposalEvent, { type: "ATTEMPT_FAILED" }>["failure"];

/** A failure of the handoff that the worker authored, as opposed to an
 *  infrastructure failure. Only this kind retries. Before encoding 8 only
 *  this kind failed an item, and any other failure paused the run. */
type AuthoredHandoffFailure = Extract<AttemptFailure, { kind: "handoff" | "missing_handoff" | "invalid_handoff" }>;

function isAuthoredHandoffFailure(failure: AttemptFailure): failure is AuthoredHandoffFailure {
  return failure.kind === "handoff" || failure.kind === "missing_handoff" || failure.kind === "invalid_handoff";
}

/** An attempt whose conversation outgrew the context window after it made
 *  tool calls continues in a new conversation, and its node keeps running.
 *  The continuation keeps the attempt's charge lineage, so it buys no
 *  authored retry, and its prompt carries the earlier attempt's recorded
 *  progress. An overflow with no tool call fails the agent instead
 *  (`failStep`): the same brief in a new conversation would overflow again. */
function continueOverflowedAttempt(
  control: CommittedWorkflowControl,
  current: Attempt,
  failure: AttemptFailure,
  encoding: WorkflowProposalEncoding,
): ProposedTransition {
  const overflowed: Attempt = { ...current, state: { _tag: "failed", reason: failure.reason }, conversationId: null };
  const proposed = insertAttemptsAfter(replaceAttempt(control, current.id, () => overflowed), current.id, [continuationAttempt(control, overflowed)]);
  const prepared = prepareExecution(proposed, encoding);
  return {
    committed: prepared.control,
    nextLifecycle: lifecycleFor(prepared.control),
    facts: [buildAttemptFailedFact(current.id, failure.kind, failure.reason, encoding, failure.toolUses), ...prepared.facts],
    eventKey: `attempt-failed:${current.id}:${failure.kind}`,
  };
}

/** An agent whose attempt failed after its retries fails, and only it fails:
 *  the work that does not need it goes on. From encoding 8 its node fails with it (`failNode`). Each
 *  node that depends on it, by the phase order that hands it the agent's
 *  output or through its container, derives as blocked, and every other node
 *  still runs. An agent of a stream fails its item the same way,
 *  and the join still settles when it folds, so the failure lands in
 *  the settlement summary. A retry that the queue length refused is part of
 *  the recorded reason. Whether the run completes or fails is decided once
 *  nothing more can run (`prepareExecution`). */
function failStep(
  control: CommittedWorkflowControl,
  current: Attempt,
  failure: AttemptFailure,
  refusedRetry: string | null,
  encoding: WorkflowProposalEncoding,
): ProposedTransition {
  const reason = refusedRetry === null ? failure.reason : `${failure.reason}. ${refusedRetry}`;
  let proposed = replaceAttempt(control, current.id, (attempt) => ({
    ...attempt,
    state: { _tag: "failed", reason },
    // A conversation that outgrew the context window cannot hold the attempt
    // again, so a Resume (`reopenFailedNodes`) starts it in a new one, as
    // the pause before encoding 8 did.
    conversationId: failure.kind === "context_overflow" ? null : failure.conversationId,
  }));
  proposed = refreshFrontier(encoding >= 8 ? failNode(proposed, current, reason) : settleNode(proposed, current.logicalNodeId));
  const prepared = prepareExecution(proposed, encoding);
  return {
    committed: prepared.control,
    nextLifecycle: lifecycleFor(prepared.control),
    facts: [buildAttemptFailedFact(current.id, failure.kind, reason, encoding, failure.toolUses), ...prepared.facts],
    eventKey: `attempt-failed:${current.id}:${failure.kind}`,
  };
}

/** Restart the attempts that a crash left in flight. An attempt that
 *  restarted `RESUME_REVERT_CAP` times with no progress pauses the run; an
 *  attempt that the event names as progressed starts its count over. */
export function recover(control: CommittedWorkflowControl, event: Extract<WorkflowProposalEvent, { type: "RECOVER" }>, encoding: WorkflowProposalEncoding = CURRENT_PROPOSAL_ENCODING): ProposedTransition {
  if (control.status === "follow_up") {
    if (!control.followUp?.pendingInput) {
      throw new Error("Workflow invariant rejected follow-up recovery without a pending request");
    }
    return {
      committed: control,
      nextLifecycle: "follow_up",
      facts: [],
      eventKey: `recover:${control.aggregateSeq + 1}`,
    };
  }
  if (control.status === "paused") {
    return { committed: control, nextLifecycle: "paused", facts: [], eventKey: `recover:${control.aggregateSeq + 1}` };
  }
  let capped = false;
  const attempts = control.attempts.map((attempt) => {
    if (attempt.state._tag !== "running") return attempt;
    const restarts = event.progressed.includes(attempt.id) ? 0 : attempt.resumeRevertCount;
    if (restarts >= RESUME_REVERT_CAP) {
      capped = true;
      return { ...attempt, state: { _tag: "pending" } as const };
    }
    return { ...attempt, state: { _tag: "pending" } as const, resumeRevertCount: restarts + 1 };
  });
  const recovered = { ...control, attempts };
  if (capped) {
    return {
      committed: { ...recovered, status: "paused" },
      nextLifecycle: "paused",
      facts: [buildAttemptResumeCapExceededFact()],
      eventKey: `recover:${control.aggregateSeq + 1}`,
    };
  }
  const prepared = prepareExecution(recovered, encoding);
  return {
    committed: { ...prepared.control, status: "executing" },
    nextLifecycle: "executing",
    facts: [buildAttemptResumeRecoveredFact(), ...prepared.facts],
    eventKey: `recover:${control.aggregateSeq + 1}`,
  };
}

export function reassess(
  control: CommittedWorkflowControl,
  event: Extract<WorkflowProposalEvent, { type: "REASSESSMENT_PROPOSED" }>,
  encoding: WorkflowProposalEncoding = CURRENT_PROPOSAL_ENCODING,
): ProposedTransition {
  const ownerAttempt = control.attempts.toReversed().find(({ logicalNodeId }) =>
    logicalNodeId === event.proposal.ownerNodeId
  );
  if (!ownerAttempt) {
    throw new Error(`Reassessment "${event.proposal.proposalId}" rejected: owner "${event.proposal.ownerNodeId}" has no attempt provenance`);
  }
  const reassessment = applyReassessment(control, event.proposal, ownerAttempt);
  const prepared = prepareExecution(refreshFrontier(reassessment.control), encoding);
  return {
    committed: prepared.control,
    nextLifecycle: lifecycleFor(prepared.control),
    facts: [buildWorkflowReassessedFact(event.proposal.proposalId, reassessment.acceptedChanges, encoding), ...prepared.facts],
    eventKey: `reassess:${event.proposal.proposalId}`,
  };
}
