/**
 * The engine process with the real pinned Antigravity CLI and the fake Gemini host (plan M11): one process per chat
 * tree and login, launched under the login's lock, observed from launch, its session files owned and removed, its
 * engine retries cancelled before they reach the host, and nothing left running after a close, a failed launch, or a
 * killed owner.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, readdirSync, rmSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { ATTRIBUTION_WAIT_MS } from "../../../../../src/orchestration/modules/provider-google-antigravity/engine/retry-watch.js"
import { LlmStreamError } from "../../../../../src/orchestration/agent-runtime/llm/errors.js"
import { createLauncherScope, createProcessSupervisor, guardianCommand } from "../../../../../src/infra/process-supervisor.js"
import { temporaryDirectories } from "../../../../helpers/directories.js"
import { eventually, openEngineHarness, openRecordedSession, text, type EngineHarness } from "./_engine.js"

const temporary = temporaryDirectories()
let harness: EngineHarness | undefined
afterEach(async () => {
  await harness?.close()
  harness = undefined
})

const STATUS_429 = { kind: "status", status: 429 } as const
/** agy retries a 429 about 4 s after the failure (REPORT.md P3); a retry that escaped arrives within this wait. */
const RETRY_WINDOW_MS = 6_000

function open(): EngineHarness {
  harness = openEngineHarness(temporary("agy-"))
  return harness
}

/** The sessions that have files in the login's home. */
function sessionsOnDisk(loginDir: string): string[] {
  const conversations = join(loginDir, "home", ".gemini", "antigravity-cli", "conversations")
  return existsSync(conversations) ? [...new Set(readdirSync(conversations).map((name) => name.replace(/\..*$/u, "")))].toSorted() : []
}

const records = (loginDir: string) => existsSync(join(loginDir, "processes")) ? readdirSync(join(loginDir, "processes")) : []
const mainRequests = (engineHarness: EngineHarness) => engineHarness.fake.requests.filter(({ kind }) => kind === "main")
const kindOf = (error: unknown) => error instanceof LlmStreamError ? error.kind : error instanceof Error ? error.name : typeof error

