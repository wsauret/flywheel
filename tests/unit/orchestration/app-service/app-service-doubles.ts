import type { QuestionBlock } from "../../../../src/infra/output-blocks.js"
import { EMPTY_OUTPUT_CHANGE_BATCH } from "../../../../src/infra/output/output-block-delta.js"
import type { OutputBlockBodyRequest, OutputGroupChildrenRequest, OutputRangeRequest } from "../../../../src/protocol/transcript-protocol-types.js"
import type { RuntimeSupervisor, SendChatOutcome } from "../../../../src/orchestration/app-service/runtime-supervisor-types.js"
import type { WorkflowController } from "../../../../src/orchestration/workflow-host/controller.js"
import type { AuthProfileResolution } from "../../../../src/orchestration/auth/auth-profile-manager.js"
import type { SessionManager, SessionMetadataChange } from "../../../../src/orchestration/session/manager.js"
import type { ChatSessionEntry, SessionEntry, SessionStore } from "../../../../src/orchestration/session-store/types.js"
import type { RuntimeChatDefault } from "../../../../src/protocol/app-service-types.js"
import { asAsyncEventReadSurface, asAsyncEventWriter, type EventStore } from "../../../../src/infra/event-store-types.js"
import { inMemoryEventReader } from "../../../helpers/in-memory-event-reader.js"
import { NO_MODULE_SERVICES } from "../../../../src/infra/module-service.js"
import { createMemoryStore } from "../../workflows/vm/host-test-support.js"
import { workflowsModule } from "../../../../src/orchestration/modules/workflows.js"
import { workflowProtocolServices } from "../../../../src/orchestration/modules/workflows/protocol.js"
import { composeModuleProtocolRuntimes } from "../../../../src/orchestration/app-service/module-protocol-host.js"
import { createRuntimeUiBus } from "../../../../src/orchestration/app-service/runtime-ui-bus.js"
import { repoDefinitions } from "../../../helpers/project-definitions.js"
import type { RuntimeEventStore } from "../../../../src/infra/sqlite-event-store.js"
import type { WorkflowHosts } from "../../../../src/orchestration/workflow-host/host-collection.js"

const configView = {
  revision: 0,
  values: {
    moduleSelection: [], allowPersistentProcesses: false, foregroundBashHoldSeconds: 240, showThinking: true, idleCompaction: true, shellWriteGuard: true, autoDeleteSessionDays: 0, writeSyntaxTheme: "nord" as const,
    requireWorkflowConfirmation: true, diffColors: "theme" as const, compatibleRendering: "auto" as const, webSearchProvider: "exa" as const,
    fontTipDismissed: false, tabsHintDismissed: false, proactiveCompactionThreshold: 270_000, showBuild: false,
    moduleSections: { subscription_usage: { alert_thresholds: [75, 90, 95, 100] } }, autoInstall: true, roles: {}, profiles: {}, keybindings: {},
    budget: { max_invocations: 100, max_tokens: 1_000_000, max_wall_clock_minutes: 60 }, workflow: { max_attempts: 100 },
    notificationsDesktop: false,
  },
  status: { kind: "valid" as const }, warnings: [], diagnostics: [],
}


/** The app-service requires its status/budget/queue/question/auth/history
 *  projections so a forgotten wire is a loud construction error rather than a
 *  silent empty-status runtime. These doubles satisfy the contract for tests
 *  that exercise the session/output/dispatch paths without a real projection. */
