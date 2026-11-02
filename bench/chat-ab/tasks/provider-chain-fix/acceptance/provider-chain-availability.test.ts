/**
 * Hidden acceptance: availability state decides every request, and a healthy
 * resolution stays quiet. Imports only the production surfaces the pre-fix tree
 * already exports, so it constrains behaviour and not one implementation shape.
 */

import { describe, expect, test } from "bun:test";
import type { AccessProviderId } from "../src/infra/llm/access-provider.js";
import {
  applySessionNoticeOperation,
  type SessionNotice,
  type SessionNoticeOperation,
} from "../src/infra/session-notice.js";
import { ApiError } from "../src/orchestration/agent-runtime/errors.js";
import { createProviderChainClient } from "../src/orchestration/agent-runtime/llm/provider-chain-client.js";
import type { ProviderAvailability } from "../src/orchestration/agent-runtime/llm/provider-availability.js";
import { QuotaExhaustedError } from "../src/orchestration/agent-runtime/shared/llm/errors.js";
import type { LLMClient, ProviderStreamEvent, StreamOptions } from "../src/orchestration/agent-runtime/llm/types.js";

type ChatGptQuotaResult = ReturnType<ProviderAvailability["chatGptQuota"]>;

/** Mutable availability script: a test changes `chatGpt` between requests to
 *  spend or restore the subscription the way another session would. */
interface AvailabilityScript {
  chatGpt?: ChatGptQuotaResult;
}

function fakeAvailability(script: AvailabilityScript): ProviderAvailability {
  return {
    async copilotAvailability() {
      return { available: true, meter: undefined };
    },
    copilotSpendSinceRefreshNanoAiu: () => 0,
    observeCopilotSpend: () => {},
    observeChatGptRateHeaders: () => {},
    observeChatGptQuotaExhausted: () => {},
    chatGptQuota: () => script.chatGpt ?? { primary: undefined, secondary: undefined },
  };
}

function fakeClient(accessProvider: AccessProviderId): LLMClient {
  return {
    accessProvider,
    modelFamily: "openai",
    model: "gpt-5.5",
    contextLimit: 400_000,
    outputLimit: 64_000,
    supportsReasoning: true,
    promptNotes: { progress: "", modelNotes: "" },
    async *streamWithTools() {
      yield { kind: "text_delta", text: accessProvider, blockKey: "b1" };
    },
    complete: async () => accessProvider,
    costFor: () => 0,
  };
}

const streamOptions: StreamOptions = { messages: [], tools: [], systemPrompt: "s" };

async function streamedText(client: LLMClient): Promise<string> {
  const events: ProviderStreamEvent[] = [];
  for await (const event of client.streamWithTools(streamOptions)) events.push(event);
  return events.map((event) => (event.kind === "text_delta" ? event.text : "")).join("");
}

/** Serves one request and returns the provider that produced the text and the
 *  provider the caller would attribute it to: the last `onProviderFailover`
 *  announcement, else `client.accessProvider`. Design-neutral attribution check. */
async function servedAndAttributed(client: LLMClient): Promise<{ served: string; attributed: string }> {
  let announced: string | undefined;
  let served = "";
  for await (const event of client.streamWithTools({
    ...streamOptions,
    onProviderFailover: async ({ accessProvider }) => { announced = accessProvider; },
  })) if (event.kind === "text_delta") served += event.text;
  return { served, attributed: announced ?? client.accessProvider };
}

function chain(script: AvailabilityScript, notices: SessionNoticeOperation[]): Promise<LLMClient> {
  return createProviderChainClient({
    model: "gpt-5.5",
    family: "openai",
    candidates: ["chatgpt", "openai_api"],
    build: async (provider) => fakeClient(provider),
    availability: fakeAvailability(script),
    sessionId: "session-1",
    onNotice: (operation) => notices.push(operation),
  });
}

