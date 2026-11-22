/**
 * Qualification that no launch of the bundled Antigravity CLI (`agy`) reaches a system keychain that can show the
 * person a dialog (plan M6a, P16). The real engine starts on a fresh login with Flywheel's separated environment and
 * no credential, which is the state of every first launch and of every sign-in: agy 1.5.14 then reads its keyring at
 * startup. On macOS the engine runs in a sandbox that reports each `/usr/bin/security` launch and each access of the
 * process tree to a keychain or a keychain settings file, wherever it lies, and that refuses every access to the
 * keychains and the keychain settings of the person who runs the tests; the test reads the reports from the unified
 * log. On Linux the engine's own log must name file storage. Windows keeps the token in the Credential Manager, which
 * shows no dialog (checked live, M15).
 */
import { afterAll, describe, expect, test } from "bun:test"
import { randomBytes } from "node:crypto"
import { mkdirSync, readFileSync, realpathSync } from "node:fs"
import { userInfo } from "node:os"
import { basename, dirname, join } from "node:path"
import { antigravityEnginePath, separatedAntigravityEnvironment } from "../../../../../src/infra/antigravity-engine.js"
import { ownedCommandRunner } from "../../../../../src/infra/owned-command.js"
import { createLauncherScope, createProcessSupervisor, guardianCommand } from "../../../../../src/infra/process-supervisor.js"
import { keychainReachedFailure, prepareTokenStore, tokenStoreObservation } from "../../../../../src/orchestration/modules/provider-google-antigravity/token-store.js"
import { temporaryDirectories } from "../../../../helpers/directories.js"

/** The two requests the test sends the engine: the handshake, then a session that a fresh login refuses. */
interface InitializeParams {
  readonly protocolVersion: number
  readonly clientCapabilities: { readonly [capability: string]: never }
  readonly clientInfo: { readonly name: string; readonly version: string }
}
interface NewSessionParams {
  readonly cwd: string
  readonly mcpServers: readonly []
}
type JsonRpcParams = InitializeParams | NewSessionParams

const temporary = temporaryDirectories()
const supervisor = createProcessSupervisor({ guardianCommand: guardianCommand() })
const launcher = createLauncherScope(supervisor)
const run = ownedCommandRunner(launcher)
afterAll(async () => {
  await launcher.close()
  await supervisor.dispose()
})

const person = userInfo()
const SECURITY = "/usr/bin/security"
const KEYCHAIN = "flywheel-agy.keychain-db"
/** The longest wait for one engine reply: agy answers `initialize` and `session/new` in a few seconds. */
const REPLY_DEADLINE_MS = 30_000

/** Starts the engine on `loginDir` through `prefix` (a sandbox, or nothing), asks it for a session as a client does,
 *  and returns its log lines once it has exited. Without a login, `session/new` fails with `Authentication required`.
 *  The engine is owned by the test's launcher scope, and its input closes and its exit is awaited on every path. */
