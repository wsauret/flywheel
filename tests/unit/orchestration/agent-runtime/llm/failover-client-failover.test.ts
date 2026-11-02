import { describe, expect, test } from "bun:test";
import type { AccessProviderId } from "../../../../../src/infra/llm/access-provider.js";
import { blockedFailureRecord, describeAgentFailure, formatAgentFailure } from "../../../../../src/orchestration/agent-runtime/failure-message.js";
import { toFailureReason } from "../../../../../src/orchestration/agent-runtime/errors.js";
import type { ProviderAvailability, RequestAdmission, SubscriptionAllowanceAdmission } from "../../../../../src/orchestration/agent-runtime/llm/provider-availability-types.js";
import { AllCandidatesExhaustedError, QuotaCoordinationError, QuotaExhaustedError } from "../../../../../src/orchestration/agent-runtime/llm/errors.js";
import { createSubscriptionSpendEnvelope } from "../../../../../src/infra/auth/subscription-spend-consent.js";
import {
  chain,
  failoverFailure,
  requestEvents,
  executeStream,
  expectSafeRecheck,
  fakeAvailability,
  fakeClient,
  run,
  SAFE_RECHECK_MS,
  streamOptions,
  textDelta,
  textStream,
  throwingStream,
  providerOutageError,
  preparedRequest,
  singletonCandidate,
  sleepRecorder,
} from "./_provider-chain-harness.js";
import type { ProviderAffordabilityCapability } from "../../../../../src/orchestration/agent-runtime/llm/provider-affordability.js";
import { streamAssistantTurn } from "../../../../../src/orchestration/agent-runtime/assistant-turn-stream.js";
import { DEFAULT_MODEL_INTERACTION_PROFILE } from "../../../../../src/orchestration/agent-runtime/model-interaction-profile.js";
import type { PreparedServingRequest } from "../../../../../src/orchestration/agent-runtime/llm/types.js";

