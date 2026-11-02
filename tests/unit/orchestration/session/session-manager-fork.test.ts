import { afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, realpathSync, rmSync } from "node:fs"
import { join } from "node:path"
import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncGuardedEventWriter, type EventStore, type EventStoreAppend, type GuardedEventStoreAppend } from "../../../../src/infra/event-store-types"
import { createSessionManager, SessionForkRefusal } from "../../../../src/orchestration/session/manager"
import { ConversationTreeStorage } from "../../../../src/orchestration/session/conversation/conversation-tree-storage"
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle"
import { parseSessionForkFact } from "../../../../src/orchestration/session/session-fork-facts"
import { readBudgetSummaryFromReader } from "../../../../src/orchestration/session/budget-summary"
import { createConversationCheckpointOwner, readConversationCheckpoint } from "../../../../src/orchestration/session/conversation-checkpoint"
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer"
import { cleanupTmpRoot, makeDepsWithStore, makeTmpDir, publishTestWorkflow, startTestWorkflowMember } from "./_session-manager-fixtures"

function message(id: string, parentId: string | null, kind: "user" | "assistant", content: string) {
  return {
    kind: "message" as const,
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: { kind, content } as const,
  }
}

async function seedChat(
  manager: ReturnType<typeof createSessionManager>,
  store: EventStore,
  options: Parameters<typeof manager.createChat>[0] = {},
) {
  const sourceSessionId = await manager.createChat({
    name: "Source session title",
    initialState: "inactive",
    initialRoles: {
      chat: { model: "anthropic/claude-sonnet-4-5", effort: "high" },
    },
    authProfileId: "profile-a",
    ...options,
  })
  await manager.replaceRoleSnapshot(
    sourceSessionId,
    { chat: { model: "anthropic/claude-sonnet-4-5", effort: "high" } },
    { chat: { model: "openai/gpt-5.2", effort: "low" } },
  )
  const source = await manager.read(sourceSessionId)
  if (source?.kind !== "chat") throw new Error("expected source chat")
  const tree = await ConversationTreeStorage.open({
    conversationId: source.conversationId,
    sessionId: sourceSessionId,
    store: asAsyncEventReadSurface(store),
    writer: asAsyncEventWriter(store),
  })
  await tree.appendEntries([
    message("root", null, "user", "question"),
    message("answer", "root", "assistant", "answer"),
  ])
  tree.dispose()
  return { sourceSessionId, source }
}

function publicationWriter(
  store: EventStore,
  beforePublication: (attempt: number, events: readonly GuardedEventStoreAppend[]) => void | Promise<void>,
) {
  let attempts = 0
  const writer: AsyncGuardedEventWriter = {
    append: async (event: EventStoreAppend) => store.append(event),
    appendBatch: async (events: readonly EventStoreAppend[]) => store.appendBatch(events),
    appendGuarded: async (event) => store.appendGuarded(event),
    appendBatchGuarded: async (events) => {
      if (events.some(({ type }) => type === "session.forked")) {
        attempts += 1
        await beforePublication(attempts, events)
      }
      return store.appendBatchGuarded(events)
    },
    pruneSupersededEvents: async (...args: Parameters<EventStore["pruneSupersededEvents"]>) =>
      store.pruneSupersededEvents(...args),
  }
  return {
    writer,
    attempts: () => attempts,
  }
}

function appendSourceTelemetry(store: EventStore, sourceSessionId: string, value: number): void {
  store.append({
    aggregateId: `session:${sourceSessionId}`,
    type: "session.duration.recorded",
    version: 1,
    timestamp: Date.now(),
    actor: "flywheel",
    sessionId: sourceSessionId,
    payload: { accumulatedActiveMs: value },
  })
}

afterEach(cleanupTmpRoot)

