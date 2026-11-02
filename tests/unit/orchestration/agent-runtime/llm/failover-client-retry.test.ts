/** In-place retry on the admitted request's walk: a candidate's transient
 *  failure is retried on that candidate with bounded backoff, and the walk
 *  advances only when those retries are spent. The outage evidence a spent
 *  candidate leaves behind is the retries' aggregate, never one failure. */

import { describe, expect, test } from "bun:test";
import type { AccessProviderId } from "../../../../../src/infra/llm/access-provider.js";
import { AllCandidatesExhaustedError, LlmStreamError, QuotaExhaustedError } from "../../../../../src/orchestration/agent-runtime/llm/errors.js";
import type { ProviderRetry } from "../../../../../src/orchestration/agent-runtime/llm/types.js";
import { normalizeProviderAttemptFailure } from "../../../../../src/orchestration/agent-runtime/llm/provider-failure.js";
import {
  chain,
  preparedRequest,
  executeStream,
  expectSafeRecheck,
  fakeAvailability,
  fakeClient,
  providerOutageError,
  requestEvents,
  run,
  singletonCandidate,
  sleepRecorder,
  streamOptions,
  subscriptionCandidate,
  textDelta,
  textStream,
  throwingStream,
} from "./_provider-chain-harness.js";

/** A connection that went away: the wire stated nothing. */
const connectionLost = (): LlmStreamError => new LlmStreamError("WebSocket closed 1006 Connection ended", "transient", undefined, { cause: new Error("WebSocket closed 1006 Connection ended") });

function failingThen(failures: number, error: () => Error, text: string) {
  let remaining = failures;
  return async function* () {
    if (remaining > 0) {
      remaining -= 1;
      throw error();
    }
    yield textDelta(text);
  };
}

