import { Schema } from "effect";
import { CURRENT_PROPOSAL_ENCODING, type DecodedWorkflowProposalEvent, type ReassessmentChange, type WorkflowProposalEncoding } from "./events.js";
import type { GraphChange } from "./graph-changes.js";
import type { ExpansionChange } from "./graph-types.js";
import { GraphChangeV5Schema } from "./historical-codecs.js";
import { encodeExpansionChangeV8 } from "./historical-normalization.js";
import { FollowUpRequestedFactSchema, FollowUpTransferredFactSchema, type WorkflowControlFactDraft } from "./session-facts.js";

// The facts that a proposal drafts, each at the version of the proposal's
// encoding, so strict replay of a stored run re-derives exactly the fact
// that the run recorded. The control commits each draft; `session-facts.ts`
// holds the schemas that decode them.

type Draft<T extends WorkflowControlFactDraft["type"]> = Extract<WorkflowControlFactDraft, { type: T }>;

export function buildForExpansionRejectedFact(nodeId: string, reason: string): Draft<"for.expansion_rejected"> {
  return { type: "for.expansion_rejected", version: 1, actor: "flywheel", payload: { nodeId, reason } };
}
export function buildForExpandedFact(nodeId: string, itemCount: number): Draft<"for.expanded"> {
  return { type: "for.expanded", version: 1, actor: "flywheel", payload: { nodeId, itemCount } };
}
/** The record of one list expansion at the proposal's encoding. A proposal
 *  of encoding 10 records version 3. An earlier proposal records the graph
 *  version 8 bytes of its build: version 2 when an item carries a vote, and
 *  otherwise the version 1 bytes, which every build before votes wrote, so
 *  strict replay of a stored run derives exactly the fact that the run
 *  recorded. */
export function buildGroupExpandedFact(
  payload: Omit<Draft<"group.expanded">["payload"], "changes"> & { readonly changes: readonly GraphChange[] },
  encoding: WorkflowProposalEncoding = CURRENT_PROPOSAL_ENCODING,
): Draft<"group.expanded"> {
  const changes = payload.changes.map(asExpansionChange);
  if (encoding >= 10) return { type: "group.expanded", version: 3, actor: "flywheel", payload: { ...payload, changes } };
  const encoded = changes.map(encodeExpansionChangeV8);
  const votes = changes.some((change) => change.kind === "add_node" && change.node.kind === "item" && change.node.vote !== undefined);
  if (votes) return { type: "group.expanded", version: 2, actor: "flywheel", payload: { ...payload, changes: encoded } };
  // An expansion without votes holds no shape that graph version 5 lacks,
  // which its strict decode proves.
  return { type: "group.expanded", version: 1, actor: "flywheel", payload: { ...payload, changes: encoded.map((change) => Schema.decodeUnknownSync(GraphChangeV5Schema)(change)) } };
}

/** One graph change as an expansion records it: an item or an agent of an
 *  item, an edge, or the join. */
function asExpansionChange(change: GraphChange): ExpansionChange {
  if (change.kind !== "add_node") return change;
  const { node } = change;
  if ((node.kind === "item" && node.ownership._tag === "list") || (node.kind === "agent" && node.ownership._tag === "item")) return { kind: "add_node", node, item: change.item };
  throw new Error(`Workflow invariant rejected expansion node "${node.id}", which is neither an item nor an agent of one`);
}

export function buildGroupExpansionRejectedFact(groupNodeId: string, reason: string): Draft<"group.expansion_rejected"> {
  return { type: "group.expansion_rejected", version: 1, actor: "flywheel", payload: { groupNodeId, reason } };
}
export function buildGroupSettledFact(payload: Draft<"group.settled">["payload"]): Draft<"group.settled"> {
  return { type: "group.settled", version: 1, actor: "flywheel", payload };
}
/** Build the fact of an attempt that failed for good at `encoding`. A
 *  proposal of encoding 7 or earlier failed only the authored handoff of a stream agent
 *  this way, which version 1 records; replay re-derives it. */
