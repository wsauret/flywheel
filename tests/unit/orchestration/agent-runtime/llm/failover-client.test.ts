import { describe, expect, test } from "bun:test";
import { accessProviderAccountKey, type AccessProviderCandidate, type AccessProviderId } from "../../../../../src/infra/llm/access-provider.js";
import { AllCandidatesExhaustedError, ContentRefusedError, QuotaExhaustedError, LlmStreamError } from "../../../../../src/orchestration/agent-runtime/llm/errors.js";
import { classifyProviderFailure, isFailoverFailure, normalizeProviderAttemptFailure } from "../../../../../src/orchestration/agent-runtime/llm/provider-failure.js";
import { candidateReadiness } from "../../../../../src/orchestration/agent-runtime/llm/failover-client.js";
import {
  type AvailabilityScript,
  chain,
  preparedRequest,
  requestEvents,
  executeStream,
  fakeAvailability,
  fakeClient,
  run,
  runAdmitted,
  SAFE_RECHECK_MS,
  served,
  streamOptions,
  textDelta,
  textStream,
  throwingStream,
  singletonCandidate,
  subscriptionCandidate,
} from "./_provider-chain-harness.js";

describe("automatic provider chain resolution", () => {
  test("runs the admitted immutable candidates in exact order", async () => {
    const visits: AccessProviderId[] = [];
    const client = chain({ availability: fakeAvailability({}).availability });
    expect(await runAdmitted(client, visits, ["chatgpt"])).toBe("openai_api");
    // A failed candidate spends its in-place retries before the next one runs.
    expect(visits).toEqual(["chatgpt", "chatgpt", "chatgpt", "chatgpt", "openai_api"]);
  });

  test("tries an opted-in free route before its paid sibling without spending the account", async () => {
    const openrouter = singletonCandidate("openrouter");
    const wires: string[] = [];
    const client = chain({
      candidateAttributions: [
        { candidate: openrouter, wireModelId: "vendor/model:free", dataUse: "standard", routeKind: "free" },
        { candidate: openrouter, wireModelId: "vendor/model", dataUse: "standard" },
      ],
      build: async (provider, attribution) => {
        wires.push(attribution.wireModelId);
        return fakeClient(provider, attribution.routeKind === "free"
          ? throwingStream(new QuotaExhaustedError("free route capacity spent"))
          : textStream("paid"));
      },
      availability: fakeAvailability({}).availability,
    });

    expect(await requestEvents(client)).toEqual([textDelta("paid")]);
    expect(wires).toEqual(["vendor/model:free", "vendor/model"]);
  });
  test("creating a client reads no availability, polls no quota, and builds no adapter", () => {
    const availability = fakeAvailability({
      chatGpt: { exhaustedAtMs: Date.now(), resetsAtMs: Date.now() + SAFE_RECHECK_MS, hold: { kind: "usage_limit", stated: false } },
    });
    const built: AccessProviderId[] = [];

    const client = chain({
      candidates: [subscriptionCandidate("github_copilot"), subscriptionCandidate("chatgpt"), singletonCandidate("openai_api")],
      build: async (provider) => {
        built.push(provider);
        return fakeClient(provider, textStream(provider));
      },
      availability: availability.availability,
      subscriptionAllowanceFor: () => ({ freshness: "fresh", allowance: "finite" }),
    });

    // A spent chain does not reject at construction either: exhaustion is a
    // fact about the request that follows, not about holding a client.
    expect(client.model).toBe("gpt-5.5");
    expect(client.modelFamily).toBe("openai");
    expect(built).toEqual([]);
    expect(availability.reads).toBe(0);
  });

  test("an exhausted paid planning read builds no denied adapter", async () => {
    let builds = 0;
    const automaticCandidate = { kind: "subscription", providerId: "github_copilot", instanceId: "test-instance", spendMode: "automatic" } as const;
    const client = chain({
      candidates: [automaticCandidate],
      availability: fakeAvailability({}).availability,
      subscriptionSpendAuthorizationFor: () => undefined,
      build: async (provider) => {
        builds += 1;
        return fakeClient(provider, textStream(provider));
      },
    });

    await expect(client.plannedAttempt()).rejects.toBeInstanceOf(AllCandidatesExhaustedError);
    expect(builds).toBe(0);
  });

  test("delegates adapter lifetime to the injected builder", async () => {
    let builds = 0;
    const client = chain({
      candidates: [singletonCandidate("openai_api")],
      build: async (provider) => {
        builds += 1;
        return fakeClient(provider, textStream("ok"));
      },
      availability: fakeAvailability({}).availability,
    });

    expect(await requestEvents(client)).toEqual([textDelta("ok")]);
    expect(await requestEvents(client)).toEqual([textDelta("ok")]);
    expect(builds).toBe(2);
  });

  test("evicts a rejected adapter construction before the next request", async () => {
    let builds = 0;
    const client = chain({
      candidates: [singletonCandidate("openai_api")],
      build: async (provider) => {
        builds += 1;
        if (builds === 1) throw new Error("construction failed");
        return fakeClient(provider, textStream("ok"));
      },
      availability: fakeAvailability({}).availability,
    });

    await expect(requestEvents(client)).rejects.toThrow("construction failed");
    expect(await requestEvents(client)).toEqual([textDelta("ok")]);
    expect(builds).toBe(2);
  });

  test("a single-candidate chain serves streams with no caller-visible difference", async () => {
    const client = chain({
      candidates: [singletonCandidate("openai_api")],
      build: async (provider) => fakeClient(provider, textStream("hi")),
      availability: fakeAvailability({}).availability,
    });

    expect(await run(client)).toEqual([textDelta("hi")]);
  });

  test("resolves exactly the candidates it is given, in order, filtering none of them out", async () => {
    // Membership belongs to `getConfiguredAccessProvidersForModel`; the chain
    // adds no static filter of its own, not even for a model Copilot cannot
    // serve. A candidate that reaches the chain is a candidate it can serve.
    const availability = fakeAvailability({});
    const client = chain({
      model: "gpt-3.5-turbo",
      candidates: [subscriptionCandidate("github_copilot"), singletonCandidate("openai_api")],
      availability: availability.availability,
      subscriptionAllowanceFor: () => ({ freshness: "fresh", allowance: "finite" }),
    });

    expect(await served(client)).toBe("github_copilot");
  });

  test("passes Copilot request options unchanged to the selected adapter", async () => {
    const seen: unknown[] = [];
    const providerOptions = { openai: { reasoning_summary: "detailed" as const } };
    const client = chain({
      candidates: [subscriptionCandidate("github_copilot"), singletonCandidate("openai_api")],
      build: async (provider) => ({
        ...fakeClient(provider, textStream(provider)),
        async *streamWithTools(options) {
          seen.push(options.providerOptions);
          yield textDelta(provider);
        },
      }),
      availability: fakeAvailability({}).availability,
      subscriptionAllowanceFor: () => ({ freshness: "fresh", allowance: "finite" }),
    });

    expect(await requestEvents(client, { ...streamOptions, providerOptions })).toEqual([textDelta("github_copilot")]);
    expect(seen).toEqual([providerOptions]);
  });


  test("rejects the request with a typed error when every candidate is exhausted", async () => {
    const client = chain({
      candidates: [subscriptionCandidate("chatgpt")],
      availability: fakeAvailability({
        chatGpt: { exhaustedAtMs: Date.now(), resetsAtMs: Date.now() + SAFE_RECHECK_MS, hold: { kind: "usage_limit", stated: false } },
      }).availability,
    });

    const request = requestEvents(client);
    await expect(request).rejects.toBeInstanceOf(AllCandidatesExhaustedError);
    await expect(request).rejects.toThrow("ChatGPT");
  });

  test("an explicit service tier also routes past the subscription", async () => {
    const client = chain({ availability: fakeAvailability({}).availability });

    const events = await requestEvents(client, {
      ...streamOptions,
      providerOptions: { openai: { service_tier: "flex" } },
    });

    expect(events).toEqual([textDelta("openai_api")]);
  });

  test("a fast-mode request rejects when only the subscription is configured", async () => {
    const client = chain({
      candidates: [subscriptionCandidate("chatgpt")],
      availability: fakeAvailability({}).availability,
    });

    const request = requestEvents(client, {
      ...streamOptions,
      providerOptions: { openai: { speed: "fast" } },
    });
    await expect(request).rejects.toBeInstanceOf(AllCandidatesExhaustedError);
    await expect(request).rejects.toThrow("OpenAI API only");
  });

  test("an Anthropic fast-mode request routes past Copilot to the API", async () => {
    const client = chain({
      model: "claude-opus-4-6",
      family: "anthropic",
      candidates: [subscriptionCandidate("github_copilot"), singletonCandidate("anthropic_api")],
      availability: fakeAvailability({}).availability,
      subscriptionAllowanceFor: () => ({ freshness: "fresh", allowance: "finite" }),
    });

    const events = await requestEvents(client, {
      ...streamOptions,
      providerOptions: { anthropic: { speed: "fast" } },
    });

    expect(events).toEqual([textDelta("anthropic_api")]);
  });

  test("a filtered subscription candidate is never quota-checked and never probes", async () => {
    // ChatGPT sits at probe_due (suppression expired); a fast-mode request
    // must skip it before any quota read, so no probe lease is ever claimed.
    const availability = fakeAvailability({
      chatGpt: { exhaustedAtMs: Date.now() - SAFE_RECHECK_MS - 1, resetsAtMs: Date.now() - 1, hold: { kind: "usage_limit", stated: true } },
    });
    const client = chain({ availability: availability.availability });

    const events = await requestEvents(client, {
      ...streamOptions,
      providerOptions: { openai: { speed: "fast" } },
    });

    expect(events).toEqual([textDelta("openai_api")]);
    // One standing read for openai_api; none for the filtered chatgpt.
    expect(availability.reads).toBe(1);
    expect(availability.probeReleases).toEqual([]);
    expect(availability.livePublishes).toEqual([]);
  });

  test("failover after a direct-API quota failure re-applies the fast-mode filter", async () => {
    const built: AccessProviderId[] = [];
    const client = chain({
      candidates: [singletonCandidate("openai_api"), singletonCandidate("openrouter")],
      build: async (provider) => {
        built.push(provider);
        return provider === "openai_api"
          ? fakeClient(provider, throwingStream(new QuotaExhaustedError("You exceeded your current quota.")))
          : fakeClient(provider, textStream(provider));
      },
      availability: fakeAvailability({}).availability,
    });

    const request = requestEvents(client, {
      ...streamOptions,
      attemptProducedEvidence: () => false,
      providerOptions: { openai: { speed: "fast" } },
    });
    const failure = await request.catch((error) => error);
    expect(failure).toBeInstanceOf(AllCandidatesExhaustedError);
    expect(built).toEqual(["openai_api"]);
  });

  test("one request advances a quota failure in fixed candidate order", async () => {
    const built: AccessProviderId[] = [];
    const client = chain({
      candidates: [singletonCandidate("openai_api"), singletonCandidate("openrouter")],
      build: async (provider) => {
        built.push(provider);
        return provider === "openai_api"
          ? fakeClient(provider, throwingStream(new QuotaExhaustedError("quota spent")))
          : fakeClient(provider, textStream("served"));
      },
      availability: fakeAvailability({}).availability,
    });

    expect(await requestEvents(client)).toEqual([textDelta("served")]);
    expect(built).toEqual(["openai_api", "openrouter"]);
  });

  test("a content refusal from the first candidate is terminal and never reaches the second candidate", async () => {
    const built: AccessProviderId[] = [];
    let attempts = 0;
    const refusal = new ContentRefusedError("anthropic", new Error("400 Could not process image"), { reason: "Could not process image", part: undefined });
    const client = chain({
      candidates: [singletonCandidate("anthropic_api"), singletonCandidate("openrouter")],
      build: async (provider) => {
        built.push(provider);
        return provider === "anthropic_api"
          ? fakeClient(provider, async function* () { attempts++; yield* throwingStream(refusal)(); })
          : fakeClient(provider, textStream("served"));
      },
      availability: fakeAvailability({}).availability,
    });

    const failure: unknown = await requestEvents(client).catch((error: unknown) => error);

    expect(failure).not.toBeInstanceOf(AllCandidatesExhaustedError);
    const attemptFailure = normalizeProviderAttemptFailure(failure);
    expect(attemptFailure.failure._tag).toBe("InvalidRequestFailure");
    expect(attemptFailure.cause).toBe(refusal);
    expect(built).toEqual(["anthropic_api"]);
    expect(attempts).toBe(1);
  });

  test("a request nobody can serve never prepares one", async () => {
    const prepared: string[] = [];
    const client = chain({
      candidates: [subscriptionCandidate("chatgpt")],
      availability: fakeAvailability({
        chatGpt: { exhaustedAtMs: Date.now(), resetsAtMs: Date.now() + SAFE_RECHECK_MS, hold: { kind: "usage_limit", stated: false } },
      }).availability,
    });

    await expect((await client.admitRequest()).run({
      prepare: preparedRequest,
      execute: async ({ attempt, client: adapter }) => {
        prepared.push(attempt.accessProvider);
        return executeStream(adapter, streamOptions);
      },
    })).rejects.toBeInstanceOf(AllCandidatesExhaustedError);
    expect(prepared).toEqual([]);
  });

  test("prepares the request once, for the candidate that actually serves it", async () => {
    const prepared: string[] = [];
    const client = chain({
      availability: fakeAvailability({
        chatGpt: { exhaustedAtMs: Date.now(), resetsAtMs: Date.now() + SAFE_RECHECK_MS, hold: { kind: "usage_limit", stated: false } },
      }).availability,
    });

    const events = await (await client.admitRequest()).run({
      prepare: preparedRequest,
      execute: async ({ attempt, client: adapter }) => {
        prepared.push(attempt.accessProvider);
        return executeStream(adapter, { ...streamOptions, systemPrompt: stableSystemPrompt(`prompt for ${attempt.accessProvider}`) });
      },
    });

    expect(prepared).toEqual(["openai_api"]);
    expect(events).toEqual([textDelta("openai_api")]);
  });

  test("carries the selected failover candidate and its provenance into request preparation", async () => {
    const prepared: Array<{ candidate: unknown; provenance: unknown }> = [];
    const client = chain({
      candidateAttributions: [
        { candidate: subscriptionCandidate("chatgpt", "account-a"), wireModelId: "gpt-5.5", dataUse: "standard", catalogProvenance: "live" },
        { candidate: singletonCandidate("openai_api"), wireModelId: "gpt-5.5", dataUse: "standard", catalogProvenance: "last-known-good" },
      ],
      availability: fakeAvailability({ chatGpt: { exhaustedAtMs: Date.now(), resetsAtMs: Date.now() + SAFE_RECHECK_MS, hold: { kind: "usage_limit", stated: false } } }).availability,
    });

    await (await client.admitRequest()).run({
      prepare: preparedRequest,
      execute: async ({ attempt, client: adapter }) => {
        prepared.push({ candidate: attempt.accessProviderCandidate, provenance: attempt.catalogProvenance });
        return executeStream(adapter, streamOptions);
      },
    });

    expect(prepared).toEqual([{ candidate: singletonCandidate("openai_api"), provenance: "last-known-good" }]);
  });

  test("keeps concurrent request attribution captures isolated", async () => {
    let capture = 0;
    const prepared: unknown[] = [];
    const client = chain({
      candidateAttributions: () => {
        capture += 1;
        return [{ candidate: subscriptionCandidate("chatgpt", `account-${capture}`), wireModelId: "gpt-5.5", dataUse: "standard", catalogProvenance: capture === 1 ? "bundled" : "last-known-good" }];
      },
      availability: fakeAvailability({}).availability,
    });
    const request = async () => (await client.admitRequest()).run({
      prepare: preparedRequest,
      execute: async ({ attempt, client: adapter }) => {
        prepared.push({ candidate: attempt.accessProviderCandidate, provenance: attempt.catalogProvenance });
        await Promise.resolve();
        return executeStream(adapter, streamOptions);
      },
    });

    await Promise.all([request(), request()]);

    expect(prepared).toEqual([
      { candidate: subscriptionCandidate("chatgpt", "account-1"), provenance: "bundled" },
      { candidate: subscriptionCandidate("chatgpt", "account-2"), provenance: "last-known-good" },
    ]);
  });

});

