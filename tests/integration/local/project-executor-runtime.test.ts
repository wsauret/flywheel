import { expect, spyOn, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdir, readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { createCliLauncher, runtimeWorkerUrl } from "../../../src/cli/runtime-launch.js"
import { createPersistentProcessManager } from "../../../src/infra/persistent-process-manager.js"
import { PROCESS_KILL_GRACE_MS } from "../../../src/infra/process-supervisor.js"
import { parseProjectionFact } from "../../../src/infra/event-projection.js"
import { spawnProjectStateWorker } from "../../../src/orchestration/app-service/project-state-worker-spawner.js"
import { createProjectExecutorClient, type ProjectExecutorClient } from "../../../src/orchestration/app-service/project-executor-client.js"
import { createProjectControlRuntime } from "../../../src/orchestration/app-service/project-control-runtime.js"
import { createMaintenanceQueue } from "../../../src/orchestration/app-service/runtime-maintenance-owner.js"
import { createAccountProjectRegistry } from "../../../src/orchestration/app-service/account-project-registry.js"
import { createProcessBackgroundClient } from "../../../src/orchestration/app-service/worker-background-client.js"
import { withDeadline } from "../../../src/infra/with-deadline.js"
import { createLoginShellPath } from "../../../src/infra/login-shell-path.js"
import { createProcessorGovernor } from "../../../src/orchestration/app-service/processor-governor.js"
import { extractContent } from "../../../src/infra/tool-content.js"
import { createProjectExecutionState } from "../../../src/orchestration/app-service/project-execution-state.js"
import type { RuntimeChatDefault, RuntimeClient, SessionCatalogRow } from "../../../src/protocol/app-service-types.js"
import { createMessagePortProcessEndpoint, listenInternalProcessChannel } from "../../../src/infra/internal-process-channel.js"
import { connectProjectExecutionChannel, serveProjectExecutionChannel } from "../../../src/orchestration/app-service/project-execution-channel.js"
import { parseConversationTreeFact } from "../../../src/orchestration/session/conversation/conversation-facts.js"
import { turnEndOfEntry } from "../../../src/orchestration/session/conversation/turn-end-record.js"
import { quotePowerShell } from "../../../src/orchestration/agent-runtime/tools/bash-script.js"
import { temporaryDirectories } from "../../helpers/directories.js"
import { servingAccountService } from "../../helpers/account-service-state.js"
import { idleAccountUpdates } from "../../helpers/account-updates.js"
import { frameKind, holdStopAcknowledgement, recordAccountLog, TEST_EXECUTOR_HEARTBEAT_INTERVAL_MS } from "./_executor-heartbeats.js"
import { writeFixtureAccountConfig } from "./_fixture-account.js"

const temporaryDirectory = temporaryDirectories()

/** The model the fixture provider serves for every role. */
const FIXTURE_MODEL = "gpt-5"
const WINDOWS_HELD_COMMAND = `Set-Content -LiteralPath ${quotePowerShell("command-started")} -Value 'started'; for ($i = 0; $i -lt 1200; $i++) { Start-Sleep -Milliseconds 50 }`

interface ExecutorProbe {
  readonly root: string
  readonly executor: ProjectExecutorClient
  readonly runtime: RuntimeClient
  readonly state: ReturnType<ReturnType<typeof spawnProjectStateWorker>["acquire"]>
}

interface ExecutorOptions {
  /** Wraps the account's side of each executor channel. */
  readonly listen?: typeof listenInternalProcessChannel
  /** The heartbeat period the account names; the production period without one. */
  readonly heartbeatIntervalMs?: number
  /** The port of a fixture provider that serves every model role. */
  readonly providerPort?: number
  /** Keeps the attached blank chat while the executor's stop pauses it. */
  readonly clientsHold?: boolean
}

/** Starts one real executor generation over a fresh account state in its own
 *  project, hands it to `use`, and ends every process it started. */
async function withExecutor(use: (probe: ExecutorProbe) => Promise<void>, options: ExecutorOptions = {}): Promise<void> {
  const { listen, heartbeatIntervalMs, providerPort } = options
  const root = temporaryDirectory("executor-")
  const cwd = process.cwd()
  const workerUrl = runtimeWorkerUrl()
  const directories = { projectRoot: root, executionCwd: root, accountHome: join(root, "account"), userDataRoot: join(root, "account", ".flywheel") }
  await mkdir(join(root, ".git"))
  await mkdir(directories.userDataRoot, { recursive: true })
  if (providerPort !== undefined) await writeFixtureAccountConfig(directories.userDataRoot, { port: providerPort, model: FIXTURE_MODEL })
  // Relative socket names keep this probe valid under long sandbox scratch paths.
  process.chdir(root)
  const launcher = await createCliLauncher()
  const persistentProcesses = createPersistentProcessManager()
  const state = spawnProjectStateWorker(directories, root, workerUrl).acquire()
  let executor: ProjectExecutorClient | undefined
  try {
    await state.capturePosition()
    executor = createProjectExecutorClient({
      async admit() { expect(await state.execution({ kind: "generation.admit", projectId: "probe", generation: 1 })).toEqual({ kind: "ok" }) },
      projectId: "probe", projectLabel: "probe", generation: 1, directories, state, launcher, persistentProcesses,
      workerUrl, allowPersistentProcesses: false, allowPersistentLaunch: async () => false,
      chatDefault: (): RuntimeChatDefault => ({ kind: "pending" }),
      loginShellPath: createLoginShellPath(), processorAdmission: createProcessorGovernor(),
      clientsHold: () => options.clientsHold ?? false,
      watchedOutput: () => [],
      notify: async () => {},
      endpoints: { control: "control.sock", state: "state.sock", output: "output.sock", lifecycle: "lifecycle.sock" },
      ...(listen ? { listen } : {}),
      ...(heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs }),
    })
    await use({ root, executor, runtime: await executor.ready, state })
  } finally {
    await executor?.terminate("the test ends")
    await state.close()
    await launcher.dispose()
    process.chdir(cwd)
  }
}

