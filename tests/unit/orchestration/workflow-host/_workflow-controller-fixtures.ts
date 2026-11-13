import { mock } from "bun:test"
import { initializedWorkflowFacts } from "../../../helpers/workflow-root-fixtures.js"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../../src/infra/event-store-types"
import { resolveEventStoreDbFile, resolveSessionDir } from "../../../../src/infra/paths"
import { createSqliteEventStore } from "../../../../src/infra/sqlite-event-store"
import { EMPTY_OUTPUT_CHANGE_BATCH } from "../../../../src/infra/output/output-block-delta"
import {
  createWorkflowController,
  type WorkflowController,
  type WorkflowControllerDeps,
} from "../../../../src/orchestration/workflow-host/controller"
import type { AsyncEventStateReadSurface, AsyncEventWriter } from "../../../../src/infra/event-store-types"
import { bindRetainedOperationHost, composeRetainedOperationHosts } from "../../../../src/infra/retained-operation-hosts"
import type { HeldRetainedOperation, RetainedOperationAcceptance, RetainedOperationCommitResult } from "../../../../src/orchestration/module-seams"
import { bindRetainedOperations } from "../../../../src/orchestration/session/module-session-operations"
import { workflowLaunchHost, type WorkflowLaunchHost } from "../../../../src/orchestration/workflow-host/launch-operation-contract"
import { loadPathWorkflow, saveWorkflowContent } from "../../../../src/orchestration/workflow-host/path-workflow"
import { prepareWorkflowLaunch } from "../../../../src/orchestration/workflow-host/publish"
import type { SessionStore, SessionEntry } from "../../../../src/orchestration/session-store/types"
import { entryRuntimeDefaults } from "../../../../src/orchestration/session-store/entry-defaults"
import { createSessionManager, type SessionManager } from "../../../../src/orchestration/session/manager"
import type { WorkflowView } from "../../../../src/workflows/view/types"
import type { WorkflowCapabilityBoundary } from "../../../../src/workflows/run-facts"
import { CONFIG_DEFAULTS } from "../../../../src/orchestration/config/schema"
import { captureRuntimeConfigRequest } from "../../../../src/orchestration/agent-runtime/request-config"
import type { WorkflowDeps } from "../../../../src/orchestration/workflow-host/deps"
import { fixtureDefinitions, FIXTURE_WORKFLOW_ID, repoModules } from "../../../helpers/project-definitions"
import { testDirectories } from "../../../helpers/directories"
import { testCapabilityModules, testProviderRegistry } from "../../../helpers/provider-authority"
import { composeRealmModuleSnapshot, type ModuleId } from "../../../../src/orchestration/modules"
import { MODULE_IDS, moduleDisabledReason } from "../../../../src/protocol/module-ids.js"
import type { WorkflowsMode } from "../../../../src/protocol/module-protocol-types.js"
import { createDefinitionAvailability, type DefinitionAvailabilityOwner } from "../../../../src/orchestration/app-service/definition-availability"
import type { CapabilityRequest, ModulePolicy } from "../../../../src/orchestration/config/module-policy"
import type { ModuleState } from "../../../../src/orchestration/config/module-descriptor"
import { modelWorkflowLaunchOrigin, workflowLaunchDecision, type ModelWorkflowLaunchOrigin, type WorkflowLaunchTarget } from "../../../../src/orchestration/workflow-host/launch-origin"
import { fullAuthority } from "../../../helpers/launch-authority"
type WorkflowLaunchDecision = ReturnType<typeof workflowLaunchDecision>["decision"]
import { createSessionAuthAdmission } from "../../../../src/orchestration/session/session-auth-profile"
import type { AuthProfileResolution } from "../../../../src/orchestration/auth/auth-profile-manager"
import { captureProviderConnection } from "../../../../src/infra/auth/auth-context"
import { fakeModelInfos, fakeModelsClient } from "../../../helpers/model-tier-fixtures"
import { authProviders } from "../../../helpers/auth-context.js"
import { createMockWorkflowHosts } from "./_workflow-host-fixtures.js"
import { createWorkflowAuthOwner } from "../../../../src/orchestration/workflow-host/auth-owner.js"
import { workflowRunOwner, workflowRunReader } from "../../../../src/orchestration/module-catalog.js"
import { planEveryCapability } from "../../../helpers/attempt-brief.js"