describe("streamed failover", () => {
  test("evaluates affordability from the real candidate attempt before execution", async () => {
    const order: string[] = [];
    let connections = 0;
    const base = fakeAvailability({}).availability;
    const prepared = new Map<string, ReturnType<typeof preparedRequest>>();
    const capability = (provider: AccessProviderId, decision: "eligible" | "unaffordable"): ProviderAffordabilityCapability => ({
      evaluate: async ({ attribution, request }) => {
        order.push(`affordability:${provider}`);
        prepared.set(provider, request);
        expect(request.attempt.candidateAttribution).toBe(attribution);
        return decision === "eligible" ? { kind: "eligible" } : { kind: "unaffordable", detail: `${provider} cannot afford this request` };
      },
    });
    const client = chain({
      candidates: [singletonCandidate("openai_api"), singletonCandidate("openrouter")],
      availability: base,
      affordability: new Map([
        ["openai_api", capability("openai_api", "unaffordable")],
        ["openrouter", capability("openrouter", "eligible")],
      ]),
      requestAdmission: {
        subscriptionSpendAuthorizationFor: () => undefined,
      },
      build: async (provider) => {
        order.push(`stage:${provider}`);
        const attempt = fakeClient(provider, textStream(provider));
        return {
          attempt,
          connect: async () => {
            connections += 1;
            order.push(`connect:${provider}`);
            return attempt;
          },
        };
      },
    });
    const request = await client.admitRequest();
    let preparations = 0;
    let executions = 0;
    await request.run({
      prepare: (attempt) => {
        preparations += 1;
        order.push(`prepare:${attempt.accessProvider}`);
        return preparedRequest(attempt);
      },
      execute: async ({ attempt, prepared: requestSnapshot, client: adapter }) => {
        executions += 1;
        expect(requestSnapshot.attempt).toBe(attempt);
        expect(prepared.get("openrouter") === requestSnapshot).toBe(true);
        return executeStream(adapter, streamOptions);
      },
    });

    expect(order).toEqual([
      "stage:openai_api",
      "prepare:openai_api",
      "affordability:openai_api",
      "stage:openrouter",
      "prepare:openrouter",
      "affordability:openrouter",
      "connect:openrouter",
    ]);
    expect(preparations).toBe(2);
    expect(executions).toBe(1);
    expect(connections).toBe(1);
  });

  test("recomputes provider-isolated input classes before affordability on fallback", async () => {
    const seen = new Map<AccessProviderId, PreparedServingRequest["tokenClasses"]>();
    const capability = (provider: AccessProviderId, decision: "eligible" | "unaffordable"): ProviderAffordabilityCapability => ({
      evaluate: async ({ request }) => {
        seen.set(provider, request.tokenClasses);
        return decision === "eligible" ? { kind: "eligible" } : { kind: "unaffordable", detail: "try fallback" };
      },
    });
    const client = chain({
      candidates: [singletonCandidate("openai_api"), singletonCandidate("openrouter")],
      availability: fakeAvailability({}).availability,
      affordability: new Map([
        ["openai_api", capability("openai_api", "unaffordable")],
        ["openrouter", capability("openrouter", "eligible")],
      ]),
      requestAdmission: {
        subscriptionSpendAuthorizationFor: () => undefined,
      },
    });
    const request = await client.admitRequest();

    await streamAssistantTurn({
      client,
      executionCwd: "/scratch",
      request,
      signal: undefined,
      providerOptions: undefined,
      ...streamOptions,
      interactionProfile: DEFAULT_MODEL_INTERACTION_PROFILE,
      reasoningEffort: undefined, cacheRetention: undefined, providerSessionKey: undefined, promptCacheKey: undefined,
      requestAudit: undefined, staleMasking: undefined, requestContext: undefined,
      turn: 1, messageCount: 0, estimatedContextTokens: 200, onEvent: () => {},
      estimatedInputTokenClasses: (attempt) => attempt.accessProvider === "openai_api"
        ? { uncachedInputTokens: 120, cacheTokens: 80 }
        : { uncachedInputTokens: 200, cacheTokens: 0 },
    });

    expect(seen.get("openai_api")).toMatchObject({ estimatedPromptTokens: 200, estimatedUncachedInputTokens: 120, estimatedCacheTokens: 80 });
    expect(seen.get("openrouter")).toMatchObject({ estimatedPromptTokens: 200, estimatedUncachedInputTokens: 200, estimatedCacheTokens: 0 });
  });

  test("does not advance until provider failure settlement completes", async () => {
    const gate = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const visits: AccessProviderId[] = [];
    const request = await chain({ availability: fakeAvailability({}).availability }).admitRequest();
    const running = request.run({
      prepare: preparedRequest,
      execute: async ({ attempt }) => {
        visits.push(attempt.accessProvider);
        started.resolve();
        if (attempt.accessProvider === "chatgpt") await gate.promise;
        return attempt.accessProvider === "chatgpt"
          ? { kind: "provider_failure" as const, failure: failoverFailure(Object.assign(new Error("busy"), { status: 503 })) }
          : { kind: "success" as const, value: attempt.accessProvider };
      },
    });
    await started.promise;
    expect(visits).toEqual(["chatgpt"]);
    gate.resolve();
    expect(await running).toBe("openai_api");
  });

  test.each([
    { name: "typed quota", raw: undefined },
    { name: "HTTP 402", raw: Object.assign(new Error("Payment required"), { status: 402 }) },
    { name: "wrapped HTTP 402", raw: new Error("SDK operation failed", { cause: Object.assign(new Error("Payment required"), { status: 402 }) }) },
    { name: "HTTP 429 quota code", raw: Object.assign(new Error("You exceeded your current quota. Add credits."), { status: 429, code: "insufficient_quota" }) },
    { name: "wrapped HTTP 429 quota code", raw: new Error("SDK operation failed", { cause: Object.assign(new Error("You exceeded your current quota. Add credits."), { status: 429, code: "insufficient_quota" }) }) },
    { name: "wrapped HTTP 429 quota message", raw: new Error("SDK operation failed", { cause: Object.assign(new Error("usage limit reached"), { status: 429 }) }) },
    { name: "statusless quota stream", raw: Object.assign(new Error("You exceeded your current quota. Add credits."), { code: "insufficient_quota" }) },
    { name: "wrapped statusless quota stream", raw: new Error("SDK operation failed", { cause: Object.assign(new Error("You exceeded your current quota. Add credits."), { code: "insufficient_quota" }) }) },
  ])("settles exact-candidate quota before immediate fallback without an outage ($name)", async ({ raw }) => {
    const availability = fakeAvailability({});
    const built: AccessProviderId[] = [];
    const attempts: AccessProviderId[] = [];
    const sleep = sleepRecorder();
    const resetsAtMs = Date.now() + 3_600_000;
    const failure = raw ?? new QuotaExhaustedError("hard cap", {
      quotaObservation: {
        exhaustion: { exhaustedAtMs: Date.now(), resetsAtMs },
        newlyExhausted: true,
        reportedResetAtMs: resetsAtMs,
      },
    });
    const client = chain({
      candidates: [singletonCandidate("openai_api"), singletonCandidate("openrouter")],
      sleep: sleep.sleep,
      build: async (provider) => {
        built.push(provider);
        return fakeClient(provider, provider === "openrouter" ? textStream("served") : throwingStream(failure));
      },
      availability: availability.availability,
    });

    const events = await (await client.admitRequest()).run({
      prepare: preparedRequest,
      execute: async ({ attempt, client: adapter }) => {
        attempts.push(attempt.accessProvider);
        const result = await executeStream(adapter, streamOptions);
        if (result.kind === "success") return result;
        expect(result.failure._tag).toBe("QuotaExhaustedFailure");
        expect(attempt.accessProviderCandidate).toEqual(singletonCandidate("openai_api"));
        expect(built).toEqual(["openai_api"]);
        availability.availability.markQuotaExhausted(singletonCandidate("openai_api"), resetsAtMs);
        return result;
      },
    });
    expect(events).toEqual([textDelta("served")]);
    expect(availability.availability.genericQuotaStanding(singletonCandidate("openai_api")).kind).toBe("suppressed");
    expect(built).toEqual(["openai_api", "openrouter"]);
    expect(attempts).toEqual(["openai_api", "openrouter"]);
    expect(sleep.delays).toEqual([]);
    expect(availability.serviceEntryCount()).toBe(0);
  });

  test("does not suppress or select a replacement when deferred settlement fails", async () => {
    const base = fakeAvailability({});
    const built: AccessProviderId[] = [];
    const client = chain({
      candidates: [singletonCandidate("openai_api"), singletonCandidate("openrouter")],
      availability: {
        ...base.availability,
        markQuotaExhausted: () => {
          throw new QuotaCoordinationError({ message: "locked", provider: "openai_api", reason: "SQLITE_BUSY" });
        },
      },
      build: async (provider) => {
        built.push(provider);
        return fakeClient(provider, throwingStream(new QuotaExhaustedError("hard cap")));
      },
    });
    await expect((await client.admitRequest()).run({
      prepare: preparedRequest,
      execute: async ({ client: adapter }) => {
        const result = await executeStream(adapter, streamOptions);
        if (result.kind === "success") throw new Error("expected quota failure");
        throw new QuotaCoordinationError({ message: "locked", provider: "openai_api", reason: "SQLITE_BUSY" });
      },
    })).rejects.toThrow(QuotaCoordinationError);
    expect(base.genericEntryCount()).toBe(0);
    expect(built).toEqual(["openai_api"]);
  });


  test("propagates cancellation without selecting another provider", async () => {
    const built: AccessProviderId[] = [];
    const client = chain({
      build: async (provider) => {
        built.push(provider);
        return fakeClient(provider, throwingStream(new DOMException("aborted", "AbortError")));
      },
      availability: fakeAvailability({}).availability,
    });

    await expect(requestEvents(client))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(built).toEqual(["chatgpt"]);
  });

});


