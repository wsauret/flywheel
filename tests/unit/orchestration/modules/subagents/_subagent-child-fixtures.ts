import { expect } from "bun:test"
import type { SessionManager } from "../../../../../src/orchestration/session/manager.js"
import { reconcileChildSessionCompletions } from "../../../../../src/orchestration/session/child-session-reconciliation.js"
import { loadSubagentRunsFromEvents, SUBAGENT_RUN_FACT_TYPES } from "../../../../../src/orchestration/modules/subagents/history/subagent-run-projection.js"
import { ManagedRuntime } from "effect"
import { EventStoreLive } from "../../../../../src/infra/event-store-effect.js"
import type { AgentDefinition } from "../../../../../src/infra/agent-definition.js"
import { contentEvidence } from "../../../../../src/infra/content-evidence.js"
import { asAsyncEventReadSurface, asAsyncEventWriter, type AsyncGuardedEventWriter, type EventStoreAppend, type LocalSqliteEventStore } from "../../../../../src/infra/event-store-types.js"
import { resolveEventStoreDbFile } from "../../../../../src/infra/paths.js"
import { createSqliteEventStore } from "../../../../../src/infra/sqlite-event-store.js"
import { createSessionStore } from "../../../../../src/orchestration/session-store/store.js"
import { childSessionProjectionAttachment } from "../../../../../src/orchestration/session-store/child-session-projection.js"
import { createBackgroundWorkRegistry } from "../../../../../src/orchestration/agent-runtime/background-work.js"
import type { Agent, AgentOptions, AgentRunResult } from "../../../../../src/orchestration/agent-runtime/types.js"
import { createSubagentSessionAuthority } from "../../../../../src/orchestration/modules/subagents/execution/session-authority.js"
import type { SubagentDispatchDeps } from "../../../../../src/orchestration/modules/subagents/execution/dispatch-deps.js"
import { createSubagentDispatch } from "../../../../../src/orchestration/modules/subagents/execution/tool.js"
import { createSessionManager } from "../../../../../src/orchestration/session/manager.js"
import { createSessionFactWriter, prepareSessionFactAppend } from "../../../../../src/orchestration/session/session-fact-writer.js"
import { temporaryDirectories } from "../../../../helpers/directories.js"
import { makeDeps, makeContext } from "../../agent-runtime/subagent/_fixtures.js"
import { repoDefinitions } from "../../../../helpers/project-definitions.js"
import { createSubagentContinuationService } from "../../../../../src/orchestration/modules/subagents/execution/continuation-service.js"
import { createSessionAuthAdmission } from "../../../../../src/orchestration/session/session-auth-profile.js"
import type { WorkflowDeps } from "../../../../../src/orchestration/workflow-host/deps.js"
import { asModelClient } from "../../agent-runtime/_model-client.js"
import { subagentsModule } from "../../../../../src/orchestration/modules/subagents.js"
import type { ModuleRuntimeServices } from "../../../../../src/orchestration/agent-runtime/module-runtime-services.js"
import { createBackgroundExecutionOwner, type BackgroundExecutionOwner } from "../../../../../src/orchestration/agent-runtime/background-execution-owner.js"
import { createForegroundBashHoldController } from "../../../../../src/orchestration/agent-runtime/foreground-bash-hold.js"
import { composeModuleRuntimes, NO_MODULE_RUNTIMES } from "../../../../../src/infra/module-runtime.js"
import { NO_MODULE_SERVICES } from "../../../../../src/infra/module-service.js"
import { chatRunner } from "../../app-service/_frontend-projection-fixtures.js"
import type { ChatRunner } from "../../../../../src/orchestration/chat/runner-types.js"
import { createSessionMessaging } from "../../../../../src/orchestration/session/session-messaging.js"
import { unusedChildSessionControl } from "../../../../helpers/child-session-control.js"
import type { CapabilityAccess } from "../../../../../src/orchestration/agent-runtime/tools/types.js"
import { roleCapture } from "../../../../helpers/role-capture.js"
import { buildDurableSubagentCreated, buildSubagentPrompted } from "../../../../../src/orchestration/modules/subagents/history/subagent-run-fact-writers.js"
import { createProviderRequestAuditWriter } from "../../../../../src/orchestration/agent-runtime/llm/provider-request-audit.js"

const delegator: AgentDefinition = {
  kind: "persona",
  name: "delegator",
  description: "Delegates bounded work to another delegator.",
  role: "explorer",
  tools: ["read"],
  maxTurns: 10,
  systemPrompt: "Delegate only when the assignment requires it.",
  subagentRoles: ["delegator"],
}

