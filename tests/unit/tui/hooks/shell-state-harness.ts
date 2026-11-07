import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ManagedRuntime } from "effect"
import { NO_MODULE_RUNTIMES } from "../../../../src/infra/module-runtime"
import { createBackgroundWorkRegistry } from "../../../../src/orchestration/agent-runtime/background-work"
import { onCleanup } from "solid-js"
import { createShellState } from "../../../../src/tui/hooks/shell-state"
import { createSessionStore } from "../../../../src/orchestration/session-store/store"
import { createAuthStatusProjection } from "../../../../src/orchestration/app-service/auth-status-projection"
import { createFrontendProjection } from "../../../../src/orchestration/app-service/frontend-projection"
import { createOutputProjection } from "../../../../src/orchestration/app-service/output-projection"
import { createShippedOutput } from "../../../../src/orchestration/app-service/shipped-output"
import { outputCursor } from "../../../../src/protocol/output-protocol-types"
import { createBudgetProtocolProjection } from "../../../../src/orchestration/app-service/budget-protocol-projection"
import { createSessionDetailProjection } from "../../../../src/orchestration/app-service/session-detail-projection"
import { createQuestionProtocolProjection } from "../../../../src/orchestration/app-service/question-protocol-projection"
import { createRoleProtocolProjection } from "../../../../src/orchestration/app-service/role-protocol-projection"
import { projectRoleAssignments } from "../../../../src/orchestration/app-service/role-assignment-projection"
import { effectiveRoleAssignments } from "../../../../src/orchestration/config/session-role-resolver"
import { createStatusProjection } from "../../../../src/orchestration/app-service/status-projection"
import { createFlywheelAppService } from "../../../../src/orchestration/app-service/app-service"
import { fakeLanes } from "../../../helpers/fake-lanes.js"
import { createRuntimeUiBus } from "../../../../src/orchestration/app-service/runtime-ui-bus"
import type { RuntimeSummaryProjection } from "../../../../src/orchestration/app-service/runtime-summary-projection"
import { runRuntimeShutdownBarrier } from "../../../../src/orchestration/app-service/runtime-shutdown"
import type { FlywheelAppService } from "../../../../src/orchestration/app-service/app-service.js"
import type { RuntimeConfigCache } from "../../../../src/tui/hooks/shell-state.js"
import type { GitView } from "../../../../src/protocol/git-protocol-types.js"
import { runtimeQuery } from "../../../helpers/runtime-dispatch.js"
import type { SessionManager } from "../../../../src/orchestration/session/manager"
import type { ReplayedSession } from "../../../../src/orchestration/session/schemas"
import type { ChatRunner } from "../../../../src/orchestration/chat/runner-types"
import type { SessionStore } from "../../../../src/orchestration/session-store/types"
import { composeFirstPartyModules } from "../../../../src/orchestration/modules.js"
import { durableCatalogRowFromSession, readyCatalogRow } from "../../../../src/orchestration/session/session-catalog-row.js"
import { EventStoreLive, EventStoreService, EventReaderService } from "../../../../src/infra/event-store-effect.js"
import { fakeProjections, runtimeSupervisor } from "../../orchestration/app-service/app-service-doubles.js"
import { makeWorkflowDeps } from "../../orchestration/workflow-host/_workflow-controller-fixtures.js"
import { testAccountHome, testAccountResources } from "../../../helpers/directories.js"

/** The project root of the harness workspace, which is also where its sessions
 *  execute: ARCH-DIRECTORIES-007 makes the project root the default execution placement. */
const HARNESS_PROJECT_ROOT = tmpdir()

// The batched-writes refactor split the event store into four services, so the
// runtime must be built from EventStoreLive (the layer that provides all of
// them) -- not Layer.succeed(EventStoreService), which leaves EventReaderService
// unsatisfied. Pattern mirrors runtime-supervisor.test.ts and event-store-service.test.ts.
// One db and runtime for the whole process: this harness module is shared by
// every shell-state test file bun runs in one process, so disposing it from
// any single file's afterAll would break the files that run later. The db
// lives in the process's test account home. The preload releases its resources
// before removing that home after the last test file.
const dbFile = join(mkdtempSync(join(testAccountHome(), "fw-shell-state-")), "flywheel.sqlite")
export const runtime = ManagedRuntime.make(EventStoreLive(dbFile))
testAccountResources.defer(() => runtime.dispose())
export const eventStore = runtime.runSync(EventStoreService)

