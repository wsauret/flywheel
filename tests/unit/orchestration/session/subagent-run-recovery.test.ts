import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import { asAsyncEventReadSurface, type AsyncGuardedEventWriter, type LocalSqliteEventStore } from "../../../../src/infra/event-store-types"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { buildSessionContext } from "../../../../src/orchestration/session/conversation/conversation-tree-context"
import { createConversationTree, readReconciledBranch } from "../../../../src/orchestration/session/conversation/conversation-tree-handle"
import { createSessionFactWriter, prepareSessionFactAppend } from "../../../../src/orchestration/session/session-fact-writer"
import { buildDurableSubagentCreated, recordSubagentCreated } from "../../../../src/orchestration/modules/subagents/history/subagent-run-fact-writers"
import { recoverStaleSubagentRuns } from "../../../../src/orchestration/modules/subagents/history/subagent-run-recovery"
import { loadSubagentRunsFromEvents } from "../../../../src/orchestration/modules/subagents/history/subagent-run-projection"

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "subagent-run-recovery-"))
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function localAsyncWriter(store: LocalSqliteEventStore): AsyncGuardedEventWriter {
  return {
    append: async (event) => store.append(event),
    appendBatch: async (events) => store.appendBatch(events),
    appendGuarded: async (event) => store.appendGuarded(event),
    appendBatchGuarded: async (events) => store.appendBatchGuarded(events),
    pruneSupersededEvents: async (aggregateId, eventType) => store.pruneSupersededEvents(aggregateId, eventType),
  }
}

