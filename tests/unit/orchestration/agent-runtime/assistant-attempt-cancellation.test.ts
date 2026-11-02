import { expect, test } from "bun:test";
import { streamAssistantTurn } from "../../../../src/orchestration/agent-runtime/assistant-turn-stream.js";
import { DEFAULT_MODEL_INTERACTION_PROFILE } from "../../../../src/orchestration/agent-runtime/model-interaction-profile.js";
import { chain, fakeAvailability, fakeClient } from "./llm/_provider-chain-harness.js";

for (const localFailure of [false, true]) {
  test(localFailure ? "cancellation does not hide a distinct local event failure" : "cancellation retains partial output without dispatching fallback", async () => {
    const controller = new AbortController();
    const cancellation = new Error("cancelled by caller");
    const callbackError = new Error("local event publication failed");
    const attempts: string[] = [];
    const output: string[] = [];
    const client = chain({
      availability: fakeAvailability({}).availability,
      build: async (provider) => fakeClient(provider, async function* () {
        attempts.push(provider);
        yield { kind: "text_delta", text: "retained", blockKey: "text" };
        controller.signal.throwIfAborted();
        yield { kind: "done", stopReason: "end_turn" };
      }),
    });
    const request = streamAssistantTurn({
      client,
      executionCwd: "/scratch",
      messages: [{ kind: "user", content: "continue" }],
      interactionProfile: DEFAULT_MODEL_INTERACTION_PROFILE,
      reasoningEffort: undefined,
      signal: controller.signal,
      cacheRetention: undefined,
      providerSessionKey: undefined, promptCacheKey: undefined,
      providerOptions: undefined,
      requestAudit: undefined,
      staleMasking: undefined,
      requestContext: undefined,
      turn: 1,
      messageCount: 1,
      estimatedContextTokens: 1,
      onEvent(event) {
        if (event.kind !== "text_delta") return;
        output.push(event.text);
        controller.abort(cancellation);
        if (localFailure) throw callbackError;
      },
    });
    if (localFailure) await expect(request).rejects.toBe(callbackError);
    else await expect(request).rejects.toBe(cancellation);
    expect(output).toEqual(["retained"]);
    expect(attempts).toEqual(["chatgpt"]);
  });
}
