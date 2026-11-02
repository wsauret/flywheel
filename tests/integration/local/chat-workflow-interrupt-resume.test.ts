import { afterAll, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"

import { isRuntimeListening, readRuntimeIdentity } from "../../../src/cli/runtime-attach.js"
import { serveLaneFor } from "../../../src/infra/cli-subprocess.js"
import { accountServeRecordPath, accountServeSocketPath, accountServeTokenPath, resolveEventStoreDbFile } from "../../../src/infra/paths.js"
import { createAccountAttachResponseReader, encodeAccountAttach } from "../../../src/protocol/account-attach.js"
import type { FrontendOutputBlock, RuntimeClient } from "../../../src/protocol/app-service-types.js"
import { defaultRoleSlots } from "../../../src/orchestration/config/role-selection.js"
import { ROLE_MODEL_DEFAULTS } from "../../../src/orchestration/config/role-model-defaults.js"
import { CONTINUATION_MESSAGES } from "../../../src/orchestration/agent-runtime/continuation-messages.js"
import { COMMAND_HANDOVER_IN_FLIGHT_KIND } from "../../../src/orchestration/session/command-handover.js"
import { PLANNED_SESSION_CONTINUATION_IN_FLIGHT_KIND } from "../../../src/orchestration/session/planned-session-continuation.js"
import { attachAccountProject, joinIsolatedAccountService, startIsolatedAccountService } from "./_account-service.js"
import { readStoreFile } from "./_replacement-harness.js"
import { descendantProcesses } from "../../helpers/real-process-fixture.js"
import { socketTemporaryRoot } from "../../helpers/directories.js"

// The isolated account service is started through this process's bun, so it serves this process's lane.
const LANE = serveLaneFor(process.execPath)

// Canonical, because the service address is a hash of the account data root
// string, and `/tmp` is a symlink on macOS.
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(socketTemporaryRoot(), "fw-chat-workflow-interrupt-resume-")))
const accountHome = path.join(TMP, "home")
const userDataRoot = path.join(accountHome, ".flywheel")
const project = path.join(TMP, "project")
const buildFile = path.join(TMP, "installed-build.json")
const MODEL = "gpt-5"
const CHAT_TASK = "CHAT-FIXTURE-TASK: answer when the fixture releases you"
const WORKFLOW_TASK = "WORKFLOW-FIXTURE-TASK: investigate the fixture defect"
const WORKFLOW_LAUNCH = "WORKFLOW-FIXTURE-LAUNCH"
const HELD_TURN = "Hold this turn open"
const STEP_HANDOFF_CALL_ID = "step-handoff-1"
/** A workflow of one phase, so the handoff of its one step ends the run. A
 *  later phase would read the same user request and get the same held answer. */
const WORKFLOW_FILE = [
  "id: interrupt-fixture",
  "name: Interrupt Fixture",
  "description: One step that the fixture provider holds.",
  "phases:",
  "  - phase: investigate",
  "    name: Investigate",
  "    brief: Investigate the reported issue. Do not edit files.",
  "    output:",
  "      summary: Concise result of the investigation.",
  "",
].join("\n")
const HELD_SHELL_CALL_ID = "held-shell-1"
/** The whole run has one budget so a stalled step names itself. */
const STEP_MS = 30_000

interface SseData {
  readonly [key: string]: unknown
}

function sse(data: SseData): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

function requestHasTools(body: unknown): boolean {
  return typeof body === "object" && body !== null && "tools" in body && Array.isArray(body.tools) && body.tools.length > 0
}

/** The user turns identify the task; the system prompt names every tool. */
function userText(body: unknown): string {
  if (typeof body !== "object" || body === null || !("messages" in body) || !Array.isArray(body.messages)) return ""
  return JSON.stringify(body.messages.filter((message: unknown) => typeof message === "object" && message !== null && "role" in message && message.role === "user"))
}

function hasToolResult(body: unknown, toolCallId: string): boolean {
  if (typeof body !== "object" || body === null || !("messages" in body) || !Array.isArray(body.messages)) return false
  return body.messages.some((message: unknown) => typeof message === "object" && message !== null
    && "role" in message && message.role === "tool" && "tool_call_id" in message && message.tool_call_id === toolCallId)
}