/** Account authorities every fixture deps object publishes. They name the
 *  isolated test account home, so nothing reads the developer's account state. */
const { accountHome, userDataRoot } = testDirectories(process.cwd())
const DEFINITIONS = fixtureDefinitions()

export const noConversationRecall: WorkflowControllerDeps["recall"] = async () => ({ hits: [] })

export function createMockSessionStore(): SessionStore & {
  _entries: Map<string, SessionEntry>
  _abortCalls: string[]
} {
  const entries = new Map<string, SessionEntry>()
  const abortCalls: string[] = []

  return {
    _entries: entries,
    _abortCalls: abortCalls,

    openSessionRuntime: (opts) => {
      entries.set(opts.sessionId, {
        ...entryRuntimeDefaults(() => [], 0),
        kind: "chat",
        runner: null,
        description: opts.description ?? "New Chat",
        conversationId: opts.conversationId,
      })
      return opts.sessionId
    },
    replaceChatDisplaySeed: () => false,
    attachChatRunner: () => false,
    appendPreRunnerOutput: () => false,
    showStartupFailure: () => false,
    get: (id: string) => entries.get(id),
    has: (id: string) => entries.has(id),
    isRunning: (id: string) => entries.has(id),
    abort: mock(async (id: string) => { abortCalls.push(id); return true }),
    prepareForShutdown: mock(() => {}),
    interruptForReplacement: mock(async () => false),
    interrupt: mock(() => false),
    releaseForegroundBash: () => false,
    transferForegroundForReplacement: async () => {},
    terminateBackgroundWork: () => {},
    remove: mock(async () => {}),
    updateEntry: mock(() => {}),
    updateChatEntry: mock(() => {}),
    answerQuestion: mock(() => false),
    compactConversation: async () => false,
    learnFromSession: () => false,
    cancelQuestion: mock(() => false),
    runningCount: () => entries.size,
    allIds: () => [...entries.keys()],
    revision: () => 0,
    reorder: mock(() => false),
    drainOutputChanges: () => EMPTY_OUTPUT_CHANGE_BATCH,
    disposeAll: async () => {},
    refreshDeps: async () => {},
    onChange: () => () => {},
  }
}

const fixtureManagers = new WeakMap<SessionManager, { projectRoot: string; store: ReturnType<typeof createSqliteEventStore> }>()

export function createMockManager(defaults?: { executionCwd?: string; projectRoot?: string }): SessionManager {
  const projectRoot = defaults?.projectRoot ?? mkdtempSync(join(tmpdir(), "flywheel-workflow-manager-"))
  if (!defaults?.projectRoot) trackProjectRoot(projectRoot)
  const store = trackEventStore(createSqliteEventStore(resolveEventStoreDbFile(projectRoot)))
  const manager = createSessionManager({ projectRoot, executionCwd: defaults?.executionCwd ?? projectRoot, store })
  const observed = {
    ...manager,
    publishWorkflow: mock(manager.publishWorkflow),
    createChat: mock(manager.createChat),
    read: mock(manager.read),
    updateLifecycleState: mock(manager.updateLifecycleState),
    updateLabel: mock(manager.updateLabel),
  }
  fixtureManagers.set(observed, { projectRoot, store })
  return observed
}

const projectRoots: string[] = []
const openStores: Array<{ close(): void }> = []

export function trackProjectRoot(projectRoot: string): void {
  projectRoots.push(projectRoot)
}

/** Hand a store the fixtures did not open into the same cleanup ordering. A
 *  store a case opens itself keeps its database file open, and Windows refuses
 *  to remove a directory that still holds an open file, so an untracked store
 *  makes the teardown fail rather than the case. */
