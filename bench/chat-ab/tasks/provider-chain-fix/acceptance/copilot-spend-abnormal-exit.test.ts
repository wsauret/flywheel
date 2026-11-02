/**
 * Hidden acceptance: every adapter that observes Copilot spend finalizes it when
 * the attempt exits abnormally, and one attempt is billed once. The stream tear
 * is a terminal prompt error, so the attempt settles instead of retrying.
 */

import { describe, expect, test } from "bun:test";
import { Redacted } from "effect";
import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";
import type { ModelInfo, ModelsClient } from "../src/infra/llm/models.js";
import { createAnthropicAdapter } from "../src/orchestration/agent-runtime/llm/anthropic.js";
import { createOpenAIAdapter } from "../src/orchestration/agent-runtime/llm/openai.js";
import { createOpenAIChatCompletionsAdapter } from "../src/orchestration/agent-runtime/llm/openai-completions.js";
import {
  createCopilotSpendObserver,
  createProviderAvailability,
  getSharedProviderAvailability,
} from "../src/orchestration/agent-runtime/llm/provider-availability.js";
import type { LLMClient } from "../src/orchestration/agent-runtime/llm/types.js";
import { ContextLengthExceededError, LlmStreamError } from "../src/orchestration/agent-runtime/shared/llm/errors.js";
import { createRetryBudget } from "../src/orchestration/agent-runtime/shared/llm/retry-budget.js";

const TOTAL_NANO_AIU = 4_473_525_000;

function stubModelsClient(info: ModelInfo | null = null): ModelsClient {
  return {
    async getModelInfo() { return info },
    async getProviderModelInfos(requests) {
      return new Map(requests.flatMap((request) => info?.provider === request.providerId ? [[request.key, info] as const] : []))
    },
    async getTokenizerIdentity() { return undefined },
  };
}

const ANTHROPIC_INFO: ModelInfo = {
  provider: "anthropic",
  family: "anthropic",
  id: "claude-sonnet-4-5",
  name: "Claude Sonnet 4.5",
  reasoning: false,
  toolCall: true,
  attachment: false,
  temperature: true,
  contextLimit: 200_000,
  outputLimit: 64_000,
};

// The provider charged the request before the stream tore: the frames carry a
// billed total and the stream then fails.
async function* framesThenFail(values: Array<Record<string, unknown>>): AsyncGenerator<Record<string, unknown>> {
  for (const value of values) yield value;
  throw new ContextLengthExceededError("prompt is too long");
}

async function failedTurn(client: LLMClient): Promise<unknown> {
  try {
    for await (const _event of client.streamWithTools({
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      systemPrompt: "",
    })) { /* drain */ }
  } catch (error) {
    return error;
  }
  throw new Error("expected the stream to fail");
}

async function spendOf(turn: () => Promise<LLMClient>): Promise<number> {
  const adapter = await turn();
  const availability = getSharedProviderAvailability();
  const before = availability.copilotSpendSinceRefreshNanoAiu();

  expect(await failedTurn(adapter)).toBeInstanceOf(ContextLengthExceededError);

  return availability.copilotSpendSinceRefreshNanoAiu() - before;
}

function responsesAdapter(events: () => AsyncGenerator<Record<string, unknown>>): Promise<LLMClient> {
  // SAFETY: test double for the one SDK surface the adapter calls.
  const client = { responses: { create: async () => events() } } as unknown as OpenAI;
  return createOpenAIAdapter({ kind: "apiKey", apiKey: "test-key" }, "gpt-5.5", stubModelsClient(), {
    client,
    accessProvider: "github_copilot",
  });
}

async function spendDelta(run: (availability: ReturnType<typeof getSharedProviderAvailability>) => Promise<void>): Promise<number> {
  const availability = getSharedProviderAvailability();
  const before = availability.copilotSpendSinceRefreshNanoAiu();
  await run(availability);
  return availability.copilotSpendSinceRefreshNanoAiu() - before;
}

