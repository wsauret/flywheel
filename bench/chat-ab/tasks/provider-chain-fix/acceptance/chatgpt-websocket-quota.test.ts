/**
 * Hidden acceptance: a terminal quota frame carried by the preferred ChatGPT
 * WebSocket path reaches the shared availability owner, so a later automatic
 * request skips ChatGPT. The fixtures beside this file serve scripted socket
 * frames through the same frame mapper that the production WebSocket path uses.
 */

import { describe, expect, it } from "bun:test";
import { Redacted } from "effect";
import { collectStreamEvents, COST_INFO, state, stubModelsClient } from "./_chatgpt-websocket-fixtures.js";
import type { OpenAIAuth } from "../src/infra/auth/openai-auth-types.js";
import { createOpenAIAdapter } from "../src/orchestration/agent-runtime/llm/openai.js";
import { createProviderChainClient } from "../src/orchestration/agent-runtime/llm/provider-chain-client.js";
import { getSharedProviderAvailability } from "../src/orchestration/agent-runtime/llm/provider-availability.js";
import { QuotaExhaustedError } from "../src/orchestration/agent-runtime/shared/llm/errors.js";
import type { AccessProviderId } from "../src/infra/llm/access-provider.js";
import type { LLMClient } from "../src/orchestration/agent-runtime/llm/types.js";
import { createRetryBudget } from "../src/orchestration/agent-runtime/shared/llm/retry-budget.js";

const auth: OpenAIAuth = {
  kind: "chatgpt",
  accessToken: Redacted.make("test-access"),
  refreshToken: Redacted.make("test-refresh"),
  expiresAtMs: Date.now() + 3_600_000,
};

describe("WebSocket quota failures update shared ChatGPT availability", () => {
  const availability = getSharedProviderAvailability();

  function resetAvailability(): void {
    availability.observeChatGptRateHeaders(new Headers({
      "x-codex-primary-used-percent": "0",
      "x-codex-primary-window-minutes": "0",
    }));
  }

  async function observeFrame(frame: unknown): Promise<unknown> {
    state.webSocketStreamEvents = [frame as Record<string, unknown>];
    const client = await createOpenAIAdapter(auth, "gpt-5.4", stubModelsClient(COST_INFO));
    return collectStreamEvents(client, { retryBudget: createRetryBudget(0) }).catch((error: unknown) => error);
  }

  function fakeClient(accessProvider: AccessProviderId): LLMClient {
    return {
      accessProvider,
      modelFamily: "openai",
      model: "gpt-5.4",
      contextLimit: 1_050_000,
      outputLimit: 128_000,
      supportsReasoning: false,
      promptNotes: { progress: "", modelNotes: "" },
      async *streamWithTools() {
        yield { kind: "text_delta", text: accessProvider, blockKey: "b1" };
      },
      complete: async () => accessProvider,
      costFor: () => 0,
    };
  }

  it("accepts both terminal frame shapes, every quota code, and optional resets", async () => {
    const codes = ["insufficient_quota", "usage_not_included", "usage_limit_reached"];
    for (const [index, code] of codes.entries()) {
      for (const shape of ["response.failed", "error"] as const) {
        resetAvailability();
        const resetsAtSeconds = shape === "response.failed"
          ? Math.floor(Date.now() / 1000) + 3_600 + index
          : undefined;
        const error = { code, message: `quota ${code}`, ...(resetsAtSeconds === undefined ? {} : { resets_at: resetsAtSeconds }) };
        const frame = shape === "response.failed"
          ? { type: shape, response: { id: "resp_ws", status: "failed", error } }
          : { type: shape, ...error };

        await observeFrame(frame);
        expect(availability.chatGptQuota().primary).toMatchObject({
          usedPercent: 100,
          resetsAtSeconds,
        });
      }
    }
  });

  // Regression guard: this passes on the base. It fails a change that marks the
  // window exhausted for a frame that is not a terminal quota error.
  it("regression guard: does not mutate availability for unsupported terminal payloads", async () => {
    const initial = {
      primary: { usedPercent: 35, windowMinutes: 300, resetsAtSeconds: Math.floor(Date.now() / 1000) + 7_200 },
      secondary: { usedPercent: 20, windowMinutes: 10_080, resetsAtSeconds: Math.floor(Date.now() / 1000) + 604_800 },
    };
    availability.observeChatGptRateHeaders(new Headers({
      "x-codex-primary-used-percent": String(initial.primary.usedPercent),
      "x-codex-primary-window-minutes": String(initial.primary.windowMinutes),
      "x-codex-primary-reset-at": String(initial.primary.resetsAtSeconds),
      "x-codex-secondary-used-percent": String(initial.secondary.usedPercent),
      "x-codex-secondary-window-minutes": String(initial.secondary.windowMinutes),
      "x-codex-secondary-reset-at": String(initial.secondary.resetsAtSeconds),
    }));

    const frames: unknown[] = [
      { type: "response.failed", response: { error: { code: "rate_limit_exceeded", resets_at: initial.primary.resetsAtSeconds + 1 } } },
      { type: "response.failed", response: { error: { message: "missing code", resets_at: initial.primary.resetsAtSeconds + 1 } } },
      { type: "response.failed", response: { error: "not an object" } },
      { type: "error", code: "server_is_overloaded", resets_at: initial.primary.resetsAtSeconds + 1 },
      { type: "error", message: "missing code", resets_at: initial.primary.resetsAtSeconds + 1 },
      { type: "error", error: "nested payload is unsupported" },
      null,
    ];

    for (const frame of frames) {
      await observeFrame(frame);
      expect(availability.chatGptQuota()).toEqual(initial);
    }
  });

  it("records the exhausted window so a later automatic request is served by OpenAI API", async () => {
    resetAvailability();
    const resetsAtSeconds = Math.floor(Date.now() / 1000) + 3_600;
    const availability = getSharedProviderAvailability();
    try {
      const terminalError = await observeFrame({
        type: "response.failed",
        response: {
          id: "resp_ws",
          status: "failed",
          error: { code: "usage_limit_reached", message: "You have hit your ChatGPT usage limit.", resets_at: resetsAtSeconds },
        },
      });
      expect(terminalError).toBeInstanceOf(QuotaExhaustedError);
      expect(terminalError).toHaveProperty("message", "You have hit your ChatGPT usage limit.");
      expect(availability.chatGptQuota().primary).toMatchObject({ usedPercent: 100, resetsAtSeconds });

      const requests: AccessProviderId[] = [];
      const chain = await createProviderChainClient({
        model: "gpt-5.4",
        family: "openai",
        candidates: ["chatgpt", "openai_api"],
        build: async (provider) => ({
          ...fakeClient(provider),
          async *streamWithTools() {
            requests.push(provider);
            yield { kind: "text_delta", text: provider, blockKey: "b1" };
          },
        }),
        availability,
      });

      let announced: string | undefined;
      const events = await collectStreamEvents(chain, {
        onProviderFailover: async ({ accessProvider }: { accessProvider: string }) => { announced = accessProvider; },
      });
      expect(events.some((event) => event.kind === "text_delta" && event.text === "openai_api")).toBe(true);
      expect(announced ?? chain.accessProvider).toBe("openai_api");
      expect(requests).toEqual(["openai_api"]);
    } finally {
      // The availability owner is process-wide: report the window inactive
      // again so the exhaustion does not leak into later tests.
      availability.observeChatGptRateHeaders(new Headers({
        "x-codex-primary-used-percent": "0",
        "x-codex-primary-window-minutes": "0",
      }));
    }
  });
});