function exhaustedWindow(resetsAtSeconds: number | undefined): ChatGptQuotaResult {
  return { primary: { usedPercent: 100, windowMinutes: 300, resetsAtSeconds }, secondary: undefined };
}

function upserts(notices: SessionNoticeOperation[]): Array<Extract<SessionNoticeOperation, { type: "upsert" }>["notice"]> {
  return notices.flatMap((operation) => (operation.type === "upsert" ? [operation.notice] : []));
}

describe("availability between requests", () => {
  test("the next request moves off a provider that was spent since the last one", async () => {
    const script: AvailabilityScript = {};
    const notices: SessionNoticeOperation[] = [];
    const resetsAtSeconds = Math.floor(Date.now() / 1000) + 3_600;
    const client = await chain(script, notices);
    expect(client.accessProvider).toBe("chatgpt");

    expect(await streamedText(client)).toBe("chatgpt");

    script.chatGpt = exhaustedWindow(resetsAtSeconds);
    notices.length = 0;

    expect(await streamedText(client)).toBe("openai_api");
    expect(upserts(notices)[0]?.id).toBe(`provider-quota:session-1:chatgpt:${resetsAtSeconds}`);
    // A completion resolves per request the same way a stream does.
    expect(await client.complete([], "s")).toBe("openai_api");
  });

  test("the next request prefers a subscription that recovered", async () => {
    const script: AvailabilityScript = { chatGpt: exhaustedWindow(undefined) };
    const client = await chain(script, []);

    expect(await servedAndAttributed(client)).toEqual({ served: "openai_api", attributed: "openai_api" });

    script.chatGpt = { primary: undefined, secondary: undefined };

    expect(await servedAndAttributed(client)).toEqual({ served: "chatgpt", attributed: "chatgpt" });
  });

  test("a request after the whole chain was spent is rejected with the typed error", async () => {
    const script: AvailabilityScript = {};
    const client = await createProviderChainClient({
      model: "gpt-5.5",
      family: "openai",
      candidates: ["chatgpt"],
      build: async (provider) => fakeClient(provider),
      availability: fakeAvailability(script),
      onNotice: () => {},
    });

    script.chatGpt = exhaustedWindow(undefined);

    const error = await streamedText(client).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ _tag: "ApiError" });
  });

  // Regression guard: this passes on the base. It fails a change that moves the
  // reported identity to the provider that served, or that announces the
  // fallback provider after its request started.
  test("regression guard: head identity stays stable and failover is announced before the fallback request", async () => {
    const order: string[] = [];
    const client = await createProviderChainClient({
      model: "gpt-5.5",
      family: "openai",
      candidates: ["chatgpt", "openai_api"],
      build: async (provider) => ({
        ...fakeClient(provider),
        async *streamWithTools() {
          order.push(`request:${provider}`);
          if (provider === "chatgpt") throw new QuotaExhaustedError("spent");
          yield { kind: "text_delta", text: provider, blockKey: "b1" };
        },
      }),
      availability: fakeAvailability({}),
    });

    expect(client.accessProvider).toBe("chatgpt");
    expect(await streamedText({
      ...client,
      streamWithTools: (options) => client.streamWithTools({
        ...options,
        onProviderFailover: async ({ accessProvider }) => {
          order.push(`failover:${accessProvider}`);
        },
      }),
    })).toBe("openai_api");
    expect(client.accessProvider).toBe("chatgpt");
    expect(order).toEqual(["request:chatgpt", "failover:openai_api", "request:openai_api"]);
  });

  // Regression guard: this passes on the base. It fails a change that starts the
  // fallback request after the attempt already produced output.
  test("regression guard: quota after produced evidence propagates without starting the fallback", async () => {
    const requests: AccessProviderId[] = [];
    const client = await createProviderChainClient({
      model: "gpt-5.5",
      family: "openai",
      candidates: ["chatgpt", "openai_api"],
      build: async (provider) => ({
        ...fakeClient(provider),
        async *streamWithTools() {
          requests.push(provider);
          throw new QuotaExhaustedError("spent after output");
        },
      }),
      availability: fakeAvailability({}),
    });

    const error = await (async () => {
      try {
        for await (const _event of client.streamWithTools({
          ...streamOptions,
          attemptProducedEvidence: () => true,
        })) { /* drain */ }
      } catch (caught) {
        return caught;
      }
      throw new Error("expected quota failure");
    })();

    expect(error).toBeInstanceOf(QuotaExhaustedError);
    expect(requests).toEqual(["chatgpt"]);
  });
});

