import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { hostPlatformArch, nativeRuntimePackages } from "../../../scripts/binary-native-assets.js"
import { createAccountRuntimeAttach, isRuntimeListening, readRuntimeIdentity, type ProjectRuntimeOptions, type RuntimeIdentity } from "../../../src/cli/runtime-attach.js"
import { launchRuntimeClient, type LaunchedRuntimeClient } from "../../../src/cli/runtime-launch.js"
import { sourceSnapshotHome } from "../../../src/infra/cli-subprocess.js"
import { scanDebugLogFiles } from "../../../src/infra/debug-log.js"
import { ContainedDirectory } from "../../../src/infra/descriptor-directory.js"
import { EXECUTABLE_ROLES } from "../../../src/infra/executable-roles.js"
import { sharedHoldersIn } from "../../../src/infra/ownership-file-lock.js"
import { accountServeRecordPath, accountServeSocketPath } from "../../../src/infra/paths.js"
import { sweepPersistentSpools } from "../../../src/infra/persistent-spool.js"
import { isProcessAlive } from "../../../src/infra/process-liveness.js"
import { createProcessTemporaryDirectory, removeProcessTemporaryDirectory } from "../../../src/infra/process-temporary-directory.js"
import { DeadlineExceeded, withDeadline } from "../../../src/infra/with-deadline.js"
import type { FrontendOutputBlock, RuntimeClient, RuntimeTransportHealth } from "../../../src/protocol/app-service-types.js"
import { writeFixtureAccountConfig } from "./_fixture-account.js"
import { until } from "./_replacement-harness.js"
import { descendantProcesses } from "../../helpers/real-process-fixture.js"

// A dev service runs from a snapshot of its checkout's source, fixed at its
// start, so an edit to the checkout never changes or breaks the running
// service, and a new client of the edited checkout replaces the service with
// one of the current source (ARCH-DISTRIBUTION-030, ARCH-RUNTIME-031). Every process here runs from a private
// copy of the checkout under an isolated home, so the test can edit the copy;
// the installed build and the account's own services are never touched.

const REPO = fileURLToPath(new URL("../../../", import.meta.url))
// Canonical, because the service address is a hash of the account data root
// string, and a module in a snapshot names its checkout by its real path.
// Each test process has its own temporary directory.
const TMP = path.join(fs.realpathSync(tmpdir()), `fw-snap-${process.pid}`)
const COPY = path.join(TMP, "c")
const HOME = path.join(TMP, "h")
const USER_DATA_ROOT = path.join(HOME, ".flywheel")
const LANE = "dev"
const MODEL = "gpt-5"
const STEP_MS = 60_000
/** A module that only a project executor loads. */
const EXECUTOR_MODULE = path.join(COPY, "src", "orchestration", "app-service", "project-executor-main.ts")

/** The copy holds its own source, so an edit to it reaches only what loads
 *  the copy. Bun names a linked source file by its real path, so a linked
 *  source tree would load the checkout's own files. */
const COPIED = new Set(["src", "scripts", "bin", "package.json", "tsconfig.json", "bunfig.toml", "bun.lock"])
const TOKENIZER_FILES = ["tokenizer-prebuilt.json", "flywheel-tokenizer.wasm.zst"]

/** Links `name` in `directory` to the same entry of the checkout. */
function linkBeside(directory: string, name: string, from: string): void {
  fs.symlinkSync(fs.realpathSync(path.join(from, name)), path.join(directory, name), "junction")
}

/** A real `node_modules` in `copy` with one link for each package, so the
 *  snapshot that the copy's entry takes sits inside the copy's real path.
 *  The packages that the dev entry stages as the native runtime are copied
 *  instead: the staging copies a linked package as a link and then patches
 *  files through it. */
