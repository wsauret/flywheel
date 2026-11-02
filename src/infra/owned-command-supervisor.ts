import * as fs from "node:fs"
import { win32 } from "node:path"

import {
  COMMAND_CHANNEL_VERSION,
  decodeSupervisorWord,
  encodeSupervisorAnswer,
  writeOutcomeRecord,
  type CommandAdoption,
  type CommandHandover,
} from "./command-handover.js"
import { parseCommandSupervisorArgv, type CommandSupervisorArgv } from "./owned-command-policy.js"
import { markedContainer, ownContainerMark } from "./container-mark.js"
import { errorMessage } from "./error-message.js"
import { namedExitStatus } from "./exit-status.js"
import { connectLines, serveLines, streamLines, type LineConnection, type LineServer } from "./line-channel.js"
import { posixGuardianReads, watchGuardian, windowsGuardianReads, type GuardianReads } from "./guardian-watch.js"
import {
  emptyContainers,
  onTermination,
  ownUnixContainer,
  ownWindowsJobContainer,
  recordTermination,
  unixContainerIdentity,
  type ManagedContainer,
  type TerminationCause,
} from "./process-container.js"
import { establishProcessPriority } from "./process-priority.js"
import { Log } from "./log.js"
import { LAUNCH_FAILED_EXIT_CODE } from "./owned-subprocess.js"
import { formatDebugLogLine } from "./debug-log.js"
import { unsettledEmptyingStreak } from "./process-probe-streak.js"
import { MAX_TIMER_MS } from "./timers.js"
import { windowsJobApi } from "./windows-job-object.js"

const log = Log.create({ service: "command-supervisor" })

/** The supervisor of one owned command: the process that leads its container.
 *
 *  It exists because a payload cannot supervise its own container. It is
 *  spawned into a fresh process group, so it is that group's leader for as long
 *  as the group exists; it holds the launcher's stream handles and passes them
 *  to the payload unchanged, so not one byte of payload output travels through
 *  it; it starts the payload only after the launcher admits it, so a refused
 *  ownership leaves nothing running; and it ends its container itself, so
 *  TERM, grace and KILL live in one place rather than in every caller.
 *
 *  It exits of its own accord only once the container is empty, and it exits
 *  with the payload's own status, so a launcher that observes this process
 *  observes the payload and everything the payload started. A supervisor that
 *  is killed or crashes proves nothing about its container, so the launcher
 *  proves emptiness itself before it reports the exit. */

/** The descriptor the launcher's control pipe arrives on. */
const SUPERVISOR_CONTROL_FD = 3

/** The payload never ran: ownership was refused, or the launcher died before
 *  it could admit the container. */
export const OWNERSHIP_REFUSED_EXIT_CODE = 70

/** The name a launch's job object is created under. One namespace, so a stray
 *  container is recognizable, and the ownership token, so the name is used
 *  once. */
export function windowsContainerName(token: string): string {
  return `Flywheel.container.${token}`
}

/** The launcher's control channel for one launch.
 *
 *  Windows has no descriptor a child can inherit beyond its three streams, so
 *  the channel is a named pipe. The name is the ownership token for the same
 *  reason the container's is: it belongs to exactly one launch, so no two
 *  launches can reach each other's channel. */
export function windowsControlChannelName(token: string): string {
  return String.raw`\\.\pipe\Flywheel.control.` + token
}

/** How long a re-raised signal is given to land before this process falls back
 *  to an ordinary exit. The kernel delivers it immediately; the wait exists so
 *  the fallback cannot report an exit code the payload never produced. */
const SIGNAL_REPORT_MS = 1_000

const RELEASED_SETTLEMENT_RETRY_MS = 250

/** What a payload used over its life. CPU time, in milliseconds, sums the
 *  payload and every descendant it waited for. The memory peak is the
 *  kernel's: the largest single process among them, not the tree's sum. */
interface PayloadUsage {
  readonly cpuUserMs: number
  readonly cpuSystemMs: number
  readonly maxProcessRssBytes: number
}

