import { expect, spyOn, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPersistentProcessManager } from "../../../../src/infra/persistent-process-manager.js"
import { resolveEventStoreDbFile } from "../../../../src/infra/paths.js"
import { EventReaderService } from "../../../../src/infra/event-store-effect.js"
import { createConversationTreeProjection } from "../../../../src/orchestration/session/conversation/conversation-projection.js"
import { installedChildSessionHistory } from "../../../../src/orchestration/session/module-session-operations.js"
import { createProjectExecutionRuntime } from "../../../../src/orchestration/app-service/project-execution-composition.js"
import * as runtimeChatKernel from "../../../../src/orchestration/app-service/runtime-chat-kernel.js"
import type { RuntimeChatKernel } from "../../../../src/orchestration/app-service/runtime-chat-kernel.js"
import { createRuntimeSupervisor } from "../../../../src/orchestration/app-service/runtime-supervisor.js"
import { createChatRunnerLoader } from "../../../../src/orchestration/app-service/chat-runner-loader.js"
import { createContinuationLanes } from "../../../../src/orchestration/session/planned-session-continuation.js"
import { durableBranchHasUserMessage } from "../../../../src/orchestration/session/conversation/conversation-tree-handle.js"
import { mockRunner, quietSupervisorCollaborators, testSessionAuthAdmission } from "../../../fixtures/runtime-supervisor-fixtures.js"
import { createSessionViewLoader } from "../../../../src/orchestration/session-store/view.js"
import { repoDefinitions } from "../../../helpers/project-definitions.js"
import { testCapabilityModules } from "../../../helpers/request-tool-surface.js"
import { servedProjectState } from "./_served-project-state-fixture.js"
import { ACCOUNT_UPDATES_ONLY } from "../../../../src/orchestration/app-service/settings-mutations.js"
import { unusedChildSessionControl } from "../../../helpers/child-session-control.js"
import { AuthProfileManager } from "../../../../src/orchestration/auth/auth-profile-manager.js"

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "execution-runtime-"))
  const projectRoot = join(root, "project")
  const accountHome = join(root, "home")
  const userDataRoot = join(accountHome, ".flywheel")
  mkdirSync(projectRoot, { recursive: true })
  mkdirSync(userDataRoot, { recursive: true })
  const served = servedProjectState({ projectRoot, accountHome, userDataRoot })
  return {
    ...served,
    paths: { projectRoot, executionCwd: projectRoot, accountHome, userDataRoot },
    async close() { await served.close(); rmSync(root, { recursive: true, force: true }) },
  }
}

// A composed executor that serves a chat or a summary read boots its real
// background Worker, and its disposal waits until that Worker releases the
// project. The Worker loads the runtime module graph in a fresh isolate: well
// under a second here, but over 5 s on a loaded 4-CPU runner. A test that
// waits for that boot owns this deadline instead of Bun's 5 s default.
const WORKER_BOOT_TEST_TIMEOUT_MS = 60_000

function composeExecution(f: ReturnType<typeof fixture>, persistent: ReturnType<typeof createPersistentProcessManager>) {
  return createProjectExecutionRuntime({
    ...f.paths, state: f.state,
    workerUrl: new URL("../../../../src/orchestration/app-service/worker-entry.ts", import.meta.url).href,
    launcher: {
      spawnOwned: async () => { throw new Error("No process may start during this test") },
      adoptOwned: async () => { throw new Error("No command may be adopted during this test") },
      open() { return this },
      close: async () => ({ settled: true }),
    },
    persistentProcesses: persistent.client(), allowPersistentProcesses: false,
  })
}

/** Composes the executor and returns the chat kernel that it assembled. */
async function composeExecutionKernel(f: ReturnType<typeof fixture>, persistent: ReturnType<typeof createPersistentProcessManager>) {
  let kernel: RuntimeChatKernel | undefined
  const assemble = runtimeChatKernel.assembleRuntimeChatKernel
  const capture = spyOn(runtimeChatKernel, "assembleRuntimeChatKernel").mockImplementation(async (...args) => {
    kernel = await assemble(...args)
    return kernel
  })
  try {
    const composition = await composeExecution(f, persistent)
    if (kernel === undefined) throw new Error("the executor assembled no chat kernel")
    return { composition, kernel }
  } finally {
    capture.mockRestore()
  }
}

