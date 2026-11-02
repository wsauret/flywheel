import { asRecord } from "../../../infra/record.js";

interface AnthropicProviderMetadata {
  [key: string]: unknown;
}

export function anthropicProviderMetadata(event: unknown): AnthropicProviderMetadata {
  const data = asRecord(event);
  const delta = asRecord(data?.delta);
  const contentBlock = asRecord(data?.content_block);
  const message = asRecord(data?.message);
  return {
    index: data?.index,
    deltaType: delta?.type,
    ...(typeof delta?.estimated_tokens === "number" ? { estimatedTokens: delta.estimated_tokens } : {}),
    contentBlockType: contentBlock?.type,
    responseId: message?.id,
    // The served model, as `message_start` names it: a dated id, never content.
    ...(typeof message?.model === "string" ? { responseModel: message.model } : {}),
    hasUsage: data?.usage !== undefined,
  };
}
