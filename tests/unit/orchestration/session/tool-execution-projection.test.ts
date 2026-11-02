import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import * as crypto from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import { asAsyncEventReadSurface, type EventStore } from "../../../../src/infra/event-store-types"
import { InvariantViolation } from "../../../../src/infra/invariant"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { activeSubagentIds, createToolExecutionProjection as createAsyncToolExecutionProjection, toolExecutionTimelineFromProjection } from "../../../../src/orchestration/session/tool-execution-projection"
import type { SessionRuntimeFact } from "../../../../src/orchestration/session/session-runtime-event-types"

const TMP_ROOT = path.join(
  os.tmpdir(),
  `flywheel-tool-execution-projection-test-${process.pid}-${Date.now()}`,
)
const createToolExecutionProjection = (store: EventStore, sessionId: string) =>
  createAsyncToolExecutionProjection(asAsyncEventReadSurface(store), sessionId)

let tmpDir: string

function makeTmpDir(): string {
  const dir = path.join(TMP_ROOT, crypto.randomUUID())
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function appendFact(store: EventStore, sessionId: string, fact: SessionRuntimeFact): void {
  store.append({
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
  tmpDir = makeTmpDir()
})

afterEach(() => {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true })
})

describe("tool execution projection", () => {
  it("rebuilds runtime-origin workflow launch and adoption calls without agent identity", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const sessionId = "runtime-workflow-invocations"

    appendFact(store, sessionId, {
      type: "tool.runtime_invocation.recorded",
      version: 1,
      actor: "flywheel",
      payload: {
        toolUseId: "runtime-launch",
        initiator: "person",
        parentConversationId: "conversation-1",
        parentEntryId: "entry-1",
        operation: {
          kind: "launch",
          input: {
            workflowDefinitionId: "implementation",
            summary: "Implement sessions",
            description: "Implement the approved sessions design.",
            launchCwd: "worktree",
          },
        },
      },
    })
    appendFact(store, sessionId, {
      type: "tool.runtime_invocation.recorded",
      version: 1,
      actor: "flywheel",
      payload: {
        toolUseId: "runtime-adoption",
        initiator: "migration",
        parentConversationId: "conversation-1",
        parentEntryId: "entry-2",
        operation: {
          kind: "adoption",
          workflowSessionId: "existing-workflow",
        },
      },
    })
    appendFact(store, sessionId, {
      type: "tool.runtime_invocation.recorded",
      version: 2,
      actor: "flywheel",
      payload: {
        toolUseId: "runtime-adoption-named",
        initiator: "migration",
        parentConversationId: "conversation-1",
        parentEntryId: "entry-3",
        operation: {
          kind: "adoption",
          workflowSessionId: "named-workflow",
          workflowDefinitionId: "implementation",
          summary: "Adopted goal",
        },
      },
    })
    appendFact(store, sessionId, inputFactV2("agent-tool", "request-1", "provider-call-1", "read", "read"))

    const state = await createToolExecutionProjection(store, sessionId).replay()
    store.close()

    expect(state.toolCount).toBe(4)
    expect(state.tools["runtime-launch"]).toMatchObject({
      toolUseId: "runtime-launch",
      toolName: "workflow",
      status: "called",
      executionMode: "background",
      traceKind: "subagent",
      childHasOwnViewport: true,
      input: {
        source: { kind: "registered", definition_id: "implementation" },
        summary: "Implement sessions",
        description: "Implement the approved sessions design.",
        cwd: "worktree",
      },
      runtimeOrigin: {
        initiator: "person",
        parentConversationId: "conversation-1",
        parentEntryId: "entry-1",
        operation: { kind: "launch" },
      },
    })
    expect(state.tools["runtime-adoption"]).toMatchObject({
      toolUseId: "runtime-adoption",
      toolName: "workflow",
      status: "called",
      input: { workflow_session_id: "existing-workflow" },
      runtimeOrigin: {
        initiator: "migration",
        parentConversationId: "conversation-1",
        parentEntryId: "entry-2",
        operation: { kind: "adoption", workflowSessionId: "existing-workflow" },
      },
    })
    // A version-1 adoption, as an earlier build wrote it, has no words, so
    // its input names only the workflow. A version-2 adoption reads like a launch.
    expect(state.tools["runtime-adoption"]?.input).toEqual({ workflow_session_id: "existing-workflow" })
    expect(state.tools["runtime-adoption-named"]?.input).toEqual({
      workflow_session_id: "named-workflow", source: { kind: "registered", definition_id: "implementation" }, summary: "Adopted goal",
    })
    expect(state.tools["runtime-launch"]?.modelRequestId).toBeUndefined()
    expect(state.tools["runtime-launch"]?.providerCallId).toBeUndefined()
    expect(state.tools["agent-tool"]).toMatchObject({
      modelRequestId: "request-1",
      providerCallId: "provider-call-1",
      providerToolName: "read",
    })
    expect(state.tools["agent-tool"]?.runtimeOrigin).toBeUndefined()
  })

  it("rejects a runtime workflow adoption with non-migration provenance", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const sessionId = "runtime-workflow-invalid-adoption"
    store.append({
      aggregateId: `session:${sessionId}`,
      type: "tool.runtime_invocation.recorded",
      version: 1,
      timestamp: Date.now(),
      actor: "flywheel",
      sessionId,
      payload: {
        toolUseId: "runtime-adoption",
        initiator: "person",
        parentConversationId: "conversation-1",
        parentEntryId: "entry-1",
        operation: { kind: "adoption", workflowSessionId: "existing-workflow" },
      },
    })

    await expect(createToolExecutionProjection(store, sessionId).replay()).rejects.toBeInstanceOf(InvariantViolation)
    store.close()
  })

  it("rebuilds a tool timeline with causation and result content policy", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const sessionId = "tool-execution-1"

    appendFact(store, sessionId, {
      type: "tool.input.completed",
      version: 1,
      actor: "agent",
      payload: {
        toolUseId: "tool-1",
        toolName: "read",
        input: { path: "src/main.ts" },
        inputBytes: 22,
        inputSha256: "input-hash",
        inputPreview: "{\"path\":\"src/main.ts\"}",
        executionMode: "foreground",
        traceKind: "tool",
        childHasOwnViewport: false,
        modelRequestId: "request-1",
      },
    })
    appendFact(store, sessionId, {
      type: "tool.result.recorded",
      version: 1,
      actor: "flywheel",
      payload: {
        toolUseId: "tool-1",
        outcome: "ok",
        contentBytes: 13,
        contentSha256: "content-hash",
        contentPreview: "file contents",
        contentTruncated: true,
        originalContentBytes: 60_000,
        originalContentSha256: "original-hash",
        fullContentPath: "/scratch/full-output.txt",
        semanticOutputTruncated: true,
        byteOutputTruncated: false,
        modelRequestId: "request-1",
      },
    })
    appendFact(store, sessionId, {
      type: "tool.result.acknowledged",
      version: 1,
      actor: "provider",
      payload: { toolUseId: "tool-1", modelRequestId: "request-1" },
    })
    appendFact(store, sessionId, {
      type: "tool.validation.failed",
      version: 1,
      actor: "flywheel",
      payload: {
        toolUseId: "tool-2",
        toolName: "write",
        input: { path: "forbidden.ts" },
        inputBytes: 23,
        inputSha256: "blocked-input-hash",
        inputPreview: "{\"path\":\"forbidden.ts\"}",
        executionMode: "foreground",
        traceKind: "tool",
        childHasOwnViewport: false,
        reason: "write blocked",
        modelRequestId: "request-2",
      },
    })

    const state = await createToolExecutionProjection(store, sessionId).replay()
    store.close()

    expect(state.toolCount).toBe(2)
    expect(state.completedCount).toBe(1)
    expect(state.failedCount).toBe(0)
    expect(state.validationFailureCount).toBe(1)
    expect(toolExecutionTimelineFromProjection(state).map((entry) => [entry.toolUseId, entry.status])).toEqual([
      ["tool-1", "completed"],
      ["tool-2", "validation_failed"],
    ])
    expect(state.tools["tool-1"]).toMatchObject({
      toolUseId: "tool-1",
      toolName: "read",
      status: "completed",
      modelRequestId: "request-1",
      contentBytes: 13,
      originalContentBytes: 60_000,
      fullContentPath: "/scratch/full-output.txt",
      semanticOutputTruncated: true,
      byteOutputTruncated: false,
    })
    expect(state.tools["tool-2"]).toMatchObject({
      toolUseId: "tool-2",
      toolName: "write",
      status: "validation_failed",
      modelRequestId: "request-2",
      validationReason: "write blocked",
    })
  })

  it("validates durable execution output without duplicating it into projection state", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const sessionId = "tool-execution-output"
    appendFact(store, sessionId, {
      type: "tool.input.completed",
      version: 1,
      actor: "agent",
      payload: {
        toolUseId: "tool-1",
        toolName: "bash",
        input: { command: "echo done" },
        inputBytes: 23,
        inputSha256: "input-hash",
        inputPreview: "{\"command\":\"echo done\"}",
        executionMode: "foreground",
        traceKind: "tool",
        childHasOwnViewport: false,
      },
    })
    appendFact(store, sessionId, {
      type: "tool.result.recorded",
      version: 1,
      actor: "flywheel",
      payload: {
        toolUseId: "tool-1",
        outcome: "ok",
        contentBytes: 4,
        contentSha256: "result-hash",
        contentPreview: "done",
      },
    })
    appendFact(store, sessionId, {
      type: "tool.execution_output.recorded",
      version: 1,
      actor: "flywheel",
      payload: { toolUseId: "tool-1", output: "durable tail\n" },
    })

    const state = await createToolExecutionProjection(store, sessionId).replay()
    store.close()

    expect({
      toolCount: state.toolCount,
      completedCount: state.completedCount,
      failedCount: state.failedCount,
      status: state.tools["tool-1"]?.status,
      contentBytes: state.tools["tool-1"]?.contentBytes,
      contentSha256: state.tools["tool-1"]?.contentSha256,
      contentPreview: state.tools["tool-1"]?.contentPreview,
    }).toEqual({
      toolCount: 1,
      completedCount: 1,
      failedCount: 0,
      status: "completed",
      contentBytes: 4,
      contentSha256: "result-hash",
      contentPreview: "done",
    })
  })

  it("rebuilds a tool whose input fact was lost from its execution output and marks the gap", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const sessionId = "tool-execution-output-orphan"
    appendFact(store, sessionId, {
      type: "tool.execution_output.recorded",
      version: 1,
      actor: "flywheel",
      payload: { toolUseId: "ghost-tool", output: "tail\n" },
    })

    const state = await createToolExecutionProjection(store, sessionId).replay()
    store.close()
    expect(state.tools["ghost-tool"]).toMatchObject({ toolName: "unrecorded", inputUnrecorded: true, status: "called" })
    expect(state.toolCount).toBe(1)
  })

  it("rebuilds a tool whose input fact was lost from its result and keeps the recorded outcome", async () => {
    // The executor of 2026-09-17 died with the input fact's write rejected and
    // the result committed two seconds later; the session must still open.
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const sessionId = "tool-orphan-1"
    appendFact(store, sessionId, {
      type: "tool.result.recorded",
      version: 1,
      actor: "flywheel",
      payload: {
        toolUseId: "ghost-tool",
        outcome: "ok",
        modelRequestId: "request-1",
      },
    })

    const state = await createToolExecutionProjection(store, sessionId).replay()
    store.close()
    expect(state.tools["ghost-tool"]).toMatchObject({
      toolName: "unrecorded", inputUnrecorded: true, status: "completed", resultOutcome: "ok", modelRequestId: "request-1",
    })
    expect(state.toolCount).toBe(1)
    expect(state.completedCount).toBe(1)
  })

  it("persists canonical provider and executable identities while allowing provider ids across requests", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const sessionId = "tool-identity-v2"
    appendFact(store, sessionId, inputFactV2("canonical-a", "request-a", "provider-call", "Bash", "bash"))
    appendFact(store, sessionId, resultFactV2("canonical-a", "request-a"))
    appendFact(store, sessionId, inputFactV2("canonical-b", "request-b", "provider-call", "Bash", "bash"))

    const state = await createToolExecutionProjection(store, sessionId).replay()
    store.close()

    expect(state.tools["canonical-a"]).toMatchObject({
      providerCallId: "provider-call",
      providerToolName: "Bash",
      toolUseId: "canonical-a",
      toolName: "bash",
      modelRequestId: "request-a",
      status: "completed",
    })
    expect(state.tools["canonical-b"]?.status).toBe("called")
  })

  // A terminal fact that omits modelRequestId asserts nothing and is
  // tolerated (see the identity-projection tests): durable ledgers exist with
  // identity-less follow-up facts, and a reader that throws on them loses the
  // session. Only conflicting asserted identity fails closed.
  it("fails closed for conflicting provider aliases and terminal request identity", async () => {
    const cases: readonly [string, SessionRuntimeFact[]][] = [
      ["provider alias", [
        inputFactV2("canonical-a", "request", "provider-call", "Bash", "bash"),
        inputFactV2("canonical-b", "request", "provider-call", "Bash", "bash"),
      ]],
      ["canonical alias", [
        inputFactV2("canonical", "request-a", "provider-a", "Bash", "bash"),
        inputFactV2("canonical", "request-b", "provider-b", "exec", "exec"),
      ]],
    ]
    for (const [name, facts] of cases) {
      const caseStore = createSqliteEventStore(resolveEventStoreDbFile(makeTmpDir()))
      for (const fact of facts) appendFact(caseStore, name, fact)
      await expect(createToolExecutionProjection(caseStore, name).replay()).rejects.toThrow(InvariantViolation)
      caseStore.close()
    }
  })

  it("still throws when the result fact asserts a different modelRequestId", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const sessionId = "tool-parity-mismatch"
    appendFact(store, sessionId, {
      type: "tool.input.completed",
      version: 1,
      actor: "agent",
      payload: {
        toolUseId: "tool-x",
        toolName: "read",
        input: { path: "a.ts" },
        inputBytes: 15,
        inputSha256: "x-input-hash",
        inputPreview: "{\"path\":\"a.ts\"}",
        executionMode: "foreground",
        traceKind: "tool",
        childHasOwnViewport: false,
        modelRequestId: "request-a",
      },
    })
    appendFact(store, sessionId, {
      type: "tool.result.recorded",
      version: 1,
      actor: "flywheel",
      payload: {
        toolUseId: "tool-x",
        outcome: "ok",
        modelRequestId: "request-b",
      },
    })

    await expect(createToolExecutionProjection(store, sessionId).replay()).rejects.toThrow(InvariantViolation)
    store.close()
  })

  it("rebuilds a tool whose input fact was lost from its acknowledgement", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const sessionId = "tool-orphan-2"
    appendFact(store, sessionId, {
      type: "tool.result.acknowledged",
      version: 1,
      actor: "provider",
      payload: { toolUseId: "phantom" },
    })

    const state = await createToolExecutionProjection(store, sessionId).replay()
    store.close()
    expect(state.tools.phantom).toMatchObject({ toolName: "unrecorded", inputUnrecorded: true, status: "called" })
    expect(state.tools.phantom?.acknowledgedAt).toBeNumber()
  })

  it("activeSubagentIds includes in-flight subagents and excludes workflow launches", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const sessionId = "active-subagents-1"

    // Subagent in flight (called, not yet completed).
    appendFact(store, sessionId, {
      type: "tool.input.completed",
      version: 1,
      actor: "agent",
      payload: {
        toolUseId: "sub-1",
        toolName: "subagent",
        input: { description: "research", prompt: "" },
        inputBytes: 0,
        inputSha256: "h",
        inputPreview: "{}",
        executionMode: "background",
        traceKind: "subagent",
        childHasOwnViewport: false,
      },
    })
    // Workflow launch in flight — excluded by childHasOwnViewport.
    appendFact(store, sessionId, {
      type: "tool.input.completed",
      version: 1,
      actor: "agent",
      payload: {
        toolUseId: "wf-1",
        toolName: "workflow",
        input: { workflow_definition_id: "demo" },
        inputBytes: 0,
        inputSha256: "h",
        inputPreview: "{}",
        executionMode: "background",
        traceKind: "subagent",
        childHasOwnViewport: true,
      },
    })
    // Inline tool in flight — excluded by traceKind.
    appendFact(store, sessionId, {
      type: "tool.input.completed",
      version: 1,
      actor: "agent",
      payload: {
        toolUseId: "read-1",
        toolName: "read",
        input: { path: "a.ts" },
        inputBytes: 0,
        inputSha256: "h",
        inputPreview: "{}",
        executionMode: "foreground",
        traceKind: "tool",
        childHasOwnViewport: false,
      },
    })
    // Subagent that already completed — excluded.
    appendFact(store, sessionId, {
      type: "tool.input.completed",
      version: 1,
      actor: "agent",
      payload: {
        toolUseId: "sub-done",
        toolName: "subagent",
        input: { description: "old", prompt: "" },
        inputBytes: 0,
        inputSha256: "h",
        inputPreview: "{}",
        executionMode: "background",
        traceKind: "subagent",
        childHasOwnViewport: false,
      },
    })
    appendFact(store, sessionId, {
      type: "tool.result.recorded",
      version: 1,
      actor: "flywheel",
      payload: { toolUseId: "sub-done", outcome: "ok" },
    })

    const state = await createToolExecutionProjection(store, sessionId).replay()
    store.close()

    const ids = activeSubagentIds(state)
    expect([...ids].sort()).toEqual(["sub-1"])
  })
})

