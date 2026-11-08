import { describe, expect, spyOn, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Log } from "../../../../../src/infra/log.js";
import type { ModelInfo } from "../../../../../src/infra/llm/models.js";
import { streamAssistantTurn } from "../../../../../src/orchestration/agent-runtime/assistant-turn-stream.js";
import { DEFAULT_MODEL_INTERACTION_PROFILE } from "../../../../../src/orchestration/agent-runtime/model-interaction-profile.js";
import { asModelClient, fakeAttempt } from "../_model-client.js";
import { IMAGE_REMOVED } from "../../../../../src/orchestration/agent-runtime/llm/image-limit.js";
import { prepareOpenAICompletionsRequest } from "../../../../../src/orchestration/agent-runtime/llm/openai-completions.js";
import { applyHistoryLowering, lowerProviderHistory, planHistoryLowering, type ProviderHistoryTarget } from "../../../../../src/orchestration/agent-runtime/llm/provider-history.js";
import { stableSystemPrompt } from "../../../../../src/orchestration/agent-runtime/llm/system-prompt-tiers.js";
import type { ConversationMessage } from "../../../../../src/orchestration/agent-runtime/llm/types.js";

const UPSTREAM_MODEL_REQUEST = resolve("inspiration/opencode/packages/core/src/session/model-request.ts");
const NOTE_REPLACEMENT = ["to reduce the request size", "to stay within the model's image limit"] as const;

const limited: ProviderHistoryTarget = { accessProvider: "openrouter", provider: "openai", api: "openai-responses", model: "deepseek-v4.1-flash", sharedHost: false };
const unlimited: ProviderHistoryTarget = { ...limited, model: "gpt-test" };

/** `count` screenshots in history order: every third one a user attachment, the rest tool results. */
function screenshots(count: number): ConversationMessage[] {
  return Array.from({ length: count }, (_, index): ConversationMessage[] => {
    const image = { type: "image" as const, mediaType: "image/png", data: `image-${index}` };
    if (index % 3 === 0) return [{ kind: "user", content: [{ type: "text", text: `look ${index}` }, image] }];
    return [
      { kind: "assistant", content: [{ type: "tool_use", id: `call-${index}`, name: "screenshot", input: {} }] },
      { kind: "toolResult", toolUseId: `call-${index}`, content: [{ type: "text", text: `shot ${index}` }, image] },
    ];
  }).flat();
}

function keptImages(history: readonly ConversationMessage[]): string[] {
  return history.flatMap((message) => message.kind === "user" || message.kind === "toolResult"
    ? typeof message.content === "string" ? [] : message.content.flatMap((part) => part.type === "image" ? [part.data] : [])
    : []);
}

function notes(history: readonly ConversationMessage[]): number {
  return JSON.stringify(history).split(IMAGE_REMOVED).length - 1;
}

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, index) => `image-${from + index}`);

