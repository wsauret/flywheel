import type { AgentLoopInput } from "../../infra/agent-loop-events.js";
import { chatInputContent } from "../../infra/chat-input.js";
import type { ContentBlock } from "./llm/types.js";
import type { LoopUserMetadata } from "./agent-loop-history.js";
import { CONTINUATION_MESSAGES } from "./continuation-messages.js";
import { completionWorkIds } from "./background-work-notifications.js";
import { textChars } from "./compaction/truncation.js";

type MessageInput = Extract<AgentLoopInput, { kind: "message" }>;

interface MessageInputEffects {
  clearRequestContext(): void;
  logicalTurnStarted(origin: "user" | "background"): void;
  pushUser(content: string | ContentBlock[], humanTyped: boolean, metadata?: LoopUserMetadata): void | Promise<void>;
  /** Charges the loop's context admission budget (ContextAdmission.admit). */
  admit(chars: number, delivered?: readonly string[]): void;
  visibleReplyRequired(): void;
}

/** Applies one message input's provenance and logical-turn side effects. */
export async function consumeAgentLoopMessageInput(
  input: MessageInput,
  startLogicalTurn: boolean,
  preserveRequestContext: boolean,
  effects: MessageInputEffects,
): Promise<"continue"> {
  const visible = input.origin !== "silent-system";
  // A message from another session is visible, but it is never the intent
  // of the person: it keeps the request context and the output-limit
  // allowance, as a background notification does. It requires no reply
  // either: most messages need none, and a forced reply becomes an
  // acknowledgement that wakes the sender again. The envelope tells the
  // recipient when an answer is due.
  const personTurn = visible && input.origin !== "session";
  if (startLogicalTurn) {
    if (personTurn && !preserveRequestContext) effects.clearRequestContext();
    effects.logicalTurnStarted(personTurn ? "user" : "background");
  }
  const content = chatInputContent(input);
  await effects.pushUser(content, visible, {
    ...(input.invocation ? { invocation: input.invocation } : {}),
    ...(input.dispatchIds ? { dispatchIds: input.dispatchIds } : {}),
    ...(input.backgroundNotificationIds ? { backgroundNotificationIds: input.backgroundNotificationIds } : {}),
    ...(input.origin === "human" ? { origin: "human" as const } : {}),
    ...(input.submissionIds ? { submissionIds: input.submissionIds } : {}),
    ...(input.producer ? { producer: input.producer } : {}),
    ...(input.runtimeNotice ? { runtimeNotice: true as const } : {}),
  });
  // Every input enters the history here, live and reconciled completions
  // alike, so here it draws from the admission budget and releases the holds
  // of the results that it delivers.
  effects.admit(typeof content === "string" ? content.length : textChars(content), input.backgroundNotificationIds?.flatMap(completionWorkIds));
  if (personTurn || (input.backgroundNotificationIds?.length ?? 0) > 0) effects.visibleReplyRequired();
  return "continue";
}

/** A person's Resume of an interrupted turn: it starts the logical turn and
 *  records the continuation the model reads. The turn-end record before it
 *  says who interrupted the turn; this is the only message that asks the
 *  model to continue. */
export async function consumeAgentLoopResumeInput(startLogicalTurn: boolean, effects: MessageInputEffects): Promise<"continue"> {
  if (startLogicalTurn) effects.logicalTurnStarted("user");
  await effects.pushUser(CONTINUATION_MESSAGES.resumed, false);
  effects.visibleReplyRequired();
  return "continue";
}
