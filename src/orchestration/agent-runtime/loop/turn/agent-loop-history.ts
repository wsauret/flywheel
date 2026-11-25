import type { CapabilityCheck } from "../../../../infra/definitions/capability-text.js";
import { stripProviderReasoningBlocks } from "../../../../infra/providers/llm/provider-reasoning-blocks.js";
import type { ServingAttempt } from "../../llm/types.js";
import type { ContentBlock, ConversationMessage } from "../../../../infra/providers/llm/conversation/conversation-message.js";
import { redactMessage } from "../../../session/conversation/redact-message.js";
import { healConversation } from "../../../session/conversation/tree/heal-messages.js";

import type { AgentLoopOptions, AgentLoopPersistence, AgentLoopSeed, HistorySink } from "../../agent-loop-types.js";
import type { UserInputProducer } from "../../../../infra/substrate/events/chat-input.js";
import type { AssistantProvenance } from "./assistant-message-settlement.js";
import { toolResultMessages, type ToolResultEntry } from "./agent-state.js";
import { isAnthropicNarration } from "../../../../infra/providers/llm/anthropic-narration.js";

/** One canonical append funnel for produced content, tool results, and user input.
 * Produced content is redacted; human-typed content passes through unchanged. A system message is echoed to
 * `onSystemMessage` from its committed content, so the live transcript shows the row a reopen projects. */
export function createLoopMessageWriters(input: {
  messages(): ConversationMessage[];
  history: HistorySink;
  onUserMessage: AgentLoopOptions["onUserMessage"];
  onSystemMessage: AgentLoopOptions["onSystemMessage"];
  assistantContentCommitted(visible: boolean): void;
}) {
  const pushMessage = async (raw: ConversationMessage, humanTyped = false, entryId?: string): Promise<ConversationMessage> => {
    const message = redactMessage(raw, humanTyped);
    input.messages().push(message);
    await input.history.append(message, entryId);
    if (message.kind === "system") input.onSystemMessage?.(message.content);
    return message;
  };
  return {
    pushMessage,
    pushUser: createLoopUserWriter(pushMessage, input.onUserMessage),
    async pushAssistant(content: ContentBlock[], provenance?: AssistantProvenance, incomplete?: true, entryId?: string): Promise<void> {
      input.assistantContentCommitted(content.some((block) =>
        block.type === "text" ? block.text.trim().length > 0 : block.type === "thinking" && isAnthropicNarration(block)));
      await pushMessage({ kind: "assistant", content, ...(incomplete ? { incomplete } : {}), ...provenance }, false, entryId);
    },
    async pushToolResults(results: ReadonlyArray<ToolResultEntry>): Promise<void> {
      for (const message of toolResultMessages(results)) await pushMessage(message);
    },
  };
}

/** Writes a user message through redaction before echoing its canonical content to observers. */
function createLoopUserWriter(
  append: (message: ConversationMessage, humanTyped?: boolean) => Promise<ConversationMessage>,
  observe: AgentLoopOptions["onUserMessage"],
) {
  return async (content: string | ContentBlock[], humanTyped = false, metadata: LoopUserMetadata = {}): Promise<void> => {
    const message = await append(loopUserMessage(content, metadata), humanTyped);
    if (message.kind === "user") observe?.(message.content, message.origin === "system" ? "system" : "user", message);
  };
}

/** The provenance and delivery ids that one loop input carries from its producer. */
export interface LoopUserMetadata {
  readonly invocation?: { label: string; args?: string };
  readonly dispatchIds?: readonly string[];
  readonly backgroundNotificationIds?: readonly string[];
  readonly origin?: "human";
  readonly submissionIds?: readonly string[];
  readonly producer?: UserInputProducer;
  readonly runtimeNotice?: true;
}

/** Assembles one loop input while preserving the provenance and delivery ids of its producer. */
function loopUserMessage(content: string | ContentBlock[], metadata: LoopUserMetadata): ConversationMessage {
  const { invocation, dispatchIds, backgroundNotificationIds, origin, submissionIds, producer, runtimeNotice } = metadata;
  return {
    kind: "user", content,
    ...(origin ? { origin } : {}),
    ...(invocation ? { invocation } : {}),
    ...(submissionIds?.length ? { submissionIds } : {}),
    ...(producer ? { producer } : {}),
    ...(dispatchIds?.length ? { dispatchIds } : {}),
    ...(backgroundNotificationIds?.length ? { backgroundNotificationIds, replyRequired: true } : {}),
    ...(runtimeNotice ? { runtimeNotice } : {}),
  };
}

/** Where provider and module entries enter canonical history: the canonical writer, the echo of each committed user
 *  message, and the flush before request accounting. */
interface EntryWriter {
  append(message: ConversationMessage): Promise<ConversationMessage>;
  onUserMessage?: AgentLoopOptions["onUserMessage"];
  flush?: () => Promise<void>;
}

/** Appends adapter-produced messages and the modules' turn reminders through the canonical writer, echoes its
 *  redacted result, and flushes before request accounting. Both read the history before either is appended. */
