import { afterEach, describe, expect, it, mock, spyOn } from "bun:test"
import { existsSync } from "node:fs"
import * as fs from "node:fs/promises"
import { lstat, mkdtemp, readFile, rm, stat, utimes } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import * as driver from "../../../../scripts/uat/tmux-driver.js"
import * as installed from "../../../../scripts/uat/installed-binary.js"
import { attachTuiUat, reapTuiUat, startTuiUat, stopTuiUat } from "../../../../scripts/uat/harness.js"
import { activatePlacedBuild, placeBuild } from "../../../helpers/placed-build.js"

const roots: string[] = []
const liveSessions: { root: string; server: string; sessionName: string }[] = []
const extraSessions: { server: string; sessionName: string }[] = []
afterEach(async () => {
  mock.restore()
  for (const session of liveSessions.splice(0)) {
    try {
      if (existsSync(join(session.root, "session.json"))) await stopTuiUat(session.root)
    } finally {
      driver.killTmuxSession(session.server, session.sessionName)
    }
  }
  for (const { server, sessionName } of extraSessions.splice(0)) driver.killTmuxSession(server, sessionName)
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function fakeApp(): driver.TmuxApp {
  return {
    hasPane: () => true,
    capture: () => "visible pane",
    captureHistory: () => "full history",
    sendKeys: () => {},
    sendLiteral: () => {},
    submit: async () => {},
    sendText: async () => {},
    mouse: () => {},
    click: () => {},
    clickText: () => {},
    hover: () => {},
    pollPane: async () => ({ elapsedMs: 0, capture: "for fresh chat" }),
    dispose: () => {},
  }
}

async function setup() {
  const scratchRoot = await mkdtemp(join(tmpdir(), "flywheel-uat-lifecycle-"))
  roots.push(scratchRoot)
  const app = fakeApp()
  const launch = spyOn(driver, "launchApp").mockReturnValue(app)
  spyOn(driver, "attachApp").mockReturnValue(app)
  spyOn(driver, "startSessionReaper").mockImplementation(() => {})
  spyOn(driver, "killTmuxSession").mockImplementation(() => {})
  spyOn(installed, "resolveInstalledBinary").mockResolvedValue("/installed/flywheel")
  return { app, launch, options: { scratchRoot, sourceProjectRoot: scratchRoot, cloneAuth: false } }
}

describe.skipIf(process.platform === "win32")("UAT persistent lifecycle with tmux preflight", () => {
  it("rejects the source wrapper as an installed binary", async () => {
    const root = await fs.realpath(await mkdtemp(join(tmpdir(), "flywheel-uat-binary-")))
    roots.push(root)
    await fs.mkdir(join(root, "bin"))
    const wrapper = join(root, "bin", "flywheel")
    await fs.writeFile(wrapper, "#!/bin/sh\n")
    spyOn(Bun, "which").mockReturnValue(wrapper)
    spyOn(fs, "access").mockImplementation(async (path) => {
      if (String(path) !== wrapper) throw new Error("not executable")
    })
    await expect(installed.resolveInstalledBinary(root)).rejects.toThrow("installed flywheel binary was not found")
  })

  it.each([undefined, "0"])("waits for readiness and keeps the home until disposal (automatic dialog override %s)", async (automaticDialogOverride) => {
    const { app, launch, options } = await setup()
    const poll = spyOn(app, "pollPane")
    let disposalHome: string | undefined
    const dispose = spyOn(app, "dispose").mockImplementation(() => {
      disposalHome = launch.mock.calls[0]?.[0].home
      expect(disposalHome && existsSync(disposalHome)).toBe(true)
    })
    const running = await startTuiUat({
      ...options,
      nonSecretEnv: automaticDialogOverride === undefined ? {} : { FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS: automaticDialogOverride },
    })
    const { sandbox } = running
    expect(dispose).not.toHaveBeenCalled()
    expect((await lstat(sandbox.home)).isDirectory()).toBe(true)
    const attached = await attachTuiUat(sandbox.root)
    expect(attached.sandbox).toEqual(sandbox)
    expect(launch).toHaveBeenCalledTimes(1)
    await attached.captureArtifact("pane.log")
    await attached.captureHistoryArtifact("history.log")
    await stopTuiUat(sandbox.root)
    expect(launch.mock.calls[0]?.[0].env?.FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS).toBe(automaticDialogOverride ?? "1")
    expect(poll).toHaveBeenCalledTimes(1)
    const readiness = poll.mock.calls[0]
    expect(readiness?.[2]).toBe(45_000)
    expect(readiness?.[3]).toBe(50)
    expect(readiness?.[1]("for fresh chat")).toBe(true)
    expect(readiness?.[1]("New Chat")).toBe(false)
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(disposalHome).toBe(sandbox.home)
    await expect(lstat(sandbox.home)).rejects.toThrow()
    expect(await readFile(join(sandbox.evidence, "pane.log"), "utf8")).toBe("visible pane")
    expect(await readFile(join(sandbox.evidence, "history.log"), "utf8")).toBe("full history")
  })

  it("activates a selected row only after its loaded frame is visible", async () => {
    const { app, options } = await setup()
    const poll = spyOn(app, "pollPane")
    const sendKeys = spyOn(app, "sendKeys")
    const matched = { elapsedMs: 12, capture: "│    > Chat ready │" }
    poll.mockImplementation(async (label, predicate, timeoutMs) => {
      if (label === "fresh chat readiness") return { elapsedMs: 0, capture: "for fresh chat" }
      expect(sendKeys).not.toHaveBeenCalled()
      expect(timeoutMs).toBe(321)
      expect(predicate("example: > Chat")).toBe(false)
      expect(predicate("│ example: > Chat │")).toBe(false)
      expect(predicate("│ Changes apply · loading │\n│    > Chat ready │")).toBe(false)
      expect(predicate("│ transcript · loading │  │    > Chat ready │")).toBe(true)
      expect(predicate("│    > Reviewer ready │")).toBe(false)
      return matched
    })

    const running = await startTuiUat(options)
    const result = await running.activateSelectedRow("Chat", 321)
    await stopTuiUat(running.sandbox.root)

    expect(result).toBe(matched)
    expect(sendKeys).toHaveBeenCalledTimes(1)
    expect(sendKeys).toHaveBeenCalledWith("Enter")
  })

  it("does not activate a selected row when its readiness wait fails", async () => {
    const { app, options } = await setup()
    const sendKeys = spyOn(app, "sendKeys")
    spyOn(app, "pollPane").mockImplementation(async (label, _predicate, timeoutMs) => {
      if (label === "fresh chat readiness") return { elapsedMs: 0, capture: "for fresh chat" }
      expect(timeoutMs).toBe(654)
      throw new driver.PanePollError("row stayed unavailable", "│ Changes apply · loading │")
    })

    const running = await startTuiUat(options)
    await expect(running.activateSelectedRow("Chat", 654)).rejects.toThrow("row stayed unavailable")
    await stopTuiUat(running.sandbox.root)
    expect(sendKeys).not.toHaveBeenCalled()
  })

  it("renews activity on attach and reaps abandoned sessions through the same stop path", async () => {
    const { app, options } = await setup()
    const dispose = spyOn(app, "dispose")
    const running = await startTuiUat({ ...options, idleTimeoutMs: 100 })
    const activity = join(running.sandbox.root, "activity")
    await utimes(activity, new Date(0), new Date(0))
    await attachTuiUat(running.sandbox.root)
    expect(Date.now() - (await stat(activity)).mtimeMs).toBeLessThan(100)
    expect(dispose).not.toHaveBeenCalled()
    await utimes(activity, new Date(0), new Date(0))
    await reapTuiUat(running.sandbox.root)
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(dispose).toHaveBeenCalledWith(true)
    expect(driver.killTmuxSession).toHaveBeenCalledWith(running.sandbox.tmuxServer, running.sessionName)
    await expect(lstat(running.sandbox.home)).rejects.toThrow()
    await expect(lstat(join(running.sandbox.root, "session.json"))).rejects.toThrow()
  })

  it("retains the last pane and removes credentials when readiness fails", async () => {
    const { app, launch, options } = await setup()
    spyOn(app, "pollPane").mockRejectedValue(new driver.PanePollError("pane exited", "last visible pane"))
    spyOn(app, "capture").mockImplementation(() => { throw new Error("pane gone") })
    spyOn(app, "captureHistory").mockImplementation(() => { throw new Error("pane gone") })
    await expect(startTuiUat(options)).rejects.toThrow("pane exited")
    const launched = launch.mock.calls[0]?.[0]
    if (!launched?.home) throw new Error("app was not launched")
    await expect(lstat(launched.home)).rejects.toThrow()
    expect(await readFile(join(launched.stderrFile, "..", "failure-pane.log"), "utf8")).toBe("last visible pane")
    expect(await readFile(join(launched.stderrFile, "..", "failure-history.log"), "utf8")).toBe("last visible pane")
  })

  it("cleans up and preserves the readiness error when diagnostic destinations are directories", async () => {
    const { app, launch, options } = await setup()
    const dispose = spyOn(app, "dispose")
    const failure = new driver.PanePollError("original readiness error", "last pane")
    spyOn(app, "pollPane").mockImplementation(async () => {
      const launched = launch.mock.calls[0]?.[0]
      if (!launched?.home) throw new Error("app was not launched")
      await fs.writeFile(join(launched.home, "auth.json"), "credential fixture")
      await fs.mkdir(launched.stderrFile, { recursive: true })
      await fs.mkdir(join(launched.stderrFile, "..", "failure-pane.log"))
      await fs.mkdir(join(launched.stderrFile, "..", "failure-history.log"))
      throw failure
    })
    spyOn(app, "captureHistory").mockImplementation(() => { throw new Error("pane gone") })
    await expect(startTuiUat(options)).rejects.toBe(failure)
    const launched = launch.mock.calls[0]?.[0]
    if (!launched?.home) throw new Error("app was not launched")
    expect(existsSync(launched.home)).toBe(false)
    expect(dispose).toHaveBeenCalledWith(true)
    expect(driver.killTmuxSession).toHaveBeenCalledWith(launched.server, launched.sessionName)
  })
})

const hasTmux = spawnSync("tmux", ["-V"], { windowsHide: true }).status === 0

function tmux(server: string, args: string[]): string {
  const { argv, cwd } = driver.tmuxCommand(server, args)
  const result = spawnSync("tmux", argv, { cwd, encoding: "utf8", windowsHide: true })
  if (result.status !== 0) throw new Error(`tmux failed: ${result.stderr}`)
  return result.stdout.trim()
}

/** Without a server, the question goes to the default server. */
function sessionExists(sessionName: string, server?: string): boolean {
  const args = ["has-session", "-t", sessionName]
  const { argv, cwd } = server === undefined ? { argv: args, cwd: undefined } : driver.tmuxCommand(server, args)
  return spawnSync("tmux", argv, { cwd, windowsHide: true }).status === 0
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function startFixture() {
  const scratchRoot = await fs.realpath(await mkdtemp(join(tmpdir(), "flywheel-uat-real-lifecycle-")))
  roots.push(scratchRoot)
  const installationHome = join(scratchRoot, "installation")
  const build = { version: "0.0.1", buildId: "a".repeat(64) }
  const binary = placeBuild(join(installationHome, ".flywheel"), build)
  activatePlacedBuild(join(installationHome, ".flywheel"), build)
  await fs.writeFile(binary, `#!/bin/sh
trap 'exit 0' TERM
printf '%s' "$$" > "$HOME/fixture.pid"
sleep 1.2
printf 'for fresh chat\\n'
while :; do sleep 1; done
`)
  const previousBinary = process.env.FLYWHEEL_INSTALLED_BINARY
  process.env.FLYWHEEL_INSTALLED_BINARY = binary
  try {
    const app = await startTuiUat({ scratchRoot, sourceProjectRoot: scratchRoot, installationHome, cloneAuth: false, idleTimeoutMs: 600 })
    liveSessions.push({ root: app.sandbox.root, server: app.sandbox.tmuxServer, sessionName: app.sessionName })
    const pid = Number(await readFile(join(app.sandbox.home, "fixture.pid"), "utf8"))
    return { app, pid, scratchRoot }
  } finally {
    if (previousBinary === undefined) delete process.env.FLYWHEEL_INSTALLED_BINARY
    else process.env.FLYWHEEL_INSTALLED_BINARY = previousBinary
  }
}

describe.skipIf(!hasTmux || process.platform === "win32")("UAT lifecycle with real tmux", () => {
  it("keeps readiness and a long wait active, confines forged metadata, and explicitly stops the fixture", async () => {
    const { app, pid, scratchRoot } = await startFixture()
    expect(app.capture()).toContain("for fresh chat")
    expect(processExists(pid)).toBe(true)
    expect(tmux(app.sandbox.tmuxServer, ["list-windows", "-t", app.sessionName, "-F", "#{window_name}:#{pane_dead}"]).split("\n")).toEqual(["app:0", "reaper:0"])
    expect(sessionExists(app.sessionName)).toBe(false)
    const waitStarted = performance.now()
    await app.pollPane("active long wait", () => performance.now() - waitStarted >= 1_400, 2_500)
    expect(existsSync(app.sandbox.home)).toBe(true)
    expect(sessionExists(app.sessionName, app.sandbox.tmuxServer)).toBe(true)
    expect(processExists(pid)).toBe(true)

    const outside = join(scratchRoot, "outside")
    await fs.mkdir(outside)
    await fs.writeFile(join(outside, "keep"), "untouched")
    const decoySession = `flywheel-uat-decoy-${process.pid}`
    tmux(app.sandbox.tmuxServer, ["new-session", "-d", "-s", decoySession, "exec sleep 60"])
    extraSessions.push({ server: app.sandbox.tmuxServer, sessionName: decoySession })
    const stateFile = join(app.sandbox.root, "session.json")
    const state = JSON.parse(await readFile(stateFile, "utf8"))
    expect(Object.keys(state).sort()).toEqual(["binaryPath", "idleTimeoutMs"])
    await fs.writeFile(stateFile, JSON.stringify({
      ...state, sessionName: decoySession,
      sandbox: { root: outside, home: outside, project: outside, evidence: outside, stderrFile: join(outside, "keep") },
    }))
    const alias = join(scratchRoot, "handle-alias")
    await fs.symlink(app.sandbox.root, alias)
    const attached = await attachTuiUat(alias)
    expect(attached.sandbox).toEqual(app.sandbox)
    expect(attached.sessionName).toBe(app.sessionName)
    await stopTuiUat(alias)
    expect(existsSync(app.sandbox.home)).toBe(false)
    expect(sessionExists(app.sessionName, app.sandbox.tmuxServer)).toBe(false)
    expect(processExists(pid)).toBe(false)
    expect(await readFile(join(outside, "keep"), "utf8")).toBe("untouched")
    expect(sessionExists(decoySession, app.sandbox.tmuxServer)).toBe(true)
    await expect(attachTuiUat(app.sandbox.root)).rejects.toThrow("ENOENT")
    await expect(attachTuiUat(outside)).rejects.toThrow("ENOENT")
  }, 15_000)

  it("reaps an idle fixture and removes its process, tmux session, and HOME", async () => {
    const { app, pid } = await startFixture()
    const deadline = performance.now() + 5_000
    while (sessionExists(app.sessionName, app.sandbox.tmuxServer) && performance.now() < deadline) await Bun.sleep(50)
    expect(sessionExists(app.sessionName, app.sandbox.tmuxServer)).toBe(false)
    expect(existsSync(app.sandbox.home)).toBe(false)
    expect(processExists(pid)).toBe(false)
    expect(existsSync(join(app.sandbox.root, "session.json"))).toBe(false)
  }, 15_000)
})