export interface SupervisedTarget {
  readonly exited: Promise<void>
  readonly exitCode: number | null
  readonly signalCode: NodeJS.Signals | null
  /** Read once the payload exited. Undefined where the platform reports no
   *  usage. */
  usage(): PayloadUsage | undefined
}

/** One control decision. `stop` is one bounded attempt a live owner may
 *  repeat; `end` retries until an unattended container is empty; `release`
 *  leaves the work running until its natural exit; `own` is a new owner that
 *  took a released container, so settlement waits for it again. A stop or an
 *  end carries the cause of its trigger, which the emptying it starts names. */
type SupervisorRequest =
  | { readonly kind: "stop"; readonly cause: TerminationCause }
  | { readonly kind: "end"; readonly cause: TerminationCause }
  | { readonly kind: "release" }
  | { readonly kind: "own" }

export interface CommandSupervisorHost {
  /** True once the launcher admitted the container. False when it refused or
   *  died first, in which case the payload must never run. */
  admission(): Promise<boolean>
  /** Establishes every required host scheduling policy before payload spawn. */
  establishPriority(): boolean
  /** Returns each control decision in order. */
  nextRequest(): Promise<SupervisorRequest>
  /** Starts the payload inside this container, on the launcher's own stream
   *  handles. */
  start(): SupervisedTarget
  /** The container this process leads, which the payload's own exit
   *  settles. */
  readonly container: ManagedContainer
  /** What a stop or an end reaches: the container, and every process the
   *  command started that left it. */
  readonly ending: ManagedContainer
  sleep(ms: number): Promise<void>
}

