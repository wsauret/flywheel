/**
 * Integration tests for the agent runtime LLM layer with real API calls.
 * Streams one assistant turn from the live model through the production
 * request path: request admission, the provider chain, and the turn stream
 * that the agent loop and subagent summaries use.
 *
 * Requires the auth profile that FLYWHEEL_LIVE_AUTH_PROFILE names, with an
 * account that can serve the live model; the suite fails, and names what the profile can serve, when
 * none can.
 */
import { describe, it, expect } from "bun:test";
import { streamAssistantTurn } from "../../../src/orchestration/agent-runtime/assistant-turn-stream.js";
import { estimateMessageTokens } from "../../../src/orchestration/agent-runtime/compaction/token-counter.js";
import { stableSystemPrompt } from "../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import { resolveModelInteractionProfile } from "../../../src/orchestration/agent-runtime/model-interaction-profile.js";
import type { ModelClient, ProviderStreamEvent } from "../../../src/orchestration/agent-runtime/llm/types.js";
import { LIVE_MODEL, withLiveClient } from "./_live-client.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const makeDirectory = temporaryDirectories();

/** Streams one tool-free turn and returns every event the turn forwarded.
 *  The provider's terminal `done` event is not forwarded: the turn keeps it
 *  as `terminalEvent`. */
async function streamGreeting(client: ModelClient) {
  const message = { kind: "user" as const, content: "Say exactly: hello world" };
  const events: ProviderStreamEvent[] = [];
  const turn = await streamAssistantTurn({
    client,
    executionCwd: makeDirectory("agent-runtime-llm-real-"),
    interactionProfile: resolveModelInteractionProfile(client.model, client.modelFamily),
    messages: [message],
    tools: [],
    systemPrompt: stableSystemPrompt("Respond in exactly 2 words."),
    reasoningEffort: undefined,
    signal: AbortSignal.timeout(25_000),
    cacheRetention: "none",
    providerSessionKey: `live-${crypto.randomUUID()}`, promptCacheKey: `live-${crypto.randomUUID()}`,
    providerOptions: undefined,
    staleMasking: undefined,
    requestContext: undefined,
    requestAudit: undefined,
    turn: 0,
    messageCount: 1,
    estimatedContextTokens: estimateMessageTokens(message, 0),
    onEvent: (event) => events.push(event),
  });
  const text = events.map((e) => e.kind === "text_delta" ? e.text : "").join("");
  return { turn, events, text };
}

describe(`${LIVE_MODEL} streaming (real API)`, () => {
  it("streams text deltas and usage", async () => {
    const { turn, events, text } = await withLiveClient("streams text deltas and usage", ({ client }) => streamGreeting(client));

    expect(turn.outcome.kind).toBe("ok");
    expect(turn.terminalEvent?.kind).toBe("done");
    expect(events.filter((e) => e.kind === "text_delta").length).toBeGreaterThan(0);
    expect(events.filter((e) => e.kind === "usage").length).toBeGreaterThan(0);
    expect(text.toLowerCase()).toContain("hello");
  }, 30_000);
});
