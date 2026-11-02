import { afterAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { readRuntimeIdentity } from "../../../src/cli/runtime-attach.js"
import { accountServeRecordPath, accountServeSocketPath, accountServeTokenPath } from "../../../src/infra/paths.js"
import { sweepPersistentSpools } from "../../../src/infra/persistent-spool.js"
import { createProcessTemporaryDirectory, removeProcessTemporaryDirectory } from "../../../src/infra/process-temporary-directory.js"
import { createAccountAttachResponseReader, encodeAccountAttach } from "../../../src/protocol/account-attach.js"
import { defaultRoleSlots } from "../../../src/orchestration/config/role-selection.js"
import { ROLE_MODEL_DEFAULTS } from "../../../src/orchestration/config/role-model-defaults.js"
import { stopHarnessProcesses } from "../../helpers/real-process-fixture.js"
import { socketTemporaryRoot } from "../../helpers/directories.js"

// A terminal that meets a service of its current build speaking another
// protocol replaces itself with the build that serves and comes back at the
// same place (ARCH-RUNTIME-036). On the development lane the build that serves is the
// checkout's source, so this runs a private copy of the checkout whose
// protocol constant the test raises, the way a developer's edit does. Every
// process here runs from that copy under an isolated home; the installed
// build and the account's own services are never touched.

const REPO = fileURLToPath(new URL("../../../", import.meta.url))
// Short and canonical: the service socket path has a length limit, and its
// address is a hash of the account data root string (`/tmp` is a link on macOS).
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(socketTemporaryRoot(), "fw-reexec-")))
const CHECKOUT = path.join(TMP, "c")
const HOME = path.join(TMP, "h")
const USER_DATA_ROOT = path.join(HOME, ".flywheel")
const TMUX_SOCKET = path.join(TMP, "tmux.sock")
const HUB_RECORD = path.join(TMP, "hub.json")
const PROTOCOL_FILE = path.join(CHECKOUT, "src", "protocol", "runtime-liveness.ts")
const LANE = "dev"
const MODEL = "gpt-5"
const STEP_MS = 60_000
/** One screen row of each numbered reply line, so a scroll place is a row. */
const REPLY_LINES = 60
const ALT_SCREEN_ENTER = "\u001b[?1049h"
const ALT_SCREEN_LEAVE = "\u001b[?1049l"

/** The copy runs the checkout's current source; only these trees are copied,
 *  because Bun resolves a linked source file to its real path and would load
 *  the checkout's own protocol constant through it. */
const COPIED = new Set(["src", "scripts", "bin", "package.json", "tsconfig.json", "bunfig.toml"])

function copyCheckout(): void {
  fs.mkdirSync(CHECKOUT)
  for (const entry of fs.readdirSync(REPO)) {
    if (entry === ".git" || entry === ".flywheel") continue
    const from = path.join(REPO, entry)
    const to = path.join(CHECKOUT, entry)
    if (COPIED.has(entry)) fs.cpSync(from, to, { recursive: true })
    else if (entry === "node_modules") linkPackages(from, to)
    else fs.symlinkSync(from, to)
  }
}

/** The copy's dev service runs from a snapshot of the copy, as a person's
 *  does, and only a snapshot lets a new client's cutover request find that
 *  the copy's source changed (ARCH-RUNTIME-031). The snapshot home is under
 *  `node_modules/.cache` and must sit inside the copy, so `node_modules` is
 *  a directory of the copy whose packages link to the checkout's. */
function linkPackages(from: string, to: string): void {
  fs.mkdirSync(to)
  for (const entry of fs.readdirSync(from)) {
    if (entry !== ".cache") fs.symlinkSync(path.join(from, entry), path.join(to, entry))
  }
}

function protocolVersion(): number {
  const declared = /^export const RUNTIME_PROTOCOL_VERSION = (\d+)$/m.exec(fs.readFileSync(PROTOCOL_FILE, "utf8"))?.[1]
  if (declared === undefined) throw new Error("the copy declares no protocol version")
  return Number(declared)
}

