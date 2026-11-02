import { afterAll, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { tmpdir } from "node:os"

import { readRuntimeIdentity } from "../../../src/cli/runtime-attach.js"
import { serveLaneFor } from "../../../src/infra/cli-subprocess.js"
import { accountServeRecordPath, LOG_DIR } from "../../../src/infra/paths.js"
import type { RuntimeClient } from "../../../src/protocol/app-service-types.js"
import { defaultRoleSlots } from "../../../src/orchestration/config/role-selection.js"
import { ROLE_MODEL_DEFAULTS } from "../../../src/orchestration/config/role-model-defaults.js"
import { attachAccountProject, joinIsolatedAccountService } from "./_account-service.js"
import { removeWhenReleased } from "../../helpers/remove-when-released.js"

// ARCH-RUNTIME-076, the guarded steady-state volume budget: the
// default-level diagnostics stream stays storage-neutral. An idle account
// service with an open project writes no record, the session's first turn
// stays under a stated byte budget, and a later turn with four times the tool
// calls writes exactly the records a turn is allowed, no more and no larger.
// The test fails when volume grows, so a new per-call INFO record shows up
// here before it reaches a person's disk.

/** How long the service must stay idle, after startup settles, with no
 *  diagnostic record written. */
const IDLE_WINDOW_MS = 60_000
/** Quiet time that marks the end of startup's background work. */
const SETTLE_QUIET_MS = 3_000
/** Every diagnostic byte, account and project logs together, that the
 *  session's first turn, with two tool calls and its title request, may
 *  write at the default level. The turn writes about 4 KB: the dispatch, the
 *  session's activation, the title run and its result, and the startup
 *  summaries of the Workers a first turn starts. The budget leaves about a
 *  kilobyte of room, so a few per-call records at INFO, or one copy of the
 *  pasted text, cross it. */
const TURN_BUDGET_BYTES = 5_120
/** A pasted text in the turn's message. Conversation content lives in the
 *  event store, so no diagnostic record may carry it: one copy alone is
 *  larger than the turn's budget. */
const PASTED_TEXT = "fixture log line with content that stays out of diagnostics\n".repeat(400)
/** The tool calls of the later turn, one after another. */
const LATER_TURN_CALLS = 8
/** Every record, as `type service message`, that a turn after the first may
 *  write at the default level, whatever its number of tool calls: the
 *  person's message, the run that answered it, and the learning review that
 *  followed it, one each. */
const ALLOWED_LATER_TURN_RECORDS: readonly string[] = [
  "log.info app-service app-service dispatch done",
  "log.info agent-runner agent runner completed",
  "log.info learning-review learning review settled",
]
const STEP_MS = 30_000
const MODEL = "gpt-5"

const LANE = serveLaneFor(process.execPath)
// Canonical, because the service address is a hash of the account data root
// string, and `/tmp` is a symlink on macOS.
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), "fw-diagnostics-budget-")))
const accountHome = path.join(TMP, "home")
const userDataRoot = path.join(accountHome, ".flywheel")
const projectRoot = path.join(TMP, "project")
const logDirectories = [path.join(accountHome, LOG_DIR), path.join(projectRoot, LOG_DIR)]

interface SseData {
  readonly [key: string]: unknown
}

function sse(data: SseData): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

/** A provider that answers the first turn with two bash calls in sequence
 *  and the later turn with LATER_TURN_CALLS of them, each turn then with a
 *  final answer. Every request without tools is a title request. */
function startFixtureProvider() {
  let turnRequests = 0
  const answer = (delta: SseData, finishReason: string): Response => new Response([
    sse({ id: "fixture", object: "chat.completion.chunk", model: MODEL, choices: [{ index: 0, delta, finish_reason: null }] }),
    sse({ id: "fixture", object: "chat.completion.chunk", model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] }),
    sse({ id: "fixture", object: "chat.completion.chunk", model: MODEL, choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }),
    "data: [DONE]\n\n",
  ].join(""), { headers: { "content-type": "text/event-stream" } })
  const call = (id: string, command: string): Response => answer({
    tool_calls: [{ index: 0, id, type: "function", function: { name: "bash", arguments: JSON.stringify({ command }) } }],
  }, "tool_calls")
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname.endsWith("/models")) {
        return Response.json({ object: "list", data: [{ id: MODEL, object: "model", created: 0, owned_by: "fixture" }] })
      }
      const body: unknown = await request.json()
      const tools = typeof body === "object" && body !== null && "tools" in body && Array.isArray(body.tools) && body.tools.length > 0
      const whole = JSON.stringify(body)
      if (!tools || whole.includes("Generate a session title")) return answer({ content: "TITLE: Budget session\nSHORT: Budget" }, "stop")
      turnRequests += 1
      if (whole.includes("Run the step commands")) {
        let done = 0
        while (whole.includes(`fixture-step-${done + 1}`)) done += 1
        return done === LATER_TURN_CALLS ? answer({ content: "Every step ran." }, "stop") : call(`budget-step-${done + 1}`, `printf fixture-step-${done + 1}`)
      }
      if (whole.includes("fixture-two")) return answer({ content: "Both commands ran." }, "stop")
      if (whole.includes("fixture-one")) return call("budget-2", "printf fixture-two")
      return call("budget-1", "printf fixture-one")
    },
  })
  if (server.port === undefined) throw new Error("fixture provider did not bind a port")
  return { port: server.port, turnRequests: () => turnRequests, stop: () => { server.stop(true) } }
}