describe("stale subagent run recovery", () => {
  test("a durable child run becomes crash-paused without rewriting its conversation", async () => {
    const sessionId = "durable-child"
    const conversationId = "conv-durable-child"
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const writer = localAsyncWriter(store)
    const tree = await createConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(store), writer })
    await tree.appendMessage({ kind: "user", content: "delegated task" })
    await tree.getStorage().dispose()
    await writer.append(prepareSessionFactAppend(sessionId, buildDurableSubagentCreated({
      childSessionId: sessionId,
      childRunId: "run-durable-child",
      conversationId,
      parentSessionId: "parent",
      parentConversationId: "parent-conversation",
      parentToolCallId: "parent-tool",
      persona: { name: "explorer", kind: "persona" },
      capabilityGrant: {
        operation: "subagent",
        required: [],
        capabilities: [],
        moduleIds: [],
        requireWorkflowConfirmation: false,
        workflowsMode: "off",
        identity: "test",
      },
      admittedModuleIds: [],
      skillsRevision: 1,
      model: "test/model",
      tools: ["read"],
      executionCwd: tmpDir,
      budget: { maxTurns: 10, maxTokens: 0 },
      parentDepth: 0,
      description: "durable child",
    })))

    const projectionReader = asAsyncEventReadSurface(store)
    const before = await readReconciledBranch({ conversationId, sessionId, store: projectionReader, writer, projectRoot: tmpDir })
    const result = await recoverStaleSubagentRuns({ sessionId, reader: projectionReader, projectionReader, writer, projectRoot: tmpDir })
    const after = await readReconciledBranch({ conversationId, sessionId, store: projectionReader, writer, projectRoot: tmpDir })

    expect(result).toEqual({ interruptedCount: 1, recoveryMessageCount: 0 })
    expect(after).toEqual(before)
    expect(loadSubagentRunsFromEvents(store.read({ aggregateId: `session:${sessionId}` })).at(-1)).toMatchObject({
      childRunId: "run-durable-child",
      status: "interrupted",
      interruptionReason: "runtime_restarted",
    })
    store.close()
  })

  test("a run stamped with its dispatcher's conversationId recovers with zero audit facts in the store", async () => {
    const sessionId = "recovery-stamped"
    const conversationId = "conv-recovery-stamped"
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const writer = localAsyncWriter(store)

    const tree = await createConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(store), writer })
    await tree.appendMessage({ kind: "user", content: "dispatch something" })
    await tree.getStorage().dispose()

    const factWriter = createSessionFactWriter({ sessionId, writer })
    recordSubagentCreated(factWriter, {
      childRunId: "child-1",
      toolUseId: "tool-1",
      modelRequestId: "request-1",
      conversationId,
      agentType: "explorer",
      description: "explore the repo",
      model: "claude-test",
      maxTurns: 4,
      tools: ["read"],
      executionCwd: tmpDir,
    })
    await Bun.sleep(5)
    factWriter.dispose()

    // The store holds no provider-request audit facts at all; recovery must
    // resolve the conversation from the run entry alone.
    expect(store.read({ aggregateId: `session:${sessionId}`, types: ["prompt.assembled", "model.requested"] })).toHaveLength(0)

    const projectionReader = asAsyncEventReadSurface(store)
    const result = await recoverStaleSubagentRuns({ sessionId, reader: projectionReader, projectionReader, writer, projectRoot: tmpDir })
    expect(result).toEqual({ interruptedCount: 1, recoveryMessageCount: 1 })

    const runs = loadSubagentRunsFromEvents(store.read({ aggregateId: `session:${sessionId}` }))
    expect(runs[0]?.status).toBe("interrupted")
    expect(runs[0]?.conversationId).toBe(conversationId)

    const entries = await readReconciledBranch({ conversationId, sessionId, store: projectionReader, writer, projectRoot: tmpDir })
    expect(entries?.some((entry) => entry.id.startsWith("subagent-recovery:"))).toBe(true)
    const context = buildSessionContext(entries ?? [])
    expect(JSON.stringify(context.messages)).toContain("runtime_recovery")
    store.close()
  })

  test("a stamped run recovers into its dispatcher's conversation, not the caller's fallback, so parallel workflow steps each keep their own", async () => {
    const sessionId = "recovery-parallel"
    const [first, second] = ["conv-step-a", "conv-step-b"]
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const writer = localAsyncWriter(store)
    for (const conversationId of [first, second]) {
      const tree = await createConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(store), writer })
      await tree.appendMessage({ kind: "user", content: `step of ${conversationId}` })
      await tree.getStorage().dispose()
    }
    const factWriter = createSessionFactWriter({ sessionId, writer })
    recordSubagentCreated(factWriter, {
      childRunId: "child-b",
      toolUseId: "tool-b",
      modelRequestId: "request-b",
      conversationId: second,
      agentType: "explorer",
      description: "explore for step b",
      model: "claude-test",
      maxTurns: 4,
      tools: ["read"],
      executionCwd: tmpDir,
    })
    await Bun.sleep(5)
    factWriter.dispose()

    const projectionReader = asAsyncEventReadSurface(store)
    const result = await recoverStaleSubagentRuns({ sessionId, reader: projectionReader, projectionReader, writer, projectRoot: tmpDir, fallbackConversationId: first })
    expect(result).toEqual({ interruptedCount: 1, recoveryMessageCount: 1 })
    const recovered = async (conversationId: string) => (await readReconciledBranch({ conversationId, sessionId, store: projectionReader, writer, projectRoot: tmpDir }))
      ?.some((entry) => entry.id.startsWith("subagent-recovery:"))
    expect(await recovered(second)).toBe(true)
    expect(await recovered(first)).toBe(false)
    store.close()
  })

  test("an unstamped legacy run without a fallback conversation is interrupted but skipped for recovery messages", async () => {
    const sessionId = "recovery-legacy"
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const writer = localAsyncWriter(store)

    // Historical row: written before the conversationId stamp existed.
    store.append({
      aggregateId: `session:${sessionId}`,
      type: "child_run.created",
      version: 1,
      timestamp: Date.now(),
      actor: "flywheel",
      sessionId,
      payload: {
        childRunId: "legacy-1",
        kind: "subagent",
        toolUseId: "tool-legacy",
        modelRequestId: "request-legacy",
        agentType: "explorer",
        description: "legacy run",
        model: "claude-test",
        maxTurns: 4,
        tools: ["read"],
      },
    })

    const result = await recoverStaleSubagentRuns({
      sessionId,
      reader: asAsyncEventReadSurface(store),
      projectionReader: asAsyncEventReadSurface(store),
      writer,
      projectRoot: tmpDir,
    })
    expect(result).toEqual({ interruptedCount: 1, recoveryMessageCount: 0 })

    const runs = loadSubagentRunsFromEvents(store.read({ aggregateId: `session:${sessionId}` }))
    expect(runs[0]?.status).toBe("interrupted")
    expect(runs[0]?.conversationId).toBeUndefined()
    store.close()
  })
})
