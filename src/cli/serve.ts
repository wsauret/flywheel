import * as fs from "node:fs"
import * as path from "node:path"

import { readAppVersion } from "../infra/app-version.js"
import { serveLaneFor, type ServeLane } from "../infra/cli-subprocess.js"
import { DebugLog, resolveDebugLogDirectory } from "../infra/debug-log.js"
import type { StartupDirectories } from "../infra/directory-authorities.js"
import { errorMessage } from "../infra/error-message.js"
import { Log } from "../infra/log.js"
import { ownedCommandRunner, runOwnedCommand } from "../infra/owned-command.js"
import { processLoginShellPath, type LoginShellPath } from "../infra/login-shell-path.js"
import type { ServiceSource } from "../infra/source-snapshot.js"
import { darwinProcess } from "../infra/darwin-process-api.js"
import { accountServeDir, accountServeLauncherExecutablePath, accountServeRecordPath, accountServeSocketPath, accountServeStartLockPath } from "../infra/paths.js"
import { acquireLock, LockRefusal, releaseLock, type LockOwnership } from "../infra/ownership-file-lock.js"
import { processHolders } from "../infra/process-holder.js"
import type { LauncherContext, LauncherScope } from "../infra/process-supervisor.js"
import type { PersistentProcessManager } from "../infra/persistent-process-manager.js"
import { createProcessWatchdog, type ProcessWatchdog } from "../infra/process-watchdog.js"
import { shutdownSignals } from "../infra/shutdown-signals.js"
import { RUNTIME_PROTOCOL_VERSION } from "../protocol/runtime-liveness.js"
import { encodeServeStartFailure, encodeServeStatusRecord, ServeStartupFailure, type ServeStartRefusal } from "../protocol/serve-handshake.js"
import { readOrCreateAccountAttachToken } from "../orchestration/app-service/account-attach-token.js"
import { createAccountProjectRegistry } from "../orchestration/app-service/account-project-registry.js"
import { createAccountServiceRuntime, type AccountServiceRuntimeOptions } from "../orchestration/app-service/account-service-runtime.js"
import { ACCOUNT_DRAIN_HARD_EXIT_MS } from "../orchestration/app-service/runtime-shutdown.js"
import type { ReplacementOwner } from "../orchestration/app-service/replacement-owner.js"
import { DEV_SERVE_PROJECT_IDLE_GRACE_MS, ServeLifetime } from "../orchestration/app-service/serve-lifetime.js"
import { accountLaunchdHost, accountServicePlatform, accountServiceRegistrationControl, createAccountServiceInstallation, currentLoginHome, isLoginHome, reloadLaunchdRegistration, type AccountServiceInstallation, type AccountServicePlatform, type RetiredServiceInstallation } from "../orchestration/app-service/account-service-installation.js"
import { SCHEDULED_TASK_ARGUMENT, SERVICE_NAMES } from "../orchestration/app-service/account-service-registration.js"
import { createServiceRegistrationRefresh, registrationReloadGuard, takeManagerStartEnvironment, type ServiceRegistrationRefresh } from "../orchestration/app-service/service-registration-refresh.js"
import { createAccountHubHandler, type AccountHubOptions, type Hub } from "../orchestration/app-service/web-serving/hub.js"
import { releaseHarnessHub } from "./release-harness.js"
import { retiredServiceInstallations } from "../orchestration/modules.js"
import { installedBuild, processRunningBuild, runningBuildId, runningDisplayBuildId, type InstalledBuild } from "../orchestration/app-service/runtime-executable.js"
import { confirmServiceStart, endServiceStart, failServiceStart, type ProbationSchedule, withdrawServiceStart } from "../orchestration/update/service-start.js"
import { lingerNotice } from "../protocol/client/process-initiation-copy.js"
import { SERVE_EXIT } from "./serve-contract.js"
import { nextService, serveExitCode, startNextService, startSuccessorService, type NextService, type ServeStop } from "./serve-next-service.js"
import { startAddressVerdict, type PreviousService } from "./serve-address.js"
import { accountHomeWatch, createRegistrationFollower, createRegistrationRetirement, createSupersededRetirementDecision, rememberAnsweredLoginHome, serveResidency, type ServeResidency } from "./serve-retirement.js"
import { runtimeWorkerUrl } from "./runtime-launch.js"
import { createAccountRuntimeAttach, probeRendezvous } from "./runtime-attach.js"
import { readRuntimeIdentity, type RuntimeIdentity } from "./runtime-identity-record.js"
import { createStartupTimeline } from "../infra/startup-timeline.js"

