import type { AgentLoopInput } from "../../infra/agent-loop-events.js";
import type { MessageProducer, SessionInputProducer } from "../../infra/chat-input.js";
import type { ConversationMessage } from "./llm/types.js";
import { MESSAGE_SESSION_TOOL_NAME } from "./tools/message-session.js";

/** What the hop rule reads of an input: who produced it. A stored user
 *  entry and a message input that the loop consumes both carry it. */
interface HopInput {
  readonly origin?: string;
  readonly producer?: MessageProducer;
}

/** The wake hop after one input, from the hop before it. This is the one
 *  hop rule (ARCH-SESSIONS-033). An input starts a turn when the session
 *  answered its last turn; otherwise a running turn reads it.
 *  - The person's input and a launch set hop 0: a person acts, or a new run
 *    begins.
 *  - A session message that starts a turn wakes the session: hop of the
 *    message plus one. The turn joins the chain of that message alone.
 *  - A message from a peer (a `sibling` or `other` sender) that a running
 *    turn reads, and that does not answer a wait of the reader, is one more
 *    step of a chain between peers: the hop rises to the hop of the message
 *    plus one. So peers that wait on background work, which no message
 *    wakes, still reach the wake limit.
 *  - Any other session message that a running turn reads joins the turn to
 *    the chain of that message: the hop rises to the hop of the message. A
 *    reply that answers a wait of the reader leaves the hop, because the turn
 *    asked for it and the turn that waits bounds it. A parent and its child
 *    take this rule, so a parent that talks with its children while it waits
 *    on them keeps its hop, and the end of the child's run bounds the talk.
 *    A message with no envelope, from older history, takes it too.
 *  - Any other input (a Resume, a turn-end record, a completion notice, a
 *    nudge, an instruction) leaves the hop. A turn that it starts continues
 *    the chain of the turn before it.
 *  `end` bounds the history before the input, which the reply-wait test reads. */
function hopAfter(hop: number, input: HopInput, startsTurn: boolean, history: readonly ConversationMessage[], end: number): number {
  const producer = input.producer;
  if (input.origin === "human" || producer?.kind === "human" || producer?.kind === "launch") return 0;
  if (producer?.kind !== "session") return hop;
  if (startsTurn) return producer.hop + 1;
  if (answersReplyWait(history, end, producer)) return hop;
  const relation = producer.envelope?.relation;
  const step = relation === "sibling" || relation === "other" ? 1 : 0;
  return Math.max(hop, producer.hop + step);
}

/** Whether the next input after `message` starts a turn: the model answered
 *  with no tool call and its stream finished. A compaction summary begins the
 *  readable history, as the start of the history does. */
function endsTurn(message: ConversationMessage): boolean {
  if (message.kind === "compactionSummary") return true;
  if (message.kind !== "assistant" || message.incomplete === true) return false;
  return typeof message.content === "string" || !message.content.some((block) => block.type === "tool_use");
}

/** Folds `hopAfter` over the user entries of `history` from `from`. The entry
 *  before `from` tells whether the first input starts a turn, so a fold that
 *  begins after an answer and a fold that begins after a tool result read the
 *  same input as the whole history reads it. `from` never points past a system
 *  entry, which tells nothing about a turn. */
function foldHop(history: readonly ConversationMessage[], from: number, initialHop: number): number {
  const prior = history[from - 1];
  let hop = initialHop;
  let next = prior === undefined || endsTurn(prior);
  for (let index = from; index < history.length; index += 1) {
    const message = history[index];
    if (!message || message.kind === "system") continue;
    if (message.kind === "user") {
      hop = hopAfter(hop, message, next, history, index);
      next = false;
    } else next = endsTurn(message);
  }
  return hop;
}

/** The wake hop of the turn that `history` ends in, read from the history
 *  alone, as a loop that starts or resumes reads it. So a successor that
 *  resumes a turn that a planned replacement or a crash cut keeps the hop of
 *  the turn that it continues, and the bound needs no counter.
 *
 *  The history does not show one fact that the live loop knows: whether the
 *  session still waited on background work when an input came after its
 *  answer. The history reads such an input as one that started a turn
 *  (`trackTurnHop`), so it keeps the chain of that input and drops a higher
 *  hop that the turn had from another chain. So a resumed loop can hold a
 *  lower hop than the live loop held, never a higher one. */
export function turnHopOf(history: readonly ConversationMessage[]): number {
  return foldHop(history, 0, 0);
}

/** The first entry of the run of user and system entries that ends `history`. */
function trailingInputStart(history: readonly ConversationMessage[]): number {
  let index = history.length;
  while (index > 0 && (history[index - 1]?.kind === "user" || history[index - 1]?.kind === "system")) index -= 1;
  return index;
}

/** The wake hop of a loop's current turn, which tools read when they send. */
export interface TurnHopTracker {
  current(): number;
  /** Updates the hop after the loop consumes `input`. */
  observe(input: AgentLoopInput | null | undefined, startsTurn: boolean): void;
}

/** Whether `message` answers a reply wait of the reader: the latest
 *  `message_session` call of the reader to its sender asked to wait, and no
 *  other message from the sender came after that call. This is rule 1 of the
 *  reply waits (`endReplyWaitsByMessage`), read from the history before
 *  `end`, so that a replay of the turn decides the same. The loop can append
 *  `message` before it is observed, so the walk passes over that entry. */
function answersReplyWait(history: readonly ConversationMessage[], end: number, message: SessionInputProducer): boolean {
  for (let index = end - 1; index >= 0; index -= 1) {
    const entry = history[index];
    if (entry?.kind === "user" && entry.producer?.kind === "session" && entry.producer.sessionId === message.sessionId) {
      if (entry.producer.toolUseId !== message.toolUseId) return false;
      continue;
    }
    if (entry?.kind !== "assistant" || typeof entry.content === "string") continue;
    for (const block of entry.content.toReversed()) {
      if (block.type !== "tool_use" || block.name !== MESSAGE_SESSION_TOOL_NAME) continue;
      if (typeof block.input.to === "string" && block.input.to.trim() === message.sessionId) return block.input.wait === true;
    }
  }
  return false;
}

/** The hop of a running loop. The loop reads its first hop from its history
 *  (`turnHopOf`). After that it applies the same rule (`hopAfter`) to each
 *  input it consumes, from what it knows of the input: `startsTurn` is true
 *  when a park takes the input and the loop runs again, after an answer or
 *  after an interrupt. The history then tells, as it tells `turnHopOf`,
 *  whether the cut turn read the inputs that end it. The loop holds the
 *  hop as a number, so the hop survives a compaction of the history, and an
 *  input that reaches a turn that waits on background work after its answer
 *  is read as a running turn reads it. Without that, a parent that talks with
 *  its children while it waits on them would raise its hop each time, though
 *  no message woke it. */
export function trackTurnHop(history: () => readonly ConversationMessage[]): TurnHopTracker {
  let hop: number | undefined;
  const current = (): number => (hop ??= turnHopOf(history()));
  return {
    current,
    observe(input, startsTurn) {
      if (hop === undefined) {
        current();
        return;
      }
      const entries = history();
      // The input joins the inputs that end the history, such as a held
      // message. The first of them starts the turn only after an answer:
      // after an interrupt the run can follow a tool result, and its first
      // entry is then a message that the cut turn read.
      if (startsTurn) hop = foldHop(entries, trailingInputStart(entries), hop);
      else {
        const message = input?.kind === "message" ? input : input?.kind === "request-context" ? input.input : undefined;
        if (message) hop = hopAfter(hop, message, false, entries, entries.length);
      }
    },
  };
}