test("execution composition opens no primary state connection and leaves its authority usable after shutdown", async () => {
  const f = fixture()
  const persistent = createPersistentProcessManager()
  const primaryConnections = new Map<Database, string>()
  const original = Database.prototype.exec
  const probe = spyOn(Database.prototype, "exec").mockImplementation(function(this: Database, sql: string) {
    if (this.filename === resolveEventStoreDbFile(f.paths.projectRoot) && !primaryConnections.has(this)) primaryConnections.set(this, new Error(sql).stack ?? sql)
    return original.call(this, sql)
  })
  const fetchProbe = spyOn(globalThis, "fetch")
  let composition: Awaited<ReturnType<typeof createProjectExecutionRuntime>> | undefined
  try {
    composition = await composeExecution(f, persistent)
    expect(fetchProbe).not.toHaveBeenCalled()
    // Update work is the account service's. An executor composes none of it,
    // so it answers neither an update read nor the auto-install setting.
    await expect(composition.client.query({ type: "updateSnapshot" })).rejects.toThrow(ACCOUNT_UPDATES_ONLY)
    await expect(composition.client.dispatch({ type: "settings.set_update_auto_install", expected: true, value: false })).rejects.toThrow(ACCOUNT_UPDATES_ONLY)
    probe.mockRestore()
    expect(primaryConnections.size).toBe(0)
    let settlementWakes = 0
    const unsubscribe = composition.client.subscribe((event) => { if (event.type === "patch" && event.patch.payload.kind === "settlement.changed") settlementWakes++ })
    const opened = await composition.client.dispatch({ type: "chat.open" })
    if (!opened.ok || !opened.sessionId) throw new Error("Chat open refused")
    const sessionId = opened.sessionId
    await composition.client.dispatch({ type: "session.rename", sessionId, title: "Remote owner" })
    expect((await f.state.sessions.read(sessionId))?.label).toBe("Remote owner")
    expect(f.requests).toContain("session.control")
    // A child is never a catalog row (ARCH-PROTOCOL-048). Only a run an owner in this
    // process holds is work: a child whose run is recorded open with no owner
    // here keeps nothing busy.
    expect(await composition.blockers()).toEqual([])
    const parent = await f.state.sessions.read(sessionId)
    if (parent?.kind !== "chat") throw new Error("Missing parent chat")
    const childId = f.state.sessions.allocateId()
    await f.state.sessions.publishSubagent({
      id: childId, conversationId: f.state.sessions.allocateId(), description: "Inspect the runtime",
      launchedFrom: { parentSessionId: sessionId, conversationId: parent.conversationId, toolUseId: "tool-child" }, initialRoles: {},
      runBinding: {
        aggregateId: `session:${childId}`, type: "child_run.created", version: 1, timestamp: Date.now(), actor: "flywheel", sessionId: childId,
        payload: { childRunId: "run-child", kind: "subagent", toolUseId: "tool-child", agentType: "explorer", description: "Inspect the runtime", model: "test-model", maxTurns: 4, tools: [], executionCwd: f.paths.projectRoot },
      },
      assignment: "inspect",
      promptFact: {
        aggregateId: `session:${childId}`, type: "subagent.prompted", version: 3, timestamp: Date.now(), actor: "flywheel", sessionId: childId,
        payload: { childRunId: "run-child", prompt: "inspect", task: "inspect", toolNames: [] },
      },
    })
    expect((await composition.client.query({ type: "snapshot" })).rows.map((row) => row.id)).toEqual([sessionId])
    expect((await composition.client.query({ type: "sessionDetail", sessionId: childId })).view?.row).toMatchObject({ kind: "subagent", parentSessionId: sessionId })
    expect(await composition.blockers()).toEqual([])
    // The child whose run no owner here holds is the chat's tree, and it holds no work.
    expect(await composition.client.query({ type: "chatSettlement", sessionId })).toEqual({ state: "complete" })
    // A new chat changes what owns work, which wakes a client that waits on settlement.
    expect(settlementWakes).toBeGreaterThan(0)
    unsubscribe()
    const shutdown = await composition.dispose({ clientsHold: false })
    expect(shutdown).toMatchObject({ kind: "settled" })
    composition = undefined
    expect(f.state.available).toBe(true)
    await f.state.writer.append({ aggregateId: "probe", sessionId: "probe", type: "test.fact", version: 1, timestamp: 1, actor: "test", payload: {} })
    expect(f.store.aggregateSeq("probe")).toBe(0)
  } finally {
    fetchProbe.mockRestore()
    probe.mockRestore()
    await composition?.dispose({ clientsHold: false })
    persistent.releaseAll()
    await f.close()
  }
}, WORKER_BOOT_TEST_TIMEOUT_MS)