const log = Log.create({ service: "serve" })

/** The source of a service that runs no snapshot: an installed service,
 *  which runs its build, or a dev service that runs its live checkout. */
const NO_SNAPSHOT: ServiceSource = { snapshot: undefined, refusedSource: undefined, sweepOthers: async () => {}, cutoverAnswer: (build) => build }

const USAGE = `Usage: flywheel serve [install|uninstall]

Run or manage the account service that opens projects on demand.`
const BUILD_CHECK_MS = 60_000
/** How long a start waits for an owner at the lane's address to answer its
 *  probe before the start refuses. A service that is busy can stall for 2 to
 *  6 seconds, and a client waits as long for the answer to its cutover
 *  request. */
const OWNER_ANSWER_MS = 10_000

function projectIdleGraceMs(env: { readonly [name: string]: string | undefined }): number | undefined {
  const value = env.FLYWHEEL_PROJECT_IDLE_TIMEOUT_SECONDS
  if (value === undefined) return undefined
  const seconds = Number(value)
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error("FLYWHEEL_PROJECT_IDLE_TIMEOUT_SECONDS must be a non-negative number")
  return seconds * 1_000
}

/** Admits the release performance harness's isolated hub. A port override
 * without the exact harness identity is rejected instead of changing a normal
 * production launch. */
export function releaseHarnessRuntimeOptions(
  env: { readonly [name: string]: string | undefined },
): Pick<AccountServiceRuntimeOptions, "startHub"> {
  const harness = releaseHarnessHub(env)
  if (harness === undefined) return {}
  return {
    startHub(options: AccountHubOptions): Hub {
      // The handler exists before the first request: the server answers
      // nothing until this function returns.
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => handle(request) })
      const origin = `http://127.0.0.1:${server.port}`
      const handle = createAccountHubHandler(options, origin)
      if (harness.record) fs.writeFileSync(harness.record, `${origin}\n`)
      return {
        origin,
        held: () => true,
        stop: () => { server.stop(true) },
      }
    },
  }
}

/** What a harness may supply in place of the production process: the hub
 *  binding, the web client's files, the clock that bounds the drain, the lifetime that decides when
 *  an unheld serve retires, and the period of the build tick. A test process
 *  has one Worker budget for that clock and shares it with every other test,
 *  so a test supplies a clock of its own. The serve command also hands over
 *  the state Worker it started before this module loaded. */
export interface ServeSeams extends Pick<AccountServiceRuntimeOptions, "startHub" | "createUpdates" | "replacementCutLimitMs" | "clientAssets" | "stateStandby"> {
  readonly drainWatchdog?: () => ProcessWatchdog
  readonly serveLifetime?: () => ServeLifetime
  /** The residency decision, in place of the one this lane's service makes. */
  readonly residency?: () => Promise<ServeResidency>
  /** The installed lane's registration, in place of the one this lane's
   *  service platform drives: the one a service whose residency follows it
   *  reads and hands its address to, and the one `install` and `uninstall`
   *  change. */
  readonly serviceInstallation?: () => AccountServiceInstallation
  readonly buildCheckMs?: number
  /** The build this process executes, in place of the one its executable names. */
  readonly ownBuildId?: () => string | undefined
  /** The build a start would run now, in place of the account's `current`
   *  build. A fixture names an install with it, which a dev service weighs
   *  too, although the dev lane otherwise weighs no build. */
  readonly installedBuild?: (directories: StartupDirectories) => InstalledBuild | undefined
  readonly registrationRefresh?: () => ServiceRegistrationRefresh | undefined
  /** The start of the successor that a resident service makes when it
   *  retires and no service manager restarts it, in place of this lane's
   *  service launch. */
  readonly startSuccessor?: () => Promise<void>
  /** The service's one login shell PATH: serve probes it and every project
   *  executor is told it. The process's own holder by default. */
  readonly loginShellPath?: LoginShellPath
  /** The first wait of the start lock's backoff ladder. */
  readonly startLockBaseDelayMs?: number
  /** How long a start waits for an owner at the lane's address to answer. */
  readonly ownerAnswerMs?: number
  /** The clock of the start's probation after its listen, in place of the
   *  minute that a timer runs. */
  readonly probation?: ProbationSchedule
}

