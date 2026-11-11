import { describe, expect, test } from "bun:test";
import type { AccessProviderId } from "../../../../../src/infra/llm/access-provider.js";
import { classifyApiError } from "../../../../../src/infra/llm/provider-error-copy.js";
import { AllCandidatesExhaustedError, LlmStreamError, ProviderRequestValidationError, QuotaExhaustedError, StreamIdleTimeoutError } from "../../../../../src/orchestration/agent-runtime/llm/errors.js";
import { toFailureReason } from "../../../../../src/orchestration/agent-runtime/errors.js";
import { describeAgentFailure } from "../../../../../src/orchestration/agent-runtime/failure-message.js";
import { ProviderAttemptFailure } from "../../../../../src/orchestration/agent-runtime/llm/provider-failure.js";
import { createProviderAvailability } from "../../../../../src/orchestration/agent-runtime/llm/provider-availability.js";
import { workerOutcome } from "../../../../../src/orchestration/workflow-host/worker-outcome.js";
import { WorkerFailedError, classifyError } from "../../../../../src/workflows/context-bundle/error-classifier.js";
import {
  chain,
  preparedRequest,
  requestEvents,
  executeStream,
  expectSafeRecheck,
  fakeAvailability,
  fakeClient,
  providerOutageError,
  run,
  SAFE_RECHECK_MS,
  streamOptions,
  textDelta,
  textStream,
  throwingStream,
  singletonCandidate,
  subscriptionCandidate,
} from "./_provider-chain-harness.js";