/** The edit a developer makes when the wire changes. */
function raiseProtocol(): number {
  const next = protocolVersion() + 1
  fs.writeFileSync(PROTOCOL_FILE, fs.readFileSync(PROTOCOL_FILE, "utf8").replace(/^export const RUNTIME_PROTOCOL_VERSION = \d+$/m, `export const RUNTIME_PROTOCOL_VERSION = ${next}`))
  return next
}

function writeAccountConfig(providerPort: number): void {
  const authDirectory = path.join(USER_DATA_ROOT, "auth", "profiles", "default")
  fs.mkdirSync(authDirectory, { recursive: true })
  for (const dir of [USER_DATA_ROOT, path.join(USER_DATA_ROOT, "auth"), path.join(USER_DATA_ROOT, "auth", "profiles"), authDirectory]) fs.chmodSync(dir, 0o700)
  const roles = new Set([...defaultRoleSlots().map((slot) => slot.roleId), ...Object.keys(ROLE_MODEL_DEFAULTS)])
  fs.writeFileSync(path.join(USER_DATA_ROOT, "flywheel.toml"), [
    "[custom_providers.fixture]",
    `base_url = ${JSON.stringify(`http://127.0.0.1:${providerPort}/v1`)}`,
    `models = [${JSON.stringify(MODEL)}]`,
    "",
    ...[...roles].flatMap((role) => [`[roles.${JSON.stringify(role)}]`, `model = ${JSON.stringify(MODEL)}`, 'effort = "low"', ""]),
  ].join("\n"))
  fs.writeFileSync(path.join(authDirectory, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "fixture-placeholder-key" } }), { mode: 0o600 })
}

function sse(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`
}

function answer(content: string): Response {
  return new Response([
    sse({ id: "fixture", object: "chat.completion.chunk", model: MODEL, choices: [{ index: 0, delta: { content }, finish_reason: null }] }),
    sse({ id: "fixture", object: "chat.completion.chunk", model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    sse({ id: "fixture", object: "chat.completion.chunk", model: MODEL, choices: [], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }),
    "data: [DONE]\n\n",
  ].join(""), { headers: { "content-type": "text/event-stream" } })
}

/** Answers each chat with a numbered list long enough to scroll, and titles
 *  each session by the word its first message names. */
function startProvider() {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      if (new URL(request.url).pathname.endsWith("/models")) return Response.json({ object: "list", data: [{ id: MODEL, object: "model", created: 0, owned_by: "fixture" }] })
      const body: unknown = await request.json()
      const whole = JSON.stringify(body)
      const word = /\b(alpha|bravo|charlie|delta)\b/.exec(whole)?.[1] ?? "other"
      const hasTools = typeof body === "object" && body !== null && "tools" in body && Array.isArray(body.tools) && body.tools.length > 0
      if (!hasTools || whole.includes("Generate a session title")) return answer(`TITLE: Chat ${word}\nSHORT: ${word}`)
      return answer(Array.from({ length: REPLY_LINES }, (_value, index) => `- ${word} row ${String(index + 1).padStart(2, "0")}`).join("\n"))
    },
  })
}

function tmux(...args: string[]): string {
  const result = spawnSync("tmux", ["-S", TMUX_SOCKET, ...args], { encoding: "utf8", windowsHide: true })
  if (result.status !== 0) throw new Error(`tmux ${args.join(" ")} failed: ${result.stderr}`)
  return result.stdout
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

interface Pane {
  readonly name: string
  readonly bytes: string
  capture(): string
  keys(...keys: string[]): void
  type(text: string): void
}

/** Starts one terminal as a shell's foreground job, the way a person does,
 *  and records every byte the pane receives. */
function openPane(name: string, program: readonly string[], projectRoot: string): Pane {
  const env = {
    HOME,
    FLYWHEEL_DISABLE_AUTOUPDATE: "1",
    FLYWHEEL_INTERNAL_RELEASE_HARNESS: "account-service-isolation-v1",
    FLYWHEEL_INTERNAL_RELEASE_HUB_PORT: "0",
    FLYWHEEL_INTERNAL_RELEASE_HUB_RECORD: HUB_RECORD,
  }
  const command = `env ${Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`).join(" ")} ${program.map(shellQuote).join(" ")} --project-root ${shellQuote(projectRoot)}; echo "PANE-EXIT=$?"; sleep 600`
  tmux("new-session", "-d", "-s", name, "-x", "120", "-y", "40", "-c", projectRoot, "sh", "-c", command)
  const bytes = path.join(TMP, `${name}.bytes`)
  tmux("pipe-pane", "-o", "-t", name, `cat >> ${shellQuote(bytes)}`)
  return {
    name,
    bytes,
    capture: () => tmux("capture-pane", "-p", "-t", name),
    keys: (...keys) => { tmux("send-keys", "-t", name, ...keys) },
    type: (text) => { tmux("send-keys", "-t", name, "-l", text) },
  }
}

async function until<T>(label: string, read: () => T | Promise<T>, accept: (value: T) => boolean, describeLast: (value: T) => string = (value) => JSON.stringify(value)): Promise<T> {
  const deadline = Date.now() + STEP_MS
  for (;;) {
    const value = await read()
    if (accept(value)) return value
    if (Date.now() > deadline) throw new Error(`${label} did not happen within ${STEP_MS}ms; last:\n${describeLast(value)}`)
    await Bun.sleep(100)
  }
}

function paneUntil(pane: Pane, label: string, accept: (screen: string) => boolean): Promise<string> {
  return until(label, pane.capture, accept, (screen) => screen)
}

/** Every terminal of this project that runs from this test's files. */
function terminalProcesses(projectRoot: string): { readonly pid: number; readonly args: string }[] {
  const listed = spawnSync("ps", ["-A", "-o", "pid=,args="], { encoding: "utf8", windowsHide: true }).stdout
  return listed.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (!match?.[1] || !match[2]) return []
    const args = match[2]
    return args.includes(TMP) && args.includes(`--project-root ${projectRoot}`) && !args.startsWith("sh ") && !args.startsWith("env ") ? [{ pid: Number(match[1]), args }] : []
  })
}

