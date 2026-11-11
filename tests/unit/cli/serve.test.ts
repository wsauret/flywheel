import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { readRuntimeIdentity } from "../../../src/cli/runtime-attach.js"
import { accountHomeWatch, createRegistrationRetirement, createSupersededRetirementDecision, releaseHarnessRuntimeOptions, runServe, serveExitCode } from "../../../src/cli/serve.js"
import { SERVICE_NAMES } from "../../../src/orchestration/app-service/account-service-registration.js"
import type { ReplacementTrigger } from "../../../src/orchestration/app-service/replacement-owner.js"
import { SERVE_EXIT } from "../../../src/cli/serve-contract.js"
import { Log } from "../../../src/infra/log.js"
import { processHolders } from "../../../src/infra/process-holder.js"
import { ServeLifetime } from "../../../src/orchestration/app-service/serve-lifetime.js"
import { createLoginShellPath } from "../../../src/infra/login-shell-path.js"
import type { LauncherContext } from "../../../src/infra/process-supervisor.js"
import { createPersistentProcessManager } from "../../../src/infra/persistent-process-manager.js"
import { serveLaneFor } from "../../../src/infra/cli-subprocess.js"
import { accountServeDir, accountServeRecordPath, accountServeSocketPath, accountServeStartLockPath, accountServeTokenPath } from "../../../src/infra/paths.js"
import { decodeServeStatusLine, ServeStartupFailure } from "../../../src/protocol/serve-handshake.js"
import { RUNTIME_PROTOCOL_VERSION } from "../../../src/protocol/runtime-liveness.js"
import { sourceBuildId } from "../../../src/orchestration/app-service/runtime-executable.js"
import { countStart, IDLE_SERVE, INSTALLED, startRecordText, statusRecords, unprobedLoginShellPath, unusedLauncher, waitFor } from "./_serve-fixtures.js"
import { decodeServeStatusLine as decodeV009StatusLine } from "../../fixtures/serve-handshake-v0-0-9.js"
import { socketTemporaryRoot } from "../../helpers/directories.js"

// A serve run in this test process serves the lane of this process's executable.
const lane = serveLaneFor(process.execPath)
let temporaryRoot: string | undefined

afterEach(() => {
  if (temporaryRoot) fs.rmSync(temporaryRoot, { recursive: true, force: true })
  temporaryRoot = undefined
})

/** A launcher for a start that parks before it serves, which starts not
 *  even a guardian. */
function parkedLauncher(): LauncherContext {
  return { ...unusedLauncher(), startGuardian: async () => { throw new Error("a parked start must not start a guardian") } }
}

