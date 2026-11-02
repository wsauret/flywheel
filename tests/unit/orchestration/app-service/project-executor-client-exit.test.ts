import { afterEach, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { scanDebugLogFiles, type DebugLogRecord } from "../../../../src/infra/debug-log.js"
import { Log } from "../../../../src/infra/log.js"
import { recordTermination } from "../../../../src/infra/process-container.js"
import { hardExitDecision } from "../../../helpers/process-watchdog-thread.js"
import { closeExecutorFixtures, fixture } from "./_project-executor-fixture.js"

afterEach(closeExecutorFixtures)

/** A log record's fields, for reading them in an assertion. */
function fieldsOf(record: DebugLogRecord | undefined): { readonly [key: string]: unknown } {
  const payload = record?.payload
  return typeof payload === "object" && payload !== null ? { ...payload } : {}
}

test("an executor that exits on its own leaves its exit status and its last output in the log", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flywheel-executor-exit-"))
  try {
    await Log.init({ dir, level: "INFO" })
    const host = fixture({ diagnostics: true })
    const client = host.acquire()
    await client.ready
    host.exit({ code: 1, signal: null }, "error: executor exploded\n      at explode (executor.ts:1:1)\n")
    expect(await client.closed).toMatchObject({ settled: true })
    await Bun.sleep(5)
    await Log.closeGlobal()

    const records = defaultLevelRecords(dir)
    const exit = fieldsOf(records.find((record) => fieldsOf(record).message === "executor process exited unexpectedly"))
    expect(exit).toMatchObject({ code: 1 })
    expect(String(exit.output)).toContain("error: executor exploded")
    // The decision when Flywheel made it, as a warning because nobody asked
    // for it, and the proof when the closure settled.
    expect(recordsAbout(records, "executor generation end")).toEqual([
      ["log.warn", expect.objectContaining({ message: "executor generation ending", cause: "exited with code 1", code: 1, active: true })],
      ["log.info", { service: "project-executor-client", projectId: "project", generation: 1, message: "executor generation ended", settled: true, closureMs: expect.any(Number) }],
    ])
  } finally {
    await Log.closeGlobal()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a kernel process API the executor's supervisor could not open is relayed as its own warning, with the supervisor that wrote it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flywheel-executor-kernel-api-"))
  try {
    await Log.init({ dir, level: "INFO" })
    const host = fixture({ diagnostics: true })
    const client = host.acquire()
    await client.ready
    const unopened = { service: "process-kernel-api", message: "a kernel process API could not be opened; its process probes answer unproven", api: "libproc", error: "dlopen failed" }
    host.write(`${JSON.stringify({ type: "log.warn", ts: 5, payload: unopened })}\n`)
    host.exit({ code: 1, signal: null })
    expect(await client.closed).toMatchObject({ settled: true })
    await Log.closeGlobal()

    expect(recordsAbout(defaultLevelRecords(dir), "a kernel process API")).toEqual([
      ["log.warn", { ...unopened, sourceTs: 5, supervisorPid: 42, projectId: "project", generation: 1 }],
    ])
  } finally {
    await Log.closeGlobal()
    rmSync(dir, { recursive: true, force: true })
  }
})

/** Every record the test's log directory holds at the default level. */
function defaultLevelRecords(dir: string): DebugLogRecord[] {
  const logDir = join(dir, ".flywheel", "log")
  return [...scanDebugLogFiles(readdirSync(logDir).map((file) => join(logDir, file)), { types: ["log.error", "log.warn", "log.info"] })]
}

/** The records whose message starts with `prefix`, each as its type and fields. */
function recordsAbout(records: readonly DebugLogRecord[], prefix: string): Array<[string, { readonly [key: string]: unknown }]> {
  return records.filter((record) => String(fieldsOf(record).message).startsWith(prefix)).map((record) => [record.type, fieldsOf(record)])
}

test("a start still waiting at ten seconds writes one record that names its step and heartbeats, and the record changes nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flywheel-executor-slow-"))
  try {
    await Log.init({ dir, level: "INFO" })
    const answer = Promise.withResolvers<void>()
    const host = fixture({ readyAnswer: answer.promise })
    const client = host.acquire()
    // The executor beats once as its channels come up and once each second after.
    for (let second = 0; second < 20; second++) {
      await host.clock.advance(1_000)
      await host.lifecyclePeer()?.send({ kind: "heartbeat" })
    }
    answer.resolve()
    await client.ready
    expect(await client.stop()).toEqual({ settled: true })
    await Log.closeGlobal()

    expect(recordsAbout(defaultLevelRecords(dir), "executor start")).toEqual([
      ["log.warn", expect.objectContaining({ message: "executor start slow", step: "ready", heartbeats: 10, startupMs: expect.any(Number) })],
    ])
  } finally {
    await Log.closeGlobal()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a stop the account asked for records its end at INFO", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flywheel-executor-stop-"))
  try {
    await Log.init({ dir, level: "INFO" })
    const host = fixture()
    const client = host.acquire()
    await client.ready
    expect(await client.stop()).toEqual({ settled: true })
    await Log.closeGlobal()

    expect(recordsAbout(defaultLevelRecords(dir), "executor generation end")).toEqual([
      ["log.info", expect.objectContaining({ message: "executor generation ending", cause: "was stopped" })],
      ["log.info", expect.objectContaining({ message: "executor generation ended", settled: true })],
    ])
  } finally {
    await Log.closeGlobal()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a stopping executor's silence is counted and recorded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flywheel-executor-stopping-"))
  try {
    await Log.init({ dir, level: "INFO" })
    // The fixture executor beats once as its channels come up and never
    // again, and it answers the stop only when the test lets it. The first
    // check, one second in, finds that heartbeat; the next three miss.
    const flushed = Promise.withResolvers<void>()
    const host = fixture({ stopAnswer: flushed.promise })
    const client = host.acquire()
    await client.ready
    const stopping = client.stop()
    await host.clock.advance(4 * 1_000)
    flushed.resolve()
    expect(await stopping).toEqual({ settled: true })
    await Log.closeGlobal()

    expect(recordsAbout(defaultLevelRecords(dir), "executor heartbeat")).toEqual([
      ["log.warn", expect.objectContaining({ message: "executor heartbeat stalled", missedPeriods: 3, silentMs: 4_000 })],
    ])
  } finally {
    await Log.closeGlobal()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a stop that misses its deadline records the silence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flywheel-executor-unflushed-"))
  try {
    await Log.init({ dir, level: "INFO" })
    // The executor never answers the stop. Its one heartbeat came as its
    // channels came up, and the first check found it.
    const host = fixture({ wedged: true, stopDeadlineMs: 4_500 })
    const client = host.acquire()
    await client.ready
    const stopping = client.stop()
    await host.clock.advance(4_500)
    expect(await stopping).toMatchObject({ settled: false })
    await Log.closeGlobal()

    expect(recordsAbout(defaultLevelRecords(dir), "executor generation ending")).toEqual([
      ["log.warn", expect.objectContaining({ cause: "did not finish saving its work when it was stopped", error: expect.any(String), missedPeriods: 3, silentMs: 4_500 })],
    ])
  } finally {
    await Log.closeGlobal()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an end records its reason when Flywheel decides it, so a closure that never settles still leaves it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flywheel-executor-hang-"))
  try {
    await Log.init({ dir, level: "INFO" })
    // The startup never passes the admission, so the closure, which joins
    // the startup, never settles.
    const host = fixture({ admission: new Promise<void>(() => {}) })
    const client = host.acquire()
    await Bun.sleep(20)
    void client.terminate("could not start", { silentMs: 31_000, missedPeriods: 30, waitedBy: ["start", "replacement"], interruptedSessionIds: [] })
    await Log.closeGlobal()

    expect(recordsAbout(defaultLevelRecords(dir), "executor generation end")).toEqual([
      ["log.warn", expect.objectContaining({ message: "executor generation ending", cause: "could not start", silentMs: 31_000, missedPeriods: 30, waitedBy: ["start", "replacement"] })],
    ])
  } finally {
    await Log.closeGlobal()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("repeated channel detaches of one generation record the first episode and count the rest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flywheel-executor-detach-"))
  try {
    await Log.init({ dir, level: "INFO" })
    const host = fixture({ reattachDeadlineMs: 1_000 })
    const client = host.acquire()
    await client.ready
    for (let episode = 0; episode < 3; episode++) {
      host.dropPeer("lifecycle")
      await Bun.sleep(20)
      host.reconnect("lifecycle")
      await Bun.sleep(20)
    }
    await client.stop()
    await Log.closeGlobal()

    expect(recordsAbout(defaultLevelRecords(dir), "executor channel")).toEqual([
      ["log.warn", expect.objectContaining({ message: "executor channel detached; awaiting reattach", kind: "lifecycle", reason: expect.any(String) })],
      ["log.info", expect.objectContaining({ message: "executor channels reattached", detachedMs: expect.any(Number) })],
      ["log.warn", expect.objectContaining({ message: "executor channels detached again", count: 2, windowMs: expect.any(Number) })],
    ])
  } finally {
    await Log.closeGlobal()
    rmSync(dir, { recursive: true, force: true })
  }
})

/** The account's exit records and the executor's own log directory, once the
 *  test's executor generation has ended. */
async function exitRecords(dir: string): Promise<{ readonly [key: string]: unknown }[]> {
  await Bun.sleep(5)
  await Log.closeGlobal()
  const logDir = join(dir, ".flywheel", "log")
  return [...scanDebugLogFiles(readdirSync(logDir).map((file) => join(logDir, file)), { types: ["log.error"] })]
    .map(fieldsOf)
    .filter((fields) => fields.message === "executor process exited unexpectedly")
}

/** One account log directory and one project whose executor has written one
 *  log file, for a test that reads the exit record and the marked files. */
function executorWithLog() {
  const dir = mkdtempSync(join(tmpdir(), "flywheel-executor-exit-"))
  const projectRoot = mkdtempSync(join(tmpdir(), "flywheel-executor-project-"))
  const executorPid = 4_000_000
  const executorLogDir = join(projectRoot, ".flywheel", "log")
  mkdirSync(executorLogDir, { recursive: true })
  const executorLog = `2026-09-23T101010000Z-${executorPid}-0-00000000-0000-4000-8000-000000000000.jsonl`
  writeFileSync(join(executorLogDir, executorLog), "")
  return {
    dir, projectRoot, executorPid, executorLogDir, executorLog,
    cleanup() {
      rmSync(dir, { recursive: true, force: true })
      rmSync(projectRoot, { recursive: true, force: true })
    },
  }
}

function markedName(file: string): string {
  return file.replace(/\.jsonl$/, ".unexpected-exit.jsonl")
}

test("an executor killed from outside names no decision, since the supervisor's re-raise is only the payload's status", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flywheel-executor-exit-"))
  try {
    await Log.init({ dir, level: "INFO" })
    const host = fixture({ diagnostics: true })
    const client = host.acquire()
    await client.ready
    const reRaise = { type: "log.debug", payload: { service: "command-supervisor", message: "re-raise payload exit signal", signal: "SIGKILL" } }
    host.exit({ code: null, signal: "SIGKILL" }, `${JSON.stringify(reRaise)}\n`)
    expect(await client.closed).toMatchObject({ settled: true })

    const [exit] = await exitRecords(dir)
    expect(exit).toMatchObject({ signal: "SIGKILL", statusOf: "payload", supervisorPid: 42 })
    expect(exit?.termination).toBeUndefined()
  } finally {
    await Log.closeGlobal()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an executor the supervisor's guardian proof ended names that decision, the executor, and its kept logs, and the account's later report of that loss decides nothing more", async () => {
  const executor = executorWithLog()
  try {
    await Log.init({ dir: executor.dir, level: "INFO" })
    const proof = { guardianPid: 7, expectedIdentity: "7 7 1", actualIdentity: "absent", elapsedProbeMs: 0.5 }
    const decision = { type: "log.info", payload: { service: "process-termination", message: "termination requested", senderPid: 42, container: 42, target: -42, signal: "SIGTERM", reason: "guardian exited", evidence: { ...proof, unreadable: { nested: true } }, caller: "at guardianLost (owned-command-supervisor.ts:1:1)" } }
    // A supervisor can record a decision before spawnOwned returns.
    const host = fixture({ diagnostics: true, executorPid: executor.executorPid, projectRoot: executor.projectRoot, earlySupervisorDiagnostic: { ...decision, ts: undefined } })
    const client = host.acquire()
    await client.ready
    // The account's own report of the same exit comes after that proof, and
    // then the executor dies of the supervisor's signal.
    host.guardianLost({ guardianPid: 7, signal: "SIGKILL" })
    host.exit({ code: null, signal: "SIGTERM" })
    expect(await client.closed).toMatchObject({ settled: true, cause: "stopped by signal SIGTERM" })

    const [exit] = await exitRecords(executor.dir)
    expect(exit).toMatchObject({
      projectId: "project", generation: 1, executorPid: executor.executorPid, supervisorPid: 42, signal: "SIGTERM", statusOf: "payload",
      termination: { senderPid: 42, container: 42, target: -42, signal: "SIGTERM", reason: "guardian exited", caller: "at guardianLost (owned-command-supervisor.ts:1:1)" },
      logFiles: [markedName(executor.executorLog)],
    })
    // The evidence crossed a process boundary, so only its string and number
    // fields are read back.
    expect(exit).toHaveProperty("termination.evidence", proof)
    expect(typeof exit?.lifetimeMs).toBe("number")
    expect(readdirSync(executor.executorLogDir)).toEqual([markedName(executor.executorLog)])
    expect(recordsAbout(defaultLevelRecords(executor.dir), "executor generation ending")).toEqual([
      ["log.warn", expect.objectContaining({ cause: "stopped by signal SIGTERM", signal: "SIGTERM" })],
    ])
  } finally {
    await Log.closeGlobal()
    executor.cleanup()
  }
})

test("an executor ended for its guardian's loss names the account's decision, which the supervisor's stop only carries out", async () => {
  const executor = executorWithLog()
  try {
    await Log.init({ dir: executor.dir, level: "INFO" })
    const host = fixture({ diagnostics: true, terminateWaits: true, executorPid: executor.executorPid, projectRoot: executor.projectRoot })
    const client = host.acquire()
    await client.ready
    // The account's supervisor reports the guardian's exit before it ends the
    // containers that guardian held. The command supervisor then records the
    // stop word it was sent, and the executor dies of that stop's signal.
    host.guardianLost({ guardianPid: 7, signal: "SIGKILL" })
    const stopRequested = { type: "log.info", payload: { service: "process-termination", message: "termination requested", senderPid: 42, container: 42, target: -42, signal: "SIGTERM", reason: "stop requested" } }
    host.exit({ code: null, signal: "SIGTERM" }, `${JSON.stringify(stopRequested)}\n`)
    const end = await client.closed

    const [exit] = await exitRecords(executor.dir)
    expect(exit).toMatchObject({
      executorPid: executor.executorPid, supervisorPid: 42, signal: "SIGTERM",
      termination: { senderPid: process.pid, container: 42, reason: "lost its process guardian", detail: { guardian: { guardianPid: 7, signal: "SIGKILL" } } },
      logFiles: [markedName(executor.executorLog)],
    })
    expect(recordsAbout(defaultLevelRecords(executor.dir), "executor generation ending")).toEqual([
      ["log.warn", expect.objectContaining({ cause: "lost its process guardian", guardian: { guardianPid: 7, signal: "SIGKILL" } })],
    ])
    // The cause that the `restarting` state names.
    expect(end).toMatchObject({ settled: true, cause: "lost its process guardian" })
  } finally {
    await Log.closeGlobal()
    executor.cleanup()
  }
})

test("a stop that ends in the executor's own hard exit names that decision", async () => {
  const executor = executorWithLog()
  try {
    await Log.init({ dir: executor.dir, level: "INFO" })
    const host = fixture({ diagnostics: true, wedged: true, executorPid: executor.executorPid, projectRoot: executor.projectRoot })
    const client = host.acquire()
    await client.ready
    const stopping = client.stop()
    // The stop never settles in the executor, so its hard-exit clock, armed
    // by the account's stop, records its decision and kills the executor.
    await Bun.sleep(5)
    const decision = hardExitDecision({ processPid: executor.executorPid, containerPid: 42, hardExitMs: 35_000, armedBy: "account stop" })
    host.exit({ code: null, signal: "SIGKILL" }, decision)
    expect(await stopping).toMatchObject({ settled: false })

    const [exit] = await exitRecords(executor.dir)
    expect(exit).toMatchObject({
      executorPid: executor.executorPid, supervisorPid: 42, signal: "SIGKILL",
      termination: { container: 42, target: executor.executorPid, signal: "SIGKILL", reason: "shutdown bound expired", evidence: { boundMs: 35_000, armedBy: "account stop" } },
      logFiles: [markedName(executor.executorLog)],
    })
  } finally {
    await Log.closeGlobal()
    executor.cleanup()
  }
})

test("an executor that ends by its stop signal while the account's stop waits for an answer ends that stop, with one INFO record and no exit record", async () => {
  const stopSignal = process.platform === "win32" ? "SIGINT" : "SIGTERM"
  const executor = executorWithLog()
  try {
    await Log.init({ dir: executor.dir, level: "INFO" })
    const host = fixture({ diagnostics: true, executorPid: executor.executorPid, projectRoot: executor.projectRoot })
    const client = host.acquire()
    await client.ready
    // `flywheel kill` signaled the executor and its supervisor together. The
    // executor's signal stop settled and closed its channels before the
    // account's drain asked, so the account's request finds no reader.
    for (const kind of ["control", "state", "output", "lifecycle"] as const) await host.dropPeer(kind)
    const stopping = client.stop()
    await host.clock.advance(250)
    const decision = { type: "log.info", payload: { service: "process-termination", message: "termination requested", senderPid: 42, container: 42, target: -42, signal: stopSignal, reason: "stop signal received", evidence: { signal: stopSignal } } }
    host.exit(process.platform === "win32" ? { code: 130, signal: null } : { code: null, signal: stopSignal }, `${JSON.stringify(decision)}\n`)
    expect(await stopping).toEqual({ settled: true })
    await Bun.sleep(5)
    await Log.closeGlobal()

    const records = defaultLevelRecords(executor.dir)
    expect(recordsAbout(records, "executor ended by")).toEqual([
      ["log.info", expect.objectContaining({ message: "executor ended by its stop signal during the account's stop", signal: stopSignal, termination: expect.objectContaining({ reason: "stop signal received", evidence: { signal: stopSignal } }), stopWaitedMs: 250 })],
    ])
    expect(recordsAbout(records, "executor generation ending")).toEqual([["log.info", expect.objectContaining({ cause: "was stopped" })]])
    expect(records.map((record) => fieldsOf(record).message)).not.toContain("executor process exited unexpectedly")
    expect(readdirSync(executor.executorLogDir)).toEqual([executor.executorLog])
  } finally {
    await Log.closeGlobal()
    executor.cleanup()
  }
})

test("a guardian loss during the account's stop decides nothing, so the executor's exit by the supervisor's signal still ends that stop", async () => {
  const stopSignal = process.platform === "win32" ? "SIGINT" : "SIGTERM"
  const executor = executorWithLog()
  try {
    await Log.init({ dir: executor.dir, level: "INFO" })
    const host = fixture({ diagnostics: true, wedged: true, terminateWaits: true, executorPid: executor.executorPid, projectRoot: executor.projectRoot })
    const client = host.acquire()
    await client.ready
    const stopping = client.stop()
    await host.clock.advance(250)
    // The guardian exits while the executor runs the account's stop. The
    // supervisor's stop word then signals the executor, which joins that stop
    // and exits after that stop settles.
    host.guardianLost({ guardianPid: 7, signal: "SIGKILL" })
    const stopRequested = { type: "log.info", payload: { service: "process-termination", message: "termination requested", senderPid: 42, container: 42, target: -42, signal: stopSignal, reason: "stop requested" } }
    host.exit(process.platform === "win32" ? { code: 130, signal: null } : { code: null, signal: stopSignal }, `${JSON.stringify(stopRequested)}\n`)
    expect(await stopping).toEqual({ settled: true })
    await Bun.sleep(5)
    await Log.closeGlobal()

    const records = defaultLevelRecords(executor.dir)
    expect(recordsAbout(records, "executor ended by")).toEqual([
      ["log.info", expect.objectContaining({ message: "executor ended by its stop signal during the account's stop", signal: stopSignal, stopWaitedMs: 250 })],
    ])
    expect(recordsAbout(records, "executor generation ending")).toEqual([["log.info", expect.objectContaining({ cause: "was stopped" })]])
    expect(records.map((record) => fieldsOf(record).message)).not.toContain("executor process exited unexpectedly")
  } finally {
    await Log.closeGlobal()
    executor.cleanup()
  }
})

test("an executor whose supervisor was killed names the account's own decision to end the rest of its container", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flywheel-executor-exit-"))
  try {
    await Log.init({ dir, level: "INFO" })
    const host = fixture({ diagnostics: true })
    const client = host.acquire()
    await client.ready
    recordTermination({ container: 7, target: -7, signal: "SIGKILL", reason: "an unrelated container" })
    recordTermination({ container: 42, target: -42, signal: "SIGKILL", reason: "container signal" })
    host.exit({ code: null, signal: "SIGKILL", statusOf: "supervisor" })
    expect(await client.closed).toMatchObject({ settled: true })

    const [exit] = await exitRecords(dir)
    expect(exit).toMatchObject({ signal: "SIGKILL", statusOf: "supervisor", supervisorPid: 42, termination: { senderPid: process.pid, container: 42, target: -42, signal: "SIGKILL", reason: "container signal" }, logFiles: [] })
    expect(exit?.executorPid).toBeUndefined()
  } finally {
    await Log.closeGlobal()
    rmSync(dir, { recursive: true, force: true })
  }
})