interface LogRecord {
  readonly type: string
  readonly payload: { readonly service?: string; readonly message?: string; readonly [key: string]: unknown }
}

/** The account's side of each executor channel, which shows `observe` each
 *  frame the executor sends and each frame the account sends before it
 *  passes on. */
function observeExecutorChannels(observe: { readonly received?: (message: unknown) => void; readonly sent?: (message: unknown) => void }): typeof listenInternalProcessChannel {
  return (options) => listenInternalProcessChannel({
    ...options,
    onConnection(endpoint) {
      options.onConnection({
        ...endpoint,
        onMessage: (handler) => endpoint.onMessage((message) => {
          observe.received?.(message)
          return handler(message)
        }),
        send(message) {
          observe.sent?.(message)
          return endpoint.send(message)
        },
      })
    },
  })
}

/** The account's side of each executor channel, which also reads the
 *  executor's own pid from its `process` frame. */
function listenForExecutorPid() {
  const pid = Promise.withResolvers<number>()
  const listen = observeExecutorChannels({
    received(message) {
      if (frameKind(message) === "process" && typeof message === "object" && message !== null && "pid" in message && typeof message.pid === "number") pid.resolve(message.pid)
    },
  })
  return { listen, pid: pid.promise }
}

/** Resolves with the fields of the first record `read` returns with
 *  `message`, once one is written. */
async function recordWritten(read: () => readonly { readonly [key: string]: unknown }[], message: string): Promise<{ readonly [key: string]: unknown }> {
  const deadline = performance.now() + 10_000
  for (;;) {
    const found = read().find((fields) => fields.message === message)
    if (found) return found
    if (performance.now() > deadline) throw new Error(`no record "${message}" within 10 s`)
    await Bun.sleep(20)
  }
}

/** Resolves once the turn's command has written `file`. */
async function fileWritten(file: string): Promise<void> {
  const deadline = performance.now() + 20_000
  while (!existsSync(file)) {
    if (performance.now() > deadline) throw new Error("the turn's command did not start within 20 s")
    await Bun.sleep(20)
  }
}

/** Every record the processes of this project wrote to its log directory. */
async function projectLogRecords(root: string): Promise<readonly LogRecord[]> {
  const dir = join(root, ".flywheel", "log")
  const names = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"))
  const text = (await Promise.all(names.map((name) => readFile(join(dir, name), "utf8")))).join("")
  return text.split("\n").filter((line) => line.length > 0).map((line): LogRecord => JSON.parse(line))
}

/** A provider whose turn runs `command` through the Bash tool once and then
 *  finishes. A request without tools, or one for a title, answers at once. */
function startCommandProvider(command: string) {
  const sse = (data: unknown): string => `data: ${JSON.stringify(data)}\n\n`
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname.endsWith("/models")) {
        return Response.json({ object: "list", data: [{ id: FIXTURE_MODEL, object: "model", created: 0, owned_by: "fixture" }] })
      }
      const body: unknown = await request.json()
      const text = JSON.stringify(body)
      const turn = typeof body === "object" && body !== null && "tools" in body && Array.isArray(body.tools) && body.tools.length > 0 && !text.includes("Generate a session title")
      const runsCommand = turn && !text.includes(`"tool_call_id":"command-1"`)
      const delta = runsCommand
        ? { tool_calls: [{ index: 0, id: "command-1", type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } }] }
        : { content: turn ? "Done." : "TITLE: Fixture session\nSHORT: Fixture" }
      return new Response([
        sse({ id: "fixture", object: "chat.completion.chunk", model: FIXTURE_MODEL, choices: [{ index: 0, delta, finish_reason: null }] }),
        sse({ id: "fixture", object: "chat.completion.chunk", model: FIXTURE_MODEL, choices: [{ index: 0, delta: {}, finish_reason: runsCommand ? "tool_calls" : "stop" }] }),
        sse({ id: "fixture", object: "chat.completion.chunk", model: FIXTURE_MODEL, choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }),
        "data: [DONE]\n\n",
      ].join(""), { headers: { "content-type": "text/event-stream" } })
    },
  })
  if (server.port === undefined) throw new Error("fixture provider did not bind a port")
  return { port: server.port, stop: () => { void server.stop(true) } }
}