test("a chat opened in the executor records the profile that serves it, not the saved default", async () => {
  const f = fixture()
  const persistent = createPersistentProcessManager()
  const bench = await new AuthProfileManager({ userDataRoot: f.paths.userDataRoot, projectRoot: f.paths.projectRoot, env: {} }).create("Bench")
  const previous = process.env.FLYWHEEL_AUTH_PROFILE
  process.env.FLYWHEEL_AUTH_PROFILE = "Bench"
  let composition: Awaited<ReturnType<typeof createProjectExecutionRuntime>> | undefined
  try {
    composition = await composeExecution(f, persistent)
    const opened = await composition.client.dispatch({ type: "chat.open" })
    if (!opened.ok || !opened.sessionId) throw new Error("Chat open refused")
    expect(await f.state.sessions.read(opened.sessionId)).toMatchObject({ authProfileId: bench })
  } finally {
    if (previous === undefined) delete process.env.FLYWHEEL_AUTH_PROFILE
    else process.env.FLYWHEEL_AUTH_PROFILE = previous
    await composition?.dispose({ clientsHold: false })
    persistent.releaseAll()
    await f.close()
  }
}, WORKER_BOOT_TEST_TIMEOUT_MS)

test("remote kernel uses the existing supervisor and chat runner delivery path", async () => {
  const f = fixture()
  const persistent = createPersistentProcessManager()
  const { composition, kernel } = await composeExecutionKernel(f, persistent)
  const delivered: string[] = []
  const authAdmission = testSessionAuthAdmission()
  const supervisor = createRuntimeSupervisor({
    undoChanges: async () => { throw new Error("Undo is not used") },
    sessionStore: kernel.sessionStore, workflowHosts: kernel.workflowHosts, manager: kernel.manager, directories: f.paths,
    runtime: kernel.runtime, projectionReader: kernel.projectionReader, writer: kernel.eventWriter,
    transcriptCache: kernel.transcriptCache,
    sessionViewLoader: createSessionViewLoader({ reader: kernel.projectionReader, projectionReader: kernel.projectionReader, writer: kernel.eventWriter }),
    ...quietSupervisorCollaborators(),
    runnerCapabilities: async () => ({
      runnerLoader: createChatRunnerLoader({ authAdmission, createRunner: async (options) => mockRunner(options.sessionId, {
        deliverCommitted: (input) => { delivered.push(typeof input === "string" ? input : input.text); return true },
      }) }),
      definitions: repoDefinitions(), moduleSelection: testCapabilityModules, childSessions: unusedChildSessionControl(),
      resolveKey: async () => undefined, authAdmission, workflowMode: () => "ask",
      recall: async () => ({ hits: [] }), subscribeProfiles: () => async () => {},
    }),
    authProfileId: () => "default",
    lifecycle: { settleSessionStore: async () => {}, settleAuthAdmission: async () => {} },
    continuationLanes: createContinuationLanes(),
    clientsHold: () => false,
  })
  try {
    expect(kernel.manager).toBe(f.state.sessions)
    // Held projections and run controls are keyed by reader identity, so every
    // read name in the executor must hold the state client itself.
    expect(kernel.eventReader).toBe(f.state)
    expect(kernel.projectionReader).toBe(f.state)
    expect(kernel.runtime.runSync(EventReaderService)).toBe(f.state)
    const sessionId = await supervisor.openSessionRuntime()
    await expect(supervisor.sendChat(sessionId, "same runner")).resolves.toEqual({ ok: true })
    await supervisor.ensureChatRunner(sessionId)
    expect(delivered).toEqual(["same runner"])
    const metadata = await f.state.sessions.read(sessionId)
    if (!metadata || metadata.kind !== "chat") throw new Error("Missing chat")
    expect(await durableBranchHasUserMessage({ conversationId: metadata.conversationId, sessionId, store: kernel.eventReader })).toBe(true)
    expect(f.requests).toContain("append")
  } finally {
    await supervisor.disposeAll()
    await composition.dispose({ clientsHold: false })
    persistent.releaseAll()
    expect(f.state.available).toBe(true)
    await f.close()
  }
}, WORKER_BOOT_TEST_TIMEOUT_MS)

