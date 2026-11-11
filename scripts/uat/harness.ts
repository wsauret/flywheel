import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, utimes, writeFile } from "node:fs/promises"
import { basename, dirname, join, resolve } from "node:path"
import { homedir } from "node:os"
import { fileURLToPath } from "node:url"
import { utimesSync } from "node:fs"
import { createHash } from "node:crypto"
import { Schema } from "effect"
import { copyActiveBuild } from "../../tests/helpers/placed-build.js"
import { RELEASE_HARNESS_ENVIRONMENT } from "../../tests/helpers/real-process-fixture.js"
import { AuthProfileManager, type AuthProfileManagerOptions } from "../../src/orchestration/auth/auth-profile-manager.js"
import { ContainedDirectory } from "../../src/infra/descriptor-directory.js"
import { authDir, requireAuthProfileName } from "../../src/infra/paths.js"
import { resolveInstalledBinary } from "./installed-binary.js"
import { attachApp, INSTALLED_LAUNCH_EXCLUDED_ENV, killTmuxSession, launchApp, PanePollError, startSessionReaper, type PollOutcome, type TmuxApp } from "./tmux-driver.js"
import { writeClaudeLoginReferences } from "../../src/orchestration/modules/provider-claude-agent-sdk/cli-login.js"

const READY_MARKER = "for fresh chat"
const READY_TIMEOUT_MS = 45_000

export interface TuiUatOptions {
  scratchRoot: string
  sourceProjectRoot: string
  config?: string
  /** Overrides launch defaults. Set FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS to "0" only when testing automatic auth or paid-use dialogs. */
  nonSecretEnv?: { readonly [name: string]: string }
  cloneAuth?: boolean
  /** HOME that owns the tested installation, including custom FLYWHEEL_INSTALLED_BINARY launchers. Defaults to the current account HOME. Only its immutable build is staged. */
  installationHome?: string
  /** Idle time without an active command. Defaults to twenty minutes. */
  idleTimeoutMs?: number
}

export interface TuiUatSandbox {
  root: string
  home: string
  project: string
  evidence: string
  stderrFile: string
  /** Socket of the sandbox's private tmux server. It stays outside HOME, which stop removes before it ends the session. */
  tmuxServer: string
  authProfile?: string
}

/** The environment of every installed launch in a sandbox. Its account
 *  service binds an ephemeral hub port, so a UAT run never collides with the
 *  operator's own `flywheel serve` on 41000, and records that origin at one
 *  sandbox path. Whichever launch starts the service, `flywheel web` reads the
 *  same record and opens the sandbox hub. Same contract the release runner
 *  uses (src/cli/release-harness.ts). */
export function sandboxEnvironment(sandbox: Pick<TuiUatSandbox, "root" | "authProfile">, nonSecretEnv?: TuiUatOptions["nonSecretEnv"]) {
  return {
    ...RELEASE_HARNESS_ENVIRONMENT,
    FLYWHEEL_INTERNAL_RELEASE_HUB_PORT: "0",
    FLYWHEEL_INTERNAL_RELEASE_HUB_RECORD: join(sandbox.root, "hub-origin"),
    FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS: "1",
    ...nonSecretEnv,
    ...(sandbox.authProfile === undefined ? {} : { FLYWHEEL_AUTH_PROFILE: sandbox.authProfile }),
  }
}

export interface TuiUatApp extends TmuxApp {
  readonly sandbox: TuiUatSandbox
  readonly sessionName: string
  captureArtifact(name: string): Promise<string>
  captureHistoryArtifact(name: string): Promise<string>
  /** Wait for a loaded selected row, activate it, and return the matched pane. */
  activateSelectedRow(expectedText: string, timeoutMs?: number): Promise<PollOutcome>
}

async function run(command: string[], cwd?: string): Promise<string> {
  const child = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe", windowsHide: true })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) throw new Error(`${command[0]} failed (${exitCode}): ${stderr.trim()}`)
  return stdout.trim()
}

