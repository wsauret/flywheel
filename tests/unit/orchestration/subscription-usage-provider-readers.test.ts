import { describe, expect, test } from "bun:test";
import { type SubscriptionUsageReaderContext, CHATGPT_RATE_LIMIT_RESET_TYPE } from "../../../src/infra/llm/subscription-usage.js";
import { createCopilotUsageReader } from "../../../src/orchestration/modules/provider-github-copilot/quota-meter.js";
import { Redacted } from "effect";
import type { StoredTokens } from "../../../src/infra/auth/openai-auth-types.js";
import { createChatGPTResetConsumer, createChatGPTUsageReader as createRawChatGPTUsageReader } from "../../../src/orchestration/modules/provider-chatgpt/usage-reader.js";
import { createDeepSeekUsageReader as createRawDeepSeekUsageReader } from "../../../src/orchestration/modules/provider-deepseek/usage-reader.js";
import { createOpenCodeGoUsageReader as createRawOpenCodeGoUsageReader } from "../../../src/orchestration/modules/provider-opencode-go/usage-reader.js";
import { createSuperGrokUsageReader as createRawSuperGrokUsageReader } from "../../../src/orchestration/modules/provider-supergrok/usage-reader.js";
import { OPENCODE_GO_V1_BASE } from "../../../src/orchestration/modules/provider-opencode-go/wire.js";
import { isFreePlan } from "../../../src/infra/llm/free-plan-accounts.js";
import { testProviderSelection } from "../../helpers/provider-authority.js";


type FetchHandler = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => ReturnType<typeof fetch>;

function fetchAdapter(handler: FetchHandler): typeof fetch {
  if (handler === fetch) return fetch;
  return Object.assign(handler, { preconnect: fetch.preconnect });
}

const createChatGPTUsageReader = (handler: FetchHandler, fresh?: Parameters<typeof createRawChatGPTUsageReader>[1]) => createRawChatGPTUsageReader(fetchAdapter(handler), fresh);
const createOpenCodeGoUsageReader = (handler: FetchHandler) => createRawOpenCodeGoUsageReader(fetchAdapter(handler));
const createDeepSeekUsageReader = (handler: FetchHandler) => createRawDeepSeekUsageReader(fetchAdapter(handler));
const createSuperGrokUsageReader = (handler: FetchHandler, fresh?: Parameters<typeof createRawSuperGrokUsageReader>[1]) => createRawSuperGrokUsageReader(fetchAdapter(handler), fresh);

function assertSuccess(outcome: Awaited<ReturnType<ReturnType<typeof createCopilotUsageReader>>>): asserts outcome is Extract<typeof outcome, { kind: "success" }> {
  if (outcome.kind !== "success") throw new Error(`expected success, received ${outcome.kind}`);
}
function context(overrides: Partial<SubscriptionUsageReaderContext> = {}): SubscriptionUsageReaderContext {
  return {
    providerId: "github_copilot",
    authDir: "/auth",
    signal: new AbortController().signal,
    compareAndSetTokens: async () => false,
    account: {
      instanceId: "copilot-a",
      identity: "octocat",
      label: "Work",
      credential: { type: "oauth", access: Redacted.make("copilot-token"), refresh: Redacted.make("github-token"), expires: Date.now() + 60 * 60_000 },
    },
    ...overrides,
  };
}

