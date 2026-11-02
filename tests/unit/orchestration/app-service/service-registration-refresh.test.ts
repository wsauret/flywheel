import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { DarwinExecutable } from "../../../../src/infra/darwin-process-api.js"
import { Log } from "../../../../src/infra/log.js"
import type { AccountServiceRegistrationControl } from "../../../../src/orchestration/app-service/account-service-installation.js"
import { createServiceRegistrationRefresh, registrationReloadGuard, takeManagerStartEnvironment } from "../../../../src/orchestration/app-service/service-registration-refresh.js"

const LABEL = "sh.flywl.flywheel.serve"
const PID = 200
const LAUNCHER_PID = 100
const OWN = "aaaaaaaaaaaaaaaa"
const ON_DISK = "bbbbbbbbbbbbbbbb"
const serveDirectories: string[] = []
/** A service that launchd started through the account's launcher, the
 *  parent LAUNCHER_PID, in the proven login home. The test runner's own
 *  executable stands in for the launcher, so the kernel names a real file. */
const LAUNCHD_START = {
  platform: "darwin",
  scheduledTask: false,
  launcherExecutable: process.execPath,
  executableOf: (pid: number): DarwinExecutable => pid === LAUNCHER_PID ? { kind: "path", path: process.execPath } : { kind: "absent" },
  procEntry: () => undefined,
  uid: 1000,
  isLoginHome: async () => true,
} as const
/** /proc/self/cgroup of the account unit's process, in each form systemd
 *  writes it: the unified hierarchy (cgroup v2) and the named systemd
 *  hierarchy beside the controllers (cgroup v1). */
const UNIT_CGROUP_V2 = "0::/user.slice/user-1000.slice/user@1000.service/app.slice/flywheel-serve.service\n"
const UNIT_CGROUP_V1 = [
  "12:pids:/user.slice/user-1000.slice/user@1000.service",
  "4:memory:/user.slice/user-1000.slice",
  "1:name=systemd:/user.slice/user-1000.slice/user@1000.service/flywheel-serve.service",
  "",
].join("\n")
/** Each answer about the login home that proves nothing. */
const UNPROVEN_LOGIN_HOMES: readonly (readonly [string, () => Promise<boolean | undefined>])[] = [
  ["not the login home", async () => false],
  ["a login home the platform does not name", async () => undefined],
  ["a login home that cannot be read", async () => { throw new Error("the account database did not answer") }],
]
/** The systemd user manager of uid 1000, as /proc/<pid>/cgroup and
 *  /proc/<pid>/comm state it. */
const USER_MANAGER = { cgroup: "0::/user.slice/user-1000.slice/user@1000.service/init.scope\n", comm: "systemd\n" }

/** /proc as the kernel states it for this service (PID) and its parent
 *  (LAUNCHER_PID). */
function linuxProc(self: string | undefined, parent: { readonly cgroup?: string; readonly comm?: string } = USER_MANAGER) {
  return (pid: number, entry: "cgroup" | "comm"): string | undefined => {
    if (pid === PID) return entry === "cgroup" ? self : "flywheel\n"
    return pid === LAUNCHER_PID ? parent[entry] : undefined
  }
}

afterEach(() => {
  for (const directory of serveDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

/** The loop guard's record in a serve directory. */
const recorded = (directory: string) => registrationReloadGuard(directory).read()

function serveDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "fw-registration-refresh-"))
  serveDirectories.push(directory)
  return directory
}