function artifactName(name: string): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/u.test(name)) throw new Error(`invalid artifact name: ${name}`)
  return name
}

function selectedRowIsLoaded(pane: string, expectedText: string): boolean {
  const lines = pane.split("\n")
  const marker = `> ${expectedText}`
  const contentColumn = lines.reduce<number | undefined>((found, line) => {
    if (found !== undefined) return found
    let offset = 0
    while (offset < line.length) {
      const markerColumn = line.indexOf(marker, offset)
      if (markerColumn < 0) return undefined
      const borderColumn = line.lastIndexOf("│", markerColumn)
      const next = line[markerColumn + marker.length]
      if (
        borderColumn >= 0
        && line.slice(borderColumn + 1, markerColumn).trim().length === 0
        && (next === undefined || /\s/u.test(next))
      ) return borderColumn + 1
      offset = markerColumn + marker.length
    }
    return undefined
  }, undefined)
  if (contentColumn === undefined) return false
  return !lines.some((line) => {
    if (line[contentColumn - 1] !== "│") return false
    const borderColumn = line.indexOf("│", contentColumn)
    const content = borderColumn < 0 ? line.slice(contentColumn) : line.slice(contentColumn, borderColumn)
    return content.includes("· loading")
  })
}

async function writeCredentialFile(destination: string, content: Buffer | undefined, required: boolean): Promise<void> {
  if (content === undefined) {
    if (required) throw new Error(`credential source file is missing: ${basename(destination)}`)
    return
  }
  await writeFile(destination, content, { flag: "wx", mode: 0o600 })
}

/** Copies the profile's auth files and writes token-free Claude login references. Links, missing credentials, or existing destination files fail without changing the source. */
export async function cloneAuthProfileFiles(sourceProfile: string, destination: string): Promise<void> {
  const source = resolve(sourceProfile)
  const id = requireAuthProfileName(basename(source))
  const access = ContainedDirectory.openExisting(dirname(source), [id], { noFollowBase: true })
  if (access === undefined) throw new Error(`auth profile does not exist: ${id}`)
  try {
    const auth = access.readFile("auth.json", 16 * 1024 * 1024)
    const profile = access.readFile("profile.json", 16 * 1024)
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
    const target = ContainedDirectory.open(dirname(destination), [basename(destination)], { privateDirectories: true, noFollowBase: true })
    target.close()
    await writeCredentialFile(join(destination, "auth.json"), auth, true)
    await writeCredentialFile(join(destination, "profile.json"), profile, false)
    writeClaudeLoginReferences(source, destination)
  } finally {
    access.close()
  }
}

/** Resolve a start request against its source auth catalog without changing credentials or selection. */
export function resolveTuiUatAuthProfile(options: Pick<TuiUatOptions, "sourceProjectRoot" | "nonSecretEnv">, source: Omit<AuthProfileManagerOptions, "projectRoot">) {
  return new AuthProfileManager({
    ...source,
    projectRoot: options.sourceProjectRoot,
    env: { ...(source.env ?? process.env), ...options.nonSecretEnv },
  }).inspect()
}

async function cloneEffectiveAuth(options: TuiUatOptions, home: string): Promise<string> {
  const sourceHome = process.env.HOME
  if (!sourceHome) throw new Error("HOME is required to resolve the configured auth profile")
  const sourceUserDataRoot = join(sourceHome, ".flywheel")
  const resolution = resolveTuiUatAuthProfile(options, { userDataRoot: sourceUserDataRoot, env: process.env })
  const destination = authDir(join(home, ".flywheel"), resolution.id)
  const account = ContainedDirectory.open(home, [".flywheel"], { privateDirectories: true, noFollowBase: true })
  account.close()
  await mkdir(join(home, ".flywheel", "auth", "profiles"), { recursive: true, mode: 0o700 })
  await chmod(join(home, ".flywheel", "auth"), 0o700)
  await chmod(join(home, ".flywheel", "auth", "profiles"), 0o700)
  await cloneAuthProfileFiles(resolution.directory, destination)
  return resolution.id
}

