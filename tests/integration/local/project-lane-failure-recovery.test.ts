import { expect, test } from "bun:test"
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { createCliLauncher, runtimeWorkerUrl } from "../../../src/cli/runtime-launch.js"
import { createMessagePortProcessEndpoint, listenInternalProcessChannel } from "../../../src/infra/internal-process-channel.js"
import { spawnProjectStateWorker } from "../../../src/orchestration/app-service/project-state-worker-spawner.js"
import { connectProjectStateChannel, serveProjectStateChannel } from "../../../src/orchestration/app-service/project-state-channel.js"
import { createProjectExecutionState } from "../../../src/orchestration/app-service/project-execution-state.js"
import { createSessionFactWriter } from "../../../src/orchestration/session/session-fact-writer.js"
import { tryOpenConversationTree } from "../../../src/orchestration/session/conversation/conversation-tree-handle.js"
import { checkpointFinalizedToolResult } from "../../../src/orchestration/session/finalized-tool-result-checkpoint.js"
import { createProjectControlRuntime, type ProjectControlRuntime, type ProjectControlRuntimeOptions } from "../../../src/orchestration/app-service/project-control-runtime.js"
import { createMaintenanceQueue } from "../../../src/orchestration/app-service/runtime-maintenance-owner.js"
import { createLoginShellPath } from "../../../src/infra/login-shell-path.js"
import { createProcessorGovernor } from "../../../src/orchestration/app-service/processor-governor.js"
import { servingAccountService } from "../../helpers/account-service-state.js"
import { idleAccountUpdates } from "../../helpers/account-updates.js"
import { createPersistentProcessManager } from "../../../src/infra/persistent-process-manager.js"
import { createAccountProjectRegistry } from "../../../src/orchestration/app-service/account-project-registry.js"
import { withDeadline } from "../../../src/infra/with-deadline.js"
import { createProcessBackgroundClient } from "../../../src/orchestration/app-service/worker-background-client.js"
import { prepareFileMutationOperation } from "../../../src/orchestration/session/file-mutation-fact-writers.js"
import { prepareWorkspaceState } from "../../../src/orchestration/workspace-state.js"
import { createSqliteEventStore } from "../../../src/infra/sqlite-event-store.js"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../src/infra/event-store-types.js"
import { createSessionManager } from "../../../src/orchestration/session/manager.js"
import { loadAgentInputProjection } from "../../../src/orchestration/session/agent-input-projection.js"
import { dropFrames, frameKind, recordAccountLog, silenceHeartbeatsAfter, TEST_EXECUTOR_HEARTBEAT_INTERVAL_MS } from "./_executor-heartbeats.js"

