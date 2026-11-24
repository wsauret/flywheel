import type { ProposedTransition } from "./attempt-transitions.js";
import type { CommittedWorkflowControl } from "../facts/committed-control.js";
import type { DecodedWorkflowProposalEvent, WorkflowProposalEncoding } from "../facts/events.js";
import { buildFollowUpFailedFact, buildFollowUpRequestedFact, buildFollowUpSucceededFact } from "./fact-drafts.js";

type FollowUpRunEvent = Extract<DecodedWorkflowProposalEvent, { type: "FOLLOW_UP_REQUESTED" | "FOLLOW_UP_SUCCEEDED" | "FOLLOW_UP_FAILED" }>;

/** The frozen transitions of a recorded follow-up run, which replay
 *  re-derives at the encoding of the proposal (13 or earlier). No current
 *  writer proposes one: a person's message after a workflow goes to the chat
 *  that launched it, and a pending request that a run recorded moves there
 *  through the adoption migration. The `follow_up` status that these
 *  transitions enter always holds pending input, which the host refuses at
 *  preflight. Recorded runs replay for the life of the store
 *  (ARCH-WORKFLOWS-032), so this reader has no removal date. */
export function replayFollowUpRun(control: CommittedWorkflowControl, event: FollowUpRunEvent, encoding: WorkflowProposalEncoding): ProposedTransition {
  switch (event.type) {
    case "FOLLOW_UP_REQUESTED": {
      const previous = control.followUp;
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
          ...control,
          status: "follow_up",
          followUp: { conversationId: event.conversationId, requestSequence, pendingInput: event.input, identity: event.identity },
        },
        nextLifecycle: "follow_up",
        facts: [buildFollowUpRequestedFact(event, encoding)],
        eventKey: `follow-up:${event.conversationId}:${requestSequence}`,
      };
    }
    case "FOLLOW_UP_SUCCEEDED": {
      const followUp = control.followUp;
      if (!followUp?.pendingInput || followUp.conversationId !== event.conversationId || followUp.requestSequence !== event.requestSequence) {
        throw new Error(`Workflow invariant rejected follow-up success for "${event.conversationId}" request ${event.requestSequence}`);
      }
      return {
        committed: { ...control, status: "completed", followUp: { ...followUp, pendingInput: null } },
        nextLifecycle: "completed",
        facts: [buildFollowUpSucceededFact(event.conversationId, event.requestSequence)],
        eventKey: `follow-up-succeeded:${event.conversationId}:${followUp.requestSequence}`,
      };
    }
    case "FOLLOW_UP_FAILED": {
      const followUp = control.followUp;
      if (!followUp?.pendingInput || followUp.conversationId !== event.conversationId || followUp.requestSequence !== event.requestSequence) {
        throw new Error("Workflow invariant rejected follow-up failure without its pending request");
      }
      return {
        committed: control,
        nextLifecycle: "follow_up",
        facts: [buildFollowUpFailedFact(event.reason, event.conversationId, event.requestSequence)],
        eventKey: `follow-up-failed:${followUp.conversationId}:${followUp.requestSequence}`,
      };
    }
  }
}