function launchdFixture(options: {
  readonly env?: { readonly [name: string]: string | undefined }
  readonly registered?: string | undefined
  readonly jobPid?: number | undefined
  readonly reloadInFlight?: () => Promise<boolean>
  readonly handOff?: () => Promise<string | undefined>
  readonly isLoginHome?: () => Promise<boolean | undefined>
}) {
  const directory = serveDirectory()
  const handOffs: string[] = []
  let loginHomeQuestions = 0
  const isLoginHome = options.isLoginHome ?? LAUNCHD_START.isLoginHome
  const control: AccountServiceRegistrationControl = {
    launchd: {
      registeredFingerprint: async () => options.registered,
      jobPid: async () => options.jobPid,
      reloadInFlight: options.reloadInFlight ?? (async () => false),
      handOffReload: options.handOff ?? (async () => { handOffs.push("handed-off"); return undefined }),
    },
  }
  const refresh = (env = options.env ?? { XPC_SERVICE_NAME: LABEL, FLYWHEEL_SERVICE_REGISTRATION: OWN }) => createServiceRegistrationRefresh({
    ...LAUNCHD_START,
    isLoginHome: () => { loginHomeQuestions += 1; return isLoginHome() },
    env,
    pid: PID,
    ppid: LAUNCHER_PID,
    serveDirectory: directory,
    launchdLabel: LABEL,
    control: () => control,
  })
  const guard = (record: unknown): void => { writeFileSync(join(directory, "registration-reload.json"), `${JSON.stringify(record)}\n`) }
  return { refresh, handOffs, serveDirectory: directory, guard, loginHomeQuestions: () => loginHomeQuestions }
}