test("a settled child releases the conversation tree its writer held in the executor", async () => {
  const f = fixture()
  const persistent = createPersistentProcessManager()
  const { composition, kernel } = await composeExecutionKernel(f, persistent)
  try {
    const parentSessionId = await kernel.manager.createChat({ initialState: "inactive" })
    const parent = await kernel.manager.read(parentSessionId)
    if (parent?.kind !== "chat") throw new Error("Missing parent chat")
    // A chat runner gives its child authority the reader that its session
    // resources resolve from the runtime, and the session store's reader.
    const authority = installedChildSessionHistory().createAuthority({
      manager: kernel.manager,
      reader: kernel.runtime.runSync(EventReaderService),
      projectionReader: kernel.projectionReader,
      writer: kernel.eventWriter,
      projectRoot: f.paths.projectRoot,
      recall: async () => ({ hits: [] }),
    })
    const childSessionId = authority.allocateId()
    const childConversationId = authority.allocateId()
    const child = await authority.publish({
      childSessionId, childConversationId, parentSessionId, parentConversationId: parent.conversationId, parentToolUseId: "tool-child",
      description: "Inspect the runtime", executionCwd: f.paths.projectRoot, authProfileId: "default", initialRoles: {},
      runBinding: {
        aggregateId: `session:${childSessionId}`, type: "child_run.created", version: 1, timestamp: Date.now(), actor: "flywheel", sessionId: childSessionId,
        payload: { childRunId: "run-child", kind: "subagent", toolUseId: "tool-child", agentType: "explorer", description: "Inspect the runtime", model: "test-model", maxTurns: 4, tools: [], executionCwd: f.paths.projectRoot },
      },
      promptFact: {
        aggregateId: `session:${childSessionId}`, type: "subagent.prompted", version: 3, timestamp: Date.now(), actor: "flywheel", sessionId: childSessionId,
        payload: { childRunId: "run-child", prompt: "inspect", task: "inspect", toolNames: [] },
      },
      assignment: "inspect",
    })
    await child.conversation.buildContext()
    const held = createConversationTreeProjection(kernel.projectionReader, childConversationId)
    expect(createConversationTreeProjection(kernel.projectionReader, childConversationId)).toBe(held)
    await child.settle()
    expect(createConversationTreeProjection(kernel.projectionReader, childConversationId)).not.toBe(held)
  } finally {
    await composition.dispose({ clientsHold: false })
    persistent.releaseAll()
    await f.close()
  }
}, WORKER_BOOT_TEST_TIMEOUT_MS)

test("the cut's handoff is heard at the cut, so the stop that follows is the planned replacement's even before the account's state names it", async () => {
  const f = fixture()
  const persistent = createPersistentProcessManager()
  const composition = await composeExecution(f, persistent)
  try {
    expect(await composition.interruptForReplacement("handoff-cut")).toEqual([])
    expect(await composition.dispose({ clientsHold: true })).toMatchObject({ kind: "settled" })
    // A stop that heard no handoff counts nothing; this one counts the handoff's rows.
    expect(composition.replacementSuccessorRows()).toEqual({ continuations: 0, handovers: 0 })
  } finally {
    persistent.releaseAll()
    await f.close()
  }
})