describe("tool execution projection scale", () => {
  it("keeps the tools index stable while folding a large provider call history", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(makeTmpDir()))
    const sessionId = "provider-alias-scale"
    store.transaction(() => {
      for (let index = 0; index < 2_000; index += 1) {
        appendFact(store, sessionId, inputFactV2(`tool-${index}`, `request-${index}`, `call-${index}`, "read", "read"))
      }
    })

    const projection = createToolExecutionProjection(store, sessionId)
    await projection.replay()
    const tools = projection.getState().tools
    appendFact(store, sessionId, inputFactV2("tool-last", "request-last", "call-last", "read", "read"))
    const state = await projection.replay()
    store.close()

    expect(state.toolCount).toBe(2_001)
    expect(state.tools).toBe(tools)
  })
})


function inputFactV2(
  toolUseId: string,
  modelRequestId: string,
  providerCallId: string,
  providerToolName: string,
  toolName: string,
): SessionRuntimeFact {
  return {
    type: "tool.input.completed", version: 2, actor: "agent",
    payload: {
      toolUseId, providerCallId, providerToolName, toolName, modelRequestId,
      input: {}, inputBytes: 2, inputSha256: "hash", inputPreview: "{}",
      executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false,
    },
  }
}

function resultFactV2(toolUseId: string, modelRequestId: string): SessionRuntimeFact {
  return { type: "tool.result.recorded", version: 1, actor: "flywheel", payload: { toolUseId, modelRequestId, outcome: "ok" } }
}