export function trackEventStore<T extends { close(): void }>(store: T): T {
  openStores.push(store)
  return store
}

export function cleanupProjectRoots(): void {
  // Stores first: a fixture store still holding the removed directory's file
  // reads as a live owner for as long as this process runs.
  while (openStores.length > 0) openStores.pop()!.close()
  while (projectRoots.length > 0) {
    rmSync(projectRoots.pop()!, { recursive: true, force: true })
  }
}

function moduleState(selected: readonly ModuleId[]): ModuleState {
  return { capabilities: selected, moduleIds: selected, requireWorkflowConfirmation: false, workflowsMode: "on", identity: selected.join("+") }
}

/** Admission boundary of the fixtures: it records every request so a test can
 *  prove a launch was admitted before anything else happened, and refuses when
 *  the selection lacks a required capability. */
export function createCapabilities(selected: readonly ModuleId[] = MODULE_IDS): Pick<ModulePolicy, "admit" | "state"> & {
  _requests: CapabilityRequest[]
} {
  const requests: CapabilityRequest[] = []
  return {
    _requests: requests,
    state: () => moduleState(selected),
    admit: async (request) => {
      requests.push(request)
      const missing = request.required.filter((capability) => !selected.includes(capability))
      return missing.length === 0
        ? { ok: true, grant: { operation: request.operation, required: request.required, capabilities: selected, moduleIds: selected, requireWorkflowConfirmation: false, workflowsMode: "on", identity: selected.join("+") } }
        : { ok: false, missing, reason: `${request.operation} is unavailable: ${moduleDisabledReason(missing)}` }
    },
  }
}

/** How a runtime host composes the modules of an admitted launch or resume. */
export const composeModules: WorkflowControllerDeps["composeModules"] = (grant) => composeRealmModuleSnapshot(grant)

async function createAvailability(selected: readonly ModuleId[] = MODULE_IDS): Promise<DefinitionAvailabilityOwner> {
  return createDefinitionAvailability({
    definitions: DEFINITIONS,
    modules: repoModules,
    capabilities: { state: () => moduleState(selected) },
  })
}

/** One projection every fixture shares. It is a read-only publication of the
 *  repository definitions, so nothing a controller test does can change it. */
export const FULL_AVAILABILITY = await createAvailability()

/** The launch port a composition supplies, as these tests drive it. The
 *  manager creates a launch's parent chat. The workflows module holds each
 *  accepted launch in the parent's durable cell, and a stand-in for the
 *  parent's writer commits it at once, or at `release` while the parent is
 *  busy. The stand-in dispatches a committed launch and keeps every commit
 *  result; it appends nothing itself, which the real writer owns. */
export interface FixtureLaunchPort {
  acceptLaunch(parentSessionId: string, operation: RetainedOperationAcceptance): Promise<boolean>
  readonly accepted: RetainedOperationAcceptance[]
  readonly results: RetainedOperationCommitResult[]
  /** Commits that threw. The writer contains them, and the cell stays. */
  readonly failures: unknown[]
  /** Parents mid-turn: their writer holds each accepted launch. */
  readonly busy: Set<string>
  bind(host: WorkflowLaunchHost): void
  /** The parent's turn ends, and its writer commits what it holds. */
  release(parentSessionId: string): Promise<void>
}

