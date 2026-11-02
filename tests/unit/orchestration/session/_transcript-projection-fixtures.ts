import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncGuardedEventWriter, type EventStore, type EventStoreAppend } from "../../../../src/infra/event-store-types"
import { createSessionManager } from "../../../../src/orchestration/session/manager"
import type { IndexedTranscript } from "../../../../src/orchestration/session/conversation/branch-history-builder"
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle"
import { beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { workflowParentBinding } from "../../../helpers/workflow-parent.js"
import { publishTestWorkflow } from "./_session-manager-fixtures"

export function transcriptStores(accept: (store: EventStore, directory: string) => void): void {
  let directory: string
  let store: EventStore
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "flywheel-transcript-projection-"))
    store = createSqliteEventStore(resolveEventStoreDbFile(directory))
    accept(store, directory)
  })
  afterEach(async () => {
    await store.close()
    rmSync(directory, { recursive: true, force: true })
  })
}

export async function openExistingTree(options: Omit<Parameters<typeof tryOpenConversationTree>[0], "store"> & { store: EventStore }) {
  const tree = await tryOpenConversationTree({ ...options, store: asAsyncEventReadSurface(options.store), writer: options.writer ?? asAsyncEventWriter(options.store) })
  if (!tree) throw new Error(`expected conversation tree ${options.conversationId}`)
  return tree
}

export async function blocks(history: IndexedTranscript | null) {
  return history ? Promise.all(Array.from({ length: history.blockCount }, (_, index) => history.readBlock(index))) : []
}

export function transcriptFixture(currentStore: () => EventStore, directory: () => string) {
  async function createChat(): Promise<{ sessionId: string; conversationId: string }> {
    const manager = createSessionManager({ projectRoot: directory(), executionCwd: directory(), store: currentStore() })
    const sessionId = await manager.createChat({ name: "Chat" })
    const conversationId = (await manager.listMetadata()).sessions.find((session) => session.id === sessionId)?.conversationId
    if (!conversationId) throw new Error("missing conversation id")
    return { sessionId, conversationId }
  }
  function immediateWriter(): AsyncGuardedEventWriter {
    const store = currentStore()
    return {
      append: async (event) => store.append(event),
      appendBatch: async (events) => store.appendBatch(events),
      appendGuarded: async (event) => store.appendGuarded(event),
      appendBatchGuarded: async (events) => store.appendBatchGuarded(events),
      pruneSupersededEvents: async () => 0,
    }
  }
  async function publishWorkflowBinding(parentSessionId: string, conversationId: string, toolUseId: string, adopted = false, name = "Workflow"): Promise<string> {
    const manager = createSessionManager({ projectRoot: directory(), executionCwd: directory(), store: currentStore() })
    const childId = `workflow-child-${toolUseId}`
    // An adopted workflow starts below another chat and moves to this parent.
    const launchedFrom = adopted
      ? await workflowParentBinding(manager, { workflowDefinitionId: "implementation" })
      : { parentSessionId, conversationId, toolUseId }
    await publishTestWorkflow(manager, { id: childId, name, workflowDefinitionId: "implementation", initialRoles: {}, launchedFrom })
    if (adopted) await manager.adoptWorkflow({ workflowId: childId, launchedFrom: { parentSessionId, conversationId, toolUseId } })
    return childId
  }
  function appendSessionFact(sessionId: string, fact: Omit<EventStoreAppend, "aggregateId" | "sessionId" | "timestamp">): void {
    currentStore().append({ ...fact, aggregateId: `session:${sessionId}`, sessionId, timestamp: Date.now() })
  }
  function appendCreatedSubagent(sessionId: string, toolUseId: string): void {
    appendSessionFact(sessionId, {
      type: "child_run.created",
      version: 1,
      actor: "flywheel",
      payload: {
        childRunId: `child-${toolUseId}`,
        kind: "subagent",
        toolUseId,
        agentType: "explorer",
        description: "Locate it",
        model: "test-model",
        maxTurns: 3,
        tools: ["read"],
      },
    })
  }
  function appendSubagentCompletion(sessionId: string, toolUseId: string): void {
    appendSessionFact(sessionId, {
      type: "subagent.completed",
      version: 1,
      actor: "flywheel",
      payload: {
        childRunId: `child-${toolUseId}`,
        status: "completed",
        isError: false,
        durationMs: 25,
        toolUses: 2,
        totalTokens: 30,
        resultBytes: 4,
        resultSha256: "sha",
        resultPreview: "done",
      },
    })
  }
  function appendCompletedSubagent(sessionId: string, toolUseId: string): void {
    appendCreatedSubagent(sessionId, toolUseId)
    appendSubagentCompletion(sessionId, toolUseId)
  }
  return { createChat, immediateWriter, publishWorkflowBinding, appendSessionFact, appendCreatedSubagent, appendSubagentCompletion, appendCompletedSubagent }
}
