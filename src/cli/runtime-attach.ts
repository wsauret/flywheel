import { closeSync, fstatSync, openSync, readFileSync, readSync, statSync } from "node:fs"
import { Redacted } from "effect"

import { AGENT_SESSION_ENV, serveLaneFor, sourceCheckout, type ServeLane, type SourceSnapshotLocation } from "../infra/cli-subprocess.js"
import type { StartupDirectories } from "../infra/directory-authorities.js"
import { accountServeErrorLogPath, accountServeRecordPath, accountServeSocketPath } from "../infra/paths.js"
import { launchPersistentSubprocess, type PersistentSubprocess } from "../infra/persistent-subprocess.js"
import { startupTrace } from "../infra/startup-trace.js"
import type { RuntimeStartupStatus } from "../protocol/app-service-types.js"
import type { RuntimeIdentity as DisplayedRuntimeIdentity } from "../protocol/client/runtime-identity.js"
import { createAccountAttachResponseReader, encodeAccountAttach, type AccountModuleRequest } from "../protocol/account-attach.js"
import { requestAccountModule } from "./account-module-request.js"
import { RUNTIME_PROTOCOL_VERSION } from "../protocol/runtime-liveness.js"
import { createServeStatusReader, decodeServeStartRefusal, ServeStartupFailure } from "../protocol/serve-handshake.js"
import { startupPhase } from "../protocol/startup-steps.js"
import { readOrCreateAccountAttachToken } from "../orchestration/app-service/account-attach-token.js"
import { ACCOUNT_DRAIN_HARD_EXIT_MS } from "../orchestration/app-service/runtime-shutdown.js"
import { unansweredStartRequested } from "../orchestration/app-service/service-manager-command.js"
import { installedBuildId, processRunningBuild, runningBuildId, runtimeCommand, type RunningBuild } from "../orchestration/app-service/runtime-executable.js"
import { errnoCode, errorMessage } from "../infra/error-message.js"
import { Log } from "../infra/log.js"
import { trustedCommandRun } from "../infra/process-container.js"
import { decodeHolderFields, type ProcessHolder } from "../infra/process-holder.js"
import type { TerminalSuccessor } from "./terminal-handoff.js"

const log = Log.create({ service: "runtime-attach" })

const HANDSHAKE_POLL_MS = 50
const HANDSHAKE_READ_BYTES = 64 * 1024
const LEGACY_CUTOVER_VERSION = "0.0.9"
const LEGACY_BUILD_CHECK_MS = 60_000
const LEGACY_LIVE_WORK_CHECK_MS = 2_000
/** How often a client that cannot join a busy superseded service looks for
 *  its retirement. That wait is as long as the service's work, so it is paced
 *  like the service's own build check rather than like a handshake. */
const SUPERSEDED_BUSY_POLL_MS = 1_000
/** How long a client waits for the registered service to listen after it
 *  asks the service manager for it. A start can find the previous instance
 *  still draining, for up to its hard-exit bound, and then wait out the
 *  manager's restart delay, so the bound is the drain limit plus a margin. */
const SERVICE_START_DEADLINE_MS = ACCOUNT_DRAIN_HARD_EXIT_MS + 20_000
/** How often a client that waits for the registered service asks the
 *  manager again while nothing listens. A start of a running job does
 *  nothing, so asking again only shortens a parked job's or a restart
 *  delay's wait. */
const SERVICE_START_REPEAT_MS = 5_000
/** How long a client waits for a superseded service to answer its cutover
 *  request. The answer comes once the service has read its projects'
 *  blockers and, when this request begins the drain, once the cut of their
 *  running work has settled or reached its limit. A request that waits
 *  longer reads as busy, and the client watches for the service to leave. */
const CUTOVER_REQUEST_DEADLINE_MS = 10_000
/** A service manager command usually answers at once; the probe's default
 *  budget is sized for `ps` and too tight for launchd under load. A start
 *  that does not answer within it is still a start request. */
const SERVICE_COMMAND_TIMEOUT_MS = 5_000
/** How much of a start's last error output its failure carries. */
const OUTPUT_TAIL_BYTES = 4_096

export interface ProjectRuntimeOptions extends StartupDirectories {
  readonly allowPersistentProcesses: boolean
  readonly idleTimeoutSeconds?: number
}

export interface AccountRuntimeAttachOptions extends ProjectRuntimeOptions {
  /** How this terminal replaces itself with another program and never
   *  settles (ARCH-RUNTIME-036): the build that serves when the service runs the
   *  current build and speaks a protocol this client cannot, or the lane's
   *  entry after a restart. A client without it refuses such a service with
   *  the protocol error and cannot restart. */
  readonly follow?: (successor: TerminalSuccessor) => Promise<never>
}