export function createFixtureLaunchPort(input: {
  readonly manager: Pick<SessionManager, "read" | "createChat">
  readonly reader: AsyncEventStateReadSurface
  readonly writer: AsyncEventWriter
}): FixtureLaunchPort {
  let host: WorkflowLaunchHost | undefined
  const boundHost = (): WorkflowLaunchHost => {
    if (!host) throw new Error("The fixture launch port has no bound workflow controller")
    return host
  }
  const accepted: RetainedOperationAcceptance[] = []
  const results: RetainedOperationCommitResult[] = []
  const failures: unknown[] = []
  const busy = new Set<string>()
  const held = new Map<string, HeldRetainedOperation[]>()
  const authorities = bindRetainedOperations({
    reader: input.reader,
    writer: input.writer,
    hosts: composeRetainedOperationHosts([bindRetainedOperationHost(workflowLaunchHost, {
      restoreLaunchTracking: (childSessionId, tasks) => boundHost().restoreLaunchTracking(childSessionId, tasks),
      commitLaunch: (operation, cell) => boundHost().commitLaunch(operation, cell),
      stopLaunch: (childSessionId, stoppedBy) => boundHost().stopLaunch(childSessionId, stoppedBy),
      launchCut: (childSessionId) => boundHost().launchCut(childSessionId),
      resumeLaunch: (childSessionId) => boundHost().resumeLaunch(childSessionId),
    })]),
  })
  async function commit(operation: HeldRetainedOperation): Promise<void> {
    let result: RetainedOperationCommitResult
    try {
      result = await operation.commit()
    } catch (error) {
      failures.push(error)
      return
    }
    results.push(result)
    if (result.kind === "committed") result.dispatch()
  }
  return {
    accepted,
    results,
    failures,
    busy,
    bind: (bound) => { host = bound },
    acceptLaunch: async (parentSessionId, operation) => {
      const parent = await input.manager.read(parentSessionId)
      const authority = authorities.find((candidate) => candidate.kind === operation.kind)
      if (parent?.kind !== "chat" || !authority) return false
      accepted.push(operation)
      const operationHeld = await authority.accept({ sessionId: parentSessionId, conversationId: parent.conversationId, operation })
      if (busy.has(parentSessionId)) held.set(parentSessionId, [...held.get(parentSessionId) ?? [], operationHeld])
      else await commit(operationHeld)
      return true
    },
    release: async (parentSessionId) => {
      busy.delete(parentSessionId)
      const waiting = held.get(parentSessionId) ?? []
      held.delete(parentSessionId)
      for (const operation of waiting) await commit(operation)
    },
  }
}

/** A controller whose fixture launch port commits through it, as a
 *  composition binds the controller as its workflow launch host. */
export function launchingController(deps: FixtureControllerDeps): WorkflowController {
  const controller = createWorkflowController(deps)
  deps.launchPort.bind(controller)
  return controller
}

/** Puts a parent chat in the fixture manager, unless it holds one under the
 *  id, and answers the trusted context of one model `workflow` call in it,
 *  as the parent's runner stamps it. */
export async function modelLaunch(deps: Pick<WorkflowControllerDeps, "manager">, input: {
  readonly chatSessionId?: string
  readonly toolUseId?: string
} = {}): Promise<ModelWorkflowLaunchOrigin> {
  const manager = deps.manager
  const chatSessionId = input.chatSessionId ?? "parent-chat"
  if (!await manager.read(chatSessionId)) await manager.createChat({ id: chatSessionId, conversationId: `${chatSessionId}-conversation`, name: "Parent chat" })
  const parent = await manager.read(chatSessionId)
  if (parent?.kind !== "chat") throw new Error(`Fixture session ${chatSessionId} is not a chat`)
  return modelWorkflowLaunchOrigin(chatSessionId, { conversationId: parent.conversationId, toolUseId: input.toolUseId ?? "tool-1", confirmation: { kind: "absent" }, authority: fullAuthority() })
}

/** A self-contained file launch in this parent's scratch directory. */
export function fixtureSource(deps: Pick<WorkflowControllerDeps, "projectRoot">, chatSessionId = "parent-chat", content = readFileSync(join(import.meta.dir, "../../../fixtures/workflow-project/workflows/repair.yaml"), "utf8")) {
  const sessionDir = resolveSessionDir(chatSessionId, deps.projectRoot)
  mkdirSync(sessionDir, { recursive: true })
  return { kind: "path" as const, path: saveWorkflowContent(sessionDir, content) }
}

