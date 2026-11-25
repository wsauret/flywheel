import { describe, expect, test } from "bun:test";
import type { UsageEntry } from "../../../../../src/infra/providers/llm/usage/usage-entry.js";
import type { AgentFactory } from "../../../../../src/orchestration/agent-runtime/types.js";
import { runHeadlessTask, type HeadlessTaskResult } from "../../../../../src/orchestration/app-service/headless/run-headless-task.js";
import type { ProviderRequestAuditFact } from "../../../../../src/orchestration/session/runtime-facts/provider-request-audit-facts.js";
import { temporaryDirectories, testDirectories } from "../../../../helpers/directories.js";
import { fakeModelsClient } from "../../../../helpers/model-tier-fixtures.js";
import { makeWorkflowDeps } from "./_headless-run-fixtures.js";

const directory = temporaryDirectories();
const launcher = { spawnOwned: async () => { throw new Error("unused"); }, adoptOwned: async () => { throw new Error("unused"); }, open() { return this; }, close: async () => ({ settled: true as const }) };

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

/** One usage entry the run's ledger committed, as the runner reports it to the usage observer. */
function committedUsage(attemptId: string, costUsd: number | null, tokens: { input: number; output: number; cacheRead: number; reasoning: number }): UsageEntry {
  return {
    attemptId, occurredAt: "2026-11-07T00:00:00.000Z", profileId: "default",
    attribution: { kind: "candidate", providerId: "openai_api" }, spendMode: "direct_api",
    credentialLineage: "00000000-0000-4000-8000-000000000000", model: "gpt-5.5", classification: "real_spend",
    coverage: "complete", currency: "USD", tokens: { ...tokens, cacheWrite: 0 },
    price: costUsd === null ? { kind: "unavailable", reason: "fixture" } : { kind: "priced", estimatedUsd: costUsd, rateCard: {}, provenance: "fixture" },
  };
}

/** Runs one headless task whose runner reports the given audit facts and committed usage, then completes. */
async function runReporting(audit: readonly ProviderRequestAuditFact[], committed: readonly UsageEntry[] = []): Promise<HeadlessTaskResult> {
  const createAgent: AgentFactory = (options) => {
    const done = Promise.withResolvers<Awaited<ReturnType<AgentFactory>["done"]>>();
    return {
      send() {
        for (const fact of audit) options.auditObserver?.(fact);
        for (const entry of committed) options.usageObserver?.(entry);
        done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } });
      },
      abort() {}, done: done.promise,
    };
  };
  const result = await runHeadlessTask("work", {
    modelsClient: fakeModelsClient, directories: testDirectories(directory("headless-tally-")), launcher, printErrorsToStderr: false,
    prepareWorkflowDeps: async () => makeWorkflowDeps(createAgent),
  });
  expect(result.completed).toBe(true);
  return result;
}

describe("headless run tally", () => {
  test("summary usage equals the in-memory accumulation across two model turns", async () => {
    const result = await runReporting([
      dispatchedFact("request-1", 1),
      dispatchedFact("request-2", 2),
      usageFact("request-1", 1, { input: 100, output: 25, cacheRead: 50, reasoning: 5, cost: 0.1234561 }),
      usageFact("request-2", 2, { input: 40, output: 10, cacheRead: 20, reasoning: 2, cost: 0.2 }),
    ]);

    expect(result.usage).toEqual({
      requests: 2,
      inputTokens: 140,
      outputTokens: 35,
      cacheReadTokens: 70,
      reasoningTokens: 7,
      costUsd: 0.323456,
    });
  });

  test("joins current v3 tokens to one idempotent canonical cost delta", async () => {
    const committed = committedUsage("attempt-current-7", 0.2, { input: 40, output: 10, cacheRead: 20, reasoning: 2 });
    const result = await runReporting([
      dispatchedFact("request-historical", 1),
      dispatchedFact("request-current", 2),
      usageFact("request-historical", 1, { input: 100, output: 25, cacheRead: 50, reasoning: 5, cost: 0.125 }),
      currentUsageFact("request-current", "attempt-current-7", 2, { input: 40, output: 10, cacheRead: 20, reasoning: 2 }),
    ], [committed, committed]);

    expect(result.usage).toEqual({
      requests: 2,
      inputTokens: 140,
      outputTokens: 35,
      cacheReadTokens: 70,
      reasoningTokens: 7,
      costUsd: 0.325,
    });
  });

  test("summarizes current committed usage without a duplicate audit callback", async () => {
    const result = await runReporting(
      [dispatchedFact("request-current-8", 1)],
      [committedUsage("attempt-current-8", null, { input: 9340, output: 6, cacheRead: 0, reasoning: 0 })],
    );

    expect(result.usage).toEqual({
      requests: 1,
      inputTokens: 9340,
      outputTokens: 6,
      cacheReadTokens: 0,
      reasoningTokens: 0,
      costUsd: 0,
    });
  });

  test("counts a dispatched request that ended before it measured usage", async () => {
    const result = await runReporting([dispatchedFact("request-cut", 1), dispatchedFact("request-cut", 1)]);

    expect(result.usage).toEqual({
      requests: 1,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: 0,
      costUsd: 0,
    });
  });

  test("preserves ordered distinct selected surfaces with sorted tools", async () => {
    const result = await runReporting([
      surfaceFact("request-1", 1, "hash-1", ["write", "bash"]),
      surfaceFact("request-2", 2, "hash-2", ["read", "bash"]),
      surfaceFact("request-3", 3, "hash-1", ["ignored_duplicate_hash"]),
    ]);

    expect(result.report?.toolSurfaces).toEqual([
      { toolSurfaceHash: "hash-1", tools: ["bash", "write"] },
      { toolSurfaceHash: "hash-2", tools: ["bash", "read"] },
    ]);
  });
});
