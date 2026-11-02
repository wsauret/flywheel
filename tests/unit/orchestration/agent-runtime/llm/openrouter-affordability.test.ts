import { describe, expect, test } from "bun:test";
import { Redacted } from "effect";
import type { AccessProviderCandidateAttribution } from "../../../../../src/infra/llm/access-provider.js";
import type { CatalogJsonValue } from "../../../../../src/infra/llm/model-catalog-resolution.js";
import { createOpenRouterAffordability } from "../../../../../src/orchestration/modules/provider-openrouter/affordability.js";
import { streamAssistantTurn } from "../../../../../src/orchestration/agent-runtime/assistant-turn-stream.js";
import { DEFAULT_MODEL_INTERACTION_PROFILE } from "../../../../../src/orchestration/agent-runtime/model-interaction-profile.js";
import type { PreparedServingRequest, StreamOptions } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import type { RequestAdmission } from "../../../../../src/orchestration/agent-runtime/llm/provider-availability-types.js";
import { chain, fakeAvailability, fakeClient, textStream } from "./_provider-chain-harness.js";

const candidate = { kind: "singleton", providerId: "openrouter", spendMode: "aggregator" } as const;
const metadata = { pricing: { prompt: 0.001, completion: 0.002 }, top_provider: { max_completion_tokens: 200 } } as const;

function attribution(provenance: "live" | "last-known-good" = "live", catalogMetadata: CatalogJsonValue = metadata): AccessProviderCandidateAttribution {
  return { candidate, wireModelId: "anthropic/claude-fable-5.1", dataUse: "standard", catalogProvenance: provenance, catalogMetadata };
}

function prepared(_capability: ReturnType<typeof createOpenRouterAffordability>, source = attribution(), promptTokens = 100, lineage = "lineage-a"): PreparedServingRequest {
  const client = fakeClient("openrouter", textStream("unused"));
  return {
    attempt: Object.freeze({ ...client, candidateAttribution: source, accessProviderCandidate: source.candidate, catalogProvenance: source.catalogProvenance, credentialLineage: lineage, outputLimit: 200 }),
    messages: [{ kind: "user", content: "hello" }],
    tools: [],
    systemPrompt: stableSystemPrompt(""),
    providerOptions: undefined,
    cacheRetention: "none",
    tokenClasses: { estimatedPromptTokens: promptTokens, cacheRetention: "none" },
  };
}

const admission: RequestAdmission = { subscriptionSpendAuthorizationFor: () => undefined };
const owner = { profileId: "profile-a", credentialLineage: "lineage-a", apiKey: Redacted.make("secret-key") };

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