export function fakeProjections() {
  return {
    projectionReader: asAsyncEventReadSurface(inMemoryEventReader([])),
    chatDefault: (): RuntimeChatDefault => ({ kind: "pending" }),
    backgroundLane: {
      start() {},
      snapshot: async () => ({ rows: [], errors: [], totalsLoading: false, generationSpeeds: {} }),
      sessionSummaryImmediate: async () => ({ rows: [], errors: [], totalsLoading: false, generationSpeeds: {} }),
      waitForTotals: async () => ({ rows: [], errors: [], totalsLoading: false, generationSpeeds: {} }),
      sessionDetail: async () => ({ view: null }),
      outputWindow: async () => { throw new Error("Output window is not used in this fixture") },
      outputRange: async () => { throw new Error("Output range is not used in this fixture") },
      outputGroupChildren: async () => { throw new Error("Output children are not used in this fixture") },
      outputBlockBody: async () => { throw new Error("Output body is not used in this fixture") },
      transcriptSearch: async () => { throw new Error("Transcript search is not used in this fixture") },
      recall: async () => { throw new Error("Conversation recall is not used in this fixture") },
      sessionChangeSummary: async () => { throw new Error("Session change summary is not used in this fixture") },
      workflowViewSnapshotBatch: async () => ({ workflowViews: [] }),
      moduleSnapshot: async () => { throw new Error("Module background snapshots are not used in this fixture") },
      dispose: async () => {},
    },
    moduleProtocol: { serve: async (query: { readonly type: string }) => { throw new Error(`Module query ${query.type} is not served in this fixture`) }, mutate: async (mutation: { readonly type: string }) => { throw new Error(`Module mutation ${mutation.type} is not handled in this fixture`) }, send: async (kind: string) => { throw new Error(`A message to a ${kind} is not handled in this fixture`) }, dispose() {} },
    sessionChanges: async () => { throw new Error("Session changes are not used in this fixture") },
    mutationEvidence: async () => { throw new Error("Mutation evidence is not used in this fixture") },
    backgroundIndex: { rows: async () => { throw new Error("The background index is not used in this fixture") } },
    statusProjection: { snapshot: async () => null, refresh() {}, dispose() {} },
    budgetProjection: { snapshot: async () => null, dispose() {} },
    summaries: { admit: async () => {}, view: () => ({ totalsLoading: true as const }), subscribe: () => () => {}, settled: async () => {}, dispose() {} },
    workflowViewProjection: { snapshot: async () => null, settled: async () => {}, dispose() {} },
    workflowLiveProjection: { snapshot: async () => null, settled: async () => {}, dispose() {} },
    questionProjection: { snapshot: async () => null, dispose() {} },
    roleProjection: { snapshot: async () => null, async dispose() {} },
    authStatusProjection: {
      observedSessionIds: new Set<string>(),
      snapshot: async () => ({ providers: [], warnings: [], profile: { id: "default", persistedId: "default", displayName: "Default", source: "default" as const, projectBinding: undefined, availableProfiles: [] }, subscriptionSpendConsent: { kind: "available" as const, profileId: "default", usageGeneration: 0, authorityIncarnation: "test-authority", authorityRevision: 0, accounts: [] } }),
      view: (profile: AuthProfileResolution) => ({ providers: [], warnings: [], profile, subscriptionSpendConsent: { kind: "available" as const, profileId: profile.id, usageGeneration: 0, authorityIncarnation: "test-authority", authorityRevision: 0, accounts: [] } }),
      replace: (profile: AuthProfileResolution) => ({ providers: [], warnings: [], profile, subscriptionSpendConsent: { kind: "available" as const, profileId: profile.id, usageGeneration: 0, authorityIncarnation: "test-authority", authorityRevision: 0, accounts: [] } }),
    },
    capabilities: {
      view: () => ({ capabilities: [], moduleIds: [], descriptorIdentity: "test", modules: [], warnings: [], requireWorkflowConfirmation: true, workflowsMode: "off" as const, persistentProcesses: { persisted: false, effective: false, forcedByCli: false } }),
      workflowsMode: () => "off" as const,
      setModule: async () => ({ ok: true as const }),
      setModules: async () => ({ ok: true as const }),
      setWorkflowMode: async () => ({ ok: true as const }),
      setPersistentProcesses: async () => ({ ok: true as const }),
      refresh: async () => {},
      dispose: async () => {},
    },
    gitAiAttribution: {
      view: () => ({ kind: "available" as const }),
      check: async () => ({ kind: "available" as const }),
      dispose() {},
    },
    git: { view: () => ({ directories: { "/project": { branch: "main" } } }), dispose() {} },
    commandUsage: { view: () => ({ uses: [] }), record: () => true, dispose() {} },
    commandCatalog: { snapshot: () => ({ revision: 1, builtInCommands: [], offCommands: [] }), dispose: async () => {} },
    commandInvoke: { invoke: async () => ({ kind: "unavailable" as const, message: "Commands are not used in this fixture" }) },
    historyProjection: {
      sessionDetail: async () => ({ view: null }),
      outputWindow: async (_sessionId: string, request: OutputRangeRequest) => ({
        totalBlocks: 0,
        visibleMessageCount: 0,
        range: {
          kind: "ok" as const,
          consistencyToken: "test:v1",
          anchor: request.anchor,
          window: { startBlockIndex: null, endBlockIndex: null, hasBefore: false, hasAfter: false, contentBytes: 0 },
          blocks: [],
          streamingToolText: {}, streamingOutputChars: 0,
        },
      }),
      outputRange: async (_sessionId: string, request: OutputRangeRequest) => ({
        kind: "ok" as const,
        consistencyToken: "test:v1",
        anchor: request.anchor,
        window: { startBlockIndex: null, endBlockIndex: null, hasBefore: false, hasAfter: false, contentBytes: 0 },
        blocks: [],
        streamingToolText: {}, streamingOutputChars: 0,
      }),
      outputGroupChildren: async (_sessionId: string, request: OutputGroupChildrenRequest) => ({
        groups: request.groupBlockIds.map((groupBlockId) => ({
          groupBlockId,
          totalChildren: 0,
          contentBytes: 0,
          children: [],
        })),
        contentBytes: 0,
      }),
      outputBlockBody: async (_sessionId: string, request: OutputBlockBodyRequest) => ({ blockId: request.blockId }),
      // The shutdown barrier joins this projection's durable flush and blocks the
      // later phases when it ends unsafely, so the double owns a real settlement.
      dispose: async () => {},
    },
    outputProjection: { async flush() {}, watch() {}, dispose() {} },
    config: { view: () => configView, refresh: async () => configView, mutate: async () => await new Promise<never>(() => {}), dispose: async () => {} },
  }
}

