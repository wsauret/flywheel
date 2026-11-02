import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ManagedRuntime } from "effect"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types.js"
import { EventReaderService, EventStoreLive, LocalEventStoreService } from "../../../../src/infra/event-store-effect.js"
import { blockIdentity } from "../../../../src/protocol/block-identity.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { isVisibleMessageBlock, type AnyBlock } from "../../../../src/infra/output-blocks.js"
import type { ConversationMessage } from "../../../../src/orchestration/agent-runtime/llm/types.js"
import { createRuntimeSupervisor as createRuntimeSupervisorBase } from "../../../../src/orchestration/app-service/runtime-supervisor.js"
import { createSessionManager } from "../../../../src/orchestration/session/manager.js"
import { createContinuationLanes } from "../../../../src/orchestration/session/planned-session-continuation.js"
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle.js"
import { SessionTranscriptProjection } from "../../../../src/orchestration/session/conversation/transcript-projection.js"
import { createSessionStore } from "../../../../src/orchestration/session-store/store.js"
import { createWorkflowHosts } from "../../../../src/orchestration/modules/workflows/host-collection.js"
import { childSessionProjectionAttachment } from "../../../../src/orchestration/session-store/child-session-projection.js"
import { loadSessionView } from "../../../../src/orchestration/session-store/view.js"
import { mockRunner, supervisorBaseDeps } from "../../../fixtures/runtime-supervisor-fixtures.js"

const createRuntimeSupervisor = createRuntimeSupervisorBase


async function openExistingTree(options: Parameters<typeof tryOpenConversationTree>[0]) {
  const tree = await tryOpenConversationTree(options)
  if (!tree) throw new Error(`expected conversation tree ${options.conversationId}`)
  return tree
}