test("an executor that dies during startup after it named its pid is recorded and keeps its logs", async () => {
  const executor = executorWithLog()
  const admission = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  try {
    await Log.init({ dir: executor.dir, level: "INFO" })
    const host = fixture({ executorPid: executor.executorPid, projectRoot: executor.projectRoot, guardianAdmission: admission.promise, guardianEntered: () => entered.resolve() })
    const client = host.acquire()
    await entered.promise
    // The executor named its pid on the lifecycle channel before startup
    // reached the guardian; one turn of the event loop delivers it.
    await Bun.sleep(5)
    host.exit({ code: 1, signal: null })
    admission.resolve()
    await expect(client.ready).rejects.toThrow()
    await client.closed

    const [exit] = await exitRecords(executor.dir)
    expect(exit).toMatchObject({ code: 1, executorPid: executor.executorPid, logFiles: [markedName(executor.executorLog)] })
    expect(exit?.termination).toBeUndefined()
  } finally {
    await Log.closeGlobal()
    executor.cleanup()
  }
})

test("an executor Flywheel ended through terminate names that end's cause and detail as the decision", async () => {
  const executor = executorWithLog()
  try {
    await Log.init({ dir: executor.dir, level: "INFO" })
    const host = fixture({ executorPid: executor.executorPid, projectRoot: executor.projectRoot })
    const client = host.acquire()
    await client.ready
    await client.terminate("stopped answering, so Flywheel ended it", { silentMs: 31_000, missedPeriods: 30, waitedBy: ["interrupt"], interruptedSessionIds: ["session-a"] })

    const [exit] = await exitRecords(executor.dir)
    expect(exit).toMatchObject({
      code: 0, executorPid: executor.executorPid, supervisorPid: 42,
      termination: { senderPid: process.pid, container: 42, reason: "stopped answering, so Flywheel ended it", detail: { silentMs: 31_000, missedPeriods: 30, waitedBy: ["interrupt"], interruptedSessionIds: ["session-a"] } },
      logFiles: [markedName(executor.executorLog)],
    })
  } finally {
    await Log.closeGlobal()
    executor.cleanup()
  }
})