export async function waitForAssertion(assert: () => void): Promise<void> {
  let lastError: unknown
  for (let i = 0; i < 100; i++) {
    try { assert(); return } catch (err) { lastError = err }
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

/** Minimal WorkflowDeps stub for tests that call sessionStore.start(). */
export const stubWorkflowDeps = makeWorkflowDeps()

export function createMockChatRunner(sessionId: string): ChatRunner {
  return {
    chatModuleHosts: NO_MODULE_RUNTIMES,
    backgroundTasks: createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} }),
    applyProjectionEvent: () => {},
    sessionId,
    abort: () => {},
    interrupt: () => false,
    dispose: async () => {},
    send: async () => "accepted",
    deliverHeldMessage: async () => ({ status: "held", reason: "no_reader" }), messageState: async () => "at_rest",
    recallQueuedMessage: () => null,
    compact: async () => false,
    deliverCommitted: () => true,
    deliverBackgroundNotification: async () => true,
    answerQuestion: () => {},
    cancelQuestion: () => {},
    resumeCommitted: () => false,
    awaitOwedCapacity: async () => false,
    setShown: () => {},
    resume: () => false,
    awaitTurnSettlement: async () => {},
    awaitLogicalTurnDurability: async () => {},
    requestWithContext: () => false,
    hold: async () => NO_MODULE_RUNTIMES,
    capabilities: async () => () => true,
    holdsRunningTurn: () => false,
    interruptForReplacement: async () => false,
    interruptPlannedCut: async () => "ended",
    releaseForegroundBash: () => false,
    transferForegroundForReplacement: async () => {},
    adoptHandedOver: async () => {},
    prepareForShutdown: () => {},
    terminateBackgroundWork: () => {},
    seedDisplayBlocks: () => {},
  }
}

type ChatSession = Extract<ReplayedSession, { readonly kind: "chat" }>

/** Durable session metadata per store, standing in for the SessionManager
 *  catalog. `executionCwd` has no authority other than this metadata, so the
 *  frontend projection emits no catalog row and no output for a live entry
 *  whose metadata is missing. */
const durableCatalogs = new WeakMap<SessionStore, Map<string, ChatSession>>()

function durableCatalog(sessionStore: SessionStore): Map<string, ChatSession> {
  const existing = durableCatalogs.get(sessionStore)
  if (existing) return existing
  const created = new Map<string, ChatSession>()
  durableCatalogs.set(sessionStore, created)
  return created
}

/** The metadata SessionManager.createChat persists before any live entry exists.
 *  Call this before openSessionRuntime, as production does. */
export function createSessionMetadata(sessionStore: SessionStore, sessionId: string, overrides: Partial<Pick<ChatSession, "label" | "name" | "executionCwd">> = {}): void {
  durableCatalog(sessionStore).set(sessionId, {
    label: "New Chat",
    lifecycleState: "active",
    kind: "chat",
    command: "chat",
    lastUpdated: "2026-01-01T00:00:00.000Z",
    executionCwd: HARNESS_PROJECT_ROOT,
    conversationId: `conv-${sessionId}`,
    ...overrides,
  })
}

/** Production protocol in miniature: persist the session metadata, open the
 *  shell entry, then attach the live runner (shell-then-attach; there is no
 *  one-shot spawn path). */
export function attachChat(sessionStore: SessionStore, sessionId: string, runner: ChatRunner = createMockChatRunner(sessionId), description?: string): void {
  createSessionMetadata(sessionStore, sessionId, description !== undefined ? { label: description, name: description } : {})
  sessionStore.openSessionRuntime({ sessionId, conversationId: `conv-${sessionId}`, ...(description !== undefined ? { description } : {}) })
  if (!sessionStore.attachChatRunner(sessionId, runner)) throw new Error(`attachChatRunner refused for ${sessionId}`)
}

/** A manager that serves the store's durable metadata catalog (the projection's
 *  reads: listMetadata().errors, listActive, listForIds, subscribe) plus the role-join
 *  `read`. Overrides layer onto this base. */