function writeAccountConfig(providerPort: number): void {
  const authDirectory = path.join(userDataRoot, "auth", "profiles", "default")
  fs.mkdirSync(authDirectory, { recursive: true })
  for (const dir of [userDataRoot, path.join(userDataRoot, "auth"), path.join(userDataRoot, "auth", "profiles"), authDirectory]) fs.chmodSync(dir, 0o700)
  const roles = new Set([...defaultRoleSlots().map((slot) => slot.roleId), ...Object.keys(ROLE_MODEL_DEFAULTS)])
  fs.writeFileSync(path.join(userDataRoot, "flywheel.toml"), [
    "[custom_providers.fixture]",
    `base_url = ${JSON.stringify(`http://127.0.0.1:${providerPort}/v1`)}`,
    `models = [${JSON.stringify(MODEL)}]`,
    "",
    ...[...roles].flatMap((role) => [`[roles.${JSON.stringify(role)}]`, `model = ${JSON.stringify(MODEL)}`, 'effort = "low"', ""]),
  ].join("\n"))
  fs.writeFileSync(path.join(authDirectory, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "fixture-placeholder-key" } }), { mode: 0o600 })
}

/** Byte length of every `.jsonl` file under the log directories. */
function logSizes(): Map<string, number> {
  const sizes = new Map<string, number>()
  for (const dir of logDirectories) {
    let names: string[]
    try {
      names = fs.readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue
      const file = path.join(dir, name)
      try {
        sizes.set(file, fs.statSync(file).size)
      } catch {
        // A retention sweep can remove a listed file.
      }
    }
  }
  return sizes
}

interface WrittenRecords {
  readonly bytes: number
  readonly records: readonly string[]
  readonly text: string
}

/** The records written since `before`, each as `type service message`. */
function writtenSince(before: ReadonlyMap<string, number>): WrittenRecords {
  let bytes = 0
  let text = ""
  const records: string[] = []
  for (const [file, size] of logSizes()) {
    const from = before.get(file) ?? 0
    if (size <= from) continue
    const handle = fs.openSync(file, "r")
    try {
      const buffer = Buffer.alloc(size - from)
      fs.readSync(handle, buffer, 0, buffer.length, from)
      bytes += buffer.length
      text += buffer.toString("utf8")
      for (const line of buffer.toString("utf8").split("\n")) {
        if (line.trim() === "") continue
        const record: unknown = JSON.parse(line)
        if (typeof record !== "object" || record === null || !("type" in record)) continue
        const payload = "payload" in record && typeof record.payload === "object" && record.payload !== null ? record.payload : {}
        const service = "service" in payload ? String(payload.service) : ""
        const message = "message" in payload ? String(payload.message) : ""
        records.push(`${String(record.type)} ${service} ${message}`.trim())
      }
    } finally {
      fs.closeSync(handle)
    }
  }
  return { bytes, records, text }
}

function describeRecords(records: readonly string[]): string {
  const counts = new Map<string, number>()
  for (const record of records) counts.set(record, (counts.get(record) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1]).map(([record, count]) => `${count} x ${record}`).join("\n")
}

function grew(before: ReadonlyMap<string, number>, after: ReadonlyMap<string, number>): boolean {
  return [...after].some(([file, size]) => before.get(file) !== size)
}

/** Waits until no log grows for SETTLE_QUIET_MS. */
async function settle(): Promise<void> {
  const deadline = Date.now() + STEP_MS * 2
  let sizes = logSizes()
  let quietSince = Date.now()
  while (Date.now() - quietSince < SETTLE_QUIET_MS) {
    if (Date.now() > deadline) throw new Error(`the logs never went quiet after startup:\n${describeRecords(writtenSince(sizes).records)}`)
    await Bun.sleep(250)
    const next = logSizes()
    if (grew(sizes, next)) {
      sizes = next
      quietSince = Date.now()
    }
  }
}

async function until<T>(label: string, read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + STEP_MS
  for (;;) {
    const value = await read()
    if (accept(value)) return value
    if (Date.now() > deadline) throw new Error(`${label} did not happen within ${STEP_MS}ms; last: ${JSON.stringify(value)}`)
    await Bun.sleep(50)
  }
}

async function activity(client: RuntimeClient, sessionId: string): Promise<string | undefined> {
  return (await client.query({ type: "statusSnapshot", sessionIds: [sessionId] })).views[0]?.view?.activity
}