function toolCallDelta(id: string, name: string, args: SseData): SseData {
  return { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }
}

/** The one provider every session of the project talks to. A chat turn that
 *  carries the chat task is held until the test releases it, so the turn can
 *  be interrupted mid-request and resumed into a fresh held request. A workflow
 *  step that carries the workflow task is held the same way, then answers
 *  with the handoff that ends the one-phase workflow.
 *  A turn that carries the held-turn text runs a shell
 *  command that waits for the test, which a replacement hands to the next
 *  build. Every request without tools (a title) answers at once. */
function startProvider() {
  let chatRelease = Promise.withResolvers<void>()
  let chatEntered = Promise.withResolvers<void>()
  let stepRelease = Promise.withResolvers<void>()
  let stepEntered = Promise.withResolvers<void>()
  // The held turn runs a foreground shell command that waits for this file.
  let heldTurnRelease = path.join(TMP, `held-shell-${crypto.randomUUID()}`)
  let chatRequests = 0
  let continuedChatRequests = 0
  let stepRequests = 0
  let continuedStepRequests = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const pathname = new URL(request.url).pathname
      if (pathname.endsWith("/models")) {
        return Response.json({ object: "list", data: [{ id: MODEL, object: "model", created: 0, owned_by: "fixture" }] })
      }
      const body: unknown = await request.json()
      const text = userText(body)
      // A title request quotes the person's first message and carries the
      // runner's tools, so only its instruction tells it apart; a well-formed
      // title keeps the title generator from retrying for the whole run.
      let delta: SseData = { content: "TITLE: Fixture session\nSHORT: Fixture" }
      let finishReason = "stop"
      const held = requestHasTools(body) && !text.includes("Generate a session title")
      if (held && text.includes(WORKFLOW_LAUNCH)) {
        if (hasToolResult(body, "workflow-launch")) {
          delta = { content: "The workflow launched." }
        } else {
          delta = toolCallDelta("workflow-launch", "workflow", {
            source: { kind: "content", content: WORKFLOW_FILE },
            description: WORKFLOW_TASK,
            summary: WORKFLOW_TASK,
          })
          finishReason = "tool_calls"
        }
      } else if (held && text.includes(CHAT_TASK)) {
        chatRequests += 1
        // A resumed request carries the continuation a Resume records; the
        // first request never does.
        if (text.includes(CONTINUATION_MESSAGES.resumed)) continuedChatRequests += 1
        chatEntered.resolve()
        await chatRelease.promise
        delta = { content: "Chat finished." }
      } else if (held && text.includes(WORKFLOW_TASK)) {
        stepRequests += 1
        if (text.includes(CONTINUATION_MESSAGES.resumed)) continuedStepRequests += 1
        stepEntered.resolve()
        await stepRelease.promise
        // The handoff ends the step; the worker asks the model nothing more.
        delta = toolCallDelta(STEP_HANDOFF_CALL_ID, "handoff", { summary: "The fixture has no defect." })
        finishReason = "tool_calls"
      } else if (held && text.includes(HELD_TURN)) {
        if (hasToolResult(body, HELD_SHELL_CALL_ID)) {
          delta = { content: "Held turn finished." }
        } else {
          delta = toolCallDelta(HELD_SHELL_CALL_ID, "bash", { command: `while [ ! -e ${JSON.stringify(heldTurnRelease)} ]; do sleep 0.05; done` })
          finishReason = "tool_calls"
        }
      }
      return new Response([
        sse({ id: "fixture", object: "chat.completion.chunk", model: MODEL, choices: [{ index: 0, delta, finish_reason: null }] }),
        sse({ id: "fixture", object: "chat.completion.chunk", model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] }),
        sse({ id: "fixture", object: "chat.completion.chunk", model: MODEL, choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }),
        "data: [DONE]\n\n",
      ].join(""), { headers: { "content-type": "text/event-stream" } })
    },
  })
  if (server.port === undefined) throw new Error("fixture provider did not bind a port")
  return {
    port: server.port,
    chatEntered: () => chatEntered.promise,
    releaseChat: () => { chatRelease.resolve() },
    stepEntered: () => stepEntered.promise,
    releaseStep: () => { stepRelease.resolve() },
    releaseHeldTurn: () => { fs.writeFileSync(heldTurnRelease, "") },
    chatRequests: () => chatRequests,
    continuedChatRequests: () => continuedChatRequests,
    stepRequests: () => stepRequests,
    continuedStepRequests: () => continuedStepRequests,
    /** Arms the next case: every hold is armed again and the counters restart. */
    reset: () => {
      chatRelease = Promise.withResolvers<void>()
      chatEntered = Promise.withResolvers<void>()
      stepRelease = Promise.withResolvers<void>()
      stepEntered = Promise.withResolvers<void>()
      heldTurnRelease = path.join(TMP, `held-shell-${crypto.randomUUID()}`)
      chatRequests = 0
      continuedChatRequests = 0
      stepRequests = 0
      continuedStepRequests = 0
    },
    stop: () => { server.stop(true) },
  }
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
    ...[...roles].flatMap((role) => [`[profiles.default.roles.${JSON.stringify(role)}]`, `model = ${JSON.stringify(MODEL)}`, 'effort = "low"', ""]),
  ].join("\n"))
  fs.writeFileSync(path.join(authDirectory, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "fixture-placeholder-key" } }), { mode: 0o600 })
}