export function buildAttemptFailedFact(
  attemptId: string,
  kind: Extract<Draft<"attempt.failed">, { version: 2 }>["payload"]["kind"],
  reason: string,
  encoding: WorkflowProposalEncoding = CURRENT_PROPOSAL_ENCODING,
  toolUses?: number,
): Draft<"attempt.failed"> {
  if (encoding >= 9) return { type: "attempt.failed", version: 3, actor: "flywheel", payload: { attemptId, kind, reason, ...(toolUses === undefined ? {} : { toolUses }) } };
  if (encoding === 8) return { type: "attempt.failed", version: 2, actor: "flywheel", payload: { attemptId, kind, reason } };
  if (kind === "handoff" || kind === "missing_handoff" || kind === "invalid_handoff") return { type: "attempt.failed", version: 1, actor: "flywheel", payload: { attemptId, kind, reason } };
  throw new Error(`Workflow invariant rejected a ${kind} failure of attempt "${attemptId}" at encoding ${encoding}: only a handoff failure fails an attempt before encoding 8`);
}
export function buildAttemptStartedFact(attemptId: string): Draft<"attempt.started"> {
  return { type: "attempt.started", version: 1, actor: "flywheel", payload: { attemptId } };
}
/** Build the success fact at its proposal encoding: v1 through encoding 5,
 *  v2 through encoding 8, and v3 with optional measured operations. */
export function buildAttemptSucceededFact(attemptId: string, encoding: WorkflowProposalEncoding = CURRENT_PROPOSAL_ENCODING, toolUses?: number): Draft<"attempt.succeeded"> {
  if (encoding >= 9) return { type: "attempt.succeeded", version: 3, actor: "flywheel", payload: { attemptId, ...(toolUses === undefined ? {} : { toolUses }) } };
  return encoding >= 6
    ? { type: "attempt.succeeded", version: 2, actor: "flywheel", payload: { attemptId } }
    : { type: "attempt.succeeded", version: 1, actor: "flywheel", payload: { attemptId, evidence: [] } };
}
export function buildAttemptBlockedFact(attemptId: string, reason: string, evidence: string): Draft<"attempt.blocked"> {
  return { type: "attempt.blocked", version: 1, actor: "flywheel", payload: { attemptId, reason, evidence } };
}
export function buildAttemptRetryInsertedFact(attemptId: string, retryAttemptId: string, feedback: string, toolUses?: number, encoding: WorkflowProposalEncoding = CURRENT_PROPOSAL_ENCODING): Draft<"attempt.retry_inserted"> {
  return encoding >= 9
    ? { type: "attempt.retry_inserted", version: 2, actor: "flywheel", payload: { attemptId, retryAttemptId, feedback, ...(toolUses === undefined ? {} : { toolUses }) } }
    : { type: "attempt.retry_inserted", version: 1, actor: "flywheel", payload: { attemptId, retryAttemptId, feedback } };
}
/** Record a refused continuation without changing the triggering attempt's outcome. */
export function buildAttemptInsertionRejectedFact(attemptId: string, reason: string): Draft<"attempt.insertion_rejected"> {
  return { type: "attempt.insertion_rejected", version: 1, actor: "flywheel", payload: { attemptId, reason } };
}
export function buildAttemptRevertedFact(attemptId: string, reason: string, conversationCleared: boolean): Draft<"attempt.reverted"> {
  return { type: "attempt.reverted", version: 1, actor: "flywheel", payload: { attemptId, reason, conversationCleared } };
}
export function buildAttemptResumeCapExceededFact(): Draft<"attempt.resume_cap_exceeded"> {
  return { type: "attempt.resume_cap_exceeded", version: 1, actor: "flywheel", payload: {} };
}
export function buildAttemptResumeRecoveredFact(): Draft<"attempt.resume_recovered"> {
  return { type: "attempt.resume_recovered", version: 1, actor: "flywheel", payload: {} };
}
export function buildAttemptRecoveredFact(attemptId: string, conversationId: string | null): Draft<"attempt.recovered"> {
  return { type: "attempt.recovered", version: 1, actor: "flywheel", payload: { attemptId, conversationId } };
}
/** Record the accepted changes of a reassessment at the proposal's
 *  encoding. A proposal of encoding 9 or earlier holds only graph version 3
 *  changes, which version 2 records. */