describe("OpenRouter affordability", () => {
  test("coalesces and caches finite key balance by credential lineage", async () => {
    let calls = 0;
    const capability = createOpenRouterAffordability(owner, { fetch: async () => { calls++; return response({ data: { limit: 10, limit_remaining: 0.49 } }); }, now: () => 1_000 });
    const request = prepared(capability);
    const input = { attribution: attribution(), admission, request };
    expect(await Promise.all([capability.evaluate(input), capability.evaluate(input)])).toEqual([
      { kind: "unaffordable", detail: "OpenRouter needs up to $0.5 but $0.49 remain." },
      { kind: "unaffordable", detail: "OpenRouter needs up to $0.5 but $0.49 remain." },
    ]);
    expect(calls).toBe(1);
    await capability.evaluate(input);
    expect(calls).toBe(1);

  });

  test("keeps same-lineage profiles in separate provider-owned capabilities", async () => {
    const authorizations: string[] = [];
    const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
      return response({ data: { limit: 10, limit_remaining: 10 } });
    };
    const first = createOpenRouterAffordability(owner, { fetch, now: () => 1_000 });
    const second = createOpenRouterAffordability(
      { profileId: "profile-b", credentialLineage: "lineage-a", apiKey: Redacted.make("other-key") },
      { fetch, now: () => 1_000 },
    );
    await first.evaluate({ attribution: attribution(), admission, request: prepared(first) });
    await second.evaluate({ attribution: attribution(), admission, request: prepared(second) });
    expect(authorizations).toEqual(["Bearer secret-key", "Bearer other-key"]);
  });

  test("charges the prepared prompt plus exact transmitted output cap and admits equality", async () => {
    const balances = [0.499, 0.5];
    const capability = createOpenRouterAffordability(owner, {
      fetch: async () => response({ data: { limit: 10, limit_remaining: balances.shift() } }),
      now: (() => {
        let now = 0;
        return () => {
          now += 300_001;
          return now;
        };
      })(),
    });
    const request = prepared(capability);
    expect(request.attempt.outputLimit).toBe(200);
    expect(await capability.evaluate({ attribution: attribution(), admission, request })).toEqual({ kind: "unaffordable", detail: "OpenRouter needs up to $0.5 but $0.499 remain." });
    expect(await capability.evaluate({ attribution: attribution(), admission, request })).toEqual({ kind: "eligible" });
  });

  for (const balance of [0.3, 0.2, 0.199]) {
    test(`prices the context-clamped outbound request against a $${balance} balance`, async () => {
      const capability = createOpenRouterAffordability(owner, {
        fetch: async () => response({ data: { limit: 10, limit_remaining: balance } }),
      });
      const dispatched: StreamOptions[] = [];
      const client = chain({
        availability: fakeAvailability({}).availability,
        candidateAttributions: [attribution()],
        requestAdmission: admission,
        affordability: new Map([["openrouter", capability]]),
        build: async () => ({
          ...fakeClient("openrouter", textStream("unused")),
          outputLimit: 200,
          totalContextLimit: 150,
          async *streamWithTools(options: StreamOptions) {
            dispatched.push(options);
            yield { kind: "done" as const, stopReason: "end_turn" as const };
          },
        }),
      });
      const result = streamAssistantTurn({
        client, executionCwd: "/scratch", signal: undefined, providerOptions: undefined,
        prepare: () => ({
          input: {
            messages: [{ kind: "user", content: "hello" }], tools: [], systemPrompt: stableSystemPrompt(""),
            interactionProfile: DEFAULT_MODEL_INTERACTION_PROFILE,
            reasoningEffort: undefined, signal: undefined, cacheRetention: "none",
            providerSessionKey: undefined, promptCacheKey: undefined, providerOptions: undefined, requestAudit: undefined,
            staleMasking: undefined, requestContext: undefined,
            turn: 1, messageCount: 1, estimatedContextTokens: 100, onEvent() {},
          },
          execute: (_candidate, fold) => fold({}, async (attempt) => {
            const value = await attempt.stream();
            await attempt.close();
            return { value, stop: false };
          }),
        }),
      });
      if (balance >= 0.2) {
        await result;
        expect(dispatched.map((options) => options.outputTokenLimit)).toEqual([50]);
      } else {
        await expect(result).rejects.toThrow("needs up to $0.2");
        expect(dispatched).toEqual([]);
      }
    });
  }

  test("admits stale, invalid, incomplete, unlimited, failed, and unknown evidence", async () => {
    const cases: Array<{ provenance?: "live" | "last-known-good"; metadata?: CatalogJsonValue; body?: unknown; reject?: boolean }> = [
      { provenance: "last-known-good" },
      { metadata: { pricing: { prompt: 1, completion: 1 } } },
      { body: { data: { limit: null, limit_remaining: null } } },
      { body: { data: { limit: 10 } } },
      { reject: true },
    ];
    for (const item of cases) {
      const capability = createOpenRouterAffordability(owner, { fetch: async () => {
        if (item.reject) throw new Error("secret network failure");
        return response(item.body ?? { data: { limit: 10, limit_remaining: 0 } });
      } });
      const source = attribution(item.provenance ?? "live", item.metadata ?? metadata);
      const request = prepared(capability, source);
      expect(await capability.evaluate({ attribution: source, admission, request })).toEqual({ kind: "eligible" });
    }
  });

  test("admits within the owned deadline when key balance capture stalls", async () => {
    let aborted = false;
    const capability = createOpenRouterAffordability(owner, {
      deadlineMs: 5,
      fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(init.signal?.reason);
        }, { once: true });
      }),
    });
    expect(await capability.evaluate({ attribution: attribution(), admission, request: prepared(capability) })).toEqual({ kind: "eligible" });
    expect(aborted).toBe(true);
  });
});
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