/** The repair fixture, or the workflow file `content`, loaded as a launch from the parent chat's scratch directory. */
export async function fixtureWorkflow(deps: Pick<WorkflowControllerDeps, "projectRoot">, content?: string) {
  const source = fixtureSource(deps, "parent-chat", content)
  const loaded = await loadPathWorkflow({ path: source.path, sessionDir: realpathSync(resolveSessionDir("parent-chat", deps.projectRoot)), revision: DEFINITIONS.captureRevision(), authority: fullAuthority() })
  if (!loaded.ok) throw new Error(loaded.reason)
  return loaded.workflow
}

/** Wait until an owned asynchronous operation reaches the state under test. */
export async function until(ready: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (ready()) return
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  throw new Error(`Timed out waiting for ${label}`)
}

interface ControllerFixtureOverrides extends Partial<Omit<WorkflowControllerDeps, "launchPort">> {
  readonly prepareWorkflowDeps?: (profileId?: string) => Promise<WorkflowDeps>
  readonly authProfiles?: { readonly inspect: () => AuthProfileResolution }
}

export interface FixtureControllerDeps extends WorkflowControllerDeps {
  readonly launchPort: FixtureLaunchPort
}

export function createDeps(overrides?: ControllerFixtureOverrides): FixtureControllerDeps {
  const {
    prepareWorkflowDeps = async () => makeWorkflowDeps(),
    authProfiles = { inspect: () => ({
      id: "default",
      persistedId: "default",
      displayName: "Default",
      source: "default" as const,
      directory: join(userDataRoot, "auth", "profiles", "default"),
      availableProfiles: [{ id: "default", displayName: "Default" }],
      projectBinding: undefined,
      retirements: {},
    }) },
    ...controllerOverrides
  } = overrides ?? {}
  const manager = controllerOverrides.manager ?? createMockManager({ projectRoot: controllerOverrides.projectRoot })
  const fixture = fixtureManagers.get(manager)
  const projectRoot = controllerOverrides.projectRoot ?? fixture?.projectRoot ?? mkdtempSync(join(tmpdir(), "flywheel-workflow-ctrl-"))
  if (!controllerOverrides.projectRoot && !fixture) trackProjectRoot(projectRoot)
  const store = fixture?.store ?? trackEventStore(createSqliteEventStore(resolveEventStoreDbFile(projectRoot)))
  const eventReader = controllerOverrides.eventReader ?? asAsyncEventReadSurface(store)
  const eventWriter = controllerOverrides.eventWriter ?? asAsyncEventWriter(store)
  const authAdmission = controllerOverrides.authAdmission ?? createSessionAuthAdmission({
    materialize: async () => { throw new Error("unexpected retirement") },
    manager,
    authProfiles,
    workflows: createWorkflowAuthOwner({ reader: workflowRunReader(eventReader), writer: workflowRunOwner().writer(eventReader, manager.commitWorkflow), profiles: authProfiles, userDataRoot, onSelected: async () => {} }),
    prepare: (profileId) => prepareWorkflowDeps(profileId),
  })
  return {
    sessionStore: createMockSessionStore(),
    workflowHosts: createMockWorkflowHosts(),
    manager,
    ...testDirectories(projectRoot),
    definitions: DEFINITIONS,
    capabilities: createCapabilities(),
    composeModules,
    availability: FULL_AVAILABILITY,
    // ON unless a test asks for approval: the ASK matrix is its own group.
    workflowMode: (): WorkflowsMode => "on",
    // The composition root prepares these from the account authorities and its
    // launch authority, so the controller never builds them.
    authAdmission,
    eventReader: asAsyncEventReadSurface(store),
    projectionReader: eventReader,
    eventWriter: asAsyncEventWriter(store),
    recall: noConversationRecall,
    ...controllerOverrides,
    launchPort: createFixtureLaunchPort({ manager, reader: eventReader, writer: eventWriter }),
  }
}

type FixtureEventStore = ReturnType<typeof createSqliteEventStore>

/** Publish a run of the repair fixture, or of the workflow file `options.content`, with the capability boundary
 *  `options.capabilityBoundary` when a case states one. */
