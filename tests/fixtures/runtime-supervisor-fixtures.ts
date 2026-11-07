import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ManagedRuntime } from "effect"
import type { RuntimeEventStore } from "../../src/infra/sqlite-event-store.js"
import { EventReaderService, EventStoreLive, LocalEventStoreService, type EventStoreRuntime } from "../../src/infra/event-store-effect.js"
import { resolveEventStoreDbFile } from "../../src/infra/paths.js"
import { createRuntimeSupervisor } from "../../src/orchestration/app-service/runtime-supervisor.js"
import type { RuntimeRunnerCapabilities, RuntimeSupervisor, RuntimeSupervisorDeps } from "../../src/orchestration/app-service/runtime-supervisor-types.js"
import { createChatRunnerLoader } from "../../src/orchestration/app-service/chat-runner-loader.js"
import type { ChatRunnerDeps } from "../../src/orchestration/chat/runner.js"
import type { ChatRunner } from "../../src/orchestration/chat/runner-types.js"
import { NO_MODULE_RUNTIMES } from "../../src/infra/module-runtime.js"
import { createSessionManager, type SessionManager } from "../../src/orchestration/session/manager.js"
import { createContinuationLanes, type ContinuationLanes } from "../../src/orchestration/session/planned-session-continuation.js"
import { createSessionStore } from "../../src/orchestration/session-store/store.js"
import { createWorkflowHosts } from "../../src/orchestration/modules/workflows/host-collection.js"
import { childSessionProjectionAttachment } from "../../src/orchestration/session-store/child-session-projection.js"
import type { WorkflowHosts } from "../../src/orchestration/workflow-host/host-collection.js"
import type { WorkflowRunner } from "../../src/orchestration/workflow-host/runner-types.js"
import type { SessionStore } from "../../src/orchestration/session-store/types.js"
import { testDirectories } from "../helpers/directories.js"
import { runtimeDispatch } from "../helpers/runtime-dispatch.js"
import type { FrontendMutation, MutationResult, RuntimeClient } from "../../src/protocol/app-service-types.js"
import type { SessionAuthAdmission } from "../../src/orchestration/session/session-auth-profile.js"
import type { WorkflowDeps } from "../../src/orchestration/workflow-host/deps.js"
import { fixtureDefinitions } from "../helpers/project-definitions.js"
import { testCapabilityModules, testRuntimeConfigCapture } from "../helpers/request-tool-surface.js"
import { authProviders } from "../helpers/auth-context.js"
import type { ConversationMessage } from "../../src/orchestration/agent-runtime/llm/types.js"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../src/infra/event-store-types.js"
import { tryOpenConversationTree } from "../../src/orchestration/session/conversation/conversation-tree-handle.js"
import { unusedChildSessionControl } from "../helpers/child-session-control.js"
import { createBackgroundWorkRegistry } from "../../src/orchestration/agent-runtime/background-work.js"
import { planEveryCapability } from "../helpers/attempt-brief.js"

export interface SupervisorTestContext {
  readonly baseDir: string
  readonly store: RuntimeEventStore
  readonly runtime: EventStoreRuntime
  readonly manager: SessionManager
  readonly sessionStore: SessionStore
  readonly workflowHosts: WorkflowHosts
  /** The one set of continuation lanes of the executor under test, which
   *  its supervisor, its subagents controls, and its continuation share. */
  readonly continuationLanes: ContinuationLanes
}

type SupervisorOverrides =
  & Partial<Omit<RuntimeRunnerCapabilities, "runnerLoader">>
  & Pick<RuntimeSupervisorDeps, "onRunnerDone" | "onRunnerError" | "resumeWorkflow" | "reconcileChildSessionCompletions">
  & { readonly createRunner?: (deps: ChatRunnerDeps) => Promise<ChatRunner> }


/** Builds the SQLite-backed context the RuntimeSupervisor tests share: a real
 *  event store, session manager, and session store over a temp dir, or over
 *  `baseDir` when the caller owns one. The caller disposes the runtime and
 *  removes the dir in `afterEach`. */