describe("candidate readiness, which the request walk and the model picker share", () => {
  const apiKey = singletonCandidate("openai_api");
  const readiness = (fake: ReturnType<typeof fakeAvailability>, conditions: Parameters<typeof candidateReadiness>[1]["conditions"] = []) =>
    candidateReadiness(apiKey, { availability: fake.availability, family: "openai", conditions });

  test("a live candidate is ready and owes no recheck", () => {
    expect(readiness(fakeAvailability({}))).toEqual({ kind: "ready", quotaProbeDue: false, serviceProbeDue: false });
  });

  test("a suppressed quota, an outage mark, and an auth storage condition each refuse the candidate", () => {
    const quota = fakeAvailability({});
    quota.availability.markQuotaExhausted(apiKey, Date.now() + 60_000);
    expect(readiness(quota)).toMatchObject({ kind: "refused", state: { reason: "quota" } });
    const outage = fakeAvailability({});
    outage.availability.markUnreachable("openai_api");
    expect(readiness(outage)).toMatchObject({ kind: "refused", state: { reason: "unavailable" } });
    expect(readiness(fakeAvailability({}), [{ kind: "malformed", scope: "provider", providerId: "openai_api", authDirectory: "/scratch/auth", revision: "1" }]))
      .toMatchObject({ kind: "refused", state: { reason: "ineligible", detail: "authentication storage needs attention." } });
  });

  test("a passed suppression is ready with its recheck due, and pending while another request holds that recheck", () => {
    const fake = fakeAvailability({});
    fake.availability.markQuotaExhausted(apiKey, Date.now() + 1_000);
    fake.advance(2_000);
    expect(readiness(fake)).toEqual({ kind: "ready", quotaProbeDue: true, serviceProbeDue: false });
    fake.availability.claimQuotaProbe(apiKey);
    expect(readiness(fake)).toMatchObject({ kind: "pending" });
  });
});