describe("launchd registration refresh at start", () => {
  test("a job started under a stale fingerprint records the request, hands re-registration to a helper, and parks", async () => {
    const setup = launchdFixture({ registered: ON_DISK })

    expect(await setup.refresh().atStart()).toBe("park")

    expect(setup.handOffs).toEqual(["handed-off"])
    expect(recorded(setup.serveDirectory)).toEqual({ fingerprint: ON_DISK, outcome: "requested" })
  })

  test("a job whose fingerprint is its own needs no launchd question about its process", async () => {
    // The fingerprint is removed from the environment every child inherits,
    // so only the job's own process carries it.
    const setup = launchdFixture({ registered: ON_DISK, jobPid: 999 })

    expect(await setup.refresh().atStart()).toBe("park")
  })

  // The guard records `requested`, `reloaded`, and `failed` below are the
  // shapes that builds before the `proven` outcome wrote, and they still
  // decide a start as they did.
  test("a start while a requested reload's helper is loaded parks, and asks nothing about the login home", async () => {
    const setup = launchdFixture({ registered: ON_DISK, reloadInFlight: async () => true })
    setup.guard({ fingerprint: ON_DISK, outcome: "requested" })

    expect(await setup.refresh().atStart()).toBe("park")
    expect(setup.handOffs).toEqual([])
    expect(setup.loginHomeQuestions()).toBe(0)
  })

  test.each(["reloaded", "failed"] as const)("a start after a reload that %s serves as it is, even while its helper is still loaded, and asks nothing about the login home", async (outcome) => {
    // A reload that fails starts the job before its helper is removed, and
    // that start must not park behind the helper.
    const inFlight: string[] = []
    const setup = launchdFixture({ registered: ON_DISK, reloadInFlight: async () => { inFlight.push("asked"); return true } })
    setup.guard({ fingerprint: ON_DISK, outcome, error: outcome === "failed" ? "launchctl bootstrap failed (exit 5)" : undefined })

    expect(await setup.refresh().atStart()).toBe("serve")
    expect(inFlight).toEqual([])
    expect(setup.handOffs).toEqual([])
    expect(setup.loginHomeQuestions()).toBe(0)
  })

  test("a stale start that finds the build tick's proof for its fingerprint hands off without asking about the login home", async () => {
    const setup = launchdFixture({ registered: ON_DISK })
    setup.guard({ fingerprint: ON_DISK, outcome: "proven" })

    expect(await setup.refresh().atStart()).toBe("park")

    expect(setup.handOffs).toEqual(["handed-off"])
    expect(recorded(setup.serveDirectory)).toEqual({ fingerprint: ON_DISK, outcome: "requested" })
    expect(setup.loginHomeQuestions()).toBe(0)
  })

  test("a proof recorded for another fingerprint proves nothing for this one", async () => {
    // The login home is asked before the request: here it is not the login home.
    const setup = launchdFixture({ registered: ON_DISK, isLoginHome: async () => false })
    setup.guard({ fingerprint: "cccccccccccccccc", outcome: "proven" })

    expect(await setup.refresh().atStart()).toBe("serve")

    expect(setup.handOffs).toEqual([])
    expect(setup.loginHomeQuestions()).toBe(1)
  })

  test("the loop guard allows one reload per fingerprint on disk, and a later install's fingerprint another", async () => {
    const setup = launchdFixture({ registered: ON_DISK })

    expect(await setup.refresh().atStart()).toBe("park")
    // The helper ended without an outcome: launchd restarts the job under the
    // same stale registration, and this start asks for nothing further.
    expect(await setup.refresh().atStart()).toBe("serve")
    expect(await setup.refresh().atStart()).toBe("serve")
    expect(setup.handOffs).toEqual(["handed-off"])

    const later = createServiceRegistrationRefresh({
      ...LAUNCHD_START,
      env: { XPC_SERVICE_NAME: LABEL, FLYWHEEL_SERVICE_REGISTRATION: OWN },
      pid: PID,
      ppid: LAUNCHER_PID,
      serveDirectory: setup.serveDirectory,
      launchdLabel: LABEL,
      control: () => ({ launchd: { registeredFingerprint: async () => "cccccccccccccccc", jobPid: async () => PID, reloadInFlight: async () => false, handOffReload: async () => { setup.handOffs.push("handed-off"); return undefined } } }),
    })
    expect(await later.atStart()).toBe("park")
    expect(setup.handOffs).toEqual(["handed-off", "handed-off"])
  })

  test.each([
    ["cannot be parsed", "{not json"],
    ["has a shape this build does not know", JSON.stringify({ fingerprint: ON_DISK, outcome: "abandoned" })],
  ])("a guard record that %s allows the attempt", async (_name, text) => {
    const setup = launchdFixture({ registered: ON_DISK })
    writeFileSync(join(setup.serveDirectory, "registration-reload.json"), text)

    expect(await setup.refresh().atStart()).toBe("park")
  })

  test("a start that cannot learn whether a helper is loaded exits to be asked again, before it records or hands off anything", async () => {
    const setup = launchdFixture({ registered: ON_DISK, reloadInFlight: async () => { throw new Error("launchctl print sh.flywl.flywheel.serve.reload did not answer") } })

    expect(await setup.refresh().atStart()).toBe("ask-again")

    expect(setup.handOffs).toEqual([])
    expect(recorded(setup.serveDirectory)).toBeUndefined()
  })

  test("a hand-off launchd refuses after no helper was found serves as it is and records the failure", async () => {
    const setup = launchdFixture({ registered: ON_DISK, handOff: async () => "launchctl submit failed (exit 1)" })

    expect(await setup.refresh().atStart()).toBe("serve")

    expect(recorded(setup.serveDirectory)).toEqual({ fingerprint: ON_DISK, outcome: "failed", error: "launchctl submit failed (exit 1)" })
  })

  test("a hand-off launchd did not answer exits to be asked again, and the next start asks whether that helper is loaded", async () => {
    // A submit that did not answer may have loaded the helper, so it is
    // neither a refusal nor a hand-off.
    let helperLoaded = true
    const submits: string[] = []
    const setup = launchdFixture({
      registered: ON_DISK,
      reloadInFlight: async () => helperLoaded && submits.length > 0,
      handOff: async () => { submits.push("submitted"); throw new Error("launchctl submit did not answer") },
    })

    expect(await setup.refresh().atStart()).toBe("ask-again")
    expect(recorded(setup.serveDirectory)).toEqual({ fingerprint: ON_DISK, outcome: "requested" })

    // The helper did load: the next start parks behind it.
    expect(await setup.refresh().atStart()).toBe("park")
    // It did not, or it ended without an outcome: the start serves as it is.
    helperLoaded = false
    expect(await setup.refresh().atStart()).toBe("serve")
    expect(submits).toEqual(["submitted"])
  })

  // The registration the release before 2026-09-23 wrote carries no
  // fingerprint, so launchd's label names the job. Remove these cases with
  // the conversion they exercise, after 2027-03-23.
  test("a job the earlier release registered, which carries no fingerprint, re-registers once", async () => {
    const setup = launchdFixture({ env: { XPC_SERVICE_NAME: LABEL }, registered: ON_DISK, jobPid: LAUNCHER_PID })

    expect(await setup.refresh().atStart()).toBe("park")
    expect(await setup.refresh().atStart()).toBe("serve")

    expect(setup.handOffs).toEqual(["handed-off"])
  })

  test("a process that inherited the earlier release's job label from the job does not act for it", async () => {
    const setup = launchdFixture({ env: { XPC_SERVICE_NAME: LABEL }, registered: ON_DISK, jobPid: 999 })

    expect(await setup.refresh().atStart()).toBe("serve")

    expect(setup.handOffs).toEqual([])
  })

  test.each([
    ["a current fingerprint", { XPC_SERVICE_NAME: LABEL, FLYWHEEL_SERVICE_REGISTRATION: ON_DISK }, ON_DISK],
    ["no fingerprinted registration on disk", { XPC_SERVICE_NAME: LABEL, FLYWHEEL_SERVICE_REGISTRATION: OWN }, undefined],
    ["a process launchd did not start", {}, ON_DISK],
  ] as const)("serves with %s, and asks nothing about the login home", async (_name, env, registered) => {
    const setup = launchdFixture({ env, registered, jobPid: LAUNCHER_PID })

    expect(await setup.refresh().atStart()).toBe("serve")

    expect(setup.handOffs).toEqual([])
    expect(setup.loginHomeQuestions()).toBe(0)
  })

  test("keeps the fingerprint it read at construction when the environment no longer has it", async () => {
    // The service removes the fingerprint from its environment right after it
    // builds the refresh, so no child inherits it.
    const env = { XPC_SERVICE_NAME: LABEL, FLYWHEEL_SERVICE_REGISTRATION: OWN }
    const setup = launchdFixture({ registered: ON_DISK })
    const refresh = setup.refresh(env)
    Reflect.deleteProperty(env, "FLYWHEEL_SERVICE_REGISTRATION")

    // Still a job launchd started under the stale registration OWN.
    expect(await refresh.atBuildTick()).toBe(true)
    expect(await refresh.atStart()).toBe("park")
    expect(setup.handOffs).toEqual(["handed-off"])
  })
})

