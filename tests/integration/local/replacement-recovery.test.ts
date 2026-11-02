import { afterAll, describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { isRuntimeListening, readRuntimeIdentity } from "../../../src/cli/runtime-attach.js"
import { ContainedDirectory } from "../../../src/infra/descriptor-directory.js"
import { FLYWHEEL_DIR_NAME } from "../../../src/infra/directory-authorities.js"
import { sharedHoldersIn } from "../../../src/infra/ownership-file-lock.js"
import { accountServeRecordPath, accountServeSocketPath, resolveOwnerPidPath } from "../../../src/infra/paths.js"
import { unixProcessIdentity, windowsProcessIdentity } from "../../../src/infra/process-container.js"
import { isProcessAlive } from "../../../src/infra/process-liveness.js"
import { isSessionOwnerGone } from "../../../src/orchestration/session/pid-lock.js"
import type { RuntimeClient } from "../../../src/protocol/app-service-types.js"
import { decodeServeStatusLine, type ServeStatusRecord } from "../../../src/protocol/serve-handshake.js"
import { defaultRoleSlots } from "../../../src/orchestration/config/role-selection.js"
import { ROLE_MODEL_DEFAULTS } from "../../../src/orchestration/config/role-model-defaults.js"
import { CONTINUATION_MESSAGES } from "../../../src/orchestration/agent-runtime/continuation-messages.js"
import { attachAccountProject, joinIsolatedAccountService } from "./_account-service.js"
import { LANE, requestAccountCutover, sessionRow, sessionStatus, systemRows, until } from "./_replacement-harness.js"
import { descendantProcesses } from "../../helpers/real-process-fixture.js"
import { socketTemporaryRoot } from "../../helpers/directories.js"

// Canonical, because the service address is a hash of the account data root
// string, and `/tmp` is a symlink on macOS.
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(socketTemporaryRoot(), "fw-replacement-recovery-")))
const accountHome = path.join(TMP, "home")
const userDataRoot = path.join(accountHome, ".flywheel")
const projectA = path.join(TMP, "project-a")
const projectB = path.join(TMP, "project-b")
const buildFile = path.join(TMP, "installed-build.json")
const MODEL = "gpt-5"

/** One held task per project, so the provider can hold and count each
 *  project's chat on its own. */
const CHAT_TASKS = {
  a: "CHAT-FIXTURE-A: answer when the fixture releases you",
  b: "CHAT-FIXTURE-B: answer when the fixture releases you",
} as const
type ProjectKey = keyof typeof CHAT_TASKS

/** The gate names the lease authorities write beside a project's state:
 *  `project-state-lease.ts` for the state generation and
 *  `project-serving-lane.ts` for the lane that serves the project. Both keep
 *  the name private; a test that reads the holders names the same entry. */
const GENERATION_GATE = "project-generation.lock"
const SERVING_GATE = `project-serving.${LANE}.lock`

/** POC 8, second half: process recovery across two projects. The whole run
 *  has one budget so a stalled step names itself. */
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

/** The user turns of the conversation. The system prompt names every tool,
 *  so only user-role text can tell the turns apart. */
function userText(body: unknown): string {
  if (typeof body !== "object" || body === null || !("messages" in body) || !Array.isArray(body.messages)) return ""
  return JSON.stringify(body.messages.filter((message: unknown) => typeof message === "object" && message !== null && "role" in message && message.role === "user"))
}

interface HeldChat {
  release: PromiseWithResolvers<void>
  entered: PromiseWithResolvers<void>
  requests: number
  continuedRequests: number
}

/** The one provider both projects talk to. A chat turn that carries a
 *  project's task is held until the test releases that project, so the kill
 *  lands mid-request in both projects and each resume runs into its own
 *  fresh held request. Every request without tools (a title) answers at once. */
