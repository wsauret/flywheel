/**
 * Runs the real pinned Antigravity CLI (`agy`, from `bun run engine:antigravity:prepare`) through Flywheel's engine
 * process against the in-process fake Gemini host, in API-key mode: the test environment points the engine at the
 * fake (`GOOGLE_GEMINI_BASE_URL`) with a dummy key, and the launch authenticates with `gemini-api-key`. Every engine
 * runs in a login directory under the test's temporary directory, after Flywheel's own token-store preparation, so on
 * macOS it reaches only the login's private keychain (plan M6a).
 */
import { afterAll, expect } from "bun:test"
import { mkdirSync, realpathSync } from "node:fs"
import { tmpdir, userInfo } from "node:os"
import { join } from "node:path"
import { antigravityEnginePath } from "../../../../../src/infra/antigravity-engine.js"
import { ownedCommandRunner } from "../../../../../src/infra/owned-command.js"
import { createLauncherScope, createProcessSupervisor, guardianCommand } from "../../../../../src/infra/process-supervisor.js"
import { launchEngine, type EngineLaunchOptions, type EngineProcess } from "../../../../../src/orchestration/modules/provider-google-antigravity/engine/engine-process.js"
import { gateHookHandler, type GateHookHandler } from "../../../../../src/orchestration/modules/provider-google-antigravity/engine/hook-command.js"
import { openToolListener } from "../../../../../src/orchestration/modules/provider-google-antigravity/tools/mcp-server.js"
import { openStepGate, type StepGate, type StepGateEvent } from "../../../../../src/orchestration/modules/provider-google-antigravity/engine/step-gate.js"
import type { McpToolDeclaration } from "../../../../../src/orchestration/modules/provider-google-antigravity/tools/tool-projection.js"
import { openFakeGemini, type FakeGemini } from "./_fake-gemini.js"

export const ECHO_TOOL: McpToolDeclaration = { name: "echo", description: "Echoes its text.", inputSchema: { type: "object", properties: { text: { type: "string" } } } }

/** One login of the harness: its directory, and its step gate with every answer the gate gave. */
export interface HarnessLogin {
  readonly loginDir: string
  readonly gate: StepGate
  readonly gateEvents: StepGateEvent[]
  /** The PreInvocation hook that the login's private home names. */
  readonly gateHook: GateHookHandler
  readonly launch: (options?: Partial<Pick<EngineLaunchOptions, "tools" | "testSeams" | "authMethod">>) => Promise<EngineProcess>
}

export interface EngineHarness {
  readonly fake: FakeGemini
  readonly run: ReturnType<typeof ownedCommandRunner>
  login(name: string): Promise<HarnessLogin>
  /** The command lines of the running `agy acp` processes of `loginDir`. */
  engineProcesses(loginDir: string): Promise<readonly string[]>
  /** Kills the running `agy acp` process of the engine `processId` at once, as a crash would. */
  killEngine(processId: string): Promise<void>
  close(): Promise<void>
}

/** The account that the engines run as: its home, and the environment that the engine's allowlist reads from. */
export interface HarnessPerson {
  readonly home: string
  readonly environment: { readonly [name: string]: string | undefined }
}

/** The `agy acp` processes that run now, with their process ids. */
async function runningEngines(run: ReturnType<typeof ownedCommandRunner>): Promise<readonly { readonly pid: number; readonly command: string }[]> {
  const listed = await run(PROCESS_LIST)
  return engineLines({ ...listed, truncated: listed.stdoutTruncated === true })
}

const PROCESS_LIST = process.platform === "win32"
  ? ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.CommandLine)\" }"]
  : ["ps", "-axo", "pid=,command="]

/** Fails the suite when it leaves an `agy acp` process running on a login in the temporary directory. The guarded
 *  runner gives the suite its own temporary directory and fails it for any entry left there. */
export function expectNoEngineLeft(): void {
  afterAll(() => {
    const temporary = realpathSync(tmpdir())
    const listed = Bun.spawnSync(PROCESS_LIST, { stdout: "pipe", stderr: "inherit", windowsHide: true })
    expect(engineLines({ exitCode: listed.exitCode, stdout: listed.stdout.toString(), truncated: false }).filter(({ command }) => command.includes(temporary)).map(({ command }) => command)).toEqual([])
  })
}

/** The `agy acp` processes of a process list. Every harness launches the pinned engine, so an engine's command line
 *  starts with its path, which the list quotes when the path holds a space; the container that owns each engine names
 *  the engine's command later in its own. A list that failed or was cut fails the caller, so a check never passes on an
 *  empty list. */