describe("Copilot spend when a stream fails after the billed total", () => {
  test("a repeated commit records the request total once", () => {
    const availability = createProviderAvailability({ now: () => 0, fetch: () => { throw new Error("no poll expected") } });
    const observer = createCopilotSpendObserver(availability);

    observer.observe({ copilot_usage: { total_nano_aiu: 1_000 } });
    observer.commit();
    observer.commit();

    expect(availability.copilotSpendSinceRefreshNanoAiu()).toBe(1_000);
  });

  test("the OpenAI Responses adapter commits the observed total", async () => {
    // SAFETY: test double for the one SDK surface the adapter calls.
    const client = { responses: { create: async () => framesThenFail([
      { type: "response.created", response: { id: "resp_1", copilot_usage: { total_nano_aiu: TOTAL_NANO_AIU } } },
      { type: "response.output_text.delta", output_index: 0, delta: "hi" },
    ]) } } as unknown as OpenAI;

    expect(await spendOf(() => createOpenAIAdapter({ kind: "apiKey", apiKey: "test-key" }, "gpt-5.5", stubModelsClient(), {
      client,
      accessProvider: "github_copilot",
    }))).toBe(TOTAL_NANO_AIU);
  });

  test("the OpenAI chat-completions adapter commits the observed total", async () => {
    // SAFETY: test double for the one SDK surface the adapter calls.
    const client = { chat: { completions: { create: async () => framesThenFail([
      {
        id: "chatcmpl_1",
        choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }],
        copilot_usage: { total_nano_aiu: TOTAL_NANO_AIU },
      },
    ]) } } } as unknown as OpenAI;

    expect(await spendOf(() => createOpenAIChatCompletionsAdapter(client, "gpt-5.5", stubModelsClient(), {
      accessProvider: "github_copilot",
    }))).toBe(TOTAL_NANO_AIU);
  });

  test("the Anthropic adapter commits the observed total", async () => {
    const rawStream = {
      controller: new AbortController(),
      [Symbol.asyncIterator]: () => framesThenFail([
        {
          type: "message_start",
          message: { id: "msg_1", usage: { input_tokens: 1, output_tokens: 0 }, copilot_usage: { total_nano_aiu: TOTAL_NANO_AIU } },
        },
      ]),
    };
    // SAFETY: test double for the one SDK surface the adapter calls.
    const client = { messages: { create: () => ({
      withResponse: async () => ({ data: rawStream, response: new Response() }),
    }) } } as unknown as Anthropic;

    expect(await spendOf(() => createAnthropicAdapter(Redacted.make("test-key"), "claude-sonnet-4-5", stubModelsClient(ANTHROPIC_INFO), {
      client,
      accessProvider: "github_copilot",
    }))).toBe(TOTAL_NANO_AIU);
  });

  // Regression guard: this passes on the base. It fails a change that loses the
  // total on normal completion or bills the same request twice.
  test("regression guard: normal completion commits the observed Responses total", async () => {
    async function* completedFrames(): AsyncGenerator<Record<string, unknown>> {
      yield { type: "response.created", response: { id: "resp_1", copilot_usage: { total_nano_aiu: TOTAL_NANO_AIU } } };
      yield {
        type: "response.completed",
        response: {
          id: "resp_1",
          status: "completed",
          output: [],
          usage: {
            input_tokens: 1,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: 1,
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      };
    }

    expect(await spendDelta(async () => {
      const client = await responsesAdapter(completedFrames);
      for await (const _event of client.streamWithTools({ messages: [], tools: [], systemPrompt: "" })) { /* drain */ }
    })).toBe(TOTAL_NANO_AIU);
  });

  test("early consumer close commits once and a second close is idempotent", async () => {
    async function* billedFrames(): AsyncGenerator<Record<string, unknown>> {
      yield { type: "response.created", response: { id: "resp_1", copilot_usage: { total_nano_aiu: TOTAL_NANO_AIU } } };
      yield { type: "response.output_text.delta", output_index: 0, delta: "hi" };
    }

    expect(await spendDelta(async () => {
      const client = await responsesAdapter(billedFrames);
      const stream = client.streamWithTools({ messages: [], tools: [], systemPrompt: "" });
      // Read until the first text arrives, so the billed frame before it was consumed.
      for (;;) {
        const step = await stream.next();
        if (step.done || step.value.kind === "text_delta") break;
      }
      await stream.return(undefined);
      await stream.return(undefined);
    })).toBe(TOTAL_NANO_AIU);
  });

  // Regression guard: this passes on the base. It fails a change that records
  // spend for a request whose frames never carried a billed total.
  test("regression guard: an abnormal exit without a billed total records nothing", async () => {
    expect(await spendDelta(async () => {
      const client = await responsesAdapter(() => framesThenFail([
        { type: "response.created", response: { id: "resp_1" } },
      ]));
      expect(await failedTurn(client)).toBeInstanceOf(ContextLengthExceededError);
    })).toBe(0);
  });

  test("caller cancellation after a billed total still commits it", async () => {
    const controller = new AbortController();
    async function* cancelledFrames(): AsyncGenerator<Record<string, unknown>> {
      yield { type: "response.created", response: { id: "resp_1", copilot_usage: { total_nano_aiu: TOTAL_NANO_AIU } } };
      controller.abort();
      throw new DOMException("cancelled", "AbortError");
    }

    expect(await spendDelta(async () => {
      const client = await responsesAdapter(cancelledFrames);
      try {
        for await (const _event of client.streamWithTools({
          messages: [],
          tools: [],
          systemPrompt: "",
          signal: controller.signal,
        })) { /* drain */ }
      } catch (error) {
        expect(error).toBeInstanceOf(DOMException);
      }
    })).toBe(TOTAL_NANO_AIU);
  });

  test("Anthropic liveness failure after billing commits the observed total", async () => {
    const rawStream = {
      controller: new AbortController(),
      async *[Symbol.asyncIterator]() {
        yield {
          type: "message_start",
          message: { id: "msg_1", usage: { input_tokens: 1, output_tokens: 0 }, copilot_usage: { total_nano_aiu: TOTAL_NANO_AIU } },
        };
      },
    };
    // SAFETY: test double for the one SDK surface the adapter calls.
    const client = { messages: { create: () => ({
      withResponse: async () => ({ data: rawStream, response: new Response() }),
    }) } } as unknown as Anthropic;

    expect(await spendDelta(async () => {
      const adapter = await createAnthropicAdapter(Redacted.make("test-key"), "claude-sonnet-4-5", stubModelsClient(ANTHROPIC_INFO), {
        client,
        accessProvider: "github_copilot",
      });
      const error = await failedTurn({
        ...adapter,
        streamWithTools: (options) => adapter.streamWithTools({
          ...options,
          retryBudget: createRetryBudget(0),
        }),
      });
      expect(error).toBeInstanceOf(LlmStreamError);
    })).toBe(TOTAL_NANO_AIU);
  });
});