export interface CommandSupervisorOutcome {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

export async function runCommandSupervisor(
  host: CommandSupervisorHost,
  killGraceMs: number,
  onPayloadExit?: "end-descendants",
): Promise<CommandSupervisorOutcome> {
  if (!(await host.admission())) return { code: OWNERSHIP_REFUSED_EXIT_CODE, signal: null }
  if (!host.establishPriority()) return { code: OWNERSHIP_REFUSED_EXIT_CODE, signal: null }
  const target = host.start()
  let pendingRequest = host.nextRequest()
  let targetExited = false
  let mode: "owned" | "ending" | "released" = "owned"
  let stopAttempted = false
  let settlementPending = false
  // Why the container is being emptied, for its termination decisions.
  let endingCause: TerminationCause = { reason: "payload exited" }
  // Default natural exit settles the group alone. Strict natural exit and
  // an owner's stop or end also reach marked detached descendants.
  let ended = false
  // An emptying that did not settle changes nothing: the container stays
  // owned. Its streak is recorded once, and the repeats count until the
  // container settles or the supervisor reports.
  const unsettled = unsettledEmptyingStreak(log, "the supervisor")
  try {
    for (;;) {
      if (!settlementPending || mode === "owned") {
        const event = await Promise.race([
          ...(targetExited ? [] : [target.exited.then(() => ({ source: "target" as const }))]),
          pendingRequest.then((request) => ({ source: "control" as const, request })),
        ])
        if (event.source === "target") {
          targetExited = true
          settlementPending = true
          if (onPayloadExit === "end-descendants") {
            ended = true
            mode = "ending"
          }
        } else {
          const request = event.request
          if (request.kind === "own") {
            if (mode === "released") mode = "owned"
            pendingRequest = host.nextRequest()
            continue
          }
          if (request.kind === "release") {
            // A persistent owner that releases after an unsettled explicit stop
            // gives up management rather than turning that stop into an
            // unattended termination loop.
            if (stopAttempted) return { code: target.exitCode, signal: target.signalCode }
            mode = "released"
          } else {
            endingCause = request.cause
            ended = true
            settlementPending = true
            if (request.kind === "end") mode = "ending"
            else stopAttempted = true
          }
          pendingRequest = host.nextRequest()
        }
        if (!settlementPending) continue
      } else {
        await host.sleep(RELEASED_SETTLEMENT_RETRY_MS)
      }
      const settlement = await emptyContainers([ended ? host.ending : host.container], killGraceMs, host.sleep, endingCause)
      if (settlement.kind === "unsettled") {
        unsettled.observe({ remaining: settlement.remaining, mode, reason: endingCause.reason })
        settlementPending = true
        continue
      }
      if (!targetExited) {
        await target.exited
        targetExited = true
      }
      return { code: target.exitCode, signal: target.signalCode }
    }
  } finally {
    unsettled.end()
  }
}

/** Runs this role on the real process. Never returns: the payload's status is
 *  reported as this process's own status, signal included. */
export async function runCommandSupervisorMain(argv: readonly string[]): Promise<never> {
  let outcome: CommandSupervisorOutcome
  try {
    const parsed = parseCommandSupervisorArgv(argv)
    outcome = await superviseCommand(parsed, await processSupervisorPlatform(parsed))
  } catch (err) {
    if (!diagnosticsSuppressed) {
      if (!payloadMayHaveStarted) fs.writeSync(2, `flywheel: ${errorMessage(err)}\n`)
      else log.error("command supervisor failed", { error: err })
    }
    await closeDiagnostics()
    process.exit(LAUNCH_FAILED_EXIT_CODE)
  }
  if (outcome.signal) {
    // The container's status is the payload's status: a payload killed by a
    // signal is reported by dying of that signal here, which is the only way
    // `signalCode` survives the hop to the launcher. The re-raise reports a
    // status and decides nothing, so it is no termination decision: one here
    // would name a decision for a payload that something outside Flywheel
    // killed.
    process.removeAllListeners(outcome.signal)
    log.debug("re-raise payload exit signal", { signal: outcome.signal })
    await closeDiagnostics()
    process.kill(process.pid, outcome.signal)
    await Bun.sleep(SIGNAL_REPORT_MS)
  }
  await closeDiagnostics()
  process.exit(outcome.code ?? 0)
}

/** The process a supervisor runs in, as the supervision needs it. The real
 *  one reads the launcher's channel, the kernel and the process's signals; a
 *  test supplies its own. */
export interface SupervisorPlatform {
  /** The launcher's channel, one word per call, and undefined once the
   *  launcher is gone and holds nothing. */
  nextLauncherWord(): Promise<string | undefined>
  /** Calls `listener` with the signal of each stop a signal asked for,
   *  including a signal that arrived before the listener did. */
  onStopSignal(listener: (signal: NodeJS.Signals) => void): void
  /** Watches the guardian a container depends on and reports its loss once,
   *  with the proof. The answer stops the watch. */
  watchGuardian(guardian: WatchedGuardian, onLost: (proof: TerminationCause) => void): () => void
  /** Serves the channel a handover names, and hands each connection to
   *  `accept`. Throws when the channel cannot be served. */
  serveChannel(address: string, accept: (connection: LineConnection) => void): LineServer
  /** Declares the build this process runs live in the account at
   *  `userDataRoot`, until the answer withdraws the declaration. */
  registerLiveBuild(userDataRoot: string): Promise<() => void>
  /** Silences every diagnostic this process writes to its inherited streams,
   *  which belong to a launcher that may be gone. */
  suppressDiagnostics(): void
  /** The identity of this process's container as its platform reads one, for
   *  the handover record; undefined where none could be read. */
  containerIdentity(): string | undefined
  establishPriority(): boolean
  /** Starts the payload inside this container, on the launcher's own output
   *  handles. `held` gives the payload a stdin this process holds and never
   *  writes, so no launcher's exit ends it. `ignore` gives the payload EOF. */
  start(stdin: "inherit" | "held" | "ignore"): SupervisedTarget
  readonly container: ManagedContainer
  /** What a stop or an end reaches (see `CommandSupervisorHost`). */
  readonly ending: ManagedContainer
  sleep(ms: number): Promise<void>
}

/** A guardian as a container names it: its pid, and the creation identity the
 *  launcher read for it. */
interface WatchedGuardian {
  readonly pid: number
  readonly identity: string
}

/** The cause of a controller's stop word, whichever controller sent it. */
const STOP_WORD_CAUSE: TerminationCause = { reason: "stop requested" }

/** Supervises one command: turns the words of its channels, the guardian's
 *  watch and the process's signals into the requests the container loop
 *  answers.
 *
 *  A container has at most one controller: the launcher, or an owner that
 *  adopted it after a handover. A controller can stop the container or hand
 *  it over, and the end of its channel ends a guarded container. A handover
 *  is the one exception: the end of a channel whose controller handed the
 *  container over is a release. Between that release and an adoption the
 *  supervisor holds the command alone. It watches no guardian, because the
 *  guardian that backed the old owner is no promise to anyone, and it ends
 *  the container itself at the recorded deadline. */
export async function superviseCommand(parsed: CommandSupervisorArgv, platform: SupervisorPlatform): Promise<CommandSupervisorOutcome> {
  const pendingRequests: SupervisorRequest[] = []
  const requestWaiters: Array<(request: SupervisorRequest) => void> = []
  const request = (value: SupervisorRequest): void => {
    const waiter = requestWaiters.shift()
    if (waiter) waiter(value)
    else pendingRequests.push(value)
  }
  const handoverAdmitted = parsed.lifetime === "guarded" && parsed.handover === true
  type Controller = "launcher" | LineConnection
  let controller: Controller | undefined = "launcher"
  /** The controller that handed the container over: its end is a release. */
  let releasing: Controller | undefined
  /** The one connection the handover channel holds. */
  let peer: LineConnection | undefined
  let stopRequested = false
  let ending = false
  let deadlineExpired = false
  let cancelDeadline = (): void => {}
  let guardian: WatchedGuardian | undefined = parsed.lifetime === "guarded" ? { pid: parsed.guardianPid, identity: parsed.guardianIdentity } : undefined
  let cancelGuardianWatch = (): void => {}
  let handedOver: { readonly recordPath: string; readonly handedOverAtMs: number; readonly supervisorIdentity?: string } | undefined
  let server: { readonly address: string; readonly served: LineServer } | undefined
  let withdrawLiveBuild: (() => void) | undefined

  /** Watches `watched`, and no other guardian, from now on. */
  const watch = (watched: WatchedGuardian | undefined): void => {
    cancelGuardianWatch()
    guardian = watched
    cancelGuardianWatch = watched === undefined ? () => {} : platform.watchGuardian(watched, end)
  }
  const end = (cause: TerminationCause): void => {
    ending = true
    watch(undefined)
    request({ kind: "end", cause })
  }
  const stop = (cause: TerminationCause): void => {
    stopRequested = true
    request({ kind: "stop", cause })
  }
  const armDeadline = (deadlineAtMs: number): void => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const arm = (): void => {
      const remainingMs = Math.max(0, deadlineAtMs - Date.now())
      timer = setTimeout(remainingMs > MAX_TIMER_MS ? arm : () => {
        deadlineExpired = true
        // No evidence: a handed-over supervisor's diagnostics are silenced.
        end({ reason: "handover deadline passed" })
      }, Math.min(remainingMs, MAX_TIMER_MS))
    }
    arm()
    cancelDeadline = () => { clearTimeout(timer) }
  }
  const channelEnded = (who: Controller): void => {
    if (who !== controller) return
    controller = undefined
    // A controller that handed the container over and asked for no stop since
    // leaves it running, as the owner of a persistent container always does.
    // Every other end is the owner of a guarded container leaving, which ends
    // the container.
    if ((releasing === who && !stopRequested) || parsed.lifetime !== "guarded") request({ kind: "release" })
    else end({ reason: "controller channel ended" })
  }

