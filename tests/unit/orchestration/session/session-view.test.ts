import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import { asAsyncEventReadSurface, asAsyncEventWriter, type EventStore } from "../../../../src/infra/event-store-types"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths"
import { createSessionManager } from "../../../../src/orchestration/session/manager"
import { createSessionBudgetStore } from "../../../../src/orchestration/session/budget-store"
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer"
import { noopEmitter } from "./_budget-store-fixtures"
import { createSessionViewLoader, loadSessionView, toSessionView } from "../../../../src/orchestration/session-store/view"
import { createConversationTree, tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle"
import type { ChatSessionEntry } from "../../../../src/orchestration/session-store/types"
import { createStoredSession } from "./_session-metadata-test-helpers"
import { loadQueueSnapshotFromReader } from "../../../../src/workflows/view/view-store"
import { publishTestWorkflow, startTestWorkflowMember } from "./_session-manager-fixtures"
import { entryRuntimeDefaults } from "../../../../src/orchestration/session-store/entry-defaults"

let tmpDir: string
let reader: EventStore

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "session-view-test-"))
  reader = createSqliteEventStore(resolveEventStoreDbFile(tmpDir))
})

afterEach(() => {
  reader.close()
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function baseSession(lifecycleState: "active" | "inactive" = "inactive") {
  return {
    label: "Saved session",
    lastUpdated: "2026-05-08T00:00:00.000Z",
    lifecycleState,
    name: "Saved session",
    executionCwd: tmpDir,
    createdAt: "2026-05-08T00:00:00.000Z",
  }
}

// Loadability is tree-gated (audit item 13): a durable chat opens iff its
// conversation has a committed user turn. Opens the manager-minted tree when it
// exists; mints one for fixtures written via raw metadata (createStoredSession
// bypasses the manager).
async function commitUserTurn(conversationId: string, sessionId: string): Promise<void> {
  const options = { conversationId, sessionId, store: asAsyncEventReadSurface(reader), writer: asAsyncEventWriter(reader) }
  const tree = await tryOpenConversationTree(options)
    ?? await createConversationTree(options)
  await tree.appendMessage({ kind: "user", content: "hello" })
  await tree.getStorage().dispose()
}

async function recordBudget(sessionId: string, opts: { cost?: number; input?: number; output?: number; contextPrompt?: number; contextWindow?: number }): Promise<void> {
  const writer = createSessionFactWriter({ sessionId, writer: asAsyncEventWriter(reader) })
  const budgetStore = createSessionBudgetStore({ sessionId, emitter: noopEmitter, reader: asAsyncEventReadSurface(reader), recorder: writer.record })
  if (opts.cost !== undefined || opts.input !== undefined || opts.output !== undefined) {
    await budgetStore.recordRuntimeEvent({
      type: "model.turn.completed",
      data: {
        total_cost_usd: opts.cost ?? 0,
        usage: { input_tokens: opts.input ?? 0, output_tokens: opts.output ?? 0 },
      },
    })
  }
  if (opts.contextPrompt !== undefined || opts.contextWindow !== undefined) {
    await budgetStore.recordContextUtilization(opts.contextPrompt ?? 0, opts.contextWindow ?? 0)
  }
  await budgetStore.dispose()
  writer.dispose()
}

async function memberSession() {
  const manager = createSessionManager({ projectRoot: tmpDir, executionCwd: tmpDir, store: reader })
  const workflowId = await publishTestWorkflow(manager)
  const sessionId = await startTestWorkflowMember(manager, reader, workflowId)
  return { manager, workflowId, sessionId }
}

describe("toSessionView", () => {
  it("propagates awaiting_user runner activity from live entries", () => {
    const entry = {
      ...entryRuntimeDefaults(() => [], 1),
      kind: "chat",
      runner: null,
      conversationId: "conv-awaiting",
      description: "Awaiting chat",
      outputBlocks: () => [],
      outputSequenceStart: 0,
      streamingToolText: {},
      tokens: 0,
      cost: 0,
      contextPercent: 0,
      streamingOutputChars: 0,
      contextPromptTokens: 0,
      startedAt: 1,
      streamPhase: null,
      runnerState: "awaiting_user",
      streamingStartedAt: null,
      accumulatedActiveMs: 0,
      connectionState: "connected",
      compactionStartedAt: null,
      activeSubagents: new Set<string>(),
    } satisfies ChatSessionEntry

    const view = toSessionView("chat-awaiting", entry, "active")

    expect(view.activity).toBe("awaiting_user")
  })
})

describe("loadSessionView", () => {
  it("loads a workflow member's own output and budget independently from the run queue", async () => {
    const { sessionId, workflowId } = await memberSession()
    await recordBudget(sessionId, { cost: 0.25, input: 30, output: 12, contextPrompt: 50, contextWindow: 100 })

    const view = await loadSessionView(sessionId, asAsyncEventReadSurface(reader), asAsyncEventReadSurface(reader))

    expect(view?.kind).toBe("workflow-agent")
    if (view?.kind !== "workflow-agent") throw new Error("expected workflow member")
    // Durable views carry no rendered blocks: the indexed range reader serves them.
    expect(view.outputBlocks).toEqual([])
    expect(view.workflowMembership.workflowId).toBe(workflowId)
    const queue = await loadQueueSnapshotFromReader(asAsyncEventReadSurface(reader), workflowId)
    expect(queue?.attempts).toHaveLength(1)
    expect(queue?.attempts[0]?.status).toBe("running")
    expect("attempts" in view).toBe(false)
    expect(view.tokens).toBe(42)
    expect(view.contextPercent).toBe(50)
  })

  it("rounds persisted context utilization for restored views", async () => {
    const { sessionId } = await memberSession()
    await recordBudget(sessionId, { contextPrompt: 10447, contextWindow: 1050000 })

    const view = await loadSessionView(sessionId, asAsyncEventReadSurface(reader), asAsyncEventReadSurface(reader))

    expect(view?.contextPercent).toBe(1)
  })

  it("does not expose a non-session workflow through the session view", async () => {
    const manager = createSessionManager({ projectRoot: tmpDir, executionCwd: tmpDir, store: reader })
    const sessionId = await publishTestWorkflow(manager)

    const view = await loadSessionView(sessionId, asAsyncEventReadSurface(reader), asAsyncEventReadSurface(reader))

    expect(view).toBeNull()
  })

  it("loads chat view with conversation id", async () => {
    const sessionId = await createStoredSession({ ...baseSession("inactive"), kind: "chat", command: "chat", conversationId: "conv-1" }, tmpDir, "chat-1")
    await commitUserTurn("conv-1", sessionId)
    await createSessionFactWriter({ sessionId, writer: asAsyncEventWriter(reader) }).record({
      type: "session.duration.recorded",
      version: 1,
      actor: "flywheel",
      payload: { accumulatedActiveMs: 123_000 },
    })

    const view = await loadSessionView(sessionId, asAsyncEventReadSurface(reader), asAsyncEventReadSurface(reader))

    expect(view?.kind).toBe("chat")
    if (view?.kind !== "chat") throw new Error("expected chat view")
    expect(view.conversationId).toBe("conv-1")
    // The chat loads because its tree has a user turn; the view carries no blocks.
    expect(view.outputBlocks).toEqual([])
    expect(view.activity).toBe("absent")
    expect(view.streamingStartedAt).toBeNull()
    expect(view.accumulatedActiveMs).toBe(123_000)
    expect("steps" in view).toBe(false)
  })

  it("loads chat seed context", async () => {
    const sessionId = await createStoredSession({ ...baseSession("inactive"), kind: "chat", command: "chat", conversationId: "conv-seed", seedContext: "Workflow summary" }, tmpDir, "chat-seed")
    await commitUserTurn("conv-seed", sessionId)

    const view = await loadSessionView(sessionId, asAsyncEventReadSurface(reader), asAsyncEventReadSurface(reader))

    expect(view?.kind).toBe("chat")
    if (view?.kind !== "chat") throw new Error("expected chat view")
    expect(view.seedContext).toBe("Workflow summary")
  })

  it("returns null for missing session", async () => {
    expect(await loadSessionView("missing", asAsyncEventReadSurface(reader), asAsyncEventReadSurface(reader))).toBeNull()
  })


  it("gates chat loadability on the tree, not the render index", async () => {
    const mgr = createSessionManager({ projectRoot: tmpDir, executionCwd: tmpDir, store: reader })
    // A chat with no committed user turn is not a conversation (recovery
    // tombstones it) -- not loadable.
    const outputOnlyChat = await mgr.createChat({ name: "Output only", initialState: "inactive" })
    expect(await loadSessionView(outputOnlyChat, asAsyncEventReadSurface(reader), asAsyncEventReadSurface(reader))).toBeNull()

    // A chat with a committed user turn and zero rendered output IS loadable.
    const committedChat = await mgr.createChat({ name: "Committed", initialState: "inactive" })
    const conversationId = (await mgr.listMetadata()).sessions.find((s) => s.id === committedChat)!.conversationId!
    await commitUserTurn(conversationId, committedChat)
    expect((await loadSessionView(committedChat, asAsyncEventReadSurface(reader), asAsyncEventReadSurface(reader)))?.kind).toBe("chat")
  })

})

describe("createSessionViewLoader", () => {
  it("dedupes concurrent loads but re-reads after settlement", async () => {
    const { manager, sessionId } = await memberSession()
    const loader = createSessionViewLoader({ reader: asAsyncEventReadSurface(reader), projectionReader: asAsyncEventReadSurface(reader) })

    const [first, second] = await Promise.all([loader.load(sessionId), loader.load(sessionId)])
    expect(first).toBe(second)

    await manager.updateLabel(sessionId, { label: "Completed work" }, "user")
    const later = await loader.load(sessionId)

    expect(later).not.toBe(first)
    expect(later?.description).toBe("Completed work")
  })

  it("reads again for a load asked for after a running load started", async () => {
    const { manager, sessionId } = await memberSession()
    const loader = createSessionViewLoader({ reader: asAsyncEventReadSurface(reader), projectionReader: asAsyncEventReadSurface(reader) })

    const running = loader.load(sessionId)
    // One microtask lets the running load start before the write commits.
    await Promise.resolve()
    await manager.updateLabel(sessionId, { label: "Completed work" }, "user")
    const asked = loader.load(sessionId)

    expect(await asked).not.toBe(await running)
    const view = await asked
    expect(view?.description).toBe("Completed work")
  })
})