describe("subscription usage provider readers", () => {
  test("normalizes Copilot's included allowance and explicit overage consent without deriving omitted fields", async () => {
    const reader = createCopilotUsageReader(async () => new Response(JSON.stringify({
      quota_snapshots: { premium_interactions: {
        unlimited: false,
        remaining: 37,
        entitlement: 50,
        overage_count: 2,
        overage_permitted: true,
      } },
      quota_reset_date: "2026-09-01",
      github_token: "must-not-escape",
    })));

    const outcome = await reader(context());

    expect(outcome).toEqual({
      kind: "success",
      report: {
        providerId: "github_copilot",
        instanceId: "copilot-a",
        identity: "octocat",
        label: "Work",
        providerStatus: "ok",
        observedAtMs: expect.any(Number),
        spendSources: [{
          kind: "automatic-billing",
          enablement: "enabled",
          used: { kind: "count", value: 2, unit: "interactions", provenance: "provider", precision: "exact" },
          resetId: "2026-09-01",
          resetAtMs: Date.parse("2026-09-01"),
        }],
        metrics: [{
          metricKey: "premium_interactions",
          label: "Premium interactions",
          scope: { kind: "account" },
          rank: 0,
          timing: { kind: "unavailable", resetId: "2026-09-01", resetAtMs: Date.parse("2026-09-01") },
          remaining: { kind: "count", value: 37, unit: "interactions", provenance: "provider", precision: "exact" },
          limit: { kind: "count", value: 50, unit: "interactions", provenance: "provider", precision: "exact" },
        }],
      },
    });
    expect(JSON.stringify(outcome)).not.toContain("github-token");
    expect(JSON.stringify(outcome)).not.toContain("copilot-token");
  });

  test("reads Copilot's plan and seat kind, and Copilot Free is a free plan (PI-MODEL-038)", async () => {
    const reading = async (sku: string) => {
      const outcome = await createCopilotUsageReader(async () => new Response(JSON.stringify({
        copilot_plan: "individual",
        access_type_sku: sku,
        quota_snapshots: { premium_interactions: { unlimited: false, remaining: 50, entitlement: 50 } },
      })))(context());
      assertSuccess(outcome);
      return outcome.report;
    };
    const copilot = testProviderSelection().definitions.find(({ id }) => id === "github_copilot");

    const free = await reading("free_limited_copilot");
    expect({ plan: free.plan, tier: free.tier }).toEqual({ plan: "individual", tier: "free_limited_copilot" });
    expect(isFreePlan(copilot, free)).toBe(true);
    expect(isFreePlan(copilot, await reading("plus_monthly_subscriber_quota"))).toBe(false);
  });

  test("ChatGPT Free and guest are free plans; SuperGrok, Claude, and an unknown plan count as paid (PI-MODEL-038)", () => {
    const definition = (id: string) => testProviderSelection().definitions.find((candidate) => candidate.id === id);
    expect(["free", "guest", "plus", "prolite", "pro"].map((plan) => isFreePlan(definition("chatgpt"), { plan }))).toEqual([true, true, false, false, false]);
    expect(isFreePlan(definition("chatgpt"), {})).toBe(false);
    expect(isFreePlan(definition("supergrok"), { plan: "free", tier: "free" })).toBe(false);
    expect(isFreePlan(definition("claude_agent_sdk"), { plan: "free", tier: "free" })).toBe(false);
  });

  test("returns unsupported when Copilot exposes no readable meter", async () => {
    const reader = createCopilotUsageReader(async () => new Response(JSON.stringify({ quota_snapshots: {} })));

    await expect(reader(context())).resolves.toEqual({ kind: "fetch-failure" });
  });

  test("classifies exact Copilot AI Credit allowances without inventing pooled bounds", async () => {
    const fixtures = [
      {
        premium: { unlimited: false, entitlement: 7000, remaining: 6629, credits_used: 370, token_based_billing: true, overage_permitted: false },
        metric: {
          metricKey: "ai_credits",
          label: "AI Credits",
          scope: { kind: "account" },
          rank: 0,
          timing: { kind: "unavailable" },
          allowanceMode: "finite",
          used: { kind: "count", value: 370, unit: "AI Credits", provenance: "provider", precision: "exact" },
          limit: { kind: "count", value: 7000, unit: "AI Credits", provenance: "provider", precision: "exact" },
          remaining: { kind: "count", value: 6629, unit: "AI Credits", provenance: "provider", precision: "exact" },
        },
      },
      {
        premium: { unlimited: true, entitlement: 0, remaining: 0, credits_used: 420, token_based_billing: true, overage_permitted: true },
        metric: {
          metricKey: "ai_credits",
          label: "AI Credits",
          scope: { kind: "account" },
          rank: 0,
          timing: { kind: "unavailable" },
          allowanceMode: "pooled",
          used: { kind: "count", value: 420, unit: "AI Credits", provenance: "provider", precision: "exact" },
        },
      },
      {
        premium: { unlimited: true, entitlement: 0, remaining: 0, credits_used: 421, token_based_billing: true, overage_permitted: false },
        metric: {
          metricKey: "ai_credits",
          label: "AI Credits",
          scope: { kind: "account" },
          rank: 0,
          timing: { kind: "unavailable" },
          allowanceMode: "pooled",
          used: { kind: "count", value: 421, unit: "AI Credits", provenance: "provider", precision: "exact" },
        },
      },
    ] as const;

    for (const fixture of fixtures) {
      const reader = createCopilotUsageReader(async () => new Response(JSON.stringify({ quota_snapshots: { premium_interactions: fixture.premium } })));
      const outcome = await reader(context());
      assertSuccess(outcome);
      expect(outcome.report.metrics).toEqual([fixture.metric]);
    }
  });

  test("does not guess an AI Credit allowance from contradictory or request-based shapes", async () => {
    const cases = [
      { unlimited: false, entitlement: 7000, remaining: 6629, credits_used: 370, token_based_billing: true, overage_permitted: true },
      { unlimited: true, entitlement: 7000, remaining: 6629, credits_used: 370, token_based_billing: true, overage_permitted: true },
      { unlimited: false, entitlement: 50, remaining: 37, credits_used: 12, token_based_billing: false, overage_permitted: false },
    ] as const;

    for (const premium of cases) {
      const reader = createCopilotUsageReader(async () => new Response(JSON.stringify({ quota_snapshots: { premium_interactions: premium } })));
      const outcome = await reader(context());
      assertSuccess(outcome);
      const aiCredits = outcome.report.metrics.find(({ metricKey }) => metricKey === "ai_credits");
      expect(aiCredits?.allowanceMode ?? "unclassified").toBe("unclassified");
    }
  });

  test("reads an overdrawn Copilot allowance as exhausted, not as a malformed report", async () => {
    // GitHub reports a negative remaining value once the last request of a
    // finite seat costs more than what was left (live shape, 2026-10-03).
    const aiCredits = createCopilotUsageReader(async () => new Response(JSON.stringify({ quota_snapshots: { premium_interactions: {
      unlimited: false, entitlement: 20000, remaining: -4, quota_remaining: -3.1, percent_remaining: 0, credits_used: 20003, token_based_billing: true, overage_permitted: false,
    } } })));
    const credits = await aiCredits(context());
    assertSuccess(credits);
    expect(credits.report.metrics.map(({ allowanceMode, used, limit, remaining }) => ({ allowanceMode, used: used?.value, limit: limit?.value, remaining: remaining?.value })))
      .toEqual([{ allowanceMode: "finite", used: 20003, limit: 20000, remaining: 0 }]);

    const interactions = createCopilotUsageReader(async () => new Response(JSON.stringify({ quota_snapshots: { premium_interactions: { unlimited: false, remaining: -2, entitlement: 50 } } })));
    const requests = await interactions(context());
    assertSuccess(requests);
    expect(requests.report.metrics.map(({ metricKey, remaining }) => ({ metricKey, remaining: remaining?.value }))).toEqual([{ metricKey: "premium_interactions", remaining: 0 }]);
  });

  test("rejects Copilot's malformed token-based billing flag", async () => {
    const reader = createCopilotUsageReader(async () => new Response(JSON.stringify({
      quota_snapshots: { premium_interactions: {
        unlimited: false,
        token_based_billing: "true",
        remaining: 37,
        entitlement: 50,
      } },
    })));

    await expect(reader(context())).resolves.toEqual({ kind: "fetch-failure" });
  });

  test("treats explicit Copilot overage refusal as disabled automatic billing", async () => {
    const reader = createCopilotUsageReader(async () => new Response(JSON.stringify({
      quota_snapshots: { premium_interactions: { unlimited: false, remaining: 37, entitlement: 50, overage_permitted: false } },
    })));

    const outcome = await reader(context());
    assertSuccess(outcome);

    expect(outcome.report.spendSources).toEqual([{ kind: "automatic-billing", enablement: "disabled" }]);
  });

  test("rejects missing Copilot identity or GitHub credential before making a request", async () => {
    let requests = 0;
    const reader = createCopilotUsageReader(async () => { requests += 1; return new Response("{}"); });

    await expect(reader(context({ account: { ...context().account, identity: undefined } }))).resolves.toEqual({ kind: "identity-unavailable" });
    await expect(reader(context({ account: { ...context().account, credential: { type: "oauth", access: Redacted.make("access"), expires: Date.now() + 60 * 60_000 } } }))).resolves.toEqual({ kind: "expired-auth" });
    expect(requests).toBe(0);
  });

  test("reads Copilot quota with the captured GitHub credential when the Copilot access token is expired", async () => {
    let request: { url: string; headers: Headers } | undefined;
    const reader = createCopilotUsageReader(async (input, init) => {
      request = { url: String(input), headers: new Headers(init?.headers) };
      return new Response(JSON.stringify({
        quota_snapshots: { premium_interactions: { unlimited: false, remaining: 37, entitlement: 50 } },
      }));
    });

    const outcome = await reader(context({
      account: {
        ...context().account,
        credential: { type: "oauth", access: Redacted.make("expired-copilot-token"), refresh: Redacted.make("captured-github-token"), expires: Date.now() - 1 },
      },
    }));

    expect(outcome.kind).toBe("success");
    expect(request?.url).toBe("https://api.github.com/copilot_internal/user");
    expect(request?.headers.get("authorization")).toBe("Bearer captured-github-token");
  });

  test.each([401, 403])("classifies Copilot quota endpoint HTTP %i as expired auth", async (status) => {
    let requests = 0;
    const reader = createCopilotUsageReader(async () => {
      requests += 1;
      return new Response("", { status });
    });

    await expect(reader(context())).resolves.toEqual({ kind: "expired-auth" });
    expect(requests).toBe(1);
  });

  test("distinguishes quota errors, fetch failures, and malformed whole-account snapshots", async () => {
    const quotaReader = createCopilotUsageReader(async () => new Response("quota", { status: 429 }));
    await expect(quotaReader(context())).resolves.toEqual({ kind: "quota-error", status: 429 });

    const fetchReader = createCopilotUsageReader(async () => { throw new Error("offline"); });
    await expect(fetchReader(context())).resolves.toEqual({ kind: "fetch-failure" });


    await expect(createCopilotUsageReader(async () => new Response("not json"))(context())).resolves.toEqual({ kind: "fetch-failure" });
  });

  test("reads ChatGPT windows with refreshed auth, account affinity, and no inferred values", async () => {
    let request: { url: string; headers: Headers } | undefined;
    const fresh = async (): Promise<StoredTokens> => ({ accessToken: Redacted.make("chat-secret"), refreshToken: undefined, expiresAtMs: Date.now() + 60_000, accountId: "account-1" });
    const reader = createChatGPTUsageReader(async (input, init) => {
      request = { url: String(input), headers: new Headers(init?.headers) };
      return new Response(JSON.stringify({ plan_type: "pro", rate_limit: {
        primary_window: { used_percent: 25, limit_window_seconds: 18_000, reset_after_seconds: 60, reset_at: 1_800_000_000 }, secondary_window: null,
      }, additional_rate_limits: [{ limit_name: "Code review", metered_feature: "reviews", rate_limit: {
        primary_window: { used_percent: 40, limit_window_seconds: 604_800, reset_after_seconds: 120, reset_at: 1_800_000_100 }, secondary_window: null,
      } }] }));
    }, fresh);
    const outcome = await reader(context({ providerId: "chatgpt" }));
    expect(request?.url).toBe("https://chatgpt.com/backend-api/wham/usage");
    expect(request?.headers.get("authorization")).toBe("Bearer chat-secret");
    expect(request?.headers.get("chatgpt-account-id")).toBe("account-1");
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      expect(outcome.report.plan).toBe("pro");
      expect(outcome.report.metrics).toEqual([
        { metricKey: "primary_window", label: "Primary window", scope: { kind: "account" }, rank: 0, usedFraction: 0.25, timing: { kind: "exact", startMs: 1_799_982_000_000, endMs: 1_800_000_000_000 } },
        { metricKey: "reviews:primary_window", label: "Code review primary window", scope: { kind: "feature", featureKey: "reviews" }, rank: 100, usedFraction: 0.4, timing: { kind: "exact", startMs: 1_799_395_300_000, endMs: 1_800_000_100_000 } },
      ]);
    }
    expect(JSON.stringify(outcome)).not.toContain("chat-secret");
  });

  test("normalizes banked reset detail and ignores the provider applicability hint", async () => {
    const fresh = async (): Promise<StoredTokens> => ({ accessToken: Redacted.make("secret"), refreshToken: undefined, expiresAtMs: Date.now() + 60_000, accountId: "account-1" });
    const responses = [
      { plan_type: "pro", rate_limit: null, rate_limit_reset_credits: { available_count: 3, applicable_available_count: 1 } },
      { available_count: 3, credits: [{ id: "later", reset_type: CHATGPT_RATE_LIMIT_RESET_TYPE, status: "available", granted_at: "2026-01-01T00:00:00Z", expires_at: null, title: "Permanent", description: "Later" }, { id: "first", reset_type: CHATGPT_RATE_LIMIT_RESET_TYPE, status: "available", granted_at: "2026-01-01T00:00:00Z", expires_at: "2026-01-02T00:00:00Z", title: "Weekly reset", description: "Soon" }] },
    ];
    const reader = createChatGPTUsageReader(async () => new Response(JSON.stringify(responses.shift())), fresh);
    const outcome = await reader(context({ providerId: "chatgpt" }));
    assertSuccess(outcome);
    expect(outcome.report.resetCredits).toEqual({ availableCount: 3, credits: [
      { id: "later", resetType: CHATGPT_RATE_LIMIT_RESET_TYPE, status: "available", grantedAtMs: Date.parse("2026-01-01T00:00:00Z"), expiresAtMs: null, title: "Permanent", description: "Later" },
      { id: "first", resetType: CHATGPT_RATE_LIMIT_RESET_TYPE, status: "available", grantedAtMs: Date.parse("2026-01-01T00:00:00Z"), expiresAtMs: Date.parse("2026-01-02T00:00:00Z"), title: "Weekly reset", description: "Soon" },
    ] });
  });

  test("skips reset detail when no reset is available", async () => {
    const fresh = async (): Promise<StoredTokens> => ({ accessToken: Redacted.make("secret"), refreshToken: undefined, expiresAtMs: Date.now() + 60_000 });
    let requests = 0;
    const reader = createChatGPTUsageReader(async () => { requests += 1; return new Response(JSON.stringify({ plan_type: "pro", rate_limit: null, rate_limit_reset_credits: { available_count: 0 } })); }, fresh);
    const outcome = await reader(context({ providerId: "chatgpt" }));
    assertSuccess(outcome);
    expect(outcome.report.resetCredits).toEqual({ availableCount: 0, credits: [] });
    expect(requests).toBe(1);
  });

  test("posts one exact selected reset and parses the provider consume code", async () => {
    const bodies: unknown[] = [];
    const consumer = createChatGPTResetConsumer(fetchAdapter(async (_input, init) => { bodies.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ code: "already_redeemed", windows_reset: [] })); }));
    await expect(consumer({ accessToken: Redacted.make("secret"), accountId: "account", providerKey: "attempt", creditId: "soon", signal: new AbortController().signal })).resolves.toEqual({ kind: "alreadyRedeemed" });
    expect(bodies).toEqual([{ redeem_request_id: "attempt", credit_id: "soon" }]);
  });

  test("reads ChatGPT prepaid credits and spend control as separate opaque-credit sources", async () => {
    const fresh = async (): Promise<StoredTokens> => ({ accessToken: Redacted.make("chat-secret"), refreshToken: Redacted.make("refresh-secret"), expiresAtMs: Date.now() + 60_000, accountId: "account-2" });
    const reader = createChatGPTUsageReader(async () => new Response(JSON.stringify({
      plan_type: "pro",
      rate_limit: null,
      credits: { has_credits: true, unlimited: false, balance: "17.25" },
      spend_control: { reached: false, individual_limit: {
        source: "workspace",
        limit: "100",
        used: "12.5",
        remaining: "87.5",
        used_percent: 12,
        remaining_percent: 88,
        reset_after_seconds: 60,
        reset_at: 1_800_000_000,
      } },
    })), fresh);

    const outcome = await reader(context({ providerId: "chatgpt" }));

    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      expect(outcome.report.spendSources).toEqual([
        {
          kind: "prepaid",
          availability: "funded",
          remaining: { kind: "count", value: 17.25, unit: "credits", provenance: "provider", precision: "exact" },
        },
        {
          kind: "automatic-billing",
          enablement: "unknown",
          used: { kind: "count", value: 12.5, unit: "credits", provenance: "provider", precision: "exact" },
          limit: { kind: "count", value: 100, unit: "credits", provenance: "provider", precision: "exact" },
          remaining: { kind: "count", value: 87.5, unit: "credits", provenance: "provider", precision: "exact" },
          resetId: "1800000000",
          resetAtMs: 1_800_000_000_000,
        },
      ]);
    }
  });

  test("preserves distinct ChatGPT prepaid entitlements without inventing values or consent", async () => {
    const fresh = async (): Promise<StoredTokens> => ({ accessToken: Redacted.make("secret"), refreshToken: undefined, expiresAtMs: Date.now() + 60_000 });
    const read = async (credits: unknown, spendControl?: unknown) => createChatGPTUsageReader(async () => new Response(JSON.stringify({ plan_type: "pro", rate_limit: null, credits, ...(spendControl === undefined ? {} : { spend_control: spendControl }) })), fresh)(context({ providerId: "chatgpt" }));

    const empty = await read({ has_credits: false, unlimited: false, balance: null });
    const available = await read({ has_credits: true, unlimited: false, balance: null }, { reached: true, individual_limit: null });
    const unlimited = await read({ has_credits: true, unlimited: true, balance: null });
    assertSuccess(empty);
    assertSuccess(available);
    assertSuccess(unlimited);

    expect(empty.report.spendSources).toEqual([{ kind: "prepaid", availability: "empty" }]);
    expect(available.report.spendSources).toEqual([
      { kind: "prepaid", availability: "available" },
      { kind: "automatic-billing", enablement: "unknown" },
    ]);
    expect(unlimited.report.spendSources).toEqual([{ kind: "prepaid", availability: "unlimited" }]);
  });

  test("classifies exact zero ChatGPT prepaid credits as empty", async () => {
    const fresh = async (): Promise<StoredTokens> => ({ accessToken: Redacted.make("secret"), refreshToken: undefined, expiresAtMs: Date.now() + 60_000 });
    const outcome = await createChatGPTUsageReader(async () => new Response(JSON.stringify({
      plan_type: "pro",
      rate_limit: null,
      credits: { has_credits: true, unlimited: false, balance: "0" },
    })), fresh)(context({ providerId: "chatgpt" }));

    assertSuccess(outcome);
    expect(outcome.report.spendSources).toEqual([{ kind: "prepaid", availability: "empty" }]);
  });

  test("classifies only proven permanent refresh failures as expired auth", async () => {
    const chatContext = context({ providerId: "chatgpt" });
    const xaiContext = context({ providerId: "supergrok" });
    const rejected = async (): Promise<StoredTokens> => { throw new Error("offline"); };
    await expect(createChatGPTUsageReader(fetch, rejected)(chatContext)).resolves.toEqual({ kind: "fetch-failure" });
    await expect(createSuperGrokUsageReader(fetch, rejected)(xaiContext)).resolves.toEqual({ kind: "fetch-failure" });
  });

  test("reads all OpenCode Go windows and rejects partial responses", async () => {
    let headers = new Headers();
    const usage = {
      rolling: { status: "ok", percent: 12, resetsAt: "2026-08-12T15:09:04.847Z" },
      weekly: { status: "rate-limited", percent: 100, resetsAt: "2026-08-15T00:00:00.000Z" },
      monthly: { status: "ok", percent: 2, resetsAt: "2026-09-01T00:00:00.000Z" },
    };
    const reader = createOpenCodeGoUsageReader(async (input, init) => {
      expect(String(input)).toBe(`${OPENCODE_GO_V1_BASE}/usage`);
      headers = new Headers(init?.headers);
      return new Response(JSON.stringify({ usage }));
    });
    const account = { ...context().account, credential: { type: "api_key", key: Redacted.make("go-secret") } as const };
    const outcome = await reader(context({ providerId: "opencode_go", account }));
    expect(headers.get("authorization")).toBe("Bearer go-secret");
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      expect(outcome.report.providerStatus).toBe("exhausted");
      expect(outcome.report.metrics.map((metric) => metric.usedFraction)).toEqual([0.12, 1, 0.02]);
      expect(outcome.report.metrics.every((metric) => metric.used === undefined && metric.limit === undefined && metric.remaining === undefined)).toBe(true);
      expect(outcome.report.spendSources).toEqual([{ kind: "prepaid", availability: "balance-unavailable" }]);
    }
    const partial = createOpenCodeGoUsageReader(async () => new Response(JSON.stringify({ usage: { rolling: usage.rolling } })));
    await expect(partial(context({ providerId: "opencode_go", account }))).resolves.toEqual({ kind: "fetch-failure" });
    const malformed = createOpenCodeGoUsageReader(async () => new Response(JSON.stringify({ usage: { ...usage, rolling: { ...usage.rolling, percent: "12" } } })));
    await expect(malformed(context({ providerId: "opencode_go", account }))).resolves.toEqual({ kind: "fetch-failure" });
  });

  test("reads each DeepSeek balance as a prepaid source, exhausted when DeepSeek says the balance cannot pay, and rejects a malformed response", async () => {
    let headers = new Headers();
    const reader = createDeepSeekUsageReader(async (input, init) => {
      expect(String(input)).toBe("https://api.deepseek.com/user/balance");
      headers = new Headers(init?.headers);
      return new Response(JSON.stringify({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "20.00", granted_balance: "0.00", topped_up_balance: "20.00" }] }));
    });
    const account = { ...context().account, credential: { type: "api_key", key: Redacted.make("sk-deepseek") } as const };
    const outcome = await reader(context({ providerId: "deepseek", account }));
    expect(headers.get("authorization")).toBe("Bearer sk-deepseek");
    assertSuccess(outcome);
    expect(outcome.report.providerStatus).toBe("ok");
    expect(outcome.report.metrics).toEqual([]);
    expect(outcome.report.spendSources).toEqual([{ kind: "prepaid", availability: "funded", remaining: { kind: "money", value: 20, currency: "USD", provenance: "provider", precision: "exact" } }]);
    const empty = await createDeepSeekUsageReader(async () => new Response(JSON.stringify({ is_available: false, balance_infos: [{ currency: "CNY", total_balance: "0.00", granted_balance: "0.00", topped_up_balance: "0.00" }] })))(context({ providerId: "deepseek", account }));
    assertSuccess(empty);
    expect(empty.report.providerStatus).toBe("exhausted");
    expect(empty.report.spendSources).toEqual([{ kind: "prepaid", availability: "empty" }]);
    const malformed = createDeepSeekUsageReader(async () => new Response(JSON.stringify({ is_available: true, balance_infos: [{ currency: "USD", total_balance: "lots" }] })));
    await expect(malformed(context({ providerId: "deepseek", account }))).resolves.toEqual({ kind: "fetch-failure" });
  });

  test("preserves OpenCode Go ok status above eighty percent", async () => {
    const account = { ...context().account, credential: { type: "api_key", key: Redacted.make("go-secret") } as const };
    const window = { status: "ok", percent: 90, resetsAt: "2026-08-12T15:09:04.847Z" };
    const outcome = await createOpenCodeGoUsageReader(async () => new Response(JSON.stringify({ usage: { rolling: window, weekly: window, monthly: window } })))(context({ providerId: "opencode_go", account }));
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      expect(outcome.report.providerStatus).toBe("ok");
      expect(outcome.report.metrics.every((metric) => metric.providerStatus === "ok")).toBe(true);
    }
  });

  test("reads SuperGrok percentages, products, exact money, and legacy monthly fields", async () => {
    const fresh = async (): Promise<StoredTokens> => ({ accessToken: Redacted.make("xai-secret"), refreshToken: undefined, expiresAtMs: Date.now() + 60_000 });
    let headers = new Headers();
    const reader = createSuperGrokUsageReader(async (input, init) => {
      headers = new Headers(init?.headers);
      if (String(input) === "https://cli-chat-proxy.grok.com/v1/settings") {
        return new Response(JSON.stringify({ on_demand_enabled: true }));
      }
      expect(String(input)).toBe("https://cli-chat-proxy.grok.com/v1/billing?format=credits");
      return new Response(JSON.stringify({ config: {
        creditUsagePercent: 18, currentPeriod: { start: "2026-08-01T00:00:00Z", end: "2026-08-08T00:00:00Z" }, productUsage: [{ product: "GrokBuild", usagePercent: 9 }],
        prepaidBalance: { val: 1250 }, onDemandUsed: { val: 200 }, onDemandCap: { val: 5000 },
        monthlyLimit: { val: 10_000 }, used: { val: 2_500 }, billingPeriodEnd: "2026-09-01T00:00:00Z",
      } }));
    }, fresh);
    const outcome = await reader(context({ providerId: "supergrok" }));
    expect(headers.get("authorization")).toBe("Bearer xai-secret");
    expect(headers.get("x-xai-token-auth")).toBe("xai-grok-cli");
    expect(headers.has("x-userid")).toBe(false);
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      expect(outcome.report.metrics.some((metric) => metric.metricKey === "prepaid_balance" || metric.metricKey === "on_demand")).toBe(false);
      expect(outcome.report.metrics.find((metric) => metric.metricKey === "monthly")).toMatchObject({ used: { value: 25 }, limit: { value: 100 }, timing: { kind: "unavailable", resetId: "2026-09-01T00:00:00Z" } });
      expect(outcome.report.metrics.find((metric) => metric.metricKey === "credits")?.timing).toEqual({ kind: "exact", startMs: Date.parse("2026-08-01T00:00:00Z"), endMs: Date.parse("2026-08-08T00:00:00Z") });
      expect(outcome.report.spendSources).toEqual([
        { kind: "prepaid", availability: "funded", remaining: { kind: "money", value: 12.5, currency: "USD", provenance: "provider", precision: "exact" } },
        { kind: "automatic-billing", enablement: "enabled", used: { kind: "money", value: 2, currency: "USD", provenance: "provider", precision: "exact" }, limit: { kind: "money", value: 50, currency: "USD", provenance: "provider", precision: "exact" } },
      ]);
    }
    expect(JSON.stringify(outcome)).not.toContain("xai-secret");
  });

  test("reads an active SuperGrok weekly period with omitted zero percentages", async () => {
    const fresh = async (): Promise<StoredTokens> => ({ accessToken: Redacted.make("xai-secret"), refreshToken: undefined, expiresAtMs: Date.now() + 60_000 });
    const nowMs = Date.now();
    const start = new Date(nowMs - 60_000).toISOString();
    const end = new Date(nowMs + 60_000).toISOString();
    const requested: string[] = [];
    const reader = createSuperGrokUsageReader(async (input) => {
      const url = String(input);
      requested.push(url);
      if (url.endsWith("/v1/settings")) return new Response(JSON.stringify({ on_demand_enabled: true }));
      return new Response(JSON.stringify({ config: {
        currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start, end },
        isUnifiedBillingUser: true,
        prepaidBalance: { val: 1250 },
        onDemandUsed: { val: 200 },
        onDemandCap: { val: 5000 },
      } }));
    }, fresh);

    const outcome = await reader(context({ providerId: "supergrok" }));

    expect(requested).toEqual([
      "https://cli-chat-proxy.grok.com/v1/billing?format=credits",
      "https://cli-chat-proxy.grok.com/v1/settings",
    ]);
    assertSuccess(outcome);
    expect(outcome.report.metrics).toEqual([{
      metricKey: "credits",
      label: "Credits",
      scope: { kind: "account" },
      rank: 0,
      usedFraction: 0,
      timing: { kind: "exact", startMs: Date.parse(start), endMs: Date.parse(end) },
    }]);
    expect(outcome.report.spendSources).toEqual([
      { kind: "prepaid", availability: "funded", remaining: { kind: "money", value: 12.5, currency: "USD", provenance: "provider", precision: "exact" } },
      { kind: "automatic-billing", enablement: "enabled", used: { kind: "money", value: 2, currency: "USD", provenance: "provider", precision: "exact" }, limit: { kind: "money", value: 50, currency: "USD", provenance: "provider", precision: "exact" } },
    ]);
  });

  test("rejects zero inference without an exact active SuperGrok weekly period", async () => {
    const fresh = async (): Promise<StoredTokens> => ({ accessToken: Redacted.make("xai-secret"), refreshToken: undefined, expiresAtMs: Date.now() + 60_000 });
    const nowMs = Date.now();
    const activePeriod = {
      type: "USAGE_PERIOD_TYPE_WEEKLY",
      start: new Date(nowMs - 60_000).toISOString(),
      end: new Date(nowMs + 60_000).toISOString(),
    };
    const invalidConfigs = [
      { currentPeriod: { ...activePeriod, start: new Date(nowMs + 60_000).toISOString(), end: new Date(nowMs + 120_000).toISOString() } },
      { currentPeriod: { ...activePeriod, type: "USAGE_PERIOD_TYPE_BIWEEKLY" } },
      { currentPeriod: activePeriod, creditUsagePercent: null },
      { currentPeriod: { ...activePeriod, start: "2020-08-01T00:00:00Z", end: "2020-08-08T00:00:00Z" } },
    ];

    for (const config of invalidConfigs) {
      const reader = createSuperGrokUsageReader(async () => new Response(JSON.stringify({ config })), fresh);
      await expect(reader(context({ providerId: "supergrok" }))).resolves.toEqual({ kind: "fetch-failure" });
    }
  });

  test("preserves SuperGrok allowance and prepaid data when settings cannot prove on-demand enablement", async () => {
    const fresh = async (): Promise<StoredTokens> => ({ accessToken: Redacted.make("xai-secret"), refreshToken: undefined, expiresAtMs: Date.now() + 60_000 });
    const reader = createSuperGrokUsageReader(async (input) => String(input).endsWith("/v1/settings")
      ? new Response("offline", { status: 500 })
      : new Response(JSON.stringify({ config: {
        creditUsagePercent: 18,
        currentPeriod: { end: "2026-08-08T00:00:00Z" },
        prepaidBalance: { val: 1250 },
        onDemandUsed: { val: 200 },
        onDemandCap: { val: 5000 },
      } })), fresh);
    const outcome = await reader(context({ providerId: "supergrok" }));
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      expect(outcome.report.metrics).toContainEqual(expect.objectContaining({ metricKey: "credits", usedFraction: 0.18, timing: { kind: "unavailable", resetId: "2026-08-08T00:00:00Z", resetAtMs: Date.parse("2026-08-08T00:00:00Z") } }));
      expect(outcome.report.spendSources).toEqual([
        { kind: "prepaid", availability: "funded", remaining: { kind: "money", value: 12.5, currency: "USD", provenance: "provider", precision: "exact" } },
        { kind: "automatic-billing", enablement: "unknown", used: { kind: "money", value: 2, currency: "USD", provenance: "provider", precision: "exact" }, limit: { kind: "money", value: 50, currency: "USD", provenance: "provider", precision: "exact" } },
      ]);
    }
  });

  test("reports provider-disabled SuperGrok automatic billing without inventing spend values", async () => {
    const fresh = async (): Promise<StoredTokens> => ({ accessToken: Redacted.make("xai-secret"), refreshToken: undefined, expiresAtMs: Date.now() + 60_000 });
    const reader = createSuperGrokUsageReader(async (input) => String(input).endsWith("/v1/settings")
      ? new Response(JSON.stringify({ on_demand_enabled: false }))
      : new Response(JSON.stringify({ config: { creditUsagePercent: 0, currentPeriod: { end: "2026-08-08T00:00:00Z" } } })), fresh);
    const outcome = await reader(context({ providerId: "supergrok" }));
    expect(outcome.kind).toBe("success");
    if (outcome.kind === "success") {
      expect(outcome.report.spendSources).toEqual([{ kind: "automatic-billing", enablement: "disabled" }]);
    }
  });

  test("classifies exact zero SuperGrok prepaid balance as empty", async () => {
    const fresh = async (): Promise<StoredTokens> => ({ accessToken: Redacted.make("xai-secret"), refreshToken: undefined, expiresAtMs: Date.now() + 60_000 });
    const reader = createSuperGrokUsageReader(async (input) => String(input).endsWith("/v1/settings")
      ? new Response(JSON.stringify({ on_demand_enabled: false }))
      : new Response(JSON.stringify({ config: {
        creditUsagePercent: 0,
        currentPeriod: { end: "2026-08-08T00:00:00Z" },
        prepaidBalance: { val: 0 },
      } })), fresh);
    const outcome = await reader(context({ providerId: "supergrok" }));

    assertSuccess(outcome);
    expect(outcome.report.spendSources).toEqual([
      { kind: "prepaid", availability: "empty" },
      { kind: "automatic-billing", enablement: "disabled" },
    ]);
  });

  test("maps malformed, auth, quota, server, timeout, and fetch failures to typed outcomes", async () => {
    const account = { ...context().account, credential: { type: "api_key", key: Redacted.make("secret") } as const };
    await expect(createOpenCodeGoUsageReader(async () => new Response("denied", { status: 401 }))(context({ providerId: "opencode_go", account }))).resolves.toEqual({ kind: "expired-auth" });
    await expect(createOpenCodeGoUsageReader(async () => new Response("not entitled", { status: 403 }))(context({ providerId: "opencode_go", account }))).resolves.toEqual({ kind: "unsupported" });
    await expect(createOpenCodeGoUsageReader(async () => new Response("slow", { status: 429 }))(context({ providerId: "opencode_go", account }))).resolves.toEqual({ kind: "quota-error", status: 429 });
    await expect(createOpenCodeGoUsageReader(async () => new Response("bad", { status: 500, statusText: "Server Error" }))(context({ providerId: "opencode_go", account }))).resolves.toEqual({ kind: "fetch-failure" });
    await expect(createOpenCodeGoUsageReader(async () => { throw new DOMException("timed out", "TimeoutError"); })(context({ providerId: "opencode_go", account }))).resolves.toEqual({ kind: "fetch-failure" });
    await expect(createOpenCodeGoUsageReader(async () => { throw new Error("offline"); })(context({ providerId: "opencode_go", account }))).resolves.toEqual({ kind: "fetch-failure" });
    await expect(createOpenCodeGoUsageReader(async () => new Response(JSON.stringify({ usage: "invalid" })))(context({ providerId: "opencode_go", account }))).resolves.toEqual({ kind: "fetch-failure" });
  });

  test("rejects oversized bodies and normalizes provider-controlled display text", async () => {
    const account = { ...context().account, credential: { type: "api_key", key: Redacted.make("secret") } as const };
    const oversized = createOpenCodeGoUsageReader(async () => new Response("x".repeat(256 * 1024 + 1)));
    await expect(oversized(context({ providerId: "opencode_go", account }))).resolves.toEqual({ kind: "fetch-failure" });
    const normalized = await createChatGPTUsageReader(async () => new Response(JSON.stringify({
      plan_type: `pro\u0000${"x".repeat(300)}`,
      rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 1, reset_after_seconds: 1, reset_at: 1 }, secondary_window: null },
    })), async () => ({ accessToken: Redacted.make("secret"), refreshToken: undefined, expiresAtMs: Date.now() + 1_000 }))(context({ providerId: "chatgpt" }));
    expect(normalized.kind).toBe("success");
    if (normalized.kind === "success") {
      expect(normalized.report.plan).not.toContain("\u0000");
      expect(normalized.report.plan?.length).toBe(256);
    }
  });
});