describe("terminal quota failover recording", () => {
  test("auto-resumes a candidate once its recorded reset passes, with no restart", async () => {
    const nowMs = 1_700_000_000_000;
    const resetAfterMs = 3_600_000;
    const availability = fakeAvailability({}, nowMs);
    availability.availability.markQuotaExhausted(singletonCandidate("openai_api"), nowMs + resetAfterMs);
    const client = chain({
      candidates: [singletonCandidate("openai_api"), singletonCandidate("openrouter")],
      availability: availability.availability,
    });

    expect(await requestEvents(client)).toEqual([textDelta("openrouter")]);

    availability.advance(resetAfterMs + 1);

    expect(await requestEvents(client)).toEqual([textDelta("openai_api")]);
  });
});

describe("coordination failures stop the request before any provider I/O", () => {
  /** The chain is the only thing that builds an adapter, so a walk that never
   *  builds one is a request no provider was sent. */
  async function rejectedWalk(availability: ProviderAvailability, deps: Partial<Parameters<typeof chain>[0]> = {}): Promise<{ error: unknown; built: AccessProviderId[] }> {
    const built: AccessProviderId[] = [];
    const client = chain({
      ...deps,
      availability,
      build: async (provider) => {
        built.push(provider);
        return fakeClient(provider, textStream(provider));
      },
    });
    const error = await requestEvents(client).then(
      () => { throw new Error("expected the request to reject") },
      (thrown) => thrown,
    );
    return { error, built };
  }

  test("an availability read the process could not coordinate rejects before any adapter is built", async () => {
    const availability = fakeAvailability({});
    const { error, built } = await rejectedWalk({
      ...availability.availability,
      refreshProjection: () => {
        throw new QuotaCoordinationError({
          message: "the accounts this request would spend from could not be read",
          provider: "chatgpt, openai_api",
          reason: "SQLITE_BUSY: database is locked",
        });
      },
    });

    expect(error).toBeInstanceOf(QuotaCoordinationError);
    expect(built).toEqual([]);
  });

});