test("the real state Worker fences every executor state producer while account writes remain admitted", async () => {
  // Recovery reads project files without following links, so a root below the
  // macOS /var link would make recovery fail instead of proving its outcome.
  const root = await realpath(await mkdtemp(join(process.env.FLYWHEEL_TEST_SCRATCH_ROOT ?? tmpdir(), "lane-fence-")))
  const directories = { projectRoot: root, executionCwd: root, accountHome: join(root, "account"), userDataRoot: join(root, "account", ".flywheel") }
  await mkdir(join(root, ".git"))
  const worker = spawnProjectStateWorker(directories, root, runtimeWorkerUrl())
  const state = worker.acquire()
  const channels: (() => Promise<void>)[] = []
  const connect = (generation: number) => {
    const ports = new MessageChannel()
    const owner = createMessagePortProcessEndpoint({ port: ports.port1, decode: (value) => value })
    const peer = createMessagePortProcessEndpoint({ port: ports.port2, decode: (value) => value })
    channels.push(serveProjectStateChannel(state, owner, { kind: "executor", projectId: "project", generation }))
    return connectProjectStateChannel(peer, { kind: "executor", projectId: "project", generation })
  }
  try {
    await state.capturePosition()
    await state.sessions.createChat({ id: "session", conversationId: "conversation", name: "Before", initialState: "inactive" })
    expect(await state.execution({ kind: "generation.admit", projectId: "project", generation: 1 })).toEqual({ kind: "ok" })
    const old = connect(1)
    const execution = await createProjectExecutionState(old)
    const facts = createSessionFactWriter({ sessionId: "session", writer: execution.eventWriter })
    const tree = await tryOpenConversationTree({ conversationId: "conversation", sessionId: "session", store: execution.eventReader, writer: execution.eventWriter })
    if (!tree) throw new Error("Missing session tree")
    await tree.appendMessage({ kind: "user", content: "Inspect files", origin: "human" })
    for (const toolUseId of ["finished", "interrupted"]) {
      await facts.record({ type: "tool.input.completed", version: 1, actor: "agent", payload: {
        toolUseId, toolName: "read", input: {}, inputBytes: 2, inputSha256: "hash", inputPreview: "{}",
        executionMode: "foreground", traceKind: "tool", childHasOwnViewport: false,
      } })
    }
    await tree.appendMessage({ kind: "assistant", content: [
      { type: "tool_use", id: "finished", name: "read", input: {} },
      { type: "tool_use", id: "interrupted", name: "read", input: {} },
    ] })
    await checkpointFinalizedToolResult(facts, { conversationId: "conversation", toolUseId: "finished", toolName: "read",
      budgetExempt: true, turnBudgetChars: 200_000, registrationOrdinal: 0, content: [{ type: "text", text: "durable result" }], outcome: "ok" })
    await facts.putInFlight!("usage.settlement", "pending", {
      state: "pending", attemptId: "pending", requestId: "request", profileId: "default", budgetStreamId: "session",
      identity: { providerSessionKey: "session", conversationId: "conversation" }, turn: 1,
    })
    const before = (await execution.eventReader.readSlice({})).facts
    tree.getStorage().dispose()
    facts.dispose()
    await execution.eventStoreRuntime.dispose()
    const item = { sessionId: "session", events: [{ aggregateId: "session:session", sessionId: "session", type: "test.fenced", version: 1, timestamp: 1, actor: "test", payload: {} }] }
    expect((await old.control({ kind: "append", item })).kind).toBe("stored")
    expect(await state.execution({ kind: "generation.close", projectId: "project", generation: 1 })).toEqual({ kind: "ok" })
    const operations = [
      { kind: "append", item },
      { kind: "append.batch", items: [item] },
      { kind: "append", item: { sessionId: "session", events: [], inFlight: [{ op: "put", kind: "tool", key: "old", payload: {} }] } },
      { kind: "maintenance.prune", aggregateId: "session:session", eventType: "test.fenced" },
      { kind: "maintenance.prune-keyed", aggregateId: "session:session", eventType: "test.fenced", payloadKey: "id" },
      { kind: "session.control", command: { kind: "session.update-label", id: "session", labels: { label: "Old", shortLabel: "Old" }, source: "generated" } },
      { kind: "session.control", command: { kind: "session.select-profile", id: "session", authProfileId: "old" } },
    ] as const
    for (const operation of operations) expect(await old.control(operation)).toEqual({ kind: "refused", reason: "closed-generation" })
    expect(await old.execution({ kind: "generation.admit", projectId: "project", generation: 2 })).toMatchObject({ kind: "refused", reason: "invalid" })
    await state.sessions.updateLabel("session", { label: "Account", shortLabel: "Account" }, "user")
    expect((await state.sessions.read("session"))?.label).toBe("Account")
    expect(await state.execution({ kind: "generation.recover", projectId: "project", generation: 1 })).toEqual({ kind: "ok" })
    expect(await state.execution({ kind: "generation.admit", projectId: "project", generation: 2 })).toEqual({ kind: "ok" })
    const next = connect(2)
    expect((await next.control({ kind: "append", item })).kind).toBe("stored")
    const page = await state.readPage({ aggregateId: "session:session", types: ["test.fenced"] }, await state.capturePosition(), 0)
    expect(page.facts).toHaveLength(2)
    const recovered = await createProjectExecutionState(next)
    try {
      expect((await recovered.eventReader.readSlice({})).facts.slice(0, before.length)).toEqual([...before])
      expect(await recovered.eventReader.readInFlight("session", ["usage.settlement", "finalized-tool-result"])).toEqual([])
      expect((await recovered.eventReader.readSlice({ sessionId: "session", types: ["tool.result.recorded"] })).facts.map((event) => {
        if (event instanceof Error) throw new Error("Unexpected corrupt result fact", { cause: event })
        return [event.payload.toolUseId, event.payload.outcome]
      })).toEqual([["finished", "ok"], ["interrupted", "interrupted"]])
      const fileFacts = createSessionFactWriter({ sessionId: "session", writer: recovered.eventWriter })
      try {
        const path = join(root, "indeterminate.txt")
        await prepareFileMutationOperation({ sessionEventWriter: fileFacts, origin: { kind: "tool_call", toolUseId: "file", modelRequestId: "request" } }, [{
          change: { path, displayPath: path, changeKind: "created", beforeContent: null, afterContent: "intended" },
          evidence: { beforeSnapshot: null },
        }])
        await writeFile(path, "unproven contents")
        const cells = await recovered.eventReader.readInFlight("session", "file.mutation")
        expect(cells).toHaveLength(1)
        expect(await state.execution({ kind: "generation.close", projectId: "project", generation: 2 })).toEqual({ kind: "ok" })
        // A write that recovery cannot prove settles once as indeterminate:
        // the cell retires, no change is attributed to the session, and the
        // project still admits the next generation.
        expect(await state.execution({ kind: "generation.recover", projectId: "project", generation: 2 })).toEqual({ kind: "ok" })
        expect(await recovered.eventReader.readInFlight("session", "file.mutation")).toEqual([])
        expect((await recovered.eventReader.readSlice({ sessionId: "session", types: ["file.mutation.settled", "file.changed"] })).facts.map((event) => {
          if (event instanceof Error) throw new Error("Unexpected corrupt file fact", { cause: event })
          return [event.type, event.payload.outcome]
        })).toEqual([["file.mutation.settled", "indeterminate"]])
        expect(await state.execution({ kind: "generation.admit", projectId: "project", generation: 3 })).toEqual({ kind: "ok" })
      } finally { fileFacts.dispose() }
    } finally { await recovered.eventStoreRuntime.dispose() }
  } finally {
    await Promise.all(channels.map((close) => close()))
    await state.close()
    await rm(root, { recursive: true, force: true })
  }
}, 30_000)

