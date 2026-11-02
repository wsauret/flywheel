import { describe, expect, test } from "bun:test";
import { createHeadlessRunTally } from "../../../../src/orchestration/headless/run-headless-task.js";
import type { ProviderRequestAuditFact } from "../../../../src/orchestration/session/provider-request-audit-facts.js";

function usageFact(requestId: string, turn: number, tokens: { input: number; output: number; cacheRead: number; reasoning: number; cost: number }): ProviderRequestAuditFact {
  return {
    type: "model.usage.recorded",
    version: 1,
    actor: "provider",
    payload: {
      requestId,
      conversationId: "conversation-1",
      turn,
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      cacheReadInputTokens: tokens.cacheRead,
      cacheCreationInputTokens: 0,
      reasoningTokens: tokens.reasoning,
      promptTokens: tokens.input + tokens.cacheRead,
      deltaCostUsd: tokens.cost,
    },
  };
}

function currentUsageFact(requestId: string, attemptId: string, turn: number, tokens: { input: number; output: number; cacheRead: number; reasoning: number }): ProviderRequestAuditFact {
  return {
    type: "model.usage.recorded",
    version: 3,
    actor: "provider",
    payload: {
      requestId,
      attemptId,
      identity: { providerSessionKey: "provider-1", conversationId: "conversation-1" },
      turn,
      inputTokens: tokens.input,
      outputTokens: tokens.output,
      cacheReadInputTokens: tokens.cacheRead,
      cacheCreationInputTokens: 0,
      reasoningTokens: tokens.reasoning,
      promptTokens: tokens.input + tokens.cacheRead,
    },
  };
}

function surfaceFact(requestId: string, turn: number, hash: string, names: readonly string[]): ProviderRequestAuditFact {
  return {
    type: "tool_surface.selected",
    version: 3,
    actor: "flywheel",
    payload: {
      requestId,
      conversationId: "conversation-1",
      turn,
      toolSurfaceHash: hash,
      tools: names.map((name) => ({ name, registrationId: `${name}.native`, executableId: name, description: `${name} tool`, input_schema: {} })),
      omittedTools: [],
    },
  };
}

function dispatchedFact(requestId: string, turn: number): ProviderRequestAuditFact {
  return {
    type: "model.request.dispatched",
    version: 2,
    actor: "provider",
    payload: { requestId, identity: { providerSessionKey: "provider-1", conversationId: "conversation-1" }, turn },
  };
}

describe("headless run tally", () => {
  test("summary usage equals the in-memory accumulation across two model turns", () => {
    const tally = createHeadlessRunTally();

    tally.observe(dispatchedFact("request-1", 1));
    tally.observe(dispatchedFact("request-2", 2));
    tally.observe(usageFact("request-1", 1, { input: 100, output: 25, cacheRead: 50, reasoning: 5, cost: 0.1234561 }));
    tally.observe(usageFact("request-2", 2, { input: 40, output: 10, cacheRead: 20, reasoning: 2, cost: 0.2 }));

    expect(tally.usage()).toEqual({
      requests: 2,
      inputTokens: 140,
      outputTokens: 35,
      cacheReadTokens: 70,
      reasoningTokens: 7,
      costUsd: 0.323456,
    });
  });

  test("joins current v3 tokens to one idempotent canonical cost delta", () => {
    const tally = createHeadlessRunTally();

    tally.observe(dispatchedFact("request-historical", 1));
    tally.observe(dispatchedFact("request-current", 2));
    tally.observe(usageFact("request-historical", 1, { input: 100, output: 25, cacheRead: 50, reasoning: 5, cost: 0.125 }));
    tally.observe(currentUsageFact("request-current", "attempt-current-7", 2, { input: 40, output: 10, cacheRead: 20, reasoning: 2 }));
    const committed = {
      usageEntryId: "attempt-current-7",
      costUsdDelta: 0.2,
      tokens: { input: 40, output: 10, cacheRead: 20, reasoning: 2 },
    };
    tally.observeCommittedUsage(committed);
    tally.observeCommittedUsage(committed);

    expect(tally.usage()).toEqual({
      requests: 2,
      inputTokens: 140,
      outputTokens: 35,
      cacheReadTokens: 70,
      reasoningTokens: 7,
      costUsd: 0.325,
    });
  });

  test("summarizes current committed usage without a duplicate audit callback", () => {
    const tally = createHeadlessRunTally();

    tally.observe(dispatchedFact("request-current-8", 1));
    tally.observeCommittedUsage({
      usageEntryId: "attempt-current-8",
      costUsdDelta: null,
      tokens: { input: 9340, output: 6, cacheRead: 0, reasoning: 0 },
    });

    expect(tally.usage()).toEqual({
      requests: 1,
      inputTokens: 9340,
      outputTokens: 6,
      cacheReadTokens: 0,
      reasoningTokens: 0,
      costUsd: 0,
    });
  });

  test("counts a dispatched request that ended before it measured usage", () => {
    const tally = createHeadlessRunTally();

    tally.observe(dispatchedFact("request-cut", 1));
    tally.observe(dispatchedFact("request-cut", 1));

    expect(tally.usage()).toEqual({
      requests: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: 0,
      costUsd: 0,
    });
  });

  test("preserves ordered distinct selected surfaces with sorted tools", () => {
    const tally = createHeadlessRunTally();

    tally.observe(surfaceFact("request-1", 1, "hash-1", ["write", "bash"]));
    tally.observe(surfaceFact("request-2", 2, "hash-2", ["read", "bash"]));
    tally.observe(surfaceFact("request-3", 3, "hash-1", ["ignored_duplicate_hash"]));

    expect(tally.toolSurfaces()).toEqual([
      { toolSurfaceHash: "hash-1", tools: ["bash", "write"] },
      { toolSurfaceHash: "hash-2", tools: ["bash", "read"] },
    ]);
  });
});