function copyNodeModules(copy: string): void {
  const from = path.join(REPO, "node_modules")
  const to = path.join(copy, "node_modules")
  fs.mkdirSync(to)
  for (const name of fs.readdirSync(from)) {
    if (name.startsWith(".")) continue
    if (!name.startsWith("@")) {
      linkBeside(to, name, from)
      continue
    }
    fs.mkdirSync(path.join(to, name))
    for (const scoped of fs.readdirSync(path.join(from, name))) linkBeside(path.join(to, name), scoped, path.join(from, name))
  }
  for (const name of nativeRuntimePackages(hostPlatformArch())) {
    fs.unlinkSync(path.join(to, name))
    fs.cpSync(fs.realpathSync(path.join(from, name)), path.join(to, name), { recursive: true })
  }
}

/** Copies the checkout into `copy`, whose source a test can then edit. */
function copyCheckout(copy: string): void {
  fs.mkdirSync(copy, { recursive: true })
  for (const entry of fs.readdirSync(REPO)) {
    if (entry === ".git" || entry === ".flywheel") continue
    if (COPIED.has(entry)) fs.cpSync(path.join(REPO, entry), path.join(copy, entry), { recursive: true })
    else if (entry === "node_modules") copyNodeModules(copy)
    else if (entry !== "crates") linkBeside(copy, entry, REPO)
  }
  const crates = path.join(copy, "crates")
  fs.mkdirSync(path.join(crates, "tokenizer"), { recursive: true })
  for (const entry of fs.readdirSync(path.join(REPO, "crates"))) {
    if (entry !== "tokenizer") linkBeside(crates, entry, path.join(REPO, "crates"))
  }
  for (const file of TOKENIZER_FILES) fs.copyFileSync(path.join(REPO, "crates", "tokenizer", file), path.join(crates, "tokenizer", file))
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

/** The text of a request's last message from the person, which a chat's later
 *  turn sends after the whole conversation before it. A module's turn
 *  reminder follows the person's message as a user message of its own, so a
 *  user message that holds a system reminder is not the person's. */
function lastPersonMessage(body: unknown): string {
  const messages = typeof body === "object" && body !== null && "messages" in body && Array.isArray(body.messages) ? body.messages : []
  const last = messages.findLast((message: unknown) => typeof message === "object" && message !== null && "role" in message && message.role === "user" && !JSON.stringify(message).includes("<system-reminder"))
  return JSON.stringify(last ?? null)
}

/** Answers each chat turn with the word its last message names, and titles
 *  each session by that word. */
function startProvider() {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      if (new URL(request.url).pathname.endsWith("/models")) return Response.json({ object: "list", data: [{ id: MODEL, object: "model", created: 0, owned_by: "fixture" }] })
      const body: unknown = await request.json()
      const whole = JSON.stringify(body)
      const word = /\b(alpha|bravo|charlie)\b/.exec(lastPersonMessage(body))?.[1] ?? "other"
      const hasTools = typeof body === "object" && body !== null && "tools" in body && Array.isArray(body.tools) && body.tools.length > 0
      if (!hasTools || whole.includes("Generate a session title")) return answer(`TITLE: Chat ${word}\nSHORT: ${word}`)
      return answer(`answer ${word}`)
    },
  })
}

/** Waits for `promise` until `deadline`. A step that does not settle, such
 *  as a call to a project that cannot open, fails with its label, so a
 *  stalled step names itself. */
async function by<T>(label: string, deadline: number, promise: Promise<T>): Promise<T> {
  try {
    return await withDeadline(promise, Math.max(deadline - Date.now(), 1))
  } catch (error) {
    if (error instanceof DeadlineExceeded) throw new Error(`${label} did not happen within ${STEP_MS}ms`, { cause: error })
    throw error
  }
}

function makeProject(name: string): string {
  const root = path.join(TMP, name)
  fs.mkdirSync(path.join(root, ".git"), { recursive: true })
  return root
}

/** Runs `flywheel serve ensure` from the copy, a new client of the copy's
 *  checkout, the way the editor extension finds or starts the service: it
 *  starts the dev service from the copy where none listens, and it exits
 *  once a service listens. */