/** Where one lane case keeps its project, its account, and its saved state. */
interface LaneDirectories {
  readonly projectRoot: string
  readonly executionCwd: string
  readonly accountHome: string
  readonly userDataRoot: string
}

/** Runs `use` against a project control runtime whose executors are real
 *  processes, in a fresh project, with heartbeats at the test period and the
 *  account's log recorded. `prepare` writes saved state before the runtime
 *  opens the project. Every setup and teardown step is here, and the runtime
 *  must settle when it is disposed. */
async function withLaneRuntime(
  prefix: string,
  options: {
    readonly listen: NonNullable<ProjectControlRuntimeOptions["listen"]>
    readonly replacement?: ProjectControlRuntimeOptions["replacement"]
    readonly prepare?: (directories: LaneDirectories) => Promise<void>
  },
  use: (lane: { readonly runtime: ProjectControlRuntime; readonly root: string; readonly ends: () => Promise<{ readonly [key: string]: unknown }[]> }) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(process.env.FLYWHEEL_TEST_SCRATCH_ROOT ?? tmpdir(), prefix))
  const directories = { projectRoot: root, executionCwd: root, accountHome: join(root, "account"), userDataRoot: join(root, "account", ".flywheel") }
  const cwd = process.cwd()
  try {
    await mkdir(join(root, ".git"))
    await mkdir(directories.userDataRoot, { recursive: true })
    await options.prepare?.(directories)
    const log = await recordAccountLog(join(root, "account-log"))
    process.chdir(root)
    const launcher = await createCliLauncher()
    const registry = createAccountProjectRegistry({ userDataRoot: directories.userDataRoot })
    const background = createProcessBackgroundClient({ workerUrl: runtimeWorkerUrl(), logBase: directories.accountHome })
    try {
      const runtime = await createProjectControlRuntime({
        directories, launcher, registry, version: "test", workerUrl: runtimeWorkerUrl(),
        createBackgroundClient: (projectRoot) => background.acquire(projectRoot),
        persistentProcesses: createPersistentProcessManager(), allowPersistentProcesses: false,
        executorHeartbeatIntervalMs: TEST_EXECUTOR_HEARTBEAT_INTERVAL_MS,
        updates: idleAccountUpdates(),
        service: servingAccountService(),
        loginShellPath: createLoginShellPath(), processorAdmission: createProcessorGovernor(),
        maintenance: createMaintenanceQueue({ workerUrl: runtimeWorkerUrl(), guardian: launcher.guardian }),
        clientsHold: () => false,
        sessionHolds: { holdProject: () => undefined, projectIdleGraceMs: undefined },
        listen: options.listen,
        ...(options.replacement === undefined ? {} : { replacement: options.replacement }),
      })
      try {
        await use({ runtime, root, ends: log.ends })
      } finally {
        expect(await runtime.dispose()).toEqual({ kind: "settled" })
        await background.dispose()
      }
    } finally {
      await registry.dispose()
      await launcher.dispose()
      await log.close()
    }
  } finally {
    process.chdir(cwd)
    await rm(root, { recursive: true, force: true })
  }
}

