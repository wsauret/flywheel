import { describe, expect, test } from "bun:test";
import { Redacted } from "effect";

import { AuthStoreMutationError } from "../../../../../src/infra/auth/auth-store-mutations.js";
import type { AccessProviderId } from "../../../../../src/infra/llm/access-provider.js";
import { AllCandidatesExhaustedError, QuotaExhaustedError, RouteUnavailableError } from "../../../../../src/orchestration/agent-runtime/llm/errors.js";
import { assertChatGptAccountUnchanged } from "../../../../../src/orchestration/agent-runtime/llm/openai-chatgpt.js";
import { normalizeProviderAttemptFailure, ProviderAttemptFailure } from "../../../../../src/orchestration/agent-runtime/llm/provider-failure.js";
import { createLoginObservations } from "../../../../../src/orchestration/modules/provider-claude-agent-sdk/login-observations.js";
import {
  chain,
  requestEvents,
  fakeAvailability,
  fakeClient,
  sleepRecorder,
  textStream,
  throwingStream,
  preparedRequest,
  singletonCandidate,
  subscriptionCandidate,
} from "./_provider-chain-harness.js";

/** Bad credentials are the account's problem, not the request's, but the
 *  next candidate is another account the user may be paying for. The chain
 *  advances only on the named usage and availability class, so an
 *  authentication rejection stops the request where it is and surfaces
 *  under its own name instead of silently spending a fallback. */
