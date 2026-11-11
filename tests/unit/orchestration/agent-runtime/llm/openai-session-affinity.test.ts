import { describe, expect, it, spyOn } from "bun:test";
import { Redacted } from "effect";
import OpenAI from "openai";
import * as transport from "../../../../../src/orchestration/agent-runtime/llm/chatgpt-adapter/transport.js";
import { createOpenAIAdapter } from "../../../../../src/orchestration/agent-runtime/llm/openai.js";
import { collectStreamEvents, REASONING_INFO } from "./_openai-chatgpt-adapter-fixtures.js";
import { wireResponse } from "./_wire-fixtures.js";
import { buildWebSocketHeaders } from "../../../../../src/orchestration/agent-runtime/llm/chatgpt-adapter/request.js";
import { buildOpenAIParams, openAISessionAffinityHeaders } from "../../../../../src/orchestration/agent-runtime/llm/openai-helpers.js";
import type { StreamOptions } from "../../../../../src/orchestration/agent-runtime/llm/types.js";

function streamOptions(overrides: Partial<StreamOptions>): StreamOptions {
  return { messages: [], tools: [], systemPrompt: stableSystemPrompt(""), ...overrides };
}

describe("openAISessionAffinityHeaders", () => {
  it("sends session_id (underscore) for the plain OpenAI API", () => {
    const headers = openAISessionAffinityHeaders(streamOptions({ providerSessionKey: "conversation-1" }), false);
    expect(headers).toEqual({ session_id: "conversation-1", "x-client-request-id": "conversation-1" });
  });

  it("sends all ChatGPT affinity header spellings from one value", () => {
    const headers = openAISessionAffinityHeaders(streamOptions({ providerSessionKey: "conversation-1" }), true);
    expect(headers).toEqual({ "session-id": "conversation-1", session_id: "conversation-1", "x-client-request-id": "conversation-1" });
  });

  it("preserves the existing 64-code-point session identity normalization", () => {
    const longKey = "k".repeat(80);
    const headers = openAISessionAffinityHeaders(streamOptions({ providerSessionKey: longKey }), true);
    expect(headers?.["session-id"]).toBe("k".repeat(64));
    expect(headers?.["x-client-request-id"]).toBe("k".repeat(64));
  });

  it("preserves session identity when compaction disables caching", () => {
    for (const isChatGPT of [false, true]) {
      expect(openAISessionAffinityHeaders(streamOptions({ providerSessionKey: "conversation-1", cacheRetention: "none" }), isChatGPT))
        .toEqual(openAISessionAffinityHeaders(streamOptions({ providerSessionKey: "conversation-1" }), isChatGPT));
    }
  });

  it("omits sessionless headers", () => {
    expect(openAISessionAffinityHeaders(streamOptions({}), true)).toEqual({});
    expect(openAISessionAffinityHeaders(streamOptions({ cacheRetention: "none" }), false)).toEqual({});
  });
});

describe("prompt-cache key and session identity", () => {
  it("sends the request's cache group as the prompt-cache key and the runner's identity in the headers", () => {
    const options = streamOptions({ providerSessionKey: "subagent-conversation", promptCacheKey: "tree-root", cacheRetention: "1h" });
    const params = buildOpenAIParams("gpt-5.4", [], "", [], false, "medium", { ...REASONING_INFO, reasoning: false }, options, "openai_api");
    expect(params.prompt_cache_key).toBe("tree-root");
    expect(openAISessionAffinityHeaders(options, false)).toEqual({ session_id: "subagent-conversation", "x-client-request-id": "subagent-conversation" });
  });

  // ChatGPT groups its prompt cache by the session header and ignores the body key, so the
  // header carries the tree's cache group; the request id keeps the conversation identity.
  it("sends the cache group in the ChatGPT session headers and the identity as the request id", () => {
    const options = streamOptions({ providerSessionKey: "subagent-conversation", promptCacheKey: "tree-root", cacheRetention: "1h" });
    const params = buildOpenAIParams("gpt-5.4", [], "", [], true, "medium", { ...REASONING_INFO, reasoning: false }, options, "chatgpt");
    expect(params.prompt_cache_key).toBe("tree-root");
    expect(openAISessionAffinityHeaders(options, true)).toEqual({ "session-id": "tree-root", session_id: "tree-root", "x-client-request-id": "subagent-conversation" });
  });
});

describe("cache-disabled session-backed requests", () => {
  it("omits prompt-cache keys and retention without dropping identity", () => {
    for (const isChatGPT of [false, true]) {
      const options = streamOptions({ providerSessionKey: "compaction-session", promptCacheKey: "tree-root", cacheRetention: "none", reasoningEffort: "max" });
      const params = buildOpenAIParams("gpt-5.4", [], "", [], isChatGPT, "max", { ...REASONING_INFO, reasoning: false }, options, isChatGPT ? "chatgpt" : "openai_api");
      expect(params).not.toHaveProperty("prompt_cache_key");
      expect(params).not.toHaveProperty("prompt_cache_retention");
      expect(params).not.toHaveProperty("previous_response_id");
      expect(openAISessionAffinityHeaders(options, isChatGPT)).toMatchObject({ session_id: "compaction-session", "x-client-request-id": "compaction-session" });
    }
  });

  it("passes compaction identity to WebSocket selection and SSE fallback", async () => {
    const selectTransport = spyOn(transport, "tryChatGptAdapterTransport").mockResolvedValue(null);
    const requests: Request[] = [];
    const fetch = spyOn(OpenAI.prototype, "fetchWithTimeout").mockImplementation(async (input, init) => {
      requests.push(new Request(input, init));
      return wireResponse([{ type: "response.completed", response: { id: "resp-1", status: "completed", output: [] } }]);
    });
    try {
      const client = await createOpenAIAdapter({
        kind: "chatgpt", accessToken: Redacted.make("test-access"), refreshToken: Redacted.make("test-refresh"),
        expiresAtMs: Date.now() + 3_600_000,
      }, "gpt-5.4", REASONING_INFO);
      await collectStreamEvents(client, { providerSessionKey: "compaction-session", promptCacheKey: "tree-root", cacheRetention: "none", reasoningEffort: "max" });
      expect(selectTransport.mock.calls[0]?.[0]).toMatchObject({ providerSessionKey: "compaction-session", promptCacheKey: "tree-root", cacheRetention: "none" });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.headers.get("session-id")).toBe("compaction-session");
      expect(requests[0]?.headers.get("session_id")).toBe("compaction-session");
      expect(requests[0]?.headers.get("x-client-request-id")).toBe("compaction-session");
      const body = await requests[0]?.json();
      expect(body).not.toHaveProperty("prompt_cache_key");
      expect(body).not.toHaveProperty("prompt_cache_retention");
    } finally {
      selectTransport.mockRestore();
      fetch.mockRestore();
    }
  });
});

describe("buildWebSocketHeaders", () => {
  it("sends the session affinity headers on the handshake", async () => {
    const affinity = { "session-id": "tree-root", session_id: "tree-root", "x-client-request-id": "conversation-1" };
    const headers = await buildWebSocketHeaders("acct-123", Redacted.make("token"), affinity);
    expect(headers.get("session-id")).toBe("tree-root");
    expect(headers.get("session_id")).toBe("tree-root");
    expect(headers.get("x-client-request-id")).toBe("conversation-1");
  });
});
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