describe("launchd registration refresh outside the login home", () => {
  test.each(UNPROVEN_LOGIN_HOMES)("a service launchd started in %s never re-registers its job", async (_name, isLoginHome) => {
    const setup = launchdFixture({ registered: ON_DISK, isLoginHome })
    const refresh = setup.refresh()

    expect(refresh.startedByManager()).toBe(true)
    expect(await refresh.atStart()).toBe("serve")
    expect(await refresh.atBuildTick()).toBe(false)

    expect(setup.handOffs).toEqual([])
    expect(recorded(setup.serveDirectory)).toBeUndefined()
  })
})

describe("launchd registration refresh on the build tick", () => {
  test("a service whose registration changed on disk records its proof and asks for its own replacement until its restart hands off", async () => {
    const setup = launchdFixture({ registered: ON_DISK })
    const refresh = setup.refresh()

    expect(await refresh.atBuildTick()).toBe(true)
    // The tick proved the login home for this fingerprint, so neither a later
    // tick nor the restarted job asks again.
    expect(recorded(setup.serveDirectory)).toEqual({ fingerprint: ON_DISK, outcome: "proven" })
    expect(await refresh.atBuildTick()).toBe(true)
    expect(setup.loginHomeQuestions()).toBe(1)

    // The restarted job records the attempt when it hands off, and the tick
    // stops asking for a replacement.
    expect(await setup.refresh().atStart()).toBe("park")
    expect(await refresh.atBuildTick()).toBe(false)
    expect(setup.loginHomeQuestions()).toBe(1)
  })

  test.each([
    ["does not answer", undefined],
    ["cannot be read", new Error("dscacheutil did not answer")],
  ] as const)("a login home that %s on one tick is asked again on the next", async (_name, unanswered) => {
    let asked = 0
    const setup = launchdFixture({
      registered: ON_DISK,
      isLoginHome: async () => {
        asked += 1
        if (asked > 1) return true
        if (unanswered instanceof Error) throw unanswered
        return unanswered
      },
    })
    const refresh = setup.refresh()

    expect(await refresh.atBuildTick()).toBe(false)
    expect(recorded(setup.serveDirectory)).toBeUndefined()

    expect(await refresh.atBuildTick()).toBe(true)
    expect(recorded(setup.serveDirectory)).toEqual({ fingerprint: ON_DISK, outcome: "proven" })
    expect(setup.loginHomeQuestions()).toBe(2)
  })

  test("a tick whose proof cannot be recorded asks for no replacement, warns once for the streak, and tries again at the next tick", async () => {
    // A restart that cannot record its attempt serves as it is, so a
    // replacement requested without a guard would repeat on every tick.
    const setup = launchdFixture({ registered: ON_DISK })
    const record = join(setup.serveDirectory, "registration-reload.json")
    // A directory in the record's place: nothing can write the record.
    mkdirSync(record)
    const refresh = setup.refresh()
    const warn = spyOn(Log.create({ service: "service-registration-refresh" }), "warn")
    try {
      expect(await refresh.atBuildTick()).toBe(false)
      expect(await refresh.atBuildTick()).toBe(false)
      expect(setup.loginHomeQuestions()).toBe(2)
      expect(warn.mock.calls.filter(([message]) => String(message).includes("could not be recorded"))).toHaveLength(1)
    } finally {
      warn.mockRestore()
    }

    rmSync(record, { recursive: true })
    expect(await refresh.atBuildTick()).toBe(true)
    expect(recorded(setup.serveDirectory)).toEqual({ fingerprint: ON_DISK, outcome: "proven" })
    expect(setup.loginHomeQuestions()).toBe(3)
  })

  test("a tick past the attempt for this fingerprint does not ask again", async () => {
    const setup = launchdFixture({ registered: ON_DISK })
    expect(await setup.refresh().atStart()).toBe("park")

    expect(await setup.refresh().atBuildTick()).toBe(false)
  })
})