describe("expired-suppression probes", () => {
  /** Chain whose sub fails terminally until `healthy` flips, with a metered
   *  fallback that always serves. */
  function probeChain(availability: ProviderAvailability, healthy: () => boolean) {
    return chain({
      candidates: [singletonCandidate("openai_api"), singletonCandidate("openrouter")],
      build: async (provider) => fakeClient(provider, provider === "openrouter"
        ? textStream("openrouter")
        : async function* () {
          if (!healthy()) throw new QuotaExhaustedError("You exceeded your current quota.");
          yield textDelta("openai_api");
        }),
      availability,
    });
  }


  test("a quota probe the request could not conclude is handed back at once", async () => {
    const availability = fakeAvailability({});
    const client = chain({
      candidates: [singletonCandidate("openai_api")],
      build: async (provider) => fakeClient(provider, throwingStream(providerOutageError("torn stream"))),
      availability: availability.availability,
    });
    availability.availability.markQuotaExhausted(singletonCandidate("openai_api"));
    availability.advance(SAFE_RECHECK_MS + 1);

    await expect(run(client)).rejects.toThrow(AllCandidatesExhaustedError);

    // The failure said nothing about quota, so the quota probe concluded
    // nothing: the lease went back and the next request rechecks immediately.
    expect(availability.probeReleases).toContain("openai_api");
    expect(availability.availability.genericQuotaStanding(singletonCandidate("openai_api"))).toEqual({ kind: "probe_due" });
    expect(availability.availability.serviceStanding("openai_api").kind).toBe("suppressed");
  });

  test("a probe whose request preparation fails is handed back at once", async () => {
    const availability = fakeAvailability({});
    const client = chain({ candidates: [singletonCandidate("openai_api")], availability: availability.availability });
    availability.availability.markQuotaExhausted(singletonCandidate("openai_api"));
    availability.advance(SAFE_RECHECK_MS + 1);

    await expect((await client.admitRequest()).run({
      prepare: preparedRequest,
      execute: async () => { throw new Error("audit write failed") },
    })).rejects.toThrow("audit write failed");

    expect(availability.probeReleases).toEqual(["openai_api"]);
    expect(availability.availability.genericQuotaStanding(singletonCandidate("openai_api"))).toEqual({ kind: "probe_due" });
  });

  test("a probe whose provider client cannot be built is handed back at once", async () => {
    const availability = fakeAvailability({});
    let builds = 0;
    const client = chain({
      candidates: [singletonCandidate("openai_api")],
      availability: availability.availability,
      build: async (provider) => {
        builds += 1;
        if (builds === 1) throw new Error("adapter build failed");
        return fakeClient(provider, textStream("recovered"));
      },
    });
    availability.availability.markQuotaExhausted(singletonCandidate("openai_api"));
    availability.advance(SAFE_RECHECK_MS + 1);

    await expect(requestEvents(client)).rejects.toThrow("adapter build failed");

    expect(availability.probeReleases).toEqual(["openai_api"]);
    expect(availability.availability.genericQuotaStanding(singletonCandidate("openai_api"))).toEqual({ kind: "probe_due" });
    expect(await requestEvents(client)).toEqual([textDelta("recovered")]);
    expect(builds).toBe(2);
  });

  test("a rejected live publication hands the probe back", async () => {
    const base = fakeAvailability({});
    base.availability.markQuotaExhausted(singletonCandidate("openai_api"));
    base.advance(SAFE_RECHECK_MS + 1);
    const client = probeChain({ ...base.availability, markQuotaLive: () => false }, () => true);

    expect(await run(client)).toEqual([textDelta("openai_api")]);
    expect(base.probeReleases).toEqual(["openai_api"]);
  });

  test("a planning read predicts the probe without claiming it", async () => {
    const availability = fakeAvailability({});
    const client = chain({
      candidates: [singletonCandidate("openai_api")],
      build: async (provider) => fakeClient(provider, textStream("openai_api")),
      availability: availability.availability,
    });
    availability.availability.markQuotaExhausted(singletonCandidate("openai_api"));
    availability.advance(SAFE_RECHECK_MS + 1);

    await client.plannedAttempt();

    // No lease was taken: the planning read issues no request, so the fleet's
    // one recheck stays claimable by the request that will.
    expect(availability.availability.genericQuotaStanding(singletonCandidate("openai_api"))).toEqual({ kind: "probe_due" });
  });

});