/** The build the serve fixture reads as the account's installed build. */
function setInstalledBuild(buildId: string, version: string): void {
  fs.writeFileSync(buildFile, JSON.stringify({ buildId, version }))
}

/** The cutover intent a newer installed client sends before it attaches. */
function requestCutover(): Promise<"busy" | "retiring"> {
  const socketPath = accountServeSocketPath(userDataRoot, LANE)
  const credential = fs.readFileSync(accountServeTokenPath(userDataRoot, LANE), "utf8").trim()
  const reader = createAccountAttachResponseReader()
  const preface = new TextEncoder().encode(encodeAccountAttach({ intent: "cutover", credential }))
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (socket: { end(): void } | undefined, result?: "busy" | "retiring", error?: unknown): void => {
      if (settled) return
      settled = true
      socket?.end()
      if (error !== undefined) reject(error)
      else if (result !== undefined) resolve(result)
      else reject(new Error("The account service closed before it answered the cutover request"))
    }
    void Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) { socket.write(preface) },
        data(socket, chunk) {
          const result = reader.push(chunk)
          if (result.kind === "busy" || result.kind === "retiring") finish(socket, result.kind)
          else if (result.kind === "failed") finish(socket, undefined, new Error(result.error))
        },
        error(socket, error) { finish(socket, undefined, error) },
        close() { finish(undefined) },
      },
    }).catch((error: unknown) => { finish(undefined, undefined, error) })
  })
}

async function until<T>(label: string, read: () => Promise<T>, accept: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + STEP_MS
  let last: T | undefined
  for (;;) {
    last = await read()
    if (accept(last)) return last
    if (Date.now() > deadline) throw new Error(`${label} did not happen within ${STEP_MS}ms; last: ${JSON.stringify(last)}`)
    await Bun.sleep(50)
  }
}

/** The session's row with its admitted actions as one list, whatever its kind. */
async function sessionRow(client: RuntimeClient, sessionId: string): Promise<{ readonly lifecycleState: string; readonly admittedActions: readonly string[] }> {
  const row = (await client.query({ type: "sessionDetail", sessionId })).view?.row
  if (!row) throw new Error(`session ${sessionId} has no row`)
  return { lifecycleState: row.lifecycleState, admittedActions: row.admittedActions ?? [] }
}

/** The workflow as a client reads it: its committed state, or running while
 *  its view has not loaded that state. */