function engineLines(listed: { readonly exitCode: number | null; readonly stdout: string; readonly truncated: boolean }): readonly { readonly pid: number; readonly command: string }[] {
  if (listed.exitCode !== 0 || listed.truncated) throw new Error(`the process list failed (exit ${String(listed.exitCode)}, cut: ${String(listed.truncated)})`)
  const engine = antigravityEnginePath()
  const starts = [`${engine} acp `, `"${engine}" acp `]
  return listed.stdout.split(/\r?\n/u).flatMap((line) => {
    const [, pid, command] = /^\s*(\d+) (.*)$/u.exec(line) ?? []
    return pid !== undefined && command !== undefined && starts.some((start) => command.startsWith(start)) ? [{ pid: Number(pid), command }] : []
  })
}

/** Opens the harness in `root`, an empty directory that the test removes. Unix socket paths are short, so `root` should
 *  be too. `fake` configures the fake Gemini host; `person` replaces the account of this process (its home and its
 *  environment). */
export function openEngineHarness(root: string, fake: Parameters<typeof openFakeGemini>[0] = {}, person?: HarnessPerson): EngineHarness {
  const base = realpathSync(root)
  const supervisor = createProcessSupervisor({ guardianCommand: guardianCommand() })
  const launcher = createLauncherScope(supervisor)
  const run = ownedCommandRunner(launcher)
  const host = openFakeGemini(fake)
  const toolListener = openToolListener()
  const gates: StepGate[] = []
  const engines: EngineProcess[] = []
  const account = { home: person?.home ?? userInfo().homedir, user: userInfo().username }
  const hostEnvironment = person?.environment ?? process.env
  return {
    fake: host,
    run,
    async login(name) {
      const loginDir = join(base, name)
      mkdirSync(loginDir, { recursive: true })
      // A login may lie deeper in `root`, such as in an auth profile's directory; its gate lives beside `root`'s own.
      const flat = name.replace(/[^\w-]+/gu, "-")
      const address = process.platform === "win32" ? `\\\\.\\pipe\\fw-agy-test-${String(process.pid)}-${flat}` : join(base, `${flat}.sock`)
      const gateId = `gate-${flat}`
      const gate = await openStepGate({ address, gateId })
      gates.push(gate)
      const gateEvents: StepGateEvent[] = []
      gate.onEvent((event) => { gateEvents.push(event) })
      const gateHook = gateHookHandler({ address, loginGateId: gateId })
      return {
        loginDir,
        gate,
        gateEvents,
        gateHook,
        async launch(options = {}) {
          const engine = await launchEngine({
            loginDir,
            launcher,
            host: { account, platform: process.platform, hostEnvironment, testEnvironment: { GOOGLE_GEMINI_BASE_URL: host.url, GEMINI_API_KEY: "flywheel-fake-key" } },
            gateHook,
            toolListener,
            tools: options.tools ?? [ECHO_TOOL],
            clientInfo: { name: "flywheel", version: "0.0.0-test" },
            authMethod: options.authMethod ?? "gemini-api-key",
            ...(options.testSeams === undefined ? {} : { testSeams: options.testSeams }),
          })
          engines.push(engine)
          return engine
        },
      }
    },
    async engineProcesses(loginDir) {
      return (await runningEngines(run)).flatMap(({ command }) => command.includes(loginDir) ? [command] : [])
    },
    async killEngine(processId) {
      // The engine's log file, which its command line names, carries the engine's process id.
      const found = (await runningEngines(run)).filter(({ command }) => command.includes(`${processId}.log`))
      if (found.length !== 1) throw new Error(`expected one running engine ${processId}, found ${String(found.length)}`)
      process.kill(found[0]!.pid, "SIGKILL")
    },
    async close() {
      await Promise.all(engines.map((engine) => engine.close("test-end")))
      await toolListener.close()
      await Promise.all(gates.map((gate) => gate.dispose()))
      await host.close()
      await launcher.close()
      await supervisor.dispose()
    },
  }
}

/** One text prompt. */
export const text = (value: string) => [{ type: "text", text: value }] as const

/** A session whose updates and tool calls are recorded. */
export async function openRecordedSession(engine: EngineProcess) {
  const updates: string[] = []
  const calls: string[] = []
  const opened = await engine.openSession({
    onUpdate: (update) => { updates.push(update.sessionUpdate) },
    onToolCall: async (call) => {
      calls.push(`${call.name} ${JSON.stringify(call.arguments)}`)
      return { content: [{ type: "text", text: "ok" }] }
    },
  })
  return { sessionId: opened.sessionId, updates, calls }
}

/** Waits until `condition` holds, polling every 20 ms, for at most `ms`. */
export async function eventually(condition: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await condition()) return true
    await Bun.sleep(20)
  }
  return condition()
}
