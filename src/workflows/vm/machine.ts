import type { ProposedTransition } from "./attempt-transitions.js";
import {
  blockAttempt,
  completeAttempt,
  failAttempt,
  lifecycleFor,
  prepareExecution,
  reassess,
  recover,
  startExecution,
} from "./attempt-transitions.js";
import type { FollowUpIdentity } from "./committed-control.js";
import { reopenFailedNodes } from "./resume-transitions.js";
import type { WorkflowMachineContext } from "./control-types.js";
import type { DecodedWorkflowProposalEvent, WorkflowProposalEncoding } from "./events.js";
import { buildFollowUpFailedFact, buildFollowUpRequestedFact, buildFollowUpSucceededFact, buildFollowUpTransferredFact, buildWorkflowAbortedFact, buildWorkflowPausedFact, buildWorkflowResumedFact } from "./fact-drafts.js";

function sameFollowUpIdentity(left: FollowUpIdentity, right: FollowUpIdentity): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "historical") return true;
  return right.kind === "identified" && left.inputID === right.inputID;
}

/** One proposal's transition. A run that the transition pauses or fails
 *  keeps no running attempt: every other attempt that still runs goes back
 *  to pending with its conversation, so a Resume starts it again in that
 *  conversation and nothing shows it running in a stopped run. The host
 *  commits a pause only once no other attempt runs, so at a pause these are
 *  the attempts that an abort interrupted and the attempts whose own failure
 *  waited behind the failure that paused the run. A serial run never had
 *  such an attempt, so stored histories replay unchanged. */
export function proposedTransition(context: WorkflowMachineContext, event: DecodedWorkflowProposalEvent, encoding: WorkflowProposalEncoding): ProposedTransition {
  const proposed = eventTransition(context, event, encoding);
  const { committed } = proposed;
  if ((committed.status !== "paused" && committed.status !== "failed") || !committed.attempts.some(({ state }) => state._tag === "running")) return proposed;
  return {
    ...proposed,
    committed: { ...committed, attempts: committed.attempts.map((attempt) => attempt.state._tag === "running" ? { ...attempt, state: { _tag: "pending" } } : attempt) },
  };
}