describe("systemd registration refresh", () => {
  function systemdFixture(env: { readonly [name: string]: string | undefined }, options: {
    readonly cgroup?: string
    readonly parent?: { readonly cgroup?: string; readonly comm?: string }
    readonly isLoginHome?: () => Promise<boolean | undefined>
  } = {}) {
    const directory = serveDirectory()
    let refreshes = 0
    let controls = 0
    let procReads = 0
    let loginProbes = 0
    const proc = linuxProc(options.cgroup ?? UNIT_CGROUP_V2, options.parent)
    const refresh = createServiceRegistrationRefresh({
      ...LAUNCHD_START,
      platform: "linux",
      procEntry: (pid, entry) => { procReads += 1; return proc(pid, entry) },
      isLoginHome: () => { loginProbes += 1; return options.isLoginHome?.() ?? Promise.resolve(true) },
      env,
      pid: PID,
      ppid: LAUNCHER_PID,
      serveDirectory: directory,
      launchdLabel: LABEL,
      control: () => {
        controls += 1
        return { systemd: { refreshUnit: async () => { refreshes += 1; return true } } }
      },
    })
    return { refresh, refreshes: () => refreshes, controls: () => controls, procReads: () => procReads, loginProbes: () => loginProbes }
  }

  test("a service systemd started refreshes its unit once it listens, and never at start or on the build tick", async () => {
    const setup = systemdFixture({ INVOCATION_ID: "0f0e0d0c" })

    expect(await setup.refresh.atStart()).toBe("serve")
    expect(await setup.refresh.atBuildTick()).toBe(false)
    expect(setup.refreshes()).toBe(0)

    await setup.refresh.afterListening()
    expect(setup.refreshes()).toBe(1)
  })

  test("the start proof is made once, and residency and the unit refresh share it", async () => {
    const setup = systemdFixture({ INVOCATION_ID: "0f0e0d0c" })

    expect(setup.refresh.startedByManager()).toBe(true)
    await setup.refresh.afterListening()
    expect(setup.refresh.startedByManager()).toBe(true)

    // Its own control group, then its parent's group and command name.
    expect(setup.procReads()).toBe(3)
    expect(setup.refreshes()).toBe(1)
  })

  test("a process of another unit that carries an invocation refreshes nothing", async () => {
    const setup = systemdFixture({ INVOCATION_ID: "0f0e0d0c" }, { cgroup: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-tmux.scope\n" })

    await setup.refresh.afterListening()

    expect(setup.refreshes()).toBe(0)
  })

  test("a scratch service that a session of an earlier build's service started refreshes nothing, although it carries the invocation and sits in the unit's group", async () => {
    // A build before 2026-09-23 leaves INVOCATION_ID in the environment its
    // children inherit, and KillMode=process keeps a session's descendants in
    // the unit's control group. The parent is that session, not systemd.
    const setup = systemdFixture({ INVOCATION_ID: "0f0e0d0c" }, { parent: { cgroup: UNIT_CGROUP_V2, comm: "bash\n" } })

    expect(setup.refresh.startedByManager()).toBe(false)
    await setup.refresh.afterListening()

    expect(setup.refreshes()).toBe(0)
    expect(setup.controls()).toBe(0)
  })

  test.each(UNPROVEN_LOGIN_HOMES)("a service systemd started in %s never writes or reloads its unit", async (_name, isLoginHome) => {
    const setup = systemdFixture({ INVOCATION_ID: "0f0e0d0c" }, { isLoginHome })

    expect(setup.refresh.startedByManager()).toBe(true)
    await setup.refresh.afterListening()
    await setup.refresh.afterListening()

    expect(setup.refreshes()).toBe(0)
    // The refresh remembers no answer of its own: each step asks the
    // service's one login-home memo, which keeps only an answered question.
    expect(setup.loginProbes()).toBe(2)
  })

  test("the start asks nothing about the login home where no start step applies", async () => {
    const setup = systemdFixture({ INVOCATION_ID: "0f0e0d0c" })

    expect(await setup.refresh.atStart()).toBe("serve")

    expect(setup.loginProbes()).toBe(0)
  })

  test("a service systemd did not start asks systemd nothing", async () => {
    const setup = systemdFixture({})

    expect(await setup.refresh.atStart()).toBe("serve")
    await setup.refresh.afterListening()
    expect(await setup.refresh.atBuildTick()).toBe(false)

    expect(setup.controls()).toBe(0)
    expect(setup.refreshes()).toBe(0)
    expect(setup.loginProbes()).toBe(0)
  })
})

describe("whether the service manager started this service", () => {
  const launcherDirectories: string[] = []
  afterEach(() => {
    for (const directory of launcherDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
  })

  /** The account's launcher program, as a file the kernel can name. */
  function launcherProgram(): string {
    const directory = mkdtempSync(join(tmpdir(), "fw-launcher-"))
    launcherDirectories.push(directory)
    const program = join(directory, "Flywheel")
    writeFileSync(program, "")
    return program
  }

  function started(options: {
    readonly platform: NodeJS.Platform
    readonly env?: { readonly [name: string]: string | undefined }
    readonly ppid?: number
    readonly scheduledTask?: boolean
    readonly launcherExecutable?: string
    readonly executableOf?: (pid: number) => DarwinExecutable
    readonly cgroup?: string
    readonly parent?: { readonly cgroup?: string; readonly comm?: string }
  }) {
    let controls = 0
    let parentReads = 0
    const refresh = createServiceRegistrationRefresh({
      platform: options.platform,
      scheduledTask: options.scheduledTask ?? false,
      launcherExecutable: options.launcherExecutable ?? "/nonexistent/Flywheel",
      executableOf: (pid) => { parentReads += 1; return options.executableOf?.(pid) ?? { kind: "absent" } },
      procEntry: linuxProc(options.cgroup, options.parent),
      uid: 1000,
      isLoginHome: async () => true,
      env: options.env ?? {},
      pid: PID,
      ppid: options.ppid ?? LAUNCHER_PID,
      serveDirectory: serveDirectory(),
      launchdLabel: LABEL,
      control: () => {
        controls += 1
        return { systemd: { refreshUnit: async () => false } }
      },
    })
    return { refresh, startedByManager: () => refresh.startedByManager(), controls: () => controls, parentReads: () => parentReads }
  }

  test("launchd started a service whose job label it carries and whose parent is launchd or the account's launcher", async () => {
    const launcher = launcherProgram()
    const env = { XPC_SERVICE_NAME: LABEL }
    expect(started({ platform: "darwin", env, ppid: 1 }).startedByManager()).toBe(true)
    const underLauncher = started({ platform: "darwin", env, launcherExecutable: launcher, executableOf: (pid) => pid === LAUNCHER_PID ? { kind: "path", path: realpathSync(launcher) } : { kind: "absent" } })
    expect(underLauncher.startedByManager()).toBe(true)
    // The kernel is asked once; every later question reads the same answer.
    expect(underLauncher.startedByManager()).toBe(true)
    expect(underLauncher.parentReads()).toBe(1)
  })

  test("a process that inherited the job label from inside the service's tree was not started by launchd", async () => {
    const launcher = launcherProgram()
    const env = { XPC_SERVICE_NAME: LABEL }
    // A harness that a session of the real service runs starts its own
    // service, which inherits the label but whose parent is a client.
    expect(started({ platform: "darwin", env, launcherExecutable: launcher, executableOf: () => ({ kind: "path", path: "/Users/test/.local/bin/flywheel" }) }).startedByManager()).toBe(false)
    // A parent the kernel states is gone is not the launcher.
    expect(started({ platform: "darwin", env, launcherExecutable: launcher }).startedByManager()).toBe(false)
    // Neither does a parent of launchd without the label.
    expect(started({ platform: "darwin", ppid: 1 }).startedByManager()).toBe(false)
  })

  test("a parent the kernel did not name leaves the start unknown: it is never cached, and the start asks launchd again", async () => {
    const launcher = launcherProgram()
    const env = { XPC_SERVICE_NAME: LABEL }
    let parent: DarwinExecutable = { kind: "unavailable" }
    const warn = spyOn(Log.create({ service: "service-registration-refresh" }), "warn").mockImplementation(() => {})
    try {
      const service = started({ platform: "darwin", env, launcherExecutable: launcher, executableOf: () => parent })

      expect(service.startedByManager()).toBeUndefined()
      expect(await service.refresh.atStart()).toBe("ask-again")
      expect(await service.refresh.atBuildTick()).toBe(false)
      await service.refresh.afterListening()
      expect(service.controls()).toBe(0)
      // The unknown answer is one event, recorded once with its own cause,
      // however many steps meet it.
      expect(warn.mock.calls.map(([message]) => message)).toEqual(["whether the service manager started the account service is unknown; it is asked again"])

      // Each unknown answer asked the kernel. A proof is kept.
      parent = { kind: "path", path: realpathSync(launcher) }
      const reads = service.parentReads()
      expect(service.startedByManager()).toBe(true)
      expect(service.startedByManager()).toBe(true)
      expect(service.parentReads()).toBe(reads + 1)
    } finally {
      warn.mockRestore()
    }
  })

  test("systemd started a service whose invocation it carries and whose control group is the account unit's, and asks systemd nothing", async () => {
    const env = { INVOCATION_ID: "0f0e0d0c" }
    for (const cgroup of [UNIT_CGROUP_V2, UNIT_CGROUP_V1]) {
      const service = started({ platform: "linux", env, cgroup })
      expect(service.startedByManager()).toBe(true)
      expect(service.controls()).toBe(0)
    }
    // A process of another unit carries that unit's invocation.
    expect(started({ platform: "linux", env, cgroup: "0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-tmux.scope\n" }).startedByManager()).toBe(false)
    expect(started({ platform: "linux", env, cgroup: "1:name=systemd:/user.slice/user-1000.slice/user@1000.service/other.service\n" }).startedByManager()).toBe(false)
    // A controller hierarchy is not systemd's own tree.
    expect(started({ platform: "linux", env, cgroup: "4:memory:/user.slice/flywheel-serve.service\n" }).startedByManager()).toBe(false)
    // A control group that cannot be read proves nothing.
    expect(started({ platform: "linux", env }).startedByManager()).toBe(false)
    // A child of the service is in the unit's group, but the service removed
    // the invocation from the environment it inherited.
    expect(started({ platform: "linux", cgroup: UNIT_CGROUP_V2 }).startedByManager()).toBe(false)
  })

  test("systemd started only a service whose parent, read once at start, is the account's user manager", async () => {
    const env = { INVOCATION_ID: "0f0e0d0c" }
    expect(started({ platform: "linux", env, cgroup: UNIT_CGROUP_V1, parent: { cgroup: "1:name=systemd:/user.slice/user-1000.slice/user@1000.service/init.scope\n", comm: "systemd\n" } }).startedByManager()).toBe(true)
    // A session of an earlier build's service, which left the invocation to
    // its children and whose descendants stay in the unit's group.
    expect(started({ platform: "linux", env, cgroup: UNIT_CGROUP_V2, parent: { cgroup: UNIT_CGROUP_V2, comm: "flywheel\n" } }).startedByManager()).toBe(false)
    // Another user's manager, the system manager, and a process in the
    // manager's group that is not the manager.
    expect(started({ platform: "linux", env, cgroup: UNIT_CGROUP_V2, parent: { cgroup: "0::/user.slice/user-1001.slice/user@1001.service/init.scope\n", comm: "systemd\n" } }).startedByManager()).toBe(false)
    expect(started({ platform: "linux", env, cgroup: UNIT_CGROUP_V2, parent: { cgroup: "0::/init.scope\n", comm: "systemd\n" } }).startedByManager()).toBe(false)
    expect(started({ platform: "linux", env, cgroup: UNIT_CGROUP_V2, parent: { cgroup: USER_MANAGER.cgroup, comm: "sd-pam\n" } }).startedByManager()).toBe(false)
    // A parent the kernel does not describe proves nothing.
    expect(started({ platform: "linux", env, cgroup: UNIT_CGROUP_V2, parent: {} }).startedByManager()).toBe(false)
  })

  test("Task Scheduler started a service whose command line carries the task's marker", async () => {
    expect(started({ platform: "win32", scheduledTask: true }).startedByManager()).toBe(true)
    // A task a release before 2026-09-23 registered passes no marker, so its
    // service is resident only through the login-home answer.
    expect(started({ platform: "win32" }).startedByManager()).toBe(false)
    // The marker proves a start only where Task Scheduler runs the task.
    expect(started({ platform: "darwin", scheduledTask: true }).startedByManager()).toBe(false)
  })

  test("the service takes each manager's start marker from the environment its children inherit", () => {
    const env: NodeJS.ProcessEnv = { PATH: "/usr/bin", XPC_SERVICE_NAME: LABEL, INVOCATION_ID: "0f0e0d0c", FLYWHEEL_SERVICE_REGISTRATION: OWN }

    const startedWith = takeManagerStartEnvironment(env)

    expect(startedWith).toEqual({ PATH: "/usr/bin", XPC_SERVICE_NAME: LABEL, INVOCATION_ID: "0f0e0d0c", FLYWHEEL_SERVICE_REGISTRATION: OWN })
    // No descendant of the service reads as a start by its manager.
    expect(env).toEqual({ PATH: "/usr/bin" })
    // The service itself still proves its own start from what it took.
    expect(started({ platform: "darwin", env: startedWith, ppid: 1 }).startedByManager()).toBe(true)
  })
})