async function serveEnsure(projectRoot: string): Promise<void> {
  const child = Bun.spawn([process.execPath, "--conditions=browser", path.join(COPY, "scripts", "dev.ts"), "serve", "ensure"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      HOME,
      FLYWHEEL_DISABLE_AUTOUPDATE: "1",
      FLYWHEEL_INTERNAL_RELEASE_HARNESS: "account-service-isolation-v1",
      FLYWHEEL_INTERNAL_RELEASE_HUB_PORT: "0",
    },
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  if (code !== 0) throw new Error(`serve ensure from the copy exited ${code}:\n${stdout}\n${stderr}`)
}

function serviceIdentity(): RuntimeIdentity {
  const identity = readRuntimeIdentity(accountServeRecordPath(USER_DATA_ROOT, LANE))
  if (identity === undefined) throw new Error("no dev service identity record")
  return identity
}

function snapshotRoot(digest: string): string {
  return path.join(COPY, "node_modules", ".cache", "flywheel", "source", digest)
}

/** The processes below the service that run from its source, with their
 *  command lines. A command supervisor names its payload after `--`, such
 *  as an executor's command line, so a supervisor is left out. */
async function sourceProcesses(servicePid: number): Promise<{ readonly pid: number; readonly args: string }[]> {
  return (await descendantProcesses(servicePid))
    .map(({ pid, argv }) => ({ pid, args: argv.join(" ") }))
    .filter(({ args }) => !args.includes(EXECUTABLE_ROLES.commandSupervisor) && !args.includes("owned-command-supervisor"))
}

/** The command line of each project executor below the service. */
async function executorCommands(servicePid: number): Promise<string[]> {
  return (await sourceProcesses(servicePid)).map(({ args }) => args).filter((args) => args.includes(EXECUTABLE_ROLES.projectExecutor))
}

/** The pids that hold the snapshot `digest` of the checkout at `checkout`. */
function snapshotHolders(checkout: string, digest: string): number[] {
  const home = ContainedDirectory.open(sourceSnapshotHome(checkout), [])
  try {
    return [...sharedHoldersIn(home, `${digest}.gate`).pids].sort((a, b) => a - b)
  } finally {
    home.close()
  }
}

/** Every INFO record of the account log that states `message`. */
function accountLogRecords(message: string): { readonly [key: string]: unknown }[] {
  const dir = path.join(HOME, ".flywheel", "log")
  return [...scanDebugLogFiles(fs.readdirSync(dir).map((file) => path.join(dir, file)), { types: ["log.info"] })].flatMap((record) => {
    const payload = record.payload
    return typeof payload === "object" && payload !== null && "message" in payload && payload.message === message ? [{ ...payload }] : []
  })
}

interface Client {
  readonly launched: LaunchedRuntimeClient
  readonly client: RuntimeClient
  /** Every connection health the client reported. */
  readonly health: RuntimeTransportHealth[]
}

const clients: Client[] = []

/** A client of `projectRoot` from this test's process, whose checkout is not
 *  the copy's, so it never asks the service whether its source is current,
 *  as a client that already made its first attach never asks again. It
 *  starts a service the way a client of the copy does, from the copy. */
async function attachClient(projectRoot: string): Promise<Client> {
  const directories = { accountHome: HOME, userDataRoot: USER_DATA_ROOT, projectRoot, executionCwd: projectRoot }
  const attach = createAccountRuntimeAttach({ ...directories, allowPersistentProcesses: false }, {
    launchRuntime: (options: ProjectRuntimeOptions) => serveEnsure(options.projectRoot),
  })
  const launched = await launchRuntimeClient({ ...directories, attach })
  const health: RuntimeTransportHealth[] = []
  launched.client.subscribe((event) => {
    if (event.type === "runtime.health") health.push(event.health)
  })
  const client = { launched, client: launched.client, health }
  clients.push(client)
  return client
}

async function answers(client: RuntimeClient, sessionId: string): Promise<string[]> {
  const window = await client.query({ type: "outputWindow", sessionId, request: { range: { anchor: { kind: "tail" }, maxBlocks: 64, maxBytes: 256_000 } } })
  if (window.range.kind !== "ok") return []
  return window.range.blocks.flatMap((block: FrontendOutputBlock) => block.kind === "text" ? [block.content] : [])
}

async function send(client: RuntimeClient, sessionId: string, word: string): Promise<void> {
  const label = `the ${word} answer`
  expect(await by(label, Date.now() + STEP_MS, client.dispatch({ type: "session.send", sessionId, input: `tell me about ${word}` }))).toMatchObject({ ok: true })
  await until(label, () => by(label, Date.now() + STEP_MS, answers(client, sessionId)), (texts) => texts.includes(`answer ${word}`))
}

async function openChat(client: RuntimeClient, word: string): Promise<string> {
  const opened = await by(`the ${word} chat`, Date.now() + STEP_MS, client.dispatch({ type: "chat.open" }))
  if (!opened.ok || opened.sessionId === undefined) throw new Error(`the ${word} chat did not open: ${JSON.stringify(opened)}`)
  await send(client, opened.sessionId, word)
  return opened.sessionId
}

/** Every process that runs from this test's files: the services, what they
 *  started, and the clients of the copy. */
function processesOfThisTest(): number[] {
  const listed = spawnSync("ps", ["-A", "-ww", "-o", "pid=,args="], { encoding: "utf8", windowsHide: true }).stdout
  return listed.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line)
    return match?.[1] !== undefined && match[2]?.includes(TMP) === true ? [Number(match[1])] : []
  })
}

