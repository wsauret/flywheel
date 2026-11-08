import type { QuestionBlock } from "../../../../src/infra/output-blocks.js"
import type { StoredFact } from "../../../../src/infra/event-store-types.js"
import type { SessionManager, SessionMetadataChange } from "../../../../src/orchestration/session/manager.js"
import type { DurableSessionCatalogRow } from "../../../../src/orchestration/session/session-catalog-types.js"
import type { ChatSessionEntry, SessionEntry, SessionStore } from "../../../../src/orchestration/session-store/types.js"
import type { ChatRunner } from "../../../../src/orchestration/chat/runner-types.js"
import { NO_MODULE_RUNTIMES } from "../../../../src/infra/module-runtime.js"
import type { WorkflowRunner } from "../../../../src/orchestration/workflow-host/runner-types.js"
import { EMPTY_OUTPUT_CHANGE_BATCH } from "../../../../src/infra/output/output-block-delta.js"
import type { SessionCatalogRow } from "../../../../src/protocol/app-service-types.js"
import { projectSessionCatalogRow } from "../../../../src/orchestration/session/session-catalog-row.js"
import { createBackgroundWorkRegistry } from "../../../../src/orchestration/agent-runtime/background-work.js"

/** A listed session's row; the fixtures here never project a child. */
export function listedRow(metadata: DurableSessionCatalogRow): SessionCatalogRow {
  const row = projectSessionCatalogRow(metadata)
  if (row.kind !== "chat") throw new Error(`fixture ${metadata.id} is a child, which has no catalog row`)
  return row
}

export function executionRow(metadata: DurableSessionCatalogRow, totalTokens: number, totalCost = 0): SessionCatalogRow {
  return {
    ...listedRow(metadata),
    totalsLoading: false,
    totalCost,
    totalBilledCost: totalCost,
    priceUnavailable: false,
    totalTokens,
    contextPercent: 0,
    contextPromptTokens: 0,
    durationMs: 0,
  }
}

export type TestSessionStore = SessionStore & { emitChange(changedId?: string): void }

