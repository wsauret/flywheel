import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"

import { Schema } from "effect"

import type { DarwinExecutable } from "../../infra/darwin-process-api.js"
import { errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import type { AccountServiceRegistrationControl } from "./account-service-installation.js"
import { ACCOUNT_SYSTEMD_UNIT, REGISTRATION_FINGERPRINT_ENV, RegistrationReloadRecord } from "./account-service-registration.js"

const log = Log.create({ service: "service-registration-refresh" })

const GUARD_FILE = "registration-reload.json"
const decodeReloadRecord = Schema.decodeUnknownOption(Schema.fromJsonString(RegistrationReloadRecord))

type LaunchdControl = NonNullable<AccountServiceRegistrationControl["launchd"]>

/** The environment entries by which a service manager marks the process it
 *  started: the registration's fingerprint, launchd's job label, and
 *  systemd's invocation of the unit. Each child of a process inherits them. */
const MANAGER_START_MARKERS = [REGISTRATION_FINGERPRINT_ENV, "XPC_SERVICE_NAME", "INVOCATION_ID"] as const

/** Answers this process's environment as its manager started it, and removes
 *  the manager's start markers from `env`, the environment every child
 *  inherits, so that only the service a manager started carries them: no
 *  descendant of a current build's service, such as a harness that one of
 *  its sessions runs, reads as a service its manager started. */
export function takeManagerStartEnvironment(env: NodeJS.ProcessEnv) {
  const started = { ...env }
  for (const name of MANAGER_START_MARKERS) Reflect.deleteProperty(env, name)
  return started
}

/** Whether a /proc/<pid>/cgroup text puts the process in a control group
 *  whose path ends with `tail`. systemd's own tree is the unified hierarchy
 *  (`0::`) under cgroup v2 and the named `name=systemd` hierarchy under
 *  cgroup v1; the other v1 hierarchies are controllers' trees. */
function inSystemdGroup(cgroup: string, tail: string): boolean {
  return cgroup.split("\n").some((line) => {
    const match = /^\d+:([^:]*):(.*)$/.exec(line)
    if (match === null || (match[1] !== "" && match[1] !== "name=systemd")) return false
    return match[2]?.endsWith(`/${tail}`) === true
  })
}

/** The loop guard in the lane's serve directory: the one launchd reload
 *  attempted for a registration fingerprint on disk, and its outcome. */
export interface RegistrationReloadGuard {
  read(): RegistrationReloadRecord | undefined
  record(entry: RegistrationReloadRecord): void
}

export function registrationReloadGuard(serveDirectory: string): RegistrationReloadGuard {
  const path = join(serveDirectory, GUARD_FILE)
  return {
    read() {
      let text: string
      try {
        text = readFileSync(path, "utf8")
      } catch {
        return undefined
      }
      const entry = decodeReloadRecord(text)
      if (entry._tag === "Some") return entry.value
      // The record only holds a repeated reload back, so one it cannot read
      // allows the attempt, which then writes a readable one.
      log.warn("the registration reload record has a shape this build does not know; it is ignored", { path })
      return undefined
    },
    record(entry) {
      mkdirSync(serveDirectory, { recursive: true })
      writeFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 })
    },
  }
}

/** What a start that its manager made does before it takes the start lock:
 *  serve, park with exit 0 because a launchd helper re-registers the job, or
 *  exit with the restart code so launchd asks again after its throttle,
 *  because nothing proved that no helper is loaded. */
type RegistrationStartDecision = "serve" | "park" | "ask-again"

/** How a service that its manager started applies a changed registration
 *  without cutting running work, and never from inside its own process tree
 *  (ARCH-RUNTIME-039).
 *
 *  systemd applies a changed unit through a manager reload, which stops
 *  nothing. `serve install` never writes the unit while it is active, so a
 *  service that systemd started writes its own build's unit and reloads the
 *  manager itself once it listens.
 *
 *  launchd reads a registration only when it loads the job, and a job cannot
 *  unload itself without ending its own work. A resident service whose
 *  registration changed on disk therefore requests its own planned
 *  replacement, and the job that launchd restarts under the stale
 *  registration hands the reload to a transient launchd job before it serves,
 *  and parks. One reload is attempted per fingerprint on disk: once it has an
 *  outcome, a stale start serves as it is until a later install writes
 *  another registration or the next login loads the file on disk.
 *
 *  On every platform, a refresh runs only in a service that its manager
 *  started and whose account home is the proven login home, the one home the
 *  registration serves. A manager-started service in any other home, such as
 *  a harness's, never writes or reloads a registration. The login home is
 *  asked only just before a step would act, so a start with nothing to change
 *  runs no command for it. */