export function createSupervisorTestContext(baseDir = mkdtempSync(join(tmpdir(), "flywheel-runtime-supervisor-"))): SupervisorTestContext {
  mkdirSync(baseDir, { recursive: true })
  const runtime = ManagedRuntime.make(EventStoreLive(resolveEventStoreDbFile(baseDir)))
  const store = runtime.runSync(LocalEventStoreService)
  const projectionReader = runtime.runSync(EventReaderService)
  const sessionStore = createSessionStore(runtime, projectionReader)
  const workflowHosts = createWorkflowHosts({ runtime, projectionReader, attachChildProjection: childSessionProjectionAttachment(sessionStore) })
  return { baseDir, store, runtime, manager: createSessionManager({ projectRoot: baseDir, executionCwd: baseDir, store }), sessionStore, workflowHosts, continuationLanes: createContinuationLanes() }
}

export async function disposeSupervisorTestContext(ctx: SupervisorTestContext): Promise<void> {
  await ctx.workflowHosts.disposeAll(() => "runtime")
  await ctx.sessionStore.disposeAll()
  await ctx.runtime.dispose()
  rmSync(ctx.baseDir, { recursive: true, force: true })
}

export function supervisorConversationFixture(currentContext: () => SupervisorTestContext) {
  async function chatConversationId(sessionId: string): Promise<string> {
    const session = await currentContext().manager.read(sessionId)
    if (session?.kind !== "chat") throw new Error(`Expected chat session ${sessionId}`)
    return session.conversationId
  }

  async function appendConversation(sessionId: string, messages: readonly ConversationMessage[]): Promise<void> {
    const ctx = currentContext()
    const conversationId = await chatConversationId(sessionId)
    if (!conversationId) throw new Error(`no conversationId for ${sessionId}`)
    const tree = await tryOpenConversationTree({ conversationId, sessionId, store: asAsyncEventReadSurface(ctx.store), writer: asAsyncEventWriter(ctx.store) })
    if (!tree) throw new Error(`expected conversation tree ${conversationId}`)
    const result = await tree.appendMessages(messages)
    await tree.getStorage().dispose()
    if (result.kind !== "committed") throw new Error(`tree append failed: ${result.kind}`)
  }

  // Loadability is tree-gated (audit item 13): a durable chat opens iff its
  // conversation has a committed user turn.
  async function commitUserTurn(sessionId: string): Promise<void> {
    await appendConversation(sessionId, [{ kind: "user", content: "hello" }])
  }

  return { chatConversationId, appendConversation, commitUserTurn }
}

export function supervisorBaseDeps(
  ctx: SupervisorTestContext,
  sessionStore: SessionStore = ctx.sessionStore,
  overrides: Partial<SupervisorOverrides> = {},
): Parameters<typeof createRuntimeSupervisor>[0] {
  const composition = supervisorTestComposition()
  const reader = ctx.runtime.runSync(EventReaderService)
  const capabilities: RuntimeRunnerCapabilities = {
    definitions: composition.runner.definitions,
    moduleSelection: composition.runner.moduleSelection,
    resolveKey: composition.runner.resolveKey,
    authAdmission: composition.authAdmission,
    subscribeProfiles: () => async () => {},
    runnerLoader: createChatRunnerLoader({ authAdmission: composition.authAdmission, createRunner: overrides.createRunner }),
    recall: overrides.recall ?? (async () => ({ hits: [] })),
    childSessions: unusedChildSessionControl(),
    ...(overrides.proactiveCompactionThreshold ? { proactiveCompactionThreshold: overrides.proactiveCompactionThreshold } : {}),
    workflowMode: overrides.workflowMode ?? (() => "ask"),
    ...(overrides.capabilities ? { capabilities: overrides.capabilities } : {}),
    ...(overrides.moduleServices ? { moduleServices: overrides.moduleServices } : {}),
    ...(overrides.launcher ? { launcher: overrides.launcher } : {}),
    ...(overrides.persistentProcesses ? { persistentProcesses: overrides.persistentProcesses } : {}),
    ...(overrides.allowPersistentProcesses ? { allowPersistentProcesses: overrides.allowPersistentProcesses } : {}),
    ...(overrides.startWorkflow ? { startWorkflow: overrides.startWorkflow } : {}),
  }
  return {
    undoChanges: composition.undoChanges,
    sessionStore, workflowHosts: ctx.workflowHosts,
    manager: ctx.manager,
    directories: testDirectories(ctx.baseDir),
    runtime: ctx.runtime,
    store: reader,
    projectionReader: reader,
    runnerCapabilities: async () => capabilities,
    authProfileId: () => "default",
    lifecycle: {
      settleSessionStore: async (causeOf) => { await ctx.workflowHosts.disposeAll(causeOf); await sessionStore.disposeAll() },
      settleAuthAdmission: () => composition.authAdmission.dispose(),
    },
    continuationLanes: ctx.continuationLanes,
    // No client attaches to a supervisor under test unless the test says so.
    clientsHold: () => false,
    ...(overrides.onRunnerDone ? { onRunnerDone: overrides.onRunnerDone } : {}),
    ...(overrides.onRunnerError ? { onRunnerError: overrides.onRunnerError } : {}),
    ...(overrides.resumeWorkflow ? { resumeWorkflow: overrides.resumeWorkflow } : {}),
    ...(overrides.reconcileChildSessionCompletions ? { reconcileChildSessionCompletions: overrides.reconcileChildSessionCompletions } : {}),
  }
}