describe("terminal outage failover", () => {
  test("lets local failures escape the callback without advancing", async () => {
    const visits: AccessProviderId[] = [];
    const local = new TypeError("local");
    const request = await chain({ availability: fakeAvailability({}).availability }).admitRequest();
    await expect(request.run({
      prepare: preparedRequest,
      execute: async ({ attempt }) => {
        visits.push(attempt.accessProvider);
        throw local;
      },
    })).rejects.toBe(local);
    expect(visits).toEqual(["chatgpt"]);
  });
  test("restarts the request on the next candidate after a terminal outage, recording the outage and no exhaustion", async () => {
    const availability = fakeAvailability({});
    const built: AccessProviderId[] = [];
    const client = chain({
      candidates: ["openai_api", "openrouter"],
      build: async (provider) => {
        built.push(provider);
        return fakeClient(
          provider,
          provider === "openai_api"
            ? throwingStream(providerOutageError("502 bad gateway"))
            : textStream("served"),
        );
      },
      availability: availability.availability,
    });

    expect(await run(client)).toEqual([textDelta("served")]);
    expect(built).toEqual(["openai_api", "openrouter"]);
    // The outage is the service row's fact, never the quota's: the account
    // can still pay the moment the provider answers again.
    expect(availability.genericEntryCount()).toBe(0);
    expect(availability.serviceEntryCount()).toBe(1);
    expect(availability.availability.serviceStanding("openai_api").kind).toBe("suppressed");

    // The next request reads the recorded outage and skips the downed
    // candidate before asking the injected adapter owner for the fallback.
    expect(await run(client)).toEqual([textDelta("served")]);
    expect(built).toEqual(["openai_api", "openrouter", "openrouter"]);
  });

  test("an outage advances from subscription to the next configured candidate", async () => {
    const availability = fakeAvailability({});
    const built: AccessProviderId[] = [];
    let healthy = false;
    const client = chain({
      candidates: [subscriptionCandidate("chatgpt"), singletonCandidate("openrouter")],
      build: async (provider) => {
        built.push(provider);
        return fakeClient(provider, provider === "chatgpt"
          ? async function* () {
            if (!healthy) throw new LlmStreamError("stream idle timeout", "transient");
            yield textDelta("subscription resumed");
          }
          : textStream("metered fallback"));
      },
      availability: availability.availability,
    });

    expect(await run(client)).toEqual([textDelta("metered fallback")]);
    expect(built).toEqual(["chatgpt", "openrouter"]);

    healthy = true;
    expect(await run(client)).toEqual([textDelta("subscription resumed")]);
    expect(built).toEqual(["chatgpt", "openrouter", "chatgpt"]);
  });

  test("an outage advances to the next subscription before metered billing", async () => {
    const built: AccessProviderId[] = [];
    const client = chain({
      candidates: [
        subscriptionCandidate("chatgpt"),
        subscriptionCandidate("opencode_go"),
        singletonCandidate("openrouter"),
      ],
      build: async (provider) => {
        built.push(provider);
        return fakeClient(provider, provider === "chatgpt"
          ? throwingStream(new LlmStreamError("stream idle timeout", "transient"))
          : textStream(provider));
      },
      availability: fakeAvailability({}).availability,
    });

    expect(await run(client)).toEqual([textDelta("opencode_go")]);
    expect(built).toEqual(["chatgpt", "opencode_go"]);
  });

  test("a suppressed subscription cannot prevent a ready configured fallback", async () => {
    const availability = fakeAvailability({});
    availability.availability.markUnreachable("chatgpt");
    const built: AccessProviderId[] = [];
    const resetsAtSeconds = Math.floor(Date.now() / 1000) + 3_600;
    const client = chain({
      candidates: [subscriptionCandidate("chatgpt"), singletonCandidate("openrouter")],
      build: async (provider) => {
        built.push(provider);
        return fakeClient(provider, provider === "chatgpt"
          ? async function* () {
            availability.availability.observeChatGptQuotaExhausted(subscriptionCandidate("chatgpt"), resetsAtSeconds);
            throw new QuotaExhaustedError("usage limit reached");
          }
          : textStream("metered fallback"));
      },
      availability: availability.availability,
    });

    expect(await run(client)).toEqual([textDelta("metered fallback")]);
    expect(built).toEqual(["openrouter"]);
  });

  test("reports the classified outage that caused pre-evidence abandonment", async () => {
    const order: string[] = [];
    const client = chain({
      candidates: ["openai_api", "openrouter"],
      build: async (provider) => fakeClient(
        provider,
        provider === "openai_api"
          ? throwingStream(new LlmStreamError("502 bad gateway", "transient"))
          : textStream("served"),
      ),
      availability: fakeAvailability({}).availability,
    });

    await (await client.admitRequest()).run({
      prepare: preparedRequest,
      execute: async ({ attempt, client: adapter }) => {
        order.push(`prepare:${attempt.accessProvider}`);
        const result = await executeStream(adapter, streamOptions);
        if (result.kind === "success") return result;
        order.push(`abandon:${attempt.accessProvider}:${result.failure._tag}`);
        return result;
      },
    });

    // Every in-place retry is abandoned and re-prepared on the same
    // candidate; the fallback is prepared only when those are spent.
    expect(order).toEqual([
      "prepare:openai_api",
      "abandon:openai_api:TransientNetworkFailure",
      "prepare:openai_api",
      "abandon:openai_api:TransientNetworkFailure",
      "prepare:openai_api",
      "abandon:openai_api:TransientNetworkFailure",
      "prepare:openai_api",
      "abandon:openai_api:TransientNetworkFailure",
      "prepare:openrouter",
    ]);
  });

  test("does not acquire an outage fallback when strict abandonment fails", async () => {
    const built: AccessProviderId[] = [];
    const client = chain({
      candidates: ["openai_api", "openrouter"],
      build: async (provider) => {
        built.push(provider);
        return fakeClient(provider, throwingStream(new LlmStreamError("502 bad gateway", "transient")));
      },
      availability: fakeAvailability({}).availability,
    });

    await expect((await client.admitRequest()).run({
      prepare: preparedRequest,
      execute: async ({ client: adapter }) => {
        const result = await executeStream(adapter, streamOptions);
        if (result.kind === "success") return result;
        throw new Error("abandonment failed");
      },
    })).rejects.toThrow("abandonment failed");
    expect(built).toEqual(["openai_api"]);
  });

  test("exhausts each candidate after partial output and records attributed outages", async () => {
    const availability = fakeAvailability({});
    const client = chain({
      candidates: ["openai_api", "openrouter"],
      build: async (provider) => fakeClient(provider, throwingStream(providerOutageError("terminated"), textDelta("partial"))),
      availability: availability.availability,
    });

    await expect(requestEvents(client)).rejects.toThrow(AllCandidatesExhaustedError);
    expect(availability.availability.serviceStanding("openai_api").kind).toBe("suppressed");
  });

  test("a provider request rejection stops the request: every candidate would reject it the same way", async () => {
    const availability = fakeAvailability({});
    const built: AccessProviderId[] = [];
    const client = chain({
      candidates: ["openai_api", "openrouter"],
      build: async (provider) => {
        built.push(provider);
        return fakeClient(provider, throwingStream(new ProviderRequestValidationError("openai", "tool schema rejected")));
      },
      availability: availability.availability,
    });

    const thrown = await requestEvents(client).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(ProviderAttemptFailure);
    if (!(thrown instanceof ProviderAttemptFailure)) throw new Error("expected an attempt failure");
    expect(thrown.failure._tag).toBe("InvalidRequestFailure");
    expect(thrown.message).toContain("tool schema rejected");
    expect(built).toEqual(["openai_api"]);
    expect(availability.serviceEntryCount()).toBe(0);
  });

  test("a local defect is unattributable: no failover, no outage record", async () => {
    const availability = fakeAvailability({});
    const built: AccessProviderId[] = [];
    const client = chain({
      candidates: ["openai_api", "openrouter"],
      build: async (provider) => {
        built.push(provider);
        return fakeClient(provider, throwingStream(new TypeError("undefined is not an object (evaluating 'this.enqueue')")));
      },
      availability: availability.availability,
    });

    await expect(run(client)).rejects.toThrow(TypeError);
    expect(built).toEqual(["openai_api"]);
    expect(availability.serviceEntryCount()).toBe(0);
    expect(availability.availability.serviceStanding("openai_api").kind).toBe("live");
  });

  test("an unattributed outage-shaped failure advances the walk but records no durable suppression", async () => {
    const availability = fakeAvailability({});
    const client = chain({
      candidates: ["openai_api", "openrouter"],
      build: async (provider) => fakeClient(
        provider,
        provider === "openai_api"
          // An adapter inference from silence: no wrapped wire error.
          ? throwingStream(new LlmStreamError("stream closed before response.completed", "transient"))
          : textStream("served"),
      ),
      availability: availability.availability,
    });

    expect(await run(client)).toEqual([textDelta("served")]);
    expect(availability.serviceEntryCount()).toBe(0);
    expect(availability.availability.serviceStanding("openai_api").kind).toBe("live");
  });

  test("an adapter-classified unknown stream failure is not evidence about the candidate: the request stops", async () => {
    const availability = fakeAvailability({});
    const built: AccessProviderId[] = [];
    const client = chain({
      candidates: ["openai_api", "openrouter"],
      build: async (provider) => {
        built.push(provider);
        return fakeClient(
          provider,
          provider === "openai_api"
            ? throwingStream(new LlmStreamError("unrecognized provider frame", "unknown"))
            : textStream("served"),
        );
      },
      availability: availability.availability,
    });

    await expect(run(client)).rejects.toBeInstanceOf(ProviderAttemptFailure);
    expect(built).toEqual(["openai_api"]);
    expect(availability.availability.serviceStanding("openai_api").kind).toBe("live");
  });

  test("a caller abort mid-stream is never an outage, however the torn stream surfaces", async () => {
    const availability = fakeAvailability({});
    const controller = new AbortController();
    const built: AccessProviderId[] = [];
    const client = chain({
      candidates: ["openai_api", "openrouter"],
      build: async (provider) => {
        built.push(provider);
        return fakeClient(provider, async function* () {
          yield textDelta("partial");
          controller.abort();
          // The adapter reports the abort-torn stream as a transient failure.
          throw new LlmStreamError("stream closed before response.completed", "transient");
        });
      },
      availability: availability.availability,
    });

    await expect(requestEvents(client, {
      ...streamOptions,
      signal: controller.signal,
      attemptProducedEvidence: () => true,
    })).rejects.toThrow("stream closed before response.completed");
    expect(built).toEqual(["openai_api"]);
    expect(availability.serviceEntryCount()).toBe(0);
    expect(availability.availability.serviceStanding("openai_api").kind).toBe("live");
  });

  test("silence without wire evidence exhausts candidates without a durable outage mark", async () => {
    const availability = fakeAvailability({});
    const built: AccessProviderId[] = [];
    const client = chain({
      candidates: ["openai_api", "openrouter"],
      build: async (provider) => {
        built.push(provider);
        return fakeClient(provider, async function* () {
          throw new LlmStreamError("stream idle timeout", "transient");
        });
      },
      availability: availability.availability,
    });

    await expect(run(client)).rejects.toThrow("stream idle timeout");
    expect(built).toEqual(["openai_api", "openrouter"]);
    expect(availability.serviceEntryCount()).toBe(0);
    expect(availability.availability.serviceStanding("openai_api").kind).toBe("live");
  });
});