export interface ServiceRegistrationRefresh {
  /** Before the start lock. launchd only. */
  atStart(): Promise<RegistrationStartDecision>
  /** After the service listens, off the attach path. systemd only. */
  afterListening(): Promise<void>
  /** On the build tick: whether this service should request its own planned
   *  replacement. The first tick that asks records its proof of the login
   *  home in the loop guard, so the restart it causes asks nothing again.
   *  launchd only. */
  atBuildTick(): Promise<boolean>
  /** Whether the service manager itself started this process, from the
   *  manager's own start marker and what the kernel states (ARCH-RUNTIME-038, ARCH-RUNTIME-040). It runs
   *  no command and never throws. A proof that is made is kept, and every
   *  later question reads it. A kernel that did not answer leaves the start
   *  unknown, as undefined: it is never kept, so the next question asks the
   *  kernel again. */
  startedByManager(): boolean | undefined
}

export function createServiceRegistrationRefresh(deps: {
  readonly platform: NodeJS.Platform
  /** Whether the command line carries the scheduled task's marker argument. */
  readonly scheduledTask: boolean
  /** The account's launcher program, which launchd runs for the job and
   *  which runs the service as its child. macOS only. */
  readonly launcherExecutable: string
  /** The executable a process runs, as the kernel names it. macOS only. */
  readonly executableOf: (pid: number) => DarwinExecutable
  /** The text of /proc/<pid>/<entry>, or nothing when it cannot be read.
   *  Linux only. */
  readonly procEntry: (pid: number, entry: "cgroup" | "comm") => string | undefined
  /** This process's user id. Linux only. */
  readonly uid: number | undefined
  /** Whether the account home is the login home, or nothing when the
   *  platform does not name the login home. Asked only by a service that its
   *  manager started, just before a registration step would act, and again
   *  at each such step: the caller remembers an answer, never this refresh. */
  readonly isLoginHome: () => Promise<boolean | undefined>
  /** This process's environment as the manager started it, which
   *  `takeManagerStartEnvironment` answers. */
  readonly env: { readonly [name: string]: string | undefined }
  readonly pid: number
  /** The parent of this process, read once at start. */
  readonly ppid: number
  readonly serveDirectory: string
  /** The label of the account service's launchd job. */
  readonly launchdLabel: string
  /** Read only once the manager's start is proven. */
  readonly control: () => AccountServiceRegistrationControl | undefined
}): ServiceRegistrationRefresh {
  const own = deps.env[REGISTRATION_FINGERPRINT_ENV]
  // A launchd job that a release before 2026-09-23 registered carries no
  // fingerprint, so launchd's label is what says the job started this
  // process. Remove this conversion after 2027-03-23: by then every launchd
  // registration carries a fingerprint, and the fingerprint alone says so.
  const byLabel = own === undefined && deps.env.XPC_SERVICE_NAME === deps.launchdLabel
  const guard = registrationReloadGuard(deps.serveDirectory)

  /** The fingerprint on disk, when this process is the launchd job's own and
   *  a registration other than the one that started it is on disk. A
   *  registration on disk without one is the earlier release's, which the
   *  next install replaces; it is never re-applied as it is. */
  const staleTarget = async (launchd: LaunchdControl): Promise<string | undefined> => {
    const registered = await launchd.registeredFingerprint()
    if (registered === undefined || registered === own) return undefined
    // The label is in the environment every descendant inherits, so in the
    // conversion only the job's own process, or the service its launcher
    // runs as a child, acts for the job. Remove with the conversion above.
    if (byLabel) {
      const jobPid = await launchd.jobPid()
      if (jobPid !== deps.pid && jobPid !== deps.ppid) return undefined
    }
    return registered
  }

  /** Each manager's own start marker, read with what the kernel states, so
   *  the proof runs no command. launchd's label is in the environment every
   *  descendant of the job inherits, including one that a session of an
   *  earlier build's service runs, so only a process whose parent is launchd
   *  itself or the account's launcher is the job's service. systemd's
   *  invocation is in the environment of every process of a unit, so only a
   *  process in the account unit's control group whose parent is the
   *  account's systemd user manager is its service: a build before
   *  2026-09-23 leaves the invocation to its children, and KillMode=process
   *  keeps a session's descendants in the unit's group. Task
   *  Scheduler passes its action no environment, and the Schedule service
   *  that starts the action names no task, so the task passes a marker
   *  argument instead. Undefined is a kernel that did not answer. */
  const proveStart = (): boolean | undefined => {
    switch (deps.platform) {
      case "darwin":
        if (deps.env.XPC_SERVICE_NAME !== deps.launchdLabel) return false
        return deps.ppid === 1 || parentIsLauncher()
      case "linux": {
        if (deps.env.INVOCATION_ID === undefined) return false
        const cgroup = deps.procEntry(deps.pid, "cgroup")
        return cgroup !== undefined && inSystemdGroup(cgroup, ACCOUNT_SYSTEMD_UNIT) && parentIsUserManager()
      }
      case "win32":
        return deps.scheduledTask
      default:
        return false
    }
  }

  /** A parent that is gone is no launcher. A parent the kernel did not name
   *  proves nothing either way. */
  const parentIsLauncher = (): boolean | undefined => {
    const parent = deps.executableOf(deps.ppid)
    if (parent.kind === "absent") return false
    if (parent.kind === "unavailable") return undefined
    try {
      return realpathSync(parent.path) === realpathSync(deps.launcherExecutable)
    } catch {
      // A launcher that is not installed is no process's parent.
      return false
    }
  }

  /** The account's systemd user manager runs as `systemd` in the
   *  `init.scope` of its own `user@<uid>.service`. */
  const parentIsUserManager = (): boolean => {
    if (deps.uid === undefined) return false
    const cgroup = deps.procEntry(deps.ppid, "cgroup")
    return cgroup !== undefined
      && inSystemdGroup(cgroup, `user@${deps.uid}.service/init.scope`)
      && deps.procEntry(deps.ppid, "comm")?.trimEnd() === "systemd"
  }

  let started: boolean | undefined
  let unknownRecorded = false
  const startedByManager = (): boolean | undefined => {
    if (started !== undefined) return started
    let failure: unknown
    try {
      started = proveStart()
    } catch (error) {
      failure = error
    }
    if (started === undefined && !unknownRecorded) {
      unknownRecorded = true
      log.warn("whether the service manager started the account service is unknown; it is asked again", failure === undefined ? {} : { error: errorMessage(failure) })
    }
    return started
  }

  let notLoginHomeLogged = false
  let unansweredStreak = false
  /** Whether the account home is the proven login home, asked at each step
   *  that would act. Only an answer proves anything. A question that does not
   *  answer, or that throws, lets no step act now and is asked again at the
   *  next step; it warns once for each streak of such questions. */
  const loginHomeProven = async (): Promise<boolean> => {
    let login: boolean | undefined
    let error: string | undefined
    try {
      login = await deps.isLoginHome()
    } catch (cause) {
      error = errorMessage(cause)
    }
    if (login === undefined) {
      if (!unansweredStreak) log.warn("the login home did not answer; the account service changes no registration now and asks again at its next step", error === undefined ? {} : { error })
      unansweredStreak = true
      return false
    }
    unansweredStreak = false
    if (!login && !notLoginHomeLogged) {
      notLoginHomeLogged = true
      log.info("the account service does not change its registration: its account home is not the login home")
    }
    return login
  }

  let resolved: { readonly control: AccountServiceRegistrationControl | undefined } | undefined
  /** The manager's registration steps of one kind, only in a service that
   *  its manager is proven to have started. Each step asks for the login
   *  home itself, just before it would act. A start that is unknown runs no
   *  step, so the later steps wait for a proof. */
  const registration = <Kind extends "launchd" | "systemd">(kind: Kind): AccountServiceRegistrationControl[Kind] | undefined => {
    if (startedByManager() !== true) return undefined
    return (resolved ??= { control: deps.control() }).control?.[kind]
  }

  /** Every failure up to the helper question leaves this start unable to say
   *  that no helper is loaded, and so does a hand-off that launchd did not
   *  answer: each throws to `atStart`, which asks again. The login home is
   *  asked last, only before the start requests a reload. */
  const handOff = async (launchd: LaunchdControl): Promise<RegistrationStartDecision> => {
    const target = await staleTarget(launchd)
    if (target === undefined) return "serve"
    const record = guard.read()
    const attempt = record?.fingerprint === target ? record : undefined
    // A reload with an outcome is over, even while its helper is still
    // loaded: a start that the reload itself made after it failed serves.
    if (attempt?.outcome === "reloaded" || attempt?.outcome === "failed") {
      log.warn("the account service runs under a stale registration whose reload already ended; it serves as it is until a later install or the next login", { registered: target, own, outcome: attempt.outcome, error: attempt.error })
      return "serve"
    }
    // A helper that is loaded boots this job out and loads the file on disk
    // soon, so a start meanwhile, such as a client's, parks before it takes
    // the start lock or consumes a replacement handoff.
    if (await launchd.reloadInFlight()) {
      log.info("the account service registration is being reloaded; this start parks", { registered: target, own })
      return "park"
    }
    // No helper is loaded, so from here a failure that proves no helper will
    // be loaded serves as it is.
    if (attempt?.outcome === "requested") {
      log.warn("the account service runs under a stale registration whose reload helper ended without an outcome; it serves as it is", { registered: target, own })
      return "serve"
    }
    // The build tick that requested this restart proved the login home for
    // this fingerprint. Any other stale start proves it now.
    if (attempt?.outcome !== "proven" && !(await loginHomeProven())) return "serve"
    try {
      guard.record({ fingerprint: target, outcome: "requested" })
    } catch (error) {
      log.warn("the account service registration reload could not be recorded; it serves as it is", { registered: target, own, error: errorMessage(error) })
      return "serve"
    }
    // A submit that did not answer can still have loaded the helper, so it
    // throws: the next start finds the requested attempt and asks whether
    // the helper is loaded.
    const refusal = await launchd.handOffReload()
    if (refusal === undefined) {
      log.info("the account service started under a stale registration; a launchd helper re-registers it", { registered: target, own })
      return "park"
    }
    log.warn("launchd refused the account service registration reload; it serves as it is", { registered: target, own, error: refusal })
    try {
      guard.record({ fingerprint: target, outcome: "failed", error: refusal })
    } catch {
      // A requested record without a helper serves as it is too.
    }
    return "serve"
  }

  /** Whether the build tick's last proof could not be recorded, so a
   *  streak of such ticks warns once. */
  let unrecordedStreak = false
  return {
    async atStart() {
      // A start the kernel did not answer for cannot say that no helper is
      // loaded, so it asks launchd again. `startedByManager` records why.
      if (startedByManager() === undefined) return "ask-again"
      try {
        const launchd = registration("launchd")
        return launchd === undefined ? "serve" : await handOff(launchd)
      } catch (error) {
        log.warn("whether a registration reload is in flight is unknown; this start exits so launchd asks again", { error: errorMessage(error) })
        return "ask-again"
      }
    },
    async afterListening() {
      const systemd = registration("systemd")
      if (systemd !== undefined && await loginHomeProven()) await systemd.refreshUnit()
    },
    startedByManager,
    async atBuildTick() {
      const launchd = registration("launchd")
      if (launchd === undefined) return false
      const target = await staleTarget(launchd)
      if (target === undefined) return false
      // The proof holds until the restart hands off: then the attempt has
      // moved on, and the tick asks for no more replacements.
      const attempt = guard.read()
      if (attempt?.fingerprint === target) return attempt.outcome === "proven"
      if (!(await loginHomeProven())) return false
      // A guard that cannot take the proof cannot take the restart's attempt
      // either. That restart would serve as it is, and every later tick would
      // request another replacement. So the tick requests nothing, and the
      // next tick tries again; the streak warns once.
      try {
        guard.record({ fingerprint: target, outcome: "proven" })
      } catch (error) {
        if (!unrecordedStreak) log.warn("the proof of the login home could not be recorded; the account service requests no replacement until it is", { registered: target, own, error: errorMessage(error) })
        unrecordedStreak = true
        return false
      }
      unrecordedStreak = false
      log.info("the account service registration changed; the service requests its own replacement", { registered: target, own })
      return true
    },
  }
}
