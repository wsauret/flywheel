import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import { asAsyncEventReadSurface, type EventStore, type StoredFact } from "../../../../src/infra/event-store-types"
import { InvariantViolation } from "../../../../src/infra/invariant"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { loadSubagentRunsFromEvents, readSubagentRuns } from "../../../../src/orchestration/modules/subagents/history/subagent-run-projection"
import type { SubagentRunFact } from "../../../../src/orchestration/modules/subagents/facts"
import { countStateRequests, factsRead } from "../../../helpers/state-requests"

let tmpDir: string

function appendFact(store: EventStore, sessionId: string, fact: SubagentRunFact): StoredFact {
  return store.append({
    aggregateId: `session:${sessionId}`,
    type: fact.type,
    version: fact.version,
    timestamp: Date.now(),
    actor: fact.actor,
    sessionId,
    payload: fact.payload,
  })
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "flywheel-subagent-projection-"))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe("subagent-run projection invariants", () => {
  test("run reads advance without rereading prior runs", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    try {
      for (const count of [2, 40]) {
        const sessionId = `history-${count}`
        for (let i = 0; i < count; i += 1) {
          appendFact(store, sessionId, {
            type: "child_run.created", version: 1, actor: "flywheel",
            payload: { childRunId: `run-${i}`, kind: "subagent", agentType: "reviewer", description: "review", model: "test", maxTurns: 3, tools: [] },
          })
        }
        const counter = countStateRequests(asAsyncEventReadSurface(store))
        expect(await readSubagentRuns(counter.reader, sessionId)).toHaveLength(count)
        counter.take()
        appendFact(store, sessionId, {
          type: "subagent.prompted", version: 3, actor: "flywheel",
          payload: { childRunId: "run-0", prompt: "review", task: "review", toolNames: [] },
        })
        const runs = await readSubagentRuns(counter.reader, sessionId)
        expect(runs[0]?.prompt).toBe("review")
        expect(factsRead(counter.take())).toBe(1)
      }
    } finally {
      store.close()
    }
  })

  test("subagent.prompted without prior child_run.created throws InvariantViolation kind=missing-producer-event", () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const sessionId = "subagent-orphan-1"
    appendFact(store, sessionId, {
      type: "subagent.prompted",
      version: 3,
      actor: "flywheel",
      payload: {
        childRunId: "ghost-run",
        prompt: "do the thing",
        task: "you are an agent",
        toolNames: ["read"],
      },
    })

    let caught: unknown
    try {
      loadSubagentRunsFromEvents(store.read({ aggregateId: `session:${sessionId}` }))
    } catch (err) {
      caught = err
    }
    store.close()

    expect(caught).toBeInstanceOf(InvariantViolation)
    if (!(caught instanceof InvariantViolation)) throw new Error("expected invariant violation")
    const violation = caught
    expect(violation.kind).toBe("missing-producer-event")
    expect(violation.eventType).toBe("subagent.prompted")
    expect(violation.detail).toContain("ghost-run")
  })

  test("happy path: created -> prompted -> completed assembles a full timeline entry", () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const sessionId = "subagent-happy"
    appendFact(store, sessionId, {
      type: "child_run.created",
      version: 1,
      actor: "flywheel",
      payload: {
        childRunId: "run-1",
        kind: "subagent",
        agentType: "reviewer",
        description: "review code",
        model: "claude-test",
        maxTurns: 3,
        tools: ["read", "search"],
      },
    })
    appendFact(store, sessionId, {
      type: "subagent.prompted",
      version: 3,
      actor: "flywheel",
      payload: {
        childRunId: "run-1",
        prompt: "review the diff",
        task: "You are a reviewer",
        toolNames: ["read", "search"],
      },
    })
    appendFact(store, sessionId, {
      type: "subagent.completed",
      version: 1,
      actor: "flywheel",
      payload: {
        childRunId: "run-1",
        status: "completed",
        isError: false,
        durationMs: 250,
        totalTokens: 30,
        inputTokens: 20,
        outputTokens: 10,
        cacheReadInputTokens: 5,
        cacheCreationInputTokens: 2,
        reasoningTokens: 3,
        totalCostUsd: 0.04,
        toolUses: 2,
        resultBytes: 7,
        resultSha256: "h",
        resultPreview: "looks ok",
      },
    })

    const runs = loadSubagentRunsFromEvents(store.read({ aggregateId: `session:${sessionId}` }))
    store.close()

    expect(runs).toHaveLength(1)
    expect(runs[0]?.executionCwd).toBeUndefined()
    expect(runs[0]).toMatchObject({
      childRunId: "run-1",
      status: "completed",
      agentType: "reviewer",
      model: "claude-test",
      prompt: "review the diff",
      // The launch fact records the composed task instructions, NOT the
      // assembled system prompt the provider later received.
      task: "You are a reviewer",
      totalTokens: 30,
      inputTokens: 20,
      outputTokens: 10,
      cacheReadInputTokens: 5,
      cacheCreationInputTokens: 2,
      reasoningTokens: 3,
      totalCostUsd: 0.04,
      toolUses: 2,
      resultPreview: "looks ok",
    })
  })

  test("projects a child-owned version-2 run binding with complete recovery authority", () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const sessionId = "child-session"
    appendFact(store, sessionId, {
      type: "child_run.created",
      version: 2,
      actor: "flywheel",
      payload: {
        childSessionId: sessionId,
        childRunId: "run-2",
        conversationId: "child-conversation",
        parentSessionId: "parent-session",
        parentConversationId: "parent-conversation",
        parentToolCallId: "tool-2",
        persona: { name: "explorer", kind: "persona" },
        capabilityGrant: {
          operation: "the subagent tool",
          required: ["subagents"],
          capabilities: ["subagents"],
          moduleIds: ["subagents"],
          requireWorkflowConfirmation: true,
          workflowsMode: "off",
          identity: "grant-1",
        },
        admittedModuleIds: ["subagents"],
        skillsRevision: 7,
        model: "claude-test",
        effort: "medium",
        tools: ["read", "handoff"],
        executionCwd: tmpDir,
        budget: { maxTurns: 30, maxTokens: 12_000 },
        parentDepth: 1,
        description: "inspect child sessions",
      },
    })

    const runs = loadSubagentRunsFromEvents(store.read({ aggregateId: `session:${sessionId}` }))
    store.close()

    expect(runs).toEqual([
      expect.objectContaining({
        childSessionId: sessionId,
        childRunId: "run-2",
        conversationId: "child-conversation",
        parentSessionId: "parent-session",
        parentConversationId: "parent-conversation",
        parentToolCallId: "tool-2",
        agentType: "explorer",
        model: "claude-test",
        tools: ["read", "handoff"],
        executionCwd: tmpDir,
        parentDepth: 1,
        status: "created",
      }),
    ])
  })

  test("projects an agent-requested cancellation as a terminal cancelled run", () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const sessionId = "subagent-cancelled"
    appendFact(store, sessionId, {
      type: "child_run.created",
      version: 1,
      actor: "flywheel",
      payload: {
        childRunId: "run-cancelled",
        kind: "subagent",
        agentType: "explorer",
        description: "stop work",
        model: "gpt-test",
        maxTurns: 3,
        tools: [],
      },
    })
    appendFact(store, sessionId, {
      type: "subagent.completed",
      version: 1,
      actor: "flywheel",
      payload: {
        childRunId: "run-cancelled",
        status: "cancelled",
        isError: false,
        durationMs: 10,
        resultBytes: 8,
        resultSha256: "hash",
        resultPreview: "canceled",
      },
    })

    const runs = loadSubagentRunsFromEvents(store.read({ aggregateId: `session:${sessionId}` }))
    store.close()
    expect(runs[0]).toMatchObject({ status: "cancelled", isError: false, resultPreview: "canceled" })
  })
})