/** Starts the account's real generation router and disposes only its own
 *  fixture project, processes, channels, and log. */
async function withControlRuntime(
  use: (probe: { readonly root: string; readonly runtime: Awaited<ReturnType<typeof createProjectControlRuntime>>; readonly account: Awaited<ReturnType<typeof recordAccountLog>> }) => Promise<void>,
  options: { readonly listen: typeof listenInternalProcessChannel; readonly providerPort: number },
): Promise<void> {
  const root = temporaryDirectory("control-stop-")
  const cwd = process.cwd()
  const directories = { projectRoot: root, executionCwd: root, accountHome: join(root, "account"), userDataRoot: join(root, "account", ".flywheel") }
  await mkdir(join(root, ".git"))
  await writeFixtureAccountConfig(directories.userDataRoot, { port: options.providerPort, model: FIXTURE_MODEL })
  const resources = new AsyncDisposableStack()
  resources.defer(() => process.chdir(cwd))
  try {
    process.chdir(root)
    const account = await recordAccountLog(join(root, "account-log"))
    resources.defer(() => account.close())
    const launcher = await createCliLauncher()
    resources.defer(() => launcher.dispose())
    const registry = createAccountProjectRegistry({ userDataRoot: directories.userDataRoot })
    resources.defer(() => registry.dispose())
    const background = createProcessBackgroundClient({ workerUrl: runtimeWorkerUrl(), logBase: directories.accountHome })
    resources.defer(() => background.dispose())
    const runtime = await createProjectControlRuntime({
      directories, launcher, registry, version: "test", workerUrl: runtimeWorkerUrl(),
      createBackgroundClient: (projectRoot) => background.acquire(projectRoot),
      persistentProcesses: createPersistentProcessManager(), allowPersistentProcesses: false,
      updates: idleAccountUpdates(), service: servingAccountService(), loginShellPath: createLoginShellPath(), processorAdmission: createProcessorGovernor(), sessionHolds: { holdProject: () => undefined, projectIdleGraceMs: undefined }, clientsHold: () => true,
      maintenance: createMaintenanceQueue({ workerUrl: runtimeWorkerUrl(), guardian: launcher.guardian }),
      listen: options.listen, executorHeartbeatIntervalMs: TEST_EXECUTOR_HEARTBEAT_INTERVAL_MS,
    })
    resources.defer(async () => { expect(await withDeadline(runtime.dispose(), 15_000)).toEqual({ kind: "settled" }) })
    await use({ root, runtime, account })
  } finally {
    await resources.disposeAsync()
  }
}

/** The state owner fences a closed generation before recovering its turn. */
async function recoverForcedExit(state: ExecutorProbe["state"], sessionId: string): Promise<void> {
  expect(await state.execution({ kind: "generation.close", projectId: "probe", generation: 1 })).toEqual({ kind: "ok" })
  expect(await state.execution({ kind: "generation.recover", projectId: "probe", generation: 1 })).toEqual({ kind: "ok" })
  expect(await state.sessions.read(sessionId)).toMatchObject({ lifecycleState: "inactive" })
}