/** Whether `message` is a person's interrupt of a chat, which these lanes never deliver. */
function isChatInterrupt(message: unknown): boolean {
  return typeof message === "object" && message !== null && "mutation" in message
    && typeof message.mutation === "object" && message.mutation !== null
    && "type" in message.mutation && message.mutation.type === "chat.interrupt"
}

test("hard Stop joins the real executor, recovers on the Worker, and replaces only on explicit input", async () => {
  let starts = 0
  let closedEndpoints = 0
  await withLaneRuntime("lane-kill-", {
    // The executor never answers the interrupt and sends no heartbeat after
    // it reports ready, so the interrupt that waits for it ends it.
    listen: (options) => listenInternalProcessChannel({
      ...options,
      onConnection(endpoint) {
        endpoint.onClose(() => { closedEndpoints += 1 })
        options.onConnection(silenceHeartbeatsAfter({ ...endpoint, async send(message) {
          if (frameKind(message) === "start") starts += 1
          if (!isChatInterrupt(message)) await endpoint.send(message)
        } }, "ready"))
      },
    }),
  }, async ({ runtime, root, ends }) => {
    await withDeadline(runtime.client.query({ type: "commandUsageSnapshot" }), 30_000)
    const opened = await runtime.client.dispatch({ type: "chat.open", initialMessage: "retain this conversation" })
    if (!opened.ok || !opened.sessionId) throw new Error("Missing chat")
    expect((await withDeadline(runtime.client.dispatch({ type: "chat.interrupt", sessionId: opened.sessionId }), 15_000)).ok).toBe(true)
    expect(closedEndpoints).toBe(4)
    // The recovery records the person's interrupt of the session that waited.
    expect(await ends()).toEqual([expect.objectContaining({
      generation: 1, cause: "stopped answering, so Flywheel ended it", waitedBy: ["interrupt"], interruptedSessionIds: [opened.sessionId],
    })])
    expect(await runtime.blockers()).toEqual([])
    const selecting = runtime.client.dispatch({ type: "session.activate", sessionId: opened.sessionId })
    // The input waits out the restart backoff after one early death, below
    // the crash-loop threshold: an opening a replacement waits for.
    const blockers = async () => {
      for (;;) {
        const found = await runtime.blockers()
        if (found.length > 0) return found
        await Bun.sleep(5)
      }
    }
    expect(await withDeadline(blockers(), 900)).toEqual([{ projectRoot: root, projectLabel: basename(root), reason: "opening" }])
    // A query the history lane cannot serve joins the scheduled restart
    // instead of being refused, and starts no generation of its own.
    const usage = runtime.client.query({ type: "commandUsageSnapshot" })
    const selected = await withDeadline(selecting, 30_000)
    expect(selected.ok).toBe(true)
    await withDeadline(usage, 30_000)
    const snapshot = await runtime.client.query({ type: "snapshot" })
    expect(snapshot.rows.find((row) => row.id === opened.sessionId)?.lifecycleState).toBe("active")
    const tab = await withDeadline(runtime.client.dispatch({ type: "chat.open" }), 2_000)
    expect(tab.ok).toBe(true)
    expect(starts).toBe(2)
    expect(await withDeadline(runtime.client.dispatch({ type: "session.send", sessionId: opened.sessionId, input: "hello" }), 30_000)).toMatchObject({ ok: true })
    expect(starts).toBe(2)
  })
  expect(closedEndpoints).toBe(8)
}, 60_000)