async function launchWithoutLogin(loginDir: string, prefix: readonly string[]): Promise<readonly string[]> {
  const environment = separatedAntigravityEnvironment({ account: { home: person.homedir, user: person.username }, platform: process.platform, hostEnvironment: process.env }, loginDir)
  const workspace = join(loginDir, "workspace")
  for (const folder of [workspace, environment.TMPDIR ?? ""]) mkdirSync(folder, { recursive: true })
  const logFile = join(loginDir, "engine.log")
  const engine = await launcher.spawnOwned([...prefix, antigravityEnginePath(), "acp", "--disable-telemetry", "--log-file", logFile], { cwd: workspace, env: environment })
  let exited = false
  void engine.exited.then(() => { exited = true })
  const replies = new Map<number, string>()
  const reading = (async () => {
    let buffered = ""
    for await (const chunk of engine.stdout ?? []) {
      buffered += new TextDecoder().decode(chunk)
      const lines = buffered.split("\n")
      buffered = lines.pop() ?? ""
      for (const line of lines) {
        const id = /"id":(\d+)/u.exec(line)?.[1]
        if (id !== undefined) replies.set(Number(id), line)
      }
    }
  })()
  const request = async (id: number, method: string, params: JsonRpcParams) => {
    engine.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
    await engine.stdin?.flush()
    const deadline = Date.now() + REPLY_DEADLINE_MS
    while (!replies.has(id)) {
      if (exited) throw new Error(`the engine exited before it answered ${method}`)
      if (Date.now() > deadline) throw new Error(`the engine did not answer ${method} within ${String(REPLY_DEADLINE_MS)}ms`)
      await Bun.sleep(20)
    }
    return replies.get(id) ?? ""
  }
  try {
    await request(1, "initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "flywheel-qualification", version: "0" } })
    expect(await request(2, "session/new", { cwd: workspace, mcpServers: [] })).toContain("Authentication required")
  } finally {
    // An orderly end first, which agy honors; a stop only when it does not exit, so cleanup never removes the login
    // directory under a running engine.
    await engine.stdin?.end()
    const ended = await Promise.race([engine.exited.then(() => true), Bun.sleep(REPLY_DEADLINE_MS).then(() => false)])
    if (!ended) await engine.terminate()
    await reading
  }
  return readFileSync(logFile, "utf8").split("\n")
}

/** The sandbox reports since `start` of the processes named `names`, by process: each line reads
 *  `<allow|deny> <operation> <path>`. */
async function sandboxReports(start: Date, names: readonly string[]): Promise<Map<string, string[]>> {
  // `--last` and not `--start`: `log` reads a start time in the system's time zone, which this process need not share.
  const shown = await run(["/usr/bin/log", "show", "--last", `${String(Math.ceil((Date.now() - start.getTime()) / 1_000))}s`, "--style", "compact", "--predicate", 'subsystem == "com.apple.sandbox.reporting"'], { timeoutMs: 30_000, maxOutputBytes: 64 * 1024 * 1024 })
  const reports = new Map<string, string[]>()
  for (const line of shown.stdout.split("\n")) {
    const report = / Sandbox: (\S+)\((\d+)\) ((?:allow|deny)\S*) (\S+) (.+)$/u.exec(line)
    if (report === null) continue
    const [, name = "", pid = "", action = "", operation = "", path = ""] = report
    if (!names.includes(name)) continue
    const key = `${name}(${pid})`
    reports.set(key, [...(reports.get(key) ?? []), `${action.replace(/\(.*$/u, "")} ${operation} ${path}`])
  }
  return reports
}

/** The reports once the unified log has all of them: the same count on two reads in a row, after at least one. */
async function settledReports(start: Date, names: readonly string[]): Promise<Map<string, string[]>> {
  let reports = new Map<string, string[]>()
  let previous = -1
  for (let attempt = 0; attempt < 20; attempt++) {
    await Bun.sleep(500)
    reports = await sandboxReports(start, names)
    const count = [...reports.values()].reduce((total, lines) => total + lines.length, 0)
    if (count > 0 && count === previous) return reports
    previous = count
  }
  return reports
}

const pidOf = (process: string) => Number(/\((\d+)\)$/u.exec(process)?.[1])

/** The sandbox profile of a login's engine: it reports every `security` launch and every access to the login's
 *  `Library`, to any keychain file or keychain folder, and to any keychain settings file, and refuses every access to
 *  the person's keychains and keychain settings. The last rule that matches decides. */
function sandboxProfile(library: string): string {
  const quote = (path: string) => JSON.stringify(path)
  return [
    "(version 1)(allow default)",
    `(allow process-exec (literal ${quote(SECURITY)}) (with report))`,
    `(allow file-read* file-write* (subpath ${quote(library)}) (regex #"[.]keychain") (regex #"/Keychains(/|$)") (regex #"com[.]apple[.]security[.]plist$") (with report))`,
    `(deny file-read* file-write* (subpath ${quote(join(person.homedir, "Library", "Keychains"))}) (literal ${quote(join(person.homedir, "Library", "Preferences", "com.apple.security.plist"))}))`,
  ].join("")
}

/** The system keychain and its folder, which every `security` process reads from its dynamic search list. Reading
 *  them shows no dialog: they are always present, and they hold no item of the engine. */
const SYSTEM_KEYCHAIN_PATHS = new Set(["/Library/Keychains", "/Library/Keychains/System.keychain"])

/** Every report of `reports` that names a keychain, a keychain folder, or a keychain settings file, or a file beside
 *  one (such as a temporary copy), other than the login's private keychain, its settings, and its folder with the
 *  framework's temporary files (`.fl<hex>`, a save of the keychain), and other than a read of the system keychain;
 *  and every refusal. */
function foreignKeychainAccess(reports: Iterable<readonly [string, readonly string[]]>, library: string): string[] {
  const ownFolder = join(library, "Keychains")
  const own = [join(ownFolder, KEYCHAIN), join(library, "Preferences", "com.apple.security.plist")]
  const foreign: string[] = []
  for (const [process, lines] of reports) {
    for (const line of lines) {
      const [action = "", operation = "", ...words] = line.split(" ")
      const path = words.join(" ")
      const keychainPath = /[.]keychain|\/Keychains(\/|$)|com[.]apple[.]security[.]plist/u.test(path)
      const ownPath = path === ownFolder || own.some((file) => path.startsWith(file)) || (dirname(path) === ownFolder && !basename(path).includes(".keychain"))
      const allowed = action === "allow" && (!keychainPath || ownPath || (SYSTEM_KEYCHAIN_PATHS.has(path) && operation.startsWith("file-read")))
      if (!allowed) foreign.push(`${process} ${line}`)
    }
  }
  return foreign
}

describe.if(process.platform === "darwin")("the engine on macOS", () => {
  test("keeps every keychain call in the login's private keychain, also after the keychain was locked, and never touches another keychain", async () => {
    // The sandbox and `security` name real paths, and the temporary directory lies behind a link (/var).
    const loginDir = join(realpathSync(temporary("antigravity-keychain-")), "login")
    const home = join(loginDir, "home")
    const library = join(home, "Library")
    const ownKeychain = join(library, "Keychains", KEYCHAIN)
    const personKeychains = ["list-keychains", "default-keychain"].map((verb) => [SECURITY, verb, "-d", "user"])
    const personBefore = await Promise.all(personKeychains.map(async (command) => (await run(command, { env: { HOME: person.homedir } })).stdout))
    expect(await prepareTokenStore(loginDir, { platform: "darwin", run })).toBe("private-keychain")
    // A restart or a sleep leaves the keychain locked; the preparation before the next launch must unlock it.
    expect((await run([SECURITY, "lock-keychain", KEYCHAIN], { env: { HOME: home } })).exitCode).toBe(0)
    expect(await prepareTokenStore(loginDir, { platform: "darwin", run })).toBe("private-keychain")
    const profile = sandboxProfile(library)
    const engineName = basename(antigravityEnginePath())
    const launched = new Date(Date.now() - 1_000)

    const logLines = await launchWithoutLogin(loginDir, ["/usr/bin/sandbox-exec", "-p", profile])

    // A child of the engine carries the engine's name until it runs `security`.
    const reports = await settledReports(launched, [engineName, "security"])
    const keychainCalls = new Set([...reports].filter(([, lines]) => lines.includes(`allow process-exec* ${SECURITY}`)).map(([process]) => pidOf(process)))
    const tree = [...reports].filter(([process]) => process.startsWith(`${engineName}(`) || keychainCalls.has(pidOf(process)))
    // agy reads its keyring at startup: a run with no `security` call would prove nothing.
    expect(keychainCalls.size).toBeGreaterThan(0)
    for (const pid of keychainCalls) {
      expect(reports.get(`security(${String(pid)})`) ?? []).toContain(`allow file-read-data ${ownKeychain}`)
      expect(reports.get(`security(${String(pid)})`) ?? []).toContain(`allow file-read-data ${join(library, "Preferences", "com.apple.security.plist")}`)
    }
    expect(foreignKeychainAccess(tree, library)).toEqual([])
    expect(keychainReachedFailure(tokenStoreObservation(logLines))).toBeUndefined()

    // The engine's keyring library writes and reads its token with these `security` commands (agy 1.5.14), which a
    // signed-out engine does not reach; a synthetic item takes the token's place.
    const engineCommand = async (args: readonly string[], stdin?: string) => run(["/usr/bin/sandbox-exec", "-p", profile, SECURITY, ...args], { env: { HOME: home }, timeoutMs: 15_000, ...(stdin === undefined ? {} : { stdin }) })
    const token = randomBytes(16).toString("hex")
    const stored = new Date(Date.now() - 1_000)
    const written = await engineCommand(["-i"], `add-generic-password -U -s flywheel-qualification -a ${basename(loginDir)} -w ${token}\n`)
    const read = await engineCommand(["find-generic-password", "-s", "flywheel-qualification", "-wa", basename(loginDir)])
    expect({ written: written.exitCode, read: read.exitCode, timedOut: written.timedOut || read.timedOut, token: read.stdout.trim() }).toEqual({ written: 0, read: 0, timedOut: false, token })
    // The window starts before `stored`, so it can hold late reports of the launch's processes; those are not the store's.
    const storeReports = new Map([...(await settledReports(stored, ["security"]))].filter(([process]) => !reports.has(process)))
    expect(storeReports.size).toBe(2)
    for (const lines of storeReports.values()) expect(lines).toContain(`allow file-read-data ${ownKeychain}`)
    expect(foreignKeychainAccess(storeReports, library)).toEqual([])

    expect(await Promise.all(personKeychains.map(async (command) => (await run(command, { env: { HOME: person.homedir } })).stdout))).toEqual(personBefore)

    // Negative control: a keychain next to the private one is foreign. It is new, so it is unlocked.
    expect((await run([SECURITY, "-i"], { env: { HOME: home }, stdin: "create-keychain -p control other.keychain-db\n" })).exitCode).toBe(0)
    const controlled = new Date(Date.now() - 1_000)
    expect((await engineCommand(["show-keychain-info", "other.keychain-db"])).exitCode).toBe(0)
    expect(foreignKeychainAccess(await settledReports(controlled, ["security"]), library).some((line) => line.endsWith(join(library, "Keychains", "other.keychain-db")))).toBe(true)
  }, 120_000)
})

describe.if(process.platform === "linux")("the engine on Linux", () => {
  test("keeps its token in a file of its home, because its environment names no session bus", async () => {
    const loginDir = join(temporary("antigravity-keychain-"), "login")
    expect(await prepareTokenStore(loginDir, { platform: "linux", run })).toBe("engine-file")

    const observation = tokenStoreObservation(await launchWithoutLogin(loginDir, []))

    expect(observation).toEqual({ fileStorageReason: "no D-Bus session bus detected", keyringFailures: [] })
  }, 60_000)
})