export function storedEvents() {
  const listeners = new Set<(events: readonly StoredFact[]) => void>()
  return {
    onStored(listener: (events: readonly StoredFact[]) => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    emit(events: readonly StoredFact[]) { for (const listener of listeners) listener(events) },
    listenerCount: () => listeners.size,
  }
}

export function fileChanged(sessionId: string): StoredFact {
  return {
    id: "file-change", position: 1, seq: 0, timestamp: 1, actor: "flywheel",
    aggregateId: `session:${sessionId}`, sessionId, type: "file.changed", version: 2,
    payload: {
      mutationId: "mutation-1", path: "/workspace/file.ts", displayPath: "file.ts",
      changeKind: "modified", before: null, after: null, toolUseId: "tool-1",
      lineStats: { added: 1, modified: 2, removed: 3 },
    },
  }
}

export function pendingQuestion(): QuestionBlock {
  return {
    kind: "question",
    toolUseId: "tool-1",
    questions: [{ question: "Pick one", choices: [{ kind: "freeform", label: "Other" }], multiSelect: false }],
    timestamp: 4,
  }
}

export function chatEntry(overrides: Partial<ChatSessionEntry> = {}): ChatSessionEntry {
  return {
    kind: "chat",
    entryEpoch: 1,
    runner: null,
    conversationId: "conv-1",
    description: "Projected chat",
    shortDescription: "Chat",
    outputBlocks: () => [{ kind: "text", id: "text-1", content: "hello", timestamp: 1 }],
    outputSequenceStart: 0,
    visibleMessageCountPrefix: 0,
    visibleMessageCountSuffix: 0,
    streamingToolText: {},
    tokens: 9,
    cost: 0.12,
    billedCost: 0,
    priceUnavailable: false,
    contextPercent: 33,
    streamingOutputChars: 6,
    contextPromptTokens: 7,
    startedAt: 100,
    streamPhase: "generating",
    runnerState: "absent",
    activityStartedAt: 0,
    streamingStartedAt: null,
    accumulatedActiveMs: 20,
    connectionState: "connected",
    notices: [],
    compactionStartedAt: null,
    activeSubagents: new Set<string>(),
    waitingOnBackgroundWork: false,
    activeBackgroundCommands: [],
    activeForegroundBashToolCallIds: [],
    ...overrides,
  }
}

/** A live child entry: a subagent shares the chat entry shape. */
export function subagentEntry(overrides: Partial<Omit<ChatSessionEntry, "kind">> = {}): SessionEntry {
  return { ...chatEntry({ description: "Projected child", shortDescription: "Child", ...overrides }), kind: "subagent" }
}

export function chatRunner(sessionId: string): ChatRunner {
  return {
    chatModuleHosts: NO_MODULE_RUNTIMES,
    backgroundTasks: createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} }),
    applyProjectionEvent: () => {},
    sessionId,
    abort: async () => {},
    interrupt: () => false,
    messageState: async () => "at_rest",
    dispose: async () => {},
    send: async () => "ended",
    deliverHeldMessage: async () => ({ status: "held", reason: "no_reader" }),
    recallQueuedMessage: async () => null,
    compact: async () => false,
    awaitTurnSettlement: async () => {},
    awaitLogicalTurnDurability: async () => {},
    deliverCommitted: () => false,
    deliverBackgroundNotification: async () => false,
    requestWithContext: () => false,
    resumeCommitted: () => false,
    awaitOwedCapacity: async () => false,
    setShown: () => {},
    resume: () => false,
    holdsRunningTurn: () => false,
    prepareForShutdown: () => {},
    interruptForReplacement: async () => false,
    interruptPlannedCut: async () => "running",
    hold: async () => NO_MODULE_RUNTIMES,
    capabilities: async () => () => true,
    terminateBackgroundWork: () => {},
    releaseForegroundBash: () => false,
    transferForegroundForReplacement: async () => {},
    adoptHandedOver: async () => {},
    answerQuestion: () => {},
    cancelQuestion: () => {},
    seedDisplayBlocks: () => {},
  }
}

export function workflowRunner(sessionId: string): WorkflowRunner & { readonly secret: string } {
  return {
    applyProjectionEvent: () => {},
    secret: "backend-only",
    sessionId,
    interruption: () => undefined,
    cut: async () => undefined,
    handBack: async () => ({ kind: "not_parked" }),
    continueHeldMessages: async () => {},
    abort: async () => {},
    interrupt: async () => false,
    dispose: async () => {},
    recallQueuedMessage: async () => null,
    compact: async () => false,
    prepare: async () => null,
    readQueue: async () => ({ attempts: [], tree: { nodes: [] }, cursor: 0, status: "idle", mutationLog: [] }),
    run: async () => ({ completed: true, attemptsCompleted: 0, attemptsTotal: 0, cost: 0, tokens: 0 }),
    interruptForReplacement: async () => false,
    interruptPlannedCut: async () => "ended",
    stepModuleRuntimes: async () => undefined,
    stepBackgroundTasks: () => undefined,
    resume: async () => false,
    continueCapacity: () => new Set(),
    releaseForegroundBash: () => false,
    transferForegroundForReplacement: async () => {},
    terminateBackgroundWork: () => {},
  }
}

export function workflowEntry(overrides: Partial<Omit<ChatSessionEntry, "kind">> = {}): SessionEntry {
  return { ...chatEntry({ description: "Projected workflow agent", ...overrides }), kind: "workflow-agent", workflowId: "workflow", operations: null }
}

