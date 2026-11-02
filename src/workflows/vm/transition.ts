import {
  createMachine,
  initialTransition,
  transition,
  types,
} from "xstate";
import { parseCommittedWorkflowControl, type CommittedWorkflowControl } from "./committed-control.js";
import {
  parseWorkflowCommand,
  type WorkflowMutation,
  type WorkflowTransitionResult,
} from "./commands.js";
import {
  parseWorkflowMachineContext,
  parseWorkflowMachineState,
  type PendingWorkflowCommit,
  type VmLifecycle,
  type WorkflowMachineContext,
  type WorkflowMachineState,
} from "./control-types.js";
import {
  CURRENT_PROPOSAL_ENCODING,
  parseFollowUpTransferEvent,
  parseWorkflowEvent,
  type WorkflowEvent,
  type DecodedWorkflowEvent,
  type DecodedWorkflowProposalEvent,
  type FollowUpTransferEvent,
  type FollowUpTransferInput,
  type WorkflowProposalEncoding,
} from "./events.js";
import {
  admissibleExecutionInput,
  executionInput,
  lifecycleFor,
} from "./attempt-transitions.js";
import { proposedTransition } from "./machine.js";
import { buildWorkflowControlCommittedFact, type WorkflowSessionFact } from "./session-facts.js";
import { composeControlRestatement } from "./companions.js";
import type { WorkflowView } from "../view/types.js";

/** An event as `transitionDecodedWorkflow` sends it, with the encoding that
 *  its proposal commits at. The encoding is required here, so the caller's
 *  value or `CURRENT_PROPOSAL_ENCODING` is its one source. */
type InvocationEvent = DecodedWorkflowEvent & { readonly proposalEncoding: WorkflowProposalEncoding };
type ProposalInvocation = DecodedWorkflowProposalEvent & { readonly proposalEncoding: WorkflowProposalEncoding };
type Invoked<T extends InvocationEvent["type"]> = Extract<InvocationEvent, { readonly type: T }>;

function lowerWorkflowCommand(_command: WorkflowMutation): void {
  throw new Error("Workflow commands are data and must not execute inside XState");
}

function buildWorkflowCommit(
  control: CommittedWorkflowControl,
  event: DecodedWorkflowProposalEvent,
  encoding: WorkflowProposalEncoding,
): PendingWorkflowCommit {
  const proposal = proposedTransition({ committed: control, pending: null }, event, encoding);
  const expectedSeq = control.aggregateSeq;
  const proposalId = `${control.definitionIdentity.workflowDefinitionId}:proposal:${expectedSeq + 1}:${proposal.eventKey}`;
  const facts: readonly WorkflowSessionFact[] = [
    ...proposal.facts,
    buildWorkflowControlCommittedFact(proposalId, event, encoding),
  ];
  const proposedCommitted = {
    ...proposal.committed,
    aggregateSeq: expectedSeq + facts.length,
  };
  return {
    proposalId,
    expectedSeq,
    previousCommitted: control,
    proposedCommitted,
    facts,
    nextLifecycle: proposal.nextLifecycle,
  };
}

function makePending(
  context: WorkflowMachineContext,
  event: ProposalInvocation,
): PendingWorkflowCommit {
  if (context.pending) throw new Error(`Workflow invariant rejected proposal while "${context.pending.proposalId}" is pending`);
  const { proposalEncoding, ...semanticEvent } = event;
  return buildWorkflowCommit(context.committed, semanticEvent, proposalEncoding);
}

function commitCommand(pending: PendingWorkflowCommit): WorkflowMutation {
  return {
    kind: "commit",
    proposal: {
      proposalId: pending.proposalId,
      expectedSeq: pending.expectedSeq,
      facts: pending.facts,
    },
  };
}

function followUpCommand(control: CommittedWorkflowControl): WorkflowMutation {
  const followUp = control.followUp;
  if (!followUp?.pendingInput) throw new Error("Workflow invariant rejected follow-up command without a pending request");
  return {
    kind: "run_follow_up",
    input: {
      workflowDefinitionId: control.definitionIdentity.workflowDefinitionId,
      input: followUp.pendingInput,
      identity: followUp.identity,
      conversationId: followUp.conversationId,
      requestSequence: followUp.requestSequence,
    },
  };
}

/** Rebuild the command implied by already committed control without proposing another fact. */
export function continueCommittedWorkflow(control: CommittedWorkflowControl): WorkflowTransitionResult {
  const state = replayDecodedWorkflow(control);
  return {
    state,
    command: control.status === "follow_up" ? followUpCommand(control) : { kind: "none" },
  };
}
/** The command that admits the next attempt in graph order beside the
 *  attempts that run now, or none when every ready attempt waits on another
 *  or the author's `max_parallel` admits no more. */