describe("provider authentication stops the request", () => {
  test("Stop unregisters an account waiter without resending or answering its question", async () => {
    const observations = createLoginObservations();
    const account = { accountId: "account", configDir: "/scratch/profile/claude", identity: "person@example.com" };
    observations.recordRequest(account, "login-rejected");
    const refusal = normalizeProviderAttemptFailure(Object.assign(new Error("login refused"), { status: 401 })).failure;
    if (refusal._tag !== "AuthFailure") throw new Error("expected authentication failure");
    const entered = Promise.withResolvers<void>();
    const activity: boolean[] = [];
    const controller = new AbortController();
    const stop = new Error("Stop");
    let executions = 0;
    const client = chain({
      availability: fakeAvailability({}).availability,
      awaitLogin: (_candidate, signal) => {
        const pending = observations.awaitLogin("/scratch/profile", account, signal);
        entered.resolve();
        return pending;
      },
    });
    const pending = (await client.admitRequest()).run({
      signal: controller.signal,
      prepare: preparedRequest,
      execute: async () => {
        executions += 1;
        return { kind: "login_refused", failure: refusal, value: "original failure" };
      },
      onLoginWait: (waiting) => { activity.push(waiting); },
    });
    await entered.promise;
    const [question] = observations.loginQuestions();
    expect(question?.phase).toBe("asking");
    expect(activity).toEqual([true]);
    controller.abort(stop);
    await expect(pending).rejects.toBe(stop);
    expect(executions).toBe(1);
    expect(activity).toEqual([true, false]);
    expect(observations.loginQuestions()).toEqual([question!]);
    observations.answerLogin(question!.id, "declined");
  });

  test.each(["renewed", "declined", "unavailable"] as const)("keeps authentication failure on its candidate when login is %s", async (answer) => {
    const refusal = normalizeProviderAttemptFailure(Object.assign(new Error("login refused"), { status: 401 })).failure;
    if (refusal._tag !== "AuthFailure") throw new Error("expected authentication failure");
    const original = { failure: refusal };
    const availability = fakeAvailability({});
    const visits: string[] = [];
    const activity: boolean[] = [];
    let waits = 0;
    let prepares = 0;
    let retries = 0;
    const client = chain({
      availability: availability.availability,
      ...(answer === "unavailable" ? {} : {
        awaitLogin: async (candidate) => {
          expect(candidate).toEqual(subscriptionCandidate("chatgpt"));
          waits += 1;
          return answer;
        },
      }),
    });
    const request = await client.admitRequest();
    const value = await request.run({
      prepare: (attempt) => { prepares += 1; return preparedRequest(attempt); },
      execute: async ({ attempt }) => {
        visits.push(attempt.accessProvider);
        return visits.length <= 2
          ? { kind: "login_refused", failure: refusal, value: original }
          : { kind: "success", value: original };
      },
      onRetry: () => { retries += 1; },
      onLoginWait: (waiting) => { activity.push(waiting); },
    });
    expect(value).toBe(original);
    expect(prepares).toBe(1);
    expect(retries).toBe(0);
    expect(waits).toBe(answer === "renewed" ? 2 : answer === "declined" ? 1 : 0);
    expect(visits).toEqual(answer === "renewed" ? ["chatgpt", "chatgpt", "chatgpt"] : ["chatgpt"]);
    expect(activity).toEqual(answer === "renewed" ? [true, false, true, false] : answer === "declined" ? [true, false] : []);
    expect(availability.serviceEntryCount()).toBe(0);
  });

  test("captured provider and file conditions skip only affected credential-backed candidates", async () => {
    const built: AccessProviderId[] = [];
    const availability = fakeAvailability({});
    const directory = "/profiles/default";
    const client = chain({
      candidates: ["chatgpt", "openai_api", "openrouter"],
      conditions: [
        { kind: "malformed", scope: "provider", providerId: "chatgpt", authDirectory: directory, revision: "r1" },
        { kind: "malformed", scope: "file", authDirectory: directory, path: `${directory}/auth.json`, revision: "r1" },
      ],
      credentialLineage: (candidate) => candidate.providerId === "openai_api" ? "stored-key" : undefined,
      build: async (provider) => {
        built.push(provider);
        return fakeClient(provider, textStream("fallback"));
      },
      availability: availability.availability,
    });

    expect(await requestEvents(client)).toEqual([{ kind: "text_delta", text: "fallback", blockKey: "b1" }]);
    expect(built).toEqual(["openrouter"]);

    const repaired = chain({
      candidates: ["chatgpt", "openai_api", "openrouter"],
      conditions: [],
      credentialLineage: (candidate) => candidate.providerId === "openai_api" ? "replacement-key" : undefined,
      build: async (provider) => {
        built.push(provider);
        return fakeClient(provider, textStream("repaired"));
      },
      availability: availability.availability,
    });
    expect(await requestEvents(repaired)).toEqual([{ kind: "text_delta", text: "repaired", blockKey: "b1" }]);
    expect(built).toEqual(["openrouter", "chatgpt"]);
  });

  test("a strict auth mutation failure settles before fallback and records its condition", async () => {
    const built: AccessProviderId[] = [];
    const observed: unknown[] = [];
    const availability = fakeAvailability({});
    const condition = { kind: "malformed", scope: "provider", providerId: "chatgpt", authDirectory: "/profiles/default", revision: "r1" } as const;
    const client = chain({
      build: async (provider) => {
        built.push(provider);
        if (provider === "chatgpt") throw normalizeProviderAttemptFailure(new AuthStoreMutationError([condition]));
        return fakeClient(provider, textStream("fallback"));
      },
      observeAuthConditions: (conditions) => { observed.push(...conditions); },
      availability: availability.availability,
    });

    expect(await requestEvents(client)).toEqual([{ kind: "text_delta", text: "fallback", blockKey: "b1" }]);
    expect(built).toEqual(["chatgpt", "openai_api"]);
    expect(observed).toEqual([condition]);
    expect(availability.serviceEntryCount()).toBe(0);
  });

  test("an HTTP authentication rejection stops without advancing or inventing an outage", async () => {
    const built: AccessProviderId[] = [];
    const availability = fakeAvailability({});
    const authError = Object.assign(new Error("invalid credential"), { status: 401 });
    const client = chain({
      build: async (provider) => {
        built.push(provider);
        return fakeClient(provider, provider === "chatgpt" ? throwingStream(authError) : textStream("fallback"));
      },
      availability: availability.availability,
    });

    const thrown = await requestEvents(client).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(ProviderAttemptFailure);
    if (!(thrown instanceof ProviderAttemptFailure)) throw new Error("expected an attempt failure");
    expect(thrown.failure._tag).toBe("AuthFailure");
    expect(built).toEqual(["chatgpt"]);
    expect(availability.serviceEntryCount()).toBe(0);
  });

  test("a status-less ChatGPT account failure stops without an outage mark", async () => {
    let authError: unknown;
    try {
      assertChatGptAccountUnchanged(
        { accessToken: Redacted.make("a"), refreshToken: Redacted.make("r-a"), expiresAtMs: 1, accountId: "account-a" },
        { accessToken: Redacted.make("b"), refreshToken: Redacted.make("r-b"), expiresAtMs: 1, accountId: "account-b" },
      );
    } catch (error) {
      authError = error;
    }
    if (!(authError instanceof Error)) throw new Error("expected an account error");
    const accountError = authError;
    const built: AccessProviderId[] = [];
    const availability = fakeAvailability({});
    const client = chain({
      build: async (provider) => {
        built.push(provider);
        return fakeClient(provider, provider === "chatgpt" ? throwingStream(accountError) : textStream("fallback"));
      },
      availability: availability.availability,
    });

    await expect(requestEvents(client)).rejects.toBeInstanceOf(ProviderAttemptFailure);
    expect(built).toEqual(["chatgpt"]);
    expect(availability.serviceEntryCount()).toBe(0);
  });

  test("an adapter that cannot authenticate while it is built stops the request the same way", async () => {
    const built: AccessProviderId[] = [];
    const availability = fakeAvailability({});
    const client = chain({
      build: async (provider) => {
        built.push(provider);
        if (provider === "chatgpt") throw normalizeProviderAttemptFailure(Object.assign(new Error("token refresh rejected"), { status: 401 }));
        return fakeClient(provider, textStream("fallback"));
      },
      availability: availability.availability,
    });

    await expect(requestEvents(client)).rejects.toBeInstanceOf(ProviderAttemptFailure);
    expect(built).toEqual(["chatgpt"]);
    expect(availability.serviceEntryCount()).toBe(0);
  });

  test("an adapter whose account is spent while it is built hands the request on", async () => {
    const built: AccessProviderId[] = [];
    const availability = fakeAvailability({});
    const client = chain({
      build: async (provider) => {
        built.push(provider);
        if (provider === "chatgpt") throw normalizeProviderAttemptFailure(new QuotaExhaustedError("usage limit reached"));
        return fakeClient(provider, textStream("fallback"));
      },
      availability: availability.availability,
    });

    expect(await requestEvents(client)).toEqual([{ kind: "text_delta", text: "fallback", blockKey: "b1" }]);
    expect(built).toEqual(["chatgpt", "openai_api"]);
  });

  // A program that cannot start fails the same way at every start, so a retry on the candidate only delays the walk.
  test.each(["connect", "request"] as const)("a route that cannot run on this machine at %s hands the request on at once and marks no outage", async (stage) => {
    const availability = fakeAvailability({});
    const sleep = sleepRecorder();
    let attempts = 0;
    const unavailable = () => {
      attempts += 1;
      return new RouteUnavailableError("The Claude engine cannot start.");
    };
    const client = chain({
      build: async (provider) => {
        if (provider !== "chatgpt") return fakeClient(provider, textStream("fallback"));
        return stage === "connect"
          ? { attempt: fakeClient(provider, textStream("unreachable")), connect: () => Promise.reject(normalizeProviderAttemptFailure(unavailable())) }
          : fakeClient(provider, async function* () { throw unavailable(); });
      },
      availability: availability.availability,
      sleep: sleep.sleep,
    });

    expect(await requestEvents(client)).toEqual([{ kind: "text_delta", text: "fallback", blockKey: "b1" }]);
    expect(attempts).toBe(1);
    expect(sleep.delays).toEqual([]);
    expect(availability.serviceEntryCount()).toBe(0);
  });

  // Only a person installs or repairs the program, so waiting never clears the route: a walk whose only route
  // cannot run fails at once with no wait, whether the route failed while it was built or while it served, and a
  // walk that also met spent routes waits on those alone.
  test.each(["connect", "request"] as const)("a walk whose only route cannot run on this machine at %s ends exhausted with no wait", async (stage) => {
    const unavailable = new RouteUnavailableError("The Claude engine cannot start.");
    const client = chain({
      candidates: ["chatgpt"],
      build: async (provider) => stage === "connect"
        ? { attempt: fakeClient(provider, textStream("unreachable")), connect: () => Promise.reject(normalizeProviderAttemptFailure(unavailable)) }
        : fakeClient(provider, async function* () { throw unavailable; }),
      availability: fakeAvailability({}).availability,
    });
    const error = await requestEvents(client).then(() => undefined, (thrown: unknown) => thrown);
    if (!(error instanceof AllCandidatesExhaustedError)) throw new Error("expected AllCandidatesExhaustedError");
    expect(error.recovery).toEqual({ kind: "none" });
  });

  test("a walk whose other route is spent until a reset waits for that reset", async () => {
    const resetsAtMs = Date.now() + 3_600_000;
    const availability = fakeAvailability({});
    availability.availability.markQuotaExhausted(singletonCandidate("openai_api"), resetsAtMs);
    const client = chain({
      build: async (provider) => ({ attempt: fakeClient(provider, textStream("unreachable")), connect: () => Promise.reject(normalizeProviderAttemptFailure(new RouteUnavailableError("The Claude engine cannot start."))) }),
      availability: availability.availability,
    });
    const error = await requestEvents(client).then(() => undefined, (thrown: unknown) => thrown);
    if (!(error instanceof AllCandidatesExhaustedError)) throw new Error("expected AllCandidatesExhaustedError");
    expect(error.recovery).toEqual({ kind: "at", atMs: resetsAtMs, hold: { kind: "usage_limit", stated: true } });
  });
});