  /** Enters the handed-over lifetime, and acknowledges the word by writing
   *  the record only once everything it promises holds. A handover that
   *  cannot complete leaves the container with its controller, which reads
   *  the missing record as no acknowledgement. */
  const handOver = async (from: Controller, handover: CommandHandover): Promise<void> => {
    if (!handoverAdmitted || from !== controller || stopRequested || ending) return
    const previousGuardian = guardian
    const startedServer = server === undefined || server.address !== handover.channel
    watch(undefined)
    try {
      if (startedServer) {
        server?.served.stop()
        server = undefined
        server = { address: handover.channel, served: platform.serveChannel(handover.channel, accept) }
      }
      withdrawLiveBuild ??= await platform.registerLiveBuild(handover.userDataRoot)
      if (stopRequested || ending || from !== controller) throw new Error("the command was stopped while it was being handed over")
      cancelDeadline()
      if (handover.deadlineAtMs !== undefined) armDeadline(handover.deadlineAtMs)
      platform.suppressDiagnostics()
      const supervisorIdentity = platform.containerIdentity()
      const record = { recordPath: handover.recordPath, handedOverAtMs: Date.now(), ...(supervisorIdentity === undefined ? {} : { supervisorIdentity }) }
      writeOutcomeRecord(record.recordPath, { version: 1, handedOverAtMs: record.handedOverAtMs, ...(supervisorIdentity === undefined ? {} : { supervisorIdentity }) })
      handedOver = record
      releasing = from
    } catch (err) {
      log.warn("command handover did not complete; the command stays with its owner", { error: errorMessage(err) })
      cancelDeadline()
      if (startedServer && handedOver === undefined) {
        server?.served.stop()
        server = undefined
      }
      if (!ending) watch(previousGuardian)
    }
  }

