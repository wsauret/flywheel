import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSqliteEventStore } from "../../../../../../src/infra/sqlite-event-store"
import type { EventStore } from "../../../../../../src/infra/event-store-types"
import { resolveEventStoreDbFile } from "../../../../../../src/infra/paths"
import type { ProviderRequestAuditFact } from "../../../../../../src/orchestration/session/provider-request-audit-facts"
import type { SessionRuntimeFact } from "../../../../../../src/orchestration/session/session-runtime-event-types"
import type { SubagentRunFact } from "../../../../../../src/orchestration/modules/subagents/facts"
import type { WorkflowQueueFact } from "../../../../../../src/workflows/view/view-facts"

type TestFact = ProviderRequestAuditFact | SessionRuntimeFact | SubagentRunFact | WorkflowQueueFact

interface UsageInput {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens?: number
  reasoningTokens?: number
  deltaCostUsd: number
  stepId?: string
  parentToolUseId?: string
}
interface Metadata {
  [key: string]: unknown
}

export function withEfficiencyStore(sessionId: string, run: (store: EventStore) => void): void {
  const tmp = mkdtempSync(join(tmpdir(), "step-efficiency-"))
  const store = createSqliteEventStore(resolveEventStoreDbFile(tmp))
  try {
    run(store)
  } finally {
    store.close()
    rmSync(tmp, { recursive: true, force: true })
  }
}

export function appendFact(store: EventStore, sessionId: string, fact: TestFact, timestamp: number): void {
  store.append({
    aggregateId: `session:${sessionId}`,
    type: fact.type,
    version: fact.version,
    timestamp,
    actor: fact.actor,
    sessionId,
    payload: fact.payload,
  })
}

export function appendSingleStepStarted(store: EventStore, sessionId: string): void {
  appendFact(store, sessionId, queueCreated(), 1_000)
  appendFact(store, sessionId, {
    type: "step.resume_state.recorded",
    version: 1,
    actor: "flywheel",
    payload: { stepId: "step-1", conversationId: "conv-worker" },
  }, 1_100)
  appendStepStatus(store, sessionId, "running", 1_200)
}

export function appendStepStatus(
  store: EventStore,
  sessionId: string,
  status: "running" | "completed" | "failed" | "skipped",
  timestamp: number,
): void {
  appendFact(store, sessionId, {
    type: "step.status.changed",
    version: 1,
    actor: "flywheel",
    payload: { stepId: "step-1", status },
  }, timestamp)
}

export function appendPrompt(
  store: EventStore,
  sessionId: string,
  requestId: string,
  conversationId: string,
  turn: number,
  timestamp: number,
  parentToolUseId?: string,
): void {
  appendFact(store, sessionId, {
    type: "prompt.assembled",
    version: 2,
    actor: "flywheel",
    payload: {
      requestId,
      conversationId,
      turn,
      promptKind: parentToolUseId ? "subagent" : "worker",
      systemPromptHash: `system-${requestId}`,
      toolSurfaceHash: `tools-${requestId}`,
      systemPrompt: "test system prompt",
      promptSha256: "a".repeat(64),
      messageCount: 1,
      estimatedContextTokens: 100,
      contextWindow: 200_000,
      ...(parentToolUseId ? { parentToolUseId } : { treePointer: { conversationId, leafEntryId: "leaf-1" } }),
    },
  }, timestamp)
  appendFact(store, sessionId, {
    type: "tool_surface.selected",
    version: 2,
    actor: "flywheel",
    payload: {
      requestId,
      conversationId,
      turn,
      toolSurfaceHash: `tools-${requestId}`,
      tools: [],
      omittedTools: [],
    },
  }, timestamp + 1)
  appendFact(store, sessionId, {
    type: "model.requested",
    version: 2,
    actor: "flywheel",
    payload: {
      requestId,
      conversationId,
      turn,
      model: "test-model",
      accessProvider: "anthropic_api",
      modelFamily: "anthropic",
      interactionProfileId: "default",
    },
  }, timestamp + 2)
}

export function appendResponse(
  store: EventStore,
  sessionId: string,
  requestId: string,
  conversationId: string,
  turn: number,
  timestamp: number,
  input: { durationMs: number; outcome?: "ok" | "stream_error" | "context_overflow" },
): void {
  const outcome = input.outcome ?? "ok"
  appendFact(store, sessionId, {
    type: "model.response_received",
    version: 1,
    actor: "provider",
    payload: {
      requestId,
      conversationId,
      turn,
      outcome,
      durationMs: input.durationMs,
      ...(outcome === "ok" ? { stopReason: "end_turn" } : { error: { tag: "TransientDisconnect", message: "retryable" } }),
    },
  }, timestamp)
}

export function appendUsage(
  store: EventStore,
  sessionId: string,
  requestId: string,
  conversationId: string,
  turn: number,
  timestamp: number,
  input: UsageInput,
): void {
  appendFact(store, sessionId, {
    type: "model.usage.recorded",
    version: 1,
    actor: "provider",
    payload: {
      requestId,
      conversationId,
      turn,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheReadInputTokens: input.cacheReadInputTokens,
      cacheCreationInputTokens: input.cacheCreationInputTokens ?? 0,
      reasoningTokens: input.reasoningTokens ?? 0,
      promptTokens: input.inputTokens + input.cacheReadInputTokens + (input.cacheCreationInputTokens ?? 0),
      deltaCostUsd: input.deltaCostUsd,
      ...(input.stepId ? { stepId: input.stepId } : {}),
      ...(input.parentToolUseId ? { parentToolUseId: input.parentToolUseId } : {}),
    },
  }, timestamp)
}