async function workflowState(client: RuntimeClient, workflowId: string) {
  const view = (await client.query({ type: "workflowDetail", workflowId })).view
  if (!view) throw new Error(`workflow ${workflowId} has no detail`)
  const attempts = (await client.query({ type: "workflowViewSnapshot", workflowId })).view?.attempts
  const member = attempts?.find((attempt) => attempt.sessionId !== undefined)?.sessionId
  const memberLifecycleState = member ? (await sessionRow(client, member)).lifecycleState : undefined
  return { state: view.workflowState, admittedActions: view.admittedActions, memberLifecycleState, ...(view.workflowState === "failed" ? { attempts } : {}) }
}

async function sessionStatus(client: RuntimeClient, sessionId: string) {
  return (await client.query({ type: "statusSnapshot", sessionIds: [sessionId] })).views[0]?.view ?? null
}

/** The system rows of the session's transcript tail, as any client reads them. */
async function systemRows(client: RuntimeClient, sessionId: string): Promise<string[]> {
  const window = await client.query({ type: "outputWindow", sessionId, request: { range: { anchor: { kind: "tail" }, maxBlocks: 64, maxBytes: 256_000 } } })
  if (window.range.kind !== "ok") return []
  return window.range.blocks.flatMap((block: FrontendOutputBlock) => block.kind === "system" ? [block.message] : [])
}

/** Opens a chat, sends the fixture task, and waits until its request is held. */
async function startHeldChat(client: RuntimeClient, provider: ReturnType<typeof startProvider>): Promise<string> {
  const opened = await client.dispatch({ type: "chat.open" })
  if (!opened.ok || !opened.sessionId) throw new Error("chat did not open")
  expect(await client.dispatch({ type: "session.send", sessionId: opened.sessionId, input: CHAT_TASK })).toMatchObject({ ok: true })
  await provider.chatEntered()
  await until("chat turn running", () => sessionStatus(client, opened.sessionId ?? ""), (status) => status?.activity === "waiting" || status?.activity === "generating")
  return opened.sessionId
}

/** A chat launches a fixture file and waits until its first step's request is held. */
async function startHeldWorkflow(client: RuntimeClient, provider: ReturnType<typeof startProvider>): Promise<string> {
  const opened = await client.dispatch({ type: "chat.open" })
  if (!opened.ok || !opened.sessionId) throw new Error("workflow parent did not open")
  const parentSessionId = opened.sessionId
  expect(await client.dispatch({ type: "session.send", sessionId: parentSessionId, input: WORKFLOW_LAUNCH })).toMatchObject({ ok: true })
  await provider.stepEntered()
  const sessionId = await until("workflow child", async () => {
    const window = await client.query({ type: "outputWindow", sessionId: parentSessionId, request: { range: { anchor: { kind: "tail" }, maxBlocks: 64, maxBytes: 256_000 } } })
    if (window.range.kind !== "ok") return undefined
    return window.range.blocks.find((block) => block.kind === "agentGroup")?.linkUri?.slice("flywheel://workflow/".length)
  }, (id) => id !== undefined)
  if (!sessionId) throw new Error("workflow child has no card")
  await until("workflow step running", () => workflowState(client, sessionId), (view) => view.admittedActions.includes("workflow.interrupt"))
  return sessionId
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

/** Attaches to a service that is not running yet, as a product client does:
 *  the client subscribes, and reads only once its first lane opens, the one
 *  seed trigger (ARCH-PROTOCOL-014). The attach starts the service, and the service
 *  opens and recovers the project before the lane opens. Under load that
 *  takes longer than the deadline of a best-effort read, so a read sent
 *  before the lane fails with RuntimeCallTimeout. */
async function attachColdProject() {
  const attached = await attachAccountProject({ accountHome, userDataRoot, executionCwd: project, projectRoot: project })
  const laneOpened = new Promise<void>((resolve) => { attached.client.onLane(() => { resolve() }) })
  // The subscription opens the lane and ends when the client closes.
  attached.client.subscribe(() => {})
  await laneOpened
  return attached
}

/** How many sessions of the project hold a row a planned replacement left
 *  for its successor: a command to adopt or a turn to continue. */
function successorRows(): number {
  // The successor's processes open and close the store while this reads it.
  return readStoreFile(resolveEventStoreDbFile(project), (reader) =>
    reader.sessionsWithInFlight(COMMAND_HANDOVER_IN_FLIGHT_KIND).length + reader.sessionsWithInFlight(PLANNED_SESSION_CONTINUATION_IN_FLIGHT_KIND).length)
}

/** Starts a shell command that waits for the test in a chat of its own, and
 *  waits until it runs. */
async function startHeldShell(client: RuntimeClient): Promise<void> {
  const opened = await client.dispatch({ type: "chat.open" })
  if (!opened.ok || !opened.sessionId) throw new Error("held chat did not open")
  expect(await client.dispatch({ type: "session.send", sessionId: opened.sessionId, input: HELD_TURN })).toMatchObject({ ok: true })
  await until("held shell command running", () => sessionStatus(client, opened.sessionId ?? ""), (status) => (status?.activeForegroundBashToolCallIds.length ?? 0) > 0)
}

/** Lets the handed-over shell command end, and starts the next service as
 *  its service manager does, with no client attached. That service consumes
 *  what the replacement left: it settles the command, whose supervisor has
 *  exited with it, and continues the held chat's cut turn. */
async function consumeHandover(provider: ReturnType<typeof startProvider>): Promise<void> {
  provider.releaseHeldTurn()
  await startIsolatedAccountService({ accountHome, userDataRoot, executionCwd: project, projectRoot: project })
  await until("the replacement's rows consumed", () => Promise.resolve(successorRows()), (rows) => rows === 0)
}

/** Ends the account service the way a crash or `kill -9` does: no signal
 *  handler, no interrupt record, no lifecycle publication. The executor and everything
 *  under it die first so nothing can record the exit, then the service before
 *  it can react to the executor's death. The identity record is cleared the
 *  way the graceful stop clears it, so the next attach starts a fresh service
 *  instead of reading a dead pid. */
async function killAccountServiceUncleanly(): Promise<void> {
  const identity = readRuntimeIdentity(accountServeRecordPath(userDataRoot, LANE))
  if (!identity) throw new Error("no account service identity record to kill")
  for (const pid of [...(await descendantProcesses(identity.pid)).map((row) => row.pid).toReversed(), identity.pid]) {
    try {
      process.kill(pid, "SIGKILL")
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) throw cause
    }
  }
  await joinIsolatedAccountService(userDataRoot)
  fs.rmSync(accountServeRecordPath(userDataRoot, LANE), { force: true })
}