describe("in-place retry on the walk", () => {
  test("retries a candidate's transient failure on that candidate with growing backoff", async () => {
    const sleeps = sleepRecorder();
    const built: AccessProviderId[] = [];
    const client = chain({
      candidates: [subscriptionCandidate("chatgpt"), singletonCandidate("openrouter")],
      build: async (provider) => {
        built.push(provider);
        return fakeClient(provider, provider === "chatgpt" ? failingThen(2, connectionLost, "chatgpt") : textStream("openrouter"));
      },
      availability: fakeAvailability({}).availability,
      sleep: sleeps.sleep,
    });

    expect(await run(client)).toEqual([textDelta("chatgpt")]);
    expect(built).toEqual(["chatgpt"]);
    expect(sleeps.delays).toHaveLength(2);
    expect(sleeps.delays[0]).toBeGreaterThanOrEqual(750);
    expect(sleeps.delays[0]).toBeLessThanOrEqual(1_250);
    expect(sleeps.delays[1]).toBeGreaterThanOrEqual(1_500);
    expect(sleeps.delays[1]).toBeLessThanOrEqual(2_500);
  });

  test.each([
    connectionLost(),
    Object.assign(new TypeError("The socket connection was closed unexpectedly."), { code: "ECONNRESET" }),
    new Error("SDK operation failed", { cause: Object.assign(new TypeError("The socket connection was closed unexpectedly."), { code: "ECONNRESET" }) }),
  ])("advances only when the candidate's retries are spent, and a lost connection marks no outage (%s)", async (error) => {
    const sleeps = sleepRecorder();
    const availability = fakeAvailability({});
    const attempts: AccessProviderId[] = [];
    const client = chain({
      candidates: [subscriptionCandidate("chatgpt"), singletonCandidate("openrouter")],
      build: async (provider) => fakeClient(provider, provider === "chatgpt"
        ? async function* () { attempts.push(provider); throw normalizeProviderAttemptFailure(error); }
        : async function* () { attempts.push(provider); yield textDelta("openrouter"); }),
      availability: availability.availability,
      sleep: sleeps.sleep,
    });

    expect(await run(client)).toEqual([textDelta("openrouter")]);
    expect(attempts).toEqual(["chatgpt", "chatgpt", "chatgpt", "chatgpt", "openrouter"]);
    expect(sleeps.delays).toHaveLength(3);
    expect(availability.serviceEntryCount()).toBe(0);
    expect(availability.availability.serviceStanding("chatgpt").kind).toBe("live");
  });

  test.each([
    providerOutageError("502 bad gateway"),
    ...["rate_limit_exceeded", "overloaded_error"].flatMap((code) => {
      const error = Object.assign(new Error(code === "overloaded_error" ? "Overloaded" : "Rate limit exceeded. Too many requests."), { code, type: code });
      return [error, new Error("SDK operation failed", { cause: error })];
    }),
  ])("a failure the provider stated marks the outage once the retries are spent, not before (%s)", async (error) => {
    const sleeps = sleepRecorder();
    const availability = fakeAvailability({});
    const marksSeen: number[] = [];
    let attempts = 0;
    const client = chain({
      candidates: ["openai_api", "openrouter"],
      build: async (provider) => fakeClient(provider, provider === "openai_api"
        ? async function* () {
          attempts += 1;
          marksSeen.push(availability.serviceEntryCount());
          throw error;
        }
        : textStream("openrouter")),
      availability: availability.availability,
      sleep: sleeps.sleep,
    });

    expect(await run(client)).toEqual([textDelta("openrouter")]);
    expect(attempts).toBe(4);
    expect(sleeps.delays).toHaveLength(3);
    expect(marksSeen).toEqual([0, 0, 0, 0]);
    expect(availability.availability.serviceStanding("openai_api").kind).toBe("suppressed");
  });

  test("a rate limit waits exactly as long as the provider asked", async () => {
    const sleeps = sleepRecorder();
    const client = chain({
      candidates: ["openai_api"],
      build: async (provider) => fakeClient(provider, failingThen(1, () => new LlmStreamError("throttled", "rate_limit", 5_000), "served")),
      availability: fakeAvailability({}).availability,
      sleep: sleeps.sleep,
    });

    expect(await run(client)).toEqual([textDelta("served")]);
    expect(sleeps.delays).toEqual([5_000]);
  });

  test("a spent quota is never retried on the same candidate", async () => {
    const sleeps = sleepRecorder();
    const attempts: AccessProviderId[] = [];
    const client = chain({
      candidates: ["openai_api", "openrouter"],
      build: async (provider) => fakeClient(provider, provider === "openai_api"
        ? async function* () { attempts.push(provider); throw new QuotaExhaustedError("You exceeded your current quota."); }
        : async function* () { attempts.push(provider); yield textDelta("openrouter"); }),
      availability: fakeAvailability({}).availability,
      sleep: sleeps.sleep,
    });

    expect(await run(client)).toEqual([textDelta("openrouter")]);
    expect(attempts).toEqual(["openai_api", "openrouter"]);
    expect(sleeps.delays).toEqual([]);
  });

  test("a spent free route marks no account quota and still rechecks after the safe interval", async () => {
    const availability = fakeAvailability({});
    const candidate = singletonCandidate("openrouter");
    const before = Date.now();
    const error = await requestEvents(chain({
      availability: availability.availability,
      candidateAttributions: [{ candidate, wireModelId: "vendor/model:free", dataUse: "standard", routeKind: "free" }],
      build: async (provider) => fakeClient(provider, throwingStream(new QuotaExhaustedError("free tier spent"))),
    })).catch((thrown: unknown) => thrown);
    expectSafeRecheck(error, before);
    // The free route's quota is not the account's, so the paid route stays open to every other request.
    expect(availability.genericEntryCount()).toBe(0);
  });

  test("an abort during the backoff ends the request with the abort reason", async () => {
    const controller = new AbortController();
    const reason = new DOMException("stopped", "AbortError");
    const attempts: AccessProviderId[] = [];
    const client = chain({
      candidates: ["openai_api", "openrouter"],
      build: async (provider) => fakeClient(provider, async function* () { attempts.push(provider); throw connectionLost(); }),
      availability: fakeAvailability({}).availability,
      sleep: (_ms, signal) => new Promise((_resolve, reject) => { signal.addEventListener("abort", () => reject(signal.reason), { once: true }); }),
    });

    const request = requestEvents(client, { ...streamOptions, signal: controller.signal });
    await Bun.sleep(1);
    controller.abort(reason);
    await expect(request).rejects.toBe(reason);
    expect(attempts).toEqual(["openai_api"]);
  });

  test("reports each retry before it waits, so the session can show the reconnect", async () => {
    const sleeps = sleepRecorder();
    const retries: ProviderRetry[] = [];
    const client = chain({
      candidates: ["openai_api"],
      build: async (provider) => fakeClient(provider, failingThen(2, connectionLost, "served")),
      availability: fakeAvailability({}).availability,
      sleep: sleeps.sleep,
    });

    const request = await client.admitRequest();
    const events = await request.run({
      prepare: preparedRequest,
      execute: ({ client: adapter }) => executeStream(adapter, streamOptions),
      onRetry: (retry) => { retries.push(retry); },
    });

    expect(events).toEqual([textDelta("served")]);
    expect(sleeps.delays).toHaveLength(2);
    expect(retries.map((retry) => [retry.attempt, retry.maxAttempts, retry.delayMs, retry.failure._tag]))
      .toEqual(sleeps.delays.map((delayMs, index) => [index + 1, 3, delayMs, "TransientNetworkFailure"]));
  });

  test("a sole candidate that stays down exhausts after its retries with the connection detail", async () => {
    const sleeps = sleepRecorder();
    const availability = fakeAvailability({});
    let attempts = 0;
    const client = chain({
      candidates: ["openai_api"],
      build: async (provider) => fakeClient(provider, async function* () { attempts += 1; throw connectionLost(); }),
      availability: availability.availability,
      sleep: sleeps.sleep,
    });

    const error = await requestEvents(client).then(
      () => { throw new Error("expected the request to reject") },
      (thrown) => thrown,
    );
    expect(error).toBeInstanceOf(AllCandidatesExhaustedError);
    if (!(error instanceof AllCandidatesExhaustedError)) throw new Error("expected aggregate exhaustion");
    expect(attempts).toBe(4);
    expect(error.message).toContain("OpenAI: unreachable after 4 attempts (WebSocket closed 1006 Connection ended)");
    expect(availability.availability.serviceStanding("openai_api").kind).toBe("live");
  });

  test("the aggregate names a provider once when the same account fills several spend modes", async () => {
    const availability = fakeAvailability({});
    availability.availability.markUnreachable("chatgpt");
    const client = chain({
      candidates: [
        { kind: "subscription", providerId: "chatgpt", instanceId: "acct", spendMode: "included" },
        { kind: "subscription", providerId: "chatgpt", instanceId: "acct", spendMode: "prepaid" },
        { kind: "subscription", providerId: "chatgpt", instanceId: "acct", spendMode: "automatic" },
      ],
      build: async (provider) => fakeClient(provider, throwingStream(connectionLost())),
      availability: availability.availability,
    });

    const error = await requestEvents(client).then(
      () => { throw new Error("expected the request to reject") },
      (thrown) => thrown,
    );
    if (!(error instanceof AllCandidatesExhaustedError)) throw new Error("expected aggregate exhaustion");
    expect(error.message.match(/ChatGPT: unreachable/g)).toHaveLength(1);
  });
});
