import { afterAll, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"

import { isRuntimeListening, readRuntimeIdentity } from "../../../src/cli/runtime-attach.js"
import { serveLaneFor } from "../../../src/infra/cli-subprocess.js"
import { accountServeRecordPath, accountServeSocketPath, accountServeTokenPath, resolveEventStoreDbFile } from "../../../src/infra/paths.js"
import { openReadonlyEventReader } from "../../../src/infra/sqlite-event-store.js"
import { loadSubagentRunsFromEvents, SUBAGENT_RUN_FACT_TYPES } from "../../../src/orchestration/modules/subagents/history/subagent-run-projection.js"
import { COMMAND_HANDOVER_IN_FLIGHT_KIND } from "../../../src/orchestration/session/command-handover.js"
import { PLANNED_SESSION_CONTINUATION_IN_FLIGHT_KIND } from "../../../src/orchestration/session/planned-session-continuation.js"
import { createAccountAttachResponseReader, encodeAccountAttach } from "../../../src/protocol/account-attach.js"
import type { FrontendOutputBlock, RuntimeClient } from "../../../src/protocol/app-service-types.js"
import { defaultRoleSlots } from "../../../src/orchestration/config/role-selection.js"
import { ROLE_MODEL_DEFAULTS } from "../../../src/orchestration/config/role-model-defaults.js"
import { attachAccountProject, joinIsolatedAccountService, startIsolatedAccountService } from "./_account-service.js"
import { descendantProcesses } from "../../helpers/real-process-fixture.js"
import { socketTemporaryRoot } from "../../helpers/directories.js"

// The isolated account service is started through this process's bun, so it serves this process's lane.
const LANE = serveLaneFor(process.execPath)

// Canonical, because the service address is a hash of the account data root
// string, and `/tmp` is a symlink on macOS.
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(socketTemporaryRoot(), "fw-subagent-interrupt-resume-")))
const accountHome = path.join(TMP, "home")
const userDataRoot = path.join(accountHome, ".flywheel")
const project = path.join(TMP, "project")
const buildFile = path.join(TMP, "installed-build.json")
const MODEL = "gpt-5"
const DISPATCH_CALL_ID = "dispatch-1"
const HANDOFF_CALL_ID = "handoff-1"
const PARENT_TASK = "Delegate the fixture task to an explorer"
const CHILD_TASK = "CHILD-FIXTURE-TASK: read nothing and hand off at once"
const HELD_TURN = "Hold this turn open"
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

/** The user turns of the conversation. The system prompt names every tool
 *  and notification tag, and the parent's dispatch call carries the child's
 *  prompt in its arguments, so only user-role text can tell the turns apart. */
function userText(body: unknown): string {
  if (typeof body !== "object" || body === null || !("messages" in body) || !Array.isArray(body.messages)) return ""
  return JSON.stringify(body.messages.filter((message: unknown) => typeof message === "object" && message !== null && "role" in message && message.role === "user"))
}

function hasToolResult(body: unknown, toolCallId: string): boolean {
  if (typeof body !== "object" || body === null || !("messages" in body) || !Array.isArray(body.messages)) return false
  return body.messages.some((message: unknown) => typeof message === "object" && message !== null
    && "role" in message && message.role === "tool" && "tool_call_id" in message && message.tool_call_id === toolCallId)
}

function toolCallDelta(id: string, name: string, args: SseData, content?: string): SseData {
  return { ...(content === undefined ? {} : { content }), tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }
}

/** The one provider every session of the project talks to. A parent turn
 *  that carries the parent task dispatches an explorer child whose prompt
 *  carries the child task; the child's request is held until the test
 *  releases it, so the child can be paused mid-request and resumed into the
 *  same held request. The parent's next turn parks on `process wait`, and
 *  the turn after the completion notification finishes. A turn that carries
 *  the held-turn text runs a shell command that waits for the test, which a
 *  replacement hands to the next build. Every request without tools (a
 *  title) answers at once. */