const provider = startProvider()

afterAll(async () => {
  await stopAccountService()
  provider.stop()
  delete process.env.FLYWHEEL_TEST_INSTALLED_BUILD_FILE
  if (!process.env.FW_KEEP_TMP) fs.rmSync(TMP, { recursive: true, force: true })
}, 60_000)

describe("chat interrupt and resume", () => {
  test("a person interrupts a running turn, the session says who interrupted it, resume finishes the turn exactly once, and neither the chat nor a running shell command delays a replacement", async () => {
    fs.mkdirSync(userDataRoot, { recursive: true })
    fs.mkdirSync(path.join(project, ".git"), { recursive: true })
    writeAccountConfig(provider.port)
    setInstalledBuild("build-old", "0.9.0")
    process.env.FLYWHEEL_TEST_INSTALLED_BUILD_FILE = buildFile

    const attached = await attachAccountProject({ accountHome, userDataRoot, executionCwd: project, projectRoot: project })
    const client = attached.client
    try {
      const chat = await startHeldChat(client, provider)
      expect(provider.chatRequests()).toBe(1)

      // Interrupt cuts the held request, the parked runner records the turn's
      // end as interrupted by a person, and the session stays live and idle.
      expect(await client.dispatch({ type: "chat.interrupt", sessionId: chat })).toMatchObject({ ok: true })
      // The active row keeps admitting Interrupt: whether a turn runs is live
      // status, and each client shows the control only while it does.
      await until("chat interrupted", () => sessionRow(client, chat), (row) => row.admittedActions.includes("chat.resume"))
      await until("interrupted row in the transcript", () => systemRows(client, chat), (rows) => rows.includes("Interrupted"))
      expect(provider.chatRequests()).toBe(1)

      // Resume authorizes the parked runner with no new message.
      expect(await client.dispatch({ type: "chat.resume", sessionId: chat })).toMatchObject({ ok: true })
      await until("continued request", () => Promise.resolve(provider.chatRequests()), (count) => count === 2)
      expect(provider.continuedChatRequests()).toBe(1)
      provider.releaseChat()
      await until("turn finished", () => sessionStatus(client, chat), (status) => status?.activity === "idle")
      const finished = await sessionRow(client, chat)
      expect(finished.admittedActions).not.toContain("chat.resume")
      const rows = await systemRows(client, chat)
      expect(rows).toContain("Interrupted")
      expect(rows).toContain("Resumed")
      expect(provider.chatRequests()).toBe(2)

      // Neither the chat a person interrupted nor a shell command that still
      // runs in another chat delays a replacement: the cutover answers at
      // once, and the stop hands the command to the next build.
      await startHeldShell(client)
      setInstalledBuild("build-new", "1.0.0")
      expect(await requestCutover()).toBe("retiring")
      await until("service withdrawn", () => isRuntimeListening(accountServeSocketPath(userDataRoot, LANE)), (listening) => !listening)
      await joinIsolatedAccountService(userDataRoot)
    } finally {
      await attached.dispose()
    }
    await consumeHandover(provider)
    // The next build continues the cut shell turn and never the finished chat.
    expect(provider.chatRequests()).toBe(2)
  }, 180_000)

  test("an interrupt survives a service restart as a person's interrupt, not an exit, and resumes once", async () => {
    provider.reset()
    // The dev-lane service of the first case retires once its last client
    // leaves; a fresh one serves this case from the start.
    await stopAccountService()
    const first = await attachAccountProject({ accountHome, userDataRoot, executionCwd: project, projectRoot: project })
    let chat: string
    try {
      chat = await startHeldChat(first.client, provider)
      expect(await first.client.dispatch({ type: "chat.interrupt", sessionId: chat })).toMatchObject({ ok: true })
      await until("chat interrupted", () => sessionRow(first.client, chat), (row) => row.admittedActions.includes("chat.resume"))
    } finally {
      await first.dispose()
    }
    await stopAccountService()

    const second = await attachColdProject()
    const client = second.client
    try {
      // Recovery left the interrupted turn alone, and the shutdown recorded no
      // second interruption over the person's: the row still admits resume and
      // the transcript says a person interrupted it.
      const recovered = await until("interrupted chat reopened", () => sessionRow(client, chat), (row) => row.admittedActions.includes("chat.resume"))
      expect(recovered.lifecycleState).toBe("inactive")
      const rows = await systemRows(client, chat)
      expect(rows).toContain("Interrupted")
      expect(rows).not.toContain("Interrupted by the runtime")
      expect(rows).not.toContain("Interrupted by an unexpected exit")

      expect(await client.dispatch({ type: "chat.resume", sessionId: chat })).toMatchObject({ ok: true })
      provider.releaseChat()
      await until("turn finished", () => sessionStatus(client, chat), (status) => status?.activity === "idle")
      // The held request before the restart, then exactly one continued request.
      expect(provider.chatRequests()).toBe(2)
      expect(provider.continuedChatRequests()).toBe(1)
      expect((await sessionRow(client, chat)).admittedActions).not.toContain("chat.resume")
    } finally {
      await second.dispose()
    }
  }, 180_000)

  test("resume works after the service and its executor die by SIGKILL: the chat reads interrupted by the exit, and resumes once", async () => {
    provider.reset()
    await stopAccountService()
    const first = await attachAccountProject({ accountHome, userDataRoot, executionCwd: project, projectRoot: project })
    let chat: string
    try {
      chat = await startHeldChat(first.client, provider)
      // The kill lands while the client still holds the chat open and its
      // request is still held: nothing graceful runs before it.
      await killAccountServiceUncleanly()
    } finally {
      await first.dispose()
    }

    const second = await attachColdProject()
    const client = second.client
    try {
      const recovered = await until("chat interrupted by the exit", () => sessionRow(client, chat), (row) => row.lifecycleState === "inactive" && (row.admittedActions ?? []).includes("chat.resume"))
      // Inactive after the exit: no Interrupt until a runner is attached again.
      expect(recovered.admittedActions).not.toContain("chat.interrupt")
      const rows = await until("exit row in the transcript", () => systemRows(client, chat), (candidate) => candidate.includes("Interrupted by an unexpected exit"))
      expect(rows).not.toContain("Interrupted by the runtime")

      expect(await client.dispatch({ type: "chat.resume", sessionId: chat })).toMatchObject({ ok: true })
      provider.releaseChat()
      await until("turn finished", () => sessionStatus(client, chat), (status) => status?.activity === "idle")
      // The request the kill cut, then exactly one continued request.
      expect(provider.chatRequests()).toBe(2)
      expect(provider.continuedChatRequests()).toBe(1)
      expect((await sessionRow(client, chat)).admittedActions).not.toContain("chat.resume")
      expect(await systemRows(client, chat)).toContain("Resumed")
    } finally {
      await second.dispose()
    }
  }, 180_000)
})

