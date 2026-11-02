import { describe, expect, test } from "bun:test";
import type { AccessProviderCandidateAttribution } from "../../../../../src/infra/llm/access-provider.js";
import type { CatalogJsonValue } from "../../../../../src/infra/llm/model-catalog-resolution.js";
import { copilotAffordability } from "../../../../../src/orchestration/modules/provider-github-copilot/affordability.js";
import { buildCopilotDynamicHeaders, copilotRequestInitiator } from "../../../../../src/orchestration/modules/provider-github-copilot/headers.js";
import type { ConversationMessage, PreparedServingRequest } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { fakeClient, textStream } from "./_provider-chain-harness.js";

const candidate = { kind: "subscription", providerId: "github_copilot", instanceId: "personal", spendMode: "included" } as const;


function attribution(metadata: CatalogJsonValue | undefined, provenance: "live" | "last-known-good" | "bundled" = "live"): AccessProviderCandidateAttribution {
  return { candidate, wireModelId: "claude-fable-5", dataUse: "standard", catalogProvenance: provenance, catalogMetadata: metadata };
}

function request(messages: PreparedServingRequest["messages"], estimatedPromptTokens = 100, cacheTokens = 0): PreparedServingRequest {
  const attempt = fakeClient("github_copilot", textStream("unused"));
  return {
    attempt,
    messages,
    tools: [],
    systemPrompt: stableSystemPrompt(""),
    providerOptions: undefined,
    cacheRetention: "5m",
    tokenClasses: { estimatedPromptTokens, estimatedUncachedInputTokens: estimatedPromptTokens - cacheTokens, estimatedCacheTokens: cacheTokens, cacheRetention: "5m" },
  };
}

function admission(evidence: ReturnType<NonNullable<Parameters<typeof copilotAffordability.evaluate>[0]["admission"]["subscriptionAllowanceFor"]>>) {
  return {
    subscriptionSpendAuthorizationFor: () => undefined,
    subscriptionAllowanceFor: () => evidence,
  };
}

const legacyMetadata = (multiplier: CatalogJsonValue): CatalogJsonValue => ({ endpoints: ["/v1/messages"], billing: { multiplier } });
const creditMetadata = (tokenPrices: CatalogJsonValue): CatalogJsonValue => ({ endpoints: ["/v1/messages"], billing: { tokenPrices } });

async function evaluate(metadata: CatalogJsonValue | undefined, evidence: Parameters<typeof admission>[0], prepared = request([{ kind: "user", content: "hello" }])) {
  return copilotAffordability.evaluate({ attribution: attribution(metadata), admission: admission(evidence), request: prepared });
}

describe("Copilot affordability", () => {
  test("paid modes never read remaining included credits or allowance", async () => {
    let allowanceReads = 0;
    const subscriptionAllowanceFor = (): SubscriptionAllowanceAdmission => {
      allowanceReads += 1;
      return { allowance: "refused", detail: "included allowance is unavailable" };
    };
    for (const spendMode of ["prepaid", "automatic"] as const) {
      expect(await copilotAffordability.evaluate({
        attribution: { ...attribution(legacyMetadata(100)), candidate: { ...candidate, spendMode } },
        admission: {
          subscriptionSpendAuthorizationFor: () => undefined,
          subscriptionAllowanceFor,
        },
        request: request([{ kind: "user", content: "hello" }]),
      })).toEqual({ kind: "eligible" });
    }
    expect(allowanceReads).toBe(0);
  });

  test("shares user and continuation initiator classification with headers", () => {
    const user: ConversationMessage[] = [{ kind: "user", content: "hello" }];
    const assistant: ConversationMessage[] = [...user, { kind: "assistant", content: "working" }];
    const tool: ConversationMessage[] = [...assistant, { kind: "toolResult", toolUseId: "tool", content: [] }];
    expect(copilotRequestInitiator(user)).toBe("user");
    expect(buildCopilotDynamicHeaders([...user])["X-Initiator"]).toBe("user");
    expect(copilotRequestInitiator(assistant)).toBe("agent");
    expect(buildCopilotDynamicHeaders([...assistant])["X-Initiator"]).toBe("agent");
    expect(copilotRequestInitiator(tool)).toBe("agent");
    expect(buildCopilotDynamicHeaders([...tool])["X-Initiator"]).toBe("agent");
  });

  test("applies the legacy multiplier only to user-initiated requests", async () => {
    const finite = { freshness: "fresh", allowance: "finite", metric: "premium_interactions", remaining: 1 } as const;
    expect(await evaluate(legacyMetadata(1.25), finite)).toEqual({ kind: "unaffordable", detail: "Copilot needs 1.25 premium interactions but 1 remain." });
    expect(await evaluate(legacyMetadata(1), finite)).toEqual({ kind: "eligible" });
    expect(await evaluate(legacyMetadata(100), finite, request([{ kind: "assistant", content: "working" }]))).toEqual({ kind: "eligible" });
  });

  test("charges exact uncached and cache-class prepared input without reserving output", async () => {
    const prices = { batchSize: 100, default: { inputPrice: 2, cachePrice: 0.5, outputPrice: 50 } };
    const finite = (remaining: number) => ({ freshness: "fresh", allowance: "finite", metric: "ai_credits", remaining } as const);
    const prepared = request([{ kind: "user", content: "hello" }], 100, 40);
    expect(await evaluate(creditMetadata(prices), finite(1.39), prepared)).toEqual({ kind: "unaffordable", detail: "Copilot needs 1.4 AI Credits for the prepared input but 1.39 remain." });
    expect(await evaluate(creditMetadata(prices), finite(1.4), prepared)).toEqual({ kind: "eligible" });
  });

  test("admits unknown, stale, pooled, incomplete, invalid, and non-live evidence", async () => {
    const cases = [
      [{}, { allowance: "unknown" }],
      [legacyMetadata(2), { freshness: "stale", allowance: "finite", metric: "premium_interactions", remaining: 0 }],
      [legacyMetadata(2), { freshness: "fresh", allowance: "pooled", usedCredits: 10 }],
      [undefined, { freshness: "fresh", allowance: "finite", metric: "premium_interactions", remaining: 0 }],
      [creditMetadata({ batchSize: 0, default: { inputPrice: 1, cachePrice: 1, outputPrice: 1 } }), { freshness: "fresh", allowance: "finite", metric: "ai_credits", remaining: 0 }],
    ] as const;
    for (const [metadata, evidence] of cases) expect(await evaluate(metadata, evidence)).toEqual({ kind: "eligible" });
    expect(await copilotAffordability.evaluate({ attribution: attribution(legacyMetadata(2), "last-known-good"), admission: admission({ freshness: "fresh", allowance: "finite", metric: "premium_interactions", remaining: 0 }), request: request([{ kind: "user", content: "hello" }]) })).toEqual({ kind: "eligible" });
  });
});
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import type { SubscriptionAllowanceAdmission } from "../../../../../src/orchestration/agent-runtime/llm/provider-availability-types.js";