test("executor composes real query and dispatch over account state and leaves its Worker usable after Stop", async () => {
  await withExecutor(async ({ executor, runtime, state }) => {
    expect((await runtime.query({ type: "snapshot" })).rows).toEqual([])
    const content = "worker-owned tool output\n".repeat(2000)
    const extracted = extractContent(content)
    if (extracted.kind !== "reference") throw new Error("expected referenced tool content")
    const committed = await state.writer.append({
      aggregateId: "read-parity", sessionId: "read-parity", type: "tool.execution_output.recorded", version: 2,
      timestamp: 1, actor: "flywheel", payload: { toolUseId: "read-parity-tool", output: extracted.reference }, contentRows: [extracted.row],
    })
    const reached = Promise.withResolvers<void>()
    const releaseRead = Promise.withResolvers<void>()
    const readPage = state.readPage
    // Hold a real Worker response, not a synthetic page, so timer ordering does
    // not depend on the size of the fixture or the machine's read latency.
    const readProbe = spyOn(state, "readPage").mockImplementation(async (...args) => {
      const page = await readPage(...args)
      reached.resolve()
      await releaseRead.promise
      return page
    })
    const execution = await createProjectExecutionState(state)
    let settled = false
    const pendingRead = execution.eventStore.readPage({ aggregateId: "read-parity" }, await state.capturePosition(), 0).then((page) => {
      settled = true
      return page
    })
    try {
      await withDeadline(reached.promise, 3000)
      await new Promise<void>((resolve) => { setTimeout(resolve, 0) })
      expect(settled).toBe(false)
      releaseRead.resolve()
      const page = await pendingRead
      expect(page.facts).toEqual([committed])
      expect(page.toolContent.resolve("read-parity", extracted.reference.sha256)).toBe(content)
      const exact = await execution.eventStore.readSlice({ aggregateId: "read-parity", positions: [committed.position] })
      expect(exact.facts).toEqual([committed])
      expect(exact.toolContent.resolve("read-parity", extracted.reference.sha256)).toBe(content)
    } finally {
      releaseRead.resolve()
      await pendingRead
      readProbe.mockRestore()
      await execution.eventStoreRuntime.dispose()
    }
    const added = Promise.withResolvers<SessionCatalogRow>()
    const unsubscribe = runtime.subscribe((event) => {
      if (event.type === "patch" && event.patch.payload.kind === "session.added") added.resolve(event.patch.payload.row)
    })
    const opened = await runtime.dispatch({ type: "chat.open" })
    expect(opened.ok).toBe(true)
    if (!opened.ok || !opened.sessionId) throw new Error("chat.open did not create a session")
    expect(await withDeadline(added.promise, 3000)).toMatchObject({ id: opened.sessionId, activity: "absent" })
    unsubscribe()
    expect((await runtime.query({ type: "snapshot" })).rows).toHaveLength(1)
    expect(await state.sessions.read(opened.sessionId)).not.toBeNull()
    const ports = new MessageChannel()
    const server = createMessagePortProcessEndpoint({ port: ports.port1, decode: (value) => value })
    const peer = createMessagePortProcessEndpoint({ port: ports.port2, decode: (value) => value })
    const release = Promise.withResolvers<void>()
    let sends = 0
    const drain = serveProjectExecutionChannel({ query: runtime.query, dispatch: runtime.dispatch, subscribe: runtime.subscribe, watchOutput: () => {}, hideSession: async () => {} }, {
      ...server,
      async send(message) {
        if (++sends === 1) await release.promise
        await server.send(message)
      },
    })
    const slowClient = connectProjectExecutionChannel(peer)
    const repaired = Promise.withResolvers<void>()
    const oversizedTitle = "x".repeat(3_800_000)
    const finalTitle = `3${oversizedTitle}`
    slowClient.onOutputGap(async () => {
      const snapshot = await slowClient.query({ type: "snapshot" })
      expect(snapshot.rows).toEqual([expect.objectContaining({ id: opened.sessionId, title: finalTitle })])
      repaired.resolve()
    })
    try {
      for (let index = 0; index < 4; index++) {
        expect((await runtime.dispatch({ type: "session.rename", sessionId: opened.sessionId, title: `${index}${oversizedTitle}` })).ok).toBe(true)
      }
      expect(sends).toBe(1)
      release.resolve()
      await withDeadline(repaired.promise, 5000)
      expect((await slowClient.query({ type: "snapshot" })).rows).toEqual([expect.objectContaining({ id: opened.sessionId, title: finalTitle })])
      expect(state.available).toBe(true)
    } finally {
      release.resolve()
      await slowClient.close()
      await drain()
    }
    expect(await executor.stop()).toEqual({ settled: true })
    expect(state.available).toBe(true)
    const afterStop = await state.sessions.createChat({ name: "State still available" })
    expect(await state.sessions.read(afterStop)).not.toBeNull()
    expect(await state.capturePosition()).toBeGreaterThan(0)
    await expect(runtime.query({ type: "snapshot" })).rejects.toThrow()
  })
}, 60_000)

test("an executor asked to stop while background admissions are in flight answers stopped and records no failure", async () => {
  await withExecutor(async ({ root, executor, runtime, state }) => {
    // Each new session queues a resident reconciliation in the executor, and
    // the snapshot admits the catalog's summaries on the background lane.
    // Neither is awaited, so the stop that follows at once closes their
    // owners under them.
    for (let index = 0; index < 120; index++) await state.sessions.createChat({ name: `Chat ${index}` })
    await runtime.query({ type: "snapshot" })
    expect(await executor.stop()).toEqual({ settled: true })
    expect((await projectLogRecords(root)).filter((record) => record.type === "log.error")).toEqual([])
    expect((await readdir(join(root, ".flywheel", "log"))).filter((name) => name.endsWith(".unexpected-exit.jsonl"))).toEqual([])
  })
}, 60_000)