describe("workflow interrupt and resume", () => {
  test("interrupt cuts the running step at once and leaves the workflow live and idle; resume with no message continues the step in its own conversation and completes the workflow", async () => {
    provider.reset()
    await stopAccountService()
    const attached = await attachAccountProject({ accountHome, userDataRoot, executionCwd: project, projectRoot: project })
    const client = attached.client
    try {
      const workflow = await startHeldWorkflow(client, provider)
      expect(provider.stepRequests()).toBe(1)

      // Interrupt does not wait for the held step: the step's worker parks in
      // its attempt, records the turn end in the step's conversation, and the
      // workflow stays live while the provider still holds the request.
      expect(await client.dispatch({ type: "workflow.interrupt", workflowId: workflow })).toMatchObject({ kind: "interrupt", interrupted: true })
      const interrupted = await until("workflow interrupted", () => workflowState(client, workflow), (view) => view.admittedActions.includes("workflow.resume"))
      expect(interrupted.memberLifecycleState).toBe("active")
      expect(interrupted.state).not.toBe("completed")

      expect(await client.dispatch({ type: "workflow.resume", workflowId: workflow })).toMatchObject({ ok: true })
      await until("continued step request", () => Promise.resolve(provider.stepRequests()), (count) => count === 2)
      provider.releaseStep()
      const completed = await until("workflow completed", () => workflowState(client, workflow), (view) => view.state === "completed")
      expect(completed.admittedActions).not.toContain("workflow.resume")
      // The held request the interrupt cut, then the one the same attempt
      // made after Resume, carrying the continuation Resume recorded.
      expect(provider.stepRequests()).toBe(2)
      expect(provider.continuedStepRequests()).toBe(1)
    } finally {
      await attached.dispose()
    }
  }, 180_000)

  test("resume with no message recovers a workflow whose service and executor died by SIGKILL mid-step, and completes it once", async () => {
    provider.reset()
    await stopAccountService()
    const first = await attachAccountProject({ accountHome, userDataRoot, executionCwd: project, projectRoot: project })
    let workflow: string
    try {
      workflow = await startHeldWorkflow(first.client, provider)
      await killAccountServiceUncleanly()
    } finally {
      await first.dispose()
    }

    const second = await attachColdProject()
    const client = second.client
    try {
      const recovered = await until("workflow interrupted by the exit", () => workflowState(client, workflow), (view) => view.memberLifecycleState === "inactive" && view.admittedActions.includes("workflow.resume"))
      expect(recovered.state).not.toBe("completed")

      expect(await client.dispatch({ type: "workflow.resume", workflowId: workflow })).toMatchObject({ ok: true })
      await until("workflow running again", () => workflowState(client, workflow), (view) => view.admittedActions.includes("workflow.interrupt"))
      provider.releaseStep()
      const completed = await until("workflow completed", () => workflowState(client, workflow), (view) => view.state === "completed")
      expect(completed.admittedActions).not.toContain("workflow.resume")
      // The request the kill cut, then the one the recovered attempt made.
      expect(provider.stepRequests()).toBe(2)
    } finally {
      await second.dispose()
    }
  }, 180_000)
})
