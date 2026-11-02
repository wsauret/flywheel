import { expect } from "bun:test"
import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import { createAccountRuntimeAttach, isRuntimeListening, readRuntimeIdentity } from "../../../src/cli/runtime-attach.js"
import { launchRuntimeClient } from "../../../src/cli/runtime-launch.js"
import { SERVE_EXIT } from "../../../src/cli/serve-contract.js"
import { serveLaneFor } from "../../../src/infra/cli-subprocess.js"
import { accountEventStoreDbFile, accountServeRecordPath, accountServeSocketPath, accountServeTokenPath, CURRENT_BUILD_LINK, resolveEventStoreDbFile } from "../../../src/infra/paths.js"
import { isSqliteBusyError } from "../../../src/infra/sqlite-durability.js"
import { openReadonlyEventReader } from "../../../src/infra/sqlite-event-store.js"
import { createAccountAttachResponseReader, encodeAccountAttach } from "../../../src/protocol/account-attach.js"
import type { FrontendOutputBlock, RuntimeClient } from "../../../src/protocol/app-service-types.js"
import { defaultRoleSlots } from "../../../src/orchestration/config/role-selection.js"
import { ROLE_MODEL_DEFAULTS } from "../../../src/orchestration/config/role-model-defaults.js"
import { attachAccountProject, joinIsolatedAccountService, startIsolatedAccountService, stopIsolatedAccountService } from "./_account-service.js"
import { EXECUTABLE_ROLES } from "../../../src/infra/executable-roles.js"
import { windowsProcessApi } from "../../../src/infra/windows-process-api.js"
import { decodeProjectExecutorInitialization } from "../../../src/orchestration/app-service/project-executor-protocol.js"
import { descendantProcesses } from "../../helpers/real-process-fixture.js"
import { MODEL, startReplacementProvider, TASKS, type ReplacementProvider, type TaskKey } from "./_replacement-provider.js"

// The isolated account service is started through this process's bun, so it serves this process's lane.
export const LANE = serveLaneFor(process.execPath)
const CONTINUATION_KIND = "session.planned_continuation"
const COMMAND_HANDOVER_KIND = "session.command_handover"
const HANDOFF_KIND = "account.replacement_handoff"

/** Each step has one budget so a stalled step names itself. */
const STEP_MS = 30_000

/** Reads until `accept` takes the value, for one step's budget from
 *  `startsAtMs`. A step that waits on an event scheduled for a known time,
 *  such as a deadline, starts there: its budget measures how late the event
 *  is, not how early the wait began. */
export async function until<T>(label: string, read: () => Promise<T>, accept: (value: T) => boolean, startsAtMs = Date.now()): Promise<T> {
  const deadline = startsAtMs + STEP_MS
  let last: T | undefined
  for (;;) {
    last = await read()
    if (accept(last)) return last
    if (Date.now() > deadline) throw new Error(`${label} did not happen within ${STEP_MS}ms; last: ${JSON.stringify(last)}`)
    await Bun.sleep(50)
  }
}

/** The pause between two reads of a store that met another process's switch
 *  of its journal mode, as the product's own switch waits (sqlite-durability.ts). */
const STORE_RETRY_MS = 5

/** Whether a read met a store another process is opening or closing. Each
 *  open of a Flywheel store switches it to WAL, and each close folds the WAL
 *  back and switches it to rollback mode, which removes the sidecars. A
 *  read-only connection that meets that switch fails with SQLITE_CANTOPEN, at
 *  its open or at a later statement, and one that waits past its busy
 *  timeout fails with SQLITE_BUSY. The next read after the switch succeeds. */
function metStoreSwitch(error: unknown): boolean {
  return (error instanceof Error && "code" in error && error.code === "SQLITE_CANTOPEN") || isSqliteBusyError(error)
}

/** Reads the store at `file` through one read-only connection, as the
 *  product's own readers do. A successor's processes open and close the store
 *  while a case reads it, so a read that meets that is read again, whole,
 *  until the step's budget; any other failure is thrown at once. */