function sandboxLayout(root: string): TuiUatSandbox {
  return {
    root,
    home: join(root, "home"),
    project: join(root, "project"),
    evidence: join(root, "evidence"),
    stderrFile: join(root, "evidence", "stderr.log"),
    tmuxServer: join(root, "tmux"),
  }
}

function sessionNameFor(root: string): string {
  return `flywheel-uat-${createHash("sha256").update(root).digest("hex").slice(0, 24)}`
}

export async function prepareTuiUatSandbox(options: TuiUatOptions): Promise<TuiUatSandbox> {
  await mkdir(options.scratchRoot, { recursive: true })
  const sandbox = sandboxLayout(await realpath(await mkdtemp(join(options.scratchRoot, "tui-uat-"))))
  const { home, project, evidence } = sandbox
  try {
    await Promise.all([
      mkdir(home, { recursive: true, mode: 0o700 }),
      mkdir(project, { recursive: true, mode: 0o700 }),
      mkdir(evidence, { recursive: true, mode: 0o700 }),
    ])
    await run(["git", "init", "--quiet"], project)
    const canonicalProject = await realpath(project)
    const gitRoot = await realpath(await run(["git", "rev-parse", "--show-toplevel"], project))
    if (gitRoot !== canonicalProject) throw new Error(`isolated git root mismatch: expected ${canonicalProject}, got ${gitRoot}`)
    const userDataRoot = join(home, ".flywheel")
    await mkdir(userDataRoot, { recursive: true, mode: 0o700 })
    if (options.config !== undefined) await writeFile(join(userDataRoot, "flywheel.toml"), options.config, { mode: 0o600 })
    const authProfile = options.cloneAuth === false ? undefined : await cloneEffectiveAuth(options, home)
    return { ...sandbox, authProfile }
  } catch (error) {
    await rm(home, { recursive: true, force: true })
    throw error
  }
}

export async function removeUatHome(home: string, stop: () => void | Promise<void> = () => {}): Promise<void> {
  await stop()
  await rm(home, { recursive: true, force: true })
}

/** tmux on macOS and Linux, or psmux on Windows, which installs as `tmux` and
 *  drives the terminal through the same commands. */
function requireTmuxPlatform(): void {
  if (process.platform !== "darwin" && process.platform !== "linux" && process.platform !== "win32") throw new Error(`Flywheel TUI UAT requires macOS, Linux, or Windows, got ${process.platform}`)
}

const idleTimeoutSchema = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0))
const sessionStateSchema = Schema.Struct({
  binaryPath: Schema.String,
  idleTimeoutMs: idleTimeoutSchema,
  authProfile: Schema.optionalKey(Schema.String),
})
const STATE_FILE = "session.json"
const ACTIVITY_FILE = "activity"

async function readSession(root: string) {
  const canonicalRoot = await realpath(root)
  const state = Schema.decodeUnknownSync(sessionStateSchema)(JSON.parse(await readFile(join(canonicalRoot, STATE_FILE), "utf8")))
  return { ...state, sandbox: { ...sandboxLayout(canonicalRoot), authProfile: state.authProfile }, sessionName: sessionNameFor(canonicalRoot) }
}

async function keepActive<T>(root: string, idleTimeoutMs: number, command: () => Promise<T>): Promise<T> {
  const activity = join(root, ACTIVITY_FILE)
  const refresh = () => utimesSync(activity, new Date(), new Date())
  refresh()
  const timer = setInterval(() => {
    try { refresh() } catch {
      // An explicit stop can remove the activity file during a running command.
      clearInterval(timer)
    }
  }, Math.max(1, Math.min(1_000, idleTimeoutMs / 3)))
  timer.unref()
  try {
    return await command()
  } finally {
    clearInterval(timer)
  }
}