// The process table is read through `ps` and `pgrep`, which Windows lacks.
describe.skipIf(process.platform === "win32")("dev service source snapshot", () => {
  let provider: ReturnType<typeof startProvider> | undefined
  let executorSource = ""
  let first: { readonly pid: number; readonly digest: string } | undefined
  let sessionA: string | undefined
  let clientA: Client | undefined

  beforeAll(async () => {
    fs.mkdirSync(TMP)
    provider = startProvider()
    if (provider.port === undefined) throw new Error("the fixture provider has no port")
    await writeFixtureAccountConfig(USER_DATA_ROOT, { port: provider.port, model: MODEL })
    copyCheckout(COPY)
    executorSource = fs.readFileSync(EXECUTOR_MODULE, "utf8")
  }, 120_000)

  afterAll(async () => {
    for (const { launched } of clients) await launched.dispose()
    // A dev service that no client holds leaves within seconds; whatever still
    // runs from this test's files after that is ended here.
    await until("the dev service leaves", () => isRuntimeListening(accountServeSocketPath(USER_DATA_ROOT, LANE)), (listening) => !listening).catch(() => undefined)
    const remaining = processesOfThisTest()
    for (const pid of remaining) spawnSync("kill", ["-KILL", String(pid)], { windowsHide: true })
    await until("the test's processes are gone", async () => remaining.filter(isProcessAlive), (alive) => alive.length === 0)
    provider?.stop(true)
    // A killed process removes none of its temporary entries, and a service
    // that outlives the client that launched it leaves its output spool
    // behind. Production removes them at the next launch of each owner; the
    // test runs those same sweeps once its processes are gone.
    await sweepPersistentSpools()
    for (const stem of ["fw-ipc", "flywheel-native"] as const) await removeProcessTemporaryDirectory(await createProcessTemporaryDirectory(stem))
    if (!process.env.FW_KEEP_TMP) fs.rmSync(TMP, { recursive: true, force: true })
  }, 120_000)

  test("a dev service started from the checkout runs its project executors from a snapshot of the checkout's source", async () => {
    const projectA = makeProject("a")
    await serveEnsure(projectA)
    const identity = serviceIdentity()
    const digest = identity.sourceSnapshot?.digest ?? ""
    first = { pid: identity.pid, digest }
    clientA = await attachClient(projectA)
    sessionA = await openChat(clientA.client, "alpha")

    expect(identity.sourceSnapshot).toEqual({ checkout: COPY, digest: expect.stringMatching(/^[0-9a-f]{16}$/) })
    expect(await executorCommands(identity.pid)).toEqual([expect.stringContaining(path.join(snapshotRoot(digest), "scripts", "project-executor.ts"))])
    // The service, its guardian, and its executor each hold the snapshot they
    // run from, so no sweep removes it under them.
    const fromSnapshot = (await sourceProcesses(identity.pid)).filter(({ args }) => args.includes(snapshotRoot(digest)))
    expect(fromSnapshot.map(({ args }) => args)).toContainEqual(expect.stringContaining(`${path.join(snapshotRoot(digest), "scripts", "source-cli.ts")} ${EXECUTABLE_ROLES.guardian}`))
    expect(snapshotHolders(COPY, digest)).toEqual(expect.arrayContaining([identity.pid, ...fromSnapshot.map(({ pid }) => pid)]))
  }, 240_000)

  test("an edit that breaks the checkout's executor source leaves the running service able to open and serve a new project", async () => {
    if (first === undefined) throw new Error("no service started")
    fs.writeFileSync(EXECUTOR_MODULE, `${executorSource}\nexport const brokenByThisTest = (\n`)
    const projectB = makeProject("b")
    const clientB = await attachClient(projectB)
    await openChat(clientB.client, "bravo")
    expect(serviceIdentity().pid).toBe(first.pid)
    const executor = path.join(snapshotRoot(first.digest), "scripts", "project-executor.ts")
    expect(await executorCommands(first.pid)).toEqual([expect.stringContaining(executor), expect.stringContaining(executor)])
  }, 240_000)

  test("a new client of the edited checkout replaces the service with one of the current source, and the first client's session continues", async () => {
    if (first === undefined || clientA === undefined || sessionA === undefined) throw new Error("no service or first client")
    fs.writeFileSync(EXECUTOR_MODULE, `${executorSource}\n// A real change to the checkout's source.\n`)
    await serveEnsure(makeProject("c"))

    const successor = serviceIdentity()
    expect(successor.pid).not.toBe(first.pid)
    expect(successor.sourceSnapshot).toEqual({ checkout: COPY, digest: expect.stringMatching(/^[0-9a-f]{16}$/) })
    const digest = successor.sourceSnapshot?.digest ?? ""
    expect(digest).not.toBe(first.digest)
    expect(accountLogRecords("replacement requested")).toEqual([expect.objectContaining({ trigger: "source changed", checkout: COPY, ownDigest: first.digest, currentDigest: digest })])

    await send(clientA.client, sessionA, "charlie")
    expect(await answers(clientA.client, sessionA)).toEqual(expect.arrayContaining(["answer alpha", "answer charlie"]))
    expect(clientA.health.filter((health) => health.kind === "faulted")).toEqual([])
    expect(await executorCommands(successor.pid)).toContainEqual(expect.stringContaining(path.join(snapshotRoot(digest), "scripts", "project-executor.ts")))
  }, 240_000)

  test("once every client closes, the service leaves, and the next service removes the snapshot that no process runs from", async () => {
    if (first === undefined) throw new Error("no service started")
    const current = serviceIdentity().sourceSnapshot?.digest ?? ""
    for (const { launched } of clients.splice(0)) await launched.dispose()
    await until("the dev service leaves", () => isRuntimeListening(accountServeSocketPath(USER_DATA_ROOT, LANE)), (listening) => !listening)

    await serveEnsure(makeProject("d"))
    const replaced = snapshotRoot(first.digest)
    await until(`the removal of ${replaced}`, async () => fs.existsSync(replaced), (exists) => !exists)
    expect(fs.existsSync(snapshotRoot(current))).toBe(true)
  }, 240_000)
})