/** A start that another holder keeps from serving: the start lock is held,
 *  an owner at the address does not answer or cannot take a connection, or
 *  the address answered a probe with an error that proves nothing. It is not
 *  this build failing to start, so it takes its count back and says why, at
 *  DEBUG when it repeats a parked lane's latest failure. It joins the lane's
 *  failing streak, and exits with the code its manager restarts, so the next
 *  start asks again, until a streak whose cause does not clear itself
 *  persists and the start parks. `reason` states the cause
 *  alone, because a client shows it whichever of the two the start does. A
 *  refusal that `flywheel kill` does not clear is named in the record, so a
 *  client shows the remedy that works. `clearsItself` says whether the cause
 *  ends with no person's action, such as a start lock that a live start
 *  holds. */
function refuseStart(reason: string, { refusal, clearsItself }: { readonly refusal?: ServeStartRefusal; readonly clearsItself: boolean }): number {
  withdrawServiceStart()
  const exit = failServiceStart({ cause: reason, causeKind: clearsItself ? "clears-itself" : "refused", refusal }, (repeat) => {
    const evidence = { pid: process.pid, reason }
    if (repeat) log.debug("the account service start was refused", evidence)
    else log.warn("the account service start was refused", evidence)
  })
  process.stdout.write(encodeServeStartFailure(reason, refusal))
  return exit === "park" ? SERVE_EXIT.parked : SERVE_EXIT.restart
}

/** Parks a start because another owner serves the lane. The start parks
 *  whatever that owner published: an exit its manager restarts would only
 *  find the owner again. */
function parkBehindOwner(identity: RuntimeIdentity | undefined, lane: ServeLane): number {
  if (identity?.protocolVersion !== undefined) {
    process.stdout.write(encodeServeStatusRecord({
      flywheel: "serve.already-listening",
      pid: identity.pid,
      version: identity.version,
      protocolVersion: identity.protocolVersion,
      lane,
    }))
  } else {
    // The exit still parks (ARCH-RUNTIME-041): a restart would only find the same
    // owner again. The record names what ends that owner.
    const refusal = "A running account service did not publish a compatible identity record"
    log.warn(`${refusal}; this start parks`)
    process.stdout.write(encodeServeStatusRecord({ flywheel: "serve.startup.failed", error: `${refusal}. Run \`flywheel kill\`, then start Flywheel again.` }))
  }
  endServiceStart()
  return SERVE_EXIT.parked
}

/** Records the end of a previous service that did not take its exit path,
 *  and removes the record it left. Its log files are closed, so they are
 *  marked to be kept past ordinary ones for whoever reads this record. The
 *  kernel can give its pid to this process, whose own log opened in the same
 *  directory before this start, so only files opened before this process
 *  began are its files then. */
function recordUncleanEnd(previous: PreviousService, accountHome: string, identityPath: string): void {
  const logFiles = DebugLog.markUnexpectedExit(resolveDebugLogDirectory(accountHome), previous.pid, previous.pid === process.pid ? performance.timeOrigin : undefined)
  log.warn("the previous account service ended without its exit path", { ...previous, logFiles })
  fs.rmSync(identityPath, { force: true })
}

/** This lane's service platform, as install, the registration refresh,
 *  and the registration a client-started service follows each drive it. Only install removes the registrations of earlier releases, so only
 *  install names them. */
function laneServicePlatform(directories: StartupDirectories, launcher: LauncherContext, retired: readonly RetiredServiceInstallation[] = []): AccountServicePlatform | undefined {
  return accountServicePlatform({ userDataRoot: directories.userDataRoot, accountHome: directories.accountHome, retired, runCommand: ownedCommandRunner(launcher.scope) })
}

/** The registration refresh of this lane's service. The manager's
 *  start markers, the registration fingerprint among them, name the start of
 *  this process only, so they are read once here and removed from the
 *  environment every child inherits. */