describe("RuntimeSupervisor re-activation across SQLite reopen cycles", () => {
  test("durable chat survives two fresh SQLite reopen cycles and one appended turn", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "flywheel-reactivation-reopen-cycle-"))
    const sessionId = "reactivation-reopen-cycle"
    const initialMessages: ConversationMessage[] = Array.from({ length: 70 }, (_, index) => ({ kind: "user", content: `durable-${index}` }))

    function openCycle() {
      const runtime = ManagedRuntime.make(EventStoreLive(resolveEventStoreDbFile(baseDir)))
      const store = runtime.runSync(LocalEventStoreService)
      const manager = createSessionManager({ projectRoot: baseDir, executionCwd: baseDir, store })
      const sessionStore = createSessionStore(runtime, runtime.runSync(EventReaderService))
      const workflowHosts = createWorkflowHosts({ runtime, projectionReader: runtime.runSync(EventReaderService), attachChildProjection: childSessionProjectionAttachment(sessionStore) })
      const supervisor = createRuntimeSupervisor({
        ...supervisorBaseDeps({ baseDir, runtime, store, manager, sessionStore, workflowHosts, continuationLanes: createContinuationLanes() }, sessionStore, { createRunner: async (deps) => mockRunner(deps.sessionId) }),
        sessionViewLoader: { load: (id) => loadSessionView(id, asAsyncEventReadSurface(store), asAsyncEventReadSurface(store)) },
      })
      return { runtime, store, manager, sessionStore, supervisor }
    }

    async function fullBlocks(cycle: ReturnType<typeof openCycle>, conversationId: string) {
      const projection = new SessionTranscriptProjection({ conversationId, sessionId, store: asAsyncEventReadSurface(cycle.store), executionCwd: baseDir })
      try {
        const history = await projection.read()
        return history ? await Promise.all(Array.from({ length: history.blockCount }, (_, index) => history.readBlock(index))) : []
      } finally {
        await projection.dispose()
      }
    }

    let cycle = openCycle()
    try {
      await cycle.manager.createChat({ name: "Reopen Cycle", initialState: "inactive", id: sessionId })
      const session = await cycle.manager.read(sessionId)
      if (session?.kind !== "chat") throw new Error("missing durable reopen chat")
      const conversationId = session.conversationId
      const tree = await openExistingTree({ conversationId, sessionId, store: asAsyncEventReadSurface(cycle.store), writer: asAsyncEventWriter(cycle.store) })
      const appended = await tree.appendMessages(initialMessages)
      await tree.getStorage().dispose()
      if (appended.kind !== "committed") throw new Error(`initial append failed: ${appended.kind}`)

      expect(await cycle.supervisor.activateSession(sessionId)).toBe(true)
      const firstSeed = cycle.sessionStore.get(sessionId)
      expect(firstSeed?.outputBlocks()).toHaveLength(64)
      expect(firstSeed?.outputSequenceStart).toBe(6)
      const original = await fullBlocks(cycle, conversationId)
      expect(original).toHaveLength(70)
      expect(await cycle.supervisor.closeChat(sessionId)).toBe(true)
      await cycle.supervisor.disposeAll()
      await cycle.runtime.dispose()

      cycle = openCycle()
      expect(await cycle.supervisor.activateSession(sessionId)).toBe(true)
      expect(cycle.sessionStore.get(sessionId)?.outputBlocks()).toHaveLength(64)
      expect(cycle.sessionStore.get(sessionId)?.outputSequenceStart).toBe(6)
      const reopenedTree = await openExistingTree({ conversationId, sessionId, store: asAsyncEventReadSurface(cycle.store), writer: asAsyncEventWriter(cycle.store) })
      const suffixAppend = await reopenedTree.appendMessages([{ kind: "user", content: "durable-suffix" }])
      await reopenedTree.getStorage().dispose()
      if (suffixAppend.kind !== "committed") throw new Error(`suffix append failed: ${suffixAppend.kind}`)
      expect(await cycle.supervisor.closeChat(sessionId)).toBe(true)
      await cycle.supervisor.disposeAll()
      await cycle.runtime.dispose()

      cycle = openCycle()
      expect(await cycle.supervisor.activateSession(sessionId)).toBe(true)
      const finalSeed = cycle.sessionStore.get(sessionId)
      expect(finalSeed?.outputBlocks()).toHaveLength(64)
      expect(finalSeed?.outputSequenceStart).toBe(7)
      const final = await fullBlocks(cycle, conversationId)
      expect(final.slice(0, original.length)).toEqual(original)
      expect(final.slice(original.length)).toEqual([expect.objectContaining({ kind: "userMessage", content: "durable-suffix" })])
      const identityMultiplicity = new Map<string, number>()
      for (const block of final) identityMultiplicity.set(blockIdentity(block), (identityMultiplicity.get(blockIdentity(block)) ?? 0) + 1)
      expect(identityMultiplicity.size).toBe(71)
      expect([...identityMultiplicity.values()].every((count) => count === 1)).toBe(true)
      expect(final).toEqual(expect.arrayContaining(original))
      expect(cycle.store.read({ aggregateId: `session:${sessionId}`, types: ["output.log.indexed", "output.block.indexed", "output.chunk.recorded"] })).toHaveLength(0)
      await cycle.supervisor.closeChat(sessionId)
      await cycle.supervisor.disposeAll()
      await cycle.runtime.dispose()
    } finally {
      rmSync(baseDir, { recursive: true, force: true })
    }
  })

  test("explicit activation reconciles before attaching an idle runner and seeds the reconciled display", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "flywheel-reactivation-reconcile-"))
    const runtime = ManagedRuntime.make(EventStoreLive(resolveEventStoreDbFile(baseDir)))
    const store = runtime.runSync(LocalEventStoreService)
    const manager = createSessionManager({ projectRoot: baseDir, executionCwd: baseDir, store })
    const sessionStore = createSessionStore(runtime, runtime.runSync(EventReaderService))
    const workflowHosts = createWorkflowHosts({ runtime, projectionReader: runtime.runSync(EventReaderService), attachChildProjection: childSessionProjectionAttachment(sessionStore) })
    const sessionId = await manager.createChat({ id: "cold-parent", name: "Cold parent", initialState: "inactive" })
    const session = await manager.read(sessionId)
    if (session?.kind !== "chat") throw new Error("missing durable chat")
    const initialTree = await openExistingTree({ conversationId: session.conversationId, sessionId, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
    await initialTree.appendMessage({ kind: "user", content: "initial" })
    initialTree.getStorage().dispose()
    let runnerStarts = 0
    let reconciliations = 0
    const supervisor = createRuntimeSupervisor({
      ...supervisorBaseDeps({ baseDir, runtime, store, manager, sessionStore, workflowHosts, continuationLanes: createContinuationLanes() }, sessionStore, {
        createRunner: async (deps) => {
          runnerStarts += 1
          return mockRunner(deps.sessionId)
        },
        reconcileChildSessionCompletions: async () => {
          reconciliations += 1
          const tree = await openExistingTree({ conversationId: session.conversationId, sessionId, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
          await tree.appendMessage({ kind: "user", content: "reconciled completion" })
          tree.getStorage().dispose()
          return { reconciledCount: 1, workflowAggregateReads: 0 }
        },
      }),
      sessionViewLoader: { load: (id) => loadSessionView(id, asAsyncEventReadSurface(store), asAsyncEventReadSurface(store)) },
    })

    try {
      expect(await supervisor.activateSession(sessionId)).toBe(true)
      expect(reconciliations).toBe(1)
      expect(runnerStarts).toBe(1)
      expect(sessionStore.get(sessionId)?.outputBlocks()).toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: "userMessage", content: "reconciled completion" }),
      ]))
      // A resident chat is already reconciled, so a tab switch or reattach sweeps nothing.
      expect(await supervisor.activateSession(sessionId)).toBe(true)
      expect(await supervisor.activateSession(sessionId)).toBe(true)
      expect(reconciliations).toBe(1)
    } finally {
      await supervisor.disposeAll()
      await runtime.dispose()
      rmSync(baseDir, { recursive: true, force: true })
    }
  })

  test.each([
    ["streaming", { runnerState: "streaming", waitingOnBackgroundWork: false }],
    ["parked on a question", { runnerState: "awaiting_user", waitingOnBackgroundWork: false }],
    ["parked on background work", { runnerState: "idle", waitingOnBackgroundWork: true }],
  ] as const)("activating an open session keeps the display of a turn in flight (%s) and re-reads a display at rest from the log", async (_inFlight, turn) => {
    const baseDir = mkdtempSync(join(tmpdir(), "flywheel-reactivation-open-"))
    const runtime = ManagedRuntime.make(EventStoreLive(resolveEventStoreDbFile(baseDir)))
    const store = runtime.runSync(LocalEventStoreService)
    const manager = createSessionManager({ projectRoot: baseDir, executionCwd: baseDir, store })
    const sessionStore = createSessionStore(runtime, runtime.runSync(EventReaderService))
    const workflowHosts = createWorkflowHosts({ runtime, projectionReader: runtime.runSync(EventReaderService), attachChildProjection: childSessionProjectionAttachment(sessionStore) })
    const sessionId = await manager.createChat({ id: "open-chat", name: "Open chat", initialState: "inactive" })
    const session = await manager.read(sessionId)
    if (session?.kind !== "chat") throw new Error("missing durable chat")
    const commit = async (message: ConversationMessage) => {
      const tree = await openExistingTree({ conversationId: session.conversationId, sessionId, store: asAsyncEventReadSurface(store), writer: asAsyncEventWriter(store) })
      const appended = await tree.appendMessages([message])
      await tree.getStorage().dispose()
      if (appended.kind !== "committed") throw new Error(`tree append failed: ${appended.kind}`)
    }
    await commit({ kind: "user", content: "hello" })
    // An attached runner owns the display: it keeps its own block list, the
    // store shows what the runner last synced, and a seed replaces that list.
    let runnerBlocks: AnyBlock[] = []
    const syncRunnerDisplay = () => {
      sessionStore.updateChatEntry(sessionId, { outputBlocks: runnerBlocks, visibleMessageCountSuffix: runnerBlocks.filter(isVisibleMessageBlock).length })
    }
    const supervisor = createRuntimeSupervisor({
      ...supervisorBaseDeps({ baseDir, runtime, store, manager, sessionStore, workflowHosts, continuationLanes: createContinuationLanes() }, sessionStore, {
        createRunner: async (deps) => mockRunner(deps.sessionId, { seedDisplayBlocks: (blocks) => { runnerBlocks = [...blocks] } }),
      }),
      sessionViewLoader: { load: (id) => loadSessionView(id, asAsyncEventReadSurface(store), asAsyncEventReadSurface(store)) },
    })
    const shown = () => (sessionStore.get(sessionId)?.outputBlocks() ?? [])
      .flatMap((block) => block.kind === "text" || block.kind === "userMessage" ? [block.content] : [])

    try {
      expect(await supervisor.activateSession(sessionId)).toBe(true)
      await supervisor.ensureChatRunner(sessionId)
      // The turn shows text that its own commit has not reached yet.
      sessionStore.updateEntry(sessionId, { ...turn, streamingStartedAt: Date.now() })
      runnerBlocks = [...runnerBlocks, { kind: "text", id: "streamed", content: "noticed", timestamp: Date.now() }]
      syncRunnerDisplay()

      // A reattach after a replacement, or a second client, opens the session mid-turn.
      expect(await supervisor.activateSession(sessionId)).toBe(true)
      expect(shown()).toEqual(["hello", "noticed"])

      // The turn commits its text and ends with the runner's last sync.
      await commit({ kind: "assistant", content: [{ type: "text", text: "noticed" }] })
      syncRunnerDisplay()
      sessionStore.updateEntry(sessionId, { runnerState: "idle", streamingStartedAt: null, waitingOnBackgroundWork: false })
      expect(shown()).toEqual(["hello", "noticed"])

      // Work committed without the runner leaves a display at rest behind the
      // log; activation reads it again into the store and into the runner.
      await commit({ kind: "user", content: "committed without the runner" })
      expect(await supervisor.activateSession(sessionId)).toBe(true)
      expect(shown()).toEqual(["hello", "noticed", "committed without the runner"])
      syncRunnerDisplay()
      expect(shown()).toEqual(["hello", "noticed", "committed without the runner"])
    } finally {
      await supervisor.disposeAll()
      await runtime.dispose()
      rmSync(baseDir, { recursive: true, force: true })
    }
  })
})
