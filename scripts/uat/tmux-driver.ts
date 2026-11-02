import { spawnSync } from "node:child_process"
import { basename, dirname } from "node:path"

import { stopHarnessProcesses } from "../../tests/helpers/real-process-fixture.js"

const PANE_WIDTH = "160"
const PANE_HEIGHT = "40"

export interface LaunchOptions {
  /** Socket of the private tmux server that holds the session. See `tmuxCommand`. */
  server: string
  sessionName: string
  binaryPath: string
  workDir: string
  stderrFile: string
  home?: string
  projectRoot?: string
  env?: { [name: string]: string }
  /** Command-line arguments after the binary, such as `--remote`. */
  args?: readonly string[]
}

export interface PollOutcome {
  elapsedMs: number
  capture: string
}

export class PanePollError extends Error {
  constructor(message: string, readonly lastCapture: string) {
    super(message)
  }
}

export type SgrMouseAction = "hover" | "press" | "release"

export interface TmuxApp {
  /** Whether the session still holds the app pane, independent of its reaper. */
  hasPane(): boolean
  capture(): string
  captureHistory(): string
  sendKeys(...keys: string[]): void
  sendLiteral(text: string): void
  submit(): Promise<void>
  sendText(text: string): Promise<void>
  /** Send an SGR mouse action at one-based pane coordinates. */
  mouse(action: SgrMouseAction, column: number, row: number): void
  /** Click at one-based pane coordinates. */
  click(column: number, row: number): void
  /** Click visible text. The last match can select a modal over transcript text. */
  clickText(text: string, last?: boolean): void
  /** Hover at one-based pane coordinates. */
  hover(column: number, row: number): void
  pollPane(label: string, predicate: (pane: string) => boolean, timeoutMs: number, intervalMs?: number): Promise<PollOutcome>
  dispose(keepSession?: boolean): void
}

/** One tmux client invocation: its arguments and working directory. */
export interface TmuxCommand {
  argv: string[]
  cwd: string | undefined
}

/** How to run one tmux command against the private server whose socket is
 *  `server`: the argv and the working directory of the tmux client.
 *
 *  A pane starts with its server's global environment, which is the
 *  environment of whatever process first started that server. On the shared
 *  default server, another run's variables, such as FLYWHEEL_AUTH_PROFILE,
 *  reached every launch. A server of its own gives a pane only the harness
 *  environment and the launch prefix. The server exits with its last session;
 *  tmux leaves the socket file in the run directory.
 *
 *  A unix socket path holds at most 104 bytes on macOS, and a run directory
 *  under a scratchpad or the macOS temporary directory is longer than that.
 *  tmux binds and connects the path exactly as given, so the client runs in
 *  the socket's directory and names the socket relative to it.
 *
 *  psmux, which provides tmux on Windows, accepts `-S` but still puts the
 *  session in its default namespace (verified with psmux 3.3.8), so Windows
 *  passes no socket. psmux runs one server per session, and in the same probe
 *  that server's global environment held only psmux's own variables, so no
 *  other run's environment reaches a Windows pane. */
export function tmuxCommand(server: string, args: readonly string[], platform: NodeJS.Platform = process.platform): TmuxCommand {
  if (platform === "win32") return { argv: [...args], cwd: undefined }
  return { argv: ["-S", basename(server), ...args], cwd: dirname(server) }
}

function tmux(server: string, args: string[]): string {
  const { argv, cwd } = tmuxCommand(server, args)
  const result = spawnSync("tmux", argv, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    // Standby shells retain the disposable directory after the pane is closed.
    env: process.platform === "win32" ? { ...process.env, PSMUX_NO_WARM: "1" } : undefined,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`tmux ${args.join(" ")} failed (${result.status}): ${result.stderr}`)
  return result.stdout
}

