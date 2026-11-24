import type { FileSink } from "bun"
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { AntigravityEngineHost } from "../../../../../src/infra/antigravity-engine.js"
import type { ExternalLoginPorts } from "../../../../../src/infra/llm/access/access-provider.js"
import type { OwnedProcess, OwnedProcessExit } from "../../../../../src/infra/supervision/launch/owned-subprocess.js"
import type { LauncherScope } from "../../../../../src/infra/process-supervisor.js"
import { gateHookHandler } from "../../../../../src/orchestration/modules/provider-google-antigravity/engine/hook-command.js"
import type { AntigravityProfile } from "../../../../../src/orchestration/modules/provider-google-antigravity/login/login.js"
import { createLoginObservations, type LoginObservations } from "../../../../../src/orchestration/modules/provider-google-antigravity/login/login-status.js"

export const AGY = "/scratch/bin/agy"
export const SIGN_IN_URL = "https://accounts.google.com/o/oauth2/auth?client_id=agy&code_challenge=c&state=s"
/** The code that the fake agy accepts; any other pasted line fails its sign-in. */
export const GOOD_CODE = "4/good-code"

/** One launch through the fake launcher: its argv, the variables it ran with, and its working directory. */
export interface FakeLaunch {
  readonly command: readonly string[]
  readonly env: { readonly [name: string]: string | undefined }
  readonly cwd: string | undefined
}

/** One JSON-RPC request that the fake agy reads, and one answer that it writes. */
interface FakeRequest {
  readonly id: number
  readonly method: string
  readonly params: unknown
}
interface FakeReply {
  readonly id: number
  readonly result?: unknown
  readonly error?: { readonly code: number; readonly message: string }
}

function stream() {
  let controller!: ReadableStreamDefaultController<Uint8Array>
  let closed = false
  // A reader that cancels the stream, as an ACP connection does when it closes, closes it too.
  const readable = new ReadableStream<Uint8Array>({ start(handle) { controller = handle }, cancel() { closed = true } })
  return {
    readable,
    write: (text: string) => { if (!closed) controller.enqueue(new TextEncoder().encode(text)) },
    close: () => { if (!closed) { closed = true; controller.close() } },
  }
}

/** The log line with which agy 1.5.14 names the account that signed in. */
function signedInLine(identity: string): string {
  return `I1121 22:23:16.013514      44 server_oauth.go:226] OAuth: authenticated successfully as ${identity}\n`
}

/**
 * A launcher that plays every program a login runs: `git init` (makes the repository), `/usr/bin/security` (keeps
 * each `HOME`'s search list and default keychain, as the real one does), `agy acp --login` (prints agy 1.5.14's
 * sign-in text, takes one pasted line, and on `GOOD_CODE` names `identity()` in its log and exits 0; any other line
 * or the end of its input fails as agy does), and `agy acp` (answers `initialize`, `authenticate`, which names
 * `identity()` in its log or, with `noDisplay`, refuses as agy 1.5.14 does on a host with no display, and `logout`,
 * which fails while `logoutFails` is set, and exits at the end of its input).
 * `beforeLogout` runs when a logout request arrives. Every launch, ACP method, and pasted line is recorded.
 */
