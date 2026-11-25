import { beforeAll, describe, expect, spyOn, test } from "bun:test";

import { prepareLocalTokenizer } from "../../../../../src/infra/providers/local-tokenizer.js";
import {
  createTokenEstimationCache,
  estimateConversationTokens,
  imageTokensForModel,
  tokenCountingPolicy,
} from "../../../../../src/orchestration/agent-runtime/compaction/token-counter.js";
import { createStaleToolResultMasker } from "../../../../../src/orchestration/agent-runtime/compaction/stale-tool-result-masker.js";
import type { ConversationMessage } from "../../../../../src/orchestration/agent-runtime/llm/types.js";

const IMAGE_TOKEN_ESTIMATE = imageTokensForModel("anthropic");
/** The character heuristic of a model with no local tokenizer. */
const HEURISTIC = tokenCountingPolicy("unmapped-model", "anthropic");

beforeAll(async () => {
  await prepareLocalTokenizer();
});

describe("token estimation", () => {
  test("the estimate for a history equals the sum of per-message estimates under one policy, as before", () => {
    const history: ConversationMessage[] = [
      { kind: "user", content: "abcd" }, // 4 chars -> 1 token
      { kind: "assistant", content: "efghijkl" }, // 8 chars -> 2 tokens
      { kind: "toolResult", toolUseId: "tool", content: [{ type: "text", text: "mnopqrstuvwx" }] }, // 12 chars -> 3 tokens
    ];
    expect(estimateConversationTokens(history, HEURISTIC)).toBe(6);
    for (const policy of [HEURISTIC, tokenCountingPolicy("gpt-5.4", "openai")]) {
      const perMessage = history.reduce((total, message) => total + estimateConversationTokens([message], policy), 0);
      expect(estimateConversationTokens(history, policy, createTokenEstimationCache())).toBe(perMessage);
    }
  });

  test("caches immutable message costs across appends and recalculates replaced or masked messages", () => {
    const oldInput = { path: "output.txt", content: "x".repeat(200) };
    const oldMessage: ConversationMessage = {
      kind: "assistant",
      content: [{ type: "tool_use", id: "old", name: "write", input: oldInput }],
    };
    const appended: ConversationMessage = { kind: "user", content: "next turn" };
    const stringify = JSON.stringify;
    let oldInputCalls = 0;
    const stringifySpy = spyOn(JSON, "stringify").mockImplementation((value) => {
      if (value === oldInput) oldInputCalls++;
      return stringify(value);
    });

    try {
      const cache = createTokenEstimationCache();
      const oldTotal = estimateConversationTokens([oldMessage], HEURISTIC, cache);
      const appendedTotal = estimateConversationTokens([oldMessage, appended], HEURISTIC, cache);
      expect(oldInputCalls).toBe(1);
      expect(appendedTotal).toBe(oldTotal + Math.ceil("next turn".length / 4));

      const replacement = structuredClone(oldMessage);
      expect(estimateConversationTokens([replacement, appended], HEURISTIC, cache)).toBe(appendedTotal);
      expect(oldInputCalls).toBe(1);

      const masked = createStaleToolResultMasker({ cutoffIndex: 1, zone: 0 }).mask([oldMessage, appended], 0.3);
      expect(masked).not.toBeNull();
      expect(estimateConversationTokens(masked!.messages, HEURISTIC, cache)).toBe(estimateConversationTokens(masked!.messages, HEURISTIC));
    } finally {
      stringifySpy.mockRestore();
    }
  });

  test("a tool result image part costs exactly IMAGE_TOKEN_ESTIMATE regardless of base64 length", () => {
    const longData = "A".repeat(100_000);
    expect(estimateConversationTokens([
      { kind: "toolResult", toolUseId: "tool", content: [{ type: "image", mediaType: "image/png", data: longData }] },
    ], HEURISTIC)).toBe(IMAGE_TOKEN_ESTIMATE);
  });

  test("a tool result with mixed parts sums text chars and image estimate", () => {
    expect(estimateConversationTokens([{ kind: "toolResult", toolUseId: "tool", content: [
      { type: "text", text: "abcdefgh" }, // 8 chars -> contributes 8 chars
      { type: "image", mediaType: "image/png", data: "Z".repeat(50_000) }, // contributes IMAGE_TOKEN_ESTIMATE * 4 chars
    ] }], HEURISTIC)).toBe(Math.ceil((8 + IMAGE_TOKEN_ESTIMATE * 4) / 4));
  });

  test("counts inline image blocks at the provider image policy regardless of base64 length", () => {
    const imageData = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYA"; // 36 chars
    expect(estimateConversationTokens([{
      kind: "user",
      content: [{ type: "image", mediaType: "image/png", data: imageData }],
    }], HEURISTIC)).toBe(IMAGE_TOKEN_ESTIMATE);
  });

  test("identifies mapped local tokenizers and preserves the exact heuristic fallback", () => {
    const local = tokenCountingPolicy("gpt-5.4", "openai");
    const heuristic = tokenCountingPolicy("unmapped-model", "openai");

    expect(local.identity).toBe("local:O200kBase");
    expect(heuristic.identity).toBe("heuristic:openai");
    expect(heuristic.countText("12345")).toBe(2);
  });

  test("uses one catalog-resolved Claude identity for text while retaining the serving family's image cost", () => {
    const copilot = tokenCountingPolicy("claude-fable-5.1", "anthropic", "ClaudeV5");
    const direct = tokenCountingPolicy("claude-fable-5.1", "anthropic", "ClaudeV5");
    const alternateFamily = tokenCountingPolicy("claude-fable-5.1", "openai", "ClaudeV5");

    expect(copilot.identity).toBe("local:ClaudeV5");
    expect(direct.countText("A stable canonical request")).toBe(copilot.countText("A stable canonical request"));
    expect(alternateFamily.identity).toBe(copilot.identity);
    expect(alternateFamily.imageTokens).toBe(imageTokensForModel("openai"));
    expect(copilot.imageTokens).toBe(imageTokensForModel("anthropic"));
    // Chat Completions keeps the image estimate that it had as part of the openai family.
    expect(tokenCountingPolicy("claude-fable-5.1", "chat-completions", "ClaudeV5").imageTokens).toBe(imageTokensForModel("openai"));
  });

  test("counts replayed thinking text locally while excluding opaque reasoning", () => {
    const policy = tokenCountingPolicy("gpt-5.4", "openai");
    const semanticText = "The tokenizer counts this semantic sentence.";
    const message: ConversationMessage = {
      kind: "assistant",
      content: [
        { type: "text", text: semanticText },
        { type: "thinking", thinking: "opaque chain of thought" },
        { type: "reasoning", id: "reasoning", encrypted_content: "opaque transport bytes" },
      ],
    };

    expect(estimateConversationTokens([message], policy)).toBe(policy.countText(semanticText) + policy.countText("opaque chain of thought"));
  });

  test("another model's thinking counts only as the progress updates that its request sends as text", () => {
    const thought = "a long private deliberation ".repeat(40);
    const message: ConversationMessage = {
      kind: "assistant", accessProvider: "anthropic_api", provider: "anthropic", api: "anthropic-messages", model: "claude-sonnet-5-5", timestamp: 1,
      content: [{ type: "thinking", thinking: thought, signature: "sig" }, { type: "thinking", thinking: "Checking.", signature: "sig", presentation: "progress" }, { type: "text", text: "Done." }],
    };
    const progressOnly: ConversationMessage = { kind: "assistant", content: [{ type: "thinking", thinking: "Checking.", signature: "sig", presentation: "progress" }, { type: "text", text: "Done." }] };
    const own = tokenCountingPolicy("claude-sonnet-5-5", "anthropic", "ClaudeV5Sonnet", { accessProvider: "anthropic_api", model: "claude-sonnet-5-5" });
    const other = tokenCountingPolicy("gpt-5.4", "openai", undefined, { accessProvider: "openai_api", model: "gpt-5.4" });
    const cache = createTokenEstimationCache();
    expect(estimateConversationTokens([message], other, cache)).toBe(estimateConversationTokens([progressOnly], other));
    // One cache serves both requests, and each reads its own count.
    expect(estimateConversationTokens([message], own, cache)).toBeGreaterThan(estimateConversationTokens([message], other, cache));
  });

  test("a turn that the lowering joins to an incomplete fragment counts none of its deliberation, even from the same model", () => {
    const provenance = { accessProvider: "anthropic_api", provider: "anthropic", api: "anthropic-messages", model: "claude-sonnet-5-5", timestamp: 1 } as const;
    const policy = tokenCountingPolicy("claude-sonnet-5-5", "anthropic", "ClaudeV5Sonnet", { accessProvider: "anthropic_api", model: "claude-sonnet-5-5" });
    const fragment: ConversationMessage = { kind: "assistant", ...provenance, incomplete: true, content: [{ type: "text", text: "part" }] };
    const completed: ConversationMessage = { kind: "assistant", ...provenance, reasoningTokens: 1_000, content: [{ type: "thinking", thinking: "a long private deliberation ".repeat(40), signature: "sig" }, { type: "text", text: "done" }] };
    const history = (answer: ConversationMessage): ConversationMessage[] => [{ kind: "user", content: "hi" }, fragment, answer, { kind: "user", content: "next" }];
    const withoutDeliberation: ConversationMessage = { kind: "assistant", ...provenance, content: [{ type: "text", text: "done" }] };
    const cache = createTokenEstimationCache();
    // The same message alone replays its deliberation, so one cache keeps both counts apart.
    expect(estimateConversationTokens([completed], policy, cache)).toBeGreaterThan(estimateConversationTokens([withoutDeliberation], policy));
    expect(estimateConversationTokens(history(completed), policy, cache)).toBe(estimateConversationTokens(history(withoutDeliberation), policy));
  });

  test("counts a response's reported reasoning tokens where its replayed thinking hides them", () => {
    const provenance = { accessProvider: "anthropic_api", provider: "anthropic", api: "anthropic-messages", model: "claude-sonnet-5-5" } as const;
    const replaying = tokenCountingPolicy("claude-sonnet-5-5", "anthropic", "ClaudeV5Sonnet", { accessProvider: "anthropic_api", model: "claude-sonnet-5-5" });
    const toolUse = { type: "tool_use", id: "tool", name: "record_answer", input: { answer: "42" } } as const;
    // Redacted thinking arrives with no text and only a signature, so its text counts nothing.
    const visible: ConversationMessage = { kind: "assistant", ...provenance, content: [{ type: "thinking", thinking: "", signature: "sig" }, toolUse] };
    const reported: ConversationMessage = { ...visible, reasoningTokens: 4_716 };
    const visibleTokens = estimateConversationTokens([visible], replaying);

    expect(estimateConversationTokens([reported], replaying)).toBe(visibleTokens + 4_716);
    // Another model or access provider receives the thinking as text, not as the opaque replay.
    expect(estimateConversationTokens([reported], tokenCountingPolicy("claude-opus-5-5", "anthropic", "ClaudeV5", { accessProvider: "anthropic_api", model: "claude-opus-5-5" }))).toBe(
      estimateConversationTokens([visible], tokenCountingPolicy("claude-opus-5-5", "anthropic", "ClaudeV5", { accessProvider: "anthropic_api", model: "claude-opus-5-5" })),
    );
    expect(estimateConversationTokens([reported], tokenCountingPolicy("claude-sonnet-5-5", "anthropic", "ClaudeV5Sonnet", { accessProvider: "github_copilot", model: "claude-sonnet-5-5" }))).toBe(visibleTokens);
    // A message whose reasoning blocks were not kept re-sends no reasoning.
    expect(estimateConversationTokens([{ ...reported, content: [toolUse] }], replaying)).toBe(
      estimateConversationTokens([{ ...visible, content: [toolUse] }], replaying),
    );
    // Visible thinking text that the report covers counts once.
    const readable: ConversationMessage = { ...visible, content: [{ type: "thinking", thinking: "a readable chain", signature: "sig" }, toolUse] };
    expect(estimateConversationTokens([{ ...readable, reasoningTokens: 1 }], replaying)).toBe(estimateConversationTokens([readable], replaying));
    // One shared estimation cache keeps the replayed and the downgraded counts apart.
    const cache = createTokenEstimationCache();
    expect(estimateConversationTokens([reported], replaying, cache)).toBe(visibleTokens + 4_716);
    expect(estimateConversationTokens([reported], tokenCountingPolicy("claude-sonnet-5-5", "anthropic", "ClaudeV5Sonnet", { accessProvider: "github_copilot", model: "claude-sonnet-5-5" }), cache)).toBe(visibleTokens);
  });

  // Remove with the conversion of Chat Completions turns stamped as OpenAI Responses turns after 2027-05-20.
  test("counts the reported reasoning of a Chat Completions turn that an earlier build stamped as an OpenAI Responses turn only when it names its access provider", () => {
    const policy = tokenCountingPolicy("deepseek-v4", "chat-completions", undefined, { accessProvider: "deepseek", model: "deepseek-v4" });
    const toolUse = { type: "tool_use", id: "tool", name: "record_answer", input: { answer: "42" } } as const;
    const visible: ConversationMessage = { kind: "assistant", accessProvider: "deepseek", provider: "openai", api: "openai-responses", model: "deepseek-v4", content: [{ type: "thinking", thinking: "", signature: "reasoning_content" }, toolUse] };
    const { accessProvider: _accessProvider, ...unattributed } = visible;

    expect(estimateConversationTokens([{ ...visible, reasoningTokens: 1_000 }], policy)).toBe(estimateConversationTokens([visible], policy) + 1_000);
    expect(estimateConversationTokens([{ ...unattributed, reasoningTokens: 1_000 }], policy)).toBe(estimateConversationTokens([unattributed], policy));
  });

  test("counts reported reasoning in the current turn always and in earlier turns only for a model that keeps them", () => {
    const toolUse = { type: "tool_use", id: "tool", name: "record_answer", input: { answer: "42" } } as const;
    const request: ConversationMessage = { kind: "user", content: "think it through" };
    const result: ConversationMessage = { kind: "toolResult", toolUseId: "tool", content: [{ type: "text", text: "recorded" }] };
    const cases = [
      // Measured with count_tokens: Claude Haiku 4.5 drops thinking from an earlier turn unread, Claude Sonnet 5.5 keeps it.
      { model: "claude-haiku-4-5", tokenizer: "ClaudeV3", reported: 19_395, keepsEarlier: false },
      { model: "claude-sonnet-5-5", tokenizer: "ClaudeV5Sonnet", reported: 4_716, keepsEarlier: true },
    ] as const;
    for (const { model, tokenizer, reported, keepsEarlier } of cases) {
      const policy = tokenCountingPolicy(model, "anthropic", tokenizer, { accessProvider: "anthropic_api", model });
      const plain: ConversationMessage = { kind: "assistant", accessProvider: "anthropic_api", provider: "anthropic", api: "anthropic-messages", model, content: [{ type: "thinking", thinking: "", signature: "sig" }, toolUse] };
      const counted: ConversationMessage = { ...plain, reasoningTokens: reported };
      const reply: ConversationMessage = { kind: "assistant", accessProvider: "anthropic_api", provider: "anthropic", api: "anthropic-messages", model, content: "done" };
      // What the thinking block adds over the same response without it.
      const thinking = (history: (message: ConversationMessage) => ConversationMessage[], answer = counted) =>
        estimateConversationTokens(history(answer), policy) - estimateConversationTokens(history({ ...plain, content: [toolUse] }), policy);
      const visibleOnly = thinking((answer) => [answer], plain);

      // The tool loop of the current turn re-sends the thinking to every model.
      expect(thinking((answer) => [request, answer, result])).toBe(reported);
      // A user message that travels with a tool result continues the same turn.
      expect(thinking((answer) => [request, answer, result, { kind: "user", content: "a note" }])).toBe(reported);
      // A later user message opens a new turn.
      const later = (answer: ConversationMessage): ConversationMessage[] => [request, answer, result, reply, { kind: "user", content: "next" }];
      expect(thinking(later)).toBe(keepsEarlier ? reported : visibleOnly);
      // A shared cache keeps each message's count by its position.
      const cache = createTokenEstimationCache();
      expect(estimateConversationTokens([request, counted, result], policy, cache)).toBe(estimateConversationTokens([request, counted, result], policy));
      expect(estimateConversationTokens(later(counted), policy, cache)).toBe(estimateConversationTokens(later(keepsEarlier ? counted : plain), policy));
    }
  });

  test("preserves the provider heuristic for unmapped model message blocks", () => {
    const policy = tokenCountingPolicy("unmapped-model", "openai");
    const message: ConversationMessage = {
      kind: "assistant",
      content: [
        { type: "text", text: "a" },
        { type: "text", text: "b" },
        { type: "thinking", thinking: "c" },
        { type: "reasoning", id: "reasoning", encrypted_content: "x".repeat(100_000) },
        { type: "image", mediaType: "image/png", data: "opaque" },
        { type: "tool_use", id: "tool", name: "x", input: {} },
      ],
    };

    expect(estimateConversationTokens([message], policy)).toBe(
      Math.ceil((3 + policy.imageTokens * 4 + "x".length + JSON.stringify({}).length) / 4),
    );
  });

  test("reuses message costs by object and policy identity", () => {
    const message: ConversationMessage = { kind: "user", content: "cached text" };
    let calls = 0;
    const cache = createTokenEstimationCache();
    const policy = {
      kind: "local" as const,
      identity: "local:O200kBase" as const,
      imageTokens: 765,
      countText(text: string) {
        calls += 1;
        return Math.ceil(text.length / 4);
      },
    };

    expect(estimateConversationTokens([message], policy, cache)).toBe(3);
    expect(estimateConversationTokens([message], policy, cache)).toBe(3);
    expect(calls).toBe(1);
  });

});