export function sleep(ms: number): Promise<void> {
  return Bun.sleep(ms)
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

/** A PowerShell single-quoted literal: the one escape is a doubled quote. */
function powershellQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

export function encodeSgrMouse(action: SgrMouseAction, column: number, row: number): string {
  if (!Number.isInteger(column) || !Number.isInteger(row) || column < 1 || row < 1) {
    throw new Error("mouse coordinates must be positive integers")
  }
  if (action === "hover") return `\u001b[<35;${column};${row}M`
  return `\u001b[<0;${column};${row}${action === "press" ? "M" : "m"}`
}

/** Serialize a launch with owned isolation variables taking precedence over
 *  scenario settings. tmux hands the line to a POSIX shell; psmux, which
 *  provides tmux on Windows, hands it to PowerShell, which redirects a native
 *  program's stderr to a file byte for byte. */
export function launchCommand(options: LaunchOptions, platform: NodeJS.Platform = process.platform): string {
  const env = {
    FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS: process.env.FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS ?? "1",
    ...options.env,
    HOME: options.home ?? options.workDir,
    FLYWHEEL_PROJECT_ROOT: options.projectRoot ?? options.workDir,
    FLYWHEEL_DISABLE_AUTOUPDATE: "1",
    FLYWHEEL_BOOT_TRACE: "1",
  }
  if (platform === "win32") {
    const assignments = Object.entries(env).map(([key, value]) => `$env:${key}=${powershellQuote(value)};`).join(" ")
    return `${assignments} & ${[options.binaryPath, ...options.args ?? []].map(powershellQuote).join(" ")} 2> ${powershellQuote(options.stderrFile)}`
  }
  const envPrefix = Object.entries(env).map(([key, value]) => `${key}=${shellQuote(value)}`).join(" ")
  return `env ${envPrefix} ${[options.binaryPath, ...options.args ?? []].map(shellQuote).join(" ")} 2>${shellQuote(options.stderrFile)}`
}

export function launchApp(options: LaunchOptions): TmuxApp {
  tmux(options.server, ["new-session", "-d", "-s", options.sessionName, "-n", "app", "-x", PANE_WIDTH, "-y", PANE_HEIGHT, "-c", options.workDir, launchCommand(options)])
  return attachApp(options.server, options.sessionName, options.home ?? options.workDir)
}

/** Start an owned companion. Killing the session also ends this process. */
export function startSessionReaper(server: string, sessionName: string, command: string[]): void {
  const quote = process.platform === "win32" ? powershellQuote : shellQuote
  tmux(server, ["new-window", "-d", "-t", sessionName, "-n", "reaper", `${process.platform === "win32" ? "& " : "exec "}${command.map(quote).join(" ")}`])
}

export function killTmuxSession(server: string, sessionName: string): void {
  const { argv, cwd } = tmuxCommand(server, ["kill-session", "-t", sessionName])
  spawnSync("tmux", argv, { cwd, windowsHide: true })
}

/** Attach without recreating the session or changing its selected window. */
export function attachApp(server: string, sessionName: string, home: string): TmuxApp {
  let disposed = false
  const target = `${sessionName}:app`

  const hasPane = (): boolean => tmux(server, ["list-panes", "-s", "-t", sessionName, "-F", "#{window_name}"]).trim().split("\n").includes("app")
  const capture = (): string => tmux(server, ["capture-pane", "-p", "-t", target])
  const captureHistory = (): string => tmux(server, ["capture-pane", "-p", "-S", "-", "-t", target])
  const sendKeys = (...keys: string[]): void => {
    tmux(server, ["send-keys", "-t", target, ...keys])
  }
  const sendLiteral = (text: string): void => sendKeys("-l", "--", text)
  const submit = async (): Promise<void> => {
    await sleep(500)
    sendKeys("Enter")
  }

  async function sendText(text: string): Promise<void> {
    sendLiteral(text)
    await submit()
  }

  function mouse(action: SgrMouseAction, column: number, row: number): void {
    sendLiteral(encodeSgrMouse(action, column, row))
  }

  function click(column: number, row: number): void {
    mouse("press", column, row)
    mouse("release", column, row)
  }

  function hover(column: number, row: number): void {
    mouse("hover", column, row)
  }

  function clickText(text: string, last = false): void {
    if (text.length === 0) throw new Error("click text must not be empty")
    const pane = capture()
    const lines = pane.split("\n")
    const rows = last ? lines.map((_, row) => row).toReversed() : lines.map((_, row) => row)
    for (const row of rows) {
      const line = lines[row]!
      const offset = last ? line.lastIndexOf(text) : line.indexOf(text)
      if (offset < 0) continue
      // tmux captures Unicode text; terminal columns are display cells, not UTF-16 offsets.
      click(Bun.stringWidth(line.slice(0, offset)) + 1, row + 1)
      return
    }
    throw new PanePollError(`visible text not found: ${text}`, pane)
  }

  async function pollPane(label: string, predicate: (pane: string) => boolean, timeoutMs: number, intervalMs = 50): Promise<PollOutcome> {
    const start = performance.now()
    let last = ""
    while (performance.now() - start < timeoutMs) {
      try {
        last = capture()
      } catch (error) {
        throw new PanePollError(`pollPane(${label}) could not capture the pane: ${String(error)}`, last)
      }
      if (predicate(last)) return { elapsedMs: performance.now() - start, capture: last }
      await sleep(intervalMs)
    }
    throw new PanePollError(`pollPane(${label}) timed out after ${timeoutMs}ms; last pane:\n${last}`, last)
  }

  function dispose(keepSession = false): void {
    if (disposed) return
    const remaining = stopHarnessProcesses([home])
    if (remaining.length > 0) throw new Error(`sandbox processes survived stop: ${remaining.map(({ pid }) => pid).join(", ")}`)
    disposed = true
    if (!keepSession) killTmuxSession(server, sessionName)
  }

  return { hasPane, capture, captureHistory, sendKeys, sendLiteral, submit, sendText, mouse, click, clickText, hover, pollPane, dispose }
}

