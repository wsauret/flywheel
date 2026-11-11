import { describe, expect, it, spyOn } from "bun:test"
import * as childProcess from "node:child_process"
import { realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { resolveTuiUatAuthProfile, sandboxEnvironment, searchTuiUatEvents } from "../../../../scripts/uat/harness.js"
import { AuthProfileStore } from "../../../../src/infra/auth/auth-profile-store.js"
import { attachApp, encodeSgrMouse, killTmuxSession, launchApp, launchCommand, PanePollError, startSessionReaper, tmuxCommand } from "../../../../scripts/uat/tmux-driver.js"
import { releaseHarnessRuntimeOptions } from "../../../../src/cli/serve.js"
import { runWeb } from "../../../../src/cli/web.js"
import { temporaryDirectories } from "../../../helpers/directories.js"
import * as fixture from "../../../helpers/real-process-fixture.js"

const temporary = temporaryDirectories()

describe("TUI UAT sandbox", () => {
  it.each<{ route: string; scenarioEnv: { readonly [name: string]: string }; harnessEnv: { readonly [name: string]: string } }>([
    { route: "scenario environment over the default", scenarioEnv: { FLYWHEEL_AUTH_PROFILE: "Personal" }, harnessEnv: {} },
    { route: "scenario environment over the harness environment", scenarioEnv: { FLYWHEEL_AUTH_PROFILE: "Personal" }, harnessEnv: { FLYWHEEL_AUTH_PROFILE: "Work" } },
    { route: "harness environment", scenarioEnv: {}, harnessEnv: { FLYWHEEL_AUTH_PROFILE: "Personal" } },
  ])("selects the same canonical clone source and launch profile from $route", ({ scenarioEnv, harnessEnv }) => {
    const root = temporary("uat-auth-source-")
    const store = new AuthProfileStore(root)
    const inspect = spyOn(store, "inspect").mockReturnValue({
      profiles: [{ id: "personal", displayName: "Personal" }, { id: "work", displayName: "Work" }],
      stickyProfile: "work",
      retirements: {},
    })
    try {
      const profile = resolveTuiUatAuthProfile({ sourceProjectRoot: root, nonSecretEnv: scenarioEnv }, {
        userDataRoot: root, env: harnessEnv, store, config: () => ({ auth: { project_profiles: {} } }),
      })
      expect(profile.id).toBe("personal")
      expect(profile.directory).toBe(join(root, "auth", "profiles", "personal"))
      expect(sandboxEnvironment({ root, authProfile: profile.id }, scenarioEnv).FLYWHEEL_AUTH_PROFILE).toBe("personal")
      expect(inspect).toHaveBeenCalledTimes(1)
    } finally {
      inspect.mockRestore()
    }
  })

  it("runs installed commands without the harness's launcher variables", async () => {
    const root = realpathSync(temporary("uat-run-"))
    writeFileSync(join(root, "session.json"), JSON.stringify({ binaryPath: "/installed/flywheel", idleTimeoutMs: 60_000 }))
    writeFileSync(join(root, "activity"), "")
    const seeded = new Map([["BUN_BE_BUN", "1"], ["FLYWHEEL_NATIVE_DIR", "/launcher/native"], ["FLYWHEEL_INSTALL_DIR", "/launcher/install"], ["UAT_UNRELATED", "kept"]])
    const previous = new Map([...seeded.keys()].map((key) => [key, process.env[key]]))
    for (const [key, value] of seeded) process.env[key] = value
    const stopped = new Error("stop before launching the installed binary")
    const spawn = spyOn(Bun, "spawn")
    spawn.mockImplementation(() => {
      throw stopped
    })
    try {
      await expect(searchTuiUatEvents(root, ["--limit", "1"])).rejects.toBe(stopped)
      const [argv, options] = spawn.mock.calls[0] ?? []
      expect(argv).toEqual(["/installed/flywheel", "events", "search", "--limit", "1"])
      const env = options?.env ?? {}
      const expected = new Map(Object.entries({ ...sandboxEnvironment({ root }), UAT_UNRELATED: "kept", HOME: join(root, "home"), FLYWHEEL_PROJECT_ROOT: join(root, "project") }))
      // Compare only the keys under test, so a failure never prints the operator's environment.
      const observed = new Map([...seeded.keys(), ...expected.keys()].map((key) => [key, env[key]]))
      expect(observed).toEqual(new Map([...expected, ["BUN_BE_BUN", undefined], ["FLYWHEEL_NATIVE_DIR", undefined], ["FLYWHEEL_INSTALL_DIR", undefined]]))
    } finally {
      spawn.mockRestore()
      for (const [key, value] of previous) {
        if (value === undefined) Reflect.deleteProperty(process.env, key)
        else process.env[key] = value
      }
    }
  })

  it("opens the hub its own account service bound, never the operator's fixed hub", async () => {
    const env = sandboxEnvironment({ root: temporary("uat-sandbox-") })
    const hub = releaseHarnessRuntimeOptions(env).startHub!({ lane: "installed", listProjects: async () => [], openProject: async () => "", forgetProject: async () => {}, credential: "credential" })
    const opened: string[] = []
    const errors: string[] = []
    try {
      const attach = { lane: "installed" as const, socketPath: "socket", connectionPreface: () => new Uint8Array(), ensure: async () => undefined, openProject: async () => {}, restart: () => Promise.reject(new Error("a web command never restarts")), requestModule: () => Promise.reject(new Error("a web command sends no module request")), close: () => {} }
      await runWeb([], { executionCwd: "/sandbox/project", projectRoot: "/sandbox/project", accountHome: "/sandbox/home", userDataRoot: "/sandbox/home/.flywheel" }, attach, async (url) => { opened.push(url); return true }, { log() {}, error: (line) => errors.push(line), env })
    } finally {
      hub.stop()
      process.exitCode = 0
    }
    expect(errors).toEqual([])
    expect(hub.origin).not.toBe("http://127.0.0.1:41000")
    expect(opened).toEqual([`${hub.origin}/`])
  })
})

describe("TUI UAT driver", () => {
  it("sweeps the sandbox after the app pane has exited and refuses an incomplete stop", () => {
    const spawn = spyOn(childProcess, "spawnSync").mockReturnValue({
      pid: 1, output: [], stdout: "", stderr: "can't find window: app", status: 1, signal: null,
    })
    const stop = spyOn(fixture, "stopHarnessProcesses").mockReturnValue([])
    try {
      attachApp("/sandbox/tmux", "uat", "/sandbox/home").dispose(true)
      expect(stop).toHaveBeenCalledWith(["/sandbox/home"])
      stop.mockReturnValue([{ pid: 41001, command: "/sandbox/home/flywheel serve" }])
      expect(() => attachApp("/sandbox/tmux", "uat", "/sandbox/home").dispose(true)).toThrow("41001")
    } finally {
      stop.mockRestore()
      spawn.mockRestore()
    }
  })

  it("attaches without relaunching and clicks the last visible text in display-cell coordinates", () => {
    const pane = "Open\n中文 Open"
    const spawn = spyOn(childProcess, "spawnSync").mockReturnValue({
      pid: 1, output: [], stdout: pane, stderr: "", status: 0, signal: null,
    })
    try {
      const app = attachApp("/sandbox/tmux", "uat", "/sandbox/home")
      expect(spawn).not.toHaveBeenCalled()
      app.clickText("Open", true)
      expect(spawn.mock.calls[1]?.[1]).toEqual(tmuxCommand("/sandbox/tmux", ["send-keys", "-t", "uat:app", "-l", "--", "\u001b[<0;6;2M"]).argv)
      expect(spawn.mock.calls[2]?.[1]).toEqual(tmuxCommand("/sandbox/tmux", ["send-keys", "-t", "uat:app", "-l", "--", "\u001b[<0;6;2m"]).argv)
      spawn.mockClear()
      try {
        app.clickText("missing")
        throw new Error("missing text did not fail")
      } catch (error) {
        expect(error).toBeInstanceOf(PanePollError)
        if (!(error instanceof PanePollError)) throw error
        expect(error.lastCapture).toBe(pane)
      }
      expect(spawn).toHaveBeenCalledTimes(1)
    } finally {
      spawn.mockRestore()
    }
  })
  it("addresses the private server on every command, except under psmux, which ignores -S", () => {
    const deep = `/${"d".repeat(120)}/tmux`
    for (const platform of ["darwin", "linux"] as const) {
      expect(tmuxCommand(deep, ["kill-session", "-t", "uat"], platform)).toEqual({ argv: ["-S", "tmux", "kill-session", "-t", "uat"], cwd: `/${"d".repeat(120)}` })
    }
    expect(tmuxCommand("C:\\run\\tmux", ["kill-session", "-t", "uat"], "win32")).toEqual({ argv: ["kill-session", "-t", "uat"], cwd: undefined })

    const spawn = spyOn(childProcess, "spawnSync").mockReturnValue({
      pid: 1, output: [], stdout: "app\n", stderr: "", status: 0, signal: null,
    })
    const stop = spyOn(fixture, "stopHarnessProcesses").mockReturnValue([])
    try {
      const app = launchApp({ server: "/run/tmux", sessionName: "uat", binaryPath: "/installed/flywheel", workDir: "/run/project", stderrFile: "/run/stderr.log" })
      startSessionReaper("/run/tmux", "uat", ["/bin/reaper"])
      app.hasPane()
      app.capture()
      app.dispose()
      killTmuxSession("/run/tmux", "uat")
      const { argv: prefix, cwd } = tmuxCommand("/run/tmux", [])
      expect(spawn.mock.calls.map(([, args, options]) => [options?.cwd, ...args?.slice(0, prefix.length + 1) ?? []])).toEqual(
        ["new-session", "new-window", "list-panes", "capture-pane", "kill-session", "kill-session"].map((command) => [cwd, ...prefix, command]),
      )
    } finally {
      stop.mockRestore()
      spawn.mockRestore()
    }
  })

  it("encodes one-based SGR mouse input", () => {
    expect(encodeSgrMouse("hover", 12, 7)).toBe("\u001b[<35;12;7M")
    expect(encodeSgrMouse("press", 12, 7)).toBe("\u001b[<0;12;7M")
    expect(encodeSgrMouse("release", 12, 7)).toBe("\u001b[<0;12;7m")
    expect(() => encodeSgrMouse("press", 0, 1)).toThrow("positive")
  })

  it("pins owned launch environment after caller values", () => {
    const options = {
      server: "/sandbox/tmux",
      sessionName: "uat",
      binaryPath: "/installed/flywheel",
      workDir: "/sandbox/project",
      home: "/sandbox/home",
      projectRoot: "/sandbox/project",
      stderrFile: "/sandbox/stderr.log",
      env: {
        HOME: "/real/home",
        FLYWHEEL_PROJECT_ROOT: "/real/project",
        FLYWHEEL_DISABLE_AUTOUPDATE: "0",
        FLYWHEEL_BOOT_TRACE: "0",
        EXTRA: "kept",
      },
    }
    const command = launchCommand(options)

    expect(launchCommand(options, "darwin")).toStartWith("env -u BUN_BE_BUN -u FLYWHEEL_NATIVE_DIR -u FLYWHEEL_INSTALL_DIR ")
    expect(command).toContain("HOME='/sandbox/home'")
    expect(command).toContain("FLYWHEEL_PROJECT_ROOT='/sandbox/project'")
    expect(command).toContain("FLYWHEEL_DISABLE_AUTOUPDATE='1'")
    expect(command).toContain("FLYWHEEL_BOOT_TRACE='1'")
    expect(command).toContain("FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS='1'")
    expect(command).toContain("EXTRA='kept'")
    expect(command).not.toContain("/real/home")
    expect(command).not.toContain("/real/project")

    const spawn = spyOn(childProcess, "spawnSync").mockReturnValue({
      pid: 1,
      output: [],
      stdout: "",
      stderr: "",
      status: 0,
      signal: null,
    })
    try {
      launchApp(options)
      const server = spawn.mock.calls.find(([, args]) => args?.includes("new-session"))
      if (process.platform === "win32") {
        expect(server?.[2]?.env?.PSMUX_NO_WARM).toBe("1")
        expect(server?.[2]?.env?.USERPROFILE).toBe(process.env.USERPROFILE)
      }
    } finally {
      spawn.mockRestore()
    }
  })

  it("speaks PowerShell on Windows, where psmux hands the launch to pwsh", () => {
    const command = launchCommand({
      server: "C:\\gate\\tmux",
      sessionName: "uat",
      binaryPath: "C:\\gate\\candidate-bin\\flywheel.exe",
      workDir: "C:\\gate\\work",
      stderrFile: "C:\\gate\\it's evidence\\stderr.log",
      env: { EXTRA: "kept" },
    }, "win32")

    expect(command).toBe("$env:BUN_BE_BUN=$null; $env:FLYWHEEL_NATIVE_DIR=$null; $env:FLYWHEEL_INSTALL_DIR=$null; $env:FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS='1'; $env:EXTRA='kept'; $env:HOME='C:\\gate\\work'; $env:FLYWHEEL_PROJECT_ROOT='C:\\gate\\work'; $env:FLYWHEEL_DISABLE_AUTOUPDATE='1'; $env:FLYWHEEL_BOOT_TRACE='1'; & 'C:\\gate\\candidate-bin\\flywheel.exe' 2> 'C:\\gate\\it''s evidence\\stderr.log'")
  })

  it("passes arguments after the binary, quoted for each platform's shell", () => {
    const options = { server: "/sandbox/tmux", sessionName: "uat", binaryPath: "/installed/flywheel", workDir: "/sandbox/laptop", stderrFile: "/sandbox/stderr.log", args: ["--remote", "it's"] }
    expect(launchCommand(options, "darwin")).toEndWith("'/installed/flywheel' '--remote' 'it'\\''s' 2>'/sandbox/stderr.log'")
    expect(launchCommand(options, "win32")).toEndWith("& '/installed/flywheel' '--remote' 'it''s' 2> '/sandbox/stderr.log'")
  })

  it.each(["darwin", "win32"] as const)("preserves explicit automatic-dialog opt-in on %s", (platform) => {
    const command = launchCommand({ server: "/sandbox/tmux", sessionName: "uat", binaryPath: "/installed/flywheel", workDir: "/sandbox/project", stderrFile: "/sandbox/stderr.log", env: { FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS: "0" } }, platform)
    expect(command).toContain("FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS='0'")
    expect(command).not.toContain("FLYWHEEL_TEST_SUPPRESS_AUTO_DIALOGS='1'")
  })

  it("settles literal input before submitting exactly once", async () => {
    let finishSettle: (() => void) | undefined
    const settle = new Promise<void>((resolve) => {
      finishSettle = resolve
    })
    const spawn = spyOn(childProcess, "spawnSync").mockReturnValue({
      pid: 1,
      output: [],
      stdout: "",
      stderr: "",
      status: 0,
      signal: null,
    })
    const sleep = spyOn(Bun, "sleep").mockReturnValue(settle)

    try {
      const app = launchApp({
        server: "/sandbox/tmux",
        sessionName: "uat",
        binaryPath: "/installed/flywheel",
        workDir: "/sandbox/project",
        stderrFile: "/sandbox/stderr.log",
      })
      spawn.mockClear()

      app.sendLiteral("-1")
      const submitted = app.submit()

      expect(sleep).toHaveBeenCalledTimes(1)
      expect(sleep).toHaveBeenCalledWith(500)
      expect(spawn.mock.calls).toHaveLength(1)
      expect(spawn.mock.calls[0]?.[1]).toEqual(tmuxCommand("/sandbox/tmux", ["send-keys", "-t", "uat:app", "-l", "--", "-1"]).argv)

      finishSettle?.()
      await submitted

      expect(spawn.mock.calls).toHaveLength(2)
      expect(spawn.mock.calls[1]?.[1]).toEqual(tmuxCommand("/sandbox/tmux", ["send-keys", "-t", "uat:app", "Enter"]).argv)
    } finally {
      sleep.mockRestore()
      spawn.mockRestore()
    }
  })
})