test("a start that keeps sending heartbeats is served however long it takes, and nothing ends it", async () => {
  // The start command reaches the executor 11 s after the account sends it,
  // past the ten seconds at which the one slow-start record is written. The
  // executor's heartbeat runs at the production period all the while.
  const HELD_MS = 11_000
  let heldAt: number | undefined
  let heartbeats = 0
  const listen: typeof listenInternalProcessChannel = (options) => listenInternalProcessChannel({
    ...options,
    onConnection(endpoint) {
      options.onConnection({
        ...endpoint,
        onMessage: (handler) => endpoint.onMessage((message) => {
          if (frameKind(message) === "heartbeat" && heldAt !== undefined) heartbeats++
          return handler(message)
        }),
        async send(message) {
          if (frameKind(message) !== "start") return endpoint.send(message)
          heldAt = performance.now()
          void Bun.sleep(HELD_MS).then(() => endpoint.send(message)).catch(() => {})
        },
      })
    },
  })
  await withExecutor(async ({ executor, runtime }) => {
    expect(heldAt).toBeDefined()
    expect(performance.now() - (heldAt ?? 0)).toBeGreaterThanOrEqual(HELD_MS)
    expect(heartbeats).toBeGreaterThanOrEqual(HELD_MS / 1_000 - 1)
    expect((await runtime.query({ type: "snapshot" })).rows).toEqual([])
    expect(await Promise.race([executor.closed.then(() => "ended"), Bun.sleep(0).then(() => "serving")])).toBe("serving")
  }, { listen })
}, 60_000)

test(process.platform === "win32" ? "an external SIGTERM forcefully ends the Windows executor and its session recovers" : "a SIGTERM runs the ordered stop and ends the executor by SIGTERM", async () => {
  if (process.platform === "win32") {
    const executorPid = listenForExecutorPid()
    await withExecutor(async ({ root, executor, runtime, state }) => {
      const account = await recordAccountLog(join(root, "account-log"))
      try {
        const opened = await runtime.dispatch({ type: "chat.open" })
        if (!opened.ok || !opened.sessionId) throw new Error("chat.open did not create a session")
        process.kill(await executorPid.pid, "SIGTERM")
        expect(await withDeadline(executor.closed, 20_000)).toEqual({ settled: true, cause: "exited with code 1" })
        expect(await recordWritten(account.records, "executor process exited unexpectedly")).toMatchObject({ code: 1, statusOf: "payload" })
        const messages = (await projectLogRecords(root)).map((record) => record.payload.message)
        expect(messages).not.toContain("executor stop signal received")
        expect(messages).not.toContain("shutdown barrier settled")
        expect(messages).not.toContain("fatal")
        expect(messages).not.toContain("unhandled rejection")
        await recoverForcedExit(state, opened.sessionId)
      } finally {
        await account.close()
      }
    }, { listen: executorPid.listen })
    return
  }
  const executorPid = listenForExecutorPid()
  await withExecutor(async ({ root, executor }) => {
    const account = await recordAccountLog(join(root, "account-log"))
    try {
      process.kill(await executorPid.pid, "SIGTERM")
      expect((await withDeadline(executor.closed, 20_000)).cause).toBe("stopped by signal SIGTERM")
      // The account marks the executor's log files before it records the exit.
      expect(await recordWritten(account.records, "executor process exited unexpectedly")).toMatchObject({ signal: "SIGTERM", statusOf: "payload" })
      const records = await projectLogRecords(root)
      expect(records).toContainEqual(expect.objectContaining({ type: "log.warn", payload: expect.objectContaining({ message: "executor stop signal received", signal: "SIGTERM", orderedStop: true }) }))
      const messages = records.map((record) => record.payload.message)
      expect(messages).toContain("shutdown barrier settled")
      expect(messages).not.toContain("fatal")
      expect(messages).not.toContain("unhandled rejection")
    } finally {
      await account.close()
    }
  }, { listen: executorPid.listen })
}, 60_000)