export function appendStreamEvent(
  store: EventStore,
  sessionId: string,
  input: {
    requestId: string
    conversationId: string
    turn: number
    sequence: number
    source: "provider" | "normalized" | "watchdog" | "request"
    kind: string
    metadata?: Metadata
  },
  timestamp: number,
): void {
  appendFact(store, sessionId, {
    type: "model.stream.event_observed",
    version: 1,
    actor: "provider",
    payload: {
      requestId: input.requestId,
      conversationId: input.conversationId,
      turn: input.turn,
      sequence: input.sequence,
      source: input.source,
      kind: input.kind,
      elapsedMs: 10 * input.sequence,
      sincePreviousMs: 10,
      metadata: input.metadata ?? {},
    },
  }, timestamp)
}

export function appendSubagentTool(store: EventStore, sessionId: string): void {
  appendFact(store, sessionId, {
    type: "tool.input.completed",
    version: 1,
    actor: "agent",
    payload: {
      toolUseId: "tool-sub",
      toolName: "subagent",
      input: { persona: "reviewer" },
      inputBytes: 2,
      inputSha256: "i",
      inputPreview: "{}",
      executionMode: "background",
      traceKind: "subagent",
      childHasOwnViewport: false,
      modelRequestId: "req-parent",
    },
  }, 1_500)
  appendFact(store, sessionId, {
    type: "tool.result.recorded",
    version: 1,
    actor: "flywheel",
    payload: { toolUseId: "tool-sub", outcome: "ok", modelRequestId: "req-parent" },
  }, 1_510)
  appendFact(store, sessionId, {
    type: "child_run.created",
    version: 1,
    actor: "flywheel",
    payload: {
      childRunId: "child-1",
      kind: "subagent",
      toolUseId: "tool-sub",
      modelRequestId: "req-parent",
      agentType: "reviewer",
      description: "review",
      model: "claude-test",
      maxTurns: 3,
      tools: ["read"],
    },
  }, 1_520)
}

export function appendChildTool(store: EventStore, sessionId: string): void {
  appendFact(store, sessionId, {
    type: "tool.input.completed",
    version: 1,
    actor: "agent",
    payload: {
      toolUseId: "tool-read",
      toolName: "read",
      input: { path: "src/a.ts" },
      inputBytes: 2,
      inputSha256: "i2",
      inputPreview: "{}",
      executionMode: "foreground",
      traceKind: "tool",
      childHasOwnViewport: false,
      modelRequestId: "req-child",
      parentToolUseId: "tool-sub",
    },
  }, 1_620)
  appendFact(store, sessionId, {
    type: "tool.result.recorded",
    version: 1,
    actor: "flywheel",
    payload: { toolUseId: "tool-read", outcome: "ok", modelRequestId: "req-child", parentToolUseId: "tool-sub" },
  }, 1_670)
}

export function appendSubagentCompleted(store: EventStore, sessionId: string, timestamp = 1_800): void {
  appendFact(store, sessionId, {
    type: "subagent.completed",
    version: 1,
    actor: "flywheel",
    payload: {
      childRunId: "child-1",
      status: "completed",
      isError: false,
      durationMs: 300,
      totalTokens: 40,
      inputTokens: 30,
      outputTokens: 10,
      cacheReadInputTokens: 20,
      cacheCreationInputTokens: 0,
      reasoningTokens: 2,
      totalCostUsd: 0.04,
      toolUses: 1,
      resultBytes: 2,
      resultSha256: "r",
      resultPreview: "ok",
    },
  }, timestamp)
}

export function appendParentSubagentScenario(store: EventStore, sessionId: string): void {
  appendSingleStepStarted(store, sessionId)
  appendPrompt(store, sessionId, "req-parent", "conv-worker", 1, 1_300)
  appendUsage(store, sessionId, "req-parent", "conv-worker", 1, 1_400, {
    stepId: "step-1",
    inputTokens: 100,
    outputTokens: 20,
    cacheReadInputTokens: 50,
    cacheCreationInputTokens: 10,
    reasoningTokens: 5,
    deltaCostUsd: 0.1,
  })
  appendResponse(store, sessionId, "req-parent", "conv-worker", 1, 1_410, { durationMs: 200 })
  appendSubagentTool(store, sessionId)
  appendPrompt(store, sessionId, "req-child", "conv-child", 1, 1_550, "tool-sub")
  appendUsage(store, sessionId, "req-child", "conv-child", 1, 1_600, {
    parentToolUseId: "tool-sub",
    inputTokens: 30,
    outputTokens: 10,
    cacheReadInputTokens: 20,
    reasoningTokens: 2,
    deltaCostUsd: 0.04,
  })
  appendResponse(store, sessionId, "req-child", "conv-child", 1, 1_610, { durationMs: 80 })
  appendChildTool(store, sessionId)
  appendSubagentCompleted(store, sessionId)
  appendStepStatus(store, sessionId, "completed", 2_000)
}

function queueCreated(): WorkflowQueueFact {
  return {
    type: "queue.created",
    version: 9,
    actor: "flywheel",
    payload: {
      queue: {
        status: "running",
        cursor: 0,
        mutationLog: [],
        steps: [{
          id: "step-1",
          definitionId: "implement",
          contentId: "implement",
          workflowDefinitionId: "plan-implement",
          name: "Implement",
          status: "pending",
          writes: [],
          resumeRevertCount: 0,
        }],
      },
    },
  }
}
