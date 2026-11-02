import type { CommittedWorkflowControl } from "./committed-control.js";
import type { WorkflowProposalEncoding } from "./events.js";
import { attemptIdOf, type AgentNode, type Attempt, type FollowUpV10, type LogicalNode } from "./graph-types.js";
import { isContainerNode } from "./graph-changes.js";

export function lastRunAttempt(control: CommittedWorkflowControl, nodeId: string): Attempt | undefined {
  return control.attempts.findLast((attempt) => attempt.logicalNodeId === nodeId && attempt.state._tag !== "skipped");
}

/** Failed agent nodes whose failed latest execution a person can reopen.
 *  An agent of an item is one of them only in a proposal of encoding 14 or
 *  later, so the replay of an earlier Resume reopens what it reopened then. */
export function retriableFailedNodes(control: CommittedWorkflowControl, encoding: number): readonly LogicalNode[] {
  return control.graph.nodes.filter((node) => !isContainerNode(node)
    && node.state._tag === "failed" && (node.ownership._tag !== "item" || encoding >= 14)
    && lastRunAttempt(control, node.id)?.state._tag === "failed");
}

/** Replaces an execution without buying another retry or structural
 *  allocation. A failed execution continues in a copy of its conversation,
 *  or in a fresh one when its conversation overflowed. A `rerun` runs a
 *  finished execution again in a fresh conversation, because what it read
 *  changed. */
export function continuationAttempt(control: CommittedWorkflowControl, attempt: Attempt, rerun = false): Attempt {
  const sequence = control.attempts.reduce((max, candidate) => candidate.logicalNodeId === attempt.logicalNodeId ? Math.max(max, candidate.sequence) : max, 0) + 1;
  return {
    ...attempt, id: attemptIdOf(attempt.logicalNodeId, sequence), sequence,
    state: { _tag: "pending" }, conversationId: null, handoff: null,
    parentAttemptId: attempt.id,
    provenance: {
      _tag: "continuation", reason: rerun ? "rerun" : attempt.conversationId === null ? "overflow" : "reopen",
      sourceConversationId: rerun ? null : attempt.conversationId,
      chargeAttemptId: attempt.provenance._tag === "continuation" ? attempt.provenance.chargeAttemptId : attempt.id,
    },
  };
}

type ForNode = Extract<LogicalNode, { kind: "for" }>;

// The continuations of control from before phases: the `then` chain of an
// agent node and the body of a `for` node, which history arms of control
// version 11 keep so that a run launched before phases resumes. Remove after
// 2027-04-30.

/** Select the next authored record with the continuation semantics of the proposal's encoding. */
export function followUpForAttempt(control: CommittedWorkflowControl, node: AgentNode, attempt: Attempt, encoding: WorkflowProposalEncoding): FollowUpV10 | null {
  const chain = node.followUpV10 ?? null;
  // committed@2 selected the first matching record, including on retries.
  // Replay must reproduce that producer, not repair the historical decision.
  if (encoding === 2) {
    if (attempt.parentAttemptId === null) return chain;
    let followUp = chain;
    while (followUp) {
      if (followUp.step === attempt.definitionId) return followUp.then; // stored key of control v10
      followUp = followUp.then;
    }
    return null;
  }
  let followUp = chain;
  let ancestor: Attempt | undefined = attempt;
  // Only then edges advance the authored position. Retries keep their parent's
  // position, even when several positions use the same record.
  while (ancestor && followUp) {
    if (ancestor.provenance._tag === "followUpV10") followUp = followUp.then;
    const parentAttemptId: Attempt["parentAttemptId"] = ancestor.parentAttemptId;
    ancestor = control.attempts.find(({ id }) => id === parentAttemptId);
  }
  return followUp;
}

/** Select the body positions that run after this attempt in its `for` item,
 *  in run order. An item's first attempt is the one that expansion or
 *  reassessment created, and each then edge in the attempt's lineage advances
 *  one body position, so a record that a body names twice still resolves by
 *  position. The first of them is the position that this attempt's success
 *  starts. */
export function forBodyRemainder(control: CommittedWorkflowControl, node: ForNode, attempt: Attempt): readonly ForNode["body"][number][] {
  let position = 0;
  let ancestor: Attempt | undefined = attempt;
  while (ancestor && ancestor.provenance._tag !== "round" && ancestor.provenance._tag !== "reassessment") {
    if (ancestor.provenance._tag === "followUpV10") position += 1;
    const parentAttemptId: Attempt["parentAttemptId"] = ancestor.parentAttemptId;
    ancestor = control.attempts.find(({ id }) => id === parentAttemptId);
  }
  return node.body.slice(position + 1);
}

/** Select the record of the authored position after this attempt without a handoff gate. A blocked source can hand work only to an unconditional continuation. Only the replay of a stored `ATTEMPT_BLOCKED` reads it; remove it with that replay arm after 2027-04-03. */
export function authoredContinuation(control: CommittedWorkflowControl, node: LogicalNode, attempt: Attempt, encoding: WorkflowProposalEncoding): string | null {
  if (node.kind === "agent") {
    const followUp = followUpForAttempt(control, node, attempt, encoding);
    return followUp?.when === null ? followUp.step : null; // stored key of control v10
  }
  return node.kind === "for" ? forBodyRemainder(control, node, attempt)[0]?.step ?? null : null; // stored key of control v10
}
