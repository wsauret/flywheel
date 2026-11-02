import { afterEach, beforeEach, expect, it } from "bun:test"
import { asAsyncEventReadSurface, asAsyncEventWriter, type EventStore, type EventStoreAppend } from "../../../../src/infra/event-store-types"
import type { AnyBlock } from "../../../../src/infra/output-blocks"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import { createTranscriptProjectionCache } from "../../../../src/orchestration/app-service/transcript-projection-cache"
import { createSessionManager } from "../../../../src/orchestration/session/manager"
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle"
import { temporaryDirectories } from "../../../helpers/directories"
import { countStateRequests } from "../../../helpers/state-requests"

const directories = temporaryDirectories()
let baseDir: string
let store: EventStore
beforeEach(() => {
  baseDir = directories("transcript-child-work-count-")
  store = createSqliteEventStore(resolveEventStoreDbFile(baseDir))
})
afterEach(async () => { await store.close() })

async function createChat() {
  const manager = createSessionManager({ projectRoot: baseDir, executionCwd: baseDir, store })
  const sessionId = await manager.createChat({ name: "Chat" })
  const conversationId = (await manager.listMetadata()).sessions.find((session) => session.id === sessionId)?.conversationId
  if (!conversationId) throw new Error("missing conversation id")
  return { sessionId, conversationId }
}
function appendSessionFact(sessionId: string, fact: Omit<EventStoreAppend, "aggregateId" | "sessionId" | "timestamp">) {
  return store.append({ ...fact, aggregateId: `session:${sessionId}`, sessionId, timestamp: Date.now() })
}

it.each([3, 30])("materializes one newest child for each card change with %s earlier operations", async (historyLength) => {
  const { sessionId } = await createChat()
  const childId = `${sessionId}-child`
  const operationPositions = new Set<number>()
  const appendOperation = (index: number) => {
    const fact = appendSessionFact(childId, { type: "tool.input.completed", version: 1, actor: "agent", payload: {
      toolUseId: `read-${index}`, toolName: "read", input: { path: `file-${index}.ts` }, inputBytes: 2, inputSha256: "sha", inputPreview: "{}",
      executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false,
    } })
    operationPositions.add(fact.position)
  }
  for (let index = 0; index < historyLength; index++) appendOperation(index)
  const { reader, take } = countStateRequests(asAsyncEventReadSurface(store))
  const cache = createTranscriptProjectionCache({ reader, projectionReader: reader, sessionStore: { get: () => undefined }, projectRoot: baseDir })
  const card: AnyBlock = { kind: "agentGroup", containerKind: "subagent", id: "dispatch", toolUseId: "dispatch", label: "Explorer", description: "Read files",
    children: [], totalToolCount: 0, status: "active", timestamp: 1, linkUri: `flywheel://session/${childId}`, model: "test" }
  try {
    for (let change = 0; change < 3; change++) {
      if (change > 0) appendOperation(historyLength + change - 1)
      const projected = await cache.projectBlock(sessionId, card)
      expect(projected).toMatchObject({ activity: { name: "Read", detail: `file-${historyLength + change - 1}.ts` } })
      expect(projected.kind === "agentGroup" && projected.children).toHaveLength(1)
      const materialized = take().flatMap((request) => request.query?.positions ?? []).filter((position) => operationPositions.has(position))
      expect(materialized).toHaveLength(1)
    }
  } finally { await cache.dispose() }
})

it("reads every child session its cards link in a fixed number of reads, not in reads for each child", async () => {
  // A chat with hundreds of subagents opens through the state Worker, where each read is a round trip.
  async function readsFor(children: number): Promise<number> {
    const { sessionId, conversationId } = await createChat()
    const tree = await tryOpenConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
    if (!tree) throw new Error("Missing parent conversation")
    for (let index = 0; index < children; index += 1) {
      const id = `dispatch-${index}`
      const childSessionId = `${sessionId}-child-${index}`
      const input = { kind: "dispatch", persona: "explorer", description: "Read files" }
      appendSessionFact(sessionId, { type: "tool.input.completed", version: 1, actor: "agent", payload: {
        toolUseId: id, toolName: "subagent", input, inputBytes: 2, inputSha256: "sha", inputPreview: "{}", executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false,
      } })
      appendSessionFact(sessionId, { type: "tool.result.recorded", version: 1, actor: "flywheel", payload: { toolUseId: id, outcome: "ok" } })
      await tree.appendMessage({ kind: "assistant", content: [{ type: "tool_use", id, name: "subagent", input }] })
      await tree.appendMessage({ kind: "toolResult", toolUseId: id, content: [{ type: "text", text: "done" }] })
      appendSessionFact(sessionId, { type: "session.child.linked", version: 1, actor: "flywheel", payload: { childSessionId, lastUpdated: new Date().toISOString() } })
      appendSessionFact(childSessionId, { type: "child_run.created", version: 2, actor: "flywheel", payload: {
        childSessionId, childRunId: id, conversationId: `${childSessionId}-conversation`, parentSessionId: sessionId, parentConversationId: conversationId, parentToolCallId: id,
        persona: { name: "explorer", kind: "persona" }, capabilityGrant: { operation: "subagent", required: [], capabilities: [], moduleIds: [], requireWorkflowConfirmation: false, workflowsMode: "off", identity: id },
        admittedModuleIds: [], skillsRevision: 0, model: "test", tools: [], executionCwd: baseDir, budget: { maxTurns: 1, maxTokens: 1 }, parentDepth: 0, description: "Read files",
      } })
      appendSessionFact(childSessionId, { type: "tool.input.completed", version: 1, actor: "agent", payload: {
        toolUseId: `${childSessionId}-read`, toolName: "read", input: { path: "a" }, inputBytes: 2, inputSha256: "sha", inputPreview: "{}", executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false,
      } })
      appendSessionFact(childSessionId, { type: "subagent.completed", version: 5, actor: "flywheel", payload: {
        childRunId: id, status: "completed", isError: false, durationMs: 10, totalTokens: 20, toolUses: 1, result: "Done", resultBytes: 4, resultSha256: "sha", resultPreview: "Done",
      } })
    }
    tree.getStorage().dispose()
    const { reader: counted, take } = countStateRequests(asAsyncEventReadSurface(store))
    const cache = createTranscriptProjectionCache({ reader: counted, projectionReader: counted, sessionStore: { get: () => undefined }, projectRoot: baseDir })
    try {
      const history = await cache.read(sessionId, conversationId, baseDir)
      const card = await history?.readBlock(history.indexOf("tool:dispatch-0"))
      expect(card).toMatchObject({ kind: "agentGroup", status: "completed", totalToolCount: 1 })
      expect((await history?.groupChildren("tool:dispatch-0"))?.blockCount).toBe(1)
      return take().length
    } finally { await cache.dispose() }
  }
  expect(await readsFor(6)).toBe(await readsFor(1))
})
