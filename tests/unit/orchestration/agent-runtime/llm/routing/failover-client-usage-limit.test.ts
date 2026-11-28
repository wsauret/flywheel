/** A request whose service states that one account spent the request's model until a reset: the walk's record of it,
 *  what the account still serves, and what the request ends with when every account spent the model. */

import { describe, expect, test } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { classifyAnthropicError } from "../../../../../../src/orchestration/agent-runtime/llm/adapters/anthropic/anthropic-adapter-helpers.js";
import { AllCandidatesExhaustedError } from "../../../../../../src/orchestration/agent-runtime/llm/errors.js";
import { createProviderAvailability } from "../../../../../../src/orchestration/agent-runtime/llm/routing/provider-availability.js";
import { toFailureReason } from "../../../../../../src/orchestration/agent-runtime/runner/errors.js";
import { chain, fakeClient, requestEvents, sleepRecorder, subscriptionCandidate, textDelta, textStream, throwingStream } from "../_provider-chain-harness.js";

describe("a spent model window on one account", () => {
  // The answer observed when one account spent the weekly window of one model: a 429 whose retry-after is the reset.
  const WEEKLY_RETRY_AFTER_S = 278_946;
  const spentWindow = () => classifyAnthropicError(Anthropic.APIError.generate(429,
    { type: "error", error: { type: "rate_limit_error", message: "This request would exceed your account's rate limit. Please try again later." } },
    undefined, new Headers({ "retry-after": String(WEEKLY_RETRY_AFTER_S) })));
  const loginA = subscriptionCandidate("claude_agent_sdk", "login-a");
  const loginB = subscriptionCandidate("claude_agent_sdk", "login-b");
  /** One chain of `model` on both logins, on the shared owner, whose login A has spent `spentOnA`. `attempts` names
   *  each stream that a login started, and `sleep` records each in-place retry's wait. */
  const modelChain = (owner: ReturnType<typeof createProviderAvailability>, model: string, spentOnA: string, attempts: string[], sleep = sleepRecorder()) => chain({
    model,
    family: "anthropic",
    candidates: [loginA, loginB],
    availability: owner.forCandidates("profile", [loginA, loginB], () => [model]),
    sleep: sleep.sleep,
    build: async (provider, attribution) => {
      const login = attribution.candidate.kind === "subscription" ? attribution.candidate.instanceId : provider;
      const stream = model === spentOnA && login === "login-a" ? throwingStream(spentWindow()) : textStream(login);
      return fakeClient(provider, () => {
        attempts.push(`${model}@${login}`);
        return stream();
      });
    },
  });

  test("a 429 whose retry-after states a reset days away spends that model on that account until the reset: the request moves to the next account at once, the account keeps serving its other models, and no provider outage results", async () => {
    const owner = createProviderAvailability();
    const attempts: string[] = [];
    const sleep = sleepRecorder();
    const before = Date.now();
    expect(await requestEvents(modelChain(owner, "fable", "fable", attempts, sleep))).toEqual([textDelta("login-b")]);
    const after = Date.now();
    // No in-place retry: retrying cannot clear a spent window.
    expect(attempts).toEqual(["fable@login-a", "fable@login-b"]);
    expect(sleep.delays).toEqual([]);

    const fable = owner.forCandidates("profile", [loginA], () => ["fable"]);
    const standing = fable.genericQuotaStanding(loginA, "fable");
    expect(standing).toMatchObject({ kind: "suppressed", exhaustion: { hold: { kind: "usage_limit", stated: true } } });
    if (standing.kind !== "suppressed") throw new Error("expected a suppression");
    expect(standing.exhaustion.resetsAtMs).toBeGreaterThanOrEqual(before + WEEKLY_RETRY_AFTER_S * 1000);
    expect(standing.exhaustion.resetsAtMs).toBeLessThanOrEqual(after + WEEKLY_RETRY_AFTER_S * 1000);
    expect(fable.genericQuotaStanding(loginA).kind).toBe("live");
    expect(fable.serviceStanding("claude_agent_sdk").kind).toBe("live");

    // The next Fable request passes login A, and Opus still serves on it.
    expect(await requestEvents(modelChain(owner, "fable", "fable", attempts))).toEqual([textDelta("login-b")]);
    expect(await requestEvents(modelChain(owner, "opus", "fable", attempts))).toEqual([textDelta("login-a")]);
    expect(attempts).toEqual(["fable@login-a", "fable@login-b", "fable@login-b", "opus@login-a"]);
  });

  test("when every account spent the model, the request ends as a spent limit with the earliest stated reset, which the agent's failure carries as its known-reset recovery", async () => {
    const owner = createProviderAvailability();
    const built: string[] = [];
    const spentEverywhere = chain({
      model: "fable",
      family: "anthropic",
      candidates: [loginA, loginB],
      availability: owner.forCandidates("profile", [loginA, loginB], () => ["fable"]),
      build: async (provider, attribution) => {
        built.push(attribution.candidate.kind === "subscription" ? attribution.candidate.instanceId : provider);
        return fakeClient(provider, throwingStream(spentWindow()));
      },
    });
    const before = Date.now();
    const error = await requestEvents(spentEverywhere).then(() => { throw new Error("expected the request to reject") }, (thrown: unknown) => thrown);
    expect(built).toEqual(["login-a", "login-b"]);
    expect(error).toBeInstanceOf(AllCandidatesExhaustedError);
    if (!(error instanceof AllCandidatesExhaustedError)) return;
    expect(error.unserved).toEqual({ model: "fable", reason: "spent" });
    expect(error.recovery).toMatchObject({ kind: "at", hold: { kind: "usage_limit", stated: true } });
    if (error.recovery.kind !== "at") return;
    expect(error.recovery.atMs).toBeGreaterThanOrEqual(before + WEEKLY_RETRY_AFTER_S * 1000);
    expect(error.recovery.atMs).toBeLessThan(before + WEEKLY_RETRY_AFTER_S * 1000 + 60_000);
    // The agent's recovery waits for that reset (`unattended-recovery.ts` waits on a stated usage limit).
    expect(toFailureReason(error)).toMatchObject({ kind: "api_error", recovery: { kind: "at", atMs: error.recovery.atMs, hold: { kind: "usage_limit", stated: true } }, unserved: { model: "fable", reason: "spent" } });
    expect(owner.forCandidates("profile", [loginA]).serviceStanding("claude_agent_sdk").kind).toBe("live");
  });
});