export interface AccountRuntimeAttach {
  /** The lane this process attaches in: the one its own executable serves. */
  readonly lane: ServeLane
  readonly socketPath: string
  readonly connectionPreface: () => Uint8Array
  /** Finds, starts, or replaces the lane's service, and resolves once one
   *  this client can speak to listens, with that service's identity record:
   *  the service this client reached after any cutover or launch. The record
   *  is undefined only when it vanished in the instant after that decision. */
  ensure(report: (status: RuntimeStartupStatus) => void): Promise<RuntimeIdentity | undefined>
  openProject(): Promise<void>
  /** Sends `request` to the account-lifetime service of `module` on a
   *  connection that opens no project, and calls `onAnswer` with each answer
   *  until the service ends the request. Rejects with the service's failure,
   *  or when the connection closes first. Call it once `ensure` resolved. */
  requestModule(module: string, request: AccountModuleRequest, onAnswer: (answer: unknown) => void): Promise<void>
  /** Restarts the account service and this terminal in place
   *  (PI-INTERACTION-048). It asks the service that serves now to make way
   *  for a successor, waits as a cutover waits while that service's blockers
   *  hold it, and starts the successor once it has left, so its running work
   *  resumes there. The terminal then follows into the lane's entry: the
   *  installed launcher, which runs the build `current` names, or the
   *  checkout's entry, which runs its current source. A restart requested
   *  while one is in flight joins it. Never settles once the terminal
   *  follows; rejects with the reason when the service refuses the request,
   *  does not leave within its shutdown bound, or the successor does not
   *  start, and the terminal keeps running. */
  restart(): Promise<never>
  /** This process is shutting down, and it starts no service from now on.
   *  An ensure called after this rejects at once, and an ensure already
   *  running rejects before it asks the service manager for a service,
   *  launches one, or follows another build. A service it launched that has
   *  not yet reported listening is stopped. A signal can end a client and its
   *  service in the same instant, and a service started by that client then
   *  outlives both of them. */
  close(): void
}

export interface RuntimeAttachSeams {
  readonly isRuntimeListening?: (socketPath: string) => Promise<boolean>
  readonly readRuntimeIdentity?: (identityPath: string) => RuntimeIdentity | undefined
  readonly installedBuildId?: (directories: StartupDirectories) => string | undefined
  readonly requestReplacement?: (socketPath: string, credential: string, intent: "cutover" | "restart") => Promise<"busy" | "retiring">
  /** Asks the lane's service manager to start its registered service. The
   *  production answer consults launchd, systemd, or Task Scheduler on the
   *  installed lane and is false on the dev lane. */
  readonly startInstalledService?: (options: ProjectRuntimeOptions, lane: ServeLane) => Promise<boolean>
  /** Launches a service from this client when no registered service answers,
   *  and stops it if `shutdown` aborts before it reports listening. */
  readonly launchRuntime?: (
    options: ProjectRuntimeOptions,
    report: (status: RuntimeStartupStatus) => void,
    shutdown: AbortSignal,
  ) => Promise<void>
  readonly sleep?: (milliseconds: number) => Promise<void>
  readonly now?: () => number
  /** The build this process executes, in place of the one read at its start. */
  readonly runningBuild?: RunningBuild
}

/** Finds or starts this lane's account service and authenticates each project
 * connection. An installed client asks a different installed build to retire,
 * then follows the active installation after its listener is withdrawn. A dev
 * client's first attach also asks a service that runs from a snapshot of the
 * client's checkout whether the snapshot holds the checkout's current source,
 * and starts a service of that source once a changed one has left. */
export function createAccountRuntimeAttach(options: AccountRuntimeAttachOptions, seams: RuntimeAttachSeams = {}): AccountRuntimeAttach {
  const lane = serveLaneFor(process.execPath)
  const socketPath = accountServeSocketPath(options.userDataRoot, lane)
  const credential = readOrCreateAccountAttachToken(options.userDataRoot, lane)
  let inFlight: Promise<RuntimeIdentity | undefined> | undefined
  const reporters = new Set<(status: RuntimeStartupStatus) => void>()
  let latestPhase: RuntimeStartupStatus | undefined
  // Only this client's first attach asks a dev service whether it runs the
  // checkout's current source. A reconnect never asks, so a client that
  // follows a replacement never asks for another one.
  let asksSource = lane === "dev"
  let restartInFlight: Promise<never> | undefined
  const shutdown = new AbortController()
  const ensure = (report: (status: RuntimeStartupStatus) => void, restart = false): Promise<RuntimeIdentity | undefined> => {
    if (shutdown.signal.aborted) return Promise.reject(shutdown.signal.reason)
    reporters.add(report)
    if (inFlight) {
      if (latestPhase) report(latestPhase)
      return inFlight
    }
    inFlight = ensureAccountRuntime(options, lane, socketPath, Redacted.value(credential), (status) => {
      latestPhase = status
      for (const reporter of reporters) reporter(status)
    }, seams, shutdown.signal, restart ? "restart" : asksSource ? "source" : undefined).finally(() => {
      inFlight = undefined
      latestPhase = undefined
      reporters.clear()
    })
    asksSource = false
    return inFlight
  }
  const restartAndFollow = async (): Promise<never> => {
    const follow = options.follow
    if (follow === undefined) throw new Error("this client cannot replace itself, so it cannot restart")
    // An attach in flight decided about the service before this request,
    // so the restart's own attach starts after it rather than joining it.
    // Every attach that starts meanwhile joins the restart's and waits until
    // the successor serves.
    for (let running = inFlight; running !== undefined; running = inFlight) await running.catch(() => {})
    await ensure(() => {}, true)
    return await follow({ command: runtimeCommand(options), env: {} })
  }
  return {
    lane,
    socketPath,
    connectionPreface: () => new TextEncoder().encode(encodeAccountAttach({
      intent: "runtime",
      projectRoot: options.projectRoot,
      credential: Redacted.value(credential),
    })),
    ensure: (report) => ensure(report),
    restart() {
      restartInFlight ??= restartAndFollow().catch((error: unknown) => {
        log.warn("the restart did not complete; this terminal keeps running", { error: errorMessage(error) })
        throw error
      }).finally(() => { restartInFlight = undefined })
      return restartInFlight
    },
    openProject() {
      return openAccountProject(socketPath, new TextEncoder().encode(encodeAccountAttach({
        intent: "browser",
        projectRoot: options.projectRoot,
        credential: Redacted.value(credential),
      })))
    },
    requestModule(module, request, onAnswer) {
      return requestAccountModule(socketPath, new TextEncoder().encode(encodeAccountAttach({ intent: "module", module, request, credential: Redacted.value(credential) })), onAnswer)
    },
    close() {
      reporters.clear()
      latestPhase = undefined
      if (!shutdown.signal.aborted) shutdown.abort(new Error("this client is shutting down and starts no account service"))
    },
  }
}