/** The app-service tests exercise routing at the controller boundary. */
export function workflowController(_sessionStore: SessionStore, _manager: SessionManager): WorkflowController {
  return {
    restoreLaunchTracking: async () => {},
    startWorkflow: async () => ({ error: "Workflow starts are not used in this fixture" }),
    commitLaunch: async () => ({ kind: "retained" }),
    stopLaunch: async () => { throw new Error("Workflow stops are not used in this fixture") },
    launchCut: async () => undefined,
    resumeLaunch: async () => ({ ok: false, error: "Workflow resumes are not used in this fixture" }),
    resumeWorkflow: async () => ({ kind: "not_found", message: "Workflow resumes are not used in this fixture" }),
    sendWorkflow: async (sessionId) => ({ kind: "not_delivered", sessionId }),
    restartWorkflow: async () => ({ kind: "failed", message: "Workflow restarts are not used in this fixture" }),
  }
}

/** Real module routing with injected runtime control owners. */
export function workflowProtocol(options: {
  readonly controller: WorkflowController
  readonly supervisor?: RuntimeSupervisor
  readonly store?: EventStore | RuntimeEventStore
  readonly sessions?: SessionStore
  readonly manager?: SessionManager
  readonly hosts?: Pick<WorkflowHosts, "isRunning" | "onChange" | "abort">
}) {
  const store = options.store ?? createMemoryStore([])
  const bus = createRuntimeUiBus()
  const reader = asAsyncEventReadSurface(store)
  const projections = fakeProjections()
  return composeModuleProtocolRuntimes([workflowsModule], {
    eventStore: reader, projectionReader: reader, eventWriter: asAsyncEventWriter(store),
    manager: options.manager ?? fakeManager(), sessionStore: options.sessions ?? fakeSessionStore(new Map()),
    definitions: repoDefinitions(), onStored: () => () => {}, publish: bus.publish, snapshotPosition: bus.snapshotPosition,
    hasLiveSession: () => false, interruptSession: async () => false,
    background: async () => { throw new Error("Workflow protocol fixture reads its own aggregate") },
    modules: workflowProtocolServices({
      modules: NO_MODULE_SERVICES, projectRoot: "/workspace", controller: options.controller,
      auth: { snapshot: async () => { throw new Error("Auth read not requested") }, select: async () => false, list: async () => [] },
      authStatus: projections.authStatusProjection, supervisor: options.supervisor ?? runtimeSupervisor(), bus,
      deletion: options.manager ?? fakeManager(),
      hosts: options.hosts ?? { isRunning: () => false, onChange: () => () => {}, abort: async () => false },
    }),
  }, () => ["workflows"])
}