export type SubagentChildHarness = ReturnType<typeof createHarness>

/** A durably published child with no process-local host, as after a host
 *  exit. Without `parent`, a new chat is its parent. */
export async function createUnstartedChild(manager: SessionManager, projectRoot: string, parent?: { sessionId: string; conversationId: string }): Promise<{ parentSessionId: string; parentConversationId: string; childSessionId: string; childConversationId: string }> {
  const { sessionId: parentSessionId, conversationId: parentConversationId } = parent ?? await createParentChat(manager)
  const childSessionId = manager.allocateId()
  const childConversationId = manager.allocateId()
  await manager.publishSubagent({
    id: childSessionId, conversationId: childConversationId, description: "child", initialRoles: {}, executionCwd: projectRoot,
    launchedFrom: { parentSessionId, conversationId: parentConversationId, toolUseId: "dispatch-tool" },
    runBinding: prepareSessionFactAppend(childSessionId, buildDurableSubagentCreated({
      childSessionId, childRunId: "run-1", conversationId: childConversationId,
      parentSessionId, parentConversationId, parentToolCallId: "dispatch-tool",
      persona: { name: "explorer", kind: "persona" },
      capabilityGrant: {
        operation: "subagent dispatch", required: ["subagents"], capabilities: ["subagents"], moduleIds: ["subagents"],
        requireWorkflowConfirmation: false, workflowsMode: "on", identity: "test",
      },
      admittedModuleIds: ["subagents"], skillsRevision: 1, model: "test-model", tools: ["read"], executionCwd: projectRoot,
      budget: { maxTurns: 2, maxTokens: 1000 }, parentDepth: 0, description: "child",
    })),
    assignment: "inspect",
    promptFact: prepareSessionFactAppend(childSessionId, buildSubagentPrompted({
      childRunId: "run-1", prompt: "inspect", task: "inspect", toolNames: ["read"],
    })),
  })
  return { parentSessionId, parentConversationId, childSessionId, childConversationId }
}

/** A harness factory whose project roots the calling test file owns. Call it
 *  once at the top level of the file, because it registers the `afterEach`
 *  hook that removes each root after the case that created it. A hook in this
 *  shared module would bind only to the first test file that imports it, so
 *  every later file in the same `bun test` process would leak its roots. */
export function subagentChildHarnesses(): (createRunner: (options: AgentOptions) => Agent, manageSessions?: (manager: SessionManager) => SessionManager) => SubagentChildHarness {
  const temporaryDirectory = temporaryDirectories()
  return (createRunner, manageSessions) => createHarness(temporaryDirectory("flywheel-subagent-child-sessions-"), createRunner, manageSessions)
}

/** Uses real session admission and continuation ownership with a local provider seam. */
export function continuationParentHost(harness: SubagentChildHarness, sessionId: string, conversationId: string, createAgent: WorkflowDeps["createAgent"], existingOwner?: BackgroundExecutionOwner, capabilityAccess: CapabilityAccess | undefined = makeContext().capabilityAccess) {
  const base = makeDeps()
  const owner = existingOwner ?? createBackgroundExecutionOwner(harness.backgroundTasks)
  const foregroundBashHold = createForegroundBashHoldController(() => {})
  const services: ModuleRuntimeServices = {
    ...base, dispatchOwner: owner, subagentSessions: harness.authority, sessionId,
    conversation: { aggregateId: conversationId, providerSessionKey: conversationId, artifactScopeId: sessionId },
    modules: NO_MODULE_SERVICES, childSlots: base.childSlots, purpose: { kind: "interactive-chat" },
    projectRoot: harness.projectRoot, executionCwd: harness.projectRoot,
    definitions: repoDefinitions(), personas: repoDefinitions().personas(), promptKind: "chat",
    model: base.parentModel, servingModel: { model: base.parentModel, modelFamily: base.modelFamily, availableModels: base.availableModels },
    createLLMClient: () => { throw new Error("The parent host makes no model call") },
    budgetStreamId: sessionId, auxiliaryRequestAudit: createProviderRequestAuditWriter({ identity: { providerSessionKey: conversationId }, promptKind: "chat" }), loadedSkillIds: new Set(),
    availableModels: new Map([[base.modelFamily, base.availableModels ?? new Set<string>()]]),
    createRunner: createAgent, onEvent: () => {},
    inheritableRuntimeSurfaces: { foregroundBashHold, sessions: createSessionMessaging({ manager: harness.manager, projectionReader: harness.reader, eventWriter: harness.writer }, unusedChildSessionControl()) },
    sessionEventStore: harness.reader, capabilityAccess,
  }
  const runtime = subagentsModule.runtime.create(services)
  if (!runtime) throw new Error("The parent host did not assemble")
  const modules = composeModuleRuntimes([["subagents", runtime]])
  const runner: ChatRunner = { ...chatRunner(sessionId), moduleRuntimes: NO_MODULE_RUNTIMES, hold: async () => modules }
  return { owner, foregroundBashHold, modules, runtime, runner, surfaces: services.inheritableRuntimeSurfaces, capabilityAccess: services.capabilityAccess }
}