/** Authenticates one short-lived account connection and waits until its
 * canonical project runtime is ready. Closing it leaves registration durable
 * while the normal idle owner decides when the runtime can sleep. */
function openAccountProject(socketPath: string, preface: Uint8Array): Promise<void> {
  const reader = createAccountAttachResponseReader()
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (socket: { end(): void } | undefined, error?: unknown): void => {
      if (settled) return
      settled = true
      socket?.end()
      if (error === undefined) resolve()
      else reject(error)
    }
    void Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) { socket.write(preface) },
        data(socket, chunk) {
          try {
            const result = reader.push(chunk)
            if (result.kind === "ready") finish(socket)
            else if (result.kind === "failed") finish(socket, new Error(result.error))
          } catch (error) {
            finish(socket, error)
          }
        },
        error(socket, error) { finish(socket, error) },
        close() { finish(undefined, new Error("The account service closed before the project was ready")) },
      },
    }).catch((error: unknown) => { finish(undefined, error) })
  })
}

async function ensureAccountRuntime(
  options: AccountRuntimeAttachOptions,
  lane: ServeLane,
  socketPath: string,
  credential: string,
  report: (status: RuntimeStartupStatus) => void,
  seams: RuntimeAttachSeams,
  shutdown: AbortSignal,
  /** Whether this ensure asks the service found listening to make way: at a
   *  dev client's first attach, when it runs from a snapshot of this
   *  checkout and may hold stale source, or for a person's restart, always. */
  asks: "source" | "restart" | undefined,
): Promise<RuntimeIdentity | undefined> {
  const listening = seams.isRuntimeListening ?? isRuntimeListening
  const readIdentity = seams.readRuntimeIdentity ?? readRuntimeIdentity
  const readBuild = seams.installedBuildId ?? installedBuildId
  const spawn = seams.launchRuntime ?? launchAccountRuntime
  const startService = seams.startInstalledService ?? startInstalledService
  const pause = seams.sleep ?? Bun.sleep
  // Every wait below ends in a start, a launch, or a follow. A client that
  // began shutting down during the wait stops there instead.
  const sleep = async (milliseconds: number): Promise<void> => {
    await pause(milliseconds)
    shutdown.throwIfAborted()
  }
  const now = seams.now ?? Date.now
  const identityPath = accountServeRecordPath(options.userDataRoot, lane)
  const currentBuild = readBuild(options)
  // The service that makes way at this client's request, which reads as
  // superseded until another service's record replaces its own or nothing
  // listens. A dev service that makes way for its checkout's current source,
  // or any service asked to restart, can run the build this client runs, so
  // the build alone would read it as current while it drains.
  let retiring: number | undefined
  const observation: ServiceCutoverObservation = { socketPath, identityPath, currentBuild, listening, readIdentity, retiring: () => retiring }
  // A service of the current build that speaks another protocol is a
  // protocol boundary, not a fault: this client is the older program, and the
  // terminal follows by becoming the build that serves. Any other service
  // this client cannot speak to is refused in the protocol's own words.
  const protocolBoundary = async (identity: RuntimeIdentity | undefined): Promise<void> => {
    const refusal = `the account service speaks protocol ${identity?.protocolVersion ?? "unknown"} and this client requires ${RUNTIME_PROTOCOL_VERSION}`
    const follow = options.follow
    if (follow === undefined || identity === undefined || identity.buildId !== currentBuild) throw new Error(refusal)
    const [{ servingBuild }, { buildPlatformArch }] = await Promise.all([import("./serving-build.js"), import("../infra/native-assets.js")])
    const target = servingBuild({
      lane,
      platform: process.platform,
      platformArch: buildPlatformArch(),
      userDataRoot: options.userDataRoot,
      identity,
      ownBuild: runningBuildId(seams.runningBuild ?? processRunningBuild(), options),
      sourceCommand: runtimeCommand(options),
    })
    if (typeof target === "string") throw new Error(`${refusal}: ${target}`)
    startupTrace(`account service speaks protocol ${identity.protocolVersion ?? "unknown"}; following build ${target.version}`)
    shutdown.throwIfAborted()
    return await follow(target)
  }
  // The registered service is the resident owner of the installed lane and,
  // while its registration is loaded and enabled, its one starter. A client
  // that finds nothing listening asks the service manager for it and waits,
  // so the job launchd, systemd, or Task Scheduler supervises comes back
  // under its own registration, its consent grant, and its restart policy,
  // never beside a client-owned twin that holds the address while the
  // registered job parks or respawns against it. The client launches a
  // service itself only where no registration is loaded and enabled: the dev
  // lane, an account home the manager does not serve, a login home with
  // nothing registered, or a registration the person disabled. A `current`
  // link that does not read changes none of that.
  const launch = async (): Promise<void> => {
    shutdown.throwIfAborted()
    // A start that answers this request fails after this moment, and its
    // error output follows the bytes that the service's error log holds now.
    const requestedAt = now()
    const errorLogBytes = fileSize(accountServeErrorLogPath(options.userDataRoot))
    // A start the manager did not answer settles nothing about who starts
    // the service, so the wait below observes the socket and asks again.
    if (await startService(options, lane).catch(unansweredStartRequested)) {
      report({ kind: "phase", ...startupPhase({ step: "account-service" }) })
      startupTrace("account service start requested from the service manager")
      // Each start of the installed lane that ends before it listens, or
      // within its first minute after it, records its cause, and a start whose
      // failure persisted parks the lane until a start serves that minute. A
      // start that listens ends this wait, so only a failure before the listen
      // is this wait's answer. The start this request runs parks again at once when
      // it fails for a cause that can park, so a park newer than this request
      // ends the wait at once: another request would only run one more start
      // that fails the same way. A later failure that does not park, such as
      // a refusal that clears by itself, leaves an earlier park as it was, and
      // the wait goes on. At the deadline, any failure newer than the request
      // is the answer.
      const { lastServiceStartFailure } = await import("../infra/update/service-start-record.js")
      const failedSinceRequest = () => {
        const failure = lastServiceStartFailure(options.userDataRoot)
        return failure !== undefined && failure.lastAt >= requestedAt ? failure : undefined
      }
      // While nothing listens the manager is asked again now and then, so a
      // job that parked behind an owner that has since left, or that waits
      // out a restart delay, starts promptly. The first request settled who
      // starts the service: a repeated request that fails is only logged. One
      // that finds no registration loaded and enabled any more leaves the
      // wait, and this client launches the service itself.
      let unloaded = false
      let asked = now()
      const askAgain = async (): Promise<boolean> => {
        const failure = failedSinceRequest()
        if (failure?.parked !== undefined && failure.parked.lastAt >= requestedAt) throw recordedStartFailure(failure)
        if (now() - asked < SERVICE_START_REPEAT_MS) return true
        asked = now()
        try {
          unloaded = !(await startService(options, lane))
        } catch (error) {
          log.warn("the service manager refused a repeated start of the account service; the client keeps waiting", { error: errorMessage(error) })
        }
        return !unloaded
      }
      const state = await waitForServiceState({ ...observation, deadlineMs: SERVICE_START_DEADLINE_MS, sleep, now, poll: askAgain }, (observed) => observed !== "gone")
      if (state === "current") {
        startupTrace("account service listening")
        return
      }
      if (state === "boundary") return await protocolBoundary(readIdentity(identityPath))
      // Another build answered first; it is waited out as an ordinary start.
      if (state === "superseded") return await attachListening()
      if (!unloaded) {
        const failure = failedSinceRequest()
        if (failure !== undefined) throw recordedStartFailure(failure)
        // Nothing recorded why: the start ended where none of its own code
        // ran, such as a native crash, or it could not write the record. Only
        // launchd keeps the output of such a start, in the error log.
        const output = lastLinesSince(accountServeErrorLogPath(options.userDataRoot), errorLogBytes)
        throw new Error(`the registered account service did not start listening within ${SERVICE_START_DEADLINE_MS / 1_000} seconds; the service manager runs ${buildName(currentBuild)}${output === undefined ? "" : `. Its error output: ${output}`}`)
      }
      startupTrace("the account service registration is no longer loaded and enabled; launching one")
    }
    shutdown.throwIfAborted()
    await spawn(options, report, shutdown)
    // The service records its identity before it reports listening, so the
    // record read now describes whichever service answered the launch: the
    // current build, which may speak a protocol this client does not.
    const launched = readIdentity(identityPath)
    if (launched?.buildId !== undefined && launched.buildId === currentBuild && launched.protocolVersion !== RUNTIME_PROTOCOL_VERSION) await protocolBoundary(launched)
  }
  /** Waits up to `deadlineMs` until the service found listening no longer
   *  reads as superseded, and answers the last observation either way. */
  const outlastSuperseded = (deadlineMs: number, pollMs = HANDSHAKE_POLL_MS): Promise<ServiceState> =>
    waitForServiceState({ ...observation, deadlineMs, pollMs, sleep, now }, (observed) => observed !== "superseded")
  /** What a wait for a superseded service to leave ends in, other than that
   *  service still serving: a start of the current build, or the boundary. */
  const proceed = async (state: ServiceState): Promise<void> => {
    if (state === "gone") await launch()
    else if (state === "boundary") await protocolBoundary(readIdentity(identityPath))
  }
  /** Waits until the service found listening no longer serves this client
   *  as the current one, then starts or follows what serves after it. */
  const waitOut = async (): Promise<void> => {
    report({ kind: "phase", ...startupPhase({ step: "account-service" }) })
    return await proceed(await outlastSuperseded(Number.POSITIVE_INFINITY, SUPERSEDED_BUSY_POLL_MS))
  }
  /** Joins, follows, or waits out the service found listening. */
  const attachListening = async (): Promise<void> => {
    const identity = readIdentity(identityPath)
    const compatible = identity?.protocolVersion === RUNTIME_PROTOCOL_VERSION
    // The build comparison alone decides that a service is superseded, which
    // is this client's reason to ask it to retire (ARCH-RUNTIME-031). The protocol
    // decides only whether this client can be served by that service while
    // it stays: a login service restarts a killed service from the build
    // that was current at that moment, so an install that follows finds an
    // older service listening, and the older service finishes its work and
    // retires on its own build check whether or not a client can speak to it.
    const superseded = identity?.buildId !== undefined && currentBuild !== undefined && identity.buildId !== currentBuild
    // The one other reason: a dev service of this build that runs from a
    // snapshot of this client's own checkout is asked, at this client's first
    // attach, whether that snapshot holds the checkout's current source. The
    // service alone decides, and it makes way when the source changed
    // (ARCH-RUNTIME-031).
    const asksSourceCutover = asks === "source" && identity?.sourceSnapshot?.checkout === sourceCheckout()
    // A client that an agent's command started serves that agent and never
    // replaces the service every other session runs on.
    const mayAsk = process.env[AGENT_SESSION_ENV] === undefined
    if (identity === undefined || !mayAsk || (!superseded && !asksSourceCutover && asks !== "restart")) {
      if (compatible) return
      return await protocolBoundary(identity)
    }
    const intent = asks === "restart" ? "restart" : "cutover"
    let answer: "busy" | "retiring"
    try {
      answer = await (seams.requestReplacement ?? requestAccountReplacement)(socketPath, credential, intent)
    } catch (error) {
      // A restart the service did not take leaves that service serving, so
      // nothing below would restart anything.
      if (intent === "restart") throw error
      if (identity.version !== LEGACY_CUTOVER_VERSION) {
        const state = await observedServiceState(observation)
        if (state === "superseded") throw error
        return await proceed(state)
      }
      return await proceed(await outlastSuperseded(LEGACY_BUILD_CHECK_MS + LEGACY_LIVE_WORK_CHECK_MS))
    }
    if (answer === "busy") {
      // A service asked to restart makes way once its blockers clear, so it
      // never serves this client again. A superseded one serves a client it
      // can speak to until its build check retires it.
      if (intent === "restart") retiring = identity.pid
      else if (compatible) return
      // The service is letting an admitted call return, or a project finish
      // opening or recovering, before it hands its work to its successor
      // (PI-REMOTE-012). The load screen shows the ordinary start, never the
      // builds behind it.
      startupTrace(`the account service answered the ${intent} request busy; waiting for it to leave`)
      return await waitOut()
    }
    report({ kind: "phase", ...startupPhase({ step: "account-service" }) })
    retiring = identity.pid
    const state = await outlastSuperseded(ACCOUNT_DRAIN_HARD_EXIT_MS)
    if (state === "superseded") throw new Error("the account service did not stop within its shutdown bound")
    return await proceed(state)
  }
  if (await listening(socketPath)) await attachListening()
  else await launch()
  // Each path above returns only once a service this client can speak to
  // serves, after any cutover or launch, and a service writes its record
  // before it reports listening, so the record read now names the service
  // this client reached.
  return readIdentity(identityPath)
}

