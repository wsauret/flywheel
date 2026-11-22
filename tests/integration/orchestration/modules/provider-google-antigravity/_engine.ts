/**
 * Runs the real pinned Antigravity CLI (`agy`, from `bun run engine:antigravity:prepare`) through Flywheel's engine
 * process against the in-process fake Gemini host, in API-key mode: the test environment points the engine at the
 * fake (`GOOGLE_GEMINI_BASE_URL`) with a dummy key, and the launch authenticates with `gemini-api-key`. Every engine
 * runs in a login directory under the test's temporary directory, after Flywheel's own token-store preparation, so on
 * macOS it reaches only the login's private keychain (plan M6a).
 */
import { mkdirSync, realpathSync } from "node:fs"
import { userInfo } from "node:os"
import { join } from "node:path"
import { ownedCommandRunner } from "../../../../../src/infra/owned-command.js"
import { createLauncherScope, createProcessSupervisor, guardianCommand } from "../../../../../src/infra/process-supervisor.js"
import { launchEngine, type EngineLaunchOptions, type EngineProcess } from "../../../../../src/orchestration/modules/provider-google-antigravity/engine-process.js"
import { gateHookHandler } from "../../../../../src/orchestration/modules/provider-google-antigravity/hook-command.js"
import { openToolListener } from "../../../../../src/orchestration/modules/provider-google-antigravity/mcp-server.js"
import { openStepGate, type StepGate, type StepGateEvent } from "../../../../../src/orchestration/modules/provider-google-antigravity/step-gate.js"
import type { McpToolDeclaration } from "../../../../../src/orchestration/modules/provider-google-antigravity/tool-projection.js"
import { openFakeGemini, type FakeGemini } from "./_fake-gemini.js"

export const ECHO_TOOL: McpToolDeclaration = { name: "echo", description: "Echoes its text.", inputSchema: { type: "object", properties: { text: { type: "string" } } } }

/** One login of the harness: its directory, and its step gate with every answer the gate gave. */
export interface HarnessLogin {
  readonly loginDir: string
  readonly gate: StepGate
  readonly gateEvents: StepGateEvent[]
  readonly launch: (options?: Partial<Pick<EngineLaunchOptions, "tools" | "testSeams" | "authMethod">>) => Promise<EngineProcess>
}

export interface EngineHarness {
  readonly fake: FakeGemini
  readonly run: ReturnType<typeof ownedCommandRunner>
  login(name: string): Promise<HarnessLogin>
  /** The command lines of the running `agy acp` processes of `loginDir`. */
  engineProcesses(loginDir: string): Promise<readonly string[]>
  close(): Promise<void>
}

/** Opens the harness in `root`, an empty directory that the test removes. Unix socket paths are short, so `root` should
 *  be too. `fake` configures the fake Gemini host. */
export function openEngineHarness(root: string, fake: Parameters<typeof openFakeGemini>[0] = {}): EngineHarness {
  const base = realpathSync(root)
  const supervisor = createProcessSupervisor({ guardianCommand: guardianCommand() })
  const launcher = createLauncherScope(supervisor)
  const run = ownedCommandRunner(launcher)
  const host = openFakeGemini(fake)
  const toolListener = openToolListener()
  const gates: StepGate[] = []
  const engines: EngineProcess[] = []
  const person = userInfo()
  return {
    fake: host,
    run,
    async login(name) {
      const loginDir = join(base, name)
      mkdirSync(loginDir, { recursive: true })
      const address = process.platform === "win32" ? `\\\\.\\pipe\\fw-agy-test-${String(process.pid)}-${name}` : join(base, `${name}.sock`)
      const gateId = `gate-${name}`
      const gate = await openStepGate({ address, gateId })
      gates.push(gate)
      const gateEvents: StepGateEvent[] = []
      gate.onEvent((event) => { gateEvents.push(event) })
      return {
        loginDir,
        gate,
        gateEvents,
        async launch(options = {}) {
          const engine = await launchEngine({
            loginDir,
            launcher,
            host: { account: { home: person.homedir, user: person.username }, platform: process.platform, hostEnvironment: process.env, testEnvironment: { GOOGLE_GEMINI_BASE_URL: host.url, GEMINI_API_KEY: "flywheel-fake-key" } },
            gateHook: gateHookHandler({ address, loginGateId: gateId }),
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
      const listed = process.platform === "win32"
        ? await run(["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { $_.CommandLine }"])
        : await run(["ps", "-axo", "command"])
      // The container that owns each engine names the engine's command too; only the engine runs `agy` itself.
      return listed.stdout.split(/\r?\n/u).filter((line) => line.includes(loginDir) && /^\s*"?[^"\s]*[\\/]agy(?:\.exe)?"? acp\b/u.test(line))
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
