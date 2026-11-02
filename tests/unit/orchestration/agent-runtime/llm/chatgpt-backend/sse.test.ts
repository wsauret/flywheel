/**
 * Backend wire-frame mapping: error frames with nested payloads.
 *
 * Real ChatGPT backend error frames nest code/message under `error`, and the
 * quota discriminator rides `error.type` with no `code` field at all.
 * Fixture shapes verified against the Codex CLI test suite
 * (`client_websockets.rs:1472-1480,:1642-1648`); extraction adapted from pi
 * `openai-codex-responses.ts:708-719`.
 */

import { describe, expect, it } from "bun:test";
import { ChatGptAdapterApiError, mapChatGptAdapterEvents } from "../../../../../../src/orchestration/agent-runtime/llm/chatgpt-adapter/sse.js";
import { createProviderAvailability, observeChatGptQuotaFrame } from "../../../../../../src/orchestration/agent-runtime/llm/provider-availability.js";
import type { AccessProviderCandidate } from "../../../../../../src/infra/llm/access-provider.js";

interface UnknownRecord {
  [key: string]: unknown;
}
const CHATGPT_CANDIDATE: AccessProviderCandidate = { kind: "subscription", providerId: "chatgpt", instanceId: "chatgpt-account", spendMode: "included" };

async function* frames(events: Array<UnknownRecord>): AsyncGenerator<UnknownRecord> {
  for (const event of events) yield event;
}

async function mapToError(event: UnknownRecord): Promise<ChatGptAdapterApiError> {
  try {
    for await (const _mapped of mapChatGptAdapterEvents(frames([event]))) { /* drain */ }
  } catch (error) {
    if (error instanceof ChatGptAdapterApiError) return error;
    throw error;
  }
  throw new Error("expected the frame to throw");
}

const USAGE_LIMIT_FRAME = {
  type: "error",
  status: 429,
  error: {
    type: "usage_limit_reached",
    message: "The usage limit has been reached",
    plan_type: "pro",
    resets_at: 1_704_067_242,
  },
};

const CONNECTION_LIMIT_FRAME = {
  type: "error",
  status: 400,
  error: {
    type: "invalid_request_error",
    code: "websocket_connection_limit_reached",
    message: "Responses websocket connection limit reached (60 minutes).",
  },
};

describe("mapChatGptAdapterEvents error extraction", () => {
  it("reads the quota discriminator from nested error.type when no code exists", async () => {
    const error = await mapToError(USAGE_LIMIT_FRAME);
    expect(error.code).toBe("usage_limit_reached");
    expect(error.message).toContain("The usage limit has been reached");
  });

  it("prefers nested error.code over the generic error.type", async () => {
    const error = await mapToError(CONNECTION_LIMIT_FRAME);
    expect(error.code).toBe("websocket_connection_limit_reached");
  });

  it("keeps reading legacy top-level code/message frames", async () => {
    const error = await mapToError({ type: "error", code: "usage_limit_reached", message: "limit hit" });
    expect(error.code).toBe("usage_limit_reached");
    expect(error.message).toContain("limit hit");
  });

  it("reads response.failed quota codes from response.error.type", async () => {
    const error = await mapToError({
      type: "response.failed",
      response: { error: { type: "usage_limit_reached", message: "limit hit" } },
    });
    expect(error.code).toBe("usage_limit_reached");
  });
});

describe("observeChatGptQuotaFrame nested payloads", () => {
  it("records exhaustion and resets_at from a nested error frame", () => {
    const availability = createProviderAvailability({ now: () => 1_000 }).forCandidates("default", [CHATGPT_CANDIDATE]);
    observeChatGptQuotaFrame(USAGE_LIMIT_FRAME, CHATGPT_CANDIDATE, availability);
    expect(availability.chatGptStanding(CHATGPT_CANDIDATE)).toMatchObject({
      kind: "suppressed",
      exhaustion: { resetsAtMs: 1_704_067_242_000 },
    });
  });

  it("records nothing for a non-quota nested error", () => {
    const availability = createProviderAvailability({ now: () => 1_000 }).forCandidates("default", [CHATGPT_CANDIDATE]);
    observeChatGptQuotaFrame(CONNECTION_LIMIT_FRAME, CHATGPT_CANDIDATE, availability);
    expect(availability.chatGptStanding(CHATGPT_CANDIDATE)).toEqual({ kind: "live" });
  });

  it("keeps reading the legacy top-level shape", () => {
    const availability = createProviderAvailability({ now: () => 1_000 }).forCandidates("default", [CHATGPT_CANDIDATE]);
    observeChatGptQuotaFrame({ type: "error", code: "usage_limit_reached", resets_at: 99 }, CHATGPT_CANDIDATE, availability);
    expect(availability.chatGptStanding(CHATGPT_CANDIDATE)).toMatchObject({ kind: "suppressed", exhaustion: { resetsAtMs: 99_000 } });
  });
});