/** The cutover a newer installed client sends; here it asks the development
 *  service to retire now instead of on its next build check. */
function requestCutover(): Promise<"busy" | "retiring"> {
  const credential = fs.readFileSync(accountServeTokenPath(USER_DATA_ROOT, LANE), "utf8").trim()
  const reader = createAccountAttachResponseReader()
  const preface = new TextEncoder().encode(encodeAccountAttach({ intent: "cutover", credential }))
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (socket: { end(): void } | undefined, result?: "busy" | "retiring", error?: unknown): void => {
      if (settled) return
      settled = true
      socket?.end()
      if (result !== undefined) resolve(result)
      else reject(error ?? new Error("the service closed before it answered the cutover"))
    }
    void Bun.connect({
      unix: accountServeSocketPath(USER_DATA_ROOT, LANE),
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

function makeProject(name: string): string {
  const root = path.join(TMP, name)
  fs.mkdirSync(path.join(root, ".git"), { recursive: true })
  return root
}

function visibleRows(screen: string, word: string): string[] {
  return screen.split("\n").flatMap((line) => {
    const row = new RegExp(`${word} row \\d\\d`).exec(line)?.[0]
    return row === undefined ? [] : [row]
  })
}

/** Each session is titled by its word, which the tab bar capitalizes. */
function hasTab(screen: string, word: string): boolean {
  const tabBar = screen.split("\n")[1] ?? ""
  return tabBar.includes(`${word.charAt(0).toUpperCase()}${word.slice(1)}`)
}

function occurrences(text: string, of: string): number {
  return text.split(of).length - 1
}

/** Typed text followed at once by Enter reads as a paste, whose Enter is a
 *  newline; a person pauses before submitting. */
async function submit(pane: Pane, text: string): Promise<void> {
  pane.type(text)
  await Bun.sleep(600)
  pane.keys("Enter")
}

/** Opens two chats, answers both, scrolls the second up, and leaves a draft. */
async function arrangePlace(pane: Pane, words: readonly [string, string], draft: string): Promise<{ readonly firstRow: string }> {
  await paneUntil(pane, "the first chat is ready", (screen) => screen.includes("for fresh chat"))
  await submit(pane, `tell me about ${words[0]}`)
  await paneUntil(pane, `the ${words[0]} reply`, (screen) => screen.includes(`${words[0]} row ${REPLY_LINES}`))
  pane.keys("C-n")
  await paneUntil(pane, "the second chat is ready", (screen) => screen.includes("for fresh chat"))
  await submit(pane, `tell me about ${words[1]}`)
  await paneUntil(pane, `the ${words[1]} reply`, (screen) => screen.includes(`${words[1]} row ${REPLY_LINES}`) && hasTab(screen, words[0]))
  pane.keys("PageUp")
  await paneUntil(pane, "the scroll up", (screen) => !screen.includes(`${words[1]} row ${REPLY_LINES}`) && visibleRows(screen, words[1]).length > 0)
  pane.type(draft)
  const settled = await paneUntil(pane, "the draft", (screen) => screen.includes(draft))
  const firstRow = visibleRows(settled, words[1])[0]
  if (firstRow === undefined) throw new Error(`no row is visible after the scroll:\n${settled}`)
  return { firstRow }
}

/** Raises the protocol and retires the service that speaks the old one; the
 *  terminal's reconnect starts the checkout's service, which speaks the new one. */
async function replaceService(): Promise<number> {
  const next = raiseProtocol()
  expect(await requestCutover()).toBe("retiring")
  await until("the new protocol serves", () => readRuntimeIdentity(accountServeRecordPath(USER_DATA_ROOT, LANE))?.protocolVersion, (version) => version === next)
  return next
}

async function expectSamePlace(pane: Pane, words: readonly [string, string], draft: string, firstRow: string): Promise<string> {
  return await paneUntil(pane, `the same place in the successor, with ${firstRow} at the top,`, (screen) =>
    screen.includes(draft) && hasTab(screen, words[0]) && hasTab(screen, words[1]) && visibleRows(screen, words[1])[0] === firstRow)
}

const provider = startProvider()
if (provider.port === undefined) throw new Error("the fixture provider has no port")
fs.mkdirSync(USER_DATA_ROOT, { recursive: true })
writeAccountConfig(provider.port)
copyCheckout()

afterAll(async () => {
  spawnSync("tmux", ["-S", TMUX_SOCKET, "kill-server"], { windowsHide: true })
  const remaining = stopHarnessProcesses([TMP])
  provider.stop(true)
  expect(remaining).toEqual([])
  // A killed service removes none of its temporary entries, and a service
  // that outlives the terminal that launched it leaves its output spool
  // behind. Production removes them at the next launch of each owner: a
  // persistent launch sweeps the spools, and a new process directory sweeps
  // its root. The test runs those same sweeps after its processes are gone.
  await sweepPersistentSpools()
  for (const stem of ["fw-ipc", "flywheel-native"] as const) await removeProcessTemporaryDirectory(await createProcessTemporaryDirectory(stem))
  if (!process.env.FW_KEEP_TMP) fs.rmSync(TMP, { recursive: true, force: true })
}, 60_000)

describe.skipIf(process.platform === "win32")("terminal re-execution at a protocol boundary", () => {
  test("the terminal replaces its own image with the build that serves and shows the same place", async () => {
    const project = makeProject("p1")
    const words = ["alpha", "bravo"] as const
    const draft = "an unsent draft"
    const pane = openPane("execve", [path.join(CHECKOUT, "bin", "flywheel")], project)
    const { firstRow } = await arrangePlace(pane, words, draft)
    const [before] = terminalProcesses(project)

    await replaceService()
    // The successor enters the alternate screen a second time.
    await until("the terminal re-executes", () => occurrences(fs.readFileSync(pane.bytes, "latin1"), ALT_SCREEN_ENTER), (enters) => enters === 2)
    const restored = await expectSamePlace(pane, words, draft, firstRow)

    const after = terminalProcesses(project)
    expect(after.map((process) => process.pid)).toEqual([before?.pid ?? -1])
    // The launch state is read once and deleted.
    expect(fs.readdirSync(path.join(USER_DATA_ROOT, "serve-dev")).filter((name) => name.startsWith("launch-state-"))).toEqual([])
    // One handoff: this terminal entered the alternate screen and left it,
    // then its successor entered it, with nothing drawn between.
    const bytes = fs.readFileSync(pane.bytes, "latin1")
    expect(occurrences(bytes, ALT_SCREEN_ENTER)).toBe(2)
    expect(occurrences(bytes, ALT_SCREEN_LEAVE)).toBe(1)
    expect(restored).not.toContain("PANE-EXIT")
    // The successor is live: it takes input into the restored draft.
    pane.type(" and more")
    await paneUntil(pane, "input after the handoff", (screen) => screen.includes(`${draft} and more`))
    tmux("kill-session", "-t", pane.name)
  }, 240_000)

  test("where the image cannot be replaced, the successor runs in the terminal's job and the terminal exits with its status", async () => {
    const project = makeProject("p2")
    const words = ["charlie", "delta"] as const
    const draft = "a second unsent draft"
    // Select the Windows handoff seam, not the host platform: the renderer,
    // service, and real foreground successor still run on this Unix tty.
    // The dev entry imports its snapshot, so inject the seam in that tree.
    const foregroundEntry = path.join(TMP, "foreground-successor.ts")
    fs.writeFileSync(foregroundEntry, [
      'import { mock } from "bun:test"',
      `const { enterSourceSnapshot } = await import(${JSON.stringify(path.join(CHECKOUT, "src", "infra", "source-snapshot.ts"))})`,
      `const entry = await enterSourceSnapshot(${JSON.stringify(CHECKOUT)})`,
      'if (entry.kind === "failed") throw new Error(entry.reason)',
      'const handoffPath = entry.root + "/src/cli/terminal-handoff.ts"',
      "const handoff = await import(handoffPath)",
      "const { createTerminalHandoff } = handoff",
      "mock.module(handoffPath, () => ({ ...handoff,",
      '  createTerminalHandoff: (options) => createTerminalHandoff(options, { platform: "win32" }),',
      "}))",
      `await import(${JSON.stringify(path.join(CHECKOUT, "scripts", "dev.ts"))})`,
      "",
    ].join("\n"))
    const pane = openPane("linger", [process.execPath, "--conditions=browser", foregroundEntry], project)
    const { firstRow } = await arrangePlace(pane, words, draft)
    const [predecessor] = terminalProcesses(project)
    if (!predecessor) throw new Error("the terminal did not start")

    await replaceService()
    const successors = await until("the successor starts", () => terminalProcesses(project).filter((process) => process.pid !== predecessor.pid), (found) => found.length === 1)
    await expectSamePlace(pane, words, draft, firstRow)
    expect(successors[0]?.pid).not.toBe(predecessor.pid)
    const parent = spawnSync("ps", ["-o", "ppid=", "-p", String(successors[0]?.pid)], { encoding: "utf8", windowsHide: true })
    expect(parent.status).toBe(0)
    expect(Number(parent.stdout.trim())).toBe(predecessor.pid)
    // The predecessor lingers as the shell's job while the successor runs.
    expect(() => process.kill(predecessor.pid, 0)).not.toThrow()

    // Quitting the successor ends both, with the successor's status.
    for (const _character of draft) pane.keys("BSpace")
    await paneUntil(pane, "the draft is cleared", (screen) => !screen.includes(draft))
    await submit(pane, "/exit")
    await paneUntil(pane, "the shell regains the terminal", (screen) => screen.includes("PANE-EXIT=0"))
    await until("the predecessor exits", () => {
      try {
        process.kill(predecessor.pid, 0)
        return true
      } catch {
        return false
      }
    }, (alive) => !alive)
  }, 240_000)
})