function decorateApp(app: TmuxApp, sandbox: TuiUatSandbox, sessionName: string, idleTimeoutMs: number): TuiUatApp {
  const pollPane: TmuxApp["pollPane"] = (...args) => keepActive(sandbox.root, idleTimeoutMs, () => app.pollPane(...args))
  const captureArtifact = async (name: string): Promise<string> => {
    const path = join(sandbox.evidence, artifactName(name))
    await writeFile(path, app.capture())
    return path
  }
  const captureHistoryArtifact = async (name: string): Promise<string> => {
    const path = join(sandbox.evidence, artifactName(name))
    await writeFile(path, app.captureHistory())
    return path
  }
  const activateSelectedRow = async (expectedText: string, timeoutMs = 15_000): Promise<PollOutcome> => {
    const outcome = await pollPane(`selected row ${expectedText}`, (pane) => selectedRowIsLoaded(pane, expectedText), timeoutMs, 50)
    app.sendKeys("Enter")
    return outcome
  }
  return {
    ...app, sandbox, sessionName, captureArtifact, captureHistoryArtifact, activateSelectedRow, pollPane,
    submit: () => keepActive(sandbox.root, idleTimeoutMs, () => app.submit()),
    sendText: (text) => keepActive(sandbox.root, idleTimeoutMs, () => app.sendText(text)),
  }
}

/** Launch the installed TUI in an isolated account. Returns after readiness; stop explicitly or let the session-owned idle reaper stop it. Start failures retain diagnostics and remove credentials. */
export async function startTuiUat(options: TuiUatOptions): Promise<TuiUatApp> {
  requireTmuxPlatform()
  const idleTimeoutMs = Schema.decodeUnknownSync(idleTimeoutSchema)(options.idleTimeoutMs ?? 20 * 60_000)
  await run(["tmux", "-V"])
  const sandbox = await prepareTuiUatSandbox(options)
  let app: TmuxApp | undefined
  let sessionName: string | undefined
  try {
    const binaryPath = await resolveInstalledBinary(options.sourceProjectRoot)
    copyActiveBuild(options.installationHome ?? process.env.HOME ?? homedir(), sandbox.home, false)
    sessionName = sessionNameFor(sandbox.root)
    app = launchApp({
      server: sandbox.tmuxServer,
      sessionName,
      binaryPath,
      workDir: sandbox.project,
      home: sandbox.home,
      projectRoot: sandbox.project,
      stderrFile: sandbox.stderrFile,
      env: sandboxEnvironment(sandbox, options.nonSecretEnv),
    })
    await writeFile(join(sandbox.root, STATE_FILE), JSON.stringify({ binaryPath, idleTimeoutMs, authProfile: sandbox.authProfile }), { mode: 0o600 })
    await writeFile(join(sandbox.root, ACTIVITY_FILE), "", { mode: 0o600 })
    const running = decorateApp(app, sandbox, sessionName, idleTimeoutMs)
    startSessionReaper(sandbox.tmuxServer, sessionName, [process.execPath, fileURLToPath(new URL("tui.ts", import.meta.url)), "_reap", sandbox.root])
    await running.pollPane("fresh chat readiness", (pane) => pane.includes(READY_MARKER), READY_TIMEOUT_MS, 50)
    await utimes(join(sandbox.root, ACTIVITY_FILE), new Date(), new Date())
    return running
  } catch (error) {
    try {
      if (app !== undefined) {
        const lastCapture = error instanceof PanePollError ? error.lastCapture : undefined
        try {
          await writeFile(join(sandbox.evidence, "failure-pane.log"), lastCapture ?? app.capture())
        } catch {
          // The original failure remains authoritative when the pane has already exited.
        }
        try {
          await writeFile(join(sandbox.evidence, "failure-history.log"), app.captureHistory())
        } catch {
          if (lastCapture !== undefined) await writeFile(join(sandbox.evidence, "failure-history.log"), lastCapture)
        }
      }
      try {
        await readFile(sandbox.stderrFile)
      } catch {
        await writeFile(sandbox.stderrFile, "")
      }
    } catch {
      // Diagnostics must not replace the launch failure or prevent credential cleanup.
    } finally {
      try {
        await Promise.allSettled([
          removeUatHome(sandbox.home, () => app?.dispose(true)),
          rm(join(sandbox.root, STATE_FILE), { force: true }),
          rm(join(sandbox.root, ACTIVITY_FILE), { force: true }),
        ])
      } finally {
        if (sessionName !== undefined) killTmuxSession(sandbox.tmuxServer, sessionName)
      }
    }
    throw error
  }
}