export function fakeAgy(options: { identity: string; logoutFails?: boolean; keyringLine?: string; noDisplay?: boolean }) {
  const launches: FakeLaunch[] = []
  const methods: { readonly method: string; readonly home: string | undefined; readonly params: unknown }[] = []
  const pasted: string[] = []
  const securitySettings = new Map<string, { list: string[]; fallback: string[] }>()
  const launcher: LauncherScope = {
    spawnOwned: async (command, launchOptions) => {
      const env = launchOptions?.env ?? {}
      launches.push({ command, env, cwd: launchOptions?.cwd })
      const stdout = stream()
      const stderr = stream()
      const exit = Promise.withResolvers<OwnedProcessExit>()
      let exited = false
      const finish = (code: number): void => {
        if (exited) return
        exited = true
        stdout.close()
        stderr.close()
        exit.resolve({ code, signal: null, statusOf: "payload", ownership: "surrendered" })
      }
      const logFile = command[command.indexOf("--log-file") + 1] ?? ""
      const writeLog = (text: string): void => {
        mkdirSync(join(logFile, ".."), { recursive: true })
        appendFileSync(logFile, text)
      }
      let onLine: (line: string) => void = () => {}
      let onEnd: () => void = () => finish(0)
      let buffered = ""
      const stdin: FileSink = {
        write: (chunk) => {
          buffered += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)
          const lines = buffered.split("\n")
          buffered = lines.pop() ?? ""
          for (const line of lines) onLine(line)
          return 0
        },
        flush: () => 0,
        end: () => { queueMicrotask(onEnd); return 0 },
        start: () => {},
        ref: () => {},
        unref: () => {},
      }
      if (command[0] === "git") {
        mkdirSync(join(command.at(-1) ?? "", ".git"), { recursive: true })
        queueMicrotask(() => finish(0))
      } else if (command[0] === "/usr/bin/security") {
        const home = env.HOME ?? ""
        const words = command[1] === "-i" ? [] : command.slice(1)
        onLine = (line) => {
          const [verb, ...rest] = line.trim().split(" ")
          const name = rest.at(-1)
          if (verb === "create-keychain") writeFileSync(join(home, "Library", "Keychains", name ?? ""), "keychain")
        }
        const state = securitySettings.get(home) ?? { list: [], fallback: [] }
        securitySettings.set(home, state)
        const [verb] = words
        const keychain = (name: string) => join(home, "Library", "Keychains", name)
        if (verb === "list-keychains" && words.includes("-s")) state.list = [keychain(words.at(-1) ?? "")]
        else if (verb === "list-keychains") stdout.write(state.list.map((path) => `    "${path}"\n`).join(""))
        if (verb === "default-keychain" && words.includes("-s")) state.fallback = [keychain(words.at(-1) ?? "")]
        else if (verb === "default-keychain") stdout.write(state.fallback.map((path) => `    "${path}"\n`).join(""))
        if (command[1] !== "-i") queueMicrotask(() => finish(0))
      } else if (command.includes("--login")) {
        writeLog("I1121 browser.go:56] consumerOAuth: starting OAuth flow\n")
        if (options.keyringLine !== undefined) writeLog(`${options.keyringLine}\n`)
        stdout.write(`Open this link in a browser to log in with Google:\n  ${SIGN_IN_URL}\nThen paste the authorization code, or the full URL of the page you land on, and press Enter:\n`)
        onLine = (line) => {
          pasted.push(line)
          if (line === GOOD_CODE) {
            writeLog(signedInLine(options.identity))
            finish(0)
          } else {
            stdout.write("couldn't log in: token exchange failed: invalid_grant\n")
            finish(1)
          }
        }
        onEnd = () => {
          stdout.write("login cancelled: no authorization code was entered\n")
          finish(1)
        }
      } else {
        const reply = (frame: FakeReply) => stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...frame })}\n`)
        onLine = (line) => {
          const request: FakeRequest = JSON.parse(line)
          methods.push({ method: request.method, home: env.HOME, params: request.params })
          switch (request.method) {
            case "initialize":
              reply({ id: request.id, result: { protocolVersion: 1, agentCapabilities: { auth: { logout: {} } }, authMethods: [{ id: "oauth-personal", name: "Log in with Google" }], agentInfo: { name: "Antigravity ACP Server", version: "1.5.14" } } })
              return
            case "authenticate":
              if (options.noDisplay === true) {
                reply({ id: request.id, error: { code: -32603, message: "No browser is available here (no graphical display is available to open a browser). Run `agy acp --login` in a terminal on this machine, then retry; or use a Gemini API key." } })
                return
              }
              writeLog(signedInLine(options.identity))
              reply({ id: request.id, result: {} })
              return
            case "logout":
              if (options.logoutFails === true) reply({ id: request.id, error: { code: -32603, message: "logout failed" } })
              else reply({ id: request.id, result: {} })
              return
            default:
              reply({ id: request.id, error: { code: -32601, message: `Method not found: ${request.method}` } })
          }
        }
      }
      const owned: OwnedProcess = {
        pid: 4242,
        token: "token",
        stdin,
        stdout: stdout.readable,
        stderr: stderr.readable,
        exited: exit.promise,
        terminate: async () => { finish(143); return await exit.promise },
      }
      return owned
    },
    adoptOwned: () => Promise.reject(new Error("no adoption")),
    open: () => launcher,
    close: async () => ({ settled: true }),
  }
  return { launcher, launches, methods, pasted, agyLaunches: () => launches.filter((launch) => launch.command[0] === AGY) }
}

/** The engine host of one test: the test's own OS account home, `platform`, and no host variables. */
export function engineHost(home: string, platform: NodeJS.Platform = "linux"): AntigravityEngineHost {
  return { account: { home, user: "tester" }, platform, hostEnvironment: { PATH: "/usr/bin:/bin" } }
}

/** The logins of the profile in `authDir`, on the fake engine. `withLoginReleased` runs its work at once unless
 *  given. */
export function profile(authDir: string, host: AntigravityEngineHost, observations: LoginObservations = createLoginObservations(), withLoginReleased: AntigravityProfile["withLoginReleased"] = async (_loginDir, _signal, work) => await work()): AntigravityProfile {
  return {
    authDir,
    host,
    enginePath: () => AGY,
    gateHook: (loginDir) => gateHookHandler({ address: join(loginDir, "gate"), loginGateId: "gate", entry: ["/opt/flywheel/flywheel", "--internal-role=antigravity-gate"], platform: "linux" }),
    withLoginReleased,
    observations,
  }
}

/** Login ports of a person who pastes `code` once agy shows its URL, from a client with no browser on this machine. */
export function pastePorts(launcher: LauncherScope, code = GOOD_CODE, extra: Partial<ExternalLoginPorts> = {}) {
  const urls: string[] = []
  const ports: ExternalLoginPorts = {
    launcher,
    onAuthorizeUrl: ({ url }) => { urls.push(url) },
    onManualCodeInput: async () => `  ${code}\n`,
    ...extra,
  }
  return { ports, urls }
}