export async function seedWorkflowRequest(deps: WorkflowControllerDeps, sessionId: string, userRequest: string, options: { parentSessionId?: string; toolUseId?: string; content?: string; capabilityBoundary?: WorkflowCapabilityBoundary } = {}): Promise<void> {
  const workflow = await fixtureWorkflow(deps, options.content)
  const prepared = await prepareWorkflowLaunch({ workflow, description: userRequest, deps: makeWorkflowDeps(), authProfileId: "default", projectRoot: deps.projectRoot, definitionRevision: DEFINITIONS.captureRevision() })
  const origin = await modelLaunch(deps, { chatSessionId: options.parentSessionId })
  await deps.manager.publishWorkflow({
    id: sessionId, ...prepared, facts: prepared.workflowFacts,
    launchedFrom: { parentSessionId: origin.chatSessionId, conversationId: origin.conversationId, toolUseId: options.toolUseId ?? `launch-${sessionId}` },
    ...(options.capabilityBoundary === undefined ? {} : { capabilityBoundary: options.capabilityBoundary }),
  })
}

/** A file run with proved control but a companion from an unreadable version. */
export async function seedDamagedWorkflowRequest(deps: WorkflowControllerDeps, sessionId: string, userRequest: string): Promise<void> {
  await seedWorkflowRequest(deps, sessionId, userRequest)
  await deps.eventWriter.append({ aggregateId: `workflow:${sessionId}`, sessionId, timestamp: 2, type: "queue.created", version: 99, actor: "flywheel", payload: {} })
}

export const APPROVED_INTENT = {
  summary: "Add the parser",
  description: "Add the parser and its tests, then verify both.",
}

/** What the user did with the question: the declared approving choice, the
 *  declared rejecting one, the approving one plus a second id no single
 *  affirmative choice may carry, or free text. */
export type ApprovalAnswer = "approve" | "reject" | "approve-and-extra" | "freeform"

/** Record the answered question one ASK approval consists of, on the aggregate
 *  of the chat session that asked it. The question and its binding are composed
 *  by the same launch-origin code the controller verifies against, so a case
 *  states a workflow file and an answer. */
export function seedLaunchApproval(input: {
  readonly store: FixtureEventStore
  readonly chatSessionId: string
  readonly conversationId: string
  readonly confirmationId: string
  /** The file the question approves. */
  readonly target?: WorkflowLaunchTarget
  readonly answer?: ApprovalAnswer
  /** false records an ordinary question that binds no decision. */
  readonly bindsDecision?: boolean
}): void {
  if (!input.target) throw new Error("seedLaunchApproval requires a workflow file target")
  const target = input.target
  const { decision, question } = workflowLaunchDecision(target)
  const aggregateId = `session:${input.chatSessionId}`
  input.store.appendBatch([
    {
      aggregateId,
      sessionId: input.chatSessionId,
      timestamp: Date.now(),
      type: "agent_input.requested",
      version: 3,
      actor: "agent",
      payload: {
        interactionId: input.confirmationId,
        conversationId: input.conversationId,
        toolUseId: input.confirmationId,
        request: [question],
        ...(input.bindsDecision === false ? {} : { decision }),
      },
    },
    {
      aggregateId,
      sessionId: input.chatSessionId,
      timestamp: Date.now(),
      type: "agent_input.answered",
      version: 3,
      actor: "user",
      payload: { interactionId: input.confirmationId, answers: { [decision.question]: answerOf(input.answer ?? "approve", decision) } },
    },
  ])
}

interface ApprovalAnswerPayload {
  readonly [key: string]: unknown
}

function answerOf(answer: ApprovalAnswer, decision: WorkflowLaunchDecision): ApprovalAnswerPayload {
  switch (answer) {
    case "approve":
      return { kind: "choice", selections: [{ choiceId: decision.approve.choiceId }], text: decision.approve.label }
    case "reject":
      return { kind: "choice", selections: [{ choiceId: decision.reject.choiceId }], text: decision.reject.label }
    case "approve-and-extra":
      return { kind: "choice", selections: [{ choiceId: decision.approve.choiceId }, { choiceId: "direct" }], text: decision.approve.label }
    case "freeform":
      return { kind: "freeform", text: "yes go ahead" }
  }
}