export function readStoreFile<T>(file: string, read: (reader: ReturnType<typeof openReadonlyEventReader>) => T): T {
  const deadline = Date.now() + STEP_MS
  for (;;) {
    let reader: ReturnType<typeof openReadonlyEventReader> | undefined
    try {
      reader = openReadonlyEventReader(file)
      return read(reader)
    } catch (error) {
      if (!metStoreSwitch(error) || Date.now() > deadline) throw error
    } finally {
      reader?.close()
    }
    // Synchronous, because every reader of the harness is: the other
    // process finishes its switch within milliseconds.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, STORE_RETRY_MS)
  }
}

export async function sessionRow(client: RuntimeClient, sessionId: string): Promise<{ readonly lifecycleState: string; readonly admittedActions: readonly string[] }> {
  const row = (await client.query({ type: "sessionDetail", sessionId })).view?.row
  if (!row) throw new Error(`session ${sessionId} has no row`)
  return { lifecycleState: row.lifecycleState, admittedActions: row.admittedActions ?? [] }
}

export async function sessionStatus(client: RuntimeClient, sessionId: string) {
  return (await client.query({ type: "statusSnapshot", sessionIds: [sessionId] })).views[0]?.view ?? null
}

/** Answers the session's open question `toolUseId` with the option labelled
 *  `label`, as a person's click does: the session is opened first, so its
 *  runner takes the answer, and the choice is the one the question declares. */
export async function answerChoice(client: RuntimeClient, sessionId: string, toolUseId: string, label: string) {
  const open = (await client.query({ type: "questionSnapshot", sessionIds: [sessionId] })).views[0]?.view
  const question = open?.toolUseId === toolUseId ? open.questions[0] : undefined
  const choice = question?.choices.find((candidate) => candidate.kind === "option" && candidate.label === label)
  if (!question || choice?.kind !== "option" || choice.choiceId === undefined) throw new Error(`session ${sessionId} has no open question ${toolUseId} offering ${label}`)
  const activated = await client.dispatch({ type: "session.activate", sessionId })
  if (!activated.ok) throw new Error(`session ${sessionId} did not open: ${activated.error}`)
  return await client.dispatch({ type: "question.answer", sessionId, toolUseId, answers: { [question.question]: { kind: "choice", selections: [{ choiceId: choice.choiceId }], text: label } } })
}

export async function systemRows(client: RuntimeClient, sessionId: string): Promise<string[]> {
  const window = await client.query({ type: "outputWindow", sessionId, request: { range: { anchor: { kind: "tail" }, maxBlocks: 64, maxBytes: 256_000 } } })
  if (window.range.kind !== "ok") return []
  return window.range.blocks.flatMap((block: FrontendOutputBlock) => block.kind === "system" ? [block.message] : [])
}

export async function parentCard(client: RuntimeClient, sessionId: string): Promise<Extract<FrontendOutputBlock, { kind: "agentGroup" }> | undefined> {
  const window = await client.query({ type: "outputWindow", sessionId, request: { range: { anchor: { kind: "tail" }, maxBlocks: 64, maxBytes: 256_000 } } })
  if (window.range.kind !== "ok") return undefined
  return window.range.blocks.find((block): block is Extract<FrontendOutputBlock, { kind: "agentGroup" }> => block.kind === "agentGroup")
}

/** The workflow as a client reads it: its committed state, or running while
 *  its view has not loaded that state. A new workflow's detail can read null
 *  for a moment after its launch answers, which reads running too. */
export async function workflowState(client: RuntimeClient, workflowId: string) {
  const view = (await client.query({ type: "workflowViewSnapshot", workflowId })).view
  if (view === null) return "running"
  return view.attemptsStatus === "loaded" ? view.state ?? "running" : "unavailable"
}

/** The chat a workflow belongs to, where its follow-up goes once it has
 *  finished (PI-INTERACTION-022). */