test("a failed recovery holds nothing against a replacement, and the next explicit input recovers and restarts", async () => {
  // The first generation's channels report a closure that could not be
  // proven, so its recovery fails as unsettled until a fresh proof.
  let unproven = true
  let starts = 0
  await withLaneRuntime("lane-unsettled-", {
    listen: (options) => listenInternalProcessChannel({
      ...options,
      onConnection(endpoint) {
        const closure = unproven ? endpoint.closed.then(() => { throw new Error("test: the channel's closure could not be proven") }) : endpoint.closed
        void closure.catch(() => {})
        options.onConnection(silenceHeartbeatsAfter({ ...endpoint, closed: closure, async send(message) {
          if (frameKind(message) === "start") starts += 1
          if (!isChatInterrupt(message)) await endpoint.send(message)
        } }, "ready"))
      },
    }),
  }, async ({ runtime }) => {
    await withDeadline(runtime.client.query({ type: "commandUsageSnapshot" }), 30_000)
    const opened = await runtime.client.dispatch({ type: "chat.open", initialMessage: "stop this executor" })
    if (!opened.ok || !opened.sessionId) throw new Error("Missing running chat")
    expect((await withDeadline(runtime.client.dispatch({ type: "chat.interrupt", sessionId: opened.sessionId }), 15_000)).ok).toBe(true)
    unproven = false
    expect((await runtime.client.query({ type: "snapshot" })).executor).toEqual({ kind: "recovery_failed", cause: "some commands it started did not stop" })
    // A failed recovery with no restart scheduled holds nothing live.
    expect(await runtime.blockers()).toEqual([])
    // Explicit input asks for fresh proof, recovers, and restarts after the backoff.
    expect((await withDeadline(runtime.client.dispatch({ type: "session.activate", sessionId: opened.sessionId }), 30_000)).ok).toBe(true)
    expect(starts).toBe(2)
    expect((await runtime.client.query({ type: "snapshot" })).executor).toEqual({ kind: "serving" })
  })
}, 60_000)

test("a pending question can be answered after its executor exits", async () => {
  const sessionId = "waiting"
  let dbFile = ""
  await withLaneRuntime("lane-question-", {
    async prepare(directories) {
      const prepared = prepareWorkspaceState(directories)
      dbFile = prepared.dbFile
      const store = createSqliteEventStore(prepared.dbFile)
      const writer = asAsyncEventWriter(store)
      const manager = createSessionManager({ ...directories, store, writer })
      await manager.createChat({ id: sessionId, conversationId: "waiting-conversation", name: "Waiting", initialState: "active" })
      const tree = await tryOpenConversationTree({ conversationId: "waiting-conversation", sessionId, store: asAsyncEventReadSurface(store), writer })
      if (!tree) throw new Error("Missing waiting conversation")
      await tree.appendMessages([
        { kind: "user", content: "Ask me", origin: "human" },
        { kind: "assistant", content: [{ type: "tool_use", id: "ask-1", name: "ask_user", input: {} }] },
      ])
      await tree.getStorage().dispose()
      await store.append({
        aggregateId: `session:${sessionId}`, sessionId, type: "agent_input.requested", version: 3, actor: "agent", timestamp: Date.now(),
        payload: {
          interactionId: "ask-1", conversationId: "waiting-conversation", toolUseId: "ask-1",
          request: [{ question: "Continue?", choices: [{ kind: "option", choiceId: "yes", label: "Yes" }], multiSelect: false }],
        },
      })
      store.close()
      prepared.generation.release()
    },
    listen: (options) => listenInternalProcessChannel({
      ...options,
      onConnection(endpoint) {
        options.onConnection(silenceHeartbeatsAfter({ ...endpoint, async send(message) {
          if (!isChatInterrupt(message)) await endpoint.send(message)
        } }, "ready"))
      },
    }),
  }, async ({ runtime }) => {
    await withDeadline(runtime.client.query({ type: "commandUsageSnapshot" }), 30_000)
    const opened = await runtime.client.dispatch({ type: "chat.open", initialMessage: "stop this executor" })
    if (!opened.ok || !opened.sessionId) throw new Error("Missing running chat")
    expect((await withDeadline(runtime.client.dispatch({ type: "chat.interrupt", sessionId: opened.sessionId }), 15_000)).ok).toBe(true)
    expect((await withDeadline(runtime.client.dispatch({ type: "session.activate", sessionId }), 30_000)).ok).toBe(true)
    const resumed = Promise.withResolvers<void>()
    const stopObserving = runtime.client.subscribe((event) => {
      if (event.type === "patch" && event.patch.cursor.scope === "session" && event.patch.cursor.sessionId === sessionId
        && event.patch.payload.kind === "status.updated" && event.patch.payload.status.activity === "waiting") resumed.resolve()
    })
    const answered = await withDeadline(runtime.client.dispatch({
      type: "question.answer", sessionId, toolUseId: "ask-1",
      answers: { "Continue?": { kind: "choice", selections: [{ choiceId: "yes" }], text: "Yes" } },
    }), 30_000)
    expect(answered.ok).toBe(true)
    try { await withDeadline(resumed.promise, 5_000) }
    finally { stopObserving() }
    const recorded = createSqliteEventStore(dbFile)
    try {
      expect((await loadAgentInputProjection(asAsyncEventReadSurface(recorded), sessionId)).get("ask-1")?.kind).toBe("answered")
      const reply = await tryOpenConversationTree({ conversationId: "waiting-conversation", sessionId, store: asAsyncEventReadSurface(recorded), writer: asAsyncEventWriter(recorded) })
      if (!reply) throw new Error("Missing recovered conversation")
      expect((await reply.getBranch()).some((entry) => entry.kind === "message" && entry.message.kind === "toolResult" && entry.message.toolUseId === "ask-1")).toBe(true)
      await reply.getStorage().dispose()
    }
    finally { recorded.close() }
  })
}, 60_000)