/** Canonical composition ports for supervisors whose runners are test doubles. */
export function supervisorTestComposition() {
  const authAdmission = testSessionAuthAdmission()
  return {
    undoChanges: async () => { throw new Error("Supervisor test must inject Undo") },
    kernel: {
      undoChanges: async () => { throw new Error("Supervisor test must inject Undo") },
      authProfileId: () => "default",
      lifecycle: {
        settleSessionStore: async () => {},
        settleAuthAdmission: () => authAdmission.dispose(),
      },
    } satisfies Pick<RuntimeSupervisorDeps, "undoChanges" | "authProfileId" | "lifecycle">,
    runner: {
      definitions: fixtureDefinitions(),
      moduleSelection: testCapabilityModules,
      resolveKey: async () => undefined,
      authAdmission,
    } satisfies Pick<RuntimeRunnerCapabilities, "definitions" | "moduleSelection" | "resolveKey" | "authAdmission">,
    authAdmission,
  }
}

/** Quiet auth authority for supervisor tests whose injected runner does not
 *  inspect model dependencies. */
export function testSessionAuthAdmission(): SessionAuthAdmission<WorkflowDeps> {
  const workflowDeps: WorkflowDeps = {
    ...testDirectories(process.cwd()),
    auth: {
      providers: authProviders(), credentialLineages: {}, droppedCredentials: [],
    },
    availableModels: new Map(),
    modelInfos: new Map(),
    definitions: fixtureDefinitions(),
    moduleSelection: testCapabilityModules,
    captureRuntimeConfig: testRuntimeConfigCapture,
    createAgent: () => { throw new Error("Supervisor test must inject its runner") },
    prepareRequest: () => { throw new Error("Supervisor test must inject its runner") },
    planCapabilities: planEveryCapability,
    createLLMClient: async () => { throw new Error("Supervisor test must not call a provider") },
    captureProviderConnection: async () => { throw new Error("Supervisor test must not capture a provider") },
    runOwnedCommand: async () => { throw new Error("Supervisor test must not launch a process") },
    resolveEnvSnapshot: async () => { throw new Error("Supervisor test must not probe its environment") },
    awaitModelAccessSettled: async () => {},
  }
  const snapshot = Object.freeze({ profile: { persistedId: "default", effectiveId: "default" }, workflowDeps })
  return {
    admitDefaults: async () => snapshot,
    admit: async () => snapshot,
    admitWorkflow: async () => snapshot,
    currentWorkflow: () => snapshot,
    current: () => snapshot,
    invalidate: () => [],
    dispose: async () => {},
  }
}

export function supervisorWithRunner(ctx: SupervisorTestContext, createRunner: (deps: ChatRunnerDeps) => Promise<ChatRunner>): RuntimeSupervisor {
  return createRuntimeSupervisor(supervisorBaseDeps(ctx, ctx.sessionStore, { createRunner }))
}