function laneRegistrationRefresh(lane: ServeLane, directories: StartupDirectories, launcher: LauncherContext, scheduledTask: boolean, loginHome: () => Promise<boolean | undefined>): ServiceRegistrationRefresh {
  return createServiceRegistrationRefresh({
    platform: process.platform,
    scheduledTask,
    launcherExecutable: accountServeLauncherExecutablePath(directories.userDataRoot),
    executableOf: (pid) => darwinProcess.executable(pid),
    procEntry: (pid, entry) => {
      try {
        return fs.readFileSync(`/proc/${pid}/${entry}`, "utf8")
      } catch {
        return undefined
      }
    },
    uid: process.getuid?.(),
    isLoginHome: loginHome,
    env: takeManagerStartEnvironment(process.env),
    pid: process.pid,
    ppid: process.ppid,
    serveDirectory: accountServeDir(directories.userDataRoot, lane),
    names: SERVICE_NAMES[lane],
    control: () => {
      const platform = laneServicePlatform(directories, launcher)
      return platform === undefined ? undefined : accountServiceRegistrationControl(platform)
    },
  })
}

/** Runs or manages the account-scoped service and answers the exit code the
 *  process ends with. The start lock covers probe through publication. */
export async function runServe(
  args: readonly string[],
  directories: StartupDirectories,
  launcher: LauncherContext,
  persistentProcessManager: PersistentProcessManager,
  allowPersistentProcesses: boolean,
  seams: ServeSeams = {},
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  const scheduledTask = args[0] === SCHEDULED_TASK_ARGUMENT
  if (!scheduledTask && args[0] !== undefined) return await runServeOperation(args[0], args, directories, launcher, allowPersistentProcesses, seams.serviceInstallation)
  if (args[1] !== undefined) return refuseServeArgument(args[1])

  const { drainWatchdog, serveLifetime, residency: seamResidency, serviceInstallation: seamInstallation, ownBuildId: seamOwnBuild, installedBuild: seamBuildReader, registrationRefresh: seamRefresh, startSuccessor: seamSuccessor, buildCheckMs = BUILD_CHECK_MS, loginShellPath = processLoginShellPath, startLockBaseDelayMs, ownerAnswerMs = OWNER_ANSWER_MS, probation, ...runtimeOptions } = seams
  // The build this service executes is the one its executable named when
  // this process started, never `current`: an install can activate a newer
  // build at any moment after that, and a service that named that build
  // would never see itself superseded by it (ARCH-DISTRIBUTION-018).
  const ownBuild = seamOwnBuild ? seamOwnBuild() : runningBuildId(processRunningBuild(), directories)
  const lane = serveLaneFor(process.execPath)
  // A dev service names the snapshot of its checkout that it runs from
  // (ARCH-DISTRIBUTION-030). An installed service runs its build and loads none of this.
  const source = (lane === "dev" ? (await import("../infra/source-snapshot.js")).reportSourceEntry() : undefined) ?? NO_SNAPSHOT
  // One answer for residency, the registration refresh, and the
  // registration that residency follows, each of which asks only when it
  // needs it.
  const accountHomeIsLoginHome = rememberAnsweredLoginHome(async () => isLoginHome({
    platform: process.platform,
    accountHome: directories.accountHome,
    loginHome: currentLoginHome,
  }))
  const registration = seamRefresh ? seamRefresh() : laneRegistrationRefresh(lane, directories, launcher, scheduledTask, accountHomeIsLoginHome)
  // The registration that a client-started service in the login home
  // follows, built only once residency reads it. It reads the same login-home
  // answer, so a build tick's registration read asks the login home nothing.
  let installation: Pick<AccountServiceInstallation, "registered" | "start"> | undefined
  const serviceInstallation = () => (installation ??= seamInstallation ? seamInstallation() : createAccountServiceInstallation(() => laneServicePlatform(directories, launcher), accountHomeIsLoginHome))
  // A job started under a stale registration is re-registered from outside
  // its own tree before it takes the start lock, listens, or consumes a
  // replacement handoff; the successor the reload starts does all of that. A
  // start that cannot tell whether a reload is in flight exits with the code
  // launchd restarts, so launchd asks again after its throttle.
  // Neither decision is this build failing to start, so the start the entry
  // counted is taken back.
  const decision = await registration?.atStart()
  if (decision === "park" || decision === "ask-again") endServiceStart()
  if (decision === "park") return SERVE_EXIT.parked
  if (decision === "ask-again") return SERVE_EXIT.restart
  // A start that serves has proven whether its manager started it: `atStart`
  // asks again while the kernel does not answer, and the refresh keeps the
  // proof it made. Residency reads that answer.
  const startedByManager = registration?.startedByManager() === true
  const socketPath = accountServeSocketPath(directories.userDataRoot, lane)
  const identityPath = accountServeRecordPath(directories.userDataRoot, lane)
  const credential = readOrCreateAccountAttachToken(directories.userDataRoot, lane)
  // A holder that keeps the lock through the whole ladder, or a foreign
  // object at its name, refuses the start. Any other failure is the
  // directory's, and stays a crash.
  const lockPath = accountServeStartLockPath(directories.userDataRoot, lane)
  let lock: LockOwnership
  try {
    lock = await acquireLock(lockPath, startLockBaseDelayMs)
  } catch (error) {
    if (!(error instanceof LockRefusal)) throw error
    // The lock's own words name only its file name; the path tells a person
    // which file keeps the start when only a person can clear it.
    return refuseStart(`${error.message} (${lockPath})`, { clearsItself: error.clearsItself, ...(error.emptyClaim === undefined ? {} : { refusal: { kind: "claim-settling", path: path.join(path.dirname(lockPath), error.emptyClaim) } }) })
  }
  let lockHeld = true
  let ownsRendezvous = false
  let runtime: Awaited<ReturnType<typeof createAccountServiceRuntime>> | undefined
  let watchdog: ProcessWatchdog | undefined
  const stopped = Promise.withResolvers<ServeStop>()
  let stop: ServeStop | undefined
  let next: NextService = "none"
  let decided: ServeResidency | undefined
  // Opened only once this process is the one that will serve: a start that
  // finds a live service must not open and close the account store under it.
  let registry: ReturnType<typeof createAccountProjectRegistry> | undefined
  let timeline: ReturnType<typeof createStartupTimeline> | undefined
  let endComposition: ((outcome?: "ready" | "failed" | "incomplete") => void) | undefined
  let endListening: ((outcome?: "ready" | "failed" | "incomplete") => void) | undefined
  try {
    const probe = await probeRendezvous(socketPath, ownerAnswerMs)
    const identity = readRuntimeIdentity(identityPath)
    const verdict = startAddressVerdict({ probe, identity, state: (holder) => processHolders.state(holder), socketPath })
    if (verdict.kind === "park") return parkBehindOwner(identity, lane)
    if (verdict.kind === "refuse") return refuseStart(verdict.reason, verdict)
    if (verdict.previous !== undefined) recordUncleanEnd(verdict.previous, directories.accountHome, identityPath)
    if (process.platform !== "win32") fs.rmSync(socketPath, { force: true })
    timeline = createStartupTimeline({
      owner: "account-service",
      context: { accountHome: directories.accountHome, pid: String(process.pid), lane },
      stages: ["registry", "composition", "listening"],
    })
    const endRegistry = timeline.begin("registry")
    const accountRegistry = createAccountProjectRegistry({ userDataRoot: directories.userDataRoot })
    registry = accountRegistry
    endRegistry()
    // The guardian handshake sits between the first project open and its
    // executor spawn. Started here it runs under the listen instead. Its
    // failure is not this serve's: the first launch starts a fresh guardian.
    void launcher.startGuardian().catch((err) => {
      log.warn("guardian did not start ahead of the first launch; the first launch retries", { error: errorMessage(err) })
    })
    const version = await readAppVersion()
    // The build the build tick, the watcher on `current`, and a new client's
    // cutover request weigh against this service's own. A dev service weighs
    // none: its checkout is where agents edit, and a protocol bump in the
    // middle of their work would restart every session onto a half-written
    // tree. Only a person's new `bun run dev` asks it to make way, through
    // its source (ARCH-RUNTIME-031, ARCH-DISTRIBUTION-030). A seam's build stands in for an install, which a
    // service weighs in either lane.
    const readInstalledBuild = seamBuildReader ?? (lane === "dev" ? () => undefined : installedBuild)
    const request: ReplacementOwner["request"] = (trigger, beforeRetire) => runtime?.replacement.request(trigger, beforeRetire) ?? Promise.resolve("busy")
    const retireIfSuperseded = createSupersededRetirementDecision({
      ownBuild,
      currentBuild: () => readInstalledBuild(directories),
      request,
    })
    // Residency is decided after the service listens, off the first client's
    // path; the lifetime holds the serve until it is.
    const residency = Promise.withResolvers<boolean>()
    const lifetime = serveLifetime ? serveLifetime() : new ServeLifetime({ resident: residency.promise })
    endComposition = timeline.begin("composition")
    runtime = await createAccountServiceRuntime({
      userDataRoot: directories.userDataRoot,
      accountHome: directories.accountHome,
      lane,
      socketPath,
      credential,
      launcher,
      persistentProcessManager,
      allowPersistentProcesses,
      workerUrl: runtimeWorkerUrl(),
      registry: accountRegistry,
      version,
      retireIfSuperseded,
      // A new client's cutover request weighs the build and, for a dev
      // service, its checkout's source (ARCH-RUNTIME-031).
      answerCutover: source.cutoverAnswer(retireIfSuperseded, request),
      source,
      retire: () => stopped.resolve("retired"),
      projectIdleGraceMs: projectIdleGraceMs(process.env) ?? (lane === "dev" ? DEV_SERVE_PROJECT_IDLE_GRACE_MS : undefined),
      holds: lifetime,
      loginShellPath,
      ...runtimeOptions,
      recordTrustedAttach: async (projectRoot) => {
        await accountRegistry.record({ projectRoot, label: path.basename(projectRoot) || projectRoot })
      },
      prepareProject: async (projectDirectories) => {
        const { prepareProjectDefaults } = await import("./project-preparation.js")
        await prepareProjectDefaults(projectDirectories, { publishReferences: false })
      },
    })
    await runtime.ready
    endComposition()
    endComposition = undefined
    endListening = timeline.begin("listening")
    ownsRendezvous = true
    fs.writeFileSync(identityPath, `${JSON.stringify({
      pid: process.pid,
      ...processHolders.own(),
      version,
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      socket: socketPath,
      ...(ownBuild === undefined ? {} : { buildId: ownBuild }),
      displayBuildId: runningDisplayBuildId(),
      sourceSnapshot: source.snapshot,
    })}\n`, { mode: 0o600 })
    process.stdout.write(encodeServeStatusRecord({
      flywheel: "serve.listening",
      pid: process.pid,
      version,
      protocolVersion: RUNTIME_PROTOCOL_VERSION,
      lane,
    }))
    endListening()
    endListening = undefined
    timeline.foregroundReady()
    timeline.finish()
    releaseLock(lock)
    lockHeld = false
    confirmServiceStart({ report: runtime.reportService, schedule: probation })
    // Only a confirmed start admits project opens, the account module
    // services, and the update coordinator, which can convert durable state,
    // so the rollback of a failed start never returns from a start that
    // converted it. The rollback of a build whose executors cannot open
    // returns from a service that admitted opens, which ARCH-DISTRIBUTION-024 accepts. A
    // start that counts nothing, such as a source run, admits them here too.
    runtime.openAdmission()
    // Agent commands take the login shell's PATH on every lane (ARCH-RUNTIME-045). The
    // probe runs the person's startup files, so it starts after the service
    // listens, off the attach path, at background priority, and never fails
    // the serve. Each project executor is handed its result.
    let probeScope: LauncherScope | undefined
    void loginShellPath.probe((command, options) => {
      probeScope ??= launcher.scope.open({ priority: "background" })
      return runOwnedCommand(probeScope, command, options)
    })
    // The work a planned replacement handed this service resumes after the
    // service listens, off the attach path: a client that attaches meanwhile
    // is served at once and sees each session continue. Each project retries
    // on its own; only a handoff that cannot be read stops them, and its rows
    // stay for the next start.
    void runtime.continueReplacements().catch((error: unknown) => {
      log.warn("the previous service's handoff could not be read; its work continues at the next start", { error: errorMessage(error) })
    })
    // A dev service removes the snapshots of its checkout that no process
    // runs from any more, off the attach path.
    void source.sweepOthers()

    // The drain has the account's own hard bound, which holds every project
    // executor's stop inside it and stays under the service manager's stop
    // timeout. The clock lives in a Worker created now, after readiness and while the cwd
    // still exists, and is armed when the stop begins; a drain that cannot
    // settle ends with the process, never with clients dialing an address
    // nobody will answer. The service outlives whoever started it by design
    // (ARCH-RUNTIME-037), so it watches no parent.
    watchdog = drainWatchdog ? drainWatchdog() : createProcessWatchdog({ parentPid: 0, hardExitMs: ACCOUNT_DRAIN_HARD_EXIT_MS })

    const listeners = shutdownSignals(process.platform).map((signal) => {
      const listener = () => stopped.resolve("signaled")
      process.once(signal, listener)
      return [signal, listener] as const
    })
    lifetime.start(() => stopped.resolve("unheld"))
    const decide = seamResidency ?? (() => serveResidency({
      lane,
      env: process.env,
      startedByManager: () => startedByManager,
      isLoginHome: accountHomeIsLoginHome,
      registered: () => serviceInstallation().registered(),
    }))
    residency.resolve(decide().then((settled) => {
      decided = settled
      return settled.resident
    }))
    // A service that systemd started makes its own build's unit the loaded
    // one, after it listens and off the attach path.
    void registration?.afterListening().catch((error: unknown) => {
      log.warn("the account service unit could not be refreshed", { error: errorMessage(error) })
    })
    const retireIfRegistrationStale = createRegistrationRetirement({
      resident: residency.promise,
      refresh: registration,
      request: () => runtime?.replacement.request({ kind: "service registration changed" }) ?? Promise.resolve("busy"),
    })
    const followRegistration = createRegistrationFollower({
      followsRegistration: () => decided?.followsRegistration === true,
      registered: () => serviceInstallation().registered(),
      setResident: (resident) => lifetime.setResident(resident),
    })
    const readAccountHome = accountHomeWatch(directories.accountHome)
    const buildTimer = setInterval(() => {
      // A service whose account home was removed, such as a harness's whose
      // run directory another run deleted, has no account left to serve.
      if (readAccountHome() === "gone") {
        log.info("the account home no longer exists; the account service retires", { accountHome: directories.accountHome })
        stopped.resolve("unheld")
        return
      }
      void retireIfSuperseded().catch(() => {})
      void retireIfRegistrationStale().catch((error: unknown) => {
        log.warn("the account service registration could not be checked", { error: errorMessage(error) })
      })
      void followRegistration()
    }, buildCheckMs)
    buildTimer.unref?.()
    stop = await stopped.promise
    next = nextService(stop, { resident: lifetime.resident, startedByManager, startsRegisteredJob: decided?.startsRegisteredJob === true })
    // The service's exit decision: why it stops, and the code its manager
    // reads. The drain that follows records its own settlement.
    log.info("account service stopping", { reason: stop, exitCode: serveExitCode(stop), pid: process.pid, next })
    // A start that stops by its own exit path has served, however soon after
    // its listen, so a successor during an update never inherits its park.
    endServiceStart()
    lifetime.stop()
    clearInterval(buildTimer)
    for (const [signal, listener] of listeners) process.off(signal, listener)
    return serveExitCode(stop)
  } catch (cause) {
    // Another process holds a port this start needs, such as a predecessor
    // still draining on the hub's fixed port: the host's state, not this
    // build's failure to start. The hub names its port as the refusal.
    const refusal = cause instanceof ServeStartupFailure ? cause.refusal : undefined
    if (refusal?.kind === "port-in-use" || (cause instanceof Error && "code" in cause && cause.code === "EADDRINUSE")) withdrawServiceStart()
    endComposition?.("failed")
    endListening?.("failed")
    timeline?.finish("failed", cause)
    process.stdout.write(encodeServeStartFailure(errorMessage(cause), refusal))
    throw cause
  } finally {
    if (lockHeld) releaseLock(lock)
    // Withdraw from discovery before draining, so the next serve can claim
    // the address while this one settles, instead of every client dialing a
    // listener that is closing and starting a serve that fails on the hub
    // port this process still holds. The listener stops first, which removes
    // its socket path, and the record goes next. Nothing removes the socket
    // path after that: Bun removes a stopped listener's path by name, so a
    // removal once a successor has bound the path would take the successor's
    // address. A start removes a stale path only when its address verdict
    // proves that nobody serves there.
    runtime?.withdraw()
    if (ownsRendezvous) fs.rmSync(identityPath, { force: true })
    watchdog?.arm()
    await runtime?.dispose()
    await registry?.dispose()
    // The next service finds the address and the hub port free, and the
    // armed watchdog bounds a start that does not answer.
    await startNextService(next, { registration: serviceInstallation, successor: seamSuccessor ?? (() => startSuccessorService(directories, allowPersistentProcesses)) })
    await watchdog?.dispose()
  }
}