describe("flywheel serve", () => {
  test("a newer installed build requests replacement by both builds and answers as the owner does", async () => {
    let currentBuild: { buildId: string; version: string } | undefined = { buildId: "old", version: "0.9.0" }
    let answer: "busy" | "retiring" = "busy"
    const requests: ReplacementTrigger[] = []
    let beforeRetireRan = 0
    const retireIfSuperseded = createSupersededRetirementDecision({
      ownBuild: "old",
      currentBuild: () => currentBuild,
      request: async (trigger, beforeRetire) => {
        requests.push(trigger)
        if (answer === "retiring") await beforeRetire?.()
        return answer
      },
    })

    // An unchanged build asks nothing.
    expect(await retireIfSuperseded()).toBe("busy")
    expect(requests).toEqual([])
    // A newer build requests by both builds, every time it is asked, and
    // stays busy while the owner reports blockers.
    currentBuild = { buildId: "new", version: "1.0.0" }
    const newer: ReplacementTrigger = { kind: "newer build installed", ownBuild: "old", installedBuild: "new" }
    expect(await retireIfSuperseded()).toBe("busy")
    expect(await retireIfSuperseded()).toBe("busy")
    expect(requests).toEqual([newer, newer])
    // Once the owner drains, the cutover hears retiring after its answer hook.
    answer = "retiring"
    expect(await retireIfSuperseded(async () => { beforeRetireRan += 1 })).toBe("retiring")
    expect(beforeRetireRan).toBe(1)
    // A build identity that cannot be read is never a reason to move.
    currentBuild = undefined
    expect(await retireIfSuperseded()).toBe("busy")
    expect(requests).toEqual([newer, newer, newer])
  })

  test("a service with no build identity of its own never requests replacement", async () => {
    const requests: string[] = []
    const retireIfSuperseded = createSupersededRetirementDecision({
      ownBuild: undefined,
      currentBuild: () => ({ buildId: "new", version: "1.0.0" }),
      request: async (trigger) => { requests.push(trigger.kind); return "retiring" },
    })
    expect(await retireIfSuperseded()).toBe("busy")
    expect(requests).toEqual([])
  })

  test("every service manager reads one exit-code contract: 0 parks the job, anything else restarts it", () => {
    expect(SERVE_EXIT.parked).toBe(0)
    expect(SERVE_EXIT.restart).not.toBe(0)
    // Retiring for a newer build or a stale registration, and a stop by a
    // signal such as the one `flywheel kill` sends, all come back.
    expect(serveExitCode("retired")).toBe(SERVE_EXIT.restart)
    expect(serveExitCode("signaled")).toBe(SERVE_EXIT.restart)
    // A service nothing holds and nothing registered is not restarted.
    expect(serveExitCode("unheld")).toBe(SERVE_EXIT.parked)
  })

  test("a resident service asks for its own replacement when its registration changed", async () => {
    const requests: string[] = []
    const request = async () => { requests.push("requested"); return "busy" as const }
    const due = (answer: boolean) => ({ atBuildTick: async () => answer })

    await createRegistrationRetirement({ resident: Promise.resolve(true), refresh: due(true), request })()
    expect(requests).toEqual(["requested"])
    await createRegistrationRetirement({ resident: Promise.resolve(true), refresh: due(false), request })()
    await createRegistrationRetirement({ resident: Promise.resolve(false), refresh: due(true), request })()
    await createRegistrationRetirement({ resident: Promise.resolve(true), refresh: undefined, request })()
    expect(requests).toEqual(["requested"])
  })

  test("the build tick reads the account home as gone only when the file system says it is missing, and records an unreadable home once", () => {
    let failure: string | undefined
    const watch = accountHomeWatch("/Users/test", () => {
      if (failure !== undefined) throw Object.assign(new Error(`${failure}: /Users/test`), { code: failure })
    })
    const warn = spyOn(Log.create({ service: "serve" }), "warn").mockImplementation(() => {})
    const info = spyOn(Log.create({ service: "serve" }), "info").mockImplementation(() => {})
    try {
      failure = "EACCES"
      expect(watch()).toBe("unknown")
      expect(watch()).toBe("unknown")
      expect(warn).toHaveBeenCalledTimes(1)
      failure = undefined
      expect(watch()).toBe("present")
      expect(watch()).toBe("present")
      expect(info).toHaveBeenCalledTimes(1)
      for (const code of ["ENOENT", "ENOTDIR"]) {
        failure = code
        expect(watch()).toBe("gone")
      }
    } finally {
      warn.mockRestore()
      info.mockRestore()
    }
  })

  test("admits ephemeral hub binding only for the release performance harness", () => {
    expect(releaseHarnessRuntimeOptions({})).toEqual({})
    expect(() => releaseHarnessRuntimeOptions({
      FLYWHEEL_INTERNAL_RELEASE_HUB_PORT: "0",
    })).toThrow("release performance harness")
    expect(() => releaseHarnessRuntimeOptions({
      FLYWHEEL_INTERNAL_RELEASE_HARNESS: "account-service-isolation-v1",
      FLYWHEEL_INTERNAL_RELEASE_HUB_PORT: "41001",
    })).toThrow("ephemeral")

    const options = releaseHarnessRuntimeOptions({
      FLYWHEEL_INTERNAL_RELEASE_HARNESS: "account-service-isolation-v1",
      FLYWHEEL_INTERNAL_RELEASE_HUB_PORT: "0",
    })
    expect(options.startHub).toBeFunction()
  })

  test("starts without a project and publishes a secret-free readiness handshake", async () => {
    temporaryRoot = fs.mkdtempSync(path.join(socketTemporaryRoot(), "fw-serve-"))
    const accountHome = path.join(temporaryRoot, "home")
    const userDataRoot = path.join(accountHome, ".flywheel")
    const projectRoot = path.join(temporaryRoot, "unopened-project")
    fs.mkdirSync(userDataRoot, { recursive: true })
    fs.mkdirSync(projectRoot)

    const output: string[] = []
    const write = spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk))
      return true
    })
    // The guardian is asked to start before the service listens, and a start
    // that fails is the first launch's to retry, not the serve's to report.
    let guardianStartRequestedBeforeListening: boolean | undefined
    // The login shell PATH probe runs a person's startup files, so it is
    // requested only once the service listens, off the attach path.
    let loginShellProbeRequestedAfterListening: boolean | undefined
    const launcher: LauncherContext = {
      scope: {
        spawnOwned: async () => { throw new Error("zero-project serve must not launch a process") },
        adoptOwned: async () => { throw new Error("a unit test adopts no command") },
        open: () => { throw new Error("zero-project serve must not open a launch scope") },
        close: async () => ({ settled: true }),
      },
      guardian: {
        openGeneration: async () => { throw new Error("zero-project serve must not open a guardian generation") },
        pid: async () => 0,
      },
      startGuardian: async () => {
        guardianStartRequestedBeforeListening = !output.some((chunk) => chunk.includes('"flywheel":"serve.listening"'))
        throw new Error("guardian unavailable")
      },
    }
    const manager = createPersistentProcessManager()
    let exitCode: number | undefined
    // The hub stops inside the drain; what the rendezvous looks like at that
    // moment is what a successor started during the drain would find.
    let rendezvousAtHubStop: { identity: boolean; socket: boolean } | undefined
    await countStart(userDataRoot)
    const serving = runServe([], {
      executionCwd: projectRoot,
      projectRoot,
      accountHome,
      userDataRoot,
    }, launcher, manager, false, {
      drainWatchdog: () => ({ arm() {}, dispose: async () => {} }),
      loginShellPath: {
        ...createLoginShellPath(),
        probe: async () => {
          loginShellProbeRequestedAfterListening = output.some((chunk) => chunk.includes('"flywheel":"serve.listening"'))
        },
      },
      // An install activated a newer build after this service started. The
      // service still names the build it executes, never the one `current` names.
      installedBuild: () => ({ buildId: "installed-after-exec", version: "9.9.9" }),
      startHub: () => ({
        origin: "http://127.0.0.1:41000", held: () => true,
        stop() {
          rendezvousAtHubStop ??= {
            identity: fs.existsSync(accountServeRecordPath(userDataRoot, lane)),
            socket: fs.existsSync(accountServeSocketPath(userDataRoot, lane)),
          }
        },
      }),
    })

    try {
      await waitFor(() => output.some((chunk) => chunk.includes('"flywheel":"serve.listening"')))
      const line = output.join("").split("\n").find((candidate) => candidate.includes('"flywheel":"serve.listening"'))
      if (!line) throw new Error("serve readiness handshake was not written")
      const handshake = decodeServeStatusLine(line)
      const credential = fs.readFileSync(accountServeTokenPath(userDataRoot, lane), "utf8").trim()

      expect(handshake?.flywheel).toBe("serve.listening")
      expect(guardianStartRequestedBeforeListening).toBe(true)
      expect(loginShellProbeRequestedAfterListening).toBe(true)
      expect(output.join("")).not.toContain("serve.startup.failed")
      expect(fs.existsSync(accountServeSocketPath(userDataRoot, lane))).toBe(true)
      expect(line).not.toContain(credential)
      expect(handshake).not.toHaveProperty("credential")
      expect(handshake).not.toHaveProperty("token")
      expect(fs.existsSync(path.join(projectRoot, ".flywheel"))).toBe(false)
      // The start listened, so no start of it is left counted. The listen
      // proves nothing about its build: only a project executor that reports
      // ready does.
      await waitFor(() => !("unlistened" in JSON.parse(startRecordText(userDataRoot))))
      expect(JSON.parse(startRecordText(userDataRoot))).toEqual({ version: 2 })
      expect(readRuntimeIdentity(accountServeRecordPath(userDataRoot, lane))?.buildId).toBe(sourceBuildId(RUNTIME_PROTOCOL_VERSION))

      // A client that cannot run the attach rules itself, such as the editor
      // extension, asks this build to find or start the service. It finds
      // this one listening, starts nothing, and prints its listening record.
      const printed = output.length
      expect(await runServe(["ensure"], { executionCwd: projectRoot, projectRoot, accountHome, userDataRoot }, launcher, manager, false)).toBe(0)
      expect(statusRecords(output.slice(printed))).toEqual([{ flywheel: "serve.listening", pid: process.pid, version: handshake?.flywheel === "serve.listening" ? handshake.version : "", protocolVersion: RUNTIME_PROTOCOL_VERSION, lane }])

      // A second start finds this owner serving and parks, so no service
      // manager restarts it in a loop. Parking is not a failed start, so it
      // takes its count back.
      await countStart(userDataRoot)
      expect(await runServe([], { executionCwd: projectRoot, projectRoot, accountHome, userDataRoot }, launcher, manager, false)).toBe(SERVE_EXIT.parked)
      expect(JSON.parse(startRecordText(userDataRoot))).toEqual({ version: 2 })
      expect(output.join("")).toContain('"flywheel":"serve.already-listening"')

      // An owner whose identity record names no protocol still serves, so
      // this start parks too, and says why to a client that launched it.
      const identityPath = accountServeRecordPath(userDataRoot, lane)
      const published = fs.readFileSync(identityPath, "utf8")
      const identity = readRuntimeIdentity(identityPath)
      fs.writeFileSync(identityPath, `${JSON.stringify({ pid: identity?.pid, version: identity?.version })}\n`)
      expect(await runServe([], { executionCwd: projectRoot, projectRoot, accountHome, userDataRoot }, launcher, manager, false)).toBe(SERVE_EXIT.parked)
      expect(output.join("")).toContain("A running account service did not publish a compatible identity record. Run `flywheel kill`, then start Flywheel again.")
      fs.writeFileSync(identityPath, published)
    } finally {
      process.emit("SIGINT", "SIGINT")
      exitCode = await serving
      manager.releaseAll()
      write.mockRestore()
    }
    // A stop by a signal is restarted by the service manager.
    expect(exitCode).toBe(SERVE_EXIT.restart)
    // A stopping service withdraws from discovery before it drains, so the
    // next serve can claim the address while this one settles: its listener
    // stops first, which removes the socket path or closes the named pipe,
    // and the identity record goes next.
    expect(rendezvousAtHubStop).toEqual({ identity: false, socket: false })
    expect(fs.existsSync(accountServeRecordPath(userDataRoot, lane))).toBe(false)
    expect(fs.existsSync(accountServeSocketPath(userDataRoot, lane))).toBe(false)
  }, 15_000)

  test("a dev serve that nothing holds retires on its own after its graces and hands the lane to its registered job", async () => {
    temporaryRoot = fs.mkdtempSync(path.join(socketTemporaryRoot(), "fw-serve-idle-"))
    const accountHome = path.join(temporaryRoot, "home")
    const userDataRoot = path.join(accountHome, ".flywheel")
    fs.mkdirSync(userDataRoot, { recursive: true })
    const write = spyOn(process.stdout, "write").mockImplementation(() => true)
    const launcher = unusedLauncher()
    const manager = createPersistentProcessManager()
    let exitCode: number | undefined
    // The registration refresh runs once the service listens, never on the
    // way to the start lock.
    const refreshed: string[] = []
    // A dev service that a client started never reads its registration on
    // a build tick, because no registration makes it resident
    // (ARCH-RUNTIME-081). Once nothing holds it, it asks the service manager
    // to start the registered job, which answers false when none exists.
    const registrationCalls: string[] = []
    try {
      // No client ever connects: the startup grace passes, then the idle grace,
      // and the serve resolves its own stop without a signal.
      exitCode = await runServe([], { executionCwd: temporaryRoot, projectRoot: temporaryRoot, accountHome, userDataRoot }, launcher, manager, false, {
        drainWatchdog: () => ({ arm() {}, dispose: async () => {} }),
        loginShellPath: unprobedLoginShellPath(),
        startHub: () => ({ origin: "http://127.0.0.1:41000", held: () => true, stop() {} }),
        serveLifetime: () => new ServeLifetime({ resident: false, startupGraceMs: 20, idleGraceMs: 10 }),
        buildCheckMs: 5,
        registrationRefresh: () => ({
          atStart: async () => { refreshed.push("start"); return "serve" },
          afterListening: async () => { refreshed.push(fs.existsSync(accountServeRecordPath(userDataRoot, lane)) ? "listening" : "not listening") },
          atBuildTick: async () => false,
          startedByManager: () => false,
        }),
        serviceInstallation: () => ({
          registered: async () => { registrationCalls.push("registered"); return true },
          start: async () => { registrationCalls.push("start"); return true },
        }),
      })
    } finally {
      manager.releaseAll()
      write.mockRestore()
    }
    expect(exitCode).toBe(SERVE_EXIT.parked)
    expect(refreshed).toEqual(["start", "listening"])
    expect(registrationCalls).toEqual(["start"])
    expect(fs.existsSync(accountServeRecordPath(userDataRoot, lane))).toBe(false)
    expect(fs.existsSync(accountServeSocketPath(userDataRoot, lane))).toBe(false)
  }, 15_000)

  test("a client-started service in the login home whose registration appears retires once nothing holds it and then starts the registered job", async () => {
    temporaryRoot = fs.mkdtempSync(path.join(socketTemporaryRoot(), "fw-serve-handback-"))
    const accountHome = path.join(temporaryRoot, "home")
    const userDataRoot = path.join(accountHome, ".flywheel")
    fs.mkdirSync(userDataRoot, { recursive: true })
    const write = spyOn(process.stdout, "write").mockImplementation(() => true)
    const manager = createPersistentProcessManager()
    const events: string[] = []
    const addressHeld = () => fs.existsSync(accountServeSocketPath(userDataRoot, lane)) || fs.existsSync(accountServeRecordPath(userDataRoot, lane))
    let exitCode: number | undefined
    try {
      exitCode = await runServe([], { executionCwd: temporaryRoot, projectRoot: temporaryRoot, accountHome, userDataRoot }, unusedLauncher(), manager, false, {
        drainWatchdog: () => ({ arm() {}, dispose: async () => { events.push("drain watchdog disposed") } }),
        loginShellPath: unprobedLoginShellPath(),
        startHub: () => ({ origin: "http://127.0.0.1:41000", held: () => true, stop() { events.push("hub stopped") } }),
        // No registration existed when it started, so it was resident; a
        // person turns Process initiation on while it serves.
        residency: async () => ({ resident: true, followsRegistration: true, startsRegisteredJob: true }),
        serveLifetime: () => new ServeLifetime({ resident: true, idleGraceMs: 10 }),
        buildCheckMs: 20,
        installedBuild: () => undefined,
        registrationRefresh: () => ({ atStart: async () => "serve", afterListening: async () => {}, atBuildTick: async () => false, startedByManager: () => false }),
        serviceInstallation: () => ({
          registered: async () => true,
          start: async () => {
            events.push(`registered job started with the address ${addressHeld() ? "held" : "free"}`)
            return true
          },
        }),
      })
    } finally {
      manager.releaseAll()
      write.mockRestore()
    }
    // Nothing restarts a service that a client started, so its exit parks.
    expect(exitCode).toBe(SERVE_EXIT.parked)
    expect(events).toEqual(["hub stopped", "registered job started with the address free", "drain watchdog disposed"])
  }, 15_000)

  test("a successor that binds the address while this service drains keeps it", async () => {
    temporaryRoot = fs.mkdtempSync(path.join(socketTemporaryRoot(), "fw-serve-successor-"))
    const accountHome = path.join(temporaryRoot, "home")
    const userDataRoot = path.join(accountHome, ".flywheel")
    fs.mkdirSync(userDataRoot, { recursive: true })
    const write = spyOn(process.stdout, "write").mockImplementation(() => true)
    const manager = createPersistentProcessManager()
    const socketPath = accountServeSocketPath(userDataRoot, lane)
    // A home with no registration: the successor binds as soon as it finds
    // nothing listening, which is while this service still drains.
    let successor: ReturnType<typeof Bun.listen> | undefined
    try {
      const exitCode = await runServe([], { executionCwd: temporaryRoot, projectRoot: temporaryRoot, accountHome, userDataRoot }, unusedLauncher(), manager, false, {
        drainWatchdog: () => ({ arm() {}, dispose: async () => {} }),
        loginShellPath: unprobedLoginShellPath(),
        startHub: () => ({
          origin: "http://127.0.0.1:41000", held: () => true,
          stop() {
            successor = Bun.listen({ unix: socketPath, socket: { data() {} } })
          },
        }),
        serveLifetime: () => new ServeLifetime({ resident: false, startupGraceMs: 20, idleGraceMs: 10 }),
        installedBuild: () => undefined,
        registrationRefresh: () => ({ atStart: async () => "serve", afterListening: async () => {}, atBuildTick: async () => false, startedByManager: () => false }),
      })
      expect(exitCode).toBe(SERVE_EXIT.parked)
      expect(successor).toBeDefined()
      expect(fs.existsSync(socketPath)).toBe(true)
      const probe = await Bun.connect({ unix: socketPath, socket: { data() {} } })
      probe.end()
    } finally {
      successor?.stop(true)
      manager.releaseAll()
      write.mockRestore()
    }
  }, 15_000)

  test("a resident serve whose account home is gone retires as an unheld one does", async () => {
    temporaryRoot = fs.mkdtempSync(path.join(socketTemporaryRoot(), "fw-serve-gone-"))
    // POSIX also exercises removal of the database the service holds open.
    const accountHome = path.join(temporaryRoot, "home")
    if (process.platform === "win32") {
      // Windows cannot unlink the open store; its home junction can disappear.
      const backingHome = path.join(temporaryRoot, "home-data")
      fs.mkdirSync(backingHome)
      fs.symlinkSync(path.resolve(backingHome), accountHome, "junction")
    }
    const userDataRoot = path.join(accountHome, ".flywheel")
    fs.mkdirSync(userDataRoot, { recursive: true })
    const output: string[] = []
    const write = spyOn(process.stdout, "write").mockImplementation((chunk) => { output.push(String(chunk)); return true })
    const launcher = unusedLauncher()
    const manager = createPersistentProcessManager()
    const serving = runServe([], { executionCwd: temporaryRoot, projectRoot: temporaryRoot, accountHome, userDataRoot }, launcher, manager, false, {
      drainWatchdog: () => ({ arm() {}, dispose: async () => {} }),
      loginShellPath: unprobedLoginShellPath(),
      startHub: () => ({ origin: "http://127.0.0.1:41000", held: () => true, stop() {} }),
      // Resident: nothing but the lost home retires it.
      serveLifetime: () => new ServeLifetime({ resident: true }),
      installedBuild: () => undefined,
      registrationRefresh: () => ({ atStart: async () => "serve", afterListening: async () => {}, atBuildTick: async () => false, startedByManager: () => true }),
      // On POSIX the first tick follows the store watch's removed-database
      // failure, so retirement must still work after that failure.
      buildCheckMs: 200,
    })
    let exitCode: number | undefined
    void serving.then((code) => { exitCode = code })
    try {
      await waitFor(() => output.some((chunk) => chunk.includes('"flywheel":"serve.listening"')))
      // A harness removes the home of a service it no longer tracks.
      fs.rmSync(accountHome, { recursive: true, force: true })
      await waitFor(() => exitCode !== undefined, 2_000)
    } finally {
      if (exitCode === undefined) process.emit("SIGINT", "SIGINT")
      await serving
      manager.releaseAll()
      write.mockRestore()
    }
    expect(exitCode).toBe(SERVE_EXIT.parked)
  }, 15_000)

  test.each([
    ["hands its stale registration to launchd parks", "park", SERVE_EXIT.parked],
    ["cannot learn whether a registration reload is in flight exits to be restarted", "ask-again", SERVE_EXIT.restart],
  ] as const)("a start that %s before it takes the start lock or listens", async (_name, decision, expected) => {
    // This start never binds a socket, so the platform's temporary directory
    // serves regardless of its length.
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fw-serve-stale-"))
    const accountHome = path.join(temporaryRoot, "home")
    const userDataRoot = path.join(accountHome, ".flywheel")
    fs.mkdirSync(userDataRoot, { recursive: true })
    const output: string[] = []
    const write = spyOn(process.stdout, "write").mockImplementation((chunk) => { output.push(String(chunk)); return true })
    const launcher = parkedLauncher()
    const manager = createPersistentProcessManager()
    try {
      const exitCode = await runServe([], { executionCwd: temporaryRoot, projectRoot: temporaryRoot, accountHome, userDataRoot }, launcher, manager, false, {
        registrationRefresh: () => ({ atStart: async () => decision, afterListening: async () => {}, atBuildTick: async () => false, startedByManager: () => false }),
      })
      expect(exitCode).toBe(expected)
    } finally {
      manager.releaseAll()
      write.mockRestore()
    }
    expect(output.join("")).not.toContain("serve.listening")
    expect(fs.existsSync(accountServeStartLockPath(userDataRoot, lane))).toBe(false)
    expect(fs.existsSync(accountServeRecordPath(userDataRoot, lane))).toBe(false)
  })

  test("a start that a registration handoff parks takes its count back", async () => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fw-serve-handoff-"))
    const accountHome = path.join(temporaryRoot, "home")
    const userDataRoot = path.join(accountHome, ".flywheel")
    fs.mkdirSync(userDataRoot, { recursive: true })
    for (const decision of ["park", "ask-again"] as const) {
      await countStart(userDataRoot)
      const exitCode = await runServe([], { executionCwd: temporaryRoot, projectRoot: temporaryRoot, accountHome, userDataRoot }, unusedLauncher(), createPersistentProcessManager(), false, {
        registrationRefresh: () => ({
          atStart: async () => decision,
          afterListening: async () => {},
          atBuildTick: async () => false,
          startedByManager: () => true,
        }),
      })
      expect(exitCode).toBe(decision === "park" ? SERVE_EXIT.parked : SERVE_EXIT.restart)
      expect(JSON.parse(startRecordText(userDataRoot))).toEqual({ version: 2 })
    }
  })

  test("a start that another process's port keeps from listening names the port and takes its count back; any other failure stays counted", async () => {
    temporaryRoot = fs.mkdtempSync(path.join(socketTemporaryRoot(), "fw-serve-port-"))
    const accountHome = path.join(temporaryRoot, "home")
    const userDataRoot = path.join(accountHome, ".flywheel")
    fs.mkdirSync(userDataRoot, { recursive: true })
    const output: string[] = []
    const write = spyOn(process.stdout, "write").mockImplementation((chunk) => { output.push(String(chunk)); return true })
    const held = "Failed to start server. Is port 41000 in use?"
    const failures = [
      { fail: () => new ServeStartupFailure(held, { kind: "port-in-use", port: 41000 }), printed: { flywheel: "serve.startup.failed", error: held, refusal: { kind: "port-in-use", port: 41000 } } },
      { fail: () => Object.assign(new Error(held), { code: "EADDRINUSE" }), printed: { flywheel: "serve.startup.failed", error: held } },
      { fail: () => new Error("the build cannot compose its hub"), printed: { flywheel: "serve.startup.failed", error: "the build cannot compose its hub" } },
    ] as const
    try {
      for (const { fail, printed } of failures) {
        output.length = 0
        await countStart(userDataRoot)
        await expect(runServe([], { executionCwd: temporaryRoot, projectRoot: temporaryRoot, accountHome, userDataRoot }, unusedLauncher(), createPersistentProcessManager(), false, {
          drainWatchdog: () => ({ arm() {}, dispose: async () => {} }),
          startHub: () => { throw fail() },
        })).rejects.toThrow(printed.error)
        expect(statusRecords(output).filter((record) => record.flywheel === "serve.startup.failed")).toEqual([printed])
      }
    } finally {
      write.mockRestore()
    }
    expect(JSON.parse(startRecordText(userDataRoot))).toEqual({ version: 2, unlistened: { buildId: INSTALLED.buildId, starts: 1 } })
  }, 15_000)

  test.each([
    // An earlier build's record, which names no identity: its pid runs, so
    // it is waited for and never taken over. `flywheel kill` clears it.
    ["a live holder keeps names the holder's pid", { pid: process.pid, owner: "held" }, false],
    // A holder that is gone, and the empty claim on it that an earlier
    // release leaves while it reclaims. The claim clears itself only once it
    // is ten minutes old, and no reset clears it sooner, so it names itself.
    ["an earlier release's fresh empty claim keeps names the claim", { pid: 2_147_483_647, owner: "gone" }, true],
  ] as const)("a start whose start lock %s, exits to be asked again, and takes its count back", async (_name, holder, emptyClaim) => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fw-serve-held-"))
    const accountHome = path.join(temporaryRoot, "home")
    const userDataRoot = path.join(accountHome, ".flywheel")
    const lockPath = accountServeStartLockPath(userDataRoot, lane)
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })
    fs.writeFileSync(lockPath, JSON.stringify(holder))
    const claimPath = `${lockPath}.reclaim.${createHash("sha256").update(holder.owner).digest("hex")}`
    if (emptyClaim) fs.writeFileSync(claimPath, "")
    const output: string[] = []
    const write = spyOn(process.stdout, "write").mockImplementation((chunk) => { output.push(String(chunk)); return true })
    await countStart(userDataRoot)
    let exitCode: number | undefined
    try {
      exitCode = await runServe([], { executionCwd: temporaryRoot, projectRoot: temporaryRoot, accountHome, userDataRoot }, unusedLauncher(), createPersistentProcessManager(), false, { startLockBaseDelayMs: 1 })
    } finally {
      write.mockRestore()
    }
    expect(exitCode).toBe(SERVE_EXIT.restart)
    const failed = statusRecords(output).find((record) => record.flywheel === "serve.startup.failed")
    // An older terminal starts this build's service during an update, and
    // still reads the failure: it skips the refusal record it does not know.
    expect(output.join("").split("\n").flatMap((line) => decodeV009StatusLine(line) ?? [])).toEqual([{ flywheel: "serve.startup.failed", error: expect.any(String) }])
    // A holder that a reset clears names no refusal, so a client shows the reset.
    expect(failed).toEqual(emptyClaim
      ? { flywheel: "serve.startup.failed", error: expect.stringContaining("is empty"), refusal: { kind: "claim-settling", path: claimPath } }
      : { flywheel: "serve.startup.failed", error: expect.stringContaining(`pid ${holder.pid}`) })
    expect(JSON.parse(startRecordText(userDataRoot))).toEqual({ version: 2, failing: expect.objectContaining({ starts: 1 }) })
    expect(JSON.parse(fs.readFileSync(lockPath, "utf8"))).toEqual(holder)
  })

  test("a start lock whose pid another process now holds is reclaimed, and the start serves", async () => {
    temporaryRoot = fs.mkdtempSync(path.join(socketTemporaryRoot(), "fw-serve-recycled-"))
    const accountHome = path.join(temporaryRoot, "home")
    const userDataRoot = path.join(accountHome, ".flywheel")
    const lockPath = accountServeStartLockPath(userDataRoot, lane)
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })
    // This boot, this pid, another start stamp: the holder exited and its
    // pid was given to this process.
    const own = processHolders.own() ?? expect.unreachable("the kernel did not give this test process its identity")
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, owner: "recycled", v: 1, start: "1", ...(own.boot === undefined ? {} : { boot: own.boot }) }))
    const output: string[] = []
    const write = spyOn(process.stdout, "write").mockImplementation((chunk) => { output.push(String(chunk)); return true })
    const manager = createPersistentProcessManager()
    let exitCode: number | undefined
    try {
      exitCode = await runServe([], { executionCwd: temporaryRoot, projectRoot: temporaryRoot, accountHome, userDataRoot }, unusedLauncher(), manager, false, { ...IDLE_SERVE, startLockBaseDelayMs: 1 })
    } finally {
      manager.releaseAll()
      write.mockRestore()
    }
    expect(exitCode).toBe(SERVE_EXIT.parked)
    expect(statusRecords(output).map((record) => record.flywheel)).toEqual(["serve.listening"])
    expect(fs.existsSync(lockPath)).toBe(false)
  }, 15_000)

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)("a start whose address answers a connection with an error that proves nothing keeps the path, exits to be asked again, and takes its count back", async () => {
    temporaryRoot = fs.mkdtempSync(path.join(socketTemporaryRoot(), "fw-serve-eacces-"))
    const accountHome = path.join(temporaryRoot, "home")
    const userDataRoot = path.join(accountHome, ".flywheel")
    const socketPath = accountServeSocketPath(userDataRoot, lane)
    fs.mkdirSync(path.dirname(socketPath), { recursive: true })
    // A live listener whose path this user may not connect to: the connect
    // fails with EACCES, which proves neither a service nor its absence.
    const listener = Bun.listen({ unix: socketPath, socket: { data() {} } })
    fs.chmodSync(socketPath, 0o000)
    const output: string[] = []
    const write = spyOn(process.stdout, "write").mockImplementation((chunk) => { output.push(String(chunk)); return true })
    const manager = createPersistentProcessManager()
    await countStart(userDataRoot)
    let exitCode: number | undefined
    try {
      exitCode = await runServe([], { executionCwd: temporaryRoot, projectRoot: temporaryRoot, accountHome, userDataRoot }, unusedLauncher(), manager, false, IDLE_SERVE)
      expect(fs.existsSync(socketPath)).toBe(true)
    } finally {
      manager.releaseAll()
      write.mockRestore()
      listener.stop(true)
    }
    expect(exitCode).toBe(SERVE_EXIT.restart)
    const failed = statusRecords(output).find((record) => record.flywheel === "serve.startup.failed")
    expect(failed?.flywheel === "serve.startup.failed" ? failed.error : "").toContain("EACCES")
    // `flywheel kill` keeps such a path, so the record names the remedy's own subject.
    expect(failed).toMatchObject({ refusal: { kind: "address-access", path: socketPath, code: "EACCES" } })
    expect(JSON.parse(startRecordText(userDataRoot))).toEqual({ version: 2, failing: expect.objectContaining({ starts: 1 }) })
  }, 15_000)

  test("the scheduled task's marker runs the service, and selects no other operation", async () => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fw-serve-task-"))
    const accountHome = path.join(temporaryRoot, "home")
    const userDataRoot = path.join(accountHome, ".flywheel")
    fs.mkdirSync(userDataRoot, { recursive: true })
    const write = spyOn(process.stdout, "write").mockImplementation(() => true)
    const launcher = parkedLauncher()
    const directories = { executionCwd: temporaryRoot, projectRoot: temporaryRoot, accountHome, userDataRoot }
    const seams = { registrationRefresh: () => ({ atStart: async () => "park" as const, afterListening: async () => {}, atBuildTick: async () => false, startedByManager: () => true }) }
    try {
      expect(await runServe(["--scheduled-task"], directories, launcher, createPersistentProcessManager(), false, seams)).toBe(SERVE_EXIT.parked)
      expect(await refusal(() => runServe(["--scheduled-task", "install"], directories, launcher, createPersistentProcessManager(), false, seams))).toEqual({ code: 1, stderr: expect.stringContaining("unknown argument: install") })
    } finally {
      write.mockRestore()
    }
  })

  test("serve install --update, which an update runs, reaches the registration refresh, and serve install refuses any other option", async () => {
    // A test process runs the dev lane from source, and this home is not the
    // login home, so the refresh registers nothing and runs no command.
    const directories = { executionCwd: "/scratch", projectRoot: "/scratch", accountHome: "/scratch/home", userDataRoot: "/scratch/home/.flywheel" }
    const serve = (args: readonly string[]) => runServe(args, directories, unusedLauncher(), createPersistentProcessManager(), false)

    expect(await refusal(() => serve(["install", "--update"]))).toEqual({ code: 0, stderr: "" })
    expect(await refusal(() => serve(["install", "--bogus"]))).toEqual({ code: 1, stderr: expect.stringContaining("unknown argument: --bogus") })
    expect(await refusal(() => serve(["uninstall", "--update"]))).toEqual({ code: 1, stderr: expect.stringContaining("unknown argument: --update") })
  })

  test("serve dispatches reload-registration, which cannot prove itself the helper job without launchd and, with no registration on disk, asks launchd nothing more", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "fw-serve-reload-"))
    temporaryRoot = root
    const accountHome = path.join(root, "home")
    const userDataRoot = path.join(accountHome, ".flywheel")
    fs.mkdirSync(userDataRoot, { recursive: true })
    // The launch is refused here, so no launchctl command ever runs.
    const launched: string[][] = []
    const launcher: LauncherContext = {
      scope: {
        spawnOwned: async (command) => { launched.push([...command]); throw new Error("a unit test launches no service manager command") },
        adoptOwned: async () => { throw new Error("a unit test adopts no command") },
        open: () => { throw new Error("a reload must not open a launch scope") },
        close: async () => ({ settled: true }),
      },
      guardian: {
        openGeneration: async () => { throw new Error("a reload must not open a guardian generation") },
        pid: async () => 0,
      },
      startGuardian: async () => { throw new Error("a reload must not start a guardian") },
    }

    // The reload first asks launchd which process runs the helper job, and a
    // question that cannot be asked proves nothing, so the reload refuses.
    const uid = process.getuid?.()
    expect(await refusal(() => runServe(["reload-registration"], { executionCwd: root, projectRoot: root, accountHome, userDataRoot }, launcher, createPersistentProcessManager(), false)))
      .toEqual({ code: 1, stderr: expect.stringContaining(uid === undefined ? "launchd needs the account's user id" : "a unit test launches no service manager command") })
    // No registration is on disk in this home, so the reload is Process
    // initiation Off's unload, which starts nothing after a failure and
    // records nothing. A host without a user id names no launchd domain, so
    // it asks nothing. A test runs from source, so it asks about the dev
    // lane's helper.
    expect(launched).toEqual(uid === undefined ? [] : [["launchctl", "print", `gui/${uid}/${SERVICE_NAMES.dev.reloadHelper}`]])
    expect(fs.existsSync(path.join(accountServeDir(userDataRoot, "dev"), "registration-reload.json"))).toBe(false)
    expect(await refusal(() => runServe(["reload-registration", "extra"], { executionCwd: root, projectRoot: root, accountHome, userDataRoot }, launcher, createPersistentProcessManager(), false)))
      .toEqual({ code: 1, stderr: expect.stringContaining("unknown argument: extra") })
  })
})

/** The exit code and standard error of one serve run that refuses. */
async function refusal(run: () => Promise<number>): Promise<{ readonly code: number; readonly stderr: string }> {
  const written: string[] = []
  const stderr = spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => { written.push(String(chunk)); return true })
  try {
    return { code: await run(), stderr: written.join("") }
  } finally {
    stderr.mockRestore()
  }
}