function admission(control: CommittedWorkflowControl, encoding: WorkflowProposalEncoding): WorkflowMutation {
  const attempt = admissibleExecutionInput(control, encoding);
  return attempt ? { kind: "prepare_attempt", attempt } : { kind: "none" };
}

function postCommitCommand(pending: PendingWorkflowCommit): WorkflowMutation {
  const terminal = pending.facts.at(-1);
  if (terminal?.type !== "workflow.control.committed") {
    throw new Error("Workflow invariant rejected committed proposal without a terminal control fact");
  }
  const event = terminal.payload.event;
  if (event.type === "ATTEMPT_STARTED") {
    const attempt = pending.proposedCommitted.attempts.find(({ id }) => id === event.attemptId);
    if (!attempt || attempt.state._tag !== "running") {
      throw new Error(`Workflow invariant rejected acknowledged start for "${event.attemptId}"`);
    }
    return { kind: "run_attempts", attempts: [executionInput(attempt, pending.proposedCommitted, terminal.version)] };
  }
  if (event.type === "RECOVER") {
    if (pending.proposedCommitted.status === "follow_up") return followUpCommand(pending.proposedCommitted);
    if (pending.nextLifecycle === "paused") return { kind: "none" };
    return admission(pending.proposedCommitted, terminal.version);
  }
  if (pending.nextLifecycle === "ready" || pending.nextLifecycle === "executing") return admission(pending.proposedCommitted, terminal.version);
  return event.type === "FOLLOW_UP_REQUESTED" || (event.type === "RESUME" && pending.proposedCommitted.status === "follow_up")
    ? followUpCommand(pending.proposedCommitted)
    : { kind: "none" };
}

/** The command that admits the next attempt once the host has forked the
 *  attempt that the last commit started, so every attempt that waits on no
 *  other starts before the host waits for any result. It reads committed
 *  control only and proposes nothing. */
export function admissionCommand(state: WorkflowMachineState): WorkflowMutation {
  if (state.context.pending) throw new Error(`Workflow invariant rejected admission while "${state.context.pending.proposalId}" is pending`);
  if (state.lifecycle !== "ready" && state.lifecycle !== "executing") return { kind: "none" };
  return admission(state.context.committed, CURRENT_PROPOSAL_ENCODING);
}

/** Inspect the next executable command without acknowledging or persisting a pending commit. */
export function nextWorkflowCommand(result: WorkflowTransitionResult): WorkflowMutation {
  return result.state.context.pending ? postCommitCommand(result.state.context.pending) : result.command;
}

function proposalRoute(
  context: WorkflowMachineContext,
  event: ProposalInvocation,
  enqueue: (fn: typeof lowerWorkflowCommand, command: WorkflowMutation) => void,
) {
  const pending = makePending(context, event);
  enqueue(lowerWorkflowCommand, commitCommand(pending));
  return { target: "awaiting_commit", context: { pending } };
}