function eventTransition(context: WorkflowMachineContext, event: DecodedWorkflowProposalEvent, encoding: WorkflowProposalEncoding): ProposedTransition {
  switch (event.type) {
    case "START":
    case "ADVANCE": {
      const prepared = prepareExecution(context.committed, encoding);
      return { committed: prepared.control, nextLifecycle: lifecycleFor(prepared.control), facts: prepared.facts, eventKey: event.type.toLowerCase() };
    }
    case "ATTEMPT_STARTED": {
      const prepared = startExecution(context.committed, event.attemptId, event.conversationId, encoding);
      return { committed: prepared.control, nextLifecycle: "executing", facts: prepared.facts, eventKey: `attempt-started:${event.attemptId}` };
    }
    case "ATTEMPT_SUCCEEDED": return completeAttempt(context.committed, event, encoding);
    case "ATTEMPT_BLOCKED": return blockAttempt(context.committed, event, encoding);
    case "ATTEMPT_FAILED": return failAttempt(context.committed, event, encoding);
    case "PAUSE": return {
      committed: { ...context.committed, status: "paused" },
      nextLifecycle: "paused",
      facts: [buildWorkflowPausedFact(event.reason)],
      eventKey: "pause",
    };
    case "RESUME": {
      if (context.committed.followUp?.pendingInput) {
        return {
          committed: { ...context.committed, status: "follow_up" },
          nextLifecycle: "follow_up",
          facts: [buildWorkflowResumedFact()],
          eventKey: "resume",
        };
      }
      // A failed run resumes by running its failed agents again; every
      // finished agent that does not read a failed agent's output keeps its
      // result.
      const resumed = context.committed.status === "failed" ? reopenFailedNodes(context.committed, encoding, event.readers) : context.committed;
      const prepared = prepareExecution({ ...resumed, status: "ready" }, encoding);
      return { committed: prepared.control, nextLifecycle: lifecycleFor(prepared.control), facts: [buildWorkflowResumedFact(), ...prepared.facts], eventKey: "resume" };
    }
    case "RECOVER": return recover(context.committed, event, encoding);
    case "ABORT": return {
      committed: { ...context.committed, status: "paused" },
      nextLifecycle: "paused",
      facts: [buildWorkflowAbortedFact(event.reason)],
      eventKey: "abort",
    };
    case "FOLLOW_UP_REQUESTED": {
      const previous = context.committed.followUp;
      if (previous && previous.conversationId !== event.conversationId) {
        throw new Error(`Workflow invariant rejected replacement follow-up conversation "${event.conversationId}"`);
      }
      if (previous?.pendingInput) {
        throw new Error("Workflow invariant rejected a second pending follow-up request");
      }
      const requestSequence = (previous?.requestSequence ?? 0) + 1;
      if (event.requestSequence !== requestSequence) {
        throw new Error(`Workflow invariant rejected follow-up request sequence ${event.requestSequence}; expected ${requestSequence}`);
      }
      return {
        committed: {
          ...context.committed,
          status: "follow_up",
          followUp: { conversationId: event.conversationId, requestSequence, pendingInput: event.input, identity: event.identity },
        },
        nextLifecycle: "follow_up",
        facts: [buildFollowUpRequestedFact(event, encoding)],
        eventKey: `follow-up:${event.conversationId}:${requestSequence}`,
      };
    }
    case "FOLLOW_UP_SUCCEEDED": {
      const followUp = context.committed.followUp;
      if (!followUp?.pendingInput || followUp.conversationId !== event.conversationId || followUp.requestSequence !== event.requestSequence) {
        throw new Error(`Workflow invariant rejected follow-up success for "${event.conversationId}" request ${event.requestSequence}`);
      }
      return {
        committed: { ...context.committed, status: "completed", followUp: { ...followUp, pendingInput: null } },
        nextLifecycle: "completed",
        facts: [buildFollowUpSucceededFact(event.conversationId, event.requestSequence)],
        eventKey: `follow-up-succeeded:${event.conversationId}:${followUp.requestSequence}`,
      };
    }
    case "FOLLOW_UP_FAILED": {
      const followUp = context.committed.followUp;
      if (!followUp?.pendingInput || followUp.conversationId !== event.conversationId || followUp.requestSequence !== event.requestSequence) {
        throw new Error("Workflow invariant rejected follow-up failure without its pending request");
      }
      return {
        committed: context.committed,
        nextLifecycle: "follow_up",
        facts: [buildFollowUpFailedFact(event.reason, event.conversationId, event.requestSequence)],
        eventKey: `follow-up-failed:${followUp.conversationId}:${followUp.requestSequence}`,
      };
    }
    case "FOLLOW_UP_TRANSFERRED": {
      const followUp = context.committed.followUp;
      if (!followUp?.pendingInput) {
        throw new Error("Workflow invariant rejected transfer without a pending follow-up");
      }
      if (followUp.conversationId !== event.source.conversationId
        || followUp.requestSequence !== event.source.requestSequence
        || !sameFollowUpIdentity(followUp.identity, event.source.identity)) {
        throw new Error("Workflow invariant rejected transfer because its source does not match current pending control");
      }
      return {
        committed: {
          ...context.committed,
          status: "completed",
          followUp: { ...followUp, pendingInput: null },
        },
        nextLifecycle: "completed",
        facts: [buildFollowUpTransferredFact(event)],
        eventKey: `follow-up-transferred:${followUp.conversationId}:${followUp.requestSequence}`,
      };
    }
    case "REASSESSMENT_PROPOSED": return reassess(context.committed, event, encoding);
  }
}