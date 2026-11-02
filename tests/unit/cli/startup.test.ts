import { describe, expect, spyOn, test } from "bun:test"
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync, writeSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { keepServiceErrorLogBounded, opensProject, opensTerminal, prepareCliStartup, publishFailedHeadlessTerminal, selectRunDirectories, shouldSelectStartupInteractively, type DirectorySelectionIo, type StartupBoundaries } from "../../../src/cli/startup.js"
import { createHeadlessOutputObserver } from "../../../src/orchestration/headless/headless-output.js"
import type { AccountRuntimeAttach } from "../../../src/cli/runtime-attach.js"
import type { StartupDirectories } from "../../../src/infra/directory-authorities.js"
import { writeLaunchState, type LaunchState } from "../../../src/infra/launch-state.js"
import { LAUNCH_STATE_ENV, REMOTE_HANDOFF_ENV } from "../../../src/cli/terminal-handoff.js"
import { AccountHomeRefusal } from "../../../src/infra/directory-authorities.js"
import type { RemoteAttach, TerminalRemoteRequest } from "../../../src/orchestration/terminal-remote.js"
import { Log } from "../../../src/infra/log.js"
import { DebugLog } from "../../../src/infra/debug-log.js"
import { temporaryDirectories } from "../../helpers/directories.js"

const DIRECTORIES: StartupDirectories = {
  userDataRoot: "/scratch/flywheel-startup-test/home/.flywheel",
  accountHome: "/scratch/flywheel-startup-test/home",
  projectRoot: "/scratch/flywheel-startup-test/project",
  executionCwd: "/scratch/flywheel-startup-test/project",
}

/** Boundaries that record the order they are crossed in and touch nothing. A
 *  service start is admitted with `admission`. */
function recordingBoundaries(order: string[], env: { [name: string]: string | undefined } = {}, admission: "serve" | "rolled-back" = "serve"): StartupBoundaries {
  const attach: AccountRuntimeAttach = {
    lane: "dev",
    socketPath: "/scratch/flywheel-startup-test/serve.sock",
    connectionPreface: () => new Uint8Array(),
    restart: () => Promise.reject(new Error("a startup never restarts")),
    requestModule: () => Promise.reject(new Error("a startup sends no module request")),
    ensure: () => {
      order.push("account service launch")
      return Promise.resolve(undefined)
    },
    openProject: () => Promise.resolve(),
    close: () => {},
  }
  return {
    env,
    selectDirectories: async () => {
      order.push("directories selected")
      return DIRECTORIES
    },
    registerLiveBuild: (userDataRoot) => {
      order.push(`live build registered ${userDataRoot}`)
      return () => order.push("live build withdrawn")
    },
    initLog: async ({ dir, print }) => {
      order.push(`log initialized ${dir} print=${print}`)
    },
    installCrashPolicy: () => {
      order.push("crash policy installed")
    },
    createAttach: async ({ projectRoot, allowPersistentProcesses, follow }) => {
      order.push(`attach created ${projectRoot} persistent=${allowPersistentProcesses}${follow === undefined ? "" : " follows"}`)
      return attach
    },
    boundServiceErrorLog: (userDataRoot) => {
      order.push(`error log bounded ${userDataRoot}`)
    },
    admitServiceStart: async (userDataRoot) => {
      order.push(`service start counted ${userDataRoot}`)
      return admission
    },
    chooseRemote: async () => { throw new Error("a local launch never asks for a remote project") },
    installRelease: async () => { throw new Error("a local launch never installs a release") },
  }
}

describe("prepareCliStartup", () => {
  test("the client timeline starts after log initialization and keeps pre-log stage durations", async () => {
    const order: string[] = []
    const records: unknown[] = []
    const types: string[] = []
    const record = spyOn(DebugLog, "record").mockImplementation((entry) => {
      if (entry.type.startsWith("startup.")) {
        records.push(entry.payload)
        types.push(entry.type)
      }
    })
    try {
      const startup = await prepareCliStartup({ kind: "run", args: [] }, recordingBoundaries(order))
      startup?.timeline?.foregroundReady()
      startup?.timeline?.finish("incomplete")
      expect(types).toEqual(["startup.started", "startup.finished"])
      expect(records[0]).toMatchObject({ context: {
        projectRoot: DIRECTORIES.projectRoot,
        pid: String(process.pid),
        timelineId: expect.stringMatching(/\S/),
      } })
      expect(records[1]).not.toHaveProperty("type")
      expect(records[1]).toMatchObject({ outcome: "incomplete", foregroundReadyMs: expect.any(Number), stages: {
        "terminal.directories": { status: "ready" },
        "terminal.log": { status: "ready" },
        "terminal.attach": { count: 1 },
        "terminal.service_ready": { status: "ready" },
        "client.app_import": { status: "pending" },
        "client.shell_import": { status: "pending" },
        "client.first_frame": { status: "pending" },
      } })
      expect(order.indexOf(`log initialized ${DIRECTORIES.projectRoot} print=false`)).toBeGreaterThan(order.indexOf("directories selected"))
    } finally {
      record.mockRestore()
    }
  })

  test("the terminal run mode starts the account service before it returns, after directories, live build, and log", async () => {
    const order: string[] = []
    const startup = await prepareCliStartup({ kind: "run", args: ["--print-logs"] }, recordingBoundaries(order))

    expect(order).toEqual([
      "directories selected",
      `live build registered ${DIRECTORIES.userDataRoot}`,
      `log initialized ${DIRECTORIES.projectRoot} print=true`,
      `attach created ${DIRECTORIES.projectRoot} persistent=false follows`,
      "account service launch",
    ])
    expect(startup?.attach).toBeDefined()
    expect(startup?.subcommand).toBeUndefined()
    expect(startup?.directories).toBe(DIRECTORIES)
    startup?.withdrawLiveBuild()
    expect(order.at(-1)).toBe("live build withdrawn")
  })

  test("the terminal run mode forwards --allow-persistent-processes to the service launch", async () => {
    const order: string[] = []
    const startup = await prepareCliStartup({ kind: "run", args: [], allowPersistentProcesses: true }, recordingBoundaries(order))

    expect(order).toContain(`attach created ${DIRECTORIES.projectRoot} persistent=true follows`)
    expect(startup?.allowPersistentProcesses).toBe(true)
  })

  test("a subcommand run registers its live build and opens neither the log nor the service early", async () => {
    const order: string[] = []
    const startup = await prepareCliStartup({ kind: "run", args: ["auth", "--help"] }, recordingBoundaries(order))

    expect(order).toEqual(["directories selected", `live build registered ${DIRECTORIES.userDataRoot}`])
    expect(startup?.attach).toBeUndefined()
    expect(startup?.subcommand).toBeDefined()
  })

  test("a start of the account service opens the account log, installs its crash policy, bounds its error log, and counts itself before command composition", async () => {
    for (const args of [["serve"], ["serve", "--scheduled-task"]]) {
      const order: string[] = []
      const startup = await prepareCliStartup({ kind: "run", args }, recordingBoundaries(order))

      expect(order).toEqual([
        "directories selected",
        `live build registered ${DIRECTORIES.userDataRoot}`,
        `log initialized ${DIRECTORIES.accountHome} print=false`,
        "crash policy installed",
        `error log bounded ${DIRECTORIES.userDataRoot}`,
        `service start counted ${DIRECTORIES.userDataRoot}`,
      ])
      expect(startup?.subcommand).toBeDefined()
    }
  })

  test("a serve command that manages the registration opens the account log, installs no crash policy, and counts no start", async () => {
    const order: string[] = []
    await prepareCliStartup({ kind: "run", args: ["serve", "install"] }, recordingBoundaries(order))

    expect(order).toEqual(["directories selected", `live build registered ${DIRECTORIES.userDataRoot}`, `log initialized ${DIRECTORIES.accountHome} print=false`])
  })

  test("a service start that rolled the account back ends before command composition with the code its manager restarts", async () => {
    const order: string[] = []
    const exitCode = process.exitCode
    try {
      expect(await prepareCliStartup({ kind: "run", args: ["serve"] }, recordingBoundaries(order, {}, "rolled-back"))).toBeUndefined()
      expect(process.exitCode).toBe(75)
    } finally {
      // Bun keeps a code once set, so an unset code is restored as 0.
      process.exitCode = exitCode ?? 0
    }
    expect(order.at(-1)).toBe("live build withdrawn")
  })

  test("a headless run opens neither the log nor the service early", async () => {
    const order: string[] = []
    const startup = await prepareCliStartup({ kind: "run", args: ["--headless", "--task", "ship it"] }, recordingBoundaries(order))

    expect(order).toEqual(["directories selected", `live build registered ${DIRECTORIES.userDataRoot}`])
    expect(startup?.attach).toBeUndefined()
    expect(startup?.subcommand).toBeUndefined()
  })

  test("a terminal handed a place by its predecessor takes it once, and consumes the variable so no child inherits it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flywheel-startup-launch-state-"))
    try {
      const place: LaunchState = { version: 3, projectRoot: DIRECTORIES.projectRoot, foreground: "s", tabs: ["s"], scroll: {}, disclosure: {}, drafts: {}, questionDrafts: {}, modal: { kind: "sessions" } }
      const path = writeLaunchState(dir, place)
      const env: StartupBoundaries["env"] = { [LAUNCH_STATE_ENV]: path }
      const restored = await prepareCliStartup({ kind: "run", args: [] }, recordingBoundaries([], env))
      expect(restored?.launchState).toEqual(place)
      expect(existsSync(path)).toBe(false)
      expect(LAUNCH_STATE_ENV in env).toBe(false)

      const future = join(dir, "future.json")
      writeFileSync(future, JSON.stringify({ ...place, version: 4 }))
      const plain = await prepareCliStartup({ kind: "run", args: [] }, recordingBoundaries([], { [LAUNCH_STATE_ENV]: future }))
      expect(plain?.launchState).toBeUndefined()
      expect(plain?.attach).toBeDefined()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })

  test("a successor environment without the variable makes a plain start", async () => {
    const warn = spyOn(Log.Default, "warn")
    try {
      const startup = await prepareCliStartup({ kind: "run", args: [] }, recordingBoundaries([], {}))
      expect(startup?.launchState).toBeUndefined()
      expect(startup?.attach).toBeDefined()
      expect(warn).not.toHaveBeenCalled()
    } finally { warn.mockRestore() }
  })

  test("a variable naming a missing file makes a plain start with a warning", async () => {
    const warn = spyOn(Log.Default, "warn")
    try {
      const missing = join(tmpdir(), "flywheel-startup-missing-launch-state.json")
      const startup = await prepareCliStartup({ kind: "run", args: [] }, recordingBoundaries([], { [LAUNCH_STATE_ENV]: missing }))
      expect(startup?.launchState).toBeUndefined()
      expect(startup?.attach).toBeDefined()
      expect(warn).toHaveBeenCalledWith("the previous terminal's place was not restored", { reason: expect.stringContaining("could not be read") })
    } finally { warn.mockRestore() }
  })
})

