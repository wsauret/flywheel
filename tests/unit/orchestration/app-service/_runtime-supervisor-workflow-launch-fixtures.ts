import { NO_MODULE_SERVICES } from "../../../../src/infra/module-service.js"
import { readFileSync, rmSync } from "node:fs"
import { EventReaderService, EventStoreWriterService } from "../../../../src/infra/event-store-effect.js"
import { bindRetainedOperationHost, composeRetainedOperationHosts } from "../../../../src/infra/retained-operation-hosts.js"
import { createRuntimeSupervisor } from "../../../../src/orchestration/app-service/runtime-supervisor.js"
import { attachedRunnerDelivery } from "../../../../src/orchestration/app-service/session-background-notifications.js"
import type { RuntimeSupervisor } from "../../../../src/orchestration/app-service/runtime-supervisor-types.js"
import { createConversationTreeWriterController, type ConversationTreeWriterController } from "../../../../src/orchestration/chat/tree-writer.js"
import { loadSessionView } from "../../../../src/orchestration/session-store/view.js"
import { tryOpenConversationTree } from "../../../../src/orchestration/session/conversation/conversation-tree-handle.js"
import type { SessionManager } from "../../../../src/orchestration/session/manager.js"
import { bindRetainedOperations, bindSessionStops } from "../../../../src/orchestration/session/module-session-operations.js"
import { createWorkflowController } from "../../../../src/orchestration/workflow-host/controller.js"
import { workflowLaunchHost, type WorkflowLaunchHost } from "../../../../src/orchestration/workflow-host/launch-operation-contract.js"
import { createSupervisorTestContext, mockRunner, mockWorkflowRunner, supervisorBaseDeps, supervisorConversationFixture, type SupervisorTestContext } from "../../../fixtures/runtime-supervisor-fixtures.js"
import { assistantMessage } from "../session/_save-point-fixtures.js"
import { cleanupProjectRoots, createCapabilities, createDeps, makeWorkflowDeps } from "../workflow-host/_workflow-controller-fixtures.js"
import type { WorkflowHosts } from "../../../../src/orchestration/workflow-host/host-collection.js"
import type { WorkflowRunner } from "../../../../src/orchestration/workflow-host/runner-types.js"
import { createSessionAuthAdmission } from "../../../../src/orchestration/session/session-auth-profile.js"
import type { AgentFactory } from "../../../../src/orchestration/agent-runtime/types.js"
import { reconcileChildSessionCompletions } from "../../../../src/orchestration/session/child-session-reconciliation.js"
import { EventBus } from "../../../../src/infra/event-bus.js"
import { createStoredChatSession } from "../chat/_chat-session-agent-runtime-fixtures.js"
import { contentEvidence } from "../../../../src/infra/content-evidence.js"
import { createSessionFactWriter } from "../../../../src/orchestration/session/session-fact-writer.js"
import { modelWorkflowLaunchOrigin } from "../../../../src/orchestration/workflow-host/launch-origin.js"
import { fullAuthority } from "../../../helpers/launch-authority.js"
import { basename, join } from "node:path"
import { resolveSessionDir } from "../../../../src/infra/paths.js"
import { stageWorkflowSource } from "../../../../src/orchestration/workflow-host/path-workflow.js"

const contexts: SupervisorTestContext[] = []
const supervisors: RuntimeSupervisor[] = []

function launchHosts(ctx: SupervisorTestContext) {
  const running = new Map<string, WorkflowRunner>()
  const starts: string[] = []
  const aborts: string[] = []
  return {
    ...ctx.workflowHosts,
    _startCalls: starts,
    _abortCalls: aborts,
    start: async ({ sessionId, onDefinitionAccepted }) => {
      await onDefinitionAccepted?.()
      starts.push(sessionId)
      running.set(sessionId, mockWorkflowRunner(sessionId))
      return sessionId
    },
    get: (id) => running.get(id),
    allIds: () => [...running.keys()],
    isRunning: (id) => running.has(id),
    abort: async (id) => { aborts.push(id); running.delete(id); return true },
    remove: async (id) => { running.delete(id) },
    disposeAll: async () => { running.clear() },
  } satisfies WorkflowHosts & { readonly _startCalls: string[]; readonly _abortCalls: string[] }
}

export async function cleanup(): Promise<void> {
  for (const supervisor of supervisors.splice(0).toReversed()) {
    await supervisor.disposeAll()
  }
  cleanupProjectRoots()
  const dirs = new Set<string>()
  for (const ctx of contexts.splice(0)) {
    await ctx.workflowHosts.disposeAll(() => "runtime")
    await ctx.runtime.dispose()
    dirs.add(ctx.baseDir)
  }
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
}

/** One executor composition over a real SQLite store: the supervisor whose
 *  chat actors accept launches, the workflow controller it binds as their
 *  host, and chat runners whose writers are real conversation tree writers.
 *  The runners never call a provider: a model turn would show as a call to
 *  `resume`, `resumeCommitted`, or `deliverCommitted`. */