/** What a client finds at the lane's address: nothing, a service of the
 *  current build it can speak to, one of the current build in another
 *  protocol, or a service another build runs or that is retiring. When no
 *  current build can be read, no service is another build's. A service that
 *  listens before it has written its identity record reads as superseded, so
 *  the client reads the record again rather than refuse a protocol it has
 *  not read. */
type ServiceState = "gone" | "current" | "boundary" | "superseded"

interface ServiceCutoverObservation {
  readonly socketPath: string
  readonly identityPath: string
  readonly currentBuild: string | undefined
  readonly listening: (socketPath: string) => Promise<boolean>
  readonly readIdentity: (identityPath: string) => RuntimeIdentity | undefined
  /** The pid of the service that makes way at this client's request, if one
   *  does: one that answered a cutover with `retiring`, or one asked to
   *  restart, whatever it answered. */
  readonly retiring: () => number | undefined
}

async function observedServiceState(options: ServiceCutoverObservation): Promise<ServiceState> {
  if (!(await options.listening(options.socketPath))) return "gone"
  const identity = options.readIdentity(options.identityPath)
  if (identity === undefined || identity.pid === options.retiring() || (options.currentBuild !== undefined && identity.buildId !== options.currentBuild)) return "superseded"
  return identity.protocolVersion === RUNTIME_PROTOCOL_VERSION ? "current" : "boundary"
}