const workflowMachine = createMachine({
  id: "workflow",
  schemas: {
    context: types<WorkflowMachineContext>(),
    events: {
      // Only `initializeWorkflow` sends INITIALIZE, which commits nothing.
      INITIALIZE: types<Extract<WorkflowEvent, { type: "INITIALIZE" }>>(),
      COMMIT_SUCCEEDED: types<Invoked<"COMMIT_SUCCEEDED">>(),
      START: types<Invoked<"START">>(),
      ADVANCE: types<Invoked<"ADVANCE">>(),
      ATTEMPT_STARTED: types<Invoked<"ATTEMPT_STARTED">>(),
      ATTEMPT_SUCCEEDED: types<Invoked<"ATTEMPT_SUCCEEDED">>(),
      ATTEMPT_BLOCKED: types<Invoked<"ATTEMPT_BLOCKED">>(),
      ATTEMPT_FAILED: types<Invoked<"ATTEMPT_FAILED">>(),
      PAUSE: types<Invoked<"PAUSE">>(),
      RESUME: types<Invoked<"RESUME">>(),
      RECOVER: types<Invoked<"RECOVER">>(),
      ABORT: types<Invoked<"ABORT">>(),
      FOLLOW_UP_REQUESTED: types<Invoked<"FOLLOW_UP_REQUESTED">>(),
      FOLLOW_UP_SUCCEEDED: types<Invoked<"FOLLOW_UP_SUCCEEDED">>(),
      FOLLOW_UP_FAILED: types<Invoked<"FOLLOW_UP_FAILED">>(),
      FOLLOW_UP_TRANSFERRED: types<Invoked<"FOLLOW_UP_TRANSFERRED">>(),
      REASSESSMENT_PROPOSED: types<Invoked<"REASSESSMENT_PROPOSED">>(),
    },
  },
  context: ({ input }: { input: unknown }) => parseWorkflowMachineContext(input),
  initial: "bootstrapping",
  states: {
    bootstrapping: {
      on: {
        INITIALIZE: {
          to: ({ event }) => ({
            target: lifecycleFor(event.control),
            context: { committed: event.control, pending: null },
          }),
        },
      },
    },
    ready: {
      on: {
        START: { to: ({ context, event }, enq) => proposalRoute(context, event, enq) },
        ATTEMPT_STARTED: { to: ({ context, event }, enq) => proposalRoute(context, event, enq) },
        PAUSE: { to: ({ context, event }, enq) => proposalRoute(context, event, enq) },
        ABORT: { to: ({ context, event }, enq) => proposalRoute(context, event, enq) },
        RECOVER: { to: ({ context, event }, enq) => proposalRoute(context, event, enq) },
      },
    },
    awaiting_commit: {
      on: {
        COMMIT_SUCCEEDED: {
          to: ({ context, event }, enq) => {
            const pending = context.pending;
            // A COMMIT_SUCCEEDED for a discarded proposal is a lost race, not
            // corruption: after conflict replay the machine may observe a
            // late commit event for a proposal it no longer holds. Ignore it.
            if (!pending || pending.proposalId !== event.proposalId) return;
            if (pending.proposedCommitted.aggregateSeq !== event.aggregateSeq) {
              throw new Error(`Workflow invariant rejected commit sequence ${event.aggregateSeq}; expected ${pending.proposedCommitted.aggregateSeq}`);
            }
            const command = postCommitCommand(pending);
            if (command.kind !== "none") enq(lowerWorkflowCommand, command);
            return {
              target: pending.nextLifecycle,
              context: { committed: pending.proposedCommitted, pending: null },
            };
          },
        },
      },
    },
    executing: {
      on: {
        ADVANCE: { to: ({ context, event }, enq) => proposalRoute(context, event, enq) },
        ATTEMPT_STARTED: { to: ({ context, event }, enq) => proposalRoute(context, event, enq) },
        ATTEMPT_SUCCEEDED: { to: ({ context, event }, enq) => proposalRoute(context, event, enq) },
        ATTEMPT_BLOCKED: { to: ({ context, event }, enq) => proposalRoute(context, event, enq) },
        ATTEMPT_FAILED: { to: ({ context, event }, enq) => proposalRoute(context, event, enq) },
        PAUSE: { to: ({ context, event }, enq) => proposalRoute(context, event, enq) },
        RECOVER: { to: ({ context, event }, enq) => proposalRoute(context, event, enq) },
        ABORT: { to: ({ context, event }, enq) => proposalRoute(context, event, enq) },
        REASSESSMENT_PROPOSED: { to: ({ context, event }, enq) => proposalRoute(context, event, enq) },
      },
    },
    paused: {
      on: {
        RESUME: { to: ({ context, event }, enq) => proposalRoute(context, event, enq) },
        RECOVER: { to: ({ context, event }, enq) => proposalRoute(context, event, enq) },
        ABORT: { to: ({ context, event }, enq) => proposalRoute(context, event, enq) },
        FOLLOW_UP_TRANSFERRED: { to: ({ context, event }, enq) => proposalRoute(context, event, enq) },
      },
    },
    follow_up: {
      on: {
        FOLLOW_UP_SUCCEEDED: { to: ({ context, event }, enq) => proposalRoute(context, event, enq) },
        FOLLOW_UP_FAILED: { to: ({ context, event }, enq) => proposalRoute(context, event, enq) },
        FOLLOW_UP_TRANSFERRED: { to: ({ context, event }, enq) => proposalRoute(context, event, enq) },
        PAUSE: { to: ({ context, event }, enq) => proposalRoute(context, event, enq) },
        ABORT: { to: ({ context, event }, enq) => proposalRoute(context, event, enq) },
        RECOVER: { to: ({ context, event }, enq) => proposalRoute(context, event, enq) },
      },
    },
    completed: {
      on: {
        FOLLOW_UP_REQUESTED: { to: ({ context, event }, enq) => proposalRoute(context, event, enq) },
        ABORT: { to: ({ context, event }, enq) => proposalRoute(context, event, enq) },
      },
    },
    // A Resume runs the failed agents of a run that ended on an agent's
    // failure again (`reopenFailedNodes`); the host proposes it only for such a run
    // (`resumesFailedAgents`).
    failed: {
      on: {
        RESUME: { to: ({ context, event }, enq) => proposalRoute(context, event, enq) },
      },
    },
  },
});

