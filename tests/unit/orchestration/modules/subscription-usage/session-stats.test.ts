import { afterEach, describe, expect, test } from "bun:test"
import assert from "node:assert/strict"
import { asAsyncEventReadSurface, type EventStoreAppend, type StoredFact } from "../../../../../src/infra/event-store-types.js"
import type { MeasuredUsageEntry as UsageEntry } from "../../../../../src/infra/llm/usage-entry.js"
import { inMemoryEventReader } from "../../../../helpers/in-memory-event-reader.js"
import { countStateRequests, factsRead } from "../../../../helpers/state-requests.js"
import { createSessionStatsReader } from "../../../../../src/orchestration/modules/subscription-usage/session-stats.js"
import { dbFile, readyBudget, removeIndexDirectories } from "../../session/_summary-index-fixtures.js"

afterEach(removeIndexDirectories)

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

function fixture() {
  const events: StoredFact[] = []
  const store = inMemoryEventReader(events)
  const source = asAsyncEventReadSurface(store)
  const reads: NonNullable<Parameters<typeof store.read>[0]>[] = []
  const reader = {
    capturePosition: source.capturePosition,
    readPage: (query: Parameters<typeof source.readPage>[0], upper: number, after: number, tolerant?: boolean) => {
      reads.push({ ...query, afterPosition: after })
      return source.readPage(query, upper, after, tolerant)
    },
  }
  function append(sessionId: string, type: string, version: number, actor: EventStoreAppend["actor"], payload: EventStoreAppend["payload"]) {
    const position = events.length + 1
    events.push({ aggregateId: `session:${sessionId}`, sessionId, type, version, actor, payload, position, seq: events.filter((event) => event.sessionId === sessionId).length, id: String(position), timestamp: position })
    return String(position)
  }
  function usage(sessionId: string, n: number, classification: "real_spend" | "subscription_equivalent" = "real_spend", price: UsageEntry["price"] = { kind: "priced", estimatedUsd: n, rateCard: {}, provenance: "test" }) {
    append(sessionId, "model.usage.measured", 5, "provider", {
      attemptId: uuid(n), occurredAt: "2025-01-01T00:00:00.000Z", profileId: "profile",
      attribution: classification === "real_spend" ? { kind: "unattributed" } : { kind: "candidate", providerId: "provider", instanceId: "account" },
      spendMode: classification === "real_spend" ? "direct_api" : "included",
      credentialLineage: uuid(100), model: n === 3 ? "second" : "first",
      tokens: { input: n, output: 2, cacheRead: 3, cacheWrite: 4, reasoning: 1 },
      classification, price, currency: "USD", budgetStreamId: "runner",
    })
  }
  function tool(sessionId: string, n: number, outcome: string) {
    append(sessionId, "tool.input.completed", 1, "agent", { toolUseId: `call-${n}`, toolName: "search", input: {}, inputBytes: 0, inputSha256: "", inputPreview: "", executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false })
    append(sessionId, "tool.result.recorded", 2, "flywheel", { toolUseId: `call-${n}`, outcome, contentPreview: "recorded output" })
  }
  function generation(sessionId: string, n: number, model: string, reasoningEffort: string | undefined, durationMs: number) {
    append(sessionId, "model.requested", 5, "flywheel", {
      requestId: uuid(n), identity: { providerSessionKey: sessionId }, turn: 1,
      model, accessProvider: "openai", modelFamily: "gpt", interactionProfileId: "default",
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    })
    append(sessionId, "model.stream.summary.recorded", 3, "flywheel", {
      requestId: uuid(n), identity: { providerSessionKey: sessionId }, turn: 1, rawEventCount: 2,
      countsBySource: {}, countsByKind: {}, interDelta: { count: 0, meanMs: 0, p50Ms: 0, p90Ms: 0, p99Ms: 0, maxMs: 0, ge1s: 0, ge2s: 0, ge5s: 0, ge10s: 0 },
      watchdog: { thinkingStallCount: 0 }, recovery: { streamRetryCount: 0, reasoningDisabledRetryCount: 0 },
      bigGapTransitions: [], generation: { kind: "recorded", basis: "O200kBase", outputTokens: 100, durationMs, measuredBlocks: 1, excludedBlocks: 0 },
    })
  }
  function child(sessionId: string, parentSessionId: string) {
    append(sessionId, "session.created", 4, "flywheel", {
      kind: "subagent", command: "subagent", conversationId: sessionId, label: sessionId,
      createdAt: "2025-01-01", lastUpdated: "2025-01-01", lifecycleState: "active",
      executionCwd: "/scratch", launchedFrom: { parentSessionId, toolUseId: `launch-${sessionId}` },
    })
  }
  return { append, usage, tool, generation, child, reads, events, stats: createSessionStatsReader(reader) }
}