export async function workflowParent(client: RuntimeClient, workflowId: string): Promise<string> {
  const view = (await client.query({ type: "workflowDetail", workflowId })).view
  if (!view) throw new Error(`workflow ${workflowId} has no detail`)
  return view.launchedFrom.parentSessionId
}

/** One investigation step whose output takes the fixture provider's step
 *  handoff. A later phase would replay the same task text and the same
 *  provider call id in a second step conversation. */
const INVESTIGATION_WORKFLOW = [
  "id: investigation",
  "name: Investigation",
  "phases:",
  "  - phase: investigate",
  "    name: Investigate",
  "    brief: Investigate the reported issue and confirm the root cause. Do not edit files.",
  "    output:",
  "      summary: Concise result of the investigation.",
  "      fields:",
  "        hypothesis: { type: string, nullable: true }",
  "        evidence: { type: list, of: { type: string }, min: 1 }",
  "    writes: []",
  "",
].join("\n")

/** Launches a workflow from a chat through the `workflow` tool: the
 *  investigation step, or the file `projectWorkflow` names under the
 *  project's `.flywheel/workflows`. Returns the workflow id. */
export async function launchWorkflow(client: RuntimeClient, key: TaskKey, projectWorkflow?: string): Promise<string> {
  const projectRoot = (await client.query({ type: "snapshot" })).projectRoot
  const content = projectWorkflow === undefined
    ? INVESTIGATION_WORKFLOW
    : fs.readFileSync(path.join(projectRoot, ".flywheel", "workflows", `${projectWorkflow}.yaml`), "utf8")
  const opened = await client.dispatch({ type: "chat.open" })
  if (!opened.ok || !opened.sessionId) throw new Error(`workflow ${key} parent did not open`)
  const sent = await client.dispatch({ type: "session.send", sessionId: opened.sessionId, input: `FIXTURE-WORKFLOW-LAUNCH:${key}:${Buffer.from(content).toString("base64")}` })
  if (!sent.ok) throw new Error(`workflow ${key} launch request failed: ${sent.error}`)
  const link = await until("workflow card", async () => (await parentCard(client, opened.sessionId!))?.linkUri, (uri) => uri?.startsWith("flywheel://workflow/") === true)
  if (!link) throw new Error("The workflow has no card")
  return link.slice("flywheel://workflow/".length)
}

/** Reads the actual started agent session from the workflow's view. */
export async function workflowMember(client: RuntimeClient, workflowId: string): Promise<string> {
  const id = await until("workflow member", async () => {
    const view = (await client.query({ type: "workflowViewSnapshot", workflowId })).view
    return view?.attempts.find((attempt) => attempt.sessionId !== undefined)?.sessionId
  }, (value) => value !== undefined)
  if (!id) throw new Error("The workflow has no started member")
  return id
}

/** The child session a parent's card links to. */
export async function childOf(client: RuntimeClient, parentSessionId: string): Promise<string> {
  const link = await until("child card", async () => (await parentCard(client, parentSessionId))?.linkUri, (uri) => uri !== undefined && uri.startsWith("flywheel://session/"))
  const child = link?.slice("flywheel://session/".length)
  if (!child) throw new Error(`no child under ${parentSessionId}`)
  return child
}

export async function openChat(client: RuntimeClient, key: TaskKey): Promise<string> {
  const opened = await client.dispatch({ type: "chat.open" })
  if (!opened.ok || !opened.sessionId) throw new Error(`chat for ${key} did not open`)
  expect(await client.dispatch({ type: "session.send", sessionId: opened.sessionId, input: TASKS[key] })).toMatchObject({ ok: true })
  return opened.sessionId
}

/** Opens a chat, sends the task, and waits until its turn is held on the provider. */
export async function startHeldChat(client: RuntimeClient, provider: ReplacementProvider, key: TaskKey): Promise<string> {
  const sessionId = await openChat(client, key)
  await provider.entered(key)
  await until(`${key} turn running`, () => sessionStatus(client, sessionId), (status) => status?.activity === "waiting" || status?.activity === "generating" || status?.activity === "executing_tools")
  return sessionId
}