/** Starts a process that enters a snapshot of `checkout`, and answers it
 *  with the digest it entered. The process ends once it has entered, or,
 *  with `stay`, runs until it is killed. */
async function snapshotHolderProcess(checkout: string, stay: boolean): Promise<{ readonly child: Bun.Subprocess<"ignore", "pipe", "pipe">; readonly digest: string }> {
  const module = pathToFileURL(path.join(REPO, "src", "infra", "source-snapshot.ts")).href
  const script = [
    `const { enterSourceSnapshot } = await import(${JSON.stringify(module)})`,
    `const entry = await enterSourceSnapshot(${JSON.stringify(checkout)})`,
    `process.stdout.write((entry.kind === "failed" ? "failed: " + entry.reason : entry.digest) + "\\n")`,
    stay ? "setInterval(() => {}, 60_000)" : "",
  ].join("\n")
  const child = Bun.spawn([process.execPath, "-e", script], { stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true })
  const reader = child.stdout.getReader()
  let line = ""
  while (!line.includes("\n")) {
    const { value, done } = await reader.read()
    if (done) break
    line += new TextDecoder().decode(value)
  }
  reader.releaseLock()
  return { child, digest: line.trim() }
}

/** The pid each holder record of the snapshot `digest` names. */
function holderRecordPids(checkout: string, digest: string): number[] {
  const home = sourceSnapshotHome(checkout)
  return fs.readdirSync(home)
    .filter((name) => name.startsWith(`${digest}.gate.shared.`))
    .map((name) => Number(JSON.parse(fs.readFileSync(path.join(home, name), "utf8")).pid))
}