describe("SessionManager.forkChat", () => {
  it("publishes captured context as an independent chat without copying later source changes", async () => {
    const { deps, store } = makeDepsWithStore(makeTmpDir())
    const manager = createSessionManager(deps)
    const { sourceSessionId, source } = await seedChat(manager, store)
    const captured = [
      { kind: "user" as const, content: "question" },
      { kind: "assistant" as const, content: "answer" },
      { kind: "user" as const, origin: "human" as const, content: "side question" },
      { kind: "assistant" as const, content: "side answer" },
    ]
    const sourceTree = await ConversationTreeStorage.open({
      conversationId: source.conversationId,
      sessionId: sourceSessionId,
      store: asAsyncEventReadSurface(store),
      writer: asAsyncEventWriter(store),
    })
    try {
      await sourceTree.appendEntries([
        message("later-question", "answer", "user", "later question"),
        message("later-answer", "later-question", "assistant", "later answer"),
      ])
    } finally {
      sourceTree.dispose()
    }
    const notices: unknown[] = []
    manager.subscribe((change) => notices.push(change))
    const targetSessionId = await manager.createChatFromContext(sourceSessionId, captured)
    const target = await manager.read(targetSessionId)
    if (target?.kind !== "chat") throw new Error("expected captured-context chat")
    const tree = await tryOpenConversationTree({
      conversationId: target.conversationId,
      sessionId: targetSessionId,
      store: asAsyncEventReadSurface(store),
      writer: asAsyncEventWriter(store),
    })
    if (!tree) throw new Error("expected captured-context tree")
    try {
      expect((await tree.buildContext({ allowAssistantTail: true })).messages)
        .toEqual(captured)
    } finally {
      tree.getStorage().dispose()
    }
    expect(target).toMatchObject({
      lifecycleState: "inactive",
      executionCwd: source.executionCwd,
      authProfileId: source.authProfileId,
      roleAssignments: source.roleAssignments,
      launchedFrom: { parentSessionId: sourceSessionId },
    })
    expect(await manager.read(sourceSessionId))
      .toMatchObject({ childSessionIds: [targetSessionId], lastUpdated: source.lastUpdated })
    expect(notices).toEqual([{ kind: "changed", sessionIds: [targetSessionId, sourceSessionId] }])
  })

  it.each(["forkChat", "createChatFromContext"] as const)("%s starts the branch with the source's checkpoint and leaves the source unchanged", async (branch) => {
    const { deps, store } = makeDepsWithStore(makeTmpDir())
    const manager = createSessionManager(deps)
    const { sourceSessionId, source } = await seedChat(manager, store)
    const reader = asAsyncEventReadSurface(store)
    const sourceOwner = { kind: "session" as const, sessionId: sourceSessionId }
    const publish = () => branch === "forkChat"
      ? manager.forkChat(sourceSessionId)
      : manager.createChatFromContext(sourceSessionId, [{ kind: "user", content: "question" }])
    const checkpointOf = async (sessionId: string) => {
      const session = await manager.read(sessionId)
      if (session?.kind !== "chat") throw new Error("expected chat")
      return readConversationCheckpoint(reader, { kind: "session", sessionId }, session.conversationId)
    }

    expect(await checkpointOf(await publish())).toBeUndefined()

    const writer = createSessionFactWriter({ sessionId: sourceSessionId, writer: asAsyncEventWriter(store) })
    const saved = await createConversationCheckpointOwner(reader, writer, sourceOwner, source.conversationId).replace("currentState", "source state")
    expect(await checkpointOf(await publish())).toEqual(saved)
    expect(await readConversationCheckpoint(reader, sourceOwner, source.conversationId)).toEqual(saved)
  })

  it("does not publish a captured context with an orphan tool result", async () => {
    const { deps, store } = makeDepsWithStore(makeTmpDir())
    const manager = createSessionManager(deps)
    const { sourceSessionId } = await seedChat(manager, store)
    await expect(manager.createChatFromContext(sourceSessionId, [{
      kind: "toolResult",
      toolUseId: "unmatched",
      content: [{ type: "text", text: "orphan result" }],
    }])).rejects.toThrow("Cannot publish captured conversation context")
    expect(store.read({ types: ["session.created"] }).map((row) => row.sessionId)).toEqual([sourceSessionId])
  })

  it("publishes an inactive independent chat with inherited metadata, copied history, and lineage", async () => {
    const baseDir = makeTmpDir()
    const { deps, store } = makeDepsWithStore(baseDir)
    const manager = createSessionManager(deps)
    const notices: Array<readonly string[]> = []
    manager.subscribe((change) => {
      if (change.kind === "changed") notices.push(change.sessionIds)
    })
    const { sourceSessionId, source } = await seedChat(manager, store)
    store.append({
      aggregateId: `session:${sourceSessionId}`,
      type: "model.context.measured",
      version: 1,
      timestamp: Date.now(),
      actor: "provider",
      sessionId: sourceSessionId,
      payload: { promptTokens: 9000, contextWindow: 100000 },
    })
    notices.length = 0
    // A later clock shows whether the fork moved the source's own time.
    await Bun.sleep(2)

    const targetSessionId = await manager.forkChat(sourceSessionId)
    const target = await manager.read(targetSessionId)
    if (target?.kind !== "chat") throw new Error("expected target chat")

    expect(Object.keys(target).sort()).toEqual([
      "authProfileId",
      "command",
      "conversationId",
      "createdAt",
      "executionCwd",
      "kind",
      "label",
      "lastUpdated",
      "launchedFrom",
      "lifecycleState",
      "name",
      "roleAssignments",
      "shortLabel",
    ])
    expect(target.kind).toBe("chat")
    expect(target.command).toBe("chat")
    expect(target.label).toBe("Fork of Source session title")
    expect(target.shortLabel).toBe("Fork: Source")
    expect(target.name).toBe("Fork of Source session title")
    expect(target.lifecycleState).toBe("inactive")
    expect(target.executionCwd).toBe(source.executionCwd)
    expect(target.launchedFrom).toEqual({ parentSessionId: sourceSessionId })
    expect(target.authProfileId).toBe("profile-a")
    expect(target.roleAssignments).toEqual(source.roleAssignments)
    expect(target.conversationId).not.toBe(source.conversationId)
    expect(targetSessionId).not.toBe(sourceSessionId)
    expect(await manager.read(sourceSessionId)).toMatchObject({ childSessionIds: [targetSessionId], lastUpdated: source.lastUpdated })
    expect(notices).toEqual([[targetSessionId, sourceSessionId]])
    // The fork starts with its source's context, not its cost.
    expect(await readBudgetSummaryFromReader(asAsyncEventReadSurface(store), targetSessionId))
      .toMatchObject({ contextPromptTokens: 9000, contextPercent: 9, totalCost: 0, totalTokens: 0 })

    const forkRows = store.read({ aggregateId: `session:${targetSessionId}`, types: ["session.forked"] })
    expect(forkRows).toHaveLength(1)
    const row = forkRows[0]
    if (!row) throw new Error("expected fork fact")
    const fork = parseSessionForkFact({
      type: row.type,
      version: row.version,
      actor: row.actor,
      payload: row.payload,
    })
    expect(fork.payload).toMatchObject({
      sourceSessionId,
      targetSessionId,
      selection: { kind: "active_branch" },
      copiedEntryCount: 2,
      copiedRootEntryId: "root",
      copiedLeafEntryId: "answer",
    })

    const targetTree = await ConversationTreeStorage.open({
      conversationId: target.conversationId,
      sessionId: targetSessionId,
      store: asAsyncEventReadSurface(store),
      writer: asAsyncEventWriter(store),
    })
    await targetTree.appendEntry(message("target-only", "answer", "user", "independent"))
    targetTree.dispose()
    const sourceTree = await ConversationTreeStorage.open({
      conversationId: source.conversationId,
      sessionId: sourceSessionId,
      store: asAsyncEventReadSurface(store),
    })
    expect(await sourceTree.getEntry("target-only")).toBeUndefined()
    sourceTree.dispose()

    expect(await manager.updateLabel(targetSessionId, { label: "Renamed fork", shortLabel: "Renamed fork" }, "user")).toBe(true)
    expect((await manager.read(targetSessionId))?.label).toBe("Renamed fork")
  })

  it("records the source's directory even after that directory is removed", async () => {
    // A fork keeps its source's path meaning; its own start then refuses the
    // removed directory as the source's does (ARCH-DIRECTORIES-007).
    const baseDir = realpathSync(makeTmpDir())
    const worktree = join(baseDir, "worktree")
    mkdirSync(worktree)
    const { deps, store } = makeDepsWithStore(baseDir, { executionCwd: worktree })
    const manager = createSessionManager(deps)
    const { sourceSessionId } = await seedChat(manager, store)
    rmSync(worktree, { recursive: true })

    const target = await manager.read(await manager.forkChat(sourceSessionId))

    expect(target?.executionCwd).toBe(worktree)
  })

  it("rejects missing sources, workflow aggregates, and ordinary workflow members", async () => {
    const baseDir = makeTmpDir()
    const { deps, store } = makeDepsWithStore(baseDir)
    const manager = createSessionManager(deps)

    await expect(manager.forkChat("missing")).rejects.toThrow("Session not found: missing")
    const workflowId = await publishTestWorkflow(manager)
    await expect(manager.forkChat(workflowId)).rejects.toThrow(`Session not found: ${workflowId}`)
    const memberId = await startTestWorkflowMember(manager, store, workflowId)
    const refusal = await manager.forkChat(memberId).catch((error: unknown) => error)
    expect(refusal).toBeInstanceOf(SessionForkRefusal)
    expect(refusal).toHaveProperty("message", "Only chat sessions can be forked")
  })

  it("preserves an absent role snapshot for first-use materialization", async () => {
    const baseDir = makeTmpDir()
    const { deps, store } = makeDepsWithStore(baseDir)
    const manager = createSessionManager(deps)
    const sourceSessionId = await manager.createChat({ name: "Source without roles", initialState: "inactive" })
    const source = await manager.read(sourceSessionId)
    if (source?.kind !== "chat") throw new Error("expected source chat")
    const sourceTree = await ConversationTreeStorage.open({
      conversationId: source.conversationId,
      sessionId: sourceSessionId,
      store: asAsyncEventReadSurface(store),
      writer: asAsyncEventWriter(store),
    })
    await sourceTree.appendEntries([
      message("root", null, "user", "question"),
      message("answer", "root", "assistant", "answer"),
    ])
    sourceTree.dispose()

    const targetSessionId = await manager.forkChat(sourceSessionId)

    expect((await manager.read(targetSessionId))?.roleAssignments).toBeUndefined()
  })

  it("does not publish metadata or notify when copying the tree fails", async () => {
    const baseDir = makeTmpDir()
    const { deps, store } = makeDepsWithStore(baseDir)
    const manager = createSessionManager(deps)
    const sourceSessionId = await manager.createChat({ name: "Empty", initialState: "inactive" })
    const notices: unknown[] = []
    manager.subscribe((change) => notices.push(change))
    notices.length = 0

    await expect(manager.forkChat(sourceSessionId)).rejects.toThrow("There is no committed conversation to fork")
    expect(store.read({ types: ["session.forked"] })).toEqual([])
    expect((await manager.listMetadata()).sessions).toHaveLength(1)
    expect(notices).toEqual([])
  })

  it("retries source conflicts with stable destination facts and notifies only after success", async () => {
    const baseDir = makeTmpDir()
    const { deps, store } = makeDepsWithStore(baseDir)
    let sourceSessionId = ""
    const destinationBatches: Array<readonly GuardedEventStoreAppend[]> = []
    const race = publicationWriter(store, (attempt, events) => {
      destinationBatches.push(events)
      if (attempt === 1) appendSourceTelemetry(store, sourceSessionId, attempt)
    })
    const manager = createSessionManager({ ...deps, writer: race.writer })
    sourceSessionId = (await seedChat(manager, store)).sourceSessionId
    const notices: unknown[] = []
    manager.subscribe((change) => notices.push(change))

    const targetSessionId = await manager.forkChat(sourceSessionId)

    expect(race.attempts()).toBe(2)
    expect(destinationBatches[1]?.map(({ expectedSeq: _, ...event }) => event))
      .toEqual(destinationBatches[0]?.map(({ expectedSeq: _, ...event }) => event))
    expect(store.read({ aggregateId: `session:${targetSessionId}`, types: ["session.created"] })).toHaveLength(1)
    expect(notices).toHaveLength(1)
  })

  it("leaves the validated tree private when publication conflicts exhaust retries", async () => {
    const baseDir = makeTmpDir()
    const { deps, store } = makeDepsWithStore(baseDir)
    let sourceSessionId = ""
    let targetSessionId = ""
    let targetConversationId = ""
    const race = publicationWriter(store, (attempt, events) => {
      const created = events.find(({ type }) => type === "session.created")
      targetSessionId = created?.sessionId ?? ""
      const payload = created?.payload
      targetConversationId = typeof payload?.conversationId === "string" ? payload.conversationId : ""
      appendSourceTelemetry(store, sourceSessionId, attempt)
    })
    const manager = createSessionManager({ ...deps, writer: race.writer })
    sourceSessionId = (await seedChat(manager, store)).sourceSessionId
    const notices: unknown[] = []
    manager.subscribe((change) => notices.push(change))

    await expect(manager.forkChat(sourceSessionId)).rejects.toThrow(/after 3 attempts/)

    expect(race.attempts()).toBe(3)
    expect(await manager.read(targetSessionId)).toBeNull()
    expect(store.read({ aggregateId: `session:${targetSessionId}` })).toEqual([])
    expect(store.read({ aggregateId: `conversation:${targetConversationId}` }).length).toBeGreaterThan(0)
    expect(notices).toEqual([])
  })
})
