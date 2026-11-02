interface ConversationContentBlock {
  type: string;
  id?: string;
  signature?: string;
  redacted?: boolean;
  encrypted_content?: string;
  summary?: unknown;
  providerCallId?: string;
  providerItemId?: string;
}

interface ProviderAttributedMessage {
  kind: "user" | "assistant" | "system" | "toolResult" | "compactionSummary";
  content: string | ConversationContentBlock[];
  toolUseId?: string;
  api?: "openai-responses" | "anthropic-messages" | "google-generative-ai";
  provider?: "openai" | "anthropic" | "google";
  model?: string;
  responseId?: string;
  stopReason?: string;
  timestamp?: number;
}

/** Returns copies of the messages without provider response metadata
 *  (api, provider, model, response id, stop reason, timestamp) and without
 *  provider-native thinking or reasoning blocks and signatures, so that any
 *  provider can replay them. The input is not changed. */
export function stripProviderReasoningBlocks<T extends ProviderAttributedMessage>(messages: ReadonlyArray<T>): T[] {
  return messages.map((message) => {
    const { api: _api, provider: _provider, model: _model, responseId: _responseId, stopReason: _stopReason, timestamp: _timestamp, ...neutralMessage } = message;
    // SAFETY: Removing provider metadata preserves every required field of the generic message subtype.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: generic subtype metadata removal preserves all required subtype fields
    if (typeof neutralMessage.content === "string") return { ...neutralMessage } as T;
    // SAFETY: Filtering provider reasoning blocks preserves every required field of the generic message subtype.
    // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: generic subtype content normalization preserves all required subtype fields
    return {
      ...neutralMessage,
      content: neutralMessage.content
        .filter((block) => block.type !== "thinking" && block.type !== "reasoning")
        .map((block) => {
          const {
            signature: _signature,
            encrypted_content: _encrypted_content,
            ...neutralBlock
          } = block;
          return { ...neutralBlock };
        }),
    } as T;
  });
}