test(process.platform === "win32" ? "an account stop that races a forced Windows exit reports the unflushed stop and recovers" : "an account stop that joins a signal stop is answered", async () => {
  if (process.platform === "win32") {
    const executorPid = listenForExecutorPid()
    await withExecutor(async ({ root, executor, runtime, state }) => {
      const account = await recordAccountLog(join(root, "account-log"))
      try {
        const opened = await runtime.dispatch({ type: "chat.open" })
        if (!opened.ok || !opened.sessionId) throw new Error("chat.open did not create a session")
        process.kill(await executorPid.pid, "SIGTERM")
        // TerminateProcess cannot join JavaScript shutdown.
        expect(await executor.stop()).toEqual({ settled: false, reason: "Executor did not flush gracefully: Error: project executor exited with code 1" })
        expect(await recordWritten(account.records, "executor process exited unexpectedly")).toMatchObject({ code: 1, statusOf: "payload" })
        expect((await projectLogRecords(root)).map((record) => record.payload.message)).not.toContain("executor stop signal received")
        await recoverForcedExit(state, opened.sessionId)
      } finally {
        await account.close()
      }
    }, { listen: executorPid.listen })
    return
  }
  const executorPid = listenForExecutorPid()
  await withExecutor(async ({ root, executor }) => {
    const account = await recordAccountLog(join(root, "account-log"))
    try {
      // `flywheel kill` signals the executor and the account together, and
      // the account's drain then asks the executor to stop.
      process.kill(await executorPid.pid, "SIGTERM")
      expect(await executor.stop()).toEqual({ settled: true })
      // The exit follows the closure; one turn lets its handler record it.
      await Bun.sleep(10)
      const records = account.records()
      expect(records.filter((fields) => fields.message === "executor generation ending").map((fields) => fields.cause)).toEqual(["was stopped"])
      expect(records.map((fields) => fields.message)).not.toContain("executor process exited unexpectedly")
      expect((await projectLogRecords(root)).map((record) => record.payload)).toContainEqual(expect.objectContaining({ message: "executor stop signal received", signal: "SIGTERM", orderedStop: true }))
    } finally {
      await account.close()
    }
  }, { listen: executorPid.listen })
}, 60_000)

test(process.platform === "win32" ? "an account-decided Windows job end retains its intent and recovers its in-flight turn as a crash" : "an end the account decides closes the channels first, so the executor ends at its supervisor's SIGTERM with its turn in flight", async () => {
  if (process.platform === "win32") {
    const provider = startCommandProvider(WINDOWS_HELD_COMMAND)
    try {
      await withExecutor(async ({ root, executor, runtime, state }) => {
        const account = await recordAccountLog(join(root, "account-log"))
        try {
          const opened = await runtime.dispatch({ type: "chat.open" })
          if (!opened.ok || !opened.sessionId) throw new Error("chat.open did not create a session")
          expect(await runtime.dispatch({ type: "session.send", sessionId: opened.sessionId, input: "Run the fixture command." })).toMatchObject({ ok: true })
          await fileWritten(join(root, "command-started"))
          expect(await executor.terminate("the account ends it")).toEqual({ settled: true, cause: "the account ends it" })
          const ended = await recordWritten(account.records, "executor generation ended")
          expect(ended.settled).toBe(true)
          expect(ended.closureMs).toBeLessThan(PROCESS_KILL_GRACE_MS / 2)
          expect(await recordWritten(account.records, "executor process exited unexpectedly")).toMatchObject({ code: 1, statusOf: "payload", termination: { reason: "the account ends it", senderPid: process.pid } })
          const messages = (await projectLogRecords(root)).map((record) => record.payload.message)
          expect(messages).not.toContain("executor stop signal received")
          expect(messages).not.toContain("executor ends by its stop signal")
          await recoverForcedExit(state, opened.sessionId)
          const page = await state.readPage({ sessionId: opened.sessionId, types: ["chat.entries.appended"] }, await state.capturePosition(), 0)
          const turnEnds = page.facts.flatMap((event) => {
            if (event instanceof Error) throw event
            const fact = parseProjectionFact(event, parseConversationTreeFact)
            return fact.type === "chat.entries.appended" ? fact.payload.entries.flatMap((entry) => turnEndOfEntry(entry) ?? []) : []
          })
          expect(turnEnds).toEqual([{ reason: "crash" }])
        } finally {
          await account.close()
        }
      }, { providerPort: provider.port })
    } finally {
      provider.stop()
    }
    return
  }
  // Without the detach rule, the ordered stop would record the cut turn
  // through channels the account closed, and wait for the supervisor's
  // SIGKILL at the end of its kill grace.
  const provider = startCommandProvider(": > command-started; i=0; while [ $i -lt 1200 ]; do sleep 0.05; i=$((i+1)); done")
  try {
    await withExecutor(async ({ root, executor, runtime }) => {
      const account = await recordAccountLog(join(root, "account-log"))
      try {
        const opened = await runtime.dispatch({ type: "chat.open" })
        if (!opened.ok || !opened.sessionId) throw new Error("chat.open did not create a session")
        expect(await runtime.dispatch({ type: "session.send", sessionId: opened.sessionId, input: "Run the fixture command." })).toMatchObject({ ok: true })
        await fileWritten(join(root, "command-started"))
        expect(await executor.terminate("the account ends it")).toEqual({ settled: true, cause: "the account ends it" })
        const ended = await recordWritten(account.records, "executor generation ended")
        expect(ended.settled).toBe(true)
        expect(ended.closureMs).toBeLessThan(PROCESS_KILL_GRACE_MS / 2)
        expect(await recordWritten(account.records, "executor process exited unexpectedly")).toMatchObject({ signal: "SIGTERM", termination: { reason: "the account ends it" } })
        // The executor sees the account close its channels before or after
        // the supervisor's SIGTERM, and ends at once either way.
        const executorRecords = (await projectLogRecords(root)).map((record) => record.payload)
        const receipt = executorRecords.find((fields) => fields.message === "executor stop signal received")
        const endedBy = executorRecords.find((fields) => fields.message === "executor ends by its stop signal")
        expect(receipt?.orderedStop === true ? endedBy?.after : receipt?.why).toBe(receipt?.orderedStop === true ? "lifecycle channel detached" : "the lifecycle channel is detached")
      } finally {
        await account.close()
      }
    }, { providerPort: provider.port })
  } finally {
    provider.stop()
  }
}, 60_000)