/** Polls the service until `settled` accepts what it observes or the deadline
 *  passes, and answers the last observation either way. `poll` runs after
 *  each pause, and a false answer ends the wait with a fresh observation. */
async function waitForServiceState(
  options: ServiceCutoverObservation & {
    readonly deadlineMs: number
    readonly pollMs?: number
    readonly sleep: (milliseconds: number) => Promise<void>
    readonly now: () => number
    readonly poll?: () => Promise<boolean>
  },
  settled: (state: ServiceState) => boolean,
): Promise<ServiceState> {
  const deadline = options.now() + options.deadlineMs
  for (;;) {
    const state = await observedServiceState(options)
    if (settled(state) || options.now() >= deadline) return state
    await options.sleep(options.pollMs ?? HANDSHAKE_POLL_MS)
    if (options.poll !== undefined && !(await options.poll())) return await observedServiceState(options)
  }
}

/** Asks the installed lane's registered service to start. The installation
 *  module loads only here, on the rare attach that finds nothing listening,
 *  so the common warm attach carries none of its weight. */
async function startInstalledService(options: ProjectRuntimeOptions, lane: ServeLane): Promise<boolean> {
  if (lane !== "installed") return false
  const { accountServicePlatform, createAccountServiceInstallation, serviceCommandLaunch } = await import("../orchestration/app-service/account-service-installation.js")
  // A client attach runs before any launcher scope exists, so it drives the
  // service manager through trusted system programs.
  const host = { platform: process.platform, env: process.env, uid: process.getuid?.() }
  const installation = createAccountServiceInstallation(() => accountServicePlatform({
    userDataRoot: options.userDataRoot,
    accountHome: options.accountHome,
    // Retired registrations matter only to `serve install`; a start touches none.
    retired: [],
    runCommand: (command) => trustedCommandRun(serviceCommandLaunch(command, host), SERVICE_COMMAND_TIMEOUT_MS),
  }))
  return await installation.start()
}