describe("the account service's error log under launchd", () => {
  const directories = temporaryDirectories()
  const MIB = 1024 * 1024
  /** Bytes that differ along the file, so a kept tail shows where it came from. */
  const contents = (size: number, seed: number) => Buffer.from(Array.from({ length: size }, (_, index) => (index * 7 + seed) % 251))
  /** launchd uses append mode; Windows needs a writable non-append handle to exercise truncation. */
  function withFd(path: string, flags: "a" | "r", use: (fd: number) => void): void {
    const fd = openSync(path, flags === "a" && process.platform === "win32" ? "r+" : flags)
    try { use(fd) } finally { closeSync(fd) }
  }

  test("a start whose error output is the file keeps only its last 256 KiB once it passes 1 MiB, says so, and its next write follows that tail", () => {
    const log = join(directories("flywheel-error-log-"), "serve.stderr.log")
    const original = contents(1.5 * MIB, 1)
    writeFileSync(log, original)
    const info = spyOn(Log.Default, "info")
    try {
      withFd(log, "a", (fd) => {
        keepServiceErrorLogBounded(log, fd)
        writeSync(fd, "next start\n")
      })
      expect(info).toHaveBeenCalledTimes(1)
      expect(info).toHaveBeenCalledWith("the account service's error log passed its bound; this start kept its last bytes", { bytes: 1.5 * MIB, kept: 256 * 1024 })
    } finally { info.mockRestore() }

    expect(readFileSync(log)).toEqual(Buffer.concat([original.subarray(-256 * 1024), Buffer.from("next start\n")]))
  })

  test("a trim that fails leaves the file whole, says why, and never fails the start", () => {
    const log = join(directories("flywheel-error-log-"), "serve.stderr.log")
    writeFileSync(log, contents(1.5 * MIB, 1))
    const warn = spyOn(Log.Default, "warn")
    try {
      // A descriptor open only for reading cannot truncate the file.
      withFd(log, "r", (fd) => keepServiceErrorLogBounded(log, fd))
      expect(warn).toHaveBeenCalledWith("the account service's error log could not be trimmed", { error: expect.stringMatching(/\S/) })
    } finally { warn.mockRestore() }

    expect(readFileSync(log)).toEqual(contents(1.5 * MIB, 1))
  })

  test.each([
    ["error output that goes to another file", 1.5 * MIB, "other.log"],
    ["a file at the bound", MIB, "serve.stderr.log"],
  ] as const)("%s stays as it was", (_case, size, errorOutput) => {
    const dir = directories("flywheel-error-log-")
    const log = join(dir, "serve.stderr.log")
    const other = join(dir, "other.log")
    writeFileSync(log, contents(size, 1))
    writeFileSync(other, contents(1.5 * MIB, 2))

    withFd(join(dir, errorOutput), "a", (fd) => keepServiceErrorLogBounded(log, fd))

    expect(readFileSync(log)).toEqual(contents(size, 1))
    expect(readFileSync(other)).toEqual(contents(1.5 * MIB, 2))
  })
})

describe("which runs open a project", () => {
  // The account home is a project only through an exact selection (PI-INTERACTION-069),
  // so startup tells selection which runs would open the project it selects.
  test("a launch and flywheel web open a project, and account subcommands do not", () => {
    expect(opensProject([])).toBe(true)
    expect(opensProject(["--headless", "--task", "ship it"])).toBe(true)
    expect(opensProject(["web"])).toBe(true)
    expect(opensProject(["serve"])).toBe(false)
    expect(opensProject(["kill"])).toBe(false)
    expect(opensProject(["auth", "status"])).toBe(false)
  })

  test("asks for the project root only when a terminal run opens a project", () => {
    expect(shouldSelectStartupInteractively([], true, true)).toBe(true)
    expect(shouldSelectStartupInteractively(["web"], true, true)).toBe(true)
    expect(shouldSelectStartupInteractively(["--headless", "--task", "ship it"], true, true)).toBe(false)
    expect(shouldSelectStartupInteractively([], false, true)).toBe(false)
    expect(shouldSelectStartupInteractively([], true, false)).toBe(false)
    for (const args of [["auth", "status"], ["kill"], ["update"], ["serve"], ["remote", "status"], ["font", "status"]]) {
      expect(shouldSelectStartupInteractively(args, true, true)).toBe(false)
    }
  })
})