export function continuationService(harness: SubagentChildHarness, createAgent: WorkflowDeps["createAgent"], overrides: Partial<WorkflowDeps> = {}, openChatRunner?: (sessionId: string) => Promise<ChatRunner | undefined>) {
  const base = makeDeps()
  const admission = createSessionAuthAdmission<WorkflowDeps>({
    manager: harness.manager,
    authProfiles: { inspect: () => ({ id: "default", persistedId: "default", displayName: "Default", directory: base.userDataRoot, projectBinding: undefined, source: "default", availableProfiles: [{ id: "default", displayName: "Default" }], retirements: {} }) },
    materialize: async () => { throw new Error("This fixture does not retire profiles") },
    prepare: async (profileId) => {
      const deps: WorkflowDeps = {
        userDataRoot: base.userDataRoot, accountHome: base.accountHome, activeProfileId: profileId,
        auth: { providers: new Map(), credentialLineages: {}, droppedCredentials: [] },
        availableModels: new Map(), modelInfos: new Map(), definitions: repoDefinitions(),
        moduleSelection: base.moduleSelection, captureRuntimeConfig: base.captureRuntimeConfig, createAgent,
        prepareRequest: () => { throw new Error("This fixture prepares no pre-start") },
        createLLMClient: async (model) => asModelClient({
          model, modelFamily: "anthropic", accessProvider: "anthropic_api", contextLimit: 100_000,
          outputLimit: 8_000, supportsReasoning: false, promptNotes: { progress: "", modelNotes: "" },
          priceFor: () => ({ status: "unavailable", reason: "missing-rate-card" }),
          async *streamWithTools() { throw new Error("This fixture does not stream") },
        }),
        captureProviderConnection: async () => ({
          ...roleCapture(["claude-sonnet-4.6", "claude-opus-4.6", "gpt-5", "gpt-6.1-sol", "gpt-6-luna"]),
          admit: () => ({ createAgent: deps.createAgent, createLLMClient: deps.createLLMClient }),
        }),
        runOwnedCommand: async () => { throw new Error("This fixture launches no commands") },
        resolveEnvSnapshot: async () => { throw new Error("This fixture does not probe an environment") },
        capabilityAccess: makeContext().capabilityAccess,
        awaitModelAccessSettled: async () => {},
        ...overrides,
      }
      return deps
    },
  })
  const hosts = new Map<string, ReturnType<typeof continuationParentHost>>()
  const service = createSubagentContinuationService({
    directories: { projectRoot: harness.projectRoot, executionCwd: harness.projectRoot, userDataRoot: base.userDataRoot, accountHome: base.accountHome },
    sessionManager: harness.manager, sessionStore: harness.sessionStore, eventStore: harness.reader,
    projectionReader: harness.reader, enabled: () => true,
    executionEnvironment: () => ({ authAdmission: admission, recall: async () => ({ hits: [] }), attachProjection: childSessionProjectionAttachment(harness.sessionStore), deliverNotification: async () => false,
      openChatRunner: openChatRunner ?? (async (sessionId) => {
        const parent = await harness.manager.read(sessionId)
        if (parent?.kind !== "chat") return undefined
        const host = hosts.get(sessionId) ?? continuationParentHost(harness, sessionId, parent.conversationId, createAgent)
        hosts.set(sessionId, host)
        return host.runner
      }),
    }),
  })
  return { service, async close() { await Promise.all([...hosts.values()].map((host) => host.owner.close())); await admission.dispose() } }
}

/** Resolves once `reached` holds. A child's transcript and metrics reach the
 *  session store over an asynchronous event bus, and the store notifies its
 *  subscribers once per coalesced burst, after the output projection has
 *  published. A test re-checks on each notification, so it waits for the state
 *  it asserts rather than for a guessed duration. */