test("an executor keeps its heartbeat while it stops", async () => {
  const held = holdStopAcknowledgement()
  try {
    await withExecutor(async ({ executor, runtime, state }) => {
      const opened = await runtime.dispatch({ type: "chat.open" })
      if (!opened.ok || !opened.sessionId) throw new Error("chat.open did not create a session")
      held.arm(opened.sessionId)
      let settled = false
      const stop = executor.stop().then((result) => { settled = true; return result })
      try {
        await withDeadline(held.entered, 10_000)
        expect(await state.sessions.read(opened.sessionId)).toMatchObject({ lifecycleState: "inactive" })
        await withDeadline(held.tenHeartbeats, 10_000)
        expect(held.heartbeats()).toBeGreaterThanOrEqual(10)
        expect(held.answered()).toBe(false)
        expect(settled).toBe(false)
        await expect(runtime.dispatch({ type: "chat.open" })).rejects.toThrow("project executor is stopping")
      } finally {
        held.release()
        expect(await withDeadline(stop, 10_000)).toEqual({ settled: true })
      }
    }, { listen: held.listen, clientsHold: true, heartbeatIntervalMs: TEST_EXECUTOR_HEARTBEAT_INTERVAL_MS })
  } finally {
    held.release()
  }
}, 60_000)

test("a message refused during a real ordered stop is served by generation two after durable acknowledgement", async () => {
  const provider = startCommandProvider("echo fixture")
  const held = holdStopAcknowledgement()
  try {
    await withControlRuntime(async ({ runtime, account }) => {
      const opened = await runtime.client.dispatch({ type: "chat.open" })
      if (!opened.ok || !opened.sessionId) throw new Error("chat.open did not create a session")
      held.arm(opened.sessionId)
      // The client that shows the chat activates it; the activation answers before the executor attaches the runner.
      expect(await runtime.client.dispatch({ type: "session.activate", sessionId: opened.sessionId })).toMatchObject({ ok: true })
      await withDeadline(held.activated, 10_000)
      await held.sendStop()
      await withDeadline(held.entered, 10_000)
      let settled = false
      const send = runtime.client.dispatch({ type: "session.send", sessionId: opened.sessionId, input: "Typed while the executor stops." }).then((result) => { settled = true; return result })
      try {
        await withDeadline(held.refused, 10_000)
        await withDeadline(held.tenHeartbeats, 10_000)
        expect(held.heartbeats()).toBeGreaterThanOrEqual(10)
        expect(held.answered()).toBe(false)
        expect(settled).toBe(false)
        expect(account.records().filter((fields) => fields.message === "executor generation ready").map((fields) => fields.generation)).toEqual([1])
      } finally {
        held.release()
        expect(await withDeadline(send, 20_000)).toMatchObject({ ok: true })
      }
      expect(account.records().filter((fields) => fields.message === "executor generation ready").map((fields) => fields.generation)).toEqual([1, 2])
    }, { listen: held.listen, providerPort: provider.port })
  } finally {
    held.release()
    provider.stop()
  }
}, 60_000)