export function fakeSessionStore(entries: Map<string, SessionEntry>, runningCount: number = entries.size): TestSessionStore {
  const listeners = new Set<(changed: ReadonlySet<string> | undefined) => void>()
  const revisions = new Map<string, number>()
  const bump = (id: string) => revisions.set(id, (revisions.get(id) ?? 0) + 1)
  return {
    openSessionRuntime: (opts) => opts.sessionId,
    replaceChatDisplaySeed: () => false,
    attachChatRunner: () => false,
    appendPreRunnerOutput: () => false,
    showStartupFailure: () => false,
    get: (sessionId) => entries.get(sessionId),
    has: (sessionId) => entries.has(sessionId),
    isRunning: (sessionId) => entries.has(sessionId),
    abort: async () => false,
    prepareForShutdown: () => {},
    interruptForReplacement: async () => false,
    interrupt: () => false,
    releaseForegroundBash: () => false,
    transferForegroundForReplacement: async () => {},
    remove: async (sessionId) => { entries.delete(sessionId) },
    updateEntry: (sessionId, patch) => {
      const entry = entries.get(sessionId)
      if (!entry) return
      Object.assign(entry, patch)
      bump(sessionId)
    },
    updateChatEntry: (sessionId, patch) => {
      const entry = entries.get(sessionId)
      if (entry?.kind !== "chat") return
      Object.assign(entry, patch)
      bump(sessionId)
    },
    terminateBackgroundWork: () => {},
    answerQuestion: () => false,
    cancelQuestion: () => false,
    compactConversation: async () => false,
    learnFromSession: () => false,
    runningCount: () => runningCount,
    allIds: () => [...entries.keys()],
    revision: (sessionId) => revisions.get(sessionId) ?? 0,
    drainOutputChanges: () => EMPTY_OUTPUT_CHANGE_BATCH,
    reorder: () => false,
    disposeAll: async () => {},
    refreshDeps: async () => {},
    onChange: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    emitChange: (changedId) => {
      if (changedId !== undefined) bump(changedId)
      for (const listener of listeners) listener(changedId === undefined ? undefined : new Set([changedId]))
    },
  }
}

export function fakeManager(overrides: Partial<SessionManager> = {}): SessionManager & { emitChange(sessionIds: readonly string[]): void; emitDeleted(sessionId: string): void } {
  const listeners = new Set<(change: SessionMetadataChange) => void>()
  const capturedProfiles = new Map<string, string>()
  const notify = (change: SessionMetadataChange) => { for (const listener of listeners) listener(change) }
  const manager: SessionManager & { emitChange(sessionIds: readonly string[]): void; emitDeleted(sessionId: string): void } = {
    emitChange: (sessionIds) => notify({ kind: "changed", sessionIds }),
    emitDeleted: (sessionId: string) => notify({ kind: "deleted", sessionId }),
    allocateId: () => "allocated-id",
    createChat: async (opts) => opts.id ?? "created-id",
    createChatFromContext: async () => "created-id",
    listMetadata: async () => ({ sessions: [], errors: [] }),
    listActive: async () => ({ sessions: [], errors: [] }),
    // Empty by default so scoped reads never look like catalog replays in
    // call-count pins; tests needing scoped rows override listForIds directly.
    listForIds: async () => ({ sessions: [], errors: [] }),
    read: async (id) => durableSessionFromCatalogRow((await manager.listMetadata()).sessions.find((session) => session.id === id)),
    publishWorkflow: async (opts) => opts.id,
    commitWorkflow: async () => { throw new Error("Workflow publication is not used in this fixture") },
    adoptWorkflow: async () => true,
    publishSubagent: async (opts) => opts.id,
    forkChat: async () => "forked-id",
    updateLifecycleState: async () => {},
    publishActivation: async () => {},
    updateLabel: async () => true,
    updateChatMetadata: async () => {},
    captureRolesIfAbsent: async () => true,
    captureAuthProfileIfAbsent: async (id, authProfileId) => {
      const session = await manager.read(id)
      if (!session || session.authProfileId !== undefined) return false
      capturedProfiles.set(id, authProfileId)
      return true
    },
    selectAuthProfile: async () => true,
    selectAuthProfileWithRoleSnapshot: async () => true,
    replaceRoleSnapshot: async () => true,
    updateRoleAssignment: async () => true,
    removeRoleAssignment: async () => true,
    unlinkChild: async () => {},
    admitDeletion: async (id) => ({ rootSessionId: id, targets: [] }),
    finalizeDeletionTarget: async () => [],
    recoverStaleSessions: async () => 0,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    ...overrides,
  }
  const read = manager.read
  manager.read = async (id) => {
    const session = await read(id)
    const authProfileId = session?.authProfileId ?? capturedProfiles.get(id)
    return session && authProfileId !== undefined ? { ...session, authProfileId } : session
  }
  return manager
}