describe("a process that holds a dev service's snapshot", () => {
  test("removes its holder record as it exits, and a killed holder's record goes at the next join", async () => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), "fw-hold-"))
    try {
      const checkout = path.join(root, "checkout")
      fs.mkdirSync(path.join(checkout, "src"), { recursive: true })
      fs.mkdirSync(path.join(checkout, "node_modules"))
      fs.writeFileSync(path.join(checkout, "package.json"), "{}\n")
      fs.writeFileSync(path.join(checkout, "src", "index.ts"), "export {}\n")

      const ended = await snapshotHolderProcess(checkout, false)
      expect(await ended.child.exited).toBe(0)
      expect(ended.digest).toMatch(/^[0-9a-f]{16}$/)
      expect(holderRecordPids(checkout, ended.digest)).toEqual([])

      const killed = await snapshotHolderProcess(checkout, true)
      expect(holderRecordPids(checkout, killed.digest)).toEqual([killed.child.pid])
      killed.child.kill("SIGKILL")
      await killed.child.exited
      expect(holderRecordPids(checkout, killed.digest)).toEqual([killed.child.pid])

      const joined = await snapshotHolderProcess(checkout, false)
      expect(await joined.child.exited).toBe(0)
      expect(joined.digest).toBe(killed.digest)
      expect(holderRecordPids(checkout, joined.digest)).toEqual([])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 60_000)
})

/** The command a probe client runs in place of the CLI: it loads `shared`
 *  at its start, as a terminal loads most of its modules, says so, and
 *  imports `late` only once a line arrives on its input, as a terminal
 *  imports a modal's actions when a person opens it. */
const PROBE_CLI = `import { word } from "../probe/shared.js"

export async function runFlywheelCli(): Promise<void> {
  process.stdout.write(\`started \${word}\\n\`)
  for await (const _line of console) break
  try {
    const late: { readonly answer: string } = await import("../probe/late.js")
    process.stdout.write(\`loaded \${late.answer}\\n\`)
  } catch (error) {
    process.stdout.write(\`failed \${error instanceof Error ? error.message : String(error)}\\n\`)
  }
  process.exit(0)
}
`