function startProvider() {
  let childRelease = Promise.withResolvers<void>()
  let childEntered = Promise.withResolvers<void>()
  // The held turn runs a foreground shell command that waits for this file.
  let heldTurnRelease = path.join(TMP, `held-shell-${crypto.randomUUID()}`)
  let childRequests = 0
  let notificationRequests = 0
  let interruptNotices = 0
  let waitCalls = 0
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
      // A request without tools is a title request; a well-formed title
      // keeps the title generator from retrying for the whole run.
      let delta: SseData = { content: "TITLE: Fixture session\nSHORT: Fixture" }
      let finishReason = "stop"
      if (requestHasTools(body) && text.includes(CHILD_TASK)) {
        childRequests += 1
        childEntered.resolve()
        await childRelease.promise
        if (hasToolResult(body, HANDOFF_CALL_ID)) {
          delta = { content: "Child finished." }
        } else {
          delta = toolCallDelta(HANDOFF_CALL_ID, "handoff", { summary: "Child finished the fixture task." })
          finishReason = "tool_calls"
        }
      } else if (requestHasTools(body) && text.includes(HELD_TURN)) {
        if (hasToolResult(body, HELD_SHELL_CALL_ID)) {
          delta = { content: "Held turn finished." }
        } else {
          delta = toolCallDelta(HELD_SHELL_CALL_ID, "bash", { command: `while [ ! -e ${JSON.stringify(heldTurnRelease)} ]; do sleep 0.05; done` })
          finishReason = "tool_calls"
        }
      } else if (requestHasTools(body) && text.includes("subagent_notifications")) {
        notificationRequests += 1
        delta = { content: "Parent finished." }
      } else if (requestHasTools(body) && text.includes("child_interrupted_notification")) {
        // Only the runtime's interrupt reaches the parent as a notice (PI-AGENT-025); a person's interrupt must not.
        interruptNotices += 1
        delta = { content: "Parent left the interrupted child." }
      } else if (requestHasTools(body) && hasToolResult(body, DISPATCH_CALL_ID)) {
        // Every wait call carries a fresh id: the parent's conversation
        // rejects a repeated tool use id.
        waitCalls += 1
        delta = toolCallDelta(`wait-${waitCalls}`, "process", { action: "wait" })
        finishReason = "tool_calls"
      } else if (requestHasTools(body) && text.includes(PARENT_TASK)) {
        delta = toolCallDelta(DISPATCH_CALL_ID, "subagent", {
          persona: "explorer",
          description: "Fixture child",
          rationale: "The fixture proves pause and resume on a real child session.",
          prompt: CHILD_TASK,
        }, "Delegating the fixture task.")
        finishReason = "tool_calls"
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
    childEntered: () => childEntered.promise,
    releaseChild: () => { childRelease.resolve() },
    releaseHeldTurn: () => { fs.writeFileSync(heldTurnRelease, "") },
    childRequests: () => childRequests,
    notificationRequests: () => notificationRequests,
    interruptNotices: () => interruptNotices,
    /** Arms the next case: the child is held again and the counters restart. */
    reset: () => {
      childRelease = Promise.withResolvers<void>()
      childEntered = Promise.withResolvers<void>()
      heldTurnRelease = path.join(TMP, `held-shell-${crypto.randomUUID()}`)
      childRequests = 0
      notificationRequests = 0
      interruptNotices = 0
      waitCalls = 0
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
    ...[...roles].flatMap((role) => [`[roles.${JSON.stringify(role)}]`, `model = ${JSON.stringify(MODEL)}`, 'effort = "low"', ""]),
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

async function childRow(client: RuntimeClient, sessionId: string) {
  const row = (await client.query({ type: "sessionDetail", sessionId })).view?.row
  if (row?.kind !== "subagent") throw new Error(`session ${sessionId} is not a child row`)
  return row
}

async function parentStatus(client: RuntimeClient, sessionId: string) {
  return (await client.query({ type: "statusSnapshot", sessionIds: [sessionId] })).views[0]?.view ?? null
}

async function parentCard(client: RuntimeClient, sessionId: string): Promise<Extract<FrontendOutputBlock, { kind: "agentGroup" }> | undefined> {
  const window = await client.query({ type: "outputWindow", sessionId, request: { range: { anchor: { kind: "tail" }, maxBlocks: 64, maxBytes: 256_000 } } })
  if (window.range.kind !== "ok") return undefined
  return window.range.blocks.find((block): block is Extract<FrontendOutputBlock, { kind: "agentGroup" }> => block.kind === "agentGroup")
}

/** Opens a parent chat, dispatches the fixture child, and waits until the
 *  child's first request is held on the provider and the parent is parked. */
async function dispatchHeldChild(client: RuntimeClient, provider: ReturnType<typeof startProvider>) {
  const opened = await client.dispatch({ type: "chat.open" })
  if (!opened.ok || !opened.sessionId) throw new Error("parent chat did not open")
  const parent = opened.sessionId
  expect(await client.dispatch({ type: "session.send", sessionId: parent, input: PARENT_TASK })).toMatchObject({ ok: true })
  // A child is reached from its card in the parent transcript (PI-INTERACTION-040).
  const link = await until("child card", async () => (await parentCard(client, parent))?.linkUri, (uri) => uri !== undefined && uri.startsWith("flywheel://session/"))
  const child = link?.slice("flywheel://session/".length)
  if (!child) throw new Error("no child session")
  await provider.childEntered()
  await until("parent parked on its child", () => parentStatus(client, parent), (status) => status?.waitingOnBackgroundWork === true)
  return { parent, child }
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

/** How many sessions of the project hold a row a planned replacement left
 *  for its successor: a command to adopt or a turn to continue. */
function successorRows(): number {
  const reader = openReadonlyEventReader(resolveEventStoreDbFile(project))
  try {
    return reader.sessionsWithInFlight(COMMAND_HANDOVER_IN_FLIGHT_KIND).length + reader.sessionsWithInFlight(PLANNED_SESSION_CONTINUATION_IN_FLIGHT_KIND).length
  } finally {
    reader.close()
  }
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
 *  handler, no planned suspension, no lifecycle publication. The executor and
 *  everything under it die first so nothing can record the exit, then the
 *  service before it can react to the executor's death. The identity record
 *  is cleared the way the graceful stop clears it, so the next attach starts
 *  a fresh service instead of reading a dead pid. */
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

/** Resumes `child` the way a person does after a restart: from the parent's
 *  transcript, so the parent is open first. Opening the parent attaches its
 *  runner without starting a turn (ARCH-SESSIONS-038), the child then runs as the
 *  parent's background work (PI-AGENT-020), and its completion wakes the shown,
 *  idle parent for exactly one turn. */
async function resumeUnderShownParent(client: RuntimeClient, parent: string, child: string, provider: ReturnType<typeof startProvider>): Promise<void> {
  expect(await client.dispatch({ type: "session.activate", sessionId: parent })).toMatchObject({ ok: true })
  await Bun.sleep(500)
  expect(provider.notificationRequests()).toBe(0)
  expect(await client.dispatch({ type: "subagent.resume", sessionId: child })).toMatchObject({ ok: true })
  await until("child resumed", () => childRow(client, child), (row) => row.lifecycleState === "active")
  provider.releaseChild()
  const finished = await until("child completed", () => childRow(client, child), (row) => row.lifecycleState === "inactive")
  expect(finished.admittedActions).toEqual(["session.delete"])
  await until("parent received exactly one completion", () => Promise.resolve(provider.notificationRequests()), (count) => count >= 1)
  await until("parent finished", () => parentStatus(client, parent), (status) => status?.activity === "idle" && status.waitingOnBackgroundWork === false)
  expect(provider.notificationRequests()).toBe(1)
  expect(await parentCard(client, parent)).toMatchObject({ status: "completed" })
}

/** The child's latest run as the project store records it. */
function durableChildRun(childSessionId: string) {
  const reader = openReadonlyEventReader(resolveEventStoreDbFile(project))
  try {
    return loadSubagentRunsFromEvents(reader.read({ aggregateId: `session:${childSessionId}`, types: SUBAGENT_RUN_FACT_TYPES })).at(-1)
  } finally {
    reader.close()
  }
}

const provider = startProvider()

afterAll(async () => {
  await stopAccountService()
  provider.stop()
  delete process.env.FLYWHEEL_TEST_INSTALLED_BUILD_FILE
  if (!process.env.FW_KEEP_TMP) fs.rmSync(TMP, { recursive: true, force: true })
}, 60_000)

describe("subagent interrupt and resume", () => {
  test("a person interrupts a running child, the parent keeps waiting on it without a notice, resume completes it exactly once, and neither the child nor a running shell command delays a replacement", async () => {
    fs.mkdirSync(userDataRoot, { recursive: true })
    fs.mkdirSync(path.join(project, ".git"), { recursive: true })
    writeAccountConfig(provider.port)
    setInstalledBuild("build-old", "0.9.0")
    process.env.FLYWHEEL_TEST_INSTALLED_BUILD_FILE = buildFile

    const attached = await attachAccountProject({ accountHome, userDataRoot, executionCwd: project, projectRoot: project })
    const client = attached.client
    try {
      const { parent, child } = await dispatchHeldChild(client, provider)
      const running = await childRow(client, child)
      expect(running.admittedActions).toContain("subagent.interrupt")
      expect(running.admittedActions).toContain("background.terminate")
      expect(running.admittedActions).not.toContain("chat.interrupt")

      // Interrupt cuts the held request and settles the run as interrupted by
      // a person; the saved run status keeps its `paused` name.
      expect(await client.dispatch({ type: "subagent.interrupt", sessionId: child })).toMatchObject({ ok: true })
      const paused = await until("child interrupted", () => childRow(client, child), (row) => row.lifecycleState === "inactive")
      expect(paused.admittedActions).toContain("subagent.resume")
      expect(paused.admittedActions).not.toContain("subagent.interrupt")
      // The parent's call has no result yet, so the interrupted child keeps
      // its own Stop.
      expect(paused.admittedActions).toContain("background.terminate")
      // A person's message to the interrupted child resumes it.
      expect(paused.admittedActions).toContain("session.send")
      const pausedCard = await until("parent card interrupted", () => parentCard(client, parent), (card) => card?.status === "paused")
      expect(pausedCard).toMatchObject({ status: "paused", pausedBy: "person" })
      // A person's interrupt does not change what the parent waits on: no
      // notice reaches it, and no completion either (PI-INTERACTION-137, PI-AGENT-025).
      expect(provider.interruptNotices()).toBe(0)
      expect(provider.notificationRequests()).toBe(0)

      // Resume continues the child from its recorded context; the provider then answers it.
      expect(await client.dispatch({ type: "subagent.resume", sessionId: child })).toMatchObject({ ok: true })
      await until("child resumed", () => childRow(client, child), (row) => row.lifecycleState === "active")
      provider.releaseChild()
      const finished = await until("child completed", () => childRow(client, child), (row) => row.lifecycleState === "inactive")
      expect(finished.admittedActions).toEqual(["session.delete"])
      // The completion ends the parent's wait for one turn.
      await until("parent received exactly one completion", () => Promise.resolve(provider.notificationRequests()), (count) => count === 1)
      await until("parent finished", () => parentStatus(client, parent), (status) => status?.activity === "idle" && status.waitingOnBackgroundWork === false)
      expect(provider.notificationRequests()).toBe(1)
      expect(await parentCard(client, parent)).toMatchObject({ status: "completed" })

      // Neither the child a person interrupted nor a shell command that
      // still runs in another chat delays a replacement: the cutover answers
      // at once, and the stop hands the command to the next build.
      const openedHeld = await client.dispatch({ type: "chat.open" })
      if (!openedHeld.ok || !openedHeld.sessionId) throw new Error("held chat did not open")
      expect(await client.dispatch({ type: "session.send", sessionId: openedHeld.sessionId, input: HELD_TURN })).toMatchObject({ ok: true })
      await until("held shell command running", () => parentStatus(client, openedHeld.sessionId ?? ""), (status) => (status?.activeForegroundBashToolCallIds.length ?? 0) > 0)
      setInstalledBuild("build-new", "1.0.0")
      expect(await requestCutover()).toBe("retiring")
      await until("service withdrawn", () => isRuntimeListening(accountServeSocketPath(userDataRoot, LANE)), (listening) => !listening)
      await joinIsolatedAccountService(userDataRoot)
    } finally {
      await attached.dispose()
    }
    await consumeHandover(provider)
    // The next build continues the cut shell turn and never the completed child.
    expect(provider.childRequests()).toBe(2)
    expect(provider.notificationRequests()).toBe(1)
  }, 180_000)

  test("an interrupt survives a service restart as a person's interrupt, not an exit, and resumes once under its reopened parent", async () => {
    provider.reset()
    // The dev-lane service of the first case retires once its last client
    // leaves; a fresh one serves this case from the start.
    await stopAccountService()
    const first = await attachAccountProject({ accountHome, userDataRoot, executionCwd: project, projectRoot: project })
    let parent: string
    let child: string
    try {
      ;({ parent, child } = await dispatchHeldChild(first.client, provider))
      expect(await first.client.dispatch({ type: "subagent.interrupt", sessionId: child })).toMatchObject({ ok: true })
      await until("child interrupted", () => childRow(first.client, child), (row) => row.lifecycleState === "inactive")
    } finally {
      await first.dispose()
    }
    await stopAccountService()

    const second = await attachAccountProject({ accountHome, userDataRoot, executionCwd: project, projectRoot: project })
    const client = second.client
    try {
      // Recovery left the interrupted run alone: the row still admits resume
      // and the durable card still says a person interrupted it.
      const recovered = await childRow(client, child)
      expect(recovered.lifecycleState).toBe("inactive")
      expect(recovered.admittedActions).toContain("subagent.resume")
      expect(await parentCard(client, parent)).toMatchObject({ status: "paused", pausedBy: "person" })

      await resumeUnderShownParent(client, parent, child, provider)
    } finally {
      await second.dispose()
    }
  }, 180_000)

  test("resume works after the service and its executor die by SIGKILL: the run reads interrupted by the exit, and resumes once", async () => {
    provider.reset()
    await stopAccountService()
    const first = await attachAccountProject({ accountHome, userDataRoot, executionCwd: project, projectRoot: project })
    let parent: string
    let child: string
    try {
      ;({ parent, child } = await dispatchHeldChild(first.client, provider))
      // The kill lands while the client still holds the parent open and the
      // child's request is still held: nothing graceful runs before it.
      await killAccountServiceUncleanly()
    } finally {
      await first.dispose()
    }

    const second = await attachAccountProject({ accountHome, userDataRoot, executionCwd: project, projectRoot: project })
    const client = second.client
    try {
      // Recovery read the dead owner and interrupted the run: interrupted by
      // an unexpected exit, not by anyone, and still resumable.
      const recovered = await until("child interrupted", () => childRow(client, child), (row) => row.lifecycleState === "inactive" && row.admittedActions.includes("subagent.resume"))
      expect(recovered.admittedActions).not.toContain("subagent.interrupt")
      expect(durableChildRun(child)).toMatchObject({ status: "interrupted", interruptionReason: "runtime_restarted" })
      expect(durableChildRun(child)?.pausedBy).toBeUndefined()
      const interruptedCard = await until("parent card interrupted", () => parentCard(client, parent), (card) => card?.status === "interrupted")
      expect(interruptedCard).toMatchObject({ status: "interrupted" })
      expect(provider.notificationRequests()).toBe(0)

      await resumeUnderShownParent(client, parent, child, provider)
    } finally {
      await second.dispose()
    }
  }, 180_000)
})
