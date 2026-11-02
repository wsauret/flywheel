/**
 * Shared fixtures for openai-chatgpt-adapter tests.
 *
 * Each test file calls `installChatGptAdapterModuleMocks()` at top level to
 * install the openai + openai-chatgpt mocks for that file and restore the
 * real modules when the file finishes. This module also exports mutable
 * state (streamEvents, lastResponsesCreateParams) used by each test file to
 * control and observe mocked responses.
 */

import { afterAll, spyOn } from "bun:test";
import { z } from "zod";
import { Redacted } from "effect";
import * as RealOpenAIModule from "openai";
import type { ModelsClient, ModelInfo } from "../../../../../src/infra/llm/models.js";
import { mapChatGptAdapterEvents } from "../../../../../src/orchestration/agent-runtime/llm/chatgpt-adapter/sse.js";
import type { LLMClient, StreamEvent } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import type { StoredTokens } from "../../../../../src/infra/auth/openai-auth-types.js";
import * as realOpenAiChatgpt from "../../../../../src/orchestration/agent-runtime/llm/openai-chatgpt.js";
import * as realChatGptAdapterTransport from "../../../../../src/orchestration/agent-runtime/llm/chatgpt-adapter/transport.js";
import { wireResponse } from "./_wire-fixtures.js";

interface UnknownRecord {
  [key: string]: unknown;
}


// The adapters' error classifiers narrow with `instanceof` against the real
// SDK error classes, so the fake reuses them from the captured real module.
const OpenAI = RealOpenAIModule.default;

type EnsureFreshOptions = NonNullable<Parameters<typeof realOpenAiChatgpt.ensureFreshChatGPTTokens>[1]>;

const stubModelInfos = new WeakMap<ModelsClient, ModelInfo | null>();

export function stubModelsClient(info: ModelInfo | null = null): ModelsClient {
  const client: ModelsClient = {
    async refresh() {},
    getProviderCatalog(providerIds) {
      if (!info || !providerIds.includes(info.provider)) return [];
      return [{
        providerId: info.provider,
        providerName: info.provider,
        wireModelId: info.id,
        metadata: info,
        provenance: "bundled",
        canonical: { providerId: info.provider, modelId: info.id },
        transport: null,
      }];
    },
    getTokenizerIdentity() {
      return undefined;
    },
  };
  stubModelInfos.set(client, info);
  return client;
}

export function stubModelInfo(client: ModelsClient): ModelInfo | null {
  return stubModelInfos.get(client) ?? null;
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
  openWeights: false,
  modalities: { input: ["text"], output: ["text"] },
  contextLimit: 1_050_000,
  outputLimit: 128_000,
  cost: {
    input: 2.5,
    output: 15,
    cacheRead: 0.25,
    highContext: { threshold: 200_000, input: 5, output: 22.5, cacheRead: 0.5 },
  },
  pricing: {
    status: "available",
    rateCard: { input: 2.5, output: 15, cacheRead: 0.25, highContext: { threshold: 200_000, input: 5, output: 22.5, cacheRead: 0.5 } },
    provenance: { source: "models.dev", catalog: "live", provider: "openai", model: "gpt-5.4" },
  },
};

interface AdapterState {
  streamEvents: UnknownRecord[];
  webSocketStreamEvents: UnknownRecord[] | undefined;
  lastResponsesCreateParams: UnknownRecord | undefined;
  invocationOrder: string[];
  ensureFreshCalls: Array<{ signal?: AbortSignal }>;
  ensureFreshImpl: ((seed: StoredTokens, options?: EnsureFreshOptions) => Promise<StoredTokens>) | undefined;
}

export const state: AdapterState = {
  streamEvents: [],
  webSocketStreamEvents: undefined,
  lastResponsesCreateParams: undefined,
  invocationOrder: [],
  ensureFreshCalls: [],
  ensureFreshImpl: undefined,
};

async function* emitFrames(frames: Array<UnknownRecord>): AsyncGenerator<UnknownRecord> {
  for (const frame of frames) yield frame;
}

/** Installs faithful SDK transport and credential seams for one test file, then restores them when the file finishes. */
export function installChatGptAdapterModuleMocks(): void {
  const openAi = spyOn(OpenAI.prototype, "fetchWithTimeout").mockImplementation(async (input, init) => {
    state.invocationOrder.push("sse");
    state.lastResponsesCreateParams = z.record(z.string(), z.unknown()).parse(await new Request(input, init).json());
    return wireResponse(state.streamEvents);
  });
  const ensureFresh = spyOn(realOpenAiChatgpt, "ensureFreshChatGPTTokens").mockImplementation(async (seed, options) => {
    state.ensureFreshCalls.push({ signal: options?.signal });
    if (state.ensureFreshImpl) return state.ensureFreshImpl(seed, options);
    return {
      accessToken: Redacted.make("chatgpt-access-token"),
      refreshToken: Redacted.make("chatgpt-refresh-token"),
      expiresAtMs: Date.now() + 60_000,
    };
  });
  const transport = spyOn(realChatGptAdapterTransport, "tryChatGptAdapterTransport").mockImplementation(async (args) => {
    const frames = state.webSocketStreamEvents;
    if (!frames) return null;
    await args.onDispatch?.();
    state.invocationOrder.push("websocket");
    state.webSocketStreamEvents = undefined;
    return { events: mapChatGptAdapterEvents(emitFrames(frames)), commitContinuation: () => {} };
  });

  afterAll(() => {
    openAi.mockRestore();
    ensureFresh.mockRestore();
    transport.mockRestore();
  });
}

export function setMockResponseUsage(overrides?: {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  cachedTokens?: number;
  serviceTier?: string;
}): void {
  const inputTokens = overrides?.inputTokens ?? 1000;
  const outputTokens = overrides?.outputTokens ?? 200;
  const reasoningTokens = overrides?.reasoningTokens ?? 50;
  const cachedTokens = overrides?.cachedTokens ?? 0;
  state.streamEvents = [
    { type: "response.created", response: { id: "resp_test" } },
    {
      type: "response.completed",
      response: {
        id: "resp_test",
        status: "completed",
        ...(overrides?.serviceTier ? { service_tier: overrides.serviceTier } : {}),
        usage: {
          input_tokens: inputTokens,
          input_tokens_details: { cached_tokens: cachedTokens },
          output_tokens: outputTokens,
          output_tokens_details: { reasoning_tokens: reasoningTokens },
        },
        output: [],
      },
    },
  ];
}

export async function collectStreamEvents(
  client: LLMClient,
  overrides?: Partial<Parameters<LLMClient["streamWithTools"]>[0]>,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of client.streamWithTools({
    messages: [{ kind: "user", content: "hi" }],
    tools: [],
    systemPrompt: stableSystemPrompt(""),
    ...overrides,
  })) {
    events.push(event);
  }
  return events;
}
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