function startProvider() {
  const heldChat = (): HeldChat => ({ release: Promise.withResolvers<void>(), entered: Promise.withResolvers<void>(), requests: 0, continuedRequests: 0 })
  const held = { a: heldChat(), b: heldChat() } satisfies { readonly [key in ProjectKey]: HeldChat }
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
      const isTurn = requestHasTools(body) && !text.includes("Generate a session title")
      const keys: readonly ProjectKey[] = ["a", "b"]
      const key = keys.find((candidate) => text.includes(CHAT_TASKS[candidate]))
      if (isTurn && key !== undefined) {
        const chat = held[key]
        chat.requests += 1
        // A resumed request carries the continuation a Resume records; the
        // first request never does.
        if (text.includes(CONTINUATION_MESSAGES.resumed)) chat.continuedRequests += 1
        chat.entered.resolve()
        await chat.release.promise
        delta = { content: `Chat ${key} finished.` }
      }
      return new Response([
        sse({ id: "fixture", object: "chat.completion.chunk", model: MODEL, choices: [{ index: 0, delta, finish_reason: null }] }),
        sse({ id: "fixture", object: "chat.completion.chunk", model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
        sse({ id: "fixture", object: "chat.completion.chunk", model: MODEL, choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }),
        "data: [DONE]\n\n",
      ].join(""), { headers: { "content-type": "text/event-stream" } })
    },
  })
  if (server.port === undefined) throw new Error("fixture provider did not bind a port")
  return {
    port: server.port,
    entered: (key: ProjectKey) => held[key].entered.promise,
    release: (key: ProjectKey) => { held[key].release.resolve() },
    requests: (key: ProjectKey) => held[key].requests,
    continuedRequests: (key: ProjectKey) => held[key].continuedRequests,
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

async function updateStatus(client: RuntimeClient) {
  return (await client.query({ type: "updateSnapshot" })).update.status
}

/** Opens a chat, sends the project's task, and waits until its request is held. */
async function startHeldChat(client: RuntimeClient, provider: ReturnType<typeof startProvider>, key: ProjectKey): Promise<string> {
  const opened = await client.dispatch({ type: "chat.open" })
  if (!opened.ok || !opened.sessionId) throw new Error(`project ${key} chat did not open`)
  expect(await client.dispatch({ type: "session.send", sessionId: opened.sessionId, input: CHAT_TASKS[key] })).toMatchObject({ ok: true })
  await provider.entered(key)
  await until(`project ${key} chat turn running`, () => sessionRow(client, opened.sessionId ?? ""), (row) => row.admittedActions.includes("chat.interrupt"))
  return opened.sessionId
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

/** The service and everything under it, from the process table. */
async function serviceTree(pid: number): Promise<readonly number[]> {
  return [pid, ...(await descendantProcesses(pid)).map((row) => row.pid)]
}

/** Ends the account service the way a crash or `kill -9` does: no signal
 *  handler, no pause, no lifecycle publication. The executor and everything
 *  under it die first so nothing can record the exit, then the service before
 *  it can react to the executor's death. The identity record is cleared the
 *  way the graceful stop clears it, so the next attach starts a fresh service
 *  instead of reading a dead pid. Returns the tree it ended. */
async function killAccountServiceUncleanly(): Promise<readonly number[]> {
  const identity = readRuntimeIdentity(accountServeRecordPath(userDataRoot, LANE))
  if (!identity) throw new Error("no account service identity record to kill")
  const tree = await serviceTree(identity.pid)
  for (const pid of tree.toReversed()) {
    try {
      process.kill(pid, "SIGKILL")
    } catch (cause) {
      if (!(cause instanceof Error && "code" in cause && cause.code === "ESRCH")) throw cause
    }
  }
  await joinIsolatedAccountService(userDataRoot)
  fs.rmSync(accountServeRecordPath(userDataRoot, LANE), { force: true })
  return tree
}

/** The live holders of one gate beside a project's state, read the way the
 *  lease authorities read them: a holder whose process is gone is swept, not
 *  counted. */
function liveHolders(projectRoot: string, gate: string): readonly number[] {
  const flywheel = ContainedDirectory.openExisting(projectRoot, [FLYWHEEL_DIR_NAME])
  if (!flywheel) return []
  try {
    return sharedHoldersIn(flywheel, gate).pids
  } finally {
    flywheel.close()
  }
}

/** The pid a session's `owner.pid` names, or undefined when there is no lock. */
function ownerPid(sessionId: string, projectRoot: string): number | undefined {
  const pidPath = resolveOwnerPidPath(sessionId, projectRoot)
  if (!fs.existsSync(pidPath)) return undefined
  const pid = Number.parseInt(fs.readFileSync(pidPath, "utf8").trim(), 10)
  return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

/** A second account service started against the same account home and lane
 *  while one already serves: the same entry the fixture starts, so it takes
 *  the same start lock and runs the same listening check. Returns its exit
 *  code and every status record it printed. */
async function startCompetingAccountService(): Promise<{ exitCode: number; records: readonly ServeStatusRecord[] }> {
  const child = Bun.spawn([
    process.execPath,
    "--conditions=browser",
    fileURLToPath(new URL("_vscode-account-service.ts", import.meta.url)),
  ], {
    cwd: projectA,
    env: { ...process.env, HOME: accountHome },
    stdout: "pipe",
    stderr: "inherit",
    windowsHide: true,
  })
  const exit = await Promise.race([child.exited, Bun.sleep(STEP_MS).then(() => undefined)])
  if (exit === undefined) {
    child.kill("SIGKILL")
    await child.exited
    throw new Error(`the competing account service neither refused nor exited within ${STEP_MS}ms`)
  }
  const stdout = await new Response(child.stdout).text()
  const records = stdout.split("\n").flatMap((line) => {
    const record = decodeServeStatusLine(line)
    return record === undefined ? [] : [record]
  })
  return { exitCode: exit, records }
}

const provider = startProvider()

afterAll(async () => {
  await stopAccountService()
  provider.stop()
  delete process.env.FLYWHEEL_TEST_INSTALLED_BUILD_FILE
  if (!process.env.FW_KEEP_TMP) fs.rmSync(TMP, { recursive: true, force: true })
}, 60_000)

describe("process recovery across two projects", () => {
  test("after a SIGKILL of the service tree with two held turns, a fresh service recovers both projects with one owner each, both chats read interrupted and resume exactly once, a competing start is refused, and an idle cutover retires", async () => {
    fs.mkdirSync(userDataRoot, { recursive: true })
    fs.mkdirSync(path.join(projectA, ".git"), { recursive: true })
    fs.mkdirSync(path.join(projectB, ".git"), { recursive: true })
    writeAccountConfig(provider.port)
    setInstalledBuild("build-old", "0.9.0")
    process.env.FLYWHEEL_TEST_INSTALLED_BUILD_FILE = buildFile

    const base = { accountHome, userDataRoot, allowPersistentProcesses: false }
    const firstA = await attachAccountProject({ ...base, executionCwd: projectA, projectRoot: projectA })
    const firstB = await attachAccountProject({ ...base, executionCwd: projectB, projectRoot: projectB })
    let chatA: string
    let chatB: string
    let predecessorTree: readonly number[]
    try {
      chatA = await startHeldChat(firstA.client, provider, "a")
      chatB = await startHeldChat(firstB.client, provider, "b")
      expect(provider.requests("a")).toBe(1)
      expect(provider.requests("b")).toBe(1)

      // Before the kill, the predecessor's tree holds both leases and both
      // sessions' owner locks, which is what makes the recovery claim below
      // more than an absence.
      const predecessor = readRuntimeIdentity(accountServeRecordPath(userDataRoot, LANE))
      if (!predecessor) throw new Error("no predecessor identity record")
      predecessorTree = await serviceTree(predecessor.pid)
      for (const [project, chat] of [[projectA, chatA], [projectB, chatB]] as const) {
        expect(liveHolders(project, SERVING_GATE)).toEqual([predecessor.pid])
        const generationHolders = liveHolders(project, GENERATION_GATE)
        expect(generationHolders.length).toBeGreaterThan(0)
        for (const pid of generationHolders) expect(predecessorTree).toContain(pid)
        const owner = ownerPid(chat, project)
        if (owner === undefined) throw new Error(`session ${chat} has no owner.pid before the kill`)
        expect(predecessorTree).toContain(owner)
        expect(isSessionOwnerGone(chat, project)).toBe(false)
      }

      // The kill lands while both clients still hold their chats open and
      // both requests are still held: nothing graceful runs before it.
      const killed = await killAccountServiceUncleanly()
      expect(killed).toEqual(predecessorTree)
    } finally {
      await Promise.allSettled([firstA.dispose(), firstB.dispose()])
    }
    // A killed descendant can stay an unreaped zombie until its new parent
    // reaps it, and signal zero still finds a zombie. The kernel identity probe
    // reads an exited, unreaped process as absent, so the claim holds without
    // waiting for a reap.
    const processIdentity = process.platform === "win32" ? windowsProcessIdentity : unixProcessIdentity
    for (const pid of predecessorTree) expect(processIdentity(pid)).toEqual({ kind: "absent" })

    const secondA = await attachAccountProject({ ...base, executionCwd: projectA, projectRoot: projectA })
    const secondB = await attachAccountProject({ ...base, executionCwd: projectB, projectRoot: projectB })
    const clientA = secondA.client
    const clientB = secondB.client
    try {
      // The client connects on its first call, and that connect is what
      // starts the successor and opens the project under it.
      await updateStatus(clientA)
      await updateStatus(clientB)

      // (1) One successor serves both projects; each project's serving claim
      // and state generation are held by the successor's tree only, and the
      // dead predecessor's entries are gone. Neither chat has a live owner:
      // the successor opened both stores without adopting the dead turns.
      const successor = readRuntimeIdentity(accountServeRecordPath(userDataRoot, LANE))
      if (!successor) throw new Error("no successor identity record")
      const successorProtocolVersion = successor.protocolVersion
      if (successorProtocolVersion === undefined) throw new Error("the successor identity record names no protocol version")
      expect(predecessorTree).not.toContain(successor.pid)
      expect(isProcessAlive(successor.pid)).toBe(true)
      for (const [project, chat, key] of [[projectA, chatA, "a"], [projectB, chatB, "b"]] as const) {
        expect(liveHolders(project, SERVING_GATE)).toEqual([successor.pid])
        // The executor registers its generation hold once it has opened the
        // store, so the tree is read beside the holders, not before them.
        const generationHolders = await until(`project ${key} generation held under the successor`, () => Promise.resolve(liveHolders(project, GENERATION_GATE)), (holders) => holders.length > 0)
        const successorTree = await serviceTree(successor.pid)
        for (const pid of generationHolders) expect(successorTree).toContain(pid)
        for (const pid of generationHolders) expect(predecessorTree).not.toContain(pid)
        expect(isSessionOwnerGone(chat, project)).toBe(true)
      }

      // (2) Both chats read interrupted by the exit, not by a person or the
      // runtime, and admit resume.
      for (const [client, chat, key] of [[clientA, chatA, "a"], [clientB, chatB, "b"]] as const) {
        const recovered = await until(`project ${key} chat interrupted by the exit`, () => sessionRow(client, chat), (row) => row.lifecycleState === "inactive" && row.admittedActions.includes("chat.resume"))
        expect(recovered.admittedActions).not.toContain("chat.interrupt")
        const rows = await until(`project ${key} exit row in the transcript`, () => systemRows(client, chat), (candidate) => candidate.includes("Interrupted by an unexpected exit"))
        expect(rows).not.toContain("Interrupted")
        expect(rows).not.toContain("Interrupted by the runtime")
        expect(provider.requests(key)).toBe(1)
      }

      // (3) Resuming both completes each turn exactly once: the request the
      // kill cut, then exactly one continued request per chat, and the
      // resumed owner lives in the successor's tree.
      for (const [client, chat, key] of [[clientA, chatA, "a"], [clientB, chatB, "b"]] as const) {
        expect(await client.dispatch({ type: "chat.resume", sessionId: chat })).toMatchObject({ ok: true })
        await until(`project ${key} continued request`, () => Promise.resolve(provider.requests(key)), (count) => count === 2)
        expect(provider.continuedRequests(key)).toBe(1)
      }
      for (const [project, chat] of [[projectA, chatA], [projectB, chatB]] as const) {
        expect(isSessionOwnerGone(chat, project)).toBe(false)
        const resumedOwner = ownerPid(chat, project)
        if (resumedOwner === undefined) throw new Error(`session ${chat} has no owner.pid after resume`)
        expect(await serviceTree(successor.pid)).toContain(resumedOwner)
      }
      provider.release("a")
      provider.release("b")
      for (const [client, chat, key] of [[clientA, chatA, "a"], [clientB, chatB, "b"]] as const) {
        await until(`project ${key} turn finished`, () => sessionStatus(client, chat), (status) => status?.activity === "idle")
        expect(provider.requests(key)).toBe(2)
        expect(provider.continuedRequests(key)).toBe(1)
        expect((await sessionRow(client, chat)).admittedActions).not.toContain("chat.resume")
        expect(await systemRows(client, chat)).toContain("Resumed")
      }

      // (4) While the successor holds both projects, a second start on the
      // same account home and lane is refused at its start lock: it names
      // the successor as the listener, exits, and opens neither project.
      const competitor = await startCompetingAccountService()
      expect(competitor.exitCode).toBe(0)
      expect(competitor.records).toContainEqual({ flywheel: "serve.already-listening", pid: successor.pid, version: successor.version, protocolVersion: successorProtocolVersion, lane: LANE })
      expect(competitor.records.some((record) => record.flywheel === "serve.listening")).toBe(false)
      expect(readRuntimeIdentity(accountServeRecordPath(userDataRoot, LANE))?.pid).toBe(successor.pid)
      const heldTree = await serviceTree(successor.pid)
      for (const project of [projectA, projectB]) {
        expect(liveHolders(project, SERVING_GATE)).toEqual([successor.pid])
        for (const pid of liveHolders(project, GENERATION_GATE)) expect(heldTree).toContain(pid)
      }

      // (5) With both chats idle, a cutover request finds nothing to hold and
      // the successor retires; the requested-replacement hold across two
      // projects is replacement-hold.test.ts's proof. The source-run service
      // names no release repository, so it has no update in play.
      expect(await updateStatus(clientA)).toMatchObject({ kind: "no-repository" })
      setInstalledBuild("build-new", "1.0.0")
      expect(await requestAccountCutover(userDataRoot)).toBe("retiring")
      await until("service withdrawn", async () => await isRuntimeListening(accountServeSocketPath(userDataRoot, LANE)), (listening) => !listening)
      await joinIsolatedAccountService(userDataRoot)
      expect(fs.existsSync(accountServeRecordPath(userDataRoot, LANE))).toBe(false)
      for (const project of [projectA, projectB]) {
        expect(liveHolders(project, SERVING_GATE)).toEqual([])
        expect(liveHolders(project, GENERATION_GATE)).toEqual([])
      }
    } finally {
      await Promise.allSettled([secondA.dispose(), secondB.dispose()])
    }
  }, 240_000)
})