/** Runs one operation that manages the account service rather than serving
 *  it, and answers the exit code the process ends with. `seamInstallation`
 *  is the registration `install` and `uninstall` change in place of the one
 *  the installed build names. */
async function runServeOperation(
  operation: string,
  args: readonly string[],
  directories: StartupDirectories,
  launcher: LauncherContext,
  allowPersistentProcesses: boolean,
  seamInstallation: ServeSeams["serviceInstallation"],
): Promise<number> {
  // `ensure` is what the editor extension runs to reach the service,
  // `reload-registration` is what the transient launchd job that
  // re-registers the service runs, and `install --update` is what an update
  // runs; no person types any of them.
  if (operation !== "ensure" && operation !== "install" && operation !== "uninstall" && operation !== "reload-registration") return refuseServeArgument(operation)
  const update = operation === "install" && args[1] === "--update"
  const unknown = args[update ? 2 : 1]
  if (unknown !== undefined) return refuseServeArgument(unknown)
  if (operation === "ensure") return await ensureServing(directories, allowPersistentProcesses)
  const installation = seamInstallation ? seamInstallation() : createAccountServiceInstallation(() => laneServicePlatform(directories, launcher, retiredServiceInstallations()))
  try {
    if (operation === "reload-registration") {
      // The reload makes launchd hold the registration file on disk and needs
      // no installed build. A reload of a file on disk that fails leaves the
      // service job running before it fails; Process initiation Off's
      // unload, which finds no file, leaves launchd as it is.
      const guard = registrationReloadGuard(accountServeDir(directories.userDataRoot, serveLaneFor(process.execPath)))
      await reloadLaunchdRegistration(accountLaunchdHost({ accountHome: directories.accountHome, runCommand: ownedCommandRunner(launcher.scope) }), { parentPid: process.ppid }, (outcome) => guard.record(outcome))
    } else if (update) await installation.refresh()
    else if (operation === "install") {
      await installation.install()
      // A person reads this, here or through a first install, which prints
      // this command's output. An update prints nothing. A home that is not
      // the login home registers nothing, which install states, and it is
      // not a failure: an isolated home still installs and runs Flywheel.
      if (await installation.installed() === null) process.stdout.write(`Process initiation cannot be registered for ${directories.accountHome}, because it is not the home you log in to. Flywheel starts its account service when you open a project.\n`)
      const lingerOffFor = await installation.lingerOffFor()
      if (lingerOffFor !== undefined) process.stdout.write(`${lingerNotice(lingerOffFor)}\n`)
    } else await installation.uninstall()
  } catch (error) {
    // A registration operation starts no service, so its refusal names the
    // operation rather than a failed start.
    log.warn("a service registration operation failed", { operation, update, error: errorMessage(error) })
    process.stderr.write(`flywheel serve ${operation}${update ? " --update" : ""}: ${errorMessage(error)}\n`)
    return 1
  }
  return 0
}