/** A catalog row with chat defaults. A workflow agent's overrides name its
 *  membership, as the catalog row requires; the row refuses one without it. */
export function durableRow(id: string, overrides: Partial<DurableSessionCatalogRow> = {}): DurableSessionCatalogRow {
  const { kind = "chat", workflowMembership, ...fields } = overrides
  const base = { id, name: id, label: id, lifecycleState: "inactive", command: "chat", lastUpdated: "2026-01-01T00:00:00.000Z", executionCwd: "/workspace", conversationId: "conv-1", ...fields } as const
  if (kind !== "workflow-agent") return { ...base, kind }
  if (!workflowMembership) throw new Error(`the workflow agent row ${id} names no workflow membership`)
  return { ...base, kind, workflowMembership }
}

/** A manager whose durable catalog holds these metadata rows, mirroring
 *  production: `session.created` records the metadata (and with it the session's
 *  execution directory) before any store entry exists. */
export function managerWithSessions(sessions: readonly DurableSessionCatalogRow[], overrides: Partial<SessionManager> = {}): ReturnType<typeof fakeManager> {
  return fakeManager({
    listMetadata: async () => ({ sessions: [...sessions], errors: [] }),
    listActive: async () => ({ sessions: sessions.filter((session) => session.lifecycleState === "active"), errors: [] }),
    listForIds: async (ids) => ({ sessions: sessions.filter((session) => ids.includes(session.id)), errors: [] }),
    read: async (id) => durableSessionFromCatalogRow(sessions.find((session) => session.id === id)),
    ...overrides,
  })
}

export function durableSessionFromCatalogRow(session: DurableSessionCatalogRow | undefined): Awaited<ReturnType<SessionManager["read"]>> {
  if (!session) return null
  const common = {
    ...(session.authProfileId !== undefined ? { authProfileId: session.authProfileId } : {}),
    ...(session.name !== undefined ? { name: session.name } : {}),
    label: session.label,
    ...(session.shortLabel !== undefined ? { shortLabel: session.shortLabel } : {}),
    lastUpdated: session.lastUpdated,
    createdAt: session.lastUpdated,
    executionCwd: session.executionCwd,
    lifecycleState: session.lifecycleState,
    ...(session.childSessionIds === undefined ? {} : { childSessionIds: [...session.childSessionIds] }),
  }
  if (session.kind === "workflow-agent") return {
    ...common,
    kind: "workflow-agent",
    command: "workflow-agent",
    conversationId: session.conversationId ?? `conv-${session.id}`,
    launchedFrom: { parentSessionId: session.launchedFrom?.parentSessionId ?? "parent", toolUseId: session.launchedFrom?.toolUseId ?? "tool" },
    workflowMembership: session.workflowMembership,
  }
  if (session.kind === "subagent") return {
    ...common,
    kind: "subagent",
    command: "subagent",
    conversationId: session.conversationId ?? `conv-${session.id}`,
    launchedFrom: {
      parentSessionId: session.launchedFrom?.parentSessionId ?? "parent",
      toolUseId: session.launchedFrom?.toolUseId ?? "tool",
    },
  }
  return {
    ...common,
    kind: session.kind,
    command: "chat",
    conversationId: session.conversationId ?? `conv-${session.id}`,
  }
}