export interface FakeSessionStore extends SessionStore {
  readonly disposeCalls: () => number
  emitChange(): void
}

export interface FakeManager extends SessionManager {
  emitChange(sessionIds?: readonly string[]): void
  emitDeleted(sessionId: string): void
}

export function questionBlock(): QuestionBlock {
  return {
    kind: "question",
    toolUseId: "tool-1",
    questions: [{ question: "Continue?", choices: [{ kind: "option", label: "Yes" }], multiSelect: false }],
    timestamp: 2,
  }
}

export function chatEntry(overrides: Partial<ChatSessionEntry> = {}): ChatSessionEntry {
  return {
    kind: "chat",
    entryEpoch: 1,
    runner: null,
    conversationId: "conv-1",
    description: "Chat title",
    outputBlocks: () => [{ kind: "text", id: "text-1", content: "hello", timestamp: 1 }, questionBlock()],
    outputSequenceStart: 0,
    visibleMessageCountPrefix: 0,
    visibleMessageCountSuffix: 1,
    streamingToolText: {},
    tokens: 12,
    cost: 0.25,
    billedCost: 0,
    priceUnavailable: false,
    contextPercent: 40,
    streamingOutputChars: 5,
    contextPromptTokens: 7,
    startedAt: 10,
    streamPhase: "thinking",
    runnerState: "absent",
    activityStartedAt: 0,
    streamingStartedAt: null,
    accumulatedActiveMs: 3,
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

export function fakeSessionStore(entries: Map<string, SessionEntry>): FakeSessionStore {
  const listeners = new Set<(changed: ReadonlySet<string> | undefined) => void>()
  const revisions = new Map<string, number>()
  let disposeCount = 0
  const emitChange = (): void => {
    for (const listener of listeners) listener(undefined)
  }
  const bump = (id: string): void => { revisions.set(id, (revisions.get(id) ?? 0) + 1) }

  return {
    disposeCalls: () => disposeCount,
    emitChange,
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
    terminateBackgroundWork: () => {},
    remove: async (sessionId) => {
      entries.delete(sessionId)
      revisions.delete(sessionId)
      emitChange()
    },
    updateEntry: (sessionId, patch) => {
      const entry = entries.get(sessionId)
      if (!entry) return
      const outputBlocks = patch.outputBlocks
      entries.set(sessionId, { ...entry, ...patch, runner: entry.runner, conversationId: entry.conversationId, startedAt: entry.startedAt, entryEpoch: entry.entryEpoch, outputBlocks: outputBlocks === undefined ? entry.outputBlocks : () => outputBlocks })
      bump(sessionId)
      emitChange()
    },
    updateChatEntry: (sessionId, patch) => {
      const entry = entries.get(sessionId)
      if (entry?.kind !== "chat") return
      const outputBlocks = patch.outputBlocks
      entries.set(sessionId, { ...entry, ...patch, kind: "chat", runner: entry.runner, conversationId: entry.conversationId, startedAt: entry.startedAt, entryEpoch: entry.entryEpoch, outputBlocks: outputBlocks === undefined ? entry.outputBlocks : () => outputBlocks })
      bump(sessionId)
      emitChange()
    },
    answerQuestion: () => false,
    cancelQuestion: () => false,
    compactConversation: async () => false,
    learnFromSession: () => false,
    runningCount: () => entries.size,
    allIds: () => [...entries.keys()],
    revision: (sessionId) => revisions.get(sessionId) ?? 0,
    drainOutputChanges: () => EMPTY_OUTPUT_CHANGE_BATCH,
    reorder: () => false,
    disposeAll: async () => {
      disposeCount += 1
      entries.clear()
      emitChange()
    },
    refreshDeps: async () => {},
    onChange: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

export function fakeManager(overrides: Partial<FakeManager> = {}): FakeManager {
  const listeners = new Set<(change: SessionMetadataChange) => void>()
  const capturedProfiles = new Map<string, string>()
  const manager: FakeManager = {
    emitChange: (sessionIds = []) => {
      for (const listener of listeners) listener({ kind: "changed", sessionIds })
    },
    emitDeleted: (sessionId) => {
      for (const listener of listeners) listener({ kind: "deleted", sessionId })
    },
    allocateId: () => "allocated-id",
    publishWorkflow: async (opts) => opts.id,
    commitWorkflow: async () => { throw new Error("Workflow publication is not used by this fixture") },
    adoptWorkflow: async () => false,
    publishSubagent: async (opts) => opts.id,
    createChat: async (opts) => opts.id ?? "created-id",
    createChatFromContext: async () => "created-id",
    forkChat: async () => "forked-id",
    listMetadata: async () => ({ sessions: [], errors: [] }),
    listActive: async () => ({ sessions: [], errors: [] }),
    // Empty by default so scoped reads never look like catalog replays in
    // call-count pins; tests needing scoped rows override listForIds directly.
    listForIds: async () => ({ sessions: [], errors: [] }),
    read: async () => null,
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

export function runtimeSupervisor(overrides: Partial<RuntimeSupervisor> = {}): RuntimeSupervisor {
  return {
    claimComposerReturns: async () => ({ ok: true, kind: "empty" }),
    ownedSessionIds: () => [],
    awaitAcceptedWork: async () => {},
    replacementSuccessorRows: () => undefined,
    reconcileChildSessionCompletions: async () => ({ reconciledCount: 0, workflowAggregateReads: 0 }),
    undoChanges: async () => { throw new Error("Undo is not used in this fixture") },
    openSessionRuntime: async () => "new-chat",
    adoptBlankChat: () => {},
    forkSession: async () => "forked-chat",
    ensureChatRunner: async () => { throw new Error("chat runner is not used") },
    sessionKind: async () => "chat",
    sendChat: async (): Promise<SendChatOutcome> => ({ ok: true }),
    acceptRetainedOperation: async () => true,
    activateSession: async () => true,
    releaseSession: async () => {},
    hideSession: async () => {},
    closeChat: async () => true,
    discardTransientChat: async () => ({ removed: true }),
    renameSession: async () => true,
    deleteSession: async () => true,
    reorderSession: () => true,
    dismissNotice: () => true,
    interruptSession: async () => true,
    resumeChat: async () => ({ ok: true }),
    releaseForegroundBash: () => true,
    terminateBackgroundWork: async () => {},
    answerQuestion: async () => ({ ok: true }),
    cancelQuestion: async () => ({ ok: true }),
    compactChat: async () => true,
    reviewChat: async () => true,
    requestChatContext: async () => true,
    recallQueuedMessage: async () => null,
    warmChatRunner: async () => {},
    interruptForReplacement: async () => [],
    disposeAll: async () => {},
    runtimeState: () => null,
    ...overrides,
  }
}