export function managerStub(sessionStore: SessionStore, overrides: Partial<SessionManager> = {}): SessionManager {
  const refuse = (method: string) => (): never => { throw new Error(`the shell harness manager does not ${method}`) }
  const manager: SessionManager = {
    allocateId: () => "",
    publishWorkflow: async (input) => input.id,
    commitWorkflow: refuse("commitWorkflow"),
    adoptWorkflow: refuse("adoptWorkflow"),
    publishSubagent: async (input) => input.id,
    createChat: async (opts) => opts.id ?? "",
    forkChat: refuse("forkChat"),
    createChatFromContext: refuse("createChatFromContext"),
    listMetadata: async () => ({ sessions: [...durableCatalog(sessionStore)].map(([id, session]) => durableCatalogRowFromSession(id, session, session.executionCwd ?? HARNESS_PROJECT_ROOT)), errors: [] }),
    listActive: async () => {
      const { sessions, errors } = await manager.listMetadata()
      return { sessions: sessions.filter((session) => session.lifecycleState === "active"), errors }
    },
    // Mirrors the real manager: same rows as listMetadata(), scoped to the ids.
    // Defined against `manager` so a test overriding listMetadata() stays coherent.
    listForIds: async (ids) => {
      const wanted = new Set(ids)
      const { sessions, errors } = await manager.listMetadata()
      return { sessions: sessions.filter((session) => wanted.has(session.id)), errors }
    },
    read: async (id) => durableCatalog(sessionStore).get(id) ?? null,
    updateLifecycleState: async () => {},
    publishActivation: () => Promise.resolve(),
    updateLabel: async () => false,
    updateChatMetadata: async () => {},
    captureRolesIfAbsent: async () => false,
    captureAuthProfileIfAbsent: refuse("captureAuthProfileIfAbsent"),
    selectAuthProfile: refuse("selectAuthProfile"),
    selectAuthProfileWithRoleSnapshot: refuse("selectAuthProfileWithRoleSnapshot"),
    replaceRoleSnapshot: async () => false,
    updateRoleAssignment: async () => false,
    removeRoleAssignment: async () => false,
    unlinkChild: async () => {},
    admitDeletion: async (id) => ({ rootSessionId: id, targets: [] }),
    finalizeDeletionTarget: async () => [],
    recoverStaleSessions: async () => 0,
    subscribe: () => () => {},
    ...overrides,
  }
  return manager
}

/** The shell-state-under-test is a client of a real app-service bound to the
 *  same SessionStore, so the migrated protocol clients reflect the live sessions
 *  these tests drive. The session-domain signals read the session cache; live
 *  output flows through the projector into the transcript store. */