  const adopt = (connection: LineConnection, adoption: CommandAdoption): void => {
    if (handedOver === undefined || ending || controller === connection) return
    // The adopting owner enforces the rest of the deadline from now on.
    cancelDeadline()
    watch({ pid: adoption.guardianPid, identity: adoption.guardianIdentity })
    controller = connection
    releasing = undefined
    request({ kind: "own" })
    connection.say(encodeSupervisorAnswer({ kind: "adopted" }))
  }

  const accept = (connection: LineConnection): void => {
    if (peer !== undefined) {
      connection.close()
      return
    }
    peer = connection
    void (async () => {
      for (let line = await connection.next(); line !== undefined; line = await connection.next()) {
        const word = decodeSupervisorWord(line)
        if (word.kind === "adopt") adopt(connection, word.adoption)
        else if (word.kind === "unknown" && word.word === "adopt") connection.say(encodeSupervisorAnswer({ kind: "refused", versions: [COMMAND_CHANNEL_VERSION] }))
        else if (word.kind === "stop" && connection === controller) {
          // A guarded owner's stop ends ownership even while its channel
          // stays open to observe settlement.
          stopRequested = true
          end(STOP_WORD_CAUSE)
        } else if (word.kind === "handover") await handOver(connection, word.handover)
      }
      peer = undefined
      channelEnded(connection)
    })()
  }