describe("replayed images past the model's image limit", () => {
  test("a history at the limit is not edited", () => {
    expect(planHistoryLowering(screenshots(30), limited)).toEqual([]);
  });

  test("passing the limit replaces the oldest images down to half the limit, user attachments and tool results alike", () => {
    const lowered = lowerProviderHistory(screenshots(31), limited);
    expect(keptImages(lowered)).toEqual(range(16, 31));
    expect(notes(lowered)).toBe(16);
    // The note takes the image's place, so each message keeps its role, its pairing, and its other blocks.
    expect(lowered.map((message) => message.kind)).toEqual(lowerProviderHistory(screenshots(31), unlimited).map((message) => message.kind));
    expect(lowered[0]).toEqual({ kind: "user", content: [{ type: "text", text: "look 0" }, { type: "text", text: IMAGE_REMOVED }] });
    expect(lowered[2]).toEqual({ kind: "toolResult", toolUseId: "call-1", content: [{ type: "text", text: "shot 1" }, { type: "text", text: IMAGE_REMOVED }] });
  });

  test("later images keep the same replaced prefix until the limit is passed again, which moves the cut", () => {
    const prefix = lowerProviderHistory(screenshots(31), limited);
    for (let count = 32; count <= 46; count++) {
      const lowered = lowerProviderHistory(screenshots(count), limited);
      expect(lowered.slice(0, prefix.length)).toEqual(prefix);
      expect(notes(lowered)).toBe(16);
    }
    const moved = lowerProviderHistory(screenshots(47), limited);
    expect(keptImages(moved)).toEqual(range(32, 47));
    expect(notes(moved)).toBe(32);
  });

  test("the recorded edits rebuild the same provider history, and lowering it again changes nothing", () => {
    const history = screenshots(40);
    const edits = planHistoryLowering(history, limited);
    expect(edits).toHaveLength(16);
    expect(new Set(edits.map((edit) => edit.reason))).toEqual(new Set(["image-limit"]));
    const lowered = lowerProviderHistory(history, limited);
    expect(lowerProviderHistory(applyHistoryLowering(history, edits), limited)).toEqual(lowered);
    expect(planHistoryLowering(lowered, limited)).toEqual([]);
  });

  test("a model without a limit replays every image", () => {
    const history = screenshots(45);
    expect(planHistoryLowering(history, unlimited)).toEqual([]);
    expect(keptImages(lowerProviderHistory(history, unlimited))).toEqual(range(0, 45));
  });

  test("the DeepSeek V4.1 Flash request carries at most 30 images and leaves the stored history unchanged", () => {
    const messages = screenshots(40);
    const stored = structuredClone(messages);
    const info: ModelInfo = {
      provider: "openrouter", family: "openai", id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash",
      reasoning: false, toolCall: true, attachment: true, temperature: true, openWeights: true,
      cost: { input: 0, output: 0 }, pricing: { status: "unavailable", reason: "missing-rate-card" },
      modalities: { input: ["text", "image"], output: ["text"] }, contextLimit: 1_000_000, outputLimit: 4_000,
    };
    const { params } = prepareOpenAICompletionsRequest({
      accessProvider: "openrouter", model: "deepseek-v4.1-flash", wireModel: "deepseek/deepseek-v4.1-flash", info,
      options: { messages, tools: [], systemPrompt: stableSystemPrompt("system"), cacheRetention: "none" },
    });
    const imageParts = params.messages.flatMap((message) => Array.isArray(message.content) ? message.content.filter((part) => part.type === "image_url") : []);
    expect(imageParts.length).toBe(24);
    expect(messages).toEqual(stored);
  });

  test("each bounded request records at DEBUG, and only a move of the cut records at INFO, once across retries", async () => {
    const logger = Log.create({ service: "assistant-turn-stream" });
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    const info = spyOn(logger, "info").mockImplementation(() => {});
    try {
      const client = asModelClient({
        ...fakeAttempt("openrouter", "deepseek-v4.1-flash"),
        async *streamWithTools() { yield { kind: "done", stopReason: "end_turn" } as const; },
      });
      const imageLimitCut = { replaced: 0 };
      const send = (messages: ConversationMessage[]) => streamAssistantTurn({
        client, executionCwd: "/scratch", interactionProfile: DEFAULT_MODEL_INTERACTION_PROFILE,
        messages, tools: [], systemPrompt: stableSystemPrompt("system"),
        reasoningEffort: undefined, signal: undefined, cacheRetention: undefined,
        providerSessionKey: undefined, promptCacheKey: undefined, providerOptions: undefined, requestAudit: undefined,
        staleMasking: undefined, requestContext: undefined, turn: 1, imageLimitCut, messageCount: messages.length,
        estimatedContextTokens: 0, onEvent: () => {},
      });
      // A retry sends the same history again; a later request keeps the cut steady.
      await send(screenshots(31));
      await send(screenshots(31));
      await send(screenshots(32));
      await send(screenshots(47));
      const bounded = debug.mock.calls.filter(([message]) => message === "image limit bounded request");
      expect(bounded.map(([, fields]) => fields?.replaced)).toEqual([16, 16, 16, 32]);
      expect(info.mock.calls).toEqual([
        ["image limit cut moved", { turn: 1, model: "deepseek-v4.1-flash", limit: 30, images: 31, replaced: 16, previouslyReplaced: 0 }],
        ["image limit cut moved", { turn: 1, model: "deepseek-v4.1-flash", limit: 30, images: 47, replaced: 32, previouslyReplaced: 16 }],
      ]);
    } finally {
      debug.mockRestore();
      info.mockRestore();
    }
  });

  test.skipIf(!existsSync(UPSTREAM_MODEL_REQUEST))("the note is the upstream IMAGE_REMOVED text with only the recorded replacement", () => {
    const upstream = readFileSync(UPSTREAM_MODEL_REQUEST, "utf8").match(/const IMAGE_REMOVED =\s*"([^"]*)"/)?.[1];
    const [from, to] = NOTE_REPLACEMENT;
    expect(upstream?.split(from)).toHaveLength(2);
    expect(IMAGE_REMOVED).toBe(upstream?.replace(from, to) ?? "");
  });
});