describe("sole-source availability", () => {
  test.each([
    [Object.assign(new Error("throttled"), { status: 429 }), new QuotaExhaustedError("credits spent"), "Rate limited", "Out of credits", "fatal"],
    [new QuotaExhaustedError("credits spent"), new Error("ECONNRESET"), "Out of credits", "Connection lost", "transient"],
    [new Error("ECONNRESET"), new QuotaExhaustedError("credits spent"), "Connection lost", "Out of credits", "fatal"],
    [new Error("ECONNRESET"), providerOutageError("503 unavailable", "overload"), "Connection lost", "Provider server error", "unknown"],
  ] as const)("retains route evidence for %s without changing the legacy workflow classification", async (freeFailure, ordinaryFailure, freeTitle, ordinaryTitle, classification) => {
    const candidate = singletonCandidate("openrouter");
    const owner = createProviderAvailability({});
    const availability = owner.forCandidates("route-holds", [candidate]);
    let dispatches = 0;
    try {
      const client = chain({
        availability,
        candidateAttributions: [
          { candidate, wireModelId: "vendor/model:free", dataUse: "standard", routeKind: "free" },
          { candidate, wireModelId: "vendor/model", dataUse: "standard" },
        ],
        build: async (provider, attribution) => fakeClient(provider, async function* () {
          dispatches++;
          yield* throwingStream(attribution.routeKind === "free" ? freeFailure : ordinaryFailure)();
        }),
      });
      const error = await requestEvents(client).catch((thrown: unknown) => thrown);
      if (!(error instanceof AllCandidatesExhaustedError)) throw new Error("expected aggregate exhaustion");
      const reason = toFailureReason(error);
      const outcome = workerOutcome({ servedRequests: 0, durationMs: 1, terminal: reason });
      if (outcome.output !== "failed") throw new Error("expected failed workflow outcome");
      expect(classifyError(new WorkerFailedError(outcome.failureKind, outcome.failureMessage, outcome.failureDetail))).toBe(classification);
      expect(error.message).not.toContain(freeFailure.message);
      const copy = describeAgentFailure(reason);
      expect(copy.title).toBe("Providers unavailable");
      expect(copy.detail).toContain(`OpenRouter (free route vendor/model:free): ${freeTitle}. ${freeFailure.message}`);
      expect(copy.detail).toContain(`OpenRouter: ${ordinaryTitle}. ${ordinaryFailure.message}`);
      expect(copy.detail).not.toContain("paid route");
      // Every spent route states when to try again, but only a held one keeps the next request from dispatching.
      expect(copy.guidance).toContain("Wait until then");
      const held = ordinaryTitle !== "Connection lost";
      const firstDispatches = dispatches;
      await expect(requestEvents(client)).rejects.toBeInstanceOf(AllCandidatesExhaustedError);
      expect(dispatches - firstDispatches).toBe(held ? 0 : 5);
    } finally {
      await owner.dispose();
    }
  });

  test.each([
    [new QuotaExhaustedError("insufficient_quota"), "Out of credits", true],
    [Object.assign(new Error("throttled"), { status: 429 }), "Rate limited", true],
    [new LlmStreamError("unavailable", "overload", undefined, { cause: Object.assign(new Error("unavailable"), { status: 503 }) }), "Provider server error", true],
    [new LlmStreamError("busy", "overload", undefined, { cause: Object.assign(new Error("busy"), { status: 529 }) }), "Provider overloaded", true],
    [new LlmStreamError("slow down", "rate_limit"), "Rate limited", false],
    [new LlmStreamError("busy", "overload"), "Provider overloaded", false],
    [new Error("ECONNRESET"), "Connection lost", false],
    [new StreamIdleTimeoutError("stream idle timeout", "idle"), "Model response stalled", false],
  ])("renders the current request cause %s after exhaustion", async (failure, title, marked) => {
    const availability = fakeAvailability({});
    const before = Date.now();
    const client = chain({ candidates: ["openai_api"], availability: availability.availability, build: async (provider) => fakeClient(provider, throwingStream(failure)) });
    const error = await requestEvents(client).catch((thrown: unknown) => thrown);
    if (!(error instanceof AllCandidatesExhaustedError)) throw new Error("expected aggregate exhaustion");
    const copy = describeAgentFailure(toFailureReason(error));
    expect(copy.title).toBe(title);
    // The last spent route always states when to try again, so an unattended agent waits rather than fails.
    expect(copy.guidance).toContain("Wait until then");
    expect(error.recovery.kind).toBe("at");
    if (marked) return;
    // A failure the provider did not state holds back no other session; the bound is this request's alone.
    expect(availability.serviceEntryCount()).toBe(0);
    expect(copy.message).not.toContain("unreachable");
    expectSafeRecheck(error, before);
  });

  test("a downed sole provider offers retry after its suppression bound, when a request can publish recovery", async () => {
    const availability = fakeAvailability({});
    availability.availability.markUnreachable("openai_api");
    let calls = 0;
    const client = chain({
      candidates: ["openai_api"],
      build: async (provider) => fakeClient(provider, async function* () {
        calls += 1;
        yield textDelta("recovered");
      }),
      availability: availability.availability,
    });

    const error = await requestEvents(client).then(
      () => { throw new Error("expected the request to reject") },
      (thrown) => thrown,
    );
    expect(error).toBeInstanceOf(AllCandidatesExhaustedError);
    if (!(error instanceof AllCandidatesExhaustedError)) throw new Error("expected aggregate exhaustion");
    expect(error.message).toContain("OpenAI: unreachable; one request will recheck it");
    const standing = availability.availability.serviceStanding("openai_api");
    expect(standing.kind).toBe("suppressed");
    if (standing.kind !== "suppressed") throw new Error("expected provider suppression");
    expect(calls).toBe(0);

    const copy = describeAgentFailure(toFailureReason(error));
    const recheckAt = new Date(standing.exhaustion.resetsAtMs);
    expect(copy.title).toBe("Provider unavailable");
    expect(copy.message).toContain("No configured provider can serve");
    expect(copy.message).toContain(`A request after ${recheckAt.toLocaleString()} can recheck provider availability.`);
    expect(copy.message).not.toMatch(/automatic|retry now/i);
    expect(copy.detail).toBe(`OpenAI: Provider unavailable. unreachable; one request will recheck it at ${recheckAt.toISOString()}.`);
    expect(copy.guidance).toBe("Wait until then and send a message to retry, or switch models with /model.");
    expect(copy.action).toEqual({ label: "Switch models", command: "/model" });

    availability.advance(SAFE_RECHECK_MS - 1);
    await expect(requestEvents(client)).rejects.toBeInstanceOf(AllCandidatesExhaustedError);
    expect(calls).toBe(0);
    availability.advance(2);
    expect(await requestEvents(client)).toEqual([textDelta("recovered")]);
    expect(calls).toBe(1);
    expect(availability.livePublishes).toEqual(["openai_api"]);
    expect(availability.availability.serviceStanding("openai_api").kind).toBe("live");
  });

  test("planning reports aggregate exhaustion while the sole provider is suppressed", async () => {
    const availability = fakeAvailability({});
    availability.availability.markUnreachable("openai_api");
    const client = chain({
      candidates: ["openai_api"],
      availability: availability.availability,
    });

    await expect(client.plannedAttempt()).rejects.toBeInstanceOf(AllCandidatesExhaustedError);
    expect(availability.availability.serviceStanding("openai_api").kind).toBe("suppressed");
    expect(availability.livePublishes).toEqual([]);
  });

  test("planning prefers a live fallback over the downed provider's last resort", async () => {
    const availability = fakeAvailability({});
    availability.availability.markUnreachable("openai_api");
    const client = chain({
      candidates: ["openai_api", "openrouter"],
      availability: availability.availability,
    });

    expect((await client.plannedAttempt()).accessProvider).toBe("openrouter");
  });

  test("a dead end with a quota-spent fallback names the failed provider and why the fallback cannot serve", async () => {
    const availability = fakeAvailability({});
    const resetsAtMs = Date.now() + 3_600_000;
    availability.availability.markQuotaExhausted(singletonCandidate("openrouter"), resetsAtMs);
    const client = chain({
      candidates: ["openai_api", "openrouter"],
      build: async (provider) => fakeClient(provider, throwingStream(new LlmStreamError("502 bad gateway", "overload"))),
      availability: availability.availability,
    });

    const error = await requestEvents(client).then(
      () => { throw new Error("expected the request to reject") },
      (thrown) => thrown,
    );

    expect(error).toBeInstanceOf(AllCandidatesExhaustedError);
    if (!(error instanceof AllCandidatesExhaustedError)) throw new Error("expected aggregate exhaustion");
    expect(error.message).toContain("OpenAI: unreachable after 4 attempts (502 bad gateway)");
    expect(error.message).toContain(`OpenRouter: out of quota until ${new Date(resetsAtMs).toISOString()}`);
  });

  test("a later quota failure joins the aggregate after an earlier outage", async () => {
    const availability = fakeAvailability({});
    const htmlBody = "502 <html>\n<head><title>502 Bad Gateway</title></head>\n<body><center>cloudflare</center></body>\n</html>";
    const client = chain({
      candidates: ["openai_api", "openrouter"],
      build: async (provider) => fakeClient(provider, provider === "openai_api"
        ? throwingStream(new LlmStreamError(htmlBody, "overload"))
        : throwingStream(new QuotaExhaustedError("You exceeded your current quota."))),
      availability: availability.availability,
    });
    const error = await requestEvents(client).catch((thrown: unknown) => thrown);
    if (!(error instanceof AllCandidatesExhaustedError)) throw new Error("expected aggregate exhaustion");
    expect(error.message).toContain("OpenAI");
    expect(error.message).toContain("OpenRouter");
    const copy = describeAgentFailure(toFailureReason(error));
    expect(copy.title).toBe("Providers unavailable");
    expect(copy.message).toContain("different reasons");
    expect(copy.detail).toContain("Provider overloaded");
    expect(copy.detail).toContain("Out of credits");
  });

  test("mixed holds leave an unheld candidate servable beside an unreviewed paid mode", async () => {
    const now = Date.now();
    const owner = createProviderAvailability({ now: () => now });
    const prepaid = { kind: "subscription" as const, providerId: "opencode_go", instanceId: "account-a", spendMode: "prepaid" as const };
    const candidates = [singletonCandidate("openai_api"), singletonCandidate("openrouter"), prepaid];
    const availability = owner.forCandidates("mixed-holds", candidates);
    let recovered = false;
    const calls: AccessProviderId[] = [];
    try {
      const client = chain({
        candidates,
        availability,
        build: async (provider) => fakeClient(provider, async function* () {
          calls.push(provider);
          if (recovered) yield textDelta("recovered");
          else if (provider === "openai_api") throw new Error("ECONNRESET");
          else throw providerOutageError("503 unavailable", "overload");
        }),
      });
      const error = await requestEvents(client).catch((thrown: unknown) => thrown);
      if (!(error instanceof AllCandidatesExhaustedError)) throw new Error("expected aggregate exhaustion");
      expect(availability.serviceStanding("openai_api").kind).toBe("live");
      const held = availability.serviceStanding("openrouter");
      if (held.kind !== "suppressed") throw new Error("expected service suppression");
      expect(calls).toEqual([...Array.from({ length: 4 }, () => "openai_api"), ...Array.from({ length: 4 }, () => "openrouter")]);
      recovered = true;
      calls.length = 0;
      expect(await requestEvents(client)).toEqual([textDelta("recovered")]);
      expect(calls).toEqual(["openai_api"]);
      const copy = describeAgentFailure(toFailureReason(error));
      expect(copy.title).toBe("Providers unavailable");
      expect(copy.detail).toContain("Connection lost");
      expect(copy.detail).toContain("Provider server error");
      expect(copy.detail).toContain("Subscription paid capacity requires review");
      expect(copy.message).toContain(new Date(held.exhaustion.resetsAtMs).toLocaleString());
      expect(copy.message).not.toMatch(/before dispatch|automatic/i);
      // The unheld candidate rechecks after the safe interval, so the held one's shorter bound is the earliest.
      expect(error.recovery).toEqual({ kind: "at", atMs: held.exhaustion.resetsAtMs, hold: { kind: "recheck" } });
    } finally {
      await owner.dispose();
    }
  });

  test("the outage copy retains immediate retry when the aggregate has no recheck bound", () => {
    const copy = classifyApiError('No access provider can run "gpt-5.5" right now. OpenAI: unreachable (502 Bad Gateway).');
    expect(copy.title).toBe("Provider unavailable");
    expect(copy.message).toContain("unreachable");
    expect(copy.message).not.toMatch(/recheck|automatic/i);
    expect(copy.detail).toBe("OpenAI: unreachable (502 Bad Gateway).");
    expect(copy.guidance).toBe("Send a message to retry now, or switch models with /model.");
    expect(copy.action).toEqual({ label: "Switch models", command: "/model" });
  });

  test("a quota-spent fallback does not bypass the preferred provider suppression", async () => {
    const availability = fakeAvailability({});
    availability.availability.markUnreachable("openai_api");
    availability.availability.markQuotaExhausted(singletonCandidate("openrouter"), Date.now() + 3_600_000);
    const built: AccessProviderId[] = [];
    const client = chain({
      candidates: ["openai_api", "openrouter"],
      build: async (provider) => {
        built.push(provider);
        return fakeClient(provider, textStream("served"));
      },
      availability: availability.availability,
    });

    await expect(requestEvents(client)).rejects.toBeInstanceOf(AllCandidatesExhaustedError);
    expect(built).toEqual([]);
    availability.advance(SAFE_RECHECK_MS + 1);
    expect(await requestEvents(client)).toEqual([textDelta("served")]);
    expect(built).toEqual(["openai_api"]);
  });

  test("with a live fallback the cooldown holds: the downed provider is skipped, not retried", async () => {
    const availability = fakeAvailability({});
    availability.availability.markUnreachable("openai_api");
    const built: AccessProviderId[] = [];
    const client = chain({
      candidates: ["openai_api", "openrouter"],
      build: async (provider) => {
        built.push(provider);
        return fakeClient(provider, textStream(provider));
      },
      availability: availability.availability,
    });

    expect(await requestEvents(client)).toEqual([textDelta("openrouter")]);
    expect(built).toEqual(["openrouter"]);
  });

  test("outage recovery with a fallback is one probe after the suppression bound", async () => {
    const availability = fakeAvailability({});
    let healthy = false;
    const client = chain({
      candidates: ["openai_api", "openrouter"],
      build: async (provider) => fakeClient(provider, provider === "openrouter"
        ? textStream("openrouter")
        : async function* () {
          if (!healthy) throw providerOutageError("502 bad gateway");
          yield textDelta("openai_api");
        }),
      availability: availability.availability,
    });

    expect(await requestEvents(client)).toEqual([textDelta("openrouter")]);
    expect(availability.availability.serviceStanding("openai_api").kind).toBe("suppressed");

    // Inside the bound the fallback serves without touching the sub.
    expect(await requestEvents(client)).toEqual([textDelta("openrouter")]);

    healthy = true;
    availability.advance(SAFE_RECHECK_MS + 1);
    expect(await requestEvents(client)).toEqual([textDelta("openai_api")]);
    expect(availability.livePublishes).toEqual(["openai_api"]);
    expect(availability.availability.serviceStanding("openai_api").kind).toBe("live");
  });

  test("a failed outage probe renews the bound and the request falls over to the fallback", async () => {
    const availability = fakeAvailability({});
    const client = chain({
      candidates: ["openai_api", "openrouter"],
      build: async (provider) => fakeClient(provider, provider === "openrouter"
        ? textStream("openrouter")
        : throwingStream(providerOutageError("502 bad gateway"))),
      availability: availability.availability,
    });

    await run(client);
    availability.advance(SAFE_RECHECK_MS + 1);
    expect(await run(client)).toEqual([textDelta("openrouter")]);
    expect(availability.livePublishes).toEqual([]);
    expect(availability.availability.serviceStanding("openai_api").kind).toBe("suppressed");
  });
});