export function compose(ctx: SupervisorTestContext, options: {
  readonly manager?: SessionManager
  readonly capabilities?: ReturnType<typeof createCapabilities>
  readonly onRunnerError?: (id: string, errorMessage: string) => Promise<void>
  /** The workflow host reconciles a parent through the parent's actor, as
   *  production composes it, so the reconciliation waits for the parent's
   *  running turn. */
  readonly reconcilesThroughParentActor?: boolean
  /** When the parent's running turn ends; at once by default. */
  readonly parentTurnEnds?: () => Promise<void>
  readonly beforeParentReconciliation?: () => Promise<void>
  /** Sees each notification a chat's attached runner takes. */
  readonly onBackgroundNotification?: (sessionId: string, key: string | undefined) => void
  /** Sees each session read that a Stop's routing makes. */
  readonly onStopRead?: (sessionId: string) => void
  /** Runs each child in a real workflow runner in the supervisor's session
   *  store, as production does, with agents from this factory. */
  readonly runsWorkflows?: AgentFactory
  /** Runs in the preflight of each child's workflow host, so the start of
   *  the child's runtime waits for it. */
  readonly runtimePreflight?: () => Promise<void>
  readonly realChat?: boolean
} = {}) {
  const reader = ctx.runtime.runSync(EventReaderService)
  const writer = ctx.runtime.runSync(EventStoreWriterService)
  const writers = new Map<string, ConversationTreeWriterController>()
  let modelTurns = 0
  const events = new EventBus()
  events.subscribeToType("agent.run.started", () => { modelTurns += 1 })
  const modelTurn = (): boolean => { modelTurns += 1; return false }
  const workflows = launchHosts(ctx)
  const { runtimePreflight } = options
  // The host awaits the accepted definition inside its post-preflight step,
  // so a failure or wait added after it fails or holds the runtime's start.
  const realHosts: WorkflowHosts = runtimePreflight ? {
    ...ctx.workflowHosts,
    start: (input) => ctx.workflowHosts.start({ ...input, onDefinitionAccepted: async () => { await input.onDefinitionAccepted?.(); await runtimePreflight() } }),
  } : ctx.workflowHosts
  const activeHosts = options.runsWorkflows ? realHosts : workflows
  // The supervisor's hosts and the controller name each other, so a host
  // reaches the controller only when it is called, after both exist.
  const host: WorkflowLaunchHost = {
    restoreLaunchTracking: (childSessionId, tasks) => controller.restoreLaunchTracking(childSessionId, tasks),
    commitLaunch: (operation, cell) => controller.commitLaunch(operation, cell), stopLaunch: (childSessionId, stoppedBy) => controller.stopLaunch(childSessionId, stoppedBy),
    launchCut: (childSessionId) => controller.launchCut(childSessionId), resumeLaunch: (childSessionId) => controller.resumeLaunch(childSessionId),
  }
  const hosts = composeRetainedOperationHosts([bindRetainedOperationHost(workflowLaunchHost, host)])
  const retainedOperations = bindRetainedOperations({ reader, writer, hosts })
  const supervisor = createRuntimeSupervisor({
    ...supervisorBaseDeps(ctx, ctx.sessionStore, {
      createRunner: async ({ sessionId }) => {
        const session = await ctx.manager.read(sessionId)
        if (session?.kind !== "chat") throw new Error(`Session ${sessionId} is not a chat`)
        const treeWriter = createConversationTreeWriterController({ conversationId: session.conversationId, sessionId, projectRoot: ctx.baseDir, store: reader, projectionReader: reader, writer })
        writers.set(sessionId, treeWriter)
        if (options.realChat) {
          const stored = await createStoredChatSession({
            sessionId, conversationId: session.conversationId, projectRoot: ctx.baseDir, reader, writer,
            seed: async () => {},
            overrides: { eventBus: events, updateEntry: (patch) => ctx.sessionStore.updateChatEntry(sessionId, patch), treeWriter },
          })
          if (options.parentTurnEnds) {
            const durable = stored.chat.awaitLogicalTurnDurability
            stored.chat.awaitLogicalTurnDurability = async () => { await durable(); await options.parentTurnEnds?.() }
          }
          return stored.chat
        }
        return mockRunner(sessionId, {
          acceptRetainedOperation: (held) => treeWriter.acceptRetainedOperation(held),
          resume: modelTurn,
          resumeCommitted: modelTurn,
          deliverCommitted: modelTurn,
          ...(options.parentTurnEnds ? { awaitLogicalTurnDurability: options.parentTurnEnds } : {}),
          deliverBackgroundNotification: async (notification) => { options.onBackgroundNotification?.(sessionId, notification.key); return true },
          dispose: async () => { await treeWriter.dispose() },
        })
      },
      ...(options.reconcilesThroughParentActor ? {
        reconcileChildSessionCompletions: (parentSessionId, sweep) => reconcileChildSessionCompletions({
          parentSessionId, reader, projectionReader: reader, writer, ...sweep,
        }),
      } : {}),
    }),
    workflowHosts: activeHosts,
    sessionViewLoader: { load: (id) => loadSessionView(id, reader, reader) },
    retainedOperations,
    sessionStops: bindSessionStops({ hosts, modules: NO_MODULE_SERVICES, reader, projectionReader: reader, writer, projectRoot: ctx.baseDir, read: (id) => { options.onStopRead?.(id); return (options.manager ?? ctx.manager).read(id) }, deliverNotification: attachedRunnerDelivery(ctx.sessionStore) }),
  })
  supervisors.push(supervisor)
  const createAgent = options.runsWorkflows
  const profile = {
    id: "default", persistedId: "default", displayName: "Default", source: "default" as const,
    directory: join(ctx.baseDir, "auth", "profiles", "default"), availableProfiles: [{ id: "default", displayName: "Default" }],
    projectBinding: undefined, retirements: {},
  }
  const authAdmission = createSessionAuthAdmission({
    manager: ctx.manager, materialize: async () => { throw new Error("Unexpected retirement") },
    authProfiles: { inspect: () => profile },
    workflows: { snapshot: async () => profile },
    prepare: async () => ({ ...makeWorkflowDeps(), ...(createAgent ? { createAgent } : {}) }),
  })
  const controller = createWorkflowController({
    ...createDeps({
      manager: options.manager ?? ctx.manager,
      projectRoot: ctx.baseDir,
      eventReader: reader,
      projectionReader: reader,
      eventWriter: writer,
      sessionStore: ctx.sessionStore,
      workflowHosts: activeHosts,
      authAdmission,
      ...(createAgent ? { prepareWorkflowDeps: async () => ({ ...makeWorkflowDeps(), createAgent }) } : {}),
      ...(options.capabilities ? { capabilities: options.capabilities } : {}),
      ...(options.onRunnerError ? { onRunnerError: options.onRunnerError } : {}),
      ...(options.reconcilesThroughParentActor ? { reconcileChildSessionCompletions: async (parentSessionId: string) => { await options.beforeParentReconciliation?.(); return supervisor.reconcileChildSessionCompletions(parentSessionId) } } : {}),
    }),
  })
  return { supervisor, controller, workflows, writers, reader, writer, retainedOperations, modelTurns: () => modelTurns }
}