export function makeResumeQueue(): WorkflowView {
  return {
    tree: { nodes: [{ id: "step-1:phase", kind: "phase", form: "single", phaseId: "investigate", label: "Investigate", parentId: null, disposition: "pending" }, { id: "step-1", kind: "agent", definitionId: "investigate", label: "Investigate", parentId: "step-1:phase", disposition: "pending", attempts: 1, currentAttemptId: "step-1" }] },
    attempts: [{
      id: "step-1",
      definitionId: "investigate",
      workflowDefinitionId: FIXTURE_WORKFLOW_ID,
      name: "Investigate",
      briefId: "repair.investigate",
      description: "Do work",
      status: "pending",
      writes: [],
      resumeRevertCount: 0,
    }],
    cursor: 0,
    status: "paused",
    mutationLog: [],
    maxAttempts: 50,
  }
}

/** Persist the queue that mocked runners otherwise only report through callbacks. */
export async function seedWorkflowQueue(deps: Pick<WorkflowControllerDeps, "eventWriter">, sessionId: string): Promise<void> {
  await deps.eventWriter.appendBatch(initializedWorkflowFacts("Fixture request").map((fact) => ({
    ...fact, aggregateId: `workflow:${sessionId}`, sessionId, timestamp: 1,
  })))
}

export function makeWorkflowDeps(): WorkflowDeps {
  const auth = {
    providers: authProviders({ apiKeys: { openai_api: "test-openai-key" } }),
    credentialLineages: {}, droppedCredentials: [],
  }
  const connection = captureProviderConnection({ profileId: "default", authDir: join(userDataRoot, "auth"), auth })
  const providers = testProviderRegistry()
  const createAgent: WorkflowDeps["createAgent"] = () => ({
    send: () => {},
    end: () => {},
    abort: () => {},
    done: Promise.resolve({ servedRequests: 0, durationMs: 0, terminal: { kind: "completed" } }),
  })
  const createLLMClient: WorkflowDeps["createLLMClient"] = async () => { throw new Error("Fixture model client was not configured") }
  const captureRuntimeConfig = () => captureRuntimeConfigRequest({
    revision: 0,
    config: { ...CONFIG_DEFAULTS, workflow: { max_attempts: 50 } },
    warnings: [],
    diagnostics: [],
    sourceIdentity: "test",
    status: { kind: "valid" },
  }, "default")
  return {
    accountHome,
    userDataRoot,
    definitions: fixtureDefinitions(),
    captureRuntimeConfig,
    createAgent,
    createLLMClient,
    prepareRequest: () => { throw new Error("This fixture prepares no pre-start") },
    planCapabilities: planEveryCapability,
    awaitModelAccessSettled: async () => {},
    captureProviderConnection: async () => ({
      connection,
      providers,
      eligibility: {
        modelIds: new Set(["gpt-5.5", "gpt-5.4"]),
        modelUnavailableReason: () => undefined,
        candidateOffering: (candidate, model) => ({
          candidate,
          wireModelId: model,
          dataUse: "standard",
          transport: "openai-responses",
          resolvedModelMetadata: fakeModelInfos.get(model),
        }),
      },
      runtimeConfig: captureRuntimeConfig(),
      requestAdmission: async () => ({ subscriptionSpendAuthorizationFor: () => undefined }), standing: async () => ({ kind: "serves" as const }), admit: () => ({ createAgent, createLLMClient }),
    }),
    auth,
    availableModels: new Map([["openai", new Set(["gpt-5.5", "gpt-5.4"])]]),
    modelInfos: fakeModelInfos,
    modelsClient: fakeModelsClient,
    moduleSelection: testCapabilityModules,
    runOwnedCommand: async () => { throw new Error("Fixture workflow runs no commands") },
    resolveEnvSnapshot: async (scope) => ({ envBlock: scope.executionCwd }),
  }
}