export function sessionStoreReaches(harness: SubagentChildHarness, reached: () => boolean): Promise<void> {
  if (reached()) return Promise.resolve()
  return new Promise((resolve) => {
    const unsubscribe = harness.sessionStore.onChange(() => {
      if (!reached()) return
      unsubscribe()
      resolve()
    }, "subagent-child-test")
  })
}

function createHarness(projectRoot: string, createRunner: (options: AgentOptions) => Agent, manageSessions: (manager: SessionManager) => SessionManager = (manager) => manager) {
  const store = createSqliteEventStore(resolveEventStoreDbFile(projectRoot))
  const reader = asAsyncEventReadSurface(store)
  const runtime = ManagedRuntime.make(EventStoreLive(resolveEventStoreDbFile(projectRoot)))
  const sessionStore = createSessionStore(runtime, reader)
  const baseWriter = asAsyncEventWriter(store)
  const batches: (readonly EventStoreAppend[])[] = []
  let rejectNextActivation = false
  const observeBatch = (events: readonly EventStoreAppend[]): void => {
    batches.push(events)
    if (rejectNextActivation && events.some((event) => event.type === "session.lifecycle.changed")) {
      rejectNextActivation = false
      throw new Error("injected activation publication failure")
    }
  }
  const writer: AsyncGuardedEventWriter = {
    append: (event) => baseWriter.append(event),
    appendBatch: async (events) => {
      observeBatch(events)
      return baseWriter.appendBatch(events)
    },
    appendGuarded: async (event) => {
      observeBatch([event])
      return baseWriter.appendGuarded(event)
    },
    appendBatchGuarded: async (events) => {
      observeBatch(events)
      return baseWriter.appendBatchGuarded(events)
    },
    pruneSupersededEvents: (...args) => baseWriter.pruneSupersededEvents(...args),
    pruneSupersededKeyedEvents: (...args) => baseWriter.pruneSupersededKeyedEvents?.(...args) ?? Promise.resolve(0),
    putInFlight: (...args) => baseWriter.putInFlight?.(...args) ?? Promise.reject(new Error("missing in-flight writer")),
    dropInFlight: (...args) => baseWriter.dropInFlight?.(...args) ?? Promise.reject(new Error("missing in-flight writer")),
    swapInFlight: (...args) => baseWriter.swapInFlight?.(...args) ?? Promise.resolve(false),
    swapInFlightBatch: (...args) => baseWriter.swapInFlightBatch?.(...args) ?? Promise.resolve(false),
  }
  const manager = manageSessions(createSessionManager({ projectRoot, executionCwd: projectRoot, projectionReader: reader, writer }))
  const backgroundTasks = createBackgroundWorkRegistry({ kind: "workflow", enqueueNotification: () => {} })
  const metricUpdates: string[] = []
  const authority = createSubagentSessionAuthority({
    manager,
    eventStore: reader,
    projectionReader: reader,
    eventWriter: writer,
    projectRoot,
    recall: async () => ({ hits: [] }),
    attachProjection: async (input) => {
      const projection = await childSessionProjectionAttachment(sessionStore)(input)
      return {
        ...projection,
        updateMetrics(metrics) {
          metricUpdates.push(input.sessionId)
          projection.updateMetrics(metrics)
        },
      }
    },
  })
  const registry = new Map([[delegator.name, delegator]])
  return {
    projectRoot,
    store,
    reader,
    writer,
    manager,
    backgroundTasks,
    batches,
    rejectNextActivation() { rejectNextActivation = true },
    authority,
    sessionStore,
    metricUpdates,
    /** The parent's subagent tool. `deps` shapes what the dispatch launches,
     *  such as its personas or project instructions; the durable authorities
     *  above always own the child. */
    tool(parentSessionId: string, deps: Partial<SubagentDispatchDeps> = {}) {
      const dispatch = createSubagentDispatch(makeDeps({
        agentRegistry: registry,
        ...deps,
        sessionId: parentSessionId,
        subagentSessions: authority,
        sessionEventStore: reader,
        createRunner,
        backgroundTasks: deps.backgroundTasks ?? backgroundTasks,
      }))
      /** Records the parent's call as its runner does before the call runs. */
      const recordCall = async (toolName: "subagent" | "process", input: Parameters<typeof dispatch.execute>[0], context: Parameters<typeof dispatch.execute>[1]) => {
        const inputEvidence = contentEvidence(JSON.stringify(input))
        const facts = createSessionFactWriter({ sessionId: parentSessionId, writer })
        await facts.record({
          type: "tool.input.completed",
          version: 2,
          actor: "agent",
          payload: {
            toolUseId: context.toolUseId,
            providerCallId: `provider-${context.toolUseId}`,
            providerToolName: toolName,
            toolName,
            modelRequestId: context.modelRequestId ?? `request-${context.toolUseId}`,
            input,
            inputBytes: inputEvidence.bytes,
            inputSha256: inputEvidence.sha256,
            inputPreview: inputEvidence.preview,
            executionMode: toolName === "subagent" ? "background" : "foreground",
            traceKind: toolName === "subagent" ? "subagent" : "tool",
            childHasOwnViewport: toolName === "subagent",
          },
        })
        facts.dispose()
      }
      return {
        resume: dispatch.resume,
        async execute(input: Parameters<typeof dispatch.execute>[0], context: Parameters<typeof dispatch.execute>[1]) {
          await recordCall("subagent", input, context)
          return dispatch.execute(input, context)
        },
        /** The parent's `process` Resume of its child: the same continuation
         *  as a person's Resume, recorded as the parent's call and result. */
        async processResume(childSessionId: string, context: Parameters<typeof dispatch.execute>[1]) {
          await recordCall("process", { action: "resume", process_id: childSessionId }, context)
          const result = await dispatch.resume(childSessionId, context)
          const facts = createSessionFactWriter({ sessionId: parentSessionId, writer })
          await facts.record({ type: "tool.result.recorded", version: 1, actor: "flywheel", payload: { toolUseId: context.toolUseId, outcome: result.outcome === "ok" ? "ok" : "error", contentPreview: result.content } })
          facts.dispose()
          return result
        },
      }
    },
    async close() {
      await backgroundTasks.terminateAll()
      await runtime.dispose()
      await store.close()
    },
  }
}