describe("availability between requests", () => {
  test("refuses a refreshed retry that is no longer affordable without dispatching stale input", async () => {
    let revision = 0;
    let executes = 0;
    const seen: string[] = [];
    const client = chain({
      candidates: [singletonCandidate("openai_api")],
      availability: fakeAvailability({}).availability,
      requestAdmission: { subscriptionSpendAuthorizationFor: () => undefined },
      affordability: new Map([["openai_api", {
        evaluate: async ({ request }) => {
          seen.push(renderSystemPrompt(request.systemPrompt));
          return renderSystemPrompt(request.systemPrompt) === "revision:0"
            ? { kind: "eligible" as const }
            : { kind: "unaffordable" as const, detail: "changed input exceeds the balance" };
        },
      }]]),
    });
    const failure = classifyProviderFailure(new LlmStreamError("lost connection", "transient"));
    if (!isFailoverFailure(failure)) throw new Error("expected transient failure");
    await expect((await client.admitRequest()).run({
      prepare: (attempt) => ({ ...preparedRequest(attempt), systemPrompt: stableSystemPrompt(`revision:${revision}`) }),
      execute: async () => { executes += 1; revision += 1; return { kind: "provider_failure", failure }; },
    })).rejects.toThrow("changed input exceeds the balance");
    expect(seen).toEqual(["revision:0", "revision:1"]);
    expect(executes).toBe(1);
  });

  test("moves off a provider that was spent since the last request without publishing a routing notice", async () => {
    const built: AccessProviderId[] = [];
    const script: AvailabilityScript = {};
    const resetsAtSeconds = Math.floor(Date.now() / 1000) + 3_600;
    const { availability } = fakeAvailability(script);
    const client = chain({
      build: async (provider) => {
        built.push(provider);
        return fakeClient(provider, textStream(provider));
      },
      availability,
    });

    expect(await run(client)).toEqual([textDelta("chatgpt")]);
    script.chatGpt = { exhaustedAtMs: Date.now(), resetsAtMs: resetsAtSeconds * 1000, hold: { kind: "usage_limit", stated: true } };

    expect(await run(client)).toEqual([textDelta("openai_api")]);
    expect(built).toEqual(["chatgpt", "openai_api"]);
  });

  test("prefers a recovered subscription without publishing a routing notice", async () => {
    const script: AvailabilityScript = {
      chatGpt: { exhaustedAtMs: Date.now(), resetsAtMs: Date.now() + SAFE_RECHECK_MS, hold: { kind: "usage_limit", stated: false } },
    };
    const { availability } = fakeAvailability(script);
    const client = chain({ availability });

    expect(await run(client)).toEqual([textDelta("openai_api")]);

    const nextTurnClient = chain({ availability });
    script.chatGpt = undefined;

    expect(await run(nextTurnClient)).toEqual([textDelta("chatgpt")]);
    await run(client);
  });

});