describe("all candidates exhausted", () => {
  /** Aggregate rejection of one request over a chain no candidate can serve.
   *  Holding the client is fine; the request is what cannot be served. */
  async function exhaustedChain(availability: ProviderAvailability, requestAdmission?: RequestAdmission): Promise<AllCandidatesExhaustedError> {
    const error = await requestEvents(chain({ availability, ...(requestAdmission === undefined ? {} : { requestAdmission }) })).then(
      () => { throw new Error("expected the request to reject") },
      (thrown) => thrown,
    );
    if (!(error instanceof AllCandidatesExhaustedError)) throw new Error("expected AllCandidatesExhaustedError");
    return error;
  }

  test("carries the earliest reset across skipped candidates and the copy authority renders it", async () => {
    const earliestResetsAtMs = Date.now() + 3_600_000;
    const chatGptResetsAtSeconds = Math.floor(Date.now() / 1000) + 7_200;
    const availability = fakeAvailability({
      chatGpt: { exhaustedAtMs: Date.now(), resetsAtMs: chatGptResetsAtSeconds * 1000 },
    });
    availability.availability.markQuotaExhausted(singletonCandidate("openai_api"), earliestResetsAtMs);

    const error = await exhaustedChain(availability.availability);
    expect(error.message).toContain(new Date(earliestResetsAtMs).toISOString());

    const reason = toFailureReason(error);
    // A workflow step waits for the same bound that the copy states.
    expect(reason).toMatchObject({ kind: "api_error", recovery: { kind: "at", atMs: earliestResetsAtMs } });
    const copy = describeAgentFailure(reason);
    expect(copy.title).toBe("Out of credits");
    expect(copy.message).toContain(new Date(earliestResetsAtMs).toLocaleString());
    expect(copy.guidance).toContain("Wait until then");
  });

  test("names a quota-refused account's banked reset from the request admission", async () => {
    const availability = fakeAvailability({ chatGpt: { exhaustedAtMs: Date.now(), resetsAtMs: Date.now() + 7_200_000 } });
    availability.availability.markQuotaExhausted(singletonCandidate("openai_api"), Date.now() + 3_600_000);
    const hint = "This account has a banked reset that you can apply in Usage (/usage).";
    const admission = (banked: boolean): RequestAdmission => ({
      subscriptionSpendAuthorizationFor: () => undefined,
      bankedResetFor: (candidate) => banked && candidate.providerId === "chatgpt",
    });

    const banked = toFailureReason(await exhaustedChain(availability.availability, admission(true)));
    expect(describeAgentFailure(banked).title).toBe("Out of credits");
    // The transcript and headless record, and a workflow or subagent failure, all carry it.
    expect(blockedFailureRecord(describeAgentFailure(banked))).toContain(hint);
    expect(formatAgentFailure(banked)).toContain(hint);
    const none = toFailureReason(await exhaustedChain(availability.availability, admission(false)));
    expect(blockedFailureRecord(describeAgentFailure(none))).not.toContain("banked reset");
  });

  test("a failed quota recheck claim reports unavailability without inventing quota exhaustion or a reset", async () => {
    // Every suppression now states its bound, so the one genuinely reset-less
    // rejection left is a due recheck whose probe claim could not land. The
    // request states no reset, but its recovery rechecks after the safe interval.
    const availability = fakeAvailability({ probeClaimFails: true });
    availability.availability.markQuotaExhausted(singletonCandidate("openai_api"));
    availability.advance(SAFE_RECHECK_MS + 1);
    const before = Date.now();
    const error = await requestEvents(chain({ availability: availability.availability, candidates: [singletonCandidate("openai_api")] })).then(
      () => { throw new Error("expected the request to reject") },
      (thrown) => thrown,
    );
    expectSafeRecheck(error, before);
    if (!(error instanceof AllCandidatesExhaustedError)) throw new Error("expected AllCandidatesExhaustedError");
    expect(error.message).not.toContain("Capacity returns at");

    const copy = describeAgentFailure(toFailureReason(error));
    expect(copy.title).toBe("Provider unavailable");
    expect(copy.detail).toContain("the quota recheck could not be coordinated");
    expect(copy.message).not.toContain("Capacity returns at");
  });


  test("toFailureReason maps the tag to an api_error carrying the message", () => {
    const error = new AllCandidatesExhaustedError({ message: 'No access provider can run "gpt-5.5" right now.', recovery: { kind: "none" } });
    expect(toFailureReason(error)).toEqual({ kind: "api_error", message: error.message, recovery: { kind: "none" }, candidatesExhausted: true });
  });
});

