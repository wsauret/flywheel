/**
 * Fixtures for the hidden WebSocket acceptance test. This is a copy of the
 * repository's ChatGPT adapter fixtures, kept inside acceptance/ so that an edit
 * under tests/ cannot change how the hidden test serves its frames.
 *
 * Importing this module installs the openai, openai-chatgpt, and transport mocks.
 * The transport mock serves scripted WebSocket frames the way production does:
 * the real WebSocket path sends every socket frame through the backend frame
 * mapper before the adapter sees it.
 */

import { mock } from "bun:test";
import { Redacted } from "effect";
import type { ModelsClient, ModelInfo } from "../src/infra/llm/models.js";
import { mapChatGptBackendEvents } from "../src/orchestration/agent-runtime/llm/chatgpt-backend/sse.js";
import type { LLMClient, StreamEvent } from "../src/orchestration/agent-runtime/llm/types.js";

export function stubModelsClient(info: ModelInfo | null = null): ModelsClient {
  return {
    async getModelInfo() {
      return info;
    },
  };
}

export const COST_INFO: ModelInfo = {
  provider: "openai",
  family: "openai",
  id: "gpt-5.4",
  name: "GPT 5.4",
  reasoning: false,
  toolCall: true,
  attachment: false,
  temperature: true,
  contextLimit: 1_050_000,
  outputLimit: 128_000,
  cost: {
    input: 2.5,
    output: 15,
    cacheRead: 0.25,
    contextOver200k: { input: 5, output: 22.5, cacheRead: 0.5 },
  },
};

export const state: {
  streamEvents: Array<Record<string, unknown>>;
  /** Frames the WebSocket transport serves instead of falling back to SSE.
   *  The first request consumes them, so later requests keep the SSE default. */
  webSocketStreamEvents?: Array<Record<string, unknown>>;
} = {
  streamEvents: [],
};

async function* emitFrames(frames: Array<Record<string, unknown>>): AsyncGenerator<Record<string, unknown>> {
  for (const frame of frames) yield frame;
}

const responsesCreate = mock(() => emitFrames(state.streamEvents));

class FakeOpenAI {
  // The adapters' error classifiers narrow with `instanceof` against these SDK
  // error classes, so the fake must name every one of them.
  static APIError = class APIError extends Error { status: number | undefined; headers: Headers | undefined };
  static APIConnectionError = class APIConnectionError extends Error {};
  static BadRequestError = class BadRequestError extends Error {};
  static NotFoundError = class NotFoundError extends Error {};
  responses = { create: responsesCreate };
}

const fakeChatGPTClient = { responses: { create: responsesCreate } };

mock.module("openai", () => ({
  default: FakeOpenAI,
}));

mock.module("../src/orchestration/agent-runtime/llm/openai-chatgpt.js", () => ({
  createChatGPTClient: () => fakeChatGPTClient,
  ensureFreshChatGPTTokens: async () => ({
    accessToken: Redacted.make("chatgpt-access-token"),
    refreshToken: Redacted.make("chatgpt-refresh-token"),
    expiresAtMs: Date.now() + 60_000,
  }),
}));

// Without scripted frames the transport declines, so the adapter falls back to
// SSE through the mocked `responses.create` and makes no network request.
mock.module("../src/orchestration/agent-runtime/llm/chatgpt-backend/transport.js", () => ({
  tryChatGptBackendTransport: async () => {
    const frames = state.webSocketStreamEvents;
    if (!frames) return null;
    state.webSocketStreamEvents = undefined;
    return { events: mapChatGptBackendEvents(emitFrames(frames)), commitContinuation: () => {} };
  },
}));

export async function collectStreamEvents(
  client: LLMClient,
  overrides?: Partial<Parameters<LLMClient["streamWithTools"]>[0]>,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of client.streamWithTools({
    messages: [{ role: "user", content: "hi" }],
    tools: [],
    systemPrompt: "",
    ...overrides,
  })) {
    events.push(event);
  }
  return events;
}