describe("tool execution projection - repeated terminal evidence", () => {
  const input = (sessionId: string, store: EventStore): void => appendFact(store, sessionId, {
    type: "tool.input.completed",
    version: 1,
    actor: "agent",
    payload: { toolUseId: "tool-dup", toolName: "search", input: { pattern: "x" }, inputBytes: 15, inputSha256: "a".repeat(64), inputPreview: "{}", executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false },
  })

  it("lets a real outcome replace the interrupted guess written by crash recovery", async () => {
    // Incident 2026-09-08: two runtimes shared one store. Crash recovery wrote
    // "interrupted" for a call that a live writer then finished. The real
    // outcome is the truth, so it becomes the entry's terminal evidence.
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const sessionId = "tool-dup-interrupted-ok"
    input(sessionId, store)
    appendFact(store, sessionId, { type: "tool.result.recorded", version: 1, actor: "flywheel", payload: { toolUseId: "tool-dup", outcome: "interrupted", contentPreview: "Interrupted: the session restarted before this tool call completed." } })
    appendFact(store, sessionId, { type: "tool.result.recorded", version: 1, actor: "flywheel", payload: { toolUseId: "tool-dup", outcome: "ok", contentPreview: "3 matches" } })

    const state = await createToolExecutionProjection(store, sessionId).replay()
    const results = store.read({ aggregateId: `session:${sessionId}`, types: ["tool.result.recorded"] })
    store.close()

    expect(state.tools["tool-dup"]).toMatchObject({
      status: "completed",
      resultOutcome: "ok",
      contentPreview: "3 matches",
      resultEventId: results[1]?.id,
    })
    expect({ completed: state.completedCount, failed: state.failedCount }).toEqual({ completed: 1, failed: 0 })
  })

  it("counts a failing outcome that replaces the interrupted guess exactly once", async () => {
    const store = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
    const sessionId = "tool-dup-interrupted-error"
    input(sessionId, store)
    appendFact(store, sessionId, { type: "tool.result.recorded", version: 1, actor: "flywheel", payload: { toolUseId: "tool-dup", outcome: "interrupted", contentPreview: "Interrupted: the session restarted before this tool call completed." } })
    appendFact(store, sessionId, { type: "tool.result.recorded", version: 1, actor: "flywheel", payload: { toolUseId: "tool-dup", outcome: "error", contentPreview: "search failed" } })

    const state = await createToolExecutionProjection(store, sessionId).replay()
    store.close()

    expect(state.tools["tool-dup"]).toMatchObject({ status: "failed", resultOutcome: "error", contentPreview: "search failed" })
    expect({ completed: state.completedCount, failed: state.failedCount }).toEqual({ completed: 1, failed: 1 })
  })

})