describe("request selection linearization", () => {
  test("every request reads the account state once, before it filters any candidate", async () => {
    const availability = fakeAvailability({});
    const client = chain({ availability: availability.availability });

    await run(client);
    expect(availability.projectionReads).toBe(1);

    await run(client);
    expect(availability.projectionReads).toBe(2);
  });

  test("a Copilot terminal quota advances once to each fallback candidate", async () => {
    const availability = fakeAvailability({});
    const builds: string[] = [];
    const client = chain({
      candidates: [subscriptionCandidate("github_copilot"), singletonCandidate("openai_api")],
      subscriptionAllowanceFor: () => ({ freshness: "fresh", allowance: "finite" }),
      build: async (provider) => {
        const copilot = availability.availability.quotaExhaustion(subscriptionCandidate("github_copilot"));
        builds.push(`${provider}:${copilot ? "suppressed" : "live"}`);
        return fakeClient(provider, throwingStream(new QuotaExhaustedError("Copilot is out of premium interactions.")));
      },
      availability: availability.availability,
    });

    const failure = await requestEvents(client).catch((error) => error);

    expect(failure).toBeInstanceOf(AllCandidatesExhaustedError);
    expect(builds).toEqual(["github_copilot:live", "openai_api:suppressed"]);
    expect(availability.projectionReads).toBe(3);
  });
});