describe("session statistics", () => {
  test("uses canonical validation, recovery, and missing-input tool outcomes", async () => {
    const f = fixture()
    f.tool("root", 1, "interrupted")
    f.append("root", "tool.result.recorded", 2, "flywheel", { toolUseId: "call-1", outcome: "ok" })
    f.append("root", "tool.validation.failed", 1, "flywheel", {
      toolUseId: "invalid", toolName: "search", input: {}, inputBytes: 0, inputSha256: "", inputPreview: "",
      executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false, reason: "Invalid query",
    })
    f.append("root", "tool.result.recorded", 2, "flywheel", { toolUseId: "missing-input", outcome: "error" })
    expect(await f.stats("root")).toMatchObject({
      partial: true,
      tools: [
        { name: "search", calls: 2, errors: 1, interrupted: 0 },
        { name: "unrecorded", calls: 1, errors: 1 },
      ],
    })
  })

  test("uses a workflow's corrected outcome rather than its provisional error", async () => {
    const f = fixture()
    f.append("root", "tool.input.completed", 1, "agent", {
      toolUseId: "workflow-call", toolName: "workflow", input: { workflow_definition_id: "test", description: "task" },
      inputBytes: 0, inputSha256: "", inputPreview: "", executionMode: "background", traceKind: "subagent", childHasOwnViewport: true,
    })
    const priorResultEventId = f.append("root", "tool.result.recorded", 2, "flywheel", { toolUseId: "workflow-call", outcome: "error" })
    expect((await f.stats("root")).tools[0]?.errors).toBe(1)
    f.append("root", "workflow.tool_result.corrected", 1, "flywheel", {
      toolUseId: "workflow-call", childSessionId: "child", workflowDefinitionId: "test", description: "task",
      priorResultEventId, outcome: "ok", bytes: 0, sha256: "", preview: "",
    })
    expect((await f.stats("root")).tools[0]).toMatchObject({ name: "workflow", calls: 1, errors: 0 })
  })

  test("counts unmeasured and partial requests beside v5 and v6 entries and adds only reported tokens", async () => {
    const f = fixture()
    f.usage("root", 1)
    const attempt = {
      occurredAt: "2025-01-01T00:00:00.000Z", profileId: "profile", attribution: { kind: "unattributed" }, spendMode: "direct_api",
      credentialLineage: uuid(90), model: "first", classification: "real_spend", budgetStreamId: "runner",
    }
    f.append("root", "model.usage.measured", 6, "provider", { ...attempt, attemptId: uuid(2), coverage: "unmeasured" })
    f.append("root", "model.usage.measured", 6, "provider", {
      ...attempt, attemptId: uuid(3), coverage: "partial", currency: "USD",
      tokens: { input: 7, output: 3, cacheRead: null, cacheWrite: 0, reasoning: 0 }, price: { kind: "priced", estimatedUsd: 0.5, rateCard: {}, provenance: "test" },
    })
    const stats = await f.stats("root")
    expect(stats).toMatchObject({ totals: { attempts: 2, unmeasuredAttempts: 1, partialAttempts: 1, cacheComplete: false, estimatedBilledUsd: 1.5 }, models: [{ model: "first", cacheComplete: false }] })
    expect(stats.totals.tokens.input).toBe(8)
  })

  test("labels cumulative historical usage without an exact cache breakdown", async () => {
    const f = fixture()
    f.append("old", "model.usage.measured", 3, "provider", {
      totalCostUsd: 2, billedCostUsd: 1, inputTokens: 50, outputTokens: 10,
      cacheReadTokens: 0, cacheCreateTokens: 0, reasoningTokens: 0,
    })
    expect(await f.stats("old")).toMatchObject({
      partial: true, totals: { cacheComplete: false, tokens: { input: 50, output: 10 }, estimatedBilledUsd: 1 },
    })
  })

  test.each(["terminal", "process restart", "stream completion"] as const)("matches summary totals for historical subagent usage: %s", async (scenario) => {
    const f = fixture()
    f.append("child", "session.created", 4, "flywheel", {
      kind: "subagent", command: "subagent", conversationId: "child", label: "child",
      createdAt: "2025-01-01", lastUpdated: "2025-01-01", lifecycleState: "active",
      executionCwd: "/scratch", launchedFrom: { parentSessionId: "root", toolUseId: "launch-child" },
    })
    if (scenario === "terminal") {
      f.append("child", "model.turn.completed", 1, "provider", {
        isError: false, totalCostUsd: 5, billedCostUsd: 5, usage: { input_tokens: 50, output_tokens: 5 },
      })
    } else {
      const payload = {
        totalCostUsd: 3, billedCostUsd: 3, inputTokens: 30, outputTokens: 3,
        cacheReadTokens: 0, cacheCreateTokens: 0, reasoningTokens: 0,
        ...(scenario === "stream completion" ? { parentToolUseId: "stream" } : {}),
      }
      f.append("child", "model.usage.measured", 1, "provider", payload)
      if (scenario === "process restart") f.append("child", "budget.process.started", 1, "flywheel", {})
      else f.append("child", "budget.stream.completed", 1, "flywheel", { parentToolUseId: "stream" })
      f.append("child", "model.usage.measured", 1, "provider", payload)
    }
    const summary = await readyBudget(dbFile(), f.events, "root")
    const stats = await f.stats("root")
    assert.ok(summary?.budget)
    expect(summary?.errors).toEqual({})
    expect(summary?.budget).toMatchObject({
      totalCost: scenario === "terminal" ? 5 : 6,
      totalTokens: scenario === "terminal" ? 55 : 66,
    })
    expect(stats.totals.estimatedBilledUsd + stats.totals.includedValueUsd).toBe(summary.budget.totalCost)
    expect(stats.totals.tokens.total).toBe(summary.budget.totalTokens)
    expect(stats).toMatchObject({ partial: true, totals: { cacheComplete: false }, descendantCount: 1, models: [] })
  })

  test("includes a launched workflow and its nested agent in descendant work, but never a fork", async () => {
    const f = fixture()
    for (const [id, kind, parent] of [["workflow", "workflow", "root"], ["agent", "subagent", "workflow"], ["sibling", "subagent", "root"], ["fork", "chat", "root"], ["fork-agent", "subagent", "fork"]] as const) {
      f.append(id, "session.created", 4, "flywheel", {
        kind, command: kind, conversationId: id, label: id,
        ...(kind === "workflow" ? { workflowDefinitionId: "test" } : {}),
        createdAt: "2025-01-01", lastUpdated: "2025-01-01", lifecycleState: "active",
        executionCwd: "/scratch", launchedFrom: { parentSessionId: parent, toolUseId: `launch-${id}` },
      })
    }
    // A fork publishes a link from its source as well as its launch origin.
    f.append("root", "session.child.linked", 1, "flywheel", { childSessionId: "fork", lastUpdated: "2025-01-01T00:00:00.000Z" })
    f.usage("workflow", 20)
    f.usage("agent", 3, "subscription_equivalent")
    f.usage("sibling", 5)
    f.usage("fork", 7)
    f.usage("fork-agent", 9)
    f.generation("fork", 10, "first", "medium", 1000)
    const root = await f.stats("root")
    expect(root).toMatchObject({
      descendantCount: 3,
      descendants: { attempts: 3, estimatedBilledUsd: 25, includedValueUsd: 3, tokens: { input: 28 } },
      generation: { totals: { measuredRequests: 0 } },
    })
    expect(await f.stats("fork")).toMatchObject({ descendantCount: 1, descendants: { tokens: { input: 9 } } })
    // Adoption appends the ownership fact on the workflow and the adopter's link in one batch.
    f.append("workflow", "session.ownership.adopted", 1, "flywheel", {
      parentSessionId: "sibling", parentConversationId: "sibling-conversation", toolUseId: "adopt", lastUpdated: "2025-01-01T00:00:00.000Z",
    })
    f.append("sibling", "session.child.linked", 1, "flywheel", { childSessionId: "workflow", lastUpdated: "2025-01-01T00:00:00.000Z" })
    expect((await f.stats("root")).descendants.tokens.input).toBe(28)
    expect((await f.stats("sibling")).descendants.tokens.input).toBe(23)
  })

  test("reads nested leaf usage once and refreshes on later committed facts", async () => {
    const f = fixture()
    f.append("root", "session.child.linked", 1, "flywheel", { childSessionId: "child", lastUpdated: "2025-01-01T00:00:00.000Z" })
    f.append("child", "session.child.linked", 1, "flywheel", { childSessionId: "grandchild", lastUpdated: "2025-01-01T00:00:00.000Z" })
    for (const id of ["child", "grandchild"]) f.append(id, "session.created", 4, "flywheel", {
      kind: "subagent", command: "subagent", conversationId: id, label: id,
      createdAt: "2025-01-01", lastUpdated: "2025-01-01", lifecycleState: "active",
      executionCwd: "/scratch", launchedFrom: { parentSessionId: id === "child" ? "root" : "child", toolUseId: `launch-${id}` },
    })
    f.usage("root", 1)
    f.append("root", "model.turn.completed", 1, "provider", {
      isError: false, totalCostUsd: 1, billedCostUsd: 1, usage: { input_tokens: 1, output_tokens: 2 },
    })
    f.usage("child", 2, "subscription_equivalent")
    f.usage("child", 2, "subscription_equivalent")
    f.usage("grandchild", 3, "real_spend", { kind: "unavailable", reason: "No rate" })
    f.generation("root", 1, "first", "medium", 1000)
    f.generation("child", 2, "first", "high", 9000)
    f.generation("grandchild", 3, "second", undefined, 5000)
    f.generation("sibling", 4, "unrelated", "medium", 1000)
    for (const [n, outcome] of ["error", "blocked", "cancelled", "interrupted", "stopped", "ok"].entries()) f.tool("root", n, outcome)
    expect(f.reads).toHaveLength(0)
    const first = await f.stats("root")
    expect(first).toMatchObject({
      descendantCount: 2, partial: false,
      direct: { attempts: 1, estimatedBilledUsd: 1, includedValueUsd: 0 },
      descendants: { attempts: 2, estimatedBilledUsd: 0, includedValueUsd: 2, priceUnavailable: true },
      totals: { attempts: 3, estimatedBilledUsd: 1, includedValueUsd: 2, priceUnavailable: true },
      tools: [{ name: "search", calls: 6, errors: 1, blocked: 1, cancelled: 1, interrupted: 1, stopped: 1 }],
    })
    expect(first.totals.tokens).toEqual({ input: 6, output: 6, cacheRead: 9, cacheWrite: 12, reasoning: 3, total: 12 })
    expect(first.models.map(({ model, attempts }) => [model, attempts])).toEqual([["first", 2], ["second", 1]])
    expect(first.generation).toMatchObject({
      coverageComplete: true,
      totals: { outputTokens: 300, durationMs: 15000, measuredRequests: 3, unmeasuredRequests: 0, averageTokensPerSecond: 20 },
      models: [
        { model: "first", reasoningEffort: "high", outputTokens: 100, durationMs: 9000 },
        { model: "first", reasoningEffort: "medium", outputTokens: 100, durationMs: 1000 },
        { model: "second", reasoningEffort: null, outputTokens: 100, durationMs: 5000 },
      ],
    })
    expect((await f.stats("child")).generation.totals).toMatchObject({ measuredRequests: 2, durationMs: 14000 })
    expect(f.reads.every((query) => query.aggregateId === undefined || ["session:root", "session:child", "session:grandchild"].includes(query.aggregateId))).toBe(true)
    f.usage("grandchild", 4)
    expect((await f.stats("root")).totals).toMatchObject({ attempts: 4, estimatedBilledUsd: 5 })
  })

  test("reads only what changed on each poll, whatever the descendant count", async () => {
    const polls = async (descendants: number) => {
      const f = fixture()
      const counter = countStateRequests(asAsyncEventReadSurface(inMemoryEventReader(f.events)))
      const stats = createSessionStatsReader(counter.reader)
      for (let index = 0; index < descendants; index++) {
        f.child(`child-${index}`, "root")
        f.usage(`child-${index}`, 10 + index)
        f.tool(`child-${index}`, index, "ok")
        f.generation(`child-${index}`, 1000 + index, "first", "medium", 1000)
      }
      await stats("root")
      counter.take()
      const costs: [number, number][] = []
      const poll = async () => {
        const result = await stats("root")
        const requests = counter.take()
        costs.push([requests.length, factsRead(requests)])
        return result
      }
      expect((await poll()).totals.attempts).toBe(descendants)
      f.usage("child-0", 5000)
      expect((await poll()).totals.attempts).toBe(descendants + 1)
      f.child("late", "child-0")
      f.usage("late", 5001)
      f.tool("late", 5001, "error")
      expect(await poll()).toMatchObject({ descendantCount: descendants + 1, totals: { attempts: descendants + 2 }, tools: [{ name: "search", calls: descendants + 1, errors: 1 }] })
      return costs
    }
    // Eighty descendants exceed the sixty-four projections the registry holds per family.
    const few = await polls(4)
    expect(await polls(80)).toEqual(few)
    // An idle poll folds nothing; a change folds its own facts and no history.
    expect(few.map(([, facts]) => facts)).toEqual([0, 1, 4])
  })

  test("returns zero for an empty session and flags historical details as partial", async () => {
    const f = fixture()
    f.append("empty", "budget.process.started", 1, "flywheel", {})
    expect(await f.stats("empty")).toMatchObject({ partial: false, descendantCount: 0, totals: { attempts: 0 }, tools: [] })
    f.append("empty", "model.usage.measured", 4, "provider", {
      usageEntryId: "historical", costUsdDelta: 3, billedCostUsdDelta: 1,
      inputTokensDelta: 5, outputTokensDelta: 2, cacheReadTokensDelta: 1, cacheCreateTokensDelta: 2,
      reasoningTokensDelta: 1, budgetStreamId: "runner",
    })
    expect(await f.stats("empty")).toMatchObject({ partial: true, totals: { attempts: 1, estimatedBilledUsd: 1, includedValueUsd: 2 }, models: [] })
    expect((await f.stats("empty")).generation).toMatchObject({
      coverageComplete: false, totals: { averageTokensPerSecond: null, measuredRequests: 0, unmeasuredRequests: 0 },
    })
  })
})