export function heldRunner() {
  const options: AgentOptions[] = []
  const results: Array<PromiseWithResolvers<AgentRunResult>> = []
  const createAgent = (input: AgentOptions) => {
    options.push(input)
    const done = Promise.withResolvers<AgentRunResult>()
    results.push(done)
    return { send() {}, end() {}, abort() { done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } }) }, done: done.promise }
  }
  return { options, results, createAgent }
}

export function completedRunner(calls: AgentOptions[]): (options: AgentOptions) => Agent {
  return (options) => {
    calls.push(options)
    const done = Promise.withResolvers<AgentRunResult>()
    return {
      send() {
        options.runtimeSurfaces?.handoff?.onContent({ summary: "completed" })
        done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "completed" } })
      },
      end() {},
      abort() { done.resolve({ servedRequests: 0, durationMs: 1, terminal: { kind: "aborted" } }) },
      done: done.promise,
    }
  }
}

async function createParentChat(manager: SessionManager): Promise<{ sessionId: string; conversationId: string }> {
  const sessionId = await manager.createChat({ name: "Parent" })
  const parent = await manager.read(sessionId)
  if (parent?.kind !== "chat") throw new Error("Expected parent chat")
  return { sessionId, conversationId: parent.conversationId }
}

export async function createRoot(manager: SessionManager): Promise<{ sessionId: string; conversationId: string }> {
  const sessionId = await manager.createChat({ id: "root", conversationId: "root-conversation", name: "root" })
  return { sessionId, conversationId: "root-conversation" }
}

export async function waitForSettled(harness: SubagentChildHarness, parentSessionId: string): Promise<void> {
  const running = () => harness.backgroundTasks.processRecords().filter(
    (process) => process.status === "running" || process.status === "stopping",
  )
  await Promise.all(running().map((process) => harness.backgroundTasks.waitProcess(process.id)))
  expect(running()).toEqual([])
  await reconcileChildSessionCompletions({
    parentSessionId,
    reader: harness.reader,
    writer: harness.writer,
  })
}

export async function childIds(manager: SessionManager, parentSessionId: string): Promise<string[]> {
  const parent = await manager.read(parentSessionId)
  return [...(parent?.childSessionIds ?? [])]
}

export function runs(store: LocalSqliteEventStore, sessionId: string) {
  return loadSubagentRunsFromEvents(store.read({ aggregateId: `session:${sessionId}`, types: SUBAGENT_RUN_FACT_TYPES }))
}
