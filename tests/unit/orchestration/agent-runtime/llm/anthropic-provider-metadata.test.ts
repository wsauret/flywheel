import { describe, expect, it } from "bun:test";
import { anthropicProviderMetadata } from "../../../../../src/orchestration/agent-runtime/llm/anthropic-provider-metadata.js";

describe("Anthropic provider stream metadata", () => {
  it("names the model that served the response from its message_start, and nothing of other events", () => {
    const start = { type: "message_start", message: { id: "msg_1", model: "claude-sonnet-5-5-20260915", usage: { input_tokens: 3 } } };
    expect(anthropicProviderMetadata(start)).toMatchObject({ responseId: "msg_1", responseModel: "claude-sonnet-5-5-20260915" });
    expect(anthropicProviderMetadata({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "secret" } })).not.toHaveProperty("responseModel");
  });
});