/** Starts this lane's account service and waits until it reports listening,
 *  as a client does when nothing listens, and as a resident service does for
 *  its successor when it retires and nothing else starts one. */
export async function launchAccountRuntime(
  options: ProjectRuntimeOptions,
  report: (status: RuntimeStartupStatus) => void,
  shutdown: AbortSignal,
): Promise<void> {
  report({ kind: "phase", ...startupPhase({ step: "account-service" }) })
  startupTrace("account service launch start")
  const buildId = installedBuildId(options)
  const started = await launchPersistentSubprocess([
    ...runtimeCommand(options),
    ...(options.allowPersistentProcesses ? ["--allow-persistent-processes"] : []),
    "serve",
  ], {
    cwd: options.executionCwd,
    env: {
      ...process.env,
      HOME: options.accountHome,
      ...(options.idleTimeoutSeconds === undefined ? {} : { FLYWHEEL_PROJECT_IDLE_TIMEOUT_SECONDS: String(options.idleTimeoutSeconds) }),
    },
    selfManaged: true,
  })
  startupTrace("account service launched")
  try {
    await awaitServeHandshake(started, report, shutdown, buildId)
    startupTrace("account service listening")
  } finally {
    started.release()
  }
}

/** Asks the listening service to make way for a successor: the current
 *  build or source for a `cutover`, whatever its lane starts next for a
 *  `restart`. A service that does not answer within `deadlineMs` reads as
 *  `busy`: its cut or its blockers still hold it, and the client shows its
 *  ordinary start and watches for the service to leave, never a request that
 *  hangs. */
export function requestAccountReplacement(socketPath: string, credential: string, intent: "cutover" | "restart", deadlineMs: number = CUTOVER_REQUEST_DEADLINE_MS): Promise<"busy" | "retiring"> {
  const reader = createAccountAttachResponseReader()
  const preface = new TextEncoder().encode(encodeAccountAttach({ intent, credential }))
  return new Promise((resolve, reject) => {
    let settled = false
    let connection: { end(): void } | undefined
    const finish = (socket: { end(): void } | undefined, result?: "busy" | "retiring", error?: unknown): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      socket?.end()
      if (error !== undefined) reject(error)
      else if (result !== undefined) resolve(result)
      else reject(new Error(`The account service closed before it answered the ${intent} request`))
    }
    const deadline = setTimeout(() => {
      startupTrace(`the account service did not answer the ${intent} request in time; it reads as busy`)
      finish(connection, "busy")
    }, deadlineMs)
    void Bun.connect({
      unix: socketPath,
      socket: {
        open(socket) {
          // A connection that opens after the deadline answered is not used.
          if (settled) {
            socket.end()
            return
          }
          connection = socket
          socket.write(preface)
        },
        data(socket, chunk) {
          const result = reader.push(chunk)
          if (result.kind === "busy" || result.kind === "retiring") finish(socket, result.kind)
          else if (result.kind === "failed") finish(socket, undefined, new Error(result.error))
          else if (result.kind === "ready") finish(socket, undefined, new Error(`The account service returned a project response to a ${intent} request`))
        },
        error(socket, error) { finish(socket, undefined, error) },
        close() { finish(undefined) },
      },
    }).catch((error: unknown) => { finish(undefined, undefined, error) })
  })
}

/** Reads a starting account service's stdout handshake from its spool until
 *  it reports listening, reports failure, or exits. A process that exits is
 *  read once more before its exit counts: the failure line and the exit land
 *  in the same instant, and the line is the one that says why. A process
 *  that exits with no failure line ended where none of its own code ran, so
 *  its error names the executable, `buildId`, the exit code, and the last
 *  lines of its error output. Whether this client can speak the protocol of
 *  the service that answered is the caller's decision, from that service's
 *  identity record.
 *
 *  Until the service reports listening it belongs to the client that
 *  launched it. When `shutdown` aborts before then, the service is stopped
 *  and the handshake rejects with the shutdown's reason. A signal can end the
 *  service before it reaches the client, so the client launches a
 *  replacement in good faith and learns only during the launch that it is
 *  exiting. That replacement would otherwise outlive the client with nobody
 *  attached to it. */
