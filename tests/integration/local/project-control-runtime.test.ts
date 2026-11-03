import { expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { Layer, ManagedRuntime } from "effect"
import { RpcServer } from "effect/rpc"
import { layerMsgPack } from "../../../src/protocol/rpc-msgpack.js"
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { createCliLauncher, runtimeWorkerUrl } from "../../../src/cli/runtime-launch.js"
import { createPersistentProcessManager } from "../../../src/infra/persistent-process-manager.js"
import { PROCESS_KILL_GRACE_MS } from "../../../src/infra/process-supervisor.js"
import { Log } from "../../../src/infra/log.js"
import { listenInternalProcessChannel } from "../../../src/infra/internal-process-channel.js"
import { resolveConversationSearchDbFile } from "../../../src/infra/paths.js"
import { DeadlineExceeded, withDeadline } from "../../../src/infra/with-deadline.js"
import { RuntimeProtocolRpc } from "../../../src/protocol/runtime-protocol-schemas.js"
import { createRuntimeConnection } from "../../../src/protocol/client/connection.js"
import { createProjectControlRuntime } from "../../../src/orchestration/app-service/project-control-runtime.js"
import { createMaintenanceQueue } from "../../../src/orchestration/app-service/runtime-maintenance-owner.js"
import { runtimeProtocolSocketServer } from "../../../src/orchestration/app-service/runtime-protocol-socket-server.js"
import { createLoginShellPath } from "../../../src/infra/login-shell-path.js"
import { createProcessorGovernor } from "../../../src/orchestration/app-service/processor-governor.js"
import { servingAccountService } from "../../helpers/account-service-state.js"
import { idleAccountUpdates } from "../../helpers/account-updates.js"
import { createAccountProjectRegistry } from "../../../src/orchestration/app-service/account-project-registry.js"
import { bunSocketClientLayer, bunSocketServerLayer } from "../../../src/orchestration/app-service/bun-socket-rpc.js"
import { runtimeHandlers } from "../../../src/orchestration/app-service/runtime-protocol-handlers.js"
import { createProcessBackgroundClient } from "../../../src/orchestration/app-service/worker-background-client.js"
import { prepareWorkspaceState } from "../../../src/orchestration/workspace-state.js"
import { createSqliteEventStore } from "../../../src/infra/sqlite-event-store.js"
import { asAsyncEventReadSurface, asAsyncEventWriter } from "../../../src/infra/event-store-types.js"
import { createSessionManager } from "../../../src/orchestration/session/manager.js"
import { tryOpenConversationTree } from "../../../src/orchestration/session/conversation/conversation-tree-handle.js"
import { frameKind, recordAccountLog, silenceHeartbeatsAfter, TEST_EXECUTOR_HEARTBEAT_INTERVAL_MS } from "./_executor-heartbeats.js"
import { writeFixtureAccountConfig } from "./_fixture-account.js"

const BOUNDARY_MS = 3_000
async function bounded<T>(name: string, operation: Promise<T>, deadlineMs = BOUNDARY_MS): Promise<T> {
  try {
    return await withDeadline(operation, deadlineMs)
  } catch (error) {
    const detail = error instanceof DeadlineExceeded ? `did not settle within ${deadlineMs}ms` : "failed"
    throw new Error(`${name} ${detail}`, { cause: error })
  }
}

type TestCleanup = () => void | Promise<void>

interface SseData {
  readonly [key: string]: unknown
}

async function withTestCleanup<T>(run: (defer: (name: string, cleanup: TestCleanup) => () => void) => Promise<T>): Promise<T> {
  const cleanups: Array<{ name: string; cleanup: TestCleanup; active: boolean }> = []
  const defer = (name: string, cleanup: TestCleanup): (() => void) => {
    const entry = { name, cleanup, active: true }
    cleanups.push(entry)
    return () => { entry.active = false }
  }
  let outcome: { kind: "success"; value: T } | { kind: "failure"; error: unknown }
  try {
    outcome = { kind: "success", value: await run(defer) }
  } catch (error) {
    outcome = { kind: "failure", error }
  }
  const cleanupFailures: Error[] = []
  for (const entry of cleanups.toReversed()) {
    if (!entry.active) continue
    try {
      await entry.cleanup()
    } catch (error) {
      cleanupFailures.push(new Error(`${entry.name} cleanup failed`, { cause: error }))
    }
  }
  if (outcome.kind === "failure") {
    if (cleanupFailures.length > 0 && outcome.error instanceof Error) {
      const priorCause = outcome.error.cause
      const cleanupCause = new AggregateError(
        priorCause === undefined ? cleanupFailures : [priorCause, ...cleanupFailures],
        "Test cleanup also failed",
      )
      Object.defineProperty(outcome.error, "cause", { value: cleanupCause, configurable: true })
    }
    if (cleanupFailures.length > 0 && !(outcome.error instanceof Error)) {
      throw new AggregateError([outcome.error, ...cleanupFailures], "Test and cleanup failed")
    }
    throw outcome.error
  }
  if (cleanupFailures.length > 0) throw new AggregateError(cleanupFailures, "Test cleanup failed")
  return outcome.value
}

function sse(data: SseData): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

function correlatedToolResult(body: unknown, toolCallId: string): string | undefined {
  if (typeof body !== "object" || body === null || !("messages" in body) || !Array.isArray(body.messages)) return undefined
  for (const message of body.messages) {
    if (typeof message !== "object" || message === null) continue
    if (!("role" in message) || message.role !== "tool" || !("tool_call_id" in message) || message.tool_call_id !== toolCallId) continue
    if (!("content" in message)) return ""
    return typeof message.content === "string" ? message.content : JSON.stringify(message.content)
  }
  return undefined
}

async function waitForConversationFtsWrite(logDirectory: string, after: number): Promise<void> {
  // The executor's background Worker is lazy. Its first source import can take
  // longer than an ordinary control boundary, but the lock must still release
  // before SQLite's five-second busy deadline.
  const pollDeadlineMs = 4_000
  const deadline = performance.now() + pollDeadlineMs
  while (performance.now() < deadline) {
    try {
      for (const file of await readdir(logDirectory)) {
        if (!file.endsWith(".jsonl")) continue
        for (const line of (await readFile(join(logDirectory, file), "utf8")).split("\n")) {
          if (!line) continue
          try {
            const record: unknown = JSON.parse(line)
            if (typeof record !== "object" || record === null || !("ts" in record) || typeof record.ts !== "number") continue
            if (record.ts < after) continue
            if (!("type" in record) || record.type !== "conversation.fts.write" || !("payload" in record)) continue
            const payload = record.payload
            if (typeof payload !== "object" || payload === null) continue
            if ("requestedThroughPosition" in payload && typeof payload.requestedThroughPosition === "number"
              && "indexedThroughPosition" in payload && typeof payload.indexedThroughPosition === "number"
              && payload.requestedThroughPosition > payload.indexedThroughPosition) return
          } catch {
            // A writer can leave the final line incomplete while this bounded reader polls.
          }
        }
      }
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error
    }
    await Bun.sleep(10)
  }
  throw new Error(`conversation.fts.write was not observed within ${pollDeadlineMs}ms`)
}

test("a locked transcript index leaves public control and executor admission responsive", async () => {
  const root = await mkdtemp(join(process.env.FLYWHEEL_TEST_SCRATCH_ROOT ?? tmpdir(), "control-"))
  const cwd = process.cwd()
  const directories = { projectRoot: root, executionCwd: root, accountHome: join(root, "account"), userDataRoot: join(root, "account", ".flywheel") }
  await mkdir(join(root, ".git"))
  await mkdir(directories.userDataRoot, { recursive: true })
  const prepared = prepareWorkspaceState(directories)
  const store = createSqliteEventStore(prepared.dbFile)
  const writer = asAsyncEventWriter(store)
  const manager = createSessionManager({ ...directories, store, writer })
  const sessionId = await manager.createChat({ id: "durable-chat", conversationId: "durable-conversation", name: "Existing history", initialState: "inactive" })
  const tree = await tryOpenConversationTree({ sessionId, conversationId: "durable-conversation", store: asAsyncEventReadSurface(store), writer })
  if (!tree) throw new Error("Missing seeded chat tree")
  await tree.appendMessages([{ kind: "user", content: "Read this after Stop", origin: "human" }])

  const accountBackground = createProcessBackgroundClient({ workerUrl: runtimeWorkerUrl(), logBase: directories.accountHome })
  const executorBackground = createProcessBackgroundClient({ workerUrl: runtimeWorkerUrl(), logBase: root })
  const initializer = executorBackground.acquire(root)
  expect(await bounded("initial FTS watermark", initializer.transcriptSearch({ query: "lockneedle", page: 1 }))).toMatchObject({ hits: [], total: 0 })
  await bounded("initial FTS client close", initializer.close())
  await tree.appendMessages([{ kind: "user", content: "Unique lockneedle survives derived catchup.", origin: "human" }])
  tree.getStorage().dispose()
  store.close()
  prepared.generation.release()

  process.chdir(root)
  const launcher = await createCliLauncher()
  const registry = createAccountProjectRegistry({ userDataRoot: directories.userDataRoot })
  const runtime = await createProjectControlRuntime({
    directories,
    launcher,
    registry,
    version: "test",
    workerUrl: runtimeWorkerUrl(),
    createBackgroundClient: (projectRoot) => accountBackground.acquire(projectRoot),
    persistentProcesses: createPersistentProcessManager(),
    allowPersistentProcesses: false,
    updates: idleAccountUpdates(),
    service: servingAccountService(),
    loginShellPath: createLoginShellPath(), processorAdmission: createProcessorGovernor(),
    maintenance: createMaintenanceQueue({ workerUrl: runtimeWorkerUrl(), guardian: launcher.guardian }),
    clientsHold: () => false,
    sessionHolds: { holdProject: () => undefined, projectIdleGraceMs: undefined },
  })
  const liveness = { heartbeatIntervalMs: 30, silenceDeadlineMs: 300 }
  const server = ManagedRuntime.make(
    Layer.fresh(RpcServer.layer(RuntimeProtocolRpc)).pipe(
      Layer.provide(runtimeHandlers(runtime, Log.create({ service: "control-test" }), { version: "0.1.0", liveness })),
      Layer.provide(Layer.fresh(runtimeProtocolSocketServer)),
      Layer.provide(layerMsgPack),
      Layer.provide(bunSocketServerLayer({ path: "public.sock" })),
    ),
  )
  await bounded("public RPC server startup", server.context())
  const connection = createRuntimeConnection({ socket: bunSocketClientLayer("public.sock", async () => {}), liveness })
  const states: string[] = []
  connection.onStateChange((state) => states.push(state))
  const published = Promise.withResolvers<void>()
  const unsubscribe = connection.subscribe((event) => {
    if (event.type === "patch" && event.patch.payload.kind === "session.updated") published.resolve()
  })
  let indexLock: Database | null = null
  let searchSettled = false

  try {
    await bounded("executor warm snapshot", connection.query({ type: "remoteSnapshot" }), 8_000)
    const opened = await bounded("account chat.open", connection.dispatch({ type: "chat.open" }))
    if (!opened.ok || !opened.sessionId) throw new Error("Missing created chat")

    indexLock = new Database(resolveConversationSearchDbFile(root))
    indexLock.exec("begin immediate")
    const search = connection.query({ type: "transcriptSearch", request: { query: "lockneedle", page: 1 } }).finally(() => {
      searchSettled = true
    })

    expect((await bounded("account rename during FTS lock", connection.dispatch({ type: "session.rename", sessionId: opened.sessionId, title: "Control remains live" }))).ok).toBe(true)
    await bounded("public patch during FTS lock", published.promise)
    expect((await bounded("account snapshot during FTS lock", connection.query({ type: "snapshot" }))).rows.map((row) => row.id)).toContain(opened.sessionId)
    expect((await bounded("inactive passive read during FTS lock", connection.query({ type: "sessionDetail", sessionId }))).view).toMatchObject({ source: "durable", id: sessionId })
    expect(await bounded("another session session.send admission during FTS lock", connection.dispatch({ type: "session.send", sessionId: opened.sessionId, input: "hello" }))).toMatchObject({ ok: true })
    await new Promise<void>((resolve) => setTimeout(resolve, 450))
    expect(connection.state).toBe("connected")
    expect(states).not.toContain("recovering")
    expect(searchSettled).toBe(false)

    indexLock.exec("commit")
    indexLock.close()
    indexLock = null
    const found = await bounded("Find after FTS lock release", search)
    expect(found.total).toBe(1)
    expect(found.hits).toHaveLength(1)
    expect(found.hits[0]).toMatchObject({ sessionId, role: "user", entryId: expect.any(String) })
    expect(found.hits[0]?.snippet).toContain("[lockneedle]")

  } finally {
    if (indexLock) {
      try {
        indexLock.exec("rollback")
      } catch {
        // A failed assertion can follow a successful release.
      }
      indexLock.close()
    }
    unsubscribe()
    await bounded("public connection cleanup", connection.close())
    await bounded("public server cleanup", server.dispose())
    expect(await bounded("runtime cleanup", runtime.dispose(), 8_000)).toEqual({ kind: "settled" })
    await bounded("account background Worker cleanup", accountBackground.dispose())
    await bounded("executor background Worker cleanup", executorBackground.dispose())
    await bounded("registry cleanup", registry.dispose())
    await bounded("launcher cleanup", launcher.dispose())
    process.chdir(cwd)
    await rm(root, { recursive: true, force: true })
  }
}, 25_000)

test("a stalled executor start ends on its own wedge proof, every account record of its control names the project, control and detail reads after the end stay on the account, and a transcript read reaches the replacement executor", async () => {
  const root = await mkdtemp(join(process.env.FLYWHEEL_TEST_SCRATCH_ROOT ?? tmpdir(), "control-startup-"))
  const cwd = process.cwd()
  const directories = { projectRoot: root, executionCwd: root, accountHome: join(root, "account"), userDataRoot: join(root, "account", ".flywheel") }
  await mkdir(join(root, ".git"))
  await mkdir(directories.userDataRoot, { recursive: true })
  const prepared = prepareWorkspaceState(directories)
  const store = createSqliteEventStore(prepared.dbFile)
  const writer = asAsyncEventWriter(store)
  const manager = createSessionManager({ ...directories, store, writer })
  const historyId = await manager.createChat({ id: "durable-chat", conversationId: "durable-conversation", name: "Existing history", initialState: "inactive" })
  const tree = await tryOpenConversationTree({ sessionId: historyId, conversationId: "durable-conversation", store: asAsyncEventReadSurface(store), writer })
  if (!tree) throw new Error("Missing seeded chat tree")
  await tree.appendMessages([
    { kind: "user", content: "Read this after the executor ends", origin: "human" },
    { kind: "assistant", content: "Durable history survives the executor." },
  ])
  tree.getStorage().dispose()
  store.close()
  prepared.generation.release()

  process.chdir(root)
  const launcher = await createCliLauncher()
  const registry = createAccountProjectRegistry({ userDataRoot: directories.userDataRoot })
  const background = createProcessBackgroundClient({ workerUrl: runtimeWorkerUrl(), logBase: directories.accountHome })
  const log = await recordAccountLog(join(root, "account-log"))
  const stalled = Promise.withResolvers<void>()
  const firstEnded = Promise.withResolvers<void>()
  let listenersOpened = 0
  let historyAcquisitions = 0
  const runtime = await createProjectControlRuntime({
    directories, launcher, registry, version: "test", workerUrl: runtimeWorkerUrl(),
    createBackgroundClient: (projectRoot) => {
      historyAcquisitions++
      return background.acquire(projectRoot)
    },
    persistentProcesses: createPersistentProcessManager(), allowPersistentProcesses: false,
    // The first generation holds its start and sends no heartbeat after its
    // first, so the start that waits for it proves it wedged and ends it.
    executorHeartbeatIntervalMs: TEST_EXECUTOR_HEARTBEAT_INTERVAL_MS,
    updates: idleAccountUpdates(),
    service: servingAccountService(),
    loginShellPath: createLoginShellPath(), processorAdmission: createProcessorGovernor(),
    maintenance: createMaintenanceQueue({ workerUrl: runtimeWorkerUrl(), guardian: launcher.guardian }),
    clientsHold: () => false,
    sessionHolds: { holdProject: () => undefined, projectIdleGraceMs: undefined },
    listen: (options) => {
      const stalling = ++listenersOpened <= 4 && (basename(options.path) === "l.sock" || options.path.endsWith("-l"))
      return listenInternalProcessChannel({
        ...options,
        onConnection(endpoint) {
          if (!stalling) return options.onConnection(endpoint)
          void endpoint.closed.then(() => firstEnded.resolve())
          options.onConnection(silenceHeartbeatsAfter({
            ...endpoint,
            async send(message) {
              if (frameKind(message) !== "start") return endpoint.send(message)
              stalled.resolve()
              await endpoint.closed
            },
          }, "first"))
        },
      })
    },
  })
  const liveness = { heartbeatIntervalMs: 30, silenceDeadlineMs: 300 }
  const server = ManagedRuntime.make(
    Layer.fresh(RpcServer.layer(RuntimeProtocolRpc)).pipe(
      Layer.provide(runtimeHandlers(runtime, Log.create({ service: "control-startup-test" }), { version: "0.1.0", liveness })),
      Layer.provide(Layer.fresh(runtimeProtocolSocketServer)),
      Layer.provide(layerMsgPack),
      Layer.provide(bunSocketServerLayer({ path: "public.sock" })),
    ),
  )
  await bounded("stalled-start public server", server.context())
  const connection = createRuntimeConnection({ socket: bunSocketClientLayer("public.sock", async () => {}), liveness })
  const states: string[] = []
  connection.onStateChange((state) => states.push(state))
  const unsubscribe = connection.subscribe(() => {})
  try {
    await bounded("executor start interception", stalled.promise, 8_000)
    const opened = await bounded("chat open during executor startup", connection.dispatch({ type: "chat.open" }))
    if (!opened.ok || !opened.sessionId) throw new Error("Missing created chat")
    expect((await bounded("snapshot during executor startup", connection.query({ type: "snapshot" }))).rows.map((row) => row.id)).toContain(opened.sessionId)
    expect((await bounded("rename during executor startup", connection.dispatch({ type: "session.rename", sessionId: opened.sessionId, title: "Control stays live" }))).ok).toBe(true)
    await new Promise<void>((resolve) => setTimeout(resolve, 450))
    expect(connection.state).toBe("connected")
    expect(states).not.toContain("recovering")

    // Thirty silent test periods after its first heartbeat.
    await bounded("the first generation's end at its wedge proof", firstEnded.promise, 30 * TEST_EXECUTOR_HEARTBEAT_INTERVAL_MS + 4_000)
    const ends = await log.ends()
    expect(ends).toEqual([expect.objectContaining({ generation: 1, cause: "could not start", missedPeriods: 30, waitedBy: ["start"], projectId: expect.any(String) })])
    expect(listenersOpened).toBe(4)
    expect(historyAcquisitions).toBe(1)
    expect((await bounded("rename after the end", connection.dispatch({ type: "session.rename", sessionId: opened.sessionId, title: "State survives the end" }))).ok).toBe(true)
    expect((await bounded("open after the end", connection.dispatch({ type: "chat.open" }))).ok).toBe(true)
    const detail = await bounded("durable detail after the end", connection.query({ type: "sessionDetail", sessionId: historyId }))
    expect(detail.view).toMatchObject({ source: "durable", id: historyId })
    expect(listenersOpened).toBe(4)
    // Only the executor builds a transcript, so a transcript read asks the
    // paused project for execution as an open tab does (ARCH-RUNTIME-016): it waits
    // out the restart backoff after one early death, 1 s, and the start of
    // the replacement generation, which load can stretch past 2 s. It gets
    // the restart bound, not the control bound.
    const range = await bounded("transcript after the end starts the replacement executor", connection.query({
      type: "outputRange",
      sessionId: historyId,
      request: { anchor: { kind: "tail" }, maxBlocks: 20, maxBytes: 32_000 },
    }), 8_000)
    if (range.kind !== "ok") throw new Error("Transcript unavailable")
    expect(range.blocks.map((block) => "content" in block ? block.content : "")).toEqual(["Read this after the executor ends", "Durable history survives the executor."])
    expect(listenersOpened).toBe(8)
    expect(historyAcquisitions).toBe(1)
    expect((await bounded("activation on the replacement generation", connection.dispatch({ type: "session.activate", sessionId: opened.sessionId }))).ok).toBe(true)
    expect(listenersOpened).toBe(8)

    expect((await bounded("explicit send to the replacement generation", connection.dispatch({ type: "session.send", sessionId: opened.sessionId, input: "hello" }))).ok).toBe(true)
    expect(listenersOpened).toBe(8)
    // The account names the project in each record of its executor control
    // with the projectId of the executor client's records, so one filter
    // finds the end, the restart, and every other record of that project.
    const control = log.records().filter((fields) => fields.service === "project-control-runtime")
    expect(control.map((fields) => fields.message)).toContain("executor restarting")
    expect(control).toEqual(control.map(() => expect.objectContaining({ projectId: ends[0]?.projectId })))
    // The executor handles its supervisor's signal and ends at it, so the
    // ended generation's container is empty well inside the kill grace.
    const firstEnd = log.records().find((fields) => fields.message === "executor generation ended" && fields.generation === 1)
    expect(firstEnd?.settled).toBe(true)
    expect(firstEnd?.closureMs).toBeLessThan(PROCESS_KILL_GRACE_MS / 2)
  } finally {
    unsubscribe()
    await bounded("stalled-start connection cleanup", connection.close())
    await bounded("stalled-start server cleanup", server.dispose())
    expect(await bounded("stalled-start runtime cleanup", runtime.dispose(), 8_000)).toEqual({ kind: "settled" })
    await bounded("stalled-start background cleanup", background.dispose())
    await bounded("stalled-start registry cleanup", registry.dispose())
    await bounded("stalled-start launcher cleanup", launcher.dispose())
    await log.close()
    process.chdir(cwd)
    await rm(root, { recursive: true, force: true })
  }
}, 25_000)

test("provider-issued recall stays in the executor background Worker while account interaction remains live", async () => {
  const root = await mkdtemp(join(process.env.FLYWHEEL_TEST_SCRATCH_ROOT ?? tmpdir(), "control-recall-"))
  await withTestCleanup(async (defer) => {
    defer("recall root", () => rm(root, { recursive: true, force: true }))
    const priorLogLevel = process.env.FLYWHEEL_LOG_LEVEL
    defer("recall log level", () => {
      if (priorLogLevel === undefined) delete process.env.FLYWHEEL_LOG_LEVEL
      else process.env.FLYWHEEL_LOG_LEVEL = priorLogLevel
    })
    const cwd = process.cwd()
    defer("recall cwd", () => { process.chdir(cwd) })
    const directories = { projectRoot: root, executionCwd: root, accountHome: join(root, "account"), userDataRoot: join(root, "account", ".flywheel") }
    await mkdir(join(root, ".git"))

    const model = "gpt-5"
    const finalMarker = "provider recall completed uniquely"
    const providerEntered = Promise.withResolvers<void>()
    const releaseRecallToolCall = Promise.withResolvers<void>()
    const recallResultConsumed = Promise.withResolvers<void>()
    let recallResultWasConsumed = false
    const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const pathname = new URL(request.url).pathname
      if (pathname.endsWith("/models")) {
        return Response.json({ object: "list", data: [{ id: model, object: "model", created: 0, owned_by: "fixture" }] })
      }
      const body: unknown = await request.json()
      const serialized = JSON.stringify(body)
      const recallTurn = serialized.includes("Trigger production recall")
      const toolResult = correlatedToolResult(body, "recall-1")
      if (toolResult !== undefined && !toolResult.includes("Unique lockneedle in durable recall history.")) {
        throw new Error(`recall-1 returned an invalid result: ${toolResult || "<empty>"}`)
      }
      const hasRecallResult = toolResult !== undefined
      const delta = hasRecallResult
        ? { content: finalMarker }
        : recallTurn
          ? { tool_calls: [{ index: 0, id: "recall-1", type: "function", function: { name: "recall", arguments: JSON.stringify({ query: "recallprobe" }) } }] }
          : { content: "other session complete" }
      if (recallTurn && !hasRecallResult) {
        providerEntered.resolve()
        await releaseRecallToolCall.promise
      }
      if (hasRecallResult) {
        recallResultWasConsumed = true
        recallResultConsumed.resolve()
      }
      const finishReason = recallTurn && !hasRecallResult ? "tool_calls" : "stop"
      return new Response([
        sse({ id: "fixture", object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason: null }] }),
        sse({ id: "fixture", object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] }),
        sse({ id: "fixture", object: "chat.completion.chunk", model, choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }),
        "data: [DONE]\n\n",
      ].join(""), { headers: { "content-type": "text/event-stream" } })
    },
    })
    defer("recall provider", () => { provider.stop(true) })
    if (provider.port === undefined) throw new Error("recall provider did not bind a port")
    await writeFixtureAccountConfig(directories.userDataRoot, { port: provider.port, model })

    const prepared = prepareWorkspaceState(directories)
    const cancelGenerationCleanup = defer("recall state generation", () => { prepared.generation.release() })
    const store = createSqliteEventStore(prepared.dbFile)
    const cancelStoreCleanup = defer("recall state store", () => { store.close() })
    const writer = asAsyncEventWriter(store)
    const manager = createSessionManager({ ...directories, store, writer })
    const passiveSessionId = await manager.createChat({ id: "passive-chat", conversationId: "passive-conversation", name: "Passive", initialState: "inactive" })
    const passiveTree = await tryOpenConversationTree({ sessionId: passiveSessionId, conversationId: "passive-conversation", store: asAsyncEventReadSurface(store), writer })
    if (!passiveTree) throw new Error("Missing seeded passive chat tree")
    const cancelTreeCleanup = defer("recall passive tree", () => { passiveTree.getStorage().dispose() })
    const prewarm = createProcessBackgroundClient({ workerUrl: runtimeWorkerUrl(), logBase: root })
    const cancelPrewarmCleanup = defer("recall prewarm Worker", () => bounded("initial recall index Worker cleanup", prewarm.dispose()))
    const prewarmLane = prewarm.acquire(root)
    const cancelPrewarmLaneCleanup = defer("recall prewarm lease", () => bounded("initial recall index lease cleanup", prewarmLane.close()))
    expect(await bounded("initial recall index watermark", prewarmLane.transcriptSearch({ query: "lockneedle", page: 1 }))).toMatchObject({ total: 0 })
    await bounded("initial recall index lease close", prewarmLane.close())
    cancelPrewarmLaneCleanup()
    await bounded("initial recall index Worker close", prewarm.dispose())
    cancelPrewarmCleanup()
    await passiveTree.appendMessages([{ kind: "user", content: "Passive history remains readable.", origin: "human" }])
    passiveTree.getStorage().dispose()
    cancelTreeCleanup()
    store.close()
    cancelStoreCleanup()
    prepared.generation.release()
    cancelGenerationCleanup()

    process.env.FLYWHEEL_LOG_LEVEL = "DEBUG"
    process.chdir(root)
    const launcher = await createCliLauncher()
    defer("recall launcher", () => bounded("recall launcher cleanup", launcher.dispose()))
    const registry = createAccountProjectRegistry({ userDataRoot: directories.userDataRoot })
    defer("recall registry", () => bounded("recall registry cleanup", registry.dispose()))
    const accountBackground = createProcessBackgroundClient({ workerUrl: runtimeWorkerUrl(), logBase: directories.accountHome })
    defer("recall account Worker", () => bounded("recall account Worker cleanup", accountBackground.dispose()))
    const runtime = await createProjectControlRuntime({
    directories, launcher, registry, version: "test", workerUrl: runtimeWorkerUrl(),
    createBackgroundClient: (projectRoot) => accountBackground.acquire(projectRoot),
    persistentProcesses: createPersistentProcessManager(), allowPersistentProcesses: false,
    updates: idleAccountUpdates(),
    service: servingAccountService(),
    loginShellPath: createLoginShellPath(), processorAdmission: createProcessorGovernor(),
    maintenance: createMaintenanceQueue({ workerUrl: runtimeWorkerUrl(), guardian: launcher.guardian }),
    clientsHold: () => false,
    sessionHolds: { holdProject: () => undefined, projectIdleGraceMs: undefined },
    })
    defer("recall runtime", async () => {
      const settlement = await bounded("recall runtime cleanup", runtime.dispose(), 8_000)
      if (settlement.kind !== "settled") throw new Error(`Recall runtime did not settle: ${settlement.kind}`)
    })
    const liveness = { heartbeatIntervalMs: 30, silenceDeadlineMs: 300 }
    const server = ManagedRuntime.make(
    Layer.fresh(RpcServer.layer(RuntimeProtocolRpc)).pipe(
      Layer.provide(runtimeHandlers(runtime, Log.create({ service: "control-recall-test" }), { version: "0.1.0", liveness })),
      Layer.provide(Layer.fresh(runtimeProtocolSocketServer)),
      Layer.provide(layerMsgPack),
      Layer.provide(bunSocketServerLayer({ path: "public.sock" })),
    ),
    )
    defer("recall server", () => bounded("recall server cleanup", server.dispose()))
    await bounded("recall public server", server.context())
    const connection = createRuntimeConnection({ socket: bunSocketClientLayer("public.sock", async () => {}), liveness })
    defer("recall connection", () => bounded("recall connection cleanup", connection.close()))
  const states: string[] = []
  connection.onStateChange((state) => states.push(state))
  const renamePatch = Promise.withResolvers<void>()
  const finalOutput = Promise.withResolvers<void>()
  const seededOutput = Promise.withResolvers<void>()
  let renamedSessionId = ""
  let recallSessionId = ""
    const unsubscribe = connection.subscribe((event) => {
    if (event.type !== "patch") return
    if (event.patch.payload.kind === "session.updated"
      && event.patch.payload.row.id === renamedSessionId
      && event.patch.payload.row.title === "Correlated during recall") renamePatch.resolve()
    if (event.patch.payload.kind === "output.delta"
      && event.patch.cursor.scope === "session"
      && event.patch.cursor.sessionId === recallSessionId
      && JSON.stringify(event.patch.payload.delta).includes(finalMarker)) finalOutput.resolve()
    if (event.patch.payload.kind === "output.delta"
      && JSON.stringify(event.patch.payload.delta).includes("other session complete")) seededOutput.resolve()
    })
    defer("recall subscription", () => { unsubscribe() })
    let indexLock: Database | null = null
    defer("recall index lock", () => {
      const lock = indexLock
      if (!lock) return
      indexLock = null
      try {
        lock.exec("rollback")
      } catch (rollbackError) {
        try {
          lock.close()
        } catch (closeError) {
          throw new Error("Index close failed after rollback failed", { cause: closeError })
        }
        throw new Error("Index rollback failed", { cause: rollbackError })
      }
      lock.close()
    })
    await bounded("executor cold startup", connection.query({ type: "remoteSnapshot" }), 8_000)
    expect(await bounded("executor background Worker warm", connection.query({
      type: "transcriptSearch",
      request: { query: "__warm_missing__", page: 1 },
    }))).toMatchObject({ hits: [], total: 0 })
    const recallChat = await bounded("recall chat open", connection.dispatch({
      type: "chat.open",
      initialMessage: "Unique lockneedle in durable recall history. recallprobe",
    }), 8_000)
    if (!recallChat.ok || !recallChat.sessionId) throw new Error("Missing recall chat")
    recallSessionId = recallChat.sessionId
    // A person who opens the chat watches its transcript; the runtime sends
    // its output deltas to this connection only while it does.
    const stopWatching = connection.watchOutput(recallSessionId)
    defer("recall output watch", () => { stopWatching() })
    await bounded("seed recall output", seededOutput.promise, 5_000)
    const other = await bounded("other chat open", connection.dispatch({ type: "chat.open" }))
    if (!other.ok || !other.sessionId) throw new Error("Missing other session")
    renamedSessionId = other.sessionId

    expect((await bounded("recall chat send admission", connection.dispatch({
      type: "session.send",
      sessionId: recallSessionId,
      input: "Trigger production recall and use its result.",
    }))).ok).toBe(true)
    await bounded("provider recall tool request", providerEntered.promise)
    indexLock = new Database(resolveConversationSearchDbFile(root))
    indexLock.exec("begin immediate")
    const recallStartedAfter = Date.now()
    releaseRecallToolCall.resolve()
    await bounded("recall entered the locked FTS boundary", waitForConversationFtsWrite(join(root, ".flywheel", "log"), recallStartedAfter), 4_250)

    expect((await bounded("correlated rename during recall", connection.dispatch({
      type: "session.rename",
      sessionId: other.sessionId,
      title: "Correlated during recall",
    }))).ok).toBe(true)
    await bounded("correlated rename patch during recall", renamePatch.promise)
    expect((await bounded("inactive history during recall", connection.query({ type: "sessionDetail", sessionId: passiveSessionId }))).view).toMatchObject({
      source: "durable",
      id: passiveSessionId,
    })
    expect((await bounded("other chat send during recall", connection.dispatch({
      type: "session.send",
      sessionId: other.sessionId,
      input: "other session",
    }))).ok).toBe(true)
    await new Promise<void>((resolve) => setTimeout(resolve, 450))
    expect(connection.state).toBe("connected")
    expect(states).not.toContain("recovering")
    expect(recallResultWasConsumed).toBe(false)

    indexLock.exec("commit")
    indexLock.close()
    indexLock = null
    await bounded("provider consumed recall result after FTS release", recallResultConsumed.promise)
    await bounded("canonical final recall output", finalOutput.promise, 5_000)
    const output = await bounded("recall output window", connection.query({
      type: "outputWindow",
      sessionId: recallSessionId,
      request: { range: { anchor: { kind: "tail" }, maxBlocks: 64, maxBytes: 32_000 } },
    }))
    expect(output.range.kind).toBe("ok")
    if (output.range.kind !== "ok") throw new Error("Recall output unavailable")
    expect(output.range.blocks.some((block) => "content" in block && block.content?.includes(finalMarker) === true)).toBe(true)
  })
}, 25_000)