test("while a replacement is requested, the account ends an executor proven wedged, so the project stops holding it", async () => {
  let closedEndpoints = 0
  await withLaneRuntime("lane-replacement-", {
    replacement: { state: () => ({ kind: "requested", blockers: [] }), changed: () => {}, joinHandoff: async () => {}, stopped: async () => false },
    // No blockers list the executor reports ever arrives, so every read of
    // it misses, and no heartbeat arrives after it reports ready.
    listen: (options) => listenInternalProcessChannel({
      ...options,
      onConnection(endpoint) {
        endpoint.onClose(() => { closedEndpoints += 1 })
        options.onConnection(silenceHeartbeatsAfter(dropFrames(endpoint, (message) => frameKind(message) === "blockers"), "ready"))
      },
    }),
  }, async ({ runtime, ends }) => {
    await withDeadline(runtime.client.query({ type: "commandUsageSnapshot" }), 30_000)
    const reads: string[][] = []
    // A read that answers from the account alone settles at once, so each
    // pass yields for the recovery that the reads wait on.
    const released = async (): Promise<void> => {
      for (;;) {
        const found = await runtime.blockers()
        reads.push(found.map((blocker) => blocker.reason))
        if (found.length === 0) return
        await Bun.sleep(5)
      }
    }
    await withDeadline(released(), 15_000)
    // A read that misses before any list is reported counts as a call, until
    // the account ends the executor and recovers it.
    expect(reads[0]).toEqual(["call"])
    expect(closedEndpoints).toBe(4)
    expect(await ends()).toEqual([expect.objectContaining({ generation: 1, cause: "stopped answering, so Flywheel ended it", waitedBy: ["replacement"] })])
  })
}, 60_000)

test("a successor's continuation that a wedged executor never answers fails once the account ends that executor", async () => {
  await withLaneRuntime("lane-continuation-", {
    // The continuation never reaches the executor, and no heartbeat arrives
    // after it reports ready.
    listen: (options) => listenInternalProcessChannel({
      ...options,
      onConnection(endpoint) {
        options.onConnection(silenceHeartbeatsAfter({ ...endpoint, async send(message) {
          if (frameKind(message) !== "continue_after_replacement") await endpoint.send(message)
        } }, "ready"))
      },
    }),
  }, async ({ runtime, ends }) => {
    await withDeadline(runtime.client.query({ type: "commandUsageSnapshot" }), 30_000)
    // The failed attempt is what makes the continuation duty try again.
    await expect(withDeadline(runtime.handoff("continue_after_replacement", "handoff"), 15_000)).rejects.toThrow("project executor terminated")
    expect(await ends()).toEqual([expect.objectContaining({ generation: 1, cause: "stopped answering, so Flywheel ended it", waitedBy: ["continuation"] })])
  })
}, 60_000)