/** The working directory of a live process, which for a project executor is its project. */
function processCwd(pid: number): string | undefined {
  if (process.platform === "linux") {
    try {
      return fs.readlinkSync(`/proc/${pid}/cwd`)
    } catch {
      return undefined
    }
  }
  const listed = Bun.spawnSync(["lsof", "-a", "-d", "cwd", "-p", String(pid), "-Fn"], { windowsHide: true }).stdout.toString()
  return listed.split("\n").find((line) => line.startsWith("n"))?.slice(1)
}

/** The cutover intent a newer installed client sends to the account
 *  service of `userDataRoot` before it attaches, and the service's answer. */
export function requestAccountCutover(userDataRoot: string): Promise<"busy" | "retiring"> {
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

/** One isolated account home with its fixture provider, the installed build
 *  its service reads, and the service's handoff state as a test reads it. */
export function createReplacementHarness(name: string) {
  // Canonical, because the service address is a hash of the account data root
  // string, and the temporary directory can be reached through a link.
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(tmpdir(), `fw-${name}-`)))
  const accountHome = path.join(tmp, "home")
  const userDataRoot = path.join(accountHome, ".flywheel")
  const buildFile = path.join(tmp, "installed-build.json")
  const base = { accountHome, userDataRoot }
  const provider = startReplacementProvider({ markerDir: path.join(userDataRoot, "fixture-commands") })

  /** Writes the account's config, with `chatModel` serving the chat role
   *  and the fixture model every other role of the default auth profile. */
  const writeAccountConfig = (chatModel: string = MODEL): void => {
    const authDirectory = path.join(userDataRoot, "auth", "profiles", "default")
    fs.mkdirSync(authDirectory, { recursive: true })
    for (const dir of [userDataRoot, path.join(userDataRoot, "auth"), path.join(userDataRoot, "auth", "profiles"), authDirectory]) fs.chmodSync(dir, 0o700)
    const roles = new Set([...defaultRoleSlots().map((slot) => slot.roleId), ...Object.keys(ROLE_MODEL_DEFAULTS)])
    fs.writeFileSync(path.join(userDataRoot, "flywheel.toml"), [
      "[custom_providers.fixture]",
      `base_url = ${JSON.stringify(`http://127.0.0.1:${provider.port}/v1`)}`,
      `models = [${JSON.stringify(MODEL)}]`,
      "",
      ...[...roles].flatMap((role) => [`[profiles.default.roles.${JSON.stringify(role)}]`, `model = ${JSON.stringify(role === "chat" ? chatModel : MODEL)}`, 'effort = "low"', ""]),
    ].join("\n"))
    fs.writeFileSync(path.join(authDirectory, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "fixture-placeholder-key" } }), { mode: 0o600 })
  }

  /** The build the serve fixture reads as the account's installed build. */
  const setInstalledBuild = (buildId: string, version: string): void => {
    fs.writeFileSync(buildFile, JSON.stringify({ buildId, version }))
  }

  /** Points the account's `current` link at a new build directory, as an
   *  install activates one: a new link renamed over the old. The serve
   *  fixture reads the build itself from the installed build file. */
  const activateCurrentLink = (buildId: string): void => {
    const target = path.join(tmp, "versions", buildId)
    fs.mkdirSync(target, { recursive: true })
    const staged = path.join(userDataRoot, `.${CURRENT_BUILD_LINK}.${buildId}`)
    fs.symlinkSync(target, staged)
    fs.renameSync(staged, path.join(userDataRoot, CURRENT_BUILD_LINK))
  }

  // A real repository: a mutating command takes its private copy only where Git
  // answers, and a `.git` entry that Git refuses runs the command uncaptured.
  const makeProject = (projectName: string): string => {
    const root = path.join(tmp, projectName)
    fs.mkdirSync(root, { recursive: true })
    const init = Bun.spawnSync(["git", "init", "-q", root], { windowsHide: true })
    if (init.exitCode !== 0) throw new Error(`git init failed: ${init.stderr.toString()}`)
    return root
  }

  const requestCutover = (): Promise<"busy" | "retiring"> => requestAccountCutover(userDataRoot)

  const serviceListening = (): Promise<boolean> => isRuntimeListening(accountServeSocketPath(userDataRoot, LANE))

  const serviceIdentity = () => readRuntimeIdentity(accountServeRecordPath(userDataRoot, LANE))

  const stopAccountService = async (): Promise<void> => {
    await stopIsolatedAccountService(userDataRoot)
    fs.rmSync(accountServeRecordPath(userDataRoot, LANE), { force: true })
  }

  /** Ends the service tree the way a crash does, executor first. */
  const killAccountServiceUncleanly = async (): Promise<void> => {
    const identity = serviceIdentity()
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

  /** Starts a service the way the service manager starts a successor: no
   *  client, from the account home, serving this lane. */
  const startSuccessor = async (cwd: string): Promise<void> => {
    await startIsolatedAccountService({ userDataRoot, accountHome, projectRoot: cwd, executionCwd: cwd })
  }

  /** The installed build moves on and a cutover answers at once, since no
   *  running command delays it: the service interrupts its work, hands its
   *  commands over, and exits with the code that tells its service manager
   *  to restart it. */
  const replace = async (): Promise<void> => {
    setInstalledBuild(`build-${crypto.randomUUID()}`, "1.0.0")
    expect(await requestCutover()).toBe("retiring")
    await until("service withdrawn", serviceListening, (listening) => !listening)
    expect(await joinIsolatedAccountService(userDataRoot)).toBe(SERVE_EXIT.restart)
  }

  /** A client of `projectRoot` that attaches to the service listening now
   *  and never asks it to make way, as a surface that was already open does
   *  while a replacement drains. */
  const attachWhileDraining = async (projectRoot: string) => {
    const directories = { ...base, projectRoot, executionCwd: projectRoot, allowPersistentProcesses: false }
    const attach = createAccountRuntimeAttach(directories)
    return await launchRuntimeClient({ ...directories, attach: { ...attach, ensure: async () => {} } })
  }

  const attach = (projectRoot: string) => attachAccountProject({ ...base, executionCwd: projectRoot, projectRoot })

  const readStore = <T>(projectRoot: string, read: (reader: ReturnType<typeof openReadonlyEventReader>) => T): T =>
    readStoreFile(resolveEventStoreDbFile(projectRoot), read)

  /** The live continuation rows of each session in a project's store. */
  const continuationRows = (projectRoot: string, sessionIds: readonly string[]): Map<string, readonly { readonly [key: string]: unknown }[]> =>
    readStore(projectRoot, (reader) => new Map(sessionIds.map((sessionId) => [sessionId, reader.readInFlight(sessionId, CONTINUATION_KIND).map((row) => row.payload)])))

  /** Every continuation row a project's store holds, by session. */
  const allContinuationSessions = (projectRoot: string): readonly string[] => readStore(projectRoot, (reader) => reader.sessionsWithInFlight(CONTINUATION_KIND))

  /** Every session of a project's store that holds a command handover row. */
  const handoverSessions = (projectRoot: string): readonly string[] => readStore(projectRoot, (reader) => reader.sessionsWithInFlight(COMMAND_HANDOVER_KIND))

  /** How many entries of a session's conversations carry `marker`, which
   *  for a fixture command's output only its completion does. */
  const entriesCarrying = (projectRoot: string, sessionId: string, marker: string): number => readStore(projectRoot, (reader) =>
    reader.read({ sessionId, types: ["chat.entries.appended"] }).flatMap((event) => Array.isArray(event.payload.entries) ? event.payload.entries : [])
      .filter((entry: unknown) => JSON.stringify(entry).includes(marker)).length)

  /** The ids of every conversation entry a session committed, in order. */
  const conversationEntryIds = (projectRoot: string, sessionId: string): readonly string[] => readStore(projectRoot, (reader) =>
    reader.read({ sessionId, types: ["chat.entries.appended"] }).flatMap((event) => {
      const entries = event.payload.entries
      return Array.isArray(entries) ? entries.flatMap((entry: unknown) => typeof entry === "object" && entry !== null && "id" in entry && typeof entry.id === "string" ? [entry.id] : []) : []
    }))

  /** The executor process serving `projectRoot` below the listening service.
   *  Its command supervisor names the same role after the payload's `--`,
   *  so the executor is the one whose own program is not that supervisor. */
  const executorOf = async (projectRoot: string): Promise<number> => {
    const identity = serviceIdentity()
    if (!identity) throw new Error("no account service identity record")
    const tree = await descendantProcesses(identity.pid)
    const isSupervisor = (argv: readonly string[]): boolean => {
      const own = argv.includes("--") ? argv.slice(0, argv.indexOf("--")) : argv
      return own.includes(EXECUTABLE_ROLES.commandSupervisor) || own.some((arg) => /(?:^|[/\\])owned-command-supervisor(?:\.ts|-[0-9a-f]{16}\.js)$/.test(arg))
    }
    const executor = tree.find((row) => {
      if (!row.argv.includes(EXECUTABLE_ROLES.projectExecutor) || isSupervisor(row.argv)) return false
      if (process.platform !== "win32") return processCwd(row.pid) === projectRoot
      // The executor removes its initialization environment. Its direct
      // supervisor retains the launch DTO and belongs to this same tree.
      const parent = tree.find((candidate) => candidate.pid === row.ppid)
      if (!parent || !isSupervisor(parent.argv)) return false
      const prefix = "FLYWHEEL_PROJECT_EXECUTOR="
      const entry = windowsProcessApi()?.environment(parent.pid)?.find((value) => value.startsWith(prefix))
      if (entry === undefined) return false
      const initialization = decodeProjectExecutorInitialization(JSON.parse(entry.slice(prefix.length)))
      return initialization?.directories.projectRoot === projectRoot
    })
    if (executor === undefined) throw new Error(`no executor serves ${projectRoot}`)
    return executor.pid
  }

  /** Takes the write lock of `projectRoot`'s store, as another writer
   *  would, until the answer is called. The project's service reads the
   *  store meanwhile, and each of its writes waits, so a cut that must write
   *  a continuation row there cannot settle until then. */
  const lockStore = (projectRoot: string): (() => void) => {
    const db = new Database(resolveEventStoreDbFile(projectRoot))
    db.exec("BEGIN IMMEDIATE")
    let locked = true
    return () => {
      if (!locked) return
      locked = false
      db.exec("ROLLBACK")
      db.close()
    }
  }

  /** The handoff rows the account store holds for this lane. */
  const handoffRows = (): readonly { readonly [key: string]: unknown }[] => {
    const file = accountEventStoreDbFile(userDataRoot)
    if (!fs.existsSync(file)) return []
    return readStoreFile(file, (reader) => reader.readInFlight(`serve:${LANE}`, HANDOFF_KIND).map((row) => row.payload))
  }

  fs.mkdirSync(userDataRoot, { recursive: true })
  writeAccountConfig()
  setInstalledBuild("build-old", "0.9.0")
  process.env.FLYWHEEL_TEST_INSTALLED_BUILD_FILE = buildFile

  return {
    tmp, accountHome, userDataRoot, base, provider,
    /** Serves the chat role with `model` from the next service on. */
    useChatModel: writeAccountConfig,
    setInstalledBuild, activateCurrentLink, makeProject, requestCutover, serviceListening, serviceIdentity,
    stopAccountService, killAccountServiceUncleanly, startSuccessor, replace, attach, attachWhileDraining,
    readStore, continuationRows, allContinuationSessions, handoverSessions, entriesCarrying, conversationEntryIds, handoffRows, executorOf, lockStore,
    async dispose(): Promise<void> {
      await stopAccountService()
      provider.stop()
      delete process.env.FLYWHEEL_TEST_INSTALLED_BUILD_FILE
      if (!process.env.FW_KEEP_TMP) fs.rmSync(tmp, { recursive: true, force: true })
    },
  }
}