  // A stop signal is a request, not a death: this process runs the escalation
  // that answers it and reports the payload's status afterwards.
  platform.onStopSignal((signal) => { stop({ reason: "stop signal received", evidence: { signal } }) })
  watch(guardian)
  const outcome = await runCommandSupervisor({
    async admission() {
      const first = await platform.nextLauncherWord()
      return first !== undefined && decodeSupervisorWord(first).kind === "go"
    },
    establishPriority: () => platform.establishPriority(),
    nextRequest: () => {
      const ready = pendingRequests.shift()
      return ready === undefined
        ? new Promise<SupervisorRequest>((resolve) => { requestWaiters.push(resolve) })
        : Promise.resolve(ready)
    },
    start() {
      const startedAtMs = performance.now()
      const target = platform.start(parsed.lifetime === "guarded" && parsed.stdin === "ignore" ? "ignore" : handoverAdmitted ? "held" : "inherit")
      // A record must never change how a command ends: a usage the platform
      // cannot read leaves the record out instead of failing this process.
      void target.exited
        .then(() => { recordPayloadExit(parsed.command, target, performance.now() - startedAtMs) })
        .catch((err: unknown) => { log.debug("payload usage unreadable", { error: errorMessage(err) }) })
      // Read once the payload runs, so every later word addresses a running
      // command. A word sent earlier waits in the channel until then.
      void (async () => {
        for (let line = await platform.nextLauncherWord(); line !== undefined; line = await platform.nextLauncherWord()) {
          const word = decodeSupervisorWord(line)
          if (word.kind === "stop" && controller === "launcher") {
            if (parsed.lifetime === "guarded") {
              stopRequested = true
              end(STOP_WORD_CAUSE)
            } else stop(STOP_WORD_CAUSE)
          } else if (word.kind === "handover") await handOver("launcher", word.handover)
        }
        channelEnded("launcher")
      })()
      return target
    },
    container: platform.container,
    // A stop or an end is an owner's decision, and the launch's stop hold
    // defers its first signal. A payload that exits by itself needs no hold.
    ending: parsed.lifetime === "guarded" && parsed.stopHold !== undefined ? { ...platform.ending, stopHold: parsed.stopHold } : platform.ending,
    sleep: (ms) => platform.sleep(ms),
  }, parsed.killGraceMs, parsed.lifetime === "guarded" ? parsed.onPayloadExit : undefined)
  cancelDeadline()
  watch(undefined)
  // Recorded before the channel closes, so an owner that reads the end of the
  // channel as the command's end finds the outcome already there.
  if (handedOver !== undefined) {
    try {
      const { recordPath, ...acknowledged } = handedOver
      writeOutcomeRecord(recordPath, {
        version: 1,
        ...acknowledged,
        outcome: { code: outcome.code, signal: outcome.signal, deadlineExpired, endedAtMs: Date.now() },
      })
    } catch (err) {
      // A record that cannot be written reads as a supervisor that ended
      // without one, which is the truth the owner can act on.
      log.warn("command outcome could not be recorded", { error: errorMessage(err) })
    }
  }
  server?.served.stop()
  withdrawLiveBuild?.()
  return outcome
}

/** One record per payload, written when it exits: what it used, how long it
 *  ran, and how it ended. It is per command, so it is DEBUG. It names the
 *  payload by its executable's file name alone, which tells a provider engine
 *  (`claude`) apart from a tool's shell (`bash`, `powershell`) or its guard
 *  (`sandbox-exec`, `bwrap`) and carries no argument or path. */
function recordPayloadExit(command: readonly string[], target: SupervisedTarget, wallMs: number): void {
  log.debug("payload exited", {
    kind: win32.basename(command[0] ?? "").replace(/\.exe$/i, ""),
    wallMs: Math.round(wallMs * 10) / 10,
    ...target.usage(),
    ...(target.exitCode === null ? {} : { exitCode: target.exitCode }),
    ...(target.signalCode === null ? {} : { signal: target.signalCode }),
  })
}

/** Set once this process's diagnostics are silenced, so a failure after that
 *  writes nothing to a stream that belongs to a launcher that may be gone. */
let diagnosticsSuppressed = false

/** The real process: where this supervisor's control channel and container
 *  come from, which is the only thing that differs between the platforms.
 *
 *  POSIX inherits the channel as a descriptor and leads its container by being
 *  the process the group is named after. Windows can inherit no such
 *  descriptor, so it connects to a named pipe, and its container is a job
 *  object it opens by name. The end of the channel means the same on both: the
 *  launcher is gone and holds nothing. */