function commandFromActions(actions: readonly { readonly args: readonly unknown[] }[]): WorkflowMutation {
  if (actions.length === 0) return { kind: "none" };
  if (actions.length > 1) throw new Error(`Workflow invariant rejected ${actions.length} commands from one transition`);
  return parseWorkflowCommand(actions[0]?.args[0]);
}

function stateFromSnapshot(snapshot: { readonly value: unknown; readonly context: WorkflowMachineContext }): WorkflowMachineState {
  return { lifecycle: workflowLifecycle(snapshot.value), context: snapshot.context };
}

function workflowLifecycle(value: unknown): VmLifecycle {
  switch (value) {
    case "bootstrapping": return "bootstrapping";
    case "ready": return "ready";
    case "awaiting_commit": return "awaiting_commit";
    case "executing": return "executing";
    case "paused": return "paused";
    case "follow_up": return "follow_up";
    case "completed": return "completed";
    case "failed": return "failed";
    default:
      throw new Error(`Workflow invariant rejected XState lifecycle ${String(value)}`);
  }
}

/** Create the ready state through XState's pure initial transition and initialization event. */
export function initializeWorkflow(control: CommittedWorkflowControl): WorkflowTransitionResult {
  const committed = parseCommittedWorkflowControl(control);
  const [bootstrapping] = initialTransition(workflowMachine, { committed, pending: null });
  const initializeEvent: WorkflowEvent = { type: "INITIALIZE", control: committed };
  const [ready, actions] = transition(workflowMachine, bootstrapping, initializeEvent);
  return { state: stateFromSnapshot(ready), command: commandFromActions(actions) };
}

/** Rebuild a pure XState snapshot from committed control without snapshot persistence. */
export function replayWorkflow(control: CommittedWorkflowControl): WorkflowMachineState {
  return replayDecodedWorkflow(parseCommittedWorkflowControl(control));
}

/** Rebuild XState from control that a strict internal boundary already decoded. */
export function replayDecodedWorkflow(control: CommittedWorkflowControl): WorkflowMachineState {
  const snapshot = workflowMachine.resolveState({
    value: lifecycleFor(control),
    context: { committed: control, pending: null },
  });
  return stateFromSnapshot(snapshot);
}

/** Drive one synchronous deterministic event through the static workflow machine. */
export function transitionWorkflow(state: WorkflowMachineState, event: WorkflowEvent): WorkflowTransitionResult {
  return transitionDecodedWorkflow(parseWorkflowMachineState(state), parseWorkflowEvent(event));
}

/** Drive values that a strict internal boundary already decoded through XState. */
export function transitionDecodedWorkflow(
  state: WorkflowMachineState,
  event: DecodedWorkflowEvent,
  proposalEncoding: WorkflowProposalEncoding = CURRENT_PROPOSAL_ENCODING,
): WorkflowTransitionResult {
  const snapshot = workflowMachine.resolveState({ value: state.lifecycle, context: state.context });
  const invocation = { ...event, proposalEncoding };
  const [next, actions] = transition(workflowMachine, snapshot, invocation);
  const result = { state: stateFromSnapshot(next), command: commandFromActions(actions) };
  if (result.state.context.pending && result.command.kind !== "commit" && result.command.kind !== "none") {
    throw new Error("Workflow invariant rejected external execution while a commit is pending");
  }
  return result;
}

interface FollowUpTransferProposal {
  readonly event: FollowUpTransferEvent;
  readonly proposal: Extract<WorkflowTransitionResult["command"], { kind: "commit" }>["proposal"];
  readonly proposedControl: CommittedWorkflowControl;
}

/**
 * Build the production proposal that transfers one pending follow-up.
 *
 * The proposal carries the queue view restated from the transferred control,
 * as every control commit carries its projection, so `queue` is the
 * workflow's current queue view. The caller commits `proposal.facts` with the
 * destination parent append under one guarded transaction. This function
 * performs no I/O and starts no worker.
 */
export function proposeFollowUpTransfer(
  control: CommittedWorkflowControl,
  queue: WorkflowView | null,
  input: FollowUpTransferInput,
): FollowUpTransferProposal {
  const event = parseFollowUpTransferEvent({ ...input, type: "FOLLOW_UP_TRANSFERRED" });
  const result = composeControlRestatement(transitionDecodedWorkflow(replayDecodedWorkflow(parseCommittedWorkflowControl(control)), event), queue);
  const pending = result.state.context.pending;
  if (result.command.kind !== "commit" || !pending) {
    throw new Error("Workflow follow-up transfer proposal requires a pending follow-up");
  }
  return { event, proposal: result.command.proposal, proposedControl: pending.proposedCommitted };
}
