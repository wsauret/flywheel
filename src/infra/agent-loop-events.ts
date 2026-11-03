/**
 * Loop-side contracts for input and lifecycle observation. The agent loop
 * draws user input from a single `InputSource` and notifies observers at two
 * lifecycle moments. Observers cause effects (typically by enqueueing into the
 * input source); the loop always drains after firing them. There is no
 * "policy" that returns messages; producers own their predicates, and once a
 * predicate fires, the producer pushes into the input source directly.
 */
import type { ChatAttachment, ChatInputLike, ChatInvocation, UserInputProducer } from "./chat-input.js";
import { chatInputText, normalizeChatInput } from "./chat-input.js";

/** `human` is the person. `session` is another session: visible, but never
 *  the intent of the person. `silent-system` is a runtime notice the model
 *  reads and the transcript does not show. A message with no origin is a
 *  visible runtime nudge. */
export type AgentLoopMessageOrigin = "human" | "session" | "silent-system"
type LogicalTurnOrigin = "user" | "system" | "background"
type LogicalTurnStartedReason = "new_input" | "queued_input"
export interface LogicalTurnStartedContext {
  origin: LogicalTurnOrigin
  reason: LogicalTurnStartedReason
}
export type AgentLoopMessageInput = {
  kind: "message";
  text: string;
  attachments?: readonly ChatAttachment[];
  origin?: AgentLoopMessageOrigin;
  /** Inline step/skill invocation display metadata, carried so the durable
   *  user message records how the transcript should render it. */
  invocation?: ChatInvocation;
  /** Client display correlation retained with the durable human message. */
  submissionIds?: readonly string[];
  /** In-flight recovery keys of the queued dispatches this input carries, so
   *  the flush that commits the resulting message can retire their cells. */
  dispatchIds?: readonly string[];
  /** Distinct in-flight keys for queued background notifications. */
  backgroundNotificationIds?: readonly string[];
  producer?: UserInputProducer;
  /** A runtime notice about the agent's own waits and background work, which the conversation labels so that a
   *  route may deliver it with the parked tool results it follows. Always `silent-system`. */
  runtimeNotice?: true;
  /** A message from another session that the wake hop limit holds: a parked
   *  loop folds it into history and starts no turn. */
  held?: true;
}
type AgentLoopCompactInput = { kind: "compact"; source?: "idle" }
// Respawned workers need a loop kick without message semantics.
export type AgentLoopWakeInput = { kind: "wake" }
// A person's Resume of an interrupted turn: the one input besides a human
// message that authorizes a loop parked after an interrupt. The loop records
// the continuation the model reads, so live and restarted resumes agree.
type AgentLoopResumeInput = { kind: "resume" }
// A hold assembles the runner and parks it on its background work without a
// model request: the parent of a resumed child waits for the child again.
type AgentLoopHoldInput = { kind: "hold" }
export type AgentLoopRequestContextInput = { kind: "request-context"; text: string; input: AgentLoopMessageInput }
export type AgentLoopInput = AgentLoopMessageInput | AgentLoopCompactInput | AgentLoopWakeInput | AgentLoopResumeInput | AgentLoopHoldInput | AgentLoopRequestContextInput;

export function messageInput(
  input: ChatInputLike,
  opts: { origin?: AgentLoopMessageOrigin; backgroundNotificationIds?: readonly string[]; held?: boolean; runtimeNotice?: boolean } = {},
): AgentLoopMessageInput {
  const normalized = normalizeChatInput(input);
  return {
    kind: "message",
    text: chatInputText(normalized),
    ...(normalized.attachments && normalized.attachments.length > 0 ? { attachments: normalized.attachments } : {}),
    ...(normalized.invocation ? { invocation: normalized.invocation } : {}),
    ...(normalized.submissionIds?.length ? { submissionIds: normalized.submissionIds } : {}),
    ...(normalized.dispatchIds && normalized.dispatchIds.length > 0 ? { dispatchIds: normalized.dispatchIds } : {}),
    ...(normalized.producer ? { producer: normalized.producer } : {}),
    ...(opts.backgroundNotificationIds?.length ? { backgroundNotificationIds: opts.backgroundNotificationIds } : {}),
    ...(opts.origin ? { origin: opts.origin } : {}),
    ...(opts.held ? { held: true as const } : {}),
    ...(opts.runtimeNotice ? { runtimeNotice: true as const } : {}),
  };
}