export async function appendProviderHistory(input: EntryWriter & {
  attempt: ServingAttempt;
  messages: readonly ConversationMessage[];
  turnReminders?: ((messages: readonly ConversationMessage[]) => Promise<readonly ConversationMessage[]>) | undefined;
  executionCwd: string;
  /** The agent check of the request (ARCH-CONTEXT-033). */
  capabilities: CapabilityCheck;
}): Promise<void> {
  await appendEntries(input, [
    ...input.attempt.messagesToAppend?.(input.messages, input.executionCwd, input.capabilities) ?? [],
    ...await input.turnReminders?.(input.messages) ?? [],
  ]);
}

/** Appends `entries` through `writer`, echoes each committed user message, and flushes once. */
export async function appendEntries(writer: EntryWriter, entries: readonly ConversationMessage[]): Promise<void> {
  if (entries.length === 0) return;
  for (const entry of entries) {
    const message = await writer.append(entry);
    if (message.kind === "user") writer.onUserMessage?.(message.content, "system");
  }
  await writer.flush?.();
}

/** The source history that a fork child starts from. The shared host's framing and the tool notice are left out: they
 *  name the source session or its grants, and the child's own requests carry its own tiers and grants. */
export function captureForkMessages(
  messages: readonly ConversationMessage[],
  captureCommitted?: () => Promise<ReadonlyArray<ConversationMessage>>,
): Promise<ConversationMessage[]> {
  if (captureCommitted) {
    return captureCommitted().then((committed) => stripProviderReasoningBlocks(committed.filter(isForkable)));
  }
  return Promise.resolve(stripProviderReasoningBlocks(healConversation(messages.filter(isForkable))));
}

function isForkable(message: ConversationMessage): boolean {
  return message.kind !== "user" || (message.framing !== "agent-host" && message.framing !== "tool-notice");
}

/** The input that the trailing turn answers: the trailing alternating message (`trailingAlternatingMessage`), past
 *  the request framing that follows it (a tool notice, a moved system tier, the engine's text, the turn context).
 *  Framing is part of the request, not an input, so it is never echoed and never owes a reply. An environment or date
 *  reminder counts as the input here, as it did before its `reminder` label. */
function trailingTurnInput(messages: readonly ConversationMessage[]): ConversationMessage | undefined {
  return messages.findLast((message) => message.kind !== "system" && (message.kind !== "user" || message.framing === undefined || message.framing === "reminder"));
}

/** Echoes the trailing user turn of a resume-seeded loop - committed to the
 *  tree before the runner started (chat sends, workers) or carried in a fork
 *  seed - so the first message of every life gets its
 *  model.user_message.recorded fact. */
function seedResumedTurn(messages: readonly ConversationMessage[], onUserMessage?: AgentLoopOptions["onUserMessage"]): void {
  const tail = trailingTurnInput(messages);
  if (tail?.kind === "user") onUserMessage?.(tail.content, tail.origin === "system" ? "system" : "user", tail);
}

/** Seeds the first turn of a loop life from `seed`: a fresh or continue seed appends `instruction` as the next user
 *  message, and a resume seed echoes the committed tail. Returns true when the seeded turn owes the person a visible
 *  reply. Throws when a fresh or continue seed has no instruction. */
export async function seedAgentLoopTurn(input: {
  seed: AgentLoopSeed;
  messages: readonly ConversationMessage[];
  instruction: string | null;
  onUserMessage?: AgentLoopOptions["onUserMessage"];
  pushUser: (content: string) => void | Promise<void>;
}): Promise<boolean> {
  const { messages, instruction, onUserMessage } = input;
  if (input.seed.kind !== "resume") {
    if (instruction === null) {
      // Writer invariant: only resume-seeded lives are woken without an
      // instruction (worker respawn). Any other seed with nothing to seed would
      // send the provider no user message for its turn.
      throw new Error("runAgentLoop: wake input (instruction null) requires a resume seed");
    }
    await input.pushUser(instruction);
    return true;
  }
  seedResumedTurn(messages, onUserMessage);
  // Production chat seeds each life with the user's message already
  // committed to the tree, so the resume tail is where reply debt starts.
  // A message from another session owes no visible reply here either, as
  // in `consumeAgentLoopMessageInput`.
  const tail = trailingTurnInput(messages);
  return tail?.kind === "user" && tail.producer?.kind !== "session" && (tail.origin !== "system" || tail.replyRequired === true);
}

/** Records that a person interrupted the running turn and holds the durable
 *  record in the loop's own history, so a live resume and one after a
 *  restart read the same past. The flush lands the record behind the cut
 *  turn's results before any input the park consumes, so the tree keeps the
 *  order this history has. A loop whose history nothing persists records
 *  nothing. True when it recorded the turn end. */
export async function recordInterruptedTurn(
  persistence: AgentLoopPersistence,
  hold: (record: ConversationMessage) => void,
  flush: (() => Promise<void>) | undefined,
): Promise<boolean> {
  const record = await persistence.recordInterruption?.();
  if (!record) return false;
  hold(record);
  await flush?.();
  return true;
}