describe("a terminal paired with another machine", () => {
  const temporary = temporaryDirectories()

  /** An account home that is a repository, so a launch in it is refused. */
  function accountHome(): string {
    const home = temporary("fw-startup-home-")
    mkdirSync(join(home, ".flywheel"))
    mkdirSync(join(home, ".git"))
    return realpathSync(home)
  }

  function io(home: string, pairedMachines: number, asked: string[] = []): DirectorySelectionIo {
    return {
      env: { HOME: home },
      cwd: home,
      interactive: true,
      choose: async () => { throw new Error("no choice is asked in the account home") },
      pairedMachines: async (userDataRoot) => { asked.push(userDataRoot); return pairedMachines },
    }
  }

  test("only the terminal opens a project on another machine; flywheel web does not", () => {
    expect(opensTerminal([])).toBe(true)
    expect(opensTerminal(["--print-logs"])).toBe(true)
    expect(opensTerminal(["web"])).toBe(false)
  })

  test("the terminal in the account home opens the remote picker once the terminal is paired, and is refused before", async () => {
    const home = accountHome()
    const asked: string[] = []
    expect(await selectRunDirectories({ kind: "run", args: [] }, io(home, 1, asked))).toEqual({ kind: "another-machine", account: { accountHome: home, userDataRoot: join(home, ".flywheel") } })
    expect(asked).toEqual([join(home, ".flywheel")])
    await expect(selectRunDirectories({ kind: "run", args: [] }, io(home, 0))).rejects.toBeInstanceOf(AccountHomeRefusal)
  })

  test("flywheel web in the account home of a paired terminal is still refused, and reads no device store", async () => {
    const home = accountHome()
    const asked: string[] = []
    await expect(selectRunDirectories({ kind: "run", args: ["web"] }, io(home, 1, asked))).rejects.toBeInstanceOf(AccountHomeRefusal)
    expect(asked).toEqual([])
  })

  function remoteAttach(closed: string[]): RemoteAttach {
    return {
      machine: "box",
      project: "flywheel",
      runtimeId: "runtime-1",
      placementId: "placement-1",
      handoff: "runtime-1.placement-1",
      release: { version: "0.2.0", protocolVersion: 1 },
      connect: () => { throw new Error("startup never connects") },
      close: () => { closed.push("relay client closed") },
    }
  }

  function remoteBoundaries(order: string[], env: { [name: string]: string | undefined }, home: string, choice: Awaited<ReturnType<StartupBoundaries["chooseRemote"]>>, requests: Omit<TerminalRemoteRequest, "prompt" | "print">[] = []): StartupBoundaries {
    return {
      ...recordingBoundaries(order, env),
      selectDirectories: async () => ({ kind: "another-machine", account: { accountHome: home, userDataRoot: join(home, ".flywheel") } }),
      chooseRemote: async (request) => { requests.push(request); return choice },
      installRelease: async (_account, version) => { order.push(`install ${version}`); return { command: ["/account/bin/flywheel-0.3.0"], env: {} } },
      handoffSeams: {
        env: { PATH: "/usr/bin" },
        leaveTerminal: async () => ({ state: undefined, resume: async () => {}, destroy: async () => {} }),
        replace: (command, successorEnv) => {
          order.push(`become ${command.join(" ")} with ${successorEnv[REMOTE_HANDOFF_ENV]}`)
          throw new Error("replaced")
        },
      },
    }
  }

  test("a machine on a later release installs it and becomes it, handing the project on", async () => {
    const order: string[] = []
    const home = accountHome()
    const boundaries = remoteBoundaries(order, {}, home, { kind: "install", version: "0.3.0", machine: "box", handoff: "runtime-1.placement-1" })
    const write = spyOn(process.stdout, "write").mockImplementation(() => true)
    try {
      await expect(prepareCliStartup({ kind: "run", args: [], remote: true }, boundaries)).rejects.toThrow("replaced")
    } finally {
      write.mockRestore()
    }
    expect(order).toEqual([`live build registered ${join(home, ".flywheel")}`, "install 0.3.0", "live build withdrawn", "become /account/bin/flywheel-0.3.0 --remote with runtime-1.placement-1"])
  })

  test("the build it becomes opens the handed project without asking, consumes the variable, and keeps its state under the account", async () => {
    const order: string[] = []
    const closed: string[] = []
    const home = accountHome()
    const env: StartupBoundaries["env"] = { [REMOTE_HANDOFF_ENV]: "runtime-1.placement-1" }
    const requests: Omit<TerminalRemoteRequest, "prompt" | "print">[] = []
    const remote = remoteAttach(closed)
    const startup = await prepareCliStartup({ kind: "run", args: [], remote: true }, remoteBoundaries(order, env, home, { kind: "attach", attach: remote }, requests))
    const stateRoot = join(home, ".flywheel", "machines", "runtime-1", "placement-1")
    expect(requests.map((request) => request.handed)).toEqual(["runtime-1.placement-1"])
    expect(env[REMOTE_HANDOFF_ENV]).toBeUndefined()
    expect(startup?.remote).toBe(remote)
    expect(startup?.attach).toBeUndefined()
    expect(startup?.directories).toEqual({ accountHome: home, userDataRoot: join(home, ".flywheel"), projectRoot: stateRoot, executionCwd: stateRoot })
    expect(existsSync(stateRoot)).toBe(true)
    expect(order).toContain(`log initialized ${stateRoot} print=false`)
    expect(closed).toEqual([])
  })

  test("a startup that fails after the choice ends the relay client", async () => {
    const order: string[] = []
    const closed: string[] = []
    const home = accountHome()
    const boundaries = { ...remoteBoundaries(order, {}, home, { kind: "attach", attach: remoteAttach(closed) }), initLog: async () => { throw new Error("the log cannot be opened") } }
    await expect(prepareCliStartup({ kind: "run", args: [], remote: true }, boundaries)).rejects.toThrow("the log cannot be opened")
    expect(closed).toEqual(["relay client closed"])
  })
})

describe("the terminal record of a headless run that fails before it runs", () => {
  test("names the task and the stage that failed", async () => {
    const records: unknown[] = []
    const observer = () => createHeadlessOutputObserver({ write: (line) => { records.push(JSON.parse(line)); return true }, once() {} })
    for (const failure of ["usage_error", "project_error", "command_error"] as const) {
      await publishFailedHeadlessTerminal(observer(), "/project", failure)
    }
    expect(records).toEqual(["usage_error", "project_error", "command_error"].map((failure) => ({
      kind: "chat.terminal", version: 4, completed: false, projectRoot: "/project", termination: { version: 2, deadlineFired: false }, failure,
    })))
  })
})