/** The origin of an accepted message, from its producer. A message with no
 *  producer came from a person through a client. Both input sources map
 *  through this one function. */
export function producerOrigin(producer: UserInputProducer | undefined): "human" | "session" {
  return producer?.kind === "session" ? "session" : "human";
}

/** True when two messages share one producer, so one entry can carry both. */
export function sameProducer(left: UserInputProducer | undefined, right: UserInputProducer | undefined): boolean {
  if (left?.kind !== "session" || right?.kind !== "session") return left?.kind === right?.kind;
  return left.sessionId === right.sessionId
    && left.conversationId === right.conversationId
    && left.toolUseId === right.toolUseId
    && left.hop === right.hop;
}

export function compactInput(source?: "idle"): AgentLoopCompactInput {
  return { kind: "compact", ...(source ? { source } : {}) };
}

export function holdInput(): AgentLoopHoldInput {
  return { kind: "hold" };
}

export function wakeInput(): AgentLoopWakeInput {
  return { kind: "wake" };
}

export function resumeInput(): AgentLoopResumeInput {
  return { kind: "resume" };
}

export function requestContextInput(input: ChatInputLike, text: string): AgentLoopRequestContextInput {
  return { kind: "request-context", text, input: messageInput(input) };
}

export interface InputWaitReservation {
  /** Commit this wait after the host has finalized the park boundary. */
  commit(): Promise<AgentLoopInput | null>;
  /** Cancel and join this wait without removing queued input. */
  cancel(): Promise<void>;
}

export interface InputSource {
  /** Non-blocking drain. Returns the next loop input, or null if empty. */
  drainPending(): AgentLoopInput | null;
  /** Install a wait reservation before the park event is published. Commit
   *  removes one queued delivery; cancellation leaves queue order unchanged.
   *  Sources that cannot park omit it. */
  prepareWaitForInput?(signal?: AbortSignal): InputWaitReservation;
  /** The loop's channel for a runtime notice about its own wait (see agent-runtime/runtime-notifications.ts for the
   *  envelope format and pipeline). The text is delivered on the next drain as a masked `silent-system` user message
   *  that carries `runtimeNotice`: it reaches the model and the durable conversation but never renders in the
   *  transcript, and it never merges with unlabeled input. Sources that cannot deliver silent notices omit it. */
  enqueueRuntimeNotice?(text: string): void;
}

export interface TurnEndedContext {
  handoffWritten: boolean;
  turnCount: number;
  /** Module policy captured at the request admission boundary that completed this turn. */
  runtimeConfig?: {
    readonly moduleSections: { readonly [section: string]: unknown };
  };
}

/** How a loop parked. `interrupted` waits for the person's message or
 *  Resume. `waiting_on_work` waits on background work of its turn, and a
 *  result of that work continues the turn. `idle` answered its turn with
 *  nothing running for it. */
export type TurnParkState = "idle" | "waiting_on_work" | "interrupted";

export interface TurnParkedContext extends TurnEndedContext {
  /** Successful serving usage established this cache window for the current context. */
  idleCache?: { observedAt: number; ttlMs: number; contextTokens: number };
  /** Managed background tasks still running at park time. A positive count
   *  means the park waits for their results, not for the user. */
  activeBackgroundCount: number;
  /** The park deliberately waits on background work: the turn dropped a
   *  wait-shaped call (the `process` wait action or a no-op bash
   *  placeholder), or a handoff-gated worker parked on tracked background
   *  tasks. False for a plain end-of-turn park with no tracked work. */
  parkedOnBackgroundWork: boolean;
  /** The agent waits inside its turn: a wait call (the `process` wait
   *  action, a no-op bash placeholder such as a `sleep` while work runs, or a
   *  `message_session` wait) opened a wait that no wake, expiry, person's
   *  message or Resume, or interrupt has ended yet. Requests in between, such
   *  as a reply nudge or a compaction, keep it. False when no wait is open,
   *  also when the park still waits on background work. */
  waitRequested: boolean;
  /** True after an interrupt gives control back to the user. Background input
   *  is retained but cannot authorize another model request. */
  userResumeRequired: boolean;
  /** How the loop parked, stated once by the loop that parks. Every reader
   *  of the park, such as the wake limit and the "Waiting" status, reads it
   *  here and never derives it again from the fields above. */
  park: TurnParkState;
}