describe("the Antigravity engine process", () => {
  test("serves two trees on one login with their own processes, tool calls and gate traffic, and a close leaves no process, session file or record", async () => {
    const engines = open()
    const login = await engines.login("l1")
    const [first, second] = await Promise.all([login.launch(), login.launch()])
    expect(first.processId).not.toBe(second.processId)
    const [a, b] = [await openRecordedSession(first), await openRecordedSession(second)]
    expect(sessionsOnDisk(login.loginDir)).toEqual([a.sessionId, b.sessionId].toSorted())
    expect(records(login.loginDir).toSorted()).toEqual([`${first.processId}.json`, `${second.processId}.json`].toSorted())

    // Each tree's model calls Flywheel's tool once; agy asks permission for each call, then calls the tool on its own
    // process's path, and each model step passes the login gate under its own session id.
    engines.fake.script(["one", "two"].map((tree) => ({ kind: "calls", when: `tree ${tree}`, calls: [{ name: "mcp_runtime_echo", args: { text: tree, toolSummary: "echo" } }] }) as const))
    // Admit each tree's next step as soon as its previous step passes. A timer can lose the race: on Linux the step
    // after the tool call reaches the gate about 50 ms after the first one.
    for (const { sessionId } of [a, b]) login.gate.grant(sessionId)
    const stopRegrant = login.gate.onEvent(({ sessionId, kind }) => { if (kind === "consumed") login.gate.grant(sessionId) })
    const results = await Promise.all([first.prompt(a.sessionId, text("tree one")), second.prompt(b.sessionId, text("tree two"))]).finally(stopRegrant)
    expect(results.map(({ stopReason }) => stopReason)).toEqual(["end_turn", "end_turn"])
    expect({ a: a.calls, b: b.calls }).toEqual({ a: ['echo {"text":"one"}'], b: ['echo {"text":"two"}'] })
    const consumed = (sessionId: string) => login.gateEvents.filter((event) => event.sessionId === sessionId && event.kind === "consumed").length
    expect([consumed(a.sessionId), consumed(b.sessionId)]).toEqual([2, 2])
    expect(login.gateEvents.every(({ sessionId }) => sessionId === a.sessionId || sessionId === b.sessionId)).toBe(true)
    expect(first.served && second.served).toBe(true)

    expect(await engines.engineProcesses(login.loginDir)).toHaveLength(2)
    const ends = await Promise.all([first.close("released"), second.close("released")])
    expect(ends.map(({ reason, served }) => ({ reason, served }))).toEqual([{ reason: "released", served: true }, { reason: "released", served: true }])
    expect(await engines.engineProcesses(login.loginDir)).toEqual([])
    expect(sessionsOnDisk(login.loginDir)).toEqual([])
    expect(records(login.loginDir)).toEqual([])
  }, 90_000)

  test("an agent file removed after launch makes the next session fail with agent-fallback before any model request", async () => {
    const engines = open()
    const login = await engines.login("l2")
    const engine = await login.launch()
    rmSync(join(login.loginDir, "home", ".gemini", "config", "agents", "flywheel", "agent.md"))
    const opened = await engine.openSession({ onUpdate: () => {}, onToolCall: () => Promise.reject(new Error("no tools")) }).catch((error: unknown) => error)
    expect(opened).toHaveProperty("name", "EngineUnavailableError")
    expect(opened).toHaveProperty("reason", "agent-fallback")
    const end = await engine.ended
    expect(end.failure).toMatchObject({ reason: "agent-fallback" })
    // A later request fails with the stored failure too, not with the closed connection.
    expect(await engine.configure("session/set_model", { sessionId: "any", modelId: "any" }).catch((error: unknown) => error)).toHaveProperty("reason", "agent-fallback")
    expect(engines.fake.requests.filter(({ kind }) => kind !== "other")).toEqual([])
    expect(await engines.engineProcesses(login.loginDir)).toEqual([])
  }, 60_000)

  test("a launch that fails after the engine started leaves no process, record or tool path", async () => {
    const engines = open()
    const login = await engines.login("l3")
    expect(await login.launch({ authMethod: "not-an-auth-method" }).catch((error: unknown) => error)).toBeInstanceOf(Error)
    await eventually(async () => (await engines.engineProcesses(login.loginDir)).length === 0 && records(login.loginDir).length === 0, 10_000)
    expect(await engines.engineProcesses(login.loginDir)).toEqual([])
    expect(records(login.loginDir)).toEqual([])
  }, 60_000)

  test("a 429 on two concurrent sessions' prompts cancels each session once, and no engine retry reaches the host", async () => {
    const engines = open()
    const login = await engines.login("l4")
    const engine = await login.launch()
    const [s, t] = [await openRecordedSession(engine), await openRecordedSession(engine)]
    engines.fake.script([{ ...STATUS_429, when: "prompt S" }, { ...STATUS_429, when: "prompt T" }])
    for (const { sessionId } of [s, t]) login.gate.grant(sessionId)
    const outcomes = await Promise.all([engine.prompt(s.sessionId, text("prompt S")), engine.prompt(t.sessionId, text("prompt T"))].map((prompt) => prompt.then(() => "answered", kindOf)))
    expect(outcomes).toEqual(["rate_limit", "rate_limit"])
    await Bun.sleep(RETRY_WINDOW_MS)
    expect(mainRequests(engines).map(({ answer }) => answer?.kind)).toEqual(["status", "status"])
  }, 90_000)

  test("control: with the retry watch off, the engine's own retry reaches the host about 4 s later", async () => {
    const engines = open()
    const login = await engines.login("l5")
    const engine = await login.launch({ testSeams: { retryWatch: false } })
    const s = await openRecordedSession(engine)
    engines.fake.script([STATUS_429, { kind: "text", text: "after the retry" }])
    login.gate.grant(s.sessionId)
    expect((await engine.prompt(s.sessionId, text("prompt S"))).stopReason).toBe("end_turn")
    const [failed, retried] = mainRequests(engines)
    expect(retried).toBeDefined()
    expect((retried?.at ?? 0) - (failed?.at ?? 0)).toBeGreaterThan(3_000)
  }, 90_000)

  test("with both transcript signs shown only the failing session is cancelled; with its sign hidden, the log line cancels both open prompts within the wait", async () => {
    const engines = open()
    const login = await engines.login("l6")
    let hidden: string | undefined
    const engine = await login.launch({ testSeams: { transcriptSign: (sessionId) => sessionId !== hidden } })
    /** A healthy prompt whose answer the host holds 2.5 s, and, once its request arrived, a prompt that fails with 503. */
    const round = async (name: string, hideFailingSign: boolean) => {
      const [failing, healthy] = [await openRecordedSession(engine), await openRecordedSession(engine)]
      hidden = hideFailingSign ? failing.sessionId : undefined
      engines.fake.script([{ kind: "text", text: name, delayMs: 2_500, when: `healthy ${name}` }, { kind: "status", status: 503, when: `failing ${name}` }])
      for (const { sessionId } of [failing, healthy]) login.gate.grant(sessionId)
      const healthyOutcome = engine.prompt(healthy.sessionId, text(`healthy ${name}`)).then(({ stopReason }) => stopReason, kindOf)
      await eventually(() => engines.fake.requests.some(({ body, kind }) => kind === "main" && body.includes(`healthy ${name}`)), 30_000)
      const started = Date.now()
      const failingOutcome = await engine.prompt(failing.sessionId, text(`failing ${name}`)).then(({ stopReason }) => stopReason, kindOf)
      const failedAfterMs = Date.now() - started
      return { failing: failingOutcome, healthy: await healthyOutcome, failedAfterMs }
    }

    const shown = await round("one", false)
    expect({ failing: shown.failing, healthy: shown.healthy }).toEqual({ failing: "overload", healthy: "end_turn" })

    const unattributed = await round("two", true)
    expect({ failing: unattributed.failing, healthy: unattributed.healthy }).toEqual({ failing: "transient", healthy: "transient" })
    expect(unattributed.failedAfterMs).toBeLessThan(ATTRIBUTION_WAIT_MS + 1_500)

    // A 503 whose error message holds a line break: agy writes its log record over several lines, and with the
    // transcript sign hidden the log record alone cancels the one open prompt.
    const multiline = await openRecordedSession(engine)
    hidden = multiline.sessionId
    engines.fake.script([{ kind: "status", status: 503, when: "failing three", body: { error: { code: 503, message: "The model is overloaded.\nPlease try again later.", status: "UNAVAILABLE" } } }])
    login.gate.grant(multiline.sessionId)
    expect(await engine.prompt(multiline.sessionId, text("failing three")).then(({ stopReason }) => stopReason, kindOf)).toBe("overload")

    await Bun.sleep(RETRY_WINDOW_MS)
    // Each failing prompt sent one request, and no engine retry followed.
    for (const name of ["one", "two", "three"]) expect(mainRequests(engines).filter(({ body }) => body.includes(`failing ${name}`))).toHaveLength(1)
  }, 120_000)

  test("a killed owner leaves no engine running, and the next launch sweeps only its session files", async () => {
    const root = temporary("agy-")
    const supervisor = createProcessSupervisor({ guardianCommand: guardianCommand() })
    const launcher = createLauncherScope(supervisor)
    try {
      const owner = await launcher.spawnOwned([process.execPath, fileURLToPath(new URL("_engine-owner.ts", import.meta.url)), root, "l7"], { env: process.env })
      const reader = owner.stdout?.getReader()
      let output = ""
      while (!output.includes("\n")) {
        const chunk = await reader?.read()
        if (chunk === undefined || chunk.done) break
        output += new TextDecoder().decode(chunk.value)
      }
      const [, ownerPid, crashed] = /^READY (\d+) (\S+)/u.exec(output) ?? []
      expect(crashed).toBeDefined()
      harness = openEngineHarness(root)
      const engines = harness
      const loginDir = join(root, "l7")
      expect(await engines.engineProcesses(loginDir)).toHaveLength(1)
      expect(sessionsOnDisk(loginDir)).toEqual([crashed ?? ""])

      // The owner process itself, which named its pid, not its container: on Unix its guardian ends the engine it
      // launched, and on Windows the end of the owner closes the job of the engine's launch.
      process.kill(Number(ownerPid), "SIGKILL")
      expect(await eventually(async () => (await engines.engineProcesses(loginDir)).length === 0, 20_000)).toBe(true)

      // A restart on the same login: its sweep removes the gone owner's session; a live sibling's session stays.
      const restarted = await engines.login("l7")
      const relaunched = await restarted.launch()
      expect(sessionsOnDisk(loginDir)).toEqual([])
      const sibling = await openRecordedSession(relaunched)
      await restarted.launch()
      expect(sessionsOnDisk(loginDir)).toEqual([sibling.sessionId])
    } finally {
      await launcher.close()
      await supervisor.dispose()
    }
  }, 120_000)
})