/** Rebuild a live handle and renew its idle deadline. The sandbox root is the handle returned by start. */
export async function attachTuiUat(root: string): Promise<TuiUatApp> {
  const state = await readSession(root)
  await utimes(join(state.sandbox.root, ACTIVITY_FILE), new Date(), new Date())
  return decorateApp(attachApp(state.sandbox.tmuxServer, state.sessionName, state.sandbox.home), state.sandbox, state.sessionName, state.idleTimeoutMs)
}

/** Stop only this sandbox's process tree, remove its HOME and credentials, then end the owning tmux session. Evidence and the isolated project remain. */
export async function stopTuiUat(root: string): Promise<void> {
  const { sandbox, sessionName } = await readSession(root)
  try {
    await removeUatHome(sandbox.home, () => attachApp(sandbox.tmuxServer, sessionName, sandbox.home).dispose(true))
    await rm(join(sandbox.root, STATE_FILE), { force: true })
    await rm(join(sandbox.root, ACTIVITY_FILE), { force: true })
  } finally {
    killTmuxSession(sandbox.tmuxServer, sessionName)
  }
}

/** Run inside the session's reaper window, never as a detached process. */
export async function reapTuiUat(root: string): Promise<void> {
  const { idleTimeoutMs, sandbox } = await readSession(root)
  for (;;) {
    const remaining = idleTimeoutMs - (Date.now() - (await stat(join(sandbox.root, ACTIVITY_FILE))).mtimeMs)
    if (remaining <= 0) break
    await Bun.sleep(Math.min(remaining, 1_000))
  }
  await stopTuiUat(sandbox.root)
}

/** Run the installed binary with the sandbox account and project, never the operator's HOME. Returns its standard output and error; a nonzero exit throws with both. */
async function runInSandbox(root: string, args: string[]): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const { sandbox, binaryPath, idleTimeoutMs } = await readSession(root)
  return keepActive(sandbox.root, idleTimeoutMs, async () => {
    const excluded = new Set<string>(INSTALLED_LAUNCH_EXCLUDED_ENV)
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !excluded.has(key)))
    const child = Bun.spawn([binaryPath, ...args], {
      cwd: sandbox.project,
      env: { ...inherited, ...sandboxEnvironment(sandbox), HOME: sandbox.home, FLYWHEEL_PROJECT_ROOT: sandbox.project },
      stdout: "pipe", stderr: "pipe", windowsHide: true,
    })
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    if (exitCode !== 0) throw new Error(`flywheel ${args[0]} failed (${exitCode}): ${stderr.trim()}`)
    return { stdout, stderr }
  })
}

/** Query the installed binary's events in the sandbox. */
export async function searchTuiUatEvents(root: string, args: string[]): Promise<string> {
  return (await runInSandbox(root, ["events", "search", ...args])).stdout
}

/** Run installed `flywheel web` in the sandbox: it opens the sandbox project
 *  through the sandbox hub and prints that hub's address. */
export async function openTuiUatWeb(root: string): Promise<string> {
  const { stdout, stderr } = await runInSandbox(root, ["web"])
  return `${stdout}${stderr}`.trim()
}