describe("ChatGPT secondary window", () => {
  test("an exhausted active secondary window spends the provider and names its reset", async () => {
    const resetsAtSeconds = Math.floor(Date.now() / 1000) + 3_600;
    const notices: SessionNoticeOperation[] = [];
    const client = await chain({
      chatGpt: {
        primary: { usedPercent: 40, windowMinutes: 300, resetsAtSeconds: undefined },
        secondary: { usedPercent: 100, windowMinutes: 10_080, resetsAtSeconds },
      },
    }, notices);

    expect(await servedAndAttributed(client)).toEqual({ served: "openai_api", attributed: "openai_api" });
    expect(upserts(notices)[0]?.id).toBe(`provider-quota:session-1:chatgpt:${resetsAtSeconds}`);
    expect(upserts(notices)[0]?.message).toContain(new Date(resetsAtSeconds * 1000).toISOString());
  });

  // Regression guard: this passes on the base. It fails a change that counts a
  // zero-minute window, or a window whose reset already passed, as spent.
  test("regression guard: an inactive or already reset secondary window is ignored", async () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const servingProvider = async (secondary: ChatGptQuotaResult["secondary"]): Promise<string> => {
      const client = await chain({
        chatGpt: { primary: { usedPercent: 10, windowMinutes: 300, resetsAtSeconds: undefined }, secondary },
      }, []);
      expect(client.accessProvider).toBe("chatgpt");
      return streamedText(client);
    };

    expect(await servingProvider({ usedPercent: 100, windowMinutes: 0, resetsAtSeconds: nowSeconds + 3_600 })).toBe("chatgpt");
    expect(await servingProvider({ usedPercent: 100, windowMinutes: 10_080, resetsAtSeconds: nowSeconds - 1 })).toBe("chatgpt");
  });
});

describe("healthy resolution emits no session patch", () => {
  test("resolving a notice that is not raised returns the same notice list", () => {
    const raised: readonly SessionNotice[] = [{
      id: "a",
      scope: "scope-a",
      kind: "transient",
      severity: "warning",
      title: "Quota exhausted",
      message: "Sending this request elsewhere.",
      startedAt: 1_000,
      updatedAt: 1_000,
    }];
    const empty: readonly SessionNotice[] = [];

    expect(applySessionNoticeOperation(raised, { type: "resolve", id: "b" })).toBe(raised);
    expect(applySessionNoticeOperation(raised, { type: "resolve-scope", scope: "scope-b" })).toBe(raised);
    expect(applySessionNoticeOperation(empty, { type: "resolve-scope", scope: "scope-a" })).toBe(empty);
    expect(applySessionNoticeOperation(raised, { type: "resolve", id: "a" })).toEqual([]);
    expect(applySessionNoticeOperation(raised, { type: "resolve-scope", scope: "scope-a" })).toEqual([]);
  });

  test("a healthy chain leaves the notice list unchanged, request after request", async () => {
    const notices: SessionNoticeOperation[] = [];
    const client = await chain({}, notices);

    await streamedText(client);
    await streamedText(client);

    expect(notices.length).toBeGreaterThan(0);
    expect(notices.every((operation) => operation.type !== "upsert")).toBe(true);
    const before: readonly SessionNotice[] = [];
    const after = notices.reduce<readonly SessionNotice[]>(
      (current, operation) => applySessionNoticeOperation(current, operation),
      before,
    );
    expect(after).toBe(before);
  });
});