/** A no-op `ChatRunner` whose disposal count is observable, shared by the
 *  RuntimeSupervisor unit tests. Each test overrides only the methods it asserts
 *  on (deliverCommitted, send, ...); everything else stays a quiet
 *  default so the harness never accidentally exercises real runner behavior. */
export function mockRunner(sessionId: string, overrides: Partial<ChatRunner> = {}): ChatRunner & { disposeCalls(): number } {
  let disposed = 0
  return {
    sessionId,
    chatModuleHosts: NO_MODULE_RUNTIMES,
    backgroundTasks: createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} }),
    abort: () => {},
    applyProjectionEvent: () => {},
    interrupt: () => false,
    terminateBackgroundWork: () => {},
    dispose: async () => { disposed += 1 },
    send: async () => "accepted",
    deliverHeldMessage: async () => ({ status: "held", reason: "no_reader" }), messageState: async () => "at_rest",
    recallQueuedMessage: () => null,
    deliverCommitted: () => true,
    deliverBackgroundNotification: async () => true,
    requestWithContext: () => true,
    resumeCommitted: () => true,
    awaitOwedCapacity: async () => false,
    setShown: () => {},
    resume: () => false,
    releaseForegroundBash: () => false,
    transferForegroundForReplacement: async () => {},
    adoptHandedOver: async () => {},
    awaitTurnSettlement: async () => {},
    awaitLogicalTurnDurability: async () => {},
    compact: async () => false,
    answerQuestion: () => {},
    cancelQuestion: () => {},
    holdsRunningTurn: () => false,
    prepareForShutdown: () => {},
    interruptForReplacement: async () => false,
    interruptPlannedCut: async () => "running",
    hold: async () => NO_MODULE_RUNTIMES,
    capabilities: async () => () => true,
    seedDisplayBlocks: () => {},
    disposeCalls: () => disposed,
    ...overrides,
  }
}

/** A quiet `WorkflowRunner` in place of a live one, as `mockRunner` is for a
 *  chat: each test overrides only the methods it asserts on. */
export function mockWorkflowRunner(sessionId: string, overrides: Partial<WorkflowRunner> = {}): WorkflowRunner {
  return {
    sessionId,
    interruption: () => undefined,
    cut: async () => undefined,
    handBack: async () => ({ kind: "not_parked" }),
    continueHeldMessages: async () => {},
    run: async () => ({ completed: false, attemptsCompleted: 0, attemptsTotal: 1, cost: 0, tokens: 0 }),
    prepare: async () => null,
    readQueue: async () => { throw new Error("not read") },
    abort: async () => {},
    applyProjectionEvent: () => {},
    interruptForReplacement: async () => false,
    interruptPlannedCut: async () => "running",
    stepModuleRuntimes: async () => undefined,
    stepBackgroundTasks: () => undefined,
    releaseForegroundBash: () => false,
    transferForegroundForReplacement: async () => {},
    terminateBackgroundWork: () => {},
    interrupt: async () => false,
    resume: async () => false,
    continueCapacity: () => new Set(),
    dispose: async () => {},
    recallQueuedMessage: () => null,
    compact: async () => false,
    ...overrides,
  }
}

/** An externally settled promise: the supervisor tests resolve it to make a
 *  runner startup complete on a controlled tick, exercising the close/dispose
 *  -during-startup races. */
export function createDeferred<T>() {
  let resolveFn: (value: T) => void = () => {}
  let rejectFn: (reason: unknown) => void = () => {}
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve
    rejectFn = reject
  })
  return { promise, resolve: resolveFn, reject: rejectFn }
}

/** The resume commands a planned continuation dispatches. */
export type ResumeMutation = Extract<FrontendMutation, { readonly type: "chat.resume" | "subagent.resume" }>

/** A runtime dispatch that answers both resume kinds with `answer`. */
export function resumeDispatch(answer: (mutation: ResumeMutation) => Promise<MutationResult<ResumeMutation>>): RuntimeClient["dispatch"] {
  return runtimeDispatch({ "chat.resume": answer, "subagent.resume": answer })
}