/** Reads `stream` line by line. */
function lineReader(stream: ReadableStream<Uint8Array>): () => Promise<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffered = ""
  return async () => {
    while (!buffered.includes("\n")) {
      const { value, done } = await reader.read()
      if (done) return buffered
      buffered += decoder.decode(value, { stream: true })
    }
    const end = buffered.indexOf("\n")
    const line = buffered.slice(0, end)
    buffered = buffered.slice(end + 1)
    return line
  }
}

// The incident this guards: a terminal of `bun run dev` that started before
// a pull imported the new `edit.ts` lazily against the `tool-paths.ts` it had
// loaded at its start, and the import failed with "Export named
// 'sessionPathInput' not found". A dev client is as long-lived as a dev
// service, so it runs from a snapshot fixed at its start too (ARCH-DISTRIBUTION-030).
describe("a dev client's source", () => {
  const root = path.join(fs.realpathSync(tmpdir()), `fw-client-${process.pid}`)
  const copy = path.join(root, "c")

  beforeAll(() => {
    copyCheckout(copy)
    fs.writeFileSync(path.join(copy, "src", "cli", "index.ts"), PROBE_CLI)
    fs.mkdirSync(path.join(copy, "src", "probe"))
    fs.writeFileSync(path.join(copy, "src", "probe", "shared.ts"), `export const word = "before"\n`)
    fs.writeFileSync(path.join(copy, "src", "probe", "late.ts"), `import { word } from "./shared.js"\n\nexport const answer = word\n`)
  }, 120_000)

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true })
  })

  test("resolves a lazy import against the source it started with, after an edit adds an export and an importer of it", async () => {
    const child = Bun.spawn([process.execPath, "--conditions=browser", path.join(copy, "scripts", "dev.ts")], {
      cwd: root,
      env: { ...process.env, HOME: path.join(root, "h"), FLYWHEEL_DISABLE_AUTOUPDATE: "1" },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    })
    try {
      const nextLine = lineReader(child.stdout)
      expect(await nextLine()).toBe("started before")

      fs.writeFileSync(path.join(copy, "src", "probe", "shared.ts"), `export const word = "after"\nexport const added = "added"\n`)
      fs.writeFileSync(path.join(copy, "src", "probe", "late.ts"), `import { added, word } from "./shared.js"\n\nexport const answer = \`\${word} \${added}\`\n`)
      child.stdin.write("open the modal\n")
      await child.stdin.flush()

      expect(await nextLine()).toBe("loaded before")
      expect(await child.exited).toBe(0)
    } finally {
      child.kill("SIGKILL")
      await child.exited
    }
  }, 60_000)

  test("updates reactive text through the production launcher from a dev snapshot", async () => {
    fs.writeFileSync(path.join(copy, "src", "cli", "index.ts"), `import { startTUI } from "../tui/launcher.js"

export async function runFlywheelCli(): Promise<void> {
  await startTUI({})
  process.exit(0)
}
`)
    fs.writeFileSync(path.join(copy, "src", "tui", "app.tsx"), `/** @jsxImportSource @opentui/solid */
import { testRender } from "@opentui/solid"
import { createSignal } from "solid-js"

export async function startTUI(): Promise<void> {
  const [word, setWord] = createSignal("before")
  const screen = await testRender(() => <text>{word()}</text>, { width: 20, height: 1 })
  try {
    await screen.renderOnce()
    const before = screen.captureCharFrame().trim()
    setWord("after")
    await screen.renderOnce()
    process.stdout.write(JSON.stringify([before, screen.captureCharFrame().trim()]) + "\\n")
  } finally {
    await screen.dispose()
  }
}
`)
    const child = Bun.spawn([process.execPath, "--conditions=browser", path.join(copy, "scripts", "dev.ts")], {
      cwd: root,
      env: { ...process.env, HOME: path.join(root, "h"), FLYWHEEL_DISABLE_AUTOUPDATE: "1" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    })
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" })
      expect(JSON.parse(stdout)).toEqual(["before", "after"])
    } finally {
      child.kill("SIGKILL")
      await child.exited
    }
  }, 60_000)
})
