/** The walk's answer to an account that does not grant the model or its extended window: the next candidate, with
 *  no in-place retry and no mark, the refusal recorded for the refusing account, and copy that names the refusal. */
import { describe, expect, test } from "bun:test";
import type { ModelRefusal } from "../../../../../src/infra/auth/provider-model-catalog-store.js";
import type { AccessProviderId } from "../../../../../src/infra/llm/access-provider.js";
import { describeAgentFailure } from "../../../../../src/orchestration/agent-runtime/failure-message.js";
import { toFailureReason } from "../../../../../src/orchestration/agent-runtime/errors.js";
import { AllCandidatesExhaustedError, ModelAccessRefusedError } from "../../../../../src/orchestration/agent-runtime/llm/errors.js";
import { chain, fakeAvailability, fakeClient, requestEvents, served, sleepRecorder, subscriptionCandidate, textStream, throwingStream } from "./_provider-chain-harness.js";

describe("a refused model in the failover walk", () => {
  test("a refused model hands the request to the next candidate at once and records the refusal for the refusing account only", async () => {
    const availability = fakeAvailability({});
    const sleep = sleepRecorder();
    const recorded: { provider: AccessProviderId; refusal: ModelRefusal }[] = [];
    const refusal: ModelRefusal = { kind: "extended-context", contextLimit: 200_000 };
    const client = chain({
      availability: availability.availability,
      sleep: sleep.sleep,
      recordModelRefusal: (attribution, refused) => { recorded.push({ provider: attribution.candidate.providerId, refusal: refused }); },
      build: async (provider) => fakeClient(provider, provider === "chatgpt"
        ? throwingStream(new ModelAccessRefusedError("Extra usage is required for long context requests.", refusal))
        : textStream(provider)),
    });
    expect(await served(client)).toBe("openai_api");
    expect(recorded).toEqual([{ provider: "chatgpt", refusal }]);
    expect(sleep.delays).toEqual([]);
    expect(availability.availability.serviceStanding("chatgpt").kind).toBe("live");
    expect(availability.availability.chatGptStanding(subscriptionCandidate("chatgpt")).kind).toBe("live");
  });

  test.each([
    { refusal: { kind: "model" } as const, title: "Model not available", guidance: "Switch models with /model" },
    { refusal: { kind: "extended-context", contextLimit: 200_000 } as const, title: "Extended context not available", guidance: "Send a message to continue" },
  ])("a refusal by every candidate ends with model-access copy, not a rate limit ($title)", async ({ refusal, title, guidance }) => {
    const client = chain({
      availability: fakeAvailability({}).availability,
      build: async (provider) => fakeClient(provider, throwingStream(Object.assign(new ModelAccessRefusedError("429 Extra usage is required for long context requests.", refusal), { status: 429 }))),
    });
    const error = await requestEvents(client).then(() => { throw new Error("expected the request to reject") }, (thrown: unknown) => thrown);
    if (!(error instanceof AllCandidatesExhaustedError)) throw new Error("expected AllCandidatesExhaustedError");
    const copy = describeAgentFailure(toFailureReason(error));
    expect(copy.title).toBe(title);
    expect(copy.guidance).toContain(guidance);
    expect(copy.guidance).not.toContain("retry");
  });
});