/** Names the one word after `serve` that it does not know, with the usage, and fails. */
const refuseServeArgument = (word: string): number => { process.stderr.write(`flywheel serve: unknown argument: ${word}\n\n${USAGE}\n`); return 1 }

/** Finds or starts this lane's account service by the same rules a terminal
 *  attaches by, and answers once it listens. It prints the handshake records
 *  a started service prints, with the listening record naming the service
 *  that answered, so a client that reads them, such as the editor extension,
 *  never launches a copy of its own beside a registered service: on the
 *  installed lane the service manager starts the registered job, and only
 *  where no registration is loaded and enabled does this process launch the
 *  service itself. */
async function ensureServing(directories: StartupDirectories, allowPersistentProcesses: boolean): Promise<number> {
  const attach = createAccountRuntimeAttach({ ...directories, allowPersistentProcesses })
  try {
    const identity = await attach.ensure((status) => {
      if (status.kind === "phase") process.stdout.write(encodeServeStatusRecord({ flywheel: "serve.startup.phase", label: status.label, ...(status.progress ? { progress: status.progress } : {}) }))
    })
    if (identity?.protocolVersion === undefined) throw new Error("the account service listens but did not publish a compatible identity record")
    process.stdout.write(encodeServeStatusRecord({ flywheel: "serve.listening", pid: identity.pid, version: identity.version, protocolVersion: identity.protocolVersion, lane: attach.lane }))
    return 0
  } catch (error) {
    process.stdout.write(encodeServeStartFailure(errorMessage(error), error instanceof ServeStartupFailure ? error.refusal : undefined))
    return 1
  } finally {
    attach.close()
  }
}