test(process.platform === "win32" ? "a message sent after a forced Windows exit waits for recovery and is served by generation two" : "a message sent while a signal stops the executor is served by the generation that follows", async () => {
  if (process.platform === "win32") {
    const provider = startCommandProvider(WINDOWS_HELD_COMMAND)
    const executorPid = listenForExecutorPid()
    try {
      await withControlRuntime(async ({ root, runtime, account }) => {
        const opened = await runtime.client.dispatch({ type: "chat.open" })
        if (!opened.ok || !opened.sessionId) throw new Error("chat.open did not create a session")
        expect(await runtime.client.dispatch({ type: "session.send", sessionId: opened.sessionId, input: "Run the fixture command." })).toMatchObject({ ok: true })
        await fileWritten(join(root, "command-started"))
        process.kill(await executorPid.pid, "SIGTERM")
        expect(await recordWritten(account.records, "executor process exited unexpectedly")).toMatchObject({ code: 1, statusOf: "payload" })
        expect(await withDeadline(runtime.client.dispatch({ type: "session.send", sessionId: opened.sessionId, input: "Typed while the executor stops." }), 20_000)).toMatchObject({ ok: true })
        expect(account.records().filter((fields) => fields.message === "executor generation ready").map((fields) => fields.generation)).toEqual([1, 2])
        const window = await runtime.client.query({ type: "outputWindow", sessionId: opened.sessionId, request: { range: { anchor: { kind: "tail" }, maxBlocks: 64, maxBytes: 256_000 } } })
        if (window.range.kind !== "ok") throw new Error("recovered transcript was unavailable")
        const messages = window.range.blocks.flatMap((block) => block.kind === "system" ? [block.message] : [])
        expect(messages).toContain("Interrupted by an unexpected exit")
        expect(messages).not.toContain("Interrupted by the runtime")
      }, { listen: executorPid.listen, providerPort: provider.port })
    } finally {
      provider.stop()
    }
    return
  }
  // The turn's command ignores TERM, so the ordered stop waits the command's
  // kill grace, five seconds, and the message reaches a stopping executor.
  const provider = startCommandProvider("trap '' TERM; : > command-started; i=0; while [ $i -lt 1200 ]; do sleep 0.05; i=$((i+1)); done")
  const executorPid = listenForExecutorPid()
  const root = temporaryDirectory("control-signal-")
  const cwd = process.cwd()
  const directories = { projectRoot: root, executionCwd: root, accountHome: join(root, "account"), userDataRoot: join(root, "account", ".flywheel") }
  await mkdir(join(root, ".git"))
  await writeFixtureAccountConfig(directories.userDataRoot, { port: provider.port, model: FIXTURE_MODEL })
  // Relative socket names keep this probe valid under long sandbox scratch paths.
  process.chdir(root)
  const account = await recordAccountLog(join(root, "account-log"))
  const launcher = await createCliLauncher()
  const registry = createAccountProjectRegistry({ userDataRoot: directories.userDataRoot })
  const background = createProcessBackgroundClient({ workerUrl: runtimeWorkerUrl(), logBase: directories.accountHome })
  const runtime = await createProjectControlRuntime({
    directories, launcher, registry, version: "test", workerUrl: runtimeWorkerUrl(),
    createBackgroundClient: (projectRoot) => background.acquire(projectRoot),
    persistentProcesses: createPersistentProcessManager(), allowPersistentProcesses: false,
    updates: idleAccountUpdates(), service: servingAccountService(), loginShellPath: createLoginShellPath(), processorAdmission: createProcessorGovernor(), sessionHolds: { holdProject: () => undefined, projectIdleGraceMs: undefined }, clientsHold: () => false,
    maintenance: createMaintenanceQueue({ workerUrl: runtimeWorkerUrl(), guardian: launcher.guardian }),
    listen: executorPid.listen,
  })
  try {
    const opened = await runtime.client.dispatch({ type: "chat.open" })
    if (!opened.ok || !opened.sessionId) throw new Error("chat.open did not create a session")
    expect(await runtime.client.dispatch({ type: "session.send", sessionId: opened.sessionId, input: "Run the fixture command." })).toMatchObject({ ok: true })
    await fileWritten(join(root, "command-started"))
    process.kill(await executorPid.pid, "SIGTERM")
    // Each record is on disk when its write returns, and the receipt comes
    // before the stop, so a send after it reaches a stopping executor.
    const receiptDeadline = performance.now() + 10_000
    while (!(await projectLogRecords(root)).some((record) => record.payload.message === "executor stop signal received")) {
      if (performance.now() > receiptDeadline) throw new Error("the executor wrote no stop signal receipt within 10 s")
      await Bun.sleep(20)
    }
    expect(await withDeadline(runtime.client.dispatch({ type: "session.send", sessionId: opened.sessionId, input: "Typed while the executor stops." }), 20_000)).toMatchObject({ ok: true })
    expect(account.records().filter((fields) => fields.message === "executor generation ready").map((fields) => fields.generation)).toEqual([1, 2])
  } finally {
    expect(await withDeadline(runtime.dispose(), 15_000)).toEqual({ kind: "settled" })
    await background.dispose()
    await registry.dispose()
    await launcher.dispose()
    await account.close()
    process.chdir(cwd)
    provider.stop()
  }
}, 60_000)