test("an executor that answers a requested Stop leaves no exit record and keeps its logs ordinary", async () => {
  const executor = executorWithLog()
  try {
    await Log.init({ dir: executor.dir, level: "INFO" })
    const stopped = fixture({ executorPid: executor.executorPid, projectRoot: executor.projectRoot })
    const running = stopped.acquire()
    await running.ready
    expect(await running.stop()).toEqual({ settled: true })
    const early = fixture({ executorPid: executor.executorPid, projectRoot: executor.projectRoot })
    const starting = early.acquire()
    expect(await starting.stop()).toEqual({ settled: true })
    await expect(starting.ready).rejects.toThrow()

    expect(await exitRecords(executor.dir)).toEqual([])
    expect(readdirSync(executor.executorLogDir)).toEqual([executor.executorLog])
  } finally {
    await Log.closeGlobal()
    executor.cleanup()
  }
})

// A starting executor has served nothing, so its stop has nothing to save.
// Under load its command supervisor, which runs at background priority, can
// wait a minute for the scheduler, and a stop that asked it to end the
// container waited that long too.
test("a stop while the executor starts ends its container at once, with no wait for a supervisor that cannot run", async () => {
  const host = fixture({ readyAnswer: new Promise(() => {}), supervisorCannotRun: true })
  const client = host.acquire()
  void client.ready.catch(() => {})
  for (let turn = 0; turn < 50 && !host.observations.includes("start"); turn++) await Bun.sleep(0)
  expect(host.observations).toContain("start")

  const stopping = client.stop()
  const outcome = await Promise.race([stopping.then(() => "stopped"), Bun.sleep(25).then(() => "still waiting")])

  expect(outcome).toBe("stopped")
  expect(await stopping).toEqual({ settled: true })
  expect(host.observations).toContain("end: was stopped before it was ready")
})
