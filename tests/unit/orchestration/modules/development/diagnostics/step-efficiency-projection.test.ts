import { describe, expect, test } from "bun:test"
import { loadStepEfficiencyFromEvents } from "../../../../../../src/orchestration/modules/development/diagnostics/step-efficiency-projection"
import { loadProviderRequestAuditFromEvents } from "../../../../../../src/orchestration/session/provider-request-audit-projection"
import {
  appendFact,
  appendParentSubagentScenario,
  appendPrompt,
  appendResponse,
  appendSingleStepStarted,
  appendStepStatus,
  appendStreamEvent,
  appendSubagentCompleted,
  appendSubagentTool,
  appendUsage,
  withEfficiencyStore,
} from "./_step-efficiency-fixtures"

function entriesFor(store: Parameters<Parameters<typeof withEfficiencyStore>[1]>[0], sessionId: string) {
  return loadStepEfficiencyFromEvents(store.read({ aggregateId: `session:${sessionId}` }))
}

describe("step efficiency projection", () => {
  test("aggregates v3 tokens but only measured historical cost", () => {
    const sessionId = "session-efficiency-mixed-usage"
    withEfficiencyStore(sessionId, (store) => {
      appendSingleStepStarted(store, sessionId)
      appendPrompt(store, sessionId, "req-historical", "conv-worker", 1, 1_300)
      appendUsage(store, sessionId, "req-historical", "conv-worker", 1, 1_400, {
        stepId: "step-1",
        inputTokens: 100,
        outputTokens: 20,
        cacheReadInputTokens: 50,
        deltaCostUsd: 0.1,
      })
      appendPrompt(store, sessionId, "req-current", "conv-worker", 2, 1_500)
      appendFact(store, sessionId, {
        type: "model.usage.recorded",
        version: 3,
        actor: "provider",
        payload: {
          requestId: "req-current",
          attemptId: "attempt-current-7",
          identity: { providerSessionKey: "conv-worker", conversationId: "conv-worker" },
          turn: 2,
          stepId: "step-1",
          inputTokens: 40,
          outputTokens: 10,
          cacheReadInputTokens: 20,
          cacheCreationInputTokens: 5,
          reasoningTokens: 2,
          promptTokens: 65,
        },
      }, 1_600)
      appendStepStatus(store, sessionId, "completed", 2_000)

      const [entry] = entriesFor(store, sessionId)
      expect(entry).toMatchObject({
        inputTokens: 140,
        outputTokens: 30,
        cacheReadInputTokens: 70,
        cacheCreationInputTokens: 5,
        reasoningTokens: 2,
        promptTokens: 215,
        costUsd: 0.1,
        parentWorkerCostUsd: 0.1,
        subagentCostUsd: 0,
      })
      const currentUsage = loadProviderRequestAuditFromEvents(store.read({ aggregateId: `session:${sessionId}` }))
        .find((request) => request.requestId === "req-current")?.usage
      expect(currentUsage?.attemptId).toBe("attempt-current-7")
      expect(currentUsage).not.toHaveProperty("deltaCostUsd")
    })
  })

  test("counts output recovery breadcrumbs by truncation cause", () => {
    const sessionId = "session-efficiency-output-recovery"
    withEfficiencyStore(sessionId, (store) => {
      appendSingleStepStarted(store, sessionId)
      appendPrompt(store, sessionId, "req-parent", "conv-worker", 1, 1_300)
      appendFact(store, sessionId, {
        type: "tool.input.completed",
        version: 1,
        actor: "agent",
        payload: {
          toolUseId: "tool-bash",
          toolName: "bash",
          input: { command: "bun run test" },
          inputBytes: 24,
          inputSha256: "input",
          inputPreview: "{\"command\":\"bun run test\"}",
          executionMode: "foreground",
          traceKind: "tool",
          childHasOwnViewport: false,
          modelRequestId: "req-parent",
        },
      }, 1_500)
      appendFact(store, sessionId, {
        type: "tool.result.recorded",
        version: 1,
        actor: "flywheel",
        payload: {
          toolUseId: "tool-bash",
          outcome: "ok",
          modelRequestId: "req-parent",
          contentTruncated: true,
          originalContentBytes: 60_000,
          originalContentSha256: "original",
          fullContentPath: "/scratch/flywheel-output.txt",
          semanticOutputTruncated: true,
          byteOutputTruncated: false,
        },
      }, 1_550)
      appendStepStatus(store, sessionId, "completed", 2_000)

      const [entry] = entriesFor(store, sessionId)
      expect(entry).toMatchObject({
        outputRecoveryCount: 1,
        semanticOutputRecoveryCount: 1,
        byteOutputRecoveryCount: 0,
      })
    })
  })

  test("counts thinking-stall escape-hatch telemetry", () => {
    const sessionId = "session-efficiency-thinking-stall"
    withEfficiencyStore(sessionId, (store) => {
      appendSingleStepStarted(store, sessionId)
      appendPrompt(store, sessionId, "req-parent", "conv-worker", 1, 1_300)
      appendStreamEvent(store, sessionId, {
        requestId: "req-parent",
        conversationId: "conv-worker",
        turn: 1,
        sequence: 1,
        source: "watchdog",
        kind: "thinking_stall",
        metadata: { elapsedMs: 120_000, summaryChars: 42 },
      }, 1_450)
      appendStreamEvent(store, sessionId, {
        requestId: "req-parent",
        conversationId: "conv-worker",
        turn: 1,
        sequence: 2,
        source: "normalized",
        kind: "stream_attempt_start",
        metadata: { disableReasoning: true },
      }, 1_460)
      appendStepStatus(store, sessionId, "completed", 2_000)

      const [entry] = entriesFor(store, sessionId)
      expect(entry).toMatchObject({
        thinkingStallCount: 1,
        thinkingStallRecoveryCount: 1,
      })
    })
  })

  test("counts thinking-stall escape-hatch telemetry from stream summaries", () => {
    const sessionId = "session-efficiency-thinking-summary"
    withEfficiencyStore(sessionId, (store) => {
      appendSingleStepStarted(store, sessionId)
      appendPrompt(store, sessionId, "req-parent", "conv-worker", 1, 1_300)
      appendFact(store, sessionId, {
        type: "model.stream.summary.recorded",
        version: 1,
        actor: "flywheel",
        payload: {
          requestId: "req-parent",
          conversationId: "conv-worker",
          turn: 1,
          rawEventCount: 10,
          startedAt: 1_350,
          completedAt: 1_500,
          countsBySource: { normalized: 8, watchdog: 2 },
          countsByKind: { thinking_stall: 2, stream_retry: 1 },
          interDelta: { count: 1, meanMs: 10, p50Ms: 10, p90Ms: 10, p99Ms: 10, maxMs: 10, ge1s: 0, ge2s: 0, ge5s: 0, ge10s: 0 },
          watchdog: { thinkingStallCount: 2, maxStallMs: 120_000 },
          recovery: { streamRetryCount: 1, reasoningDisabledRetryCount: 1 },
          bigGapTransitions: [],
        },
      }, 1_510)
      appendStepStatus(store, sessionId, "completed", 2_000)

      const [entry] = entriesFor(store, sessionId)
      expect(entry).toMatchObject({
        thinkingStallCount: 2,
        thinkingStallRecoveryCount: 1,
      })
    })
  })

  test("rolls parent and subagent request usage into one step with separate cost buckets", () => {
    const sessionId = "session-efficiency-subagent"
    withEfficiencyStore(sessionId, (store) => {
      appendParentSubagentScenario(store, sessionId)

      const [entry] = entriesFor(store, sessionId)
      expect(entry).toMatchObject({
        attemptId: "step-1",
        agentName: "Implement",
        status: "completed",
        durationMs: 800,
        modelRequests: 2,
        successfulModelRequests: 2,
        failedModelRequests: 0,
        modelLatencyMs: 280,
        parentModelLatencyMs: 200,
        subagentModelLatencyMs: 80,
        parentRequests: 1,
        subagentRequests: 1,
        inputTokens: 130,
        outputTokens: 30,
        cacheReadInputTokens: 70,
        cacheCreationInputTokens: 10,
        reasoningTokens: 7,
        promptTokens: 210,
        costUsd: 0.14,
        parentWorkerCostUsd: 0.1,
        subagentCostUsd: 0.04,
        toolCallCount: 2,
        toolCompletedCount: 2,
        toolLatencyMs: 60,
        foregroundToolLatencyMs: 10,
        subagentToolLatencyMs: 50,
        subagentCount: 1,
        failedSubagentCount: 0,
        subagentDurationMs: 300,
      })
      expect(entry?.cacheHitRatio).toBeCloseTo(70 / 210, 10)
    })
  })

  test("keeps failed step request latency even when no usage was recorded", () => {
    const sessionId = "session-efficiency-failed"
    withEfficiencyStore(sessionId, (store) => {
      appendSingleStepStarted(store, sessionId)
      appendPrompt(store, sessionId, "req-failed", "conv-worker", 1, 1_300)
      appendResponse(store, sessionId, "req-failed", "conv-worker", 1, 1_450, {
        durationMs: 150,
        outcome: "stream_error",
      })
      appendStepStatus(store, sessionId, "failed", 1_700)

      const [entry] = entriesFor(store, sessionId)
      expect(entry).toMatchObject({
        status: "failed",
        durationMs: 500,
        modelRequests: 1,
        successfulModelRequests: 0,
        failedModelRequests: 1,
        modelLatencyMs: 150,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      })
    })
  })

  test("uses subagent completion totals when child request usage is unavailable", () => {
    const sessionId = "session-efficiency-subagent-fallback"
    withEfficiencyStore(sessionId, (store) => {
      appendSingleStepStarted(store, sessionId)
      appendPrompt(store, sessionId, "req-parent", "conv-worker", 1, 1_300)
      appendResponse(store, sessionId, "req-parent", "conv-worker", 1, 1_410, { durationMs: 200 })
      appendSubagentTool(store, sessionId)
      appendSubagentCompleted(store, sessionId)
      appendStepStatus(store, sessionId, "completed", 2_000)

      const [entry] = entriesFor(store, sessionId)
      expect(entry).toMatchObject({
        modelRequests: 1,
        parentRequests: 1,
        subagentRequests: 0,
        inputTokens: 30,
        outputTokens: 10,
        cacheReadInputTokens: 20,
        reasoningTokens: 2,
        costUsd: 0.04,
        parentWorkerCostUsd: 0,
        subagentCostUsd: 0.04,
        subagentCount: 1,
        subagentDurationMs: 300,
      })
    })
  })

  test("includes interval boundary timestamps without losing attribution context", () => {
    const sessionId = "session-efficiency-interval"
    withEfficiencyStore(sessionId, (store) => {
      appendParentSubagentScenario(store, sessionId)

      const [entry] = loadStepEfficiencyFromEvents(store.read({ aggregateId: `session:${sessionId}` }), {
        after: 1_400,
        before: 1_610,
      })

      expect(entry).toMatchObject({
        modelRequests: 2,
        parentRequests: 1,
        subagentRequests: 1,
        modelLatencyMs: 280,
        inputTokens: 130,
        outputTokens: 30,
        cacheReadInputTokens: 70,
        costUsd: 0.14,
        parentWorkerCostUsd: 0.1,
        subagentCostUsd: 0.04,
        toolCallCount: 1,
        subagentCount: 0,
      })
    })
  })
})