export function context(baseDir?: string): SupervisorTestContext {
  const ctx = createSupervisorTestContext(baseDir)
  contexts.push(ctx)
  return ctx
}

/** A durable parent chat whose committed user turn the model answered, so it
 *  is loadable and owes no answer before any launch. */
export async function parentChat(ctx: SupervisorTestContext): Promise<string> {
  const parentId = await ctx.manager.createChat({ name: "Parent" })
  await supervisorConversationFixture(() => ctx).appendConversation(parentId, [{ kind: "user", content: "hello" }, assistantMessage("Hello.")])
  return parentId
}

export async function branch(ctx: SupervisorTestContext, sessionId: string) {
  const conversationId = await supervisorConversationFixture(() => ctx).chatConversationId(sessionId)
  const tree = await tryOpenConversationTree({ conversationId, sessionId, store: ctx.runtime.runSync(EventReaderService) })
  if (!tree) throw new Error(`Session ${sessionId} has no conversation`)
  try {
    return await tree.getBranch()
  } finally {
    tree.getStorage().dispose()
  }
}

/** A model's file launch, recorded at the tool boundary of its parent chat. */
export async function modelCall(ctx: SupervisorTestContext, composition: ReturnType<typeof compose>, parentId: string) {
  const content = readFileSync(join(import.meta.dir, "../../../fixtures/workflow-project/workflows/repair.yaml"), "utf8")
  const file = stageWorkflowSource({ kind: "content", content }, resolveSessionDir(parentId, ctx.baseDir), ctx.baseDir)
  if ("error" in file) throw new Error(file.error)
  const source = { kind: "path" as const, path: join("scratch", "workflows", basename(file.path)) }
  const input = { source, description: "Build it" }
  const evidence = contentEvidence(JSON.stringify(input))
  const facts = createSessionFactWriter({ sessionId: parentId, writer: composition.writer })
  await facts.record({
    type: "tool.input.completed", version: 1, actor: "agent",
    payload: {
      toolUseId: "workflow-call", toolName: "workflow", input,
      inputBytes: evidence.bytes, inputSha256: evidence.sha256, inputPreview: evidence.preview,
      executionMode: "background", traceKind: "subagent", childHasOwnViewport: true, modelRequestId: "request",
    },
  })
  facts.dispose()
  const conversationId = await supervisorConversationFixture(() => ctx).chatConversationId(parentId)
  const launch = await composition.controller.startWorkflow({
    source, description: input.description,
    origin: modelWorkflowLaunchOrigin(parentId, { conversationId, toolUseId: "workflow-call", confirmation: { kind: "absent" }, authority: fullAuthority() }),
  })
  if ("error" in launch) throw new Error(launch.error)
  return launch
}
export const quietAgent: AgentFactory = () => ({
  send() {}, end() {}, abort() {},
  done: Promise.resolve({ servedRequests: 0, durationMs: 0, terminal: { kind: "api_error", message: "no model request", recovery: { kind: "none" } } }),
})