export function buildWorkflowReassessedFact(proposalId: string, changes: readonly ReassessmentChange[], encoding: WorkflowProposalEncoding = CURRENT_PROPOSAL_ENCODING): Draft<"workflow.reassessed"> {
  if (encoding >= 10) return { type: "workflow.reassessed", version: 3, actor: "flywheel", payload: { proposalId, changes } };
  const historical = changes.flatMap((change) => change.kind === "drop_item" || change.kind === "replace_item" || change.kind === "insert_item" ? [] : [change]);
  if (historical.length !== changes.length) throw new Error(`Workflow invariant rejected item changes in reassessment "${proposalId}" at encoding ${encoding}`);
  return { type: "workflow.reassessed", version: 2, actor: "flywheel", payload: { proposalId, changes: historical } };
}
export function buildWorkflowPausedFact(reason: string): Draft<"workflow.paused"> {
  return { type: "workflow.paused", version: 1, actor: "flywheel", payload: { reason } };
}
export function buildWorkflowResumedFact(): Draft<"workflow.resumed"> {
  return { type: "workflow.resumed", version: 1, actor: "flywheel", payload: {} };
}
export function buildWorkflowAbortedFact(reason: string): Draft<"workflow.aborted"> {
  return { type: "workflow.aborted", version: 1, actor: "flywheel", payload: { reason } };
}
export function buildWorkflowCompletedFact(): Draft<"workflow.completed"> {
  return { type: "workflow.completed", version: 1, actor: "flywheel", payload: {} };
}
export function buildWorkflowFailedFact(): Draft<"workflow.failed"> {
  return { type: "workflow.failed", version: 1, actor: "flywheel", payload: {} };
}
export function buildFollowUpRequestedFact(
  event: Extract<DecodedWorkflowProposalEvent, { type: "FOLLOW_UP_REQUESTED" }>,
  version: WorkflowProposalEncoding = CURRENT_PROPOSAL_ENCODING,
): Draft<"follow_up.requested"> {
  const { conversationId, requestSequence } = event;
  if (version === 2) return {
    type: "follow_up.requested",
    version: 1,
    actor: "flywheel",
    payload: { prompt: event.input.text, conversationId, requestSequence },
  };
  return Schema.decodeUnknownSync(FollowUpRequestedFactSchema, { onExcessProperty: "error" })({
    type: "follow_up.requested", version: 2, actor: "flywheel",
    payload: { input: event.input, identity: event.identity, conversationId, requestSequence },
  });
}
export function buildFollowUpSucceededFact(conversationId: string, requestSequence: number): Draft<"follow_up.succeeded"> {
  return { type: "follow_up.succeeded", version: 1, actor: "flywheel", payload: { conversationId, requestSequence } };
}
export function buildFollowUpFailedFact(reason: string, conversationId: string, requestSequence: number): Draft<"follow_up.failed"> {
  return { type: "follow_up.failed", version: 1, actor: "flywheel", payload: { reason, conversationId, requestSequence } };
}
export function buildFollowUpTransferredFact(
  event: Extract<DecodedWorkflowProposalEvent, { type: "FOLLOW_UP_TRANSFERRED" }>,
): Draft<"follow_up.transferred"> {
  const { source, destination, queuedMappings } = event;
  return Schema.decodeUnknownSync(FollowUpTransferredFactSchema, { onExcessProperty: "error" })({
    type: "follow_up.transferred",
    version: 1,
    actor: "flywheel",
    payload: { source, destination, queuedMappings },
  });
}