async function processSupervisorPlatform(parsed: CommandSupervisorArgv): Promise<SupervisorPlatform> {
  let stopListener: ((signal: NodeJS.Signals) => void) | undefined
  const earlyStops: NodeJS.Signals[] = []
  const onStop = (signal: NodeJS.Signals): void => {
    if (stopListener) stopListener(signal)
    else earlyStops.push(signal)
  }
  for (const signal of ["SIGINT", "SIGHUP"] as const) process.on(signal, () => { onStop(signal) })
  // TERM is answered by the platform once it is known, because on POSIX this
  // process also receives the TERM its own escalation sends. Until then no
  // escalation has run, so every TERM is a stop.
  let onTerm = (): void => { onStop("SIGTERM") }
  process.on("SIGTERM", () => { onTerm() })
  let channel: Pick<SupervisorPlatform, "nextLauncherWord" | "container" | "ending" | "containerIdentity"> & {
    readonly guardian: GuardianReads
    /** Lets the children of this container's members leave it, for a job
     *  whose payload starts its commands' containers. False when it could
     *  not. */
    readonly letChildrenLeave?: () => boolean
  }
  if (parsed.container.kind === "job") {
    const { token, childrenBreakAway } = parsed.container
    const launcher = await connectLines(windowsControlChannelName(token))
    await initializeDiagnostics((line) => { launcher?.say(line.trimEnd()) })
    closeDiagnostics = async () => {
      launcher?.close()
      await launcher?.closed
    }
    // Opened once and held for this process's whole life. The handle keeps
    // the container alive while every other holder closes its own, which is
    // what carries a handed-over command past its launcher's exit.
    const opened = windowsJobApi()?.open(windowsContainerName(token))
    const job = opened?.kind === "opened" ? opened.job : undefined
    const container = ownWindowsJobContainer(job)
    channel = {
      // A channel that cannot be reached at all is already over, which the
      // admission reads as ownership never granted.
      nextLauncherWord: () => launcher?.next() ?? Promise.resolve(undefined),
      // Members are ended one at a time, so no TERM of this process's own
      // reaches it, and every TERM it receives is a request.
      container,
      // A job holds every process its members start.
      ending: container,
      guardian: windowsGuardianReads,
      // A job's name is its identity: it is made once under a token that is
      // never used again.
      containerIdentity: () => token,
      ...(childrenBreakAway === true ? { letChildrenLeave: () => job?.letChildrenLeave() === true } : {}),
    }
  } else {
    await initializeDiagnostics((line) => {
      try {
        fs.writeSync(SUPERVISOR_CONTROL_FD, line)
      } catch {
        // A released persistent owner has no reader. Retire this transport,
        // and give this process's records no other destination after it.
        diagnosticsSuppressed = true
        Log.suppress()
      }
    })
    const group = ownGroupSignals(ownUnixContainer(), () => { onStop("SIGTERM") })
    onTerm = group.onTerm
    const mark = ownContainerMark()
    channel = {
      nextLauncherWord: streamLines(Bun.file(SUPERVISOR_CONTROL_FD).stream()),
      container: group.container,
      ending: mark === undefined ? group.container : markedContainer(group.container, process.pid, mark),
      guardian: posixGuardianReads,
      containerIdentity: () => {
        const identity = unixContainerIdentity(process.pid)
        return identity.kind === "container" ? identity.identity : undefined
      },
    }
  }
  const heldStreams: unknown[] = []
  return {
    nextLauncherWord: channel.nextLauncherWord,
    onStopSignal(listener) {
      stopListener = listener
      for (const signal of earlyStops.splice(0)) listener(signal)
    },
    watchGuardian: (guardian, onLost) => watchGuardian({ ...guardian, ...channel.guardian, onLost }),
    serveChannel: serveLines,
    async registerLiveBuild(userDataRoot) {
      // Loaded only here: the registry reads build metadata through a schema
      // library that no command that is never handed over should pay for.
      const { registerLiveBuild } = await import("./update/live-builds.js")
      return registerLiveBuild(userDataRoot)
    },
    suppressDiagnostics() {
      if (diagnosticsSuppressed) return
      diagnosticsSuppressed = true
      Log.suppress()
    },
    containerIdentity: channel.containerIdentity,
    establishPriority: () => establishProcessPriority(parsed.priority),
    start(stdin) {
      // The payload is this process's ordinary child, so it starts in this
      // process's container, and in the job this process's runtime keeps for
      // its children, before its first instruction runs. No moment exists
      // where it runs with no owner: if this process dies, that runtime job
      // ends the payload with it.
      const target = Bun.spawn({
        cmd: [...parsed.command],
        stdio: [stdin === "held" ? "pipe" : stdin, "inherit", "inherit"],
        windowsHide: true,
      })
      // Set only once the spawn returned: a program that is missing makes the
      // spawn throw, and that launch never happened, so it reports itself on
      // the payload's stderr with the failed-launch status, not as a failure
      // of this supervisor.
      payloadMayHaveStarted = true
      // Held for the payload's whole life: a stdin nobody references can be
      // collected and closed, which the payload would read as its end.
      heldStreams.push(target.stdin)
      // The container lets children leave only once the payload is in it,
      // because a container that already lets them leave does not take the
      // payload either.
      if (channel.letChildrenLeave !== undefined && !channel.letChildrenLeave()) {
        recordTermination({ container: process.pid, target: target.pid, signal: "SIGKILL", reason: "the payload's container could not let its children leave" })
        target.kill("SIGKILL")
      }
      return {
        exited: target.exited.then(() => undefined),
        get exitCode() { return namedExitStatus(target.exitCode, target.signalCode).code },
        get signalCode() { return namedExitStatus(target.exitCode, target.signalCode).signal },
        usage() {
          const usage = target.resourceUsage()
          if (usage === undefined) return undefined
          // Bun reports CPU time in microseconds, as a bigint on macOS and
          // Linux although its types say number, and the peak in bytes on
          // both.
          return {
            cpuUserMs: Math.round(Number(usage.cpuTime.user) / 100) / 10,
            cpuSystemMs: Math.round(Number(usage.cpuTime.system) / 100) / 10,
            maxProcessRssBytes: usage.maxRSS,
          }
        },
      }
    },
    container: channel.container,
    ending: channel.ending,
    sleep: (ms) => Bun.sleep(ms),
  }
}

