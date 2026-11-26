import type { MessageProducer } from "../../../substrate/events/chat-input.js";
import type { ContentRepair } from "../content-repair.js";
import type { AccessProviderId } from "../access/access-provider.js";
import type { ModelFamily } from "../models/model-family.js";
import type { ReasoningEffort } from "../models/models.js";
import type { LlmToolOutputPart } from "../tool-output-part-schema.js";
import type { MutationEvidence } from "../../../substrate/file-mutations/mutation-evidence.js";
import type { LlmApi, LlmStopReason } from "./messages.js";

/**
 * The conversation message model: one canonical `ConversationMessage` union
 * is the agent loop's state, the persisted form of the conversation, and the
 * input of every provider conversion. The session and the agent runtime both
 * read it, and neither owns it.
 */

export interface UnknownFields { [key: string]: unknown }

export type ContentBlock =
  | { type: "text"; text: string; signature?: string }
  | { type: "image"; mediaType: string; data: string }
  | { type: "tool_use"; id: string; name: string; input: UnknownFields; registrationId?: string; providerItemId?: string; providerCallId?: string; thoughtSignature?: string }
  | { type: "thinking"; thinking: string; signature?: string; redacted?: boolean; presentation?: "progress" }
  | { type: "reasoning"; id: string; encrypted_content: string; summary?: Array<{ type: "summary_text"; text: string }> };

type MessageFraming = "claude" | "model" | "agent-host" | "tool-notice" | "reminder" | "turn-context";

export type ConversationMessage =
  | {
      kind: "user";
      content: string | ContentBlock[];
      /** Explicit delivery provenance. Human input is stamped at human delivery;
       * produced user-role content is stamped by the redaction boundary.
       * Absence is unknown, including historical unmarked messages. */
      origin?: "human" | "system";
      /** Exact producer: the person, another session, or the parent whose
       *  launch gave this assignment. Historical entries can omit it. */
      producer?: MessageProducer;
      /** Inline step/skill invocation display metadata. The content is the full
       *  expanded prompt (model-visible); the transcript renders a divider
       *  divider labeled `label` plus the optional raw `args` instead of the
       *  content. Providers ignore this field. */
      invocation?: { label: string; args?: string };
      /** Durable client display correlation. Providers ignore these ids. */
      submissionIds?: readonly string[];
      /** In-flight recovery keys of queued human inputs this message carries.
       * Ephemeral transport only: the save-point flush retires the keyed cells
       * in the commit that makes the message durable. */
      dispatchIds?: readonly string[];
      /** Distinct recovery keys for system-produced background notifications.
       * They share only the append-and-retire transaction with human input. */
      backgroundNotificationIds?: readonly string[];
      /** A human-facing loop must not park until it has delivered visible text
       * in response to this system-produced input. */
      replyRequired?: true;
      /** A notice of the runtime about the agent's own waits and children: a child's completion, stop, or runtime
       *  interrupt, a reply wait's end without a reply, or a wait's expiry or empty result. A route may deliver it with the
       *  parked tool results that it follows. Only those producers set it; every other input is unlabeled. */
      runtimeNotice?: true;
      /** Request framing that a route wrote into history (`lowerProviderHistory` decides who reads it). `claude` is the
       *  Claude model reminder (`runtime-reminders.ts`), which an Anthropic Messages request to the model that it names reads. `model` is the model
       *  reminder of any other route, which only a request to the model that it names reads. `agent-host` is the shared engine host's
       *  framing: its engine text and each system tier that a hosted agent's conversation carries, which only a request
       *  that the shared host serves reads. `tool-notice` is a tree-hosted agent's tool notice, which every request
       *  reads. `reminder` is an environment or date reminder (`runtime-reminders.ts`), which every request reads.
       *  `turn-context` is the context that the runtime adds for a turn (ARCH-CONTEXT-042), which every request reads
       *  and which is not the input of a turn. A fork copies neither `agent-host` nor `tool-notice` framing, because
       *  each names the source session or its grants. */
      framing?: MessageFraming;
    }
  | {
      kind: "system";
      content: string;
      /** One paged display manifest, excluded from provider context. */
      mutationEvidence?: MutationEvidence;
      /** The decision this message records about content a provider refused;
       *  `content` is its note. Never sent to a provider: the rebuild reads it. */
      contentRepair?: ContentRepair;
      /** When true, the persisted entry is excluded from the rebuilt model
       *  context, recall, and FTS; it survives only for transcript display and
       *  forensics. Set by writers of pure interaction markers (e.g. the durable
       *  turn-interruption marker) that must not re-enter prompts on resume. */
      displayOnly?: boolean;
    }
  | { kind: "compactionSummary"; content: string }
  | {
      kind: "assistant";
      content: string | ContentBlock[];
      incomplete?: true;
      /** Metadata captured from the provider's `done` event. The session
       *  tree persists it, so a rebuilt context keeps it. Absent or
       *  incomplete on partial turns (stream death before `done`), on the
       *  copies a fork takes from its parent (only `accessProvider` stays),
       *  and on tree entries written before 2026-08-10.
       *  Converters treat missing metadata as cross-provider (no verbatim
       *  replay of provider-native blocks). */
      accessProvider?: AccessProviderId;
      api?: LlmApi;
      provider?: ModelFamily;
      model?: string;
      timestamp?: number;
      stopReason?: LlmStopReason;
      responseId?: string;
      /** Reasoning tokens the provider reported for the response that
       *  produced this message. Its thinking or reasoning blocks can hide them
       *  (redacted thinking carries no text), but the provider charges them
       *  again when the same model replays the blocks and reads them, so the
       *  context estimate counts them there. Absent when the provider
       *  reported none, for a partial response, and on messages stored
       *  before 2026-10-08. */
      reasoningTokens?: number;
      /** The reasoning effort that the request of the response asked for, also for a partial response. A Responses
       *  request reads the efforts of earlier turns to send a later change as an appended update where the earlier
       *  request sent it (ARCH-CONTEXT-041). The fold reads it from `chat.reasoning_effort.recorded`, never from the
       *  stored entry. Absent for a request that names no effort and on messages stored before 2026-11-20. */
      reasoningEffort?: ReasoningEffort;
    }
  | { kind: "toolResult"; toolUseId: string; content: LlmToolOutputPart[]; isError?: boolean; interrupted?: boolean; blocked?: boolean };

/** Provider role alternation: tool results travel as user-role payloads. */
export function conversationRole(message: ConversationMessage): "user" | "assistant" | "system" {
  switch (message.kind) {
    case "assistant": return "assistant";
    case "system": return "system";
    default: return "user";
  }
}

/** Last message that occupies a slot in provider role alternation. System
 *  messages sit outside it: every provider conversion skips them from the
 *  wire (the system prompt travels separately in the request options), so
 *  alternation checks and turn seeding look past a trailing run of them.
 *  Undefined when no alternating message exists. */
export function trailingAlternatingMessage(messages: readonly ConversationMessage[]): ConversationMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && message.kind !== "system") return message;
  }
  return undefined;
}

/** The text of the labeled runtime notices after the last assistant message, in history order: the input of the next
 *  request that a route may deliver with the parked tool results. Empty when the tail holds none. */
export function trailingRuntimeNotices(messages: readonly ConversationMessage[]): readonly string[] {
  const notices: string[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined || message.kind === "assistant") break;
    if (message.kind === "user" && message.runtimeNotice === true) {
      notices.unshift(typeof message.content === "string" ? message.content : message.content.map((block) => block.type === "text" ? block.text : "").join(""));
    }
  }
  return notices;
}