describe("request-scoped canonical provider order", () => {
  test("planning without request evidence does not evaluate request affordability or connect", async () => {
    const base = fakeAvailability({}).availability;
    let stages = 0;
    let connections = 0;
    let evaluations = 0;
    const client = chain({
      candidates: [singletonCandidate("openrouter")],
      availability: base,
      affordability: new Map([["openrouter", {
        evaluate: async () => { evaluations += 1; return { kind: "unaffordable", detail: "request exceeds the available balance" }; },
      }]]),
      requestAdmission: {
        subscriptionSpendAuthorizationFor: () => undefined,
      },
      build: async (provider) => {
        stages += 1;
        const attempt = fakeClient(provider, textStream(provider));
        return { attempt, connect: async () => { connections += 1; return attempt; } };
      },
    });

    expect((await client.plannedAttempt()).accessProvider).toBe("openrouter");
    expect(evaluations).toBe(0);
    expect(stages).toBe(1);
    expect(connections).toBe(0);
  });

  test("the first healthy candidate retains its configured position", async () => {
    const availability = fakeAvailability({});
    const built: string[] = [];
    const client = chain({
      candidates: [subscriptionCandidate("chatgpt"), subscriptionCandidate("github_copilot")],
      build: async (provider) => { built.push(provider); return fakeClient(provider, textStream(provider)); },
      availability: availability.availability,
      subscriptionAllowanceFor: () => ({ freshness: "fresh", allowance: "finite" }),
    });

    const request = await client.admitRequest();
    const events = await request.run({ prepare: preparedRequest, execute: ({ client: adapter }) => executeStream(adapter, streamOptions) });

    expect(events[0]).toEqual(textDelta("chatgpt"));
    expect(built).toEqual(["chatgpt"]);
  });

  test("planning honors the same same-class order the serving walk uses", async () => {
    const availability = fakeAvailability({});
    const client = chain({
      candidates: [subscriptionCandidate("chatgpt"), subscriptionCandidate("github_copilot")],
      availability: availability.availability,
      subscriptionAllowanceFor: () => ({ freshness: "fresh", allowance: "finite" }),
    });

    const planned = await (await client.admitRequest()).plannedAttempt();

    expect(planned.accessProvider).toBe("chatgpt");
  });

  test("planning keeps the included candidate ahead of later spend classes", async () => {
    const client = chain({
      candidates: [subscriptionCandidate("chatgpt"), singletonCandidate("openai_api")],
      availability: fakeAvailability({}).availability,
    });

    const request = await client.admitRequest();
    const planned = await request.plannedAttempt();

    expect(planned.accessProvider).toBe("chatgpt");
    expect(Object.isFrozen(request.candidateAttributions)).toBe(true);
    expect(request.candidateAttributions.map(({ candidate }) => candidate.spendMode)).toEqual(["included", "direct_api"]);
  });

});
import { renderSystemPrompt, stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";

describe("the order of one provider's accounts", () => {
  const claude = (instanceId: string, spendMode: "included" | "automatic" = "included"): AccessProviderCandidate => ({ kind: "subscription", providerId: "claude_agent_sdk", instanceId, spendMode });
  const login = ({ candidate }: { readonly candidate: AccessProviderCandidate }) => [candidate.kind === "subscription" ? candidate.instanceId : candidate.providerId, candidate.spendMode];
  const ordered = async (candidates: readonly AccessProviderCandidate[], resets: ReadonlyMap<string, number>, preferred?: AccessProviderCandidate) => {
    const client = chain({
      candidates,
      requestAdmission: { subscriptionSpendAuthorizationFor: () => undefined, expiringResetFor: (candidate) => candidate.kind === "subscription" ? resets.get(candidate.instanceId) : undefined },
      ...(preferred === undefined ? {} : { preferredAccount: () => accessProviderAccountKey(preferred) }),
      availability: fakeAvailability({}).availability,
    });
    return (await client.admitRequest()).candidateAttributions.map(login);
  };

  test("included use tries the account whose expiring window resets soonest first, and accounts with no known reset last", async () => {
    expect(await ordered([claude("a"), claude("b"), claude("c"), claude("d"), subscriptionCandidate("chatgpt", "e")], new Map([["b", 3_000], ["c", 1_000], ["e", 500]])))
      .toEqual([["c", "included"], ["b", "included"], ["a", "included"], ["d", "included"], ["e", "included"]]);
  });

  test("paid use keeps its account order", async () => {
    expect(await ordered([claude("a", "automatic"), claude("b", "automatic")], new Map([["a", 3_000], ["b", 1_000]])))
      .toEqual([["a", "automatic"], ["b", "automatic"]]);
  });

  test("the tree's login breaks a tie and never passes a sooner reset", async () => {
    const candidates = [claude("a"), claude("b"), claude("c"), claude("d"), claude("e")];
    const resets = new Map([["a", 1_000], ["b", 2_000], ["c", 2_000]]);
    expect(await ordered(candidates, resets, claude("c"))).toEqual([["a", "included"], ["c", "included"], ["b", "included"], ["d", "included"], ["e", "included"]]);
    expect(await ordered(candidates, resets, claude("e"))).toEqual([["a", "included"], ["b", "included"], ["c", "included"], ["e", "included"], ["d", "included"]]);
  });
});

describe("the login of the chat tree's shared host", () => {
  const loginA = subscriptionCandidate("claude_agent_sdk", "login-a");
  const loginB = subscriptionCandidate("claude_agent_sdk", "login-b");

  test("goes first while it can serve, and the request leaves it only when it cannot", async () => {
    let dropped = false;
    // The logins that the tree's hosts named, from the oldest.
    const hostLogins: string[] = [];
    const client = chain({
      candidates: [loginA, loginB],
      preferredAccount: () => hostLogins.at(-1),
      build: async (provider, { candidate }) => {
        const login = candidate.kind === "subscription" ? candidate.instanceId : provider;
        // A bare stream error advances the walk and marks nothing, so the other login of the same provider still serves.
        return fakeClient(provider, login === "login-b" && dropped ? throwingStream(new LlmStreamError("login-b dropped", "transient")) : textStream(login));
      },
      availability: fakeAvailability({}).availability,
    });

    expect(await requestEvents(client)).toEqual([textDelta("login-a")]);
    hostLogins.push(accessProviderAccountKey(loginB));
    expect(await requestEvents(client)).toEqual([textDelta("login-b")]);
    dropped = true;
    expect(await requestEvents(client)).toEqual([textDelta("login-a")]);
  });

  test("pins the login and never its spend mode, so included use stays ahead of paid use", async () => {
    const paid = (instanceId: string): AccessProviderCandidate => ({ kind: "subscription", providerId: "claude_agent_sdk", instanceId, spendMode: "automatic" });
    const client = chain({
      candidates: [loginA, loginB, paid("login-a"), paid("login-b")],
      // A host that opened on paid use names its login, not its spend mode.
      preferredAccount: () => accessProviderAccountKey(paid("login-b")),
      availability: fakeAvailability({}).availability,
    });

    const request = await client.admitRequest();
    expect(request.candidateAttributions.map(({ candidate }) => [candidate.kind === "subscription" ? candidate.instanceId : "", candidate.spendMode]))
      .toEqual([["login-b", "included"], ["login-a", "included"], ["login-b", "automatic"], ["login-a", "automatic"]]);
  });
});