let payloadMayHaveStarted = false
let closeDiagnostics: () => Promise<void> = async () => {}

async function initializeDiagnostics(write: (line: string) => void): Promise<void> {
  // Every record goes to the launcher, whose own log level decides which it
  // writes. This process cannot decide: it runs in its payload's environment,
  // and a provider engine's environment carries no Flywheel log level.
  await Log.init({
    level: "DEBUG",
    forward(record) {
      if (diagnosticsSuppressed) return
      const line = formatDebugLogLine(record)
      if (line !== null) write(line)
    },
  })
  const terminationLog = Log.create({ service: "process-termination" })
  onTermination((decision) => { terminationLog.info("termination requested", { ...decision }) })
}

interface OwnGroupSignals {
  readonly container: ManagedContainer
  /** Answers a TERM this process received. */
  readonly onTerm: () => void
}

/** Tells the TERM this supervisor sends its own process group apart from a
 *  request to stop.
 *
 *  The escalation sends TERM to the whole group, and the group includes this
 *  process. That TERM is not a request: this process is already running the
 *  escalation a stop would ask for. Read as one, it would count a stop the
 *  owner never sent, which starts a second escalation and turns a later
 *  release into giving up a container that is still being emptied.
 *
 *  One mark is enough because at most one TERM of this process's own is
 *  outstanding at a time: each escalation sends one TERM and yields to the
 *  event loop, where that TERM is answered, before any later escalation can
 *  send another. This holds only while the kill grace is greater than 0
 *  (production uses 5000 ms), because the escalation yields in the wait that
 *  grace allows between TERM and KILL. */
export function ownGroupSignals(group: ManagedContainer, onStop: () => void): OwnGroupSignals {
  let ownTermPending = false
  return {
    container: {
      signal: (signal, cause) => {
        if (signal === "SIGTERM") ownTermPending = true
        group.signal(signal, cause)
      },
      populated: () => group.populated(),
    },
    onTerm: () => {
      if (!ownTermPending) {
        onStop()
        return
      }
      ownTermPending = false
    },
  }
}

if (import.meta.main) {
  // Only a source run starts this module directly: a packaged build enters
  // the supervisor through its role. A launch that races the lock of the
  // supervisor's bundle, or follows a lock that failed, runs this module from
  // the snapshot of the dev service that launches it, so it holds that
  // snapshot as every process that runs from one does (ARCH-DISTRIBUTION-030).
  const { runningSourceSnapshot } = await import("./cli-subprocess.js")
  if (runningSourceSnapshot() !== undefined) (await import("./source-snapshot.js")).holdRunningSnapshot()
  await runCommandSupervisorMain(process.argv)
}