export async function awaitServeHandshake(
  started: Pick<PersistentSubprocess, "command" | "metadata" | "read" | "exited" | "stop">,
  report: (status: RuntimeStartupStatus) => void,
  shutdown: AbortSignal,
  buildId: string | undefined,
): Promise<void> {
  const abandoned = Promise.withResolvers<undefined>()
  const abandon = (): void => { abandoned.resolve(undefined) }
  shutdown.addEventListener("abort", abandon, { once: true })
  let offset = 0
  let partial = ""
  let exitCode: number | undefined
  const readStatus = createServeStatusReader()
  try {
    while (true) {
      if (shutdown.aborted) {
        const outcome = await started.stop().catch((): "unsettled" => "unsettled")
        startupTrace(`account service launch abandoned by shutdown; the launched service ${outcome === "terminated" ? "stopped" : "did not confirm its stop"}`)
        shutdown.throwIfAborted()
      }
      const read = started.read("stdout", offset, HANDSHAKE_READ_BYTES)
      offset = read.nextOffset
      partial += new TextDecoder().decode(read.data)
      const lines = partial.split("\n")
      partial = lines.pop() ?? ""
      for (const line of lines) {
        const status = readStatus(line)
        if (status?.flywheel === "serve.startup.phase") {
          report({ kind: "phase", label: status.label, ...(status.progress ? { progress: status.progress } : {}) })
        } else if (status?.flywheel === "serve.startup.failed") {
          throw new ServeStartupFailure(status.error, status.refusal)
        } else if (status?.flywheel === "serve.listening" || status?.flywheel === "serve.already-listening") {
          return
        }
      }
      if (exitCode !== undefined) {
        const output = lastLines(started.metadata().stderrBytes, 0, (at, length) => started.read("stderr", at, length).data)
        throw new Error(`the account service exited with code ${exitCode} before it was listening; it ran ${started.command[0]}, ${buildName(buildId)}${output === undefined ? "" : `. Its last output: ${output}`}`)
      }
      exitCode = await Promise.race([started.exited, Bun.sleep(HANDSHAKE_POLL_MS).then(() => undefined), abandoned.promise])
    }
  } finally {
    shutdown.removeEventListener("abort", abandon)
  }
}

/** The error of a start that the lane's start record says failed, with the
 *  refusal it named. */
function recordedStartFailure(failure: { readonly cause: string; readonly refusal?: unknown }): ServeStartupFailure {
  return new ServeStartupFailure(failure.cause, decodeServeStartRefusal(failure.refusal))
}

function buildName(buildId: string | undefined): string {
  return buildId === undefined ? "a build this client could not read" : `build ${buildId}`
}

function fileSize(path: string): number {
  try {
    return statSync(path, { throwIfNoEntry: false })?.size ?? 0
  } catch {
    return 0
  }
}

/** The last lines that the file at `path` received after it held `from`
 *  bytes. A file smaller than that was trimmed since, and every line it kept
 *  can be older than `from`, so it answers nothing then, and nothing when the
 *  file cannot be read. */
function lastLinesSince(path: string, from: number): string | undefined {
  let fd: number
  try {
    fd = openSync(path, "r")
  } catch {
    return undefined
  }
  try {
    const size = fstatSync(fd).size
    if (size < from) return undefined
    return lastLines(size, from, (offset, length) => {
      const data = new Uint8Array(length)
      return data.subarray(0, readSync(fd, data, 0, length, offset))
    })
  } catch {
    return undefined
  } finally {
    closeSync(fd)
  }
}

/** The whole lines among the last `OUTPUT_TAIL_BYTES` bytes of an output of
 *  `size` bytes, from byte `from` on, joined into one line, because a notice
 *  shows only the first line of a cause. The window leaves out the line it
 *  cuts and every blank line, and answers nothing when no line is left. */
function lastLines(size: number, from: number, read: (offset: number, length: number) => Uint8Array): string | undefined {
  // One byte before the window shows whether the window's first line is whole.
  const start = Math.max(from, size - OUTPUT_TAIL_BYTES - 1)
  if (start >= size) return undefined
  const lines = new TextDecoder().decode(read(start, size - start)).split("\n")
  if (start > from) lines.shift()
  const kept = lines.map((line) => line.trim()).filter((line) => line.length > 0)
  return kept.length === 0 ? undefined : kept.join(" | ")
}

/** What one connection to a lane's address proves: a service listens, a
 *  process accepted the connection and did not answer it, the connect found
 *  no path or was refused, or nothing, with the code the connect failed with. */
export type RendezvousProbe =
  | { readonly kind: "listening" }
  | { readonly kind: "silent" }
  | { readonly kind: "absent"; readonly code: "ENOENT" | "ECONNREFUSED" }
  | { readonly kind: "unknown"; readonly code: string }

const LISTENING: RendezvousProbe = { kind: "listening" }
const SILENT: RendezvousProbe = { kind: "silent" }