async function stopAccountService(): Promise<void> {
  const identity = readRuntimeIdentity(accountServeRecordPath(userDataRoot, LANE))
  if (identity) {
    try {
      process.kill(identity.pid, "SIGTERM")
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) throw cause
    }
  }
  await joinIsolatedAccountService(userDataRoot)
  fs.rmSync(accountServeRecordPath(userDataRoot, LANE), { force: true })
}

/** A local HTTPS proxy that refuses every tunnel with an HTTP error at once.
 *  The service's processes inherit it, so a request they make to the internet,
 *  such as the model catalog refresh from models.dev on the first discovery,
 *  gets an error status in a millisecond instead of the network. A failed
 *  refresh keeps the saved catalog. A slow or unreachable models.dev otherwise
 *  lands the refresh's timeout warning in whichever window is open 10 s later. */
function startRefusingProxy() {
  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      data(socket) {
        socket.end("HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
      },
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, stop: () => { server.stop(true) } }
}

const provider = startFixtureProvider()
const proxy = startRefusingProxy()
const savedHttpsProxy = process.env.HTTPS_PROXY
const savedNoProxy = process.env.NO_PROXY
// Hermetic: the service's update check would reach the network.
process.env.FLYWHEEL_TEST_NO_UPDATE_CHECK = "1"
process.env.HTTPS_PROXY = proxy.url
process.env.NO_PROXY = "127.0.0.1,localhost"

afterAll(async () => {
  await stopAccountService()
  provider.stop()
  proxy.stop()
  delete process.env.FLYWHEEL_TEST_NO_UPDATE_CHECK
  if (savedHttpsProxy === undefined) delete process.env.HTTPS_PROXY
  else process.env.HTTPS_PROXY = savedHttpsProxy
  if (savedNoProxy === undefined) delete process.env.NO_PROXY
  else process.env.NO_PROXY = savedNoProxy
  // The service was terminated, and Windows releases a terminated process's
  // handles in TMP a moment after it exits.
  if (!process.env.FW_KEEP_TMP) removeWhenReleased(TMP, 30_000)
}, 60_000)

describe("diagnostics volume budget", () => {
  test("an idle account service writes no record, and a turn's records do not grow with its tool calls", async () => {
    writeAccountConfig(provider.port)
    fs.mkdirSync(projectRoot, { recursive: true })
    const attached = await attachAccountProject({ accountHome, userDataRoot, executionCwd: projectRoot, projectRoot })
    const client = attached.client
    try {
      const opened = await client.dispatch({ type: "chat.open" })
      if (!opened.ok || !opened.sessionId) throw new Error("the chat did not open")
      const sessionId = opened.sessionId
      await settle()

      const idleFrom = logSizes()
      await Bun.sleep(IDLE_WINDOW_MS)
      const idle = writtenSince(idleFrom)

      const turnFrom = logSizes()
      expect(await client.dispatch({ type: "session.send", sessionId, input: `Run the two fixture commands for this pasted log:\n${PASTED_TEXT}` })).toMatchObject({ ok: true })
      await until("turn finished", async () => ({ requests: provider.turnRequests(), activity: await activity(client, sessionId) }), (state) => state.requests >= 3 && state.activity === "idle")
      await settle()
      const turn = writtenSince(turnFrom)

      const laterFrom = logSizes()
      expect(await client.dispatch({ type: "session.send", sessionId, input: `Run the step commands, ${LATER_TURN_CALLS} in turn.` })).toMatchObject({ ok: true })
      await until("later turn finished", async () => ({ requests: provider.turnRequests(), activity: await activity(client, sessionId) }), (state) => state.requests >= 3 + LATER_TURN_CALLS + 1 && state.activity === "idle")
      await settle()
      const later = writtenSince(laterFrom)

      process.stderr.write(`diagnostics budget: idle ${idle.records.length} records, ${idle.bytes} bytes in ${IDLE_WINDOW_MS} ms; first turn ${turn.records.length} records, ${turn.bytes} bytes; later turn with ${LATER_TURN_CALLS} calls ${later.records.length} records, ${later.bytes} bytes\n`)
      expect(idle.records, `idle records:\n${describeRecords(idle.records)}`).toEqual([])
      // Conversation content lives in the event store, never in a record.
      expect(turn.text).not.toContain("stays out of diagnostics")
      expect(turn.bytes, `turn records:\n${describeRecords(turn.records)}`).toBeLessThanOrEqual(TURN_BUDGET_BYTES)
      // Four times the tool calls of the first turn, and no more records or
      // bytes than it: nothing records per call at the default level.
      expect([...later.records].sort(), `later turn records:\n${describeRecords(later.records)}`).toEqual([...ALLOWED_LATER_TURN_RECORDS].sort())
      expect(later.records.length).toBeLessThanOrEqual(turn.records.length)
      expect(later.bytes, `later turn records:\n${describeRecords(later.records)}`).toBeLessThanOrEqual(turn.bytes)
    } finally {
      await attached.dispose()
    }
  }, 240_000)
})
