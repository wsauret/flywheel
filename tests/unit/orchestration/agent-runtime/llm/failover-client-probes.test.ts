import { describe, expect, test } from "bun:test";
import type { ProviderAvailability } from "../../../../../src/orchestration/agent-runtime/llm/provider-availability-types.js";
import { AllCandidatesExhaustedError, QuotaExhaustedError } from "../../../../../src/orchestration/agent-runtime/llm/errors.js";
import { normalizeProviderAttemptFailure } from "../../../../../src/orchestration/agent-runtime/llm/provider-failure.js";
import {
  chain,
  fakeAvailability,
  fakeClient,
  preparedRequest,
  providerOutageError,
  requestEvents,
  run,
  SAFE_RECHECK_MS,
  singletonCandidate,
  subscriptionCandidate,
  textDelta,
  textStream,
  throwingStream,
} from "./_provider-chain-harness.js";

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

  test("a request stopped while an earlier candidate builds leaves the next candidate's due recheck unclaimed", async () => {
    const stopped = async (stopAt: "build" | "served") => {
      const availability = fakeAvailability({});
      const anthropic = subscriptionCandidate("anthropic");
      const controller = new AbortController();
      const stop = () => controller.abort(new DOMException("stopped", "AbortError"));
      const client = chain({
        candidates: stopAt === "build" ? [singletonCandidate("openai_api"), anthropic] : [anthropic],
        availability: availability.availability,
        // The serving decision is recorded between the walk's last stop check and the attempt that owns its probes.
        routing: { record: (decision) => { if (stopAt === "served" && decision.kind === "served") stop() } },
        build: async (provider) => {
          if (provider !== "openai_api") return fakeClient(provider, textStream(provider));
          stop();
          throw normalizeProviderAttemptFailure(new QuotaExhaustedError("usage limit reached"));
        },
      });
      availability.availability.markQuotaExhausted(anthropic);
      availability.advance(SAFE_RECHECK_MS + 1);
      await expect((await client.admitRequest()).run({
        signal: controller.signal,
        prepare: preparedRequest,
        execute: async () => ({ kind: "success" as const, value: "served" }),
      })).rejects.toMatchObject({ name: "AbortError" });
      expect(availability.availability.genericQuotaStanding(anthropic)).toEqual({ kind: "probe_due" });
      return availability.probeReleases;
    };

    expect(await stopped("build")).toEqual([]);
    expect(await stopped("served")).toEqual(["anthropic"]);
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