describe("spend-mode admission", () => {
  const subscription = (providerId: string, spendMode: "included" | "prepaid" | "automatic", instanceId = "account-a") => ({
    kind: "subscription" as const,
    providerId,
    instanceId,
    spendMode,
  });

  const authorizationFor = (candidate: ReturnType<typeof subscription>) => {
    const envelope = createSubscriptionSpendEnvelope("default", {
      providerId: candidate.providerId,
      instanceId: candidate.instanceId,
      subjectDigest: "subject-a",
    }, candidate.spendMode === "prepaid" ? "prepaid" : "automatic");
    return {
      envelope,
      profileId: "default",
      account: { providerId: candidate.providerId, instanceId: candidate.instanceId, subjectDigest: "subject-a" },
      usageGeneration: 1,
      authorityIncarnation: "incarnation-a",
      authorityRevision: 1,
    };
  };

  async function builtFor(
    candidate: ReturnType<typeof subscription>,
    authorized = true,
    subscriptionAllowance?: SubscriptionAllowanceAdmission,
  ) {
    const base = fakeAvailability({}).availability;
    const built: string[] = [];
    let allowanceReads = 0;
    const client = chain({
      candidates: [candidate, { kind: "singleton", providerId: "openrouter", spendMode: "aggregator" }],
      availability: base,
      subscriptionSpendAuthorizationFor: authorized ? () => authorizationFor(candidate) : () => undefined,
      subscriptionAllowanceFor: () => { allowanceReads += 1; return subscriptionAllowance ?? { allowance: "unknown" }; },
      build: async (provider) => {
        built.push(provider);
        return fakeClient(provider, textStream(provider));
      },
    });
    await requestEvents(client);
    if (candidate.spendMode !== "included") expect(allowanceReads).toBe(0);
    return built;
  }

  test("an unauthorized paid mode asks for review without claiming an unfunded balance", async () => {
    const candidate = subscription("opencode_go", "prepaid");
    const base = fakeAvailability({}).availability;
    const refusal = async (quota = false): Promise<AllCandidatesExhaustedError> => {
      const error = await requestEvents(chain({
        candidates: quota ? [singletonCandidate("openai_api"), candidate] : [candidate],
        availability: base,
        subscriptionSpendAuthorizationFor: () => undefined,
        build: async (provider) => fakeClient(provider, throwingStream(new QuotaExhaustedError("insufficient_quota"))),
      })).then(
        () => { throw new Error("expected the request to reject") },
        (thrown) => thrown,
      );
      if (!(error instanceof AllCandidatesExhaustedError)) throw new Error("expected AllCandidatesExhaustedError");
      return error;
    };

    const unreviewed = await refusal();
    expect(unreviewed.detail).toBe("Subscription paid capacity requires review. Open Auth and select the account.");
    // Waiting does not change what the person allowed, so no bound is stated.
    expect(unreviewed.recovery).toEqual({ kind: "none" });
    const skippedCopy = describeAgentFailure(toFailureReason(unreviewed));
    expect(skippedCopy.title).toBe("No eligible provider");
    expect(skippedCopy.detail).toContain(unreviewed.detail!);
    expect(skippedCopy.message).not.toContain("credits");
    expect(skippedCopy.message).not.toContain("before dispatch");
    const mixed = describeAgentFailure(toFailureReason(await refusal(true)));
    expect(mixed.title).toBe("Out of credits");
    expect(mixed.message).toContain("Other candidates could not be used for this request");
    expect(mixed.message).not.toContain("Every configured provider");
  });

  test("accepted paid modes work without provider usage evidence", async () => {
    expect(await builtFor(subscription("chatgpt", "prepaid"))).toEqual(["chatgpt"]);
    expect(await builtFor(subscription("github_copilot", "automatic"))).toEqual(["github_copilot"]);
  });

  test("denied or unreviewed consent skips only the exact paid mode before lazy construction", async () => {
    const prepaid = subscription("chatgpt", "prepaid");
    expect(await builtFor(prepaid, false)).toEqual(["openrouter"]);
    expect(await builtFor(subscription("github_copilot", "automatic"), false)).toEqual(["openrouter"]);
  });

  test("authorization for another exact envelope does not admit the candidate", async () => {
    const candidate = subscription("chatgpt", "prepaid");
    const base = fakeAvailability({}).availability;
    const built: string[] = [];
    const client = chain({
      candidates: [candidate, { kind: "singleton", providerId: "openrouter", spendMode: "aggregator" }],
      availability: base,
      subscriptionSpendAuthorizationFor: () => authorizationFor(subscription("chatgpt", "automatic")),
      build: async (provider) => {
        built.push(provider);
        return fakeClient(provider, textStream(provider));
      },
    });
    await requestEvents(client);
    expect(built).toEqual(["openrouter"]);
  });

  test("an allowance refusal gates included usage, not accepted paid modes", async () => {
    const refusal = { allowance: "refused", detail: "the local monthly cap has been reached." } as const;
    expect(await builtFor(subscription("github_copilot", "included"), false, refusal)).toEqual(["openrouter"]);
    expect(await builtFor(subscription("github_copilot", "automatic"), true, refusal)).toEqual(["github_copilot"]);
    expect(await builtFor(subscription("chatgpt", "prepaid"), true, refusal)).toEqual(["chatgpt"]);
    expect(await builtFor(subscription("github_copilot", "automatic"), false, refusal)).toEqual(["openrouter"]);
  });

  test("Copilot allowance admission follows the exact credential instance", async () => {
    const base = fakeAvailability({}).availability;
    const first = subscription("github_copilot", "included", "pooled-account");
    const second = subscription("github_copilot", "included", "finite-account");
    const seen: string[] = [];
    const built: string[] = [];
    const client = chain({
      candidates: [first, second],
      availability: base,
      subscriptionAllowanceFor: (candidate) => {
        if (candidate.kind !== "subscription") return { allowance: "unknown" };
        seen.push(candidate.instanceId);
        return candidate.instanceId === "pooled-account"
          ? { allowance: "refused", detail: "the local monthly cap has been reached." }
          : { allowance: "finite", freshness: "fresh" };
      },
      build: async (provider) => {
        built.push(provider);
        return fakeClient(provider, textStream(provider));
      },
    });

    await requestEvents(client);

    expect(seen).toEqual(["pooled-account", "finite-account"]);
    expect(built).toEqual(["github_copilot"]);
  });

  test("a provider quota refusal on prepaid falls through to automatic and preserves its reason", async () => {
    const prepaid = subscription("chatgpt", "prepaid");
    const automatic = subscription("github_copilot", "automatic");
    const base = fakeAvailability({}).availability;
    const built: string[] = [];
    const client = chain({
      candidates: [prepaid, automatic],
      availability: base,
      subscriptionSpendAuthorizationFor: (candidate) => authorizationFor(candidate.providerId === prepaid.providerId ? prepaid : automatic),
      build: async (provider) => {
        built.push(provider);
        return fakeClient(provider, provider === "chatgpt" ? throwingStream(new QuotaExhaustedError("the prepaid credits are spent")) : textStream("served"));
      },
    });
    expect(await requestEvents(client)).toEqual([textDelta("served")]);
    expect(built).toEqual(["chatgpt", "github_copilot"]);
    const exhausted = await requestEvents(chain({
      candidates: [prepaid],
      availability: fakeAvailability({}).availability,
      subscriptionSpendAuthorizationFor: () => authorizationFor(prepaid),
      build: async (provider) => fakeClient(provider, throwingStream(new QuotaExhaustedError("the prepaid credits are spent"))),
    })).then(() => { throw new Error("expected quota refusal") }, (error: unknown) => error);
    expect(exhausted).toBeInstanceOf(AllCandidatesExhaustedError);
    if (!(exhausted instanceof AllCandidatesExhaustedError)) throw new Error("expected quota refusal", { cause: exhausted });
    expect(describeAgentFailure(toFailureReason(exhausted)).detail).toContain("the prepaid credits are spent");
  });

});