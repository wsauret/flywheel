import { afterEach, beforeEach, expect, it } from "bun:test"
import { asAsyncEventReadSurface, asAsyncEventWriter, type EventStore, type EventStoreAppend } from "../../../../src/infra/event-store-types"
import type { AnyBlock } from "../../../../src/infra/output-blocks"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import { createTranscriptProjectionCache } from "../../../../src/orchestration/app-service/transcript-projection-cache"
import { createSessionManager } from "../../../../src/orchestration/session/manager"
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle"
import { temporaryDirectories } from "../../../helpers/directories"

const directories = temporaryDirectories()
let baseDir: string
let store: EventStore
beforeEach(() => {
  baseDir = directories("subagent-summary-")
  store = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
})
afterEach(async () => { await store.close() })

function append(sessionId: string, fact: Omit<EventStoreAppend, "aggregateId" | "sessionId" | "timestamp">) {
  return store.append({ ...fact, aggregateId: `session:${sessionId}`, sessionId, timestamp: Date.now() })
}

it.each([
  ["partial", "completed", "Finished all remaining work"],
  ["failed", "completed", "Finished all remaining work"],
  ["partial", "completed", undefined],
  ["failed", "completed", undefined],
  ["partial", "partial", "Finished all remaining work"],
  ["partial", "partial", undefined],
] as const)("states the selected handoff after a person resumes a %s child as %s (summary=%s)", async (earlierStatus, laterStatus, expected) => {
  const manager = createSessionManager({ projectRoot: baseDir, executionCwd: baseDir, store })
  const sessionId = await manager.createChat({ name: "Chat" })
  const conversationId = (await manager.listMetadata()).sessions.find((session) => session.id === sessionId)?.conversationId
  if (!conversationId) throw new Error("Missing parent conversation")
  const childId = `${sessionId}-child`
  const input = { persona: "explorer", description: "Finish the work" }
  const originalContent = JSON.stringify({ summary: "Earlier partial work. More remains." })
  append(sessionId, { type: "tool.input.completed", version: 1, actor: "agent", payload: {
    toolUseId: "dispatch", toolName: "subagent", input, inputBytes: 2, inputSha256: "sha", inputPreview: "{}",
    executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false,
  } })
  append(sessionId, { type: "tool.result.recorded", version: 1, actor: "flywheel", payload: { toolUseId: "dispatch", outcome: earlierStatus === "failed" ? "error" : "ok" } })
  append(sessionId, { type: "session.child.linked", version: 1, actor: "flywheel", payload: { childSessionId: childId, lastUpdated: new Date().toISOString() } })
  const tree = await tryOpenConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
  if (!tree) throw new Error("Missing parent conversation")
  await tree.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id: "dispatch", name: "subagent", input }] })
  await tree.appendMessage({ kind: "toolResult", toolUseId: "dispatch", content: [{ type: "text", text: originalContent }] })
  tree.getStorage().dispose()
  const createAttempt = (childRunId: string) => append(childId, { type: "child_run.created", version: 2, actor: "flywheel", payload: {
    childSessionId: childId, childRunId, conversationId: `${childId}-conversation`, parentSessionId: sessionId, parentConversationId: conversationId, parentToolCallId: "dispatch",
    persona: { name: "explorer", kind: "persona" }, capabilityGrant: { operation: "subagent", required: [], capabilities: [], moduleIds: [], requireWorkflowConfirmation: false, workflowsMode: "off", identity: childRunId },
    admittedModuleIds: [], skillsRevision: 0, model: "test", tools: [], executionCwd: baseDir, budget: { maxTurns: 1, maxTokens: 1 }, parentDepth: 0, description: "Finish the work",
  } })
  const completeAttempt = (childRunId: string, status: "partial" | "failed" | "completed", content: string) => append(childId, { type: "subagent.completed", version: 5, actor: "flywheel", payload: {
    childRunId, status, isError: status === "failed", durationMs: 10, result: content, resultBytes: content.length, resultSha256: "sha", resultPreview: content,
  } })
  createAttempt("first")
  completeAttempt("first", earlierStatus, originalContent)
  const reader = asAsyncEventReadSurface(store)
  const cache = createTranscriptProjectionCache({ reader, projectionReader: reader, sessionStore: { get: () => undefined }, projectRoot: baseDir })
  const live: AnyBlock = { kind: "agentGroup", containerKind: "subagent", id: "dispatch", toolUseId: "dispatch",
    label: "Explorer", description: "Finish the work", status: "partial", summary: "Earlier partial work", children: [], totalToolCount: 0, timestamp: 1 }
  try {
    await cache.projectBlock(sessionId, live)
    await cache.read(sessionId, conversationId, baseDir)
    createAttempt("second")
    completeAttempt("second", laterStatus, JSON.stringify({ summary: expected === undefined ? 42 : "**Finished** all remaining work. Tests pass." }))
    const resident = await cache.projectBlock(sessionId, live)
    const history = await cache.read(sessionId, conversationId, baseDir)
    const saved = await history?.readBlock(history.indexOf("tool:dispatch"))
    for (const block of [resident, saved]) {
      expect(block).toMatchObject({ kind: "agentGroup", status: laterStatus })
      expect(block?.kind === "agentGroup" ? block.summary : "missing card").toBe(expected)
    }
  } finally { await cache.dispose() }
})