/** Connects once to a lane's address. A missing path proves that no service
 *  listens there, and a refused connection proves it too unless the caller
 *  knows the holder runs. Any other connect failure, such as a path this user
 *  may not connect to, proves neither a service nor its absence, so no caller
 *  may remove the path on it.
 *
 *  Without `answerWithinMs`, a connection that opens reads as `listening`.
 *  With it, the probe writes one empty line and asks for an answer within the
 *  bound: every build since v0.0.9 rejects that line and closes the
 *  connection, and writes no record and adds no hold for it. Data, or an
 *  orderly close, is the answer. A process that stalls also has its
 *  connections accepted by the kernel, so a connection that gets no answer
 *  within the bound, or that ends with an error, reads as `silent`.
 *
 *  An address that does not exist answers `absent` before any connect, in
 *  the caller's own turn. A client's first probe is followed by its
 *  interface load, which holds the event loop, and a Windows pipe connect
 *  answers only through the loop, so the client would launch its service
 *  only after that load. Only a missing path counts. Windows fails the stat
 *  of a pipe whose every instance is taken with EBUSY, so that answer goes on
 *  to the connect, which waits for a free instance. */
export async function probeRendezvous(socketPath: string, answerWithinMs?: number): Promise<RendezvousProbe> {
  try {
    statSync(socketPath)
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return { kind: "absent", code: "ENOENT" }
  }
  const answer = Promise.withResolvers<RendezvousProbe>()
  let socket: Bun.Socket
  try {
    socket = await Bun.connect({
      unix: socketPath,
      socket: {
        open(opened) {
          if (answerWithinMs !== undefined) opened.write("\n")
        },
        data() { answer.resolve(LISTENING) },
        end() { answer.resolve(LISTENING) },
        error() { answer.resolve(SILENT) },
        close(_closed, error) { answer.resolve(error === undefined ? LISTENING : SILENT) },
      },
    })
  } catch (error) {
    const code = errnoCode(error)
    if (code === "ECONNREFUSED" || code === "ENOENT") return { kind: "absent", code }
    return { kind: "unknown", code: code ?? errorMessage(error) }
  }
  if (answerWithinMs === undefined) {
    socket.end()
    return LISTENING
  }
  const bound = setTimeout(() => { answer.resolve(SILENT) }, answerWithinMs)
  try {
    return await answer.promise
  } finally {
    clearTimeout(bound)
    socket.end()
  }
}

/** Whether a connect error says that this user may not connect to the
 *  address, which a person fixes by the file's permissions or by removing
 *  the file. */
export function refusesAccess(code: string): boolean {
  return code === "EACCES" || code === "EPERM"
}

/** Whether a service listens at a lane's address. A client that reads no
 *  listener starts the service, whose own probe refuses a start on an answer
 *  that proves nothing. */
export async function isRuntimeListening(socketPath: string): Promise<boolean> {
  return (await probeRendezvous(socketPath)).kind === "listening"
}

/** A lane's identity record: the service that published its address. The
 *  record lives while that service serves, so a record whose holder is gone
 *  is the trace of a service that ended without its exit path. */
export interface RuntimeIdentity {
  readonly pid: number
  readonly version: string
  readonly protocolVersion?: number
  readonly buildId?: string
  /** The code identity a person reads, as `runningDisplayBuildId` states it.
   *  Absent when the service runs live from source or predates the field. */
  readonly displayBuildId?: string
  /** The snapshot of its checkout that a dev service runs from. A record
   *  without it, which a service before snapshots and every installed
   *  service writes, names none. */
  readonly sourceSnapshot?: SourceSnapshotLocation
  /** The process that published the record. The holder fields sit flat
   *  beside `pid`. A record without them names no identity: an earlier build
   *  wrote it, or a service that could not read its own identity. It is a
   *  valid shape for good, not a shape to convert. */
  readonly holder: ProcessHolder
}

/** The identity a client shows for the service a record names: the display
 *  build the service wrote from `runningDisplayBuildId`, the same value its
 *  snapshots state. A record from a service that predates the field names
 *  none, and the first snapshot supplies it. */
export function displayedRuntimeIdentity(identity: RuntimeIdentity): DisplayedRuntimeIdentity {
  return { version: identity.version, buildId: identity.displayBuildId ?? null }
}

function isSourceSnapshotLocation(value: unknown): value is SourceSnapshotLocation {
  return typeof value === "object" && value !== null
    && "checkout" in value && typeof value.checkout === "string"
    && "digest" in value && typeof value.digest === "string"
}

export function readRuntimeIdentity(identityPath: string): RuntimeIdentity | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(identityPath, "utf8"))
    if (typeof parsed !== "object" || parsed === null) return undefined
    if (!("pid" in parsed) || typeof parsed.pid !== "number") return undefined
    if (!("version" in parsed) || typeof parsed.version !== "string") return undefined
    return {
      pid: parsed.pid,
      version: parsed.version,
      ...("protocolVersion" in parsed && typeof parsed.protocolVersion === "number" ? { protocolVersion: parsed.protocolVersion } : {}),
      ...("buildId" in parsed && typeof parsed.buildId === "string" ? { buildId: parsed.buildId } : {}),
      ...("displayBuildId" in parsed && typeof parsed.displayBuildId === "string" ? { displayBuildId: parsed.displayBuildId } : {}),
      ...("sourceSnapshot" in parsed && isSourceSnapshotLocation(parsed.sourceSnapshot) ? { sourceSnapshot: { checkout: parsed.sourceSnapshot.checkout, digest: parsed.sourceSnapshot.digest } } : {}),
      holder: decodeHolderFields(parsed.pid, {
        v: "v" in parsed ? parsed.v : undefined,
        start: "start" in parsed ? parsed.start : undefined,
        boot: "boot" in parsed ? parsed.boot : undefined,
      }),
    }
  } catch {
    return undefined
  }
}