export function buildAppService(sessionStore: ReturnType<typeof createSessionStore>, manager: SessionManager, gitView?: GitView): FlywheelAppService {
  const projections = fakeProjections()
  const summaries = liveSummaries(sessionStore)
  const projection = createFrontendProjection({ sessionStore, manager, summaries, projectRoot: HARNESS_PROJECT_ROOT, maxSnapshotHz: 1000 })
  const bus = createRuntimeUiBus()
  const outputProjection = createOutputProjection({ sessionStore, shipped: createShippedOutput({ publish: bus.publish }) })
  const statusProjection = createStatusProjection({ sessionStore, publish: bus.publish, flushOutput: outputProjection.flush, outputPosition: (sessionId) => bus.snapshotPosition({ kind: "cursor", cursor: outputCursor(sessionId) }), awaitsContinuation: async () => false, recordedActiveMs: async () => 0, onStored: () => () => {}, handedOver: { commands: async () => [], onChange: () => () => {} }, replyWaits: { addressees: async () => [], onChange: () => () => {} }, processorHolds: { heldToolCallIds: () => [], onHoldsChanged: () => () => {} } })
  const budgetProjection = createBudgetProtocolProjection({
    sessionStore,
    summaries,
    publish: bus.publish,
  })
  const reader = runtime.runSync(EventReaderService)
  const questions = createQuestionProtocolProjection({ sessionStore, reader, onStored: eventStore.onStored, publish: bus.publish })
  const questionProjection = {
    snapshot: async (sessionId: string) => (await questions).snapshot(sessionId),
    dispose: () => { void questions.then((resolvedQuestions) => resolvedQuestions.dispose()) },
  }
  const service = createFlywheelAppService({
    ...projections,
    backgroundLane: {
      ...projections.backgroundLane,
      recall: async () => { throw new Error("Conversation recall is not used in this harness") },
      transcriptSearch: async () => { throw new Error("Transcript search is not used in this harness") },
    },
    moduleProtocol: projections.moduleProtocol,
    projection,
    outputProjection,
    statusProjection,
    budgetProjection,
    questionProjection,
    roleProjection: createRoleProtocolProjection({ manager, publish: bus.publish, readRoles: async (id) => {
      const snapshot = (await manager.read(id))?.roleAssignments
      return snapshot ? { assignments: projectRoleAssignments(effectiveRoleAssignments(snapshot)) } : null
    } }),
    authStatusProjection: createAuthStatusProjection({
      initialProfile: {
        id: "default", persistedId: "default", displayName: "Default", retirements: {},
        source: "default",
        directory: join(tmpdir(), "flywheel", "auth", "profiles", "default"),
        availableProfiles: [],
        projectBinding: undefined,
      },
      moduleSelection: () => composeFirstPartyModules(),
      subscriptionSpendConsent: (profileId) => ({ kind: "available", profileId, usageGeneration: 0, authorityIncarnation: "test", authorityRevision: 0, accounts: [] }),
    }),
    commandCatalog: { snapshot: () => ({ revision: 1, builtInCommands: [], offCommands: [] }), dispose: async () => {} },
    commandInvoke: { invoke: async () => ({ kind: "unavailable" as const, message: "Commands are not used in this harness" }) },
    historyProjection: createSessionDetailProjection({ sessionStore, manager, reader: eventStore, projectionReader: reader, projectRoot: HARNESS_PROJECT_ROOT }),
    runtimeSupervisor: runtimeSupervisor(),
    bus,
    chatDefault: () => ({ kind: "pending" }),
    projectRoot: HARNESS_PROJECT_ROOT,
    summaries,
  })
  const query = runtimeQuery({
    gitSnapshot: async () => ({ git: gitView ?? projections.git.view(), snapshotPosition: bus.snapshotPosition({ kind: "cursor", cursor: { scope: "workspace", domain: "git" } }) }),
  }, (request) => service.query(request))
  return { ...service, query }
}

function liveSummaries(sessionStore: SessionStore): RuntimeSummaryProjection {
  return {
    admit: async () => {},
    view(sessionId) {
      const entry = sessionStore.get(sessionId)
      if (!entry) return { totalsLoading: true }
      return {
        totalsLoading: false,
        row: readyCatalogRow({
          id: sessionId,
          kind: "chat",
          title: entry.description,
          executionCwd: HARNESS_PROJECT_ROOT,
          lifecycleState: "active",
          notices: entry.notices,
          inputMode: { kind: "chat" },
          lastUpdated: new Date(entry.startedAt).toISOString(),
          totalsLoading: true,
        }, {
          totalCost: entry.cost,
          totalBilledCost: entry.billedCost,
          priceUnavailable: entry.priceUnavailable,
          totalTokens: entry.tokens,
          contextPercent: entry.contextPercent,
          contextPromptTokens: entry.contextPromptTokens,
          durationMs: entry.accumulatedActiveMs,
        }),
      }
    },
    subscribe: () => () => {},
    settled: async () => {},
    dispose() {},
  }
}

export function buildShellState(
  sessionStore: ReturnType<typeof createSessionStore>,
  now: () => number = () => Date.now(),
  managerOverrides: Partial<SessionManager> = {},
  runtimeConfig: RuntimeConfigCache = { view: () => undefined, settlePublication: async () => false },
  gitView?: GitView,
) {
  const manager = managerStub(sessionStore, managerOverrides)
  // Return the appService too: migrated output reads flow through the live output
  // projector, so tests drive output by publishing through it.
  const appService = buildAppService(sessionStore, manager, gitView)
  onCleanup(() => { void runRuntimeShutdownBarrier(appService.shutdown) })
  return { ...createShellState({
    // The terminal reads the service through its lane, which is open here.
    appService: { query: appService.query, dispatch: appService.dispatch, subscribe: appService.subscribe, ...fakeLanes().client },
    projectRoot: HARNESS_PROJECT_ROOT,
    now,
    runtimeConfig,
    setTerminalTitle: () => {},
    showToast: () => {},
  }), appService }
}
