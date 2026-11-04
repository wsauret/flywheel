import { fileURLToPath } from "node:url"
import { DebugLog, resolveDebugLogDirectory } from "../../infra/debug-log.js"
import { errorMessage } from "../../infra/error-message.js"
import type { CapacityContinuation } from "./capacity-wait-continuation.js"
import { createExecutorLifecycleRequests } from "./executor-lifecycle-requests.js"
import { isStorageFailure } from "../../infra/storage-failure.js"
import { Log } from "../../infra/log.js"
import type { LoginShellPath } from "../../infra/login-shell-path.js"
import { watchContainerTerminations, type ContainerTerminations } from "../../infra/process-container.js"
import { createProcessDiagnosticReader, relayProcessDiagnostic, SUPERVISOR_RECORD_SERVICES } from "../../infra/process-diagnostic-reader.js"
import { durationMs } from "../../infra/operation-log.js"
import { coalesceRepeats } from "../../infra/repeat-coalescer.js"
import { runsThroughBun } from "../../infra/cli-subprocess.js"
import type { StartupDirectories } from "../../infra/directory-authorities.js"
import { EXECUTABLE_ROLES } from "../../infra/executable-roles.js"
import { listenInternalProcessChannel, type InternalProcessChannelServer, type InternalProcessEndpoint } from "../../infra/internal-process-channel.js"
import { serveOwnedProcessBridge, type OwnedProcessBridge } from "../../infra/owned-process-bridge.js"
import type { GuardianGeneration, GuardianLoss, LauncherContext, OwnershipClosure } from "../../infra/process-supervisor.js"
import { createReattachableProcessEndpoint, type ReattachableProcessEndpoint } from "../../infra/reattachable-process-endpoint.js"
import { startupTrace } from "../../infra/startup-trace.js"
import { withDeadline } from "../../infra/with-deadline.js"
import { createInternalProcessSubchannel } from "../../infra/internal-process-subchannel.js"
import { servePersistentProcessBridge } from "../../infra/persistent-process-bridge.js"
import type { PersistentProcessManager } from "../../infra/persistent-process-manager.js"
import type { RuntimeChatDefault, RuntimeClient } from "../../protocol/app-service-types.js"
import { sameBlockers, type ReplacementBlocker } from "./replacement-blockers.js"
import type { ReplacementState } from "./replacement-owner.js"
import { PROJECT_EXECUTOR_STOP_DEADLINE_MS } from "./runtime-shutdown.js"
import { watchExecutorResponsiveness, type ExecutorWedgeProof } from "./executor-responsiveness.js"
import { executorStopSignalOf } from "./executor-stop-signals.js"
import { connectProjectExecutionChannel, type ProjectExecutionClient } from "./project-execution-channel.js"
import { serveProjectStateChannel } from "./project-state-channel.js"
import { serveProjectNotifyChannel } from "./project-notify-channel.js"
import type { ProcessorAdmission } from "./processor-governor.js"
import type { NotificationEpisodeInput } from "../../infra/notification-episode.js"
import type { ProjectStateClient } from "./project-state-client.js"
import {
  createProjectExecutorAuthenticator,
  createProjectExecutorChannelSet,
  projectExecutorChannelLimits,
  PROJECT_EXECUTOR_REATTACH_DEADLINE_MS,
  EXECUTOR_HEARTBEAT_INTERVAL_MS,
  decodeProjectExecutorCredential,
  decodeProjectExecutorEvent,
  encodeProjectExecutorInitialization,
  type ProjectExecutorInitialization,
  type ProjectExecutorEndpointKind,
  type SuccessorRows,
} from "./project-executor-protocol.js"

/** How much of the executor's most recent output an unexpected exit logs. */
const EXECUTOR_OUTPUT_TAIL_CHARS = 8_192
/** How long an unexpected exit waits for the executor's last output. */
const EXECUTOR_OUTPUT_SETTLE_MS = 1_000
/** How long one blockers read waits for its request's send and its answer
 *  together. A read that misses it answers the latest list instead. */
const BLOCKERS_READ_MS = 1_500
/** How long a start waits before its one slow-start record. The record
 *  changes nothing: no start step has a deadline. */
const EXECUTOR_START_SLOW_MS = 10_000
/** How long one generation's channel detach episodes collect repeats. */
const DETACH_EPISODE_WINDOW_MS = 60 * 60_000
/** One episode's first detach: the channel that went first and why. */
interface ChannelDetach {
  readonly kind: ProjectExecutorEndpointKind
  readonly reason: string
}
/** Services whose records on the executor's output this process relays at
 *  the level their writer gave them: every record the executor's command
 *  supervisor writes, and the executor's own process supervisor's records
 *  from before its log opened. */
const RELAYED_SERVICES: ReadonlySet<string> = new Set([...SUPERVISOR_RECORD_SERVICES, "process-supervisor"])

/** Re-enters this build, never an installed launcher that can select a different build. */
export function projectExecutorCommand(execPath = process.execPath): readonly string[] {
  return [
    ...(runsThroughBun(execPath)
      ? [execPath, "--conditions=browser", fileURLToPath(new URL("../../../scripts/project-executor.ts", import.meta.url))]
      : [execPath]),
    EXECUTABLE_ROLES.projectExecutor,
  ]
}

/** The signals by which a process crashes on its own. Every other signal
 *  that ends an executor was sent to it from outside. */
const CRASH_SIGNALS: ReadonlySet<string> = new Set(["SIGSEGV", "SIGBUS", "SIGILL", "SIGFPE", "SIGABRT", "SIGTRAP", "SIGSYS"])

/** How one executor generation ended: its ownership closure, and the cause in
 *  plain words a person can read, such as "stopped by signal SIGKILL" or
 *  "could not start". A cause completes the sentence "Flywheel's process for
 *  this project ...". Ids, measurements, and internal errors go in the log
 *  fields of the record that states the cause, never in the cause. */
type ProjectExecutorGenerationEnd = OwnershipClosure & { readonly cause: string }

/** How a stop the account asked for ended: the ownership closure, and,
 *  after a planned replacement's cut, the rows the handoff holds in the
 *  project for the successor. A stop that did not answer counts nothing. */
export type ProjectExecutorStop = OwnershipClosure & { readonly successorRows?: SuccessorRows }

/** What registers to wait for the serving generation to answer: a person's
 *  interrupt of a session, or a successor's continuation handoff. */
export type ProjectExecutorWaiter =
  | { readonly kind: "interrupt"; readonly sessionId?: string }
  | { readonly kind: "continuation" }

/** What waited for an executor to answer when the account ended it as
 *  wedged: a registered waiter, or, without a registration, the
 *  generation's own start or a requested replacement. */
export type ExecutorWedgeWaiter = ProjectExecutorWaiter["kind"] | "start" | "replacement"

/** Structured detail for the log record of a generation's end: what a
 *  person never reads in the cause. */
interface ProjectExecutorEndDetail {
  readonly channel?: ProjectExecutorEndpointKind
  readonly error?: string
  readonly code?: number | null
  readonly signal?: string
  /** How long the executor sent no heartbeat before the account ended it. */
  readonly silentMs?: number
  /** The heartbeat periods in a row the account observed with no heartbeat. */
  readonly missedPeriods?: number
  /** What waited for the executor to answer when the account ended it. */
  readonly waitedBy?: readonly ExecutorWedgeWaiter[]
  /** The sessions whose interrupt waited on the end; their recovery records it. */
  readonly interruptedSessionIds?: readonly string[]
  /** The process guardian whose exit ended the generation, as the kernel
   *  reported it. Its code, signal, and channel are the guardian's, never the
   *  executor's. */
  readonly guardian?: GuardianLoss
}

export interface ProjectExecutorClient {
  /** Resolves once the executor reports ready, however long its start takes.
   *  Rejects when the generation ends first. */
  readonly ready: Promise<RuntimeClient & Pick<ProjectExecutionClient, "hideSession"> & Partial<Pick<ProjectExecutionClient, "onOutputGap" | "watchOutput">>>
  /** Starts deferred model resolution after the account subscribes to output.
   *  The generation starts it once; a later call joins that start. */
  startChatDefault(): Promise<void>
  /** What this generation owns that is live, each with the reason that
   *  says whether it delays a replacement; empty means idle. Answers within
   *  one bound, and a concurrent read joins the read in flight. A read the
   *  executor misses or cannot do answers the latest list the generation
   *  reported, or undefined while it has reported none. */
  blockers(): Promise<readonly ReplacementBlocker[] | undefined>
  /** Tells the executor the account's replacement state. */
  setReplacement(state: ReplacementState): Promise<void>
  /** Told when the executor reports, unasked, that its blockers changed, and
   *  when an answer that came after its read missed changed the latest list. */
  onBlockersChanged(listener: () => void): () => void
  /** Sends one half of a planned replacement's handoff and resolves with the
   *  sessions the executor interrupted or resumed. It waits as long as the
   *  work takes, and rejects when the executor reports a failure or the
   *  generation ends first. */
  handoff(kind: "interrupt_for_replacement" | "continue_after_replacement", handoffId: string): Promise<readonly string[]>
  /** Asks the executor to continue every due capacity wait no run of it
   *  holds (`CapacityContinuation`). Rejects as `handoff` does. */
  continueCapacityWaits(): Promise<CapacityContinuation>
  /** Asks the executor to flush and stop, telling it whether a client holds
   *  the project now, and waits up to the stop deadline, measured from the
   *  call, for the request and the answer together. Resolves unsettled when
   *  the executor did not flush, whatever the ownership closure that followed. */
  stop(): Promise<ProjectExecutorStop>
  /** Ends the generation for the stated cause. Does not depend on executor
   *  JavaScript making progress. */
  terminate(cause: string, detail?: ProjectExecutorEndDetail): Promise<ProjectExecutorGenerationEnd>
  /** Told once, synchronously, the moment the generation begins to end, with
   *  its cause and whether the executor process ended by itself: its own
   *  exit, a crash signal, or a failure it reported, at its start too. A
   *  stop the account asked for, another signal, a lost guardian or channel,
   *  and an error on the account's side are not the executor's own end. A
   *  listener added later is told at once. From then on the generation
   *  serves nothing, whatever its closure still has to settle. */
  onEnding(listener: (cause: string, own: boolean) => void): () => void
  /** Proves again, through the guardian and the launcher, whether the
   *  containers of an ended generation are gone, and resolves with that fresh
   *  closure. An ended generation whose closure was unsettled asks here
   *  before its recovery is retried; a settled closure is final. Concurrent
   *  calls join one proof. */
  settle(): Promise<OwnershipClosure>
  /** Tells `listener` at each check once the executor has sent no heartbeat
   *  for the wedge bound of periods in a row, counted from its launch: the
   *  only evidence on which the account may end an executor that still runs.
   *  Told through a stop as well, because the executor beats until its stop
   *  closes its channels; the owner that asked for the stop ends nothing on
   *  it. Never told for an executor that keeps answering, while its
   *  lifecycle channel is detached, or once it ends. Returns the function
   *  that stops it. */
  onWedged(listener: (proof: ExecutorWedgeProof) => void): () => void
  readonly closed: Promise<ProjectExecutorGenerationEnd>
}

/** The ownership closure a generation end carries, without its cause. */
function ownership(end: ProjectExecutorGenerationEnd): OwnershipClosure {
  return end.settled ? { settled: true } : { settled: false, reason: end.reason }
}

/** Startup failures carry the joined ownership result, so the account never
 * guesses whether a rejected acquisition left a live container. */
export class ProjectExecutorStartupError extends Error {
  constructor(cause: unknown, readonly closure: OwnershipClosure) {
    super(cause instanceof Error ? cause.message : String(cause), { cause })
    this.name = "ProjectExecutorStartupError"
  }
}

/** Account-owned admission. Paths are fresh private socket or named-pipe names for this generation.
 * Returns ownership synchronously, before admission. `ready` resolves to the callable runtime.
 * State and persistent-process ownership remain with the account.
 * No startup step has a deadline. Only the generation's failure ends a start: its exit, its failure
 * report, an admission refusal, a channel close, or an end its owner decides, such as the wedge proof.
 * Startup failure closes all admitted transports and settles the guardian and container before rejection. */
export function createProjectExecutorClient(input: {
  readonly admit: () => Promise<void>
  readonly projectId: string
  readonly projectLabel: string
  readonly generation: number
  readonly directories: StartupDirectories
  readonly endpoints: ProjectExecutorInitialization["endpoints"]
  readonly launcher: LauncherContext
  readonly state: ProjectStateClient
  readonly persistentProcesses: PersistentProcessManager
  /** Immutable command-line override the executor bootstraps with. */
  readonly allowPersistentProcesses: boolean
  /** Effective host policy, read at each persistent launch the executor requests. */
  readonly allowPersistentLaunch: () => Promise<boolean>
  readonly workerUrl: string
  readonly notify: (episode: NotificationEpisodeInput) => Promise<void>
  readonly chatDefault: () => RuntimeChatDefault
  /** The account process's login shell PATH, which every generation is told. */
  readonly loginShellPath: Pick<LoginShellPath, "watch" | "current" | "request">
  /** The account's one processor admission, which this generation reports
   *  its shell containers to and hears its held containers from. */
  readonly processorAdmission: ProcessorAdmission
  /** Told the earliest continue time of the project's capacity waits, or
   *  null for none, each time the generation reports it; resolves once the
   *  account store holds it, which the executor waits for. Absent in a
   *  composition no account serves. */
  readonly onCapacityWake?: (at: number | null) => Promise<void>
  /** Whether a client holds the project now. A stop sends it, so the
   *  executor keeps an empty chat for each tab that attaches it again. */
  readonly clientsHold: () => boolean
  /** The account's union of watched sessions, which the execution channel
   *  states again first each time its transport reattaches. */
  readonly watchedOutput: () => readonly string[]
  readonly listen?: typeof listenInternalProcessChannel
  readonly stopDeadlineMs?: number
  readonly reattachDeadlineMs?: number
  /** The period the executor sends its heartbeat in, which is also the
   *  period the account counts missed heartbeats in. Tests shorten it. */
  readonly heartbeatIntervalMs?: number
  /** The clock that every deadline, reattach wait, wedge watch, and the
   *  slow-start record of this generation read. Without one, the generation
   *  reads the system clock. */
  readonly clock?: { readonly now: () => number; readonly setTimer: (fire: () => void, delayMs: number) => () => void }
}): ProjectExecutorClient {
  const kinds = ["control", "state", "output", "lifecycle"] as const
  const stopDeadlineMs = input.stopDeadlineMs ?? PROJECT_EXECUTOR_STOP_DEADLINE_MS
  const reattachDeadlineMs = input.reattachDeadlineMs ?? PROJECT_EXECUTOR_REATTACH_DEADLINE_MS
  const heartbeatIntervalMs = input.heartbeatIntervalMs ?? EXECUTOR_HEARTBEAT_INTERVAL_MS
  const { clock } = input
  const now = clock?.now ?? Date.now
  const setTimer = clock?.setTimer ?? ((fire: () => void, delayMs: number): (() => void) => {
    const timer = setTimeout(fire, delayMs)
    timer.unref?.()
    return () => clearTimeout(timer)
  })
  const deadline = <T>(inner: Promise<T>, ms: number): Promise<T> =>
    withDeadline(inner, ms, clock ? { setTimer: (fire) => clock.setTimer(fire, ms) } : {})
  const log = Log.create({ service: "project-executor-client" }).with({ projectId: input.projectId, generation: input.generation })
  const authenticator = createProjectExecutorAuthenticator(input)
  const credentials = {
    control: authenticator.issue("control").credential,
    state: authenticator.issue("state").credential,
    output: authenticator.issue("output").credential,
    lifecycle: authenticator.issue("lifecycle").credential,
  }
  const init = encodeProjectExecutorInitialization({
    projectId: input.projectId, projectLabel: input.projectLabel, generation: input.generation,
    directories: input.directories, endpoints: input.endpoints, credentials,
    workerUrl: input.workerUrl, allowPersistentProcesses: input.allowPersistentProcesses, heartbeatIntervalMs,
  })
  const scope = input.launcher.scope.open({ priority: "background" })
  const servers: InternalProcessChannelServer[] = []
  const connections = new Set<InternalProcessEndpoint<unknown, unknown>>()
  const admitted = {
    control: Promise.withResolvers<InternalProcessEndpoint<unknown, unknown>>(),
    state: Promise.withResolvers<InternalProcessEndpoint<unknown, unknown>>(),
    output: Promise.withResolvers<InternalProcessEndpoint<unknown, unknown>>(),
    lifecycle: Promise.withResolvers<InternalProcessEndpoint<unknown, unknown>>(),
  }
  const failure = Promise.withResolvers<never>()
  void failure.promise.catch(() => {})
  const ready = Promise.withResolvers<void>()
  const listening = Promise.withResolvers<void>()
  const stopped = Promise.withResolvers<SuccessorRows | undefined>()
  void stopped.promise.catch(() => {})
  // Settles once the executor process is gone. The exit ends the generation
  // only while it is active, and Stop clears active first, so Stop watches
  // this itself: an executor that dies in the instant Stop is sent answers
  // nothing and reattaches nothing, and waiting for either only holds the
  // account's shutdown open. So the exit rejects, unless it is the end of the
  // Stop that waits for its answer, which it then answers with no rows.
  const exited = Promise.withResolvers<undefined>()
  void exited.promise.catch(() => {})
  let chatDefaultStart: Promise<void> | undefined
  let blockersRequestId = 0
  // The read in flight, which a concurrent read joins: the id of the request
  // it waits on, that request's answer, and the read itself.
  let blockersRead: {
    readonly id: number
    readonly reply: PromiseWithResolvers<readonly ReplacementBlocker[] | undefined>
    readonly read: Promise<readonly ReplacementBlocker[] | undefined>
  } | undefined
  // The latest list the generation reported: an answer, an answer that came
  // after its read missed, or an unasked report. The executor sends its lists
  // in the order it computes them, so the last to arrive is the newest.
  let latestBlockers: readonly ReplacementBlocker[] | undefined
  const blockersChanged = new Set<() => void>()
  const requests = createExecutorLifecycleRequests(input.onCapacityWake)
  const closed = Promise.withResolvers<ProjectExecutorGenerationEnd>()
  let endingCause: string | undefined
  let endingOwn = false
  let endingDetail: ProjectExecutorEndDetail = {}
  // The executor process ended by itself before the account decided its end:
  // it exited or crashed on its own, or reported a failure. Read by the end
  // that follows, which for a start is the one that could not start.
  let endedByItself = false
  // Whether the executor's end answers a Stop the account requested: the
  // executor said it stopped, or the Stop came before it was ready. Only such
  // an end, or an exit that ends a Stop still waiting for its answer, leaves
  // no exit record.
  let answersStop = false
  // When the account sent the executor its Stop, which waits for its answer.
  let stopAskedAt: number | undefined
  const endingListeners = new Set<(cause: string, own: boolean) => void>()
  let settling: Promise<OwnershipClosure> | undefined
  let proven = false
  const responsiveness = watchExecutorResponsiveness({ log, periodMs: heartbeatIntervalMs, now, setTimer })
  const disposers: (() => Promise<void>)[] = []
  let bridge: OwnedProcessBridge | undefined
  let guardianGeneration: GuardianGeneration | undefined
  let closing: Promise<ProjectExecutorGenerationEnd> | undefined
  let active = false
  // Whether the executor reported ready, after which its stop has work to save.
  let reportedReady = false
  let lifecycle: InternalProcessEndpoint<unknown, unknown> | undefined
  // The executor's own pid, as it reports it. The launcher knows only its
  // command supervisor's pid, and the executor's log files carry its own.
  let executorPid: number | undefined
  // The command supervisor that leads the executor's container, once spawned.
  let supervisorPid: number | undefined
  // The decisions Flywheel records to signal the executor's container, by the
  // command supervisor inside it or by this process from outside, once spawned.
  let terminations: ContainerTerminations | undefined
  const openedAt = performance.now()
  const startupFinished = Promise.withResolvers<void>()
  const checkOpen = (): void => { if (closing) throw new Error("project executor terminated during startup") }
  /** The step the start waits on now, for the slow-start record. */
  let step: "launch" | "channels" | "admission" | "guardian" | "first heartbeat" | "ready" = "launch"
  // One record for each generation, cleared at ready or at the end: a start
  // that keeps sending heartbeats is served however long it takes, and this
  // is the evidence of where it waits.
  const cancelSlowStart = setTimer(() => {
    log.warn("executor start slow", { step, heartbeats: responsiveness.heartbeats, startupMs: durationMs(openedAt) })
  }, EXECUTOR_START_SLOW_MS)
  // One lost executor connection detaches every channel in the same moment,
  // and one episode lasts until every channel is back. The first episode of
  // a window records its detach and its reattach; later ones count, and the
  // count reports when the window closes or the generation ends.
  const detached = new Set<ProjectExecutorEndpointKind>()
  let detachedAt = 0
  let episodeRecorded = false
  const detachEpisodes = coalesceRepeats<ChannelDetach>({
    windowMs: DETACH_EPISODE_WINDOW_MS,
    first: (_generation, detach) => {
      episodeRecorded = true
      log.warn("executor channel detached; awaiting reattach", { ...detach, reattachDeadlineMs })
    },
    repeated: (_generation, repeats) => {
      const byReason: { [reason: string]: number } = {}
      for (const detach of repeats.events) byReason[detach.reason] = (byReason[detach.reason] ?? 0) + 1
      log.warn("executor channels detached again", { count: repeats.count, windowMs: repeats.windowMs, byReason })
    },
  })
  // Every path that ends a generation names its cause here, so an executor
  // that is gone is never a silent event on the account side. The decision
  // records when it is made, so a closure that hangs, or a process killed
  // while it waits, still leaves the reason; the closure records only its
  // proof. `requested` marks a stop the account asked for that went as
  // asked; every other end is one nobody asked for.
  const terminate = (cause: string, detail: ProjectExecutorEndDetail = {}, requested = false, own = false): Promise<ProjectExecutorGenerationEnd> => {
    if (!closing) {
      const decision = { ...detail, cause, active, ...(detached.size > 0 ? { detachedChannels: [...detached] } : {}) }
      if (requested) log.info("executor generation ending", decision)
      else log.warn("executor generation ending", decision)
      // The account continues every container this generation claimed before
      // the closure ends them, so a stopped container never waits for a
      // signal it cannot act on.
      processorAdmission.leave()
      detachEpisodes.end()
      cancelSlowStart()
      const closureStarted = performance.now()
      responsiveness.dispose()
      endingCause = cause
      endingOwn = own
      endingDetail = detail
      for (const listener of endingListeners) listener(cause, own)
      endingListeners.clear()
      closing = (async () => {
        active = false
        authenticator.revoke()
        failure.reject(new Error("project executor terminated"))
        for (const facade of Object.values(channels)) facade.close(cause)
        for (const endpoint of connections) endpoint.close()
        // An executor that never reported ready has served nothing, so its
        // container ends at once, without a grace and without its command
        // supervisor: that supervisor runs at background priority, and under
        // load the scheduler can hold it for a minute, startup and all.
        const early = Promise.allSettled([scope.close(reportedReady ? undefined : { reason: cause }), ...servers.map((server) => server.dispose())])
        // An in-flight spawn or guardian acquisition must transfer its result
        // before closure can account for every resource it owns.
        await startupFinished.promise
        const settlements = await Promise.allSettled([
          bridge?.abort() ?? guardianGeneration?.close() ?? Promise.resolve({ settled: true } as const),
          ...disposers.map((dispose) => dispose()),
          ...[...connections].map((endpoint) => endpoint.closed),
        ])
        const reasons: string[] = []
        for (const result of [...await early, ...settlements]) {
          if (result.status === "rejected") reasons.push(String(result.reason))
          else if (result.value && !result.value.settled) reasons.push(result.value.reason)
        }
        const end: ProjectExecutorGenerationEnd = reasons.length ? { settled: false, reason: reasons.join("; "), cause } : { settled: true, cause }
        const closureMs = durationMs(closureStarted)
        if (end.settled) log.info("executor generation ended", { settled: true, closureMs })
        else log.error("executor generation ended unsettled", { settled: false, reason: end.reason, closureMs })
        closed.resolve(end)
        return end
      })()
    }
    return closing
  }
  // The four channels the generation's users hold are facades over whatever
  // socket currently carries each kind. A socket that closes while the
  // executor lives detaches its facade and the executor reconnects with the
  // credential it already holds; only the reattach deadline passing, the
  // process exiting, an executor-reported failure, or a stop ends the generation.
  const channel = (kind: ProjectExecutorEndpointKind): ReattachableProcessEndpoint<unknown, unknown> => {
    const facade = createReattachableProcessEndpoint<unknown, unknown>({ reattachDeadlineMs, ...(clock ? { setTimer: clock.setTimer } : {}) })
    facade.onDetach((error) => {
      const detach = { kind, reason: error.message }
      const opensEpisode = detached.size === 0
      if (opensEpisode) {
        detachedAt = performance.now()
        episodeRecorded = false
        detachEpisodes.observe(String(input.generation), detach)
      }
      if (!(opensEpisode && episodeRecorded)) log.debug("executor channel detached; awaiting reattach", detach)
      detached.add(kind)
      // No heartbeat can arrive while the lifecycle channel is away; the
      // reattach deadline, not the wedge bound, judges that silence.
      if (kind === "lifecycle") responsiveness.pause()
    })
    facade.onReattach(() => {
      const fields = { kind, detachedMs: durationMs(detachedAt) }
      if (detached.delete(kind) && detached.size === 0 && episodeRecorded) log.info("executor channels reattached", fields)
      else log.debug("executor channel reattached", fields)
      if (kind === "lifecycle") responsiveness.resume()
    })
    // A close also fails a start that still waits, which then ends as one
    // that could not start: a start has no deadline, so the reattach deadline
    // is what ends one whose channel never comes back.
    facade.onClose((error) => {
      failure.reject(error)
      if (active) void terminate("lost its connection to Flywheel", { channel: kind, error: error.message })
    })
    return facade
  }
  const channels = { control: channel("control"), state: channel("state"), output: channel("output"), lifecycle: channel("lifecycle") }
  // The executor's held set is the account's decision, and a send in flight
  // when the lifecycle socket detaches has an unknown outcome, so every
  // reattach sends the complete set again; the executor's adopt is idempotent.
  const processorAdmission = input.processorAdmission.join({ projectId: input.projectId, generation: input.generation, send: (held) => { void channels.lifecycle.send({ kind: "processor_holds", held }).catch(() => {}) } })
  channels.lifecycle.onReattach(() => { processorAdmission.resend() })
  channels.lifecycle.onDetach((reason) => { requests.detached(reason) })
  channels.lifecycle.onMessage((value) => {
    const frame = decodeProjectExecutorEvent(value)
    if (!frame) { log.error("executor lifecycle frame ignored: invalid"); return }
    if (frame.kind === "process") executorPid = frame.pid
    if (frame.kind === "heartbeat") {
      listening.resolve()
      responsiveness.beat()
    }
    if (frame.kind === "ready") {
      // The one record of a generation's start: the account records its end.
      log.info("executor generation ready", { supervisorPid, executorPid, startupMs: durationMs(openedAt) })
      cancelSlowStart()
      reportedReady = true
      ready.resolve()
    }
    if (frame.kind === "stopped") {
      answersStop = true
      stopped.resolve(frame.successorRows)
    }
    if (frame.kind === "blockers") {
      const previous = latestBlockers
      latestBlockers = frame.blockers
      if (frame.id !== undefined && frame.id === blockersRead?.id) blockersRead.reply.resolve(frame.blockers)
      // A late answer tells the listeners only when it changed the list, so
      // an executor that answers every read late never drives a read loop.
      else if (frame.id === undefined || previous === undefined || !sameBlockers(previous, frame.blockers)) for (const listener of blockersChanged) listener()
    }
    if (frame.kind === "processor_claims") processorAdmission.claim(frame.claims)
    requests.hear(frame, (message) => channels.lifecycle.send(message))
    // One command the executor could not do; the generation keeps serving.
    // A handoff that waits under that command's id hears why, and a blockers
    // read answers the latest list, as a read that missed its bound does.
    if (frame.kind === "command_failed") {
      log.warn("executor lifecycle command failed", { command: frame.command, id: frame.id, reason: frame.reason })
      if (frame.id !== undefined && frame.command === "blockers" && frame.id === blockersRead?.id) blockersRead.reply.resolve(latestBlockers)
    }
    if (frame.kind === "failed") {
      if (endingCause === undefined) endedByItself = true
      stopped.reject(new Error(frame.reason))
      failure.reject(new Error(frame.reason))
      if (active) void terminate("stopped after an internal error", { error: frame.reason }, false, true)
    }
  })
  const acceptConnection = (kind: ProjectExecutorEndpointKind) =>
    (endpoint: InternalProcessEndpoint<unknown, unknown>): void => {
      connections.add(endpoint)
      if (closing) { endpoint.close(); return }
      const unsubscribe = endpoint.onMessage((value) => {
        const credential = decodeProjectExecutorCredential(value)
        if (!credential || credential.endpoint !== kind || !authenticator.accept(credential)) {
          endpoint.close("project executor authentication failed")
          return
        }
        unsubscribe()
        channels[kind].attach(endpoint)
        admitted[kind].resolve(channels[kind])
      })
    }
  // Admission is a state Worker write that queues until the Worker is up, so it
  // runs alongside the spawn: the executor's module imports overlap the Worker's
  // startup instead of following it. Nothing the executor can act through is
  // wired until the admission result is known.
  const admission = input.admit()
  // A refusal ends the startup at whatever step it is waiting on, rather than
  // after the executor's channels have authenticated.
  const admissionSettled = admission.catch((error: unknown) => failure.reject(error))
  const startup = (async () => {
    for (const kind of kinds) {
      const server = (input.listen ?? listenInternalProcessChannel)<unknown, unknown>({
        ...projectExecutorChannelLimits(kind),
        path: input.endpoints[kind], decode: (value) => value,
        onConnection: acceptConnection(kind),
      })
      servers.push(server)
      await Promise.race([server.ready, failure.promise])
      checkOpen()
    }
    disposers.push(async () => { terminations?.dispose() })
    const owned = await scope.spawnOwned(projectExecutorCommand(), {
      cwd: input.directories.executionCwd,
      env: { ...process.env, FLYWHEEL_PROJECT_EXECUTOR: JSON.stringify(init) },
      // Each command the executor launches is held by its own container
      // alone, so a command it hands over to the next build outlives it.
      childrenBreakAway: true,
      diagnostics: {
        context: { projectId: input.projectId, generation: input.generation },
        observe(record, pid) {
          terminations ??= watchContainerTerminations(pid)
          terminations.read(record.payload)
        },
      },
      // The account's process supervisor reports the guardian's exit here
      // before it ends the container, so the end names the loss and not the
      // stop word that carries it out. The account decides nothing when an
      // end is already under way. A decision the container already records
      // came first, such as the command supervisor's own proof of the loss,
      // and it names the end. A stop the account asked for keeps its channels
      // so the executor can flush: the stop word's signal joins that stop, and
      // the exit by that signal ends it.
      onGuardianLost: (guardian) => {
        if (stopAskedAt === undefined && terminations?.last() === undefined) void terminate("lost its process guardian", { guardian })
      },
    })
    const spawnedAt = now()
    // Counted from the launch, so an executor that never sends its first
    // heartbeat is proven wedged at the same bound as one that goes silent.
    responsiveness.start()
    supervisorPid = owned.pid
    const decisions = terminations ?? watchContainerTerminations(owned.pid)
    terminations = decisions
    // Native supervisors expose pipes. Drain them so diagnostics cannot block lifecycle progress.
    // The drained text is a DEBUG record, so the most recent of it is also
    // kept: an executor that dies unasked writes why only there, as the
    // stack of an uncaught failure or a runtime panic.
    let recentOutput = ""
    const diagnostics = Log.create({ service: "project-executor" }).with({ projectId: input.projectId, generation: input.generation })
    const keep = (text: string): void => {
      recentOutput = (recentOutput + text).slice(-EXECUTOR_OUTPUT_TAIL_CHARS)
    }
    const drains: Promise<void>[] = []
    for (const stream of [owned.stdout, owned.stderr]) {
      if (stream) {
        const decoder = new TextDecoder()
        const read = createProcessDiagnosticReader((text, record) => {
          if (record) decisions.read(record.payload)
          // A supervisor's record, such as a termination decision, is relayed
          // as the record it is, with the supervisor that wrote it.
          if (record !== undefined && RELAYED_SERVICES.has(record.payload.service)) relayProcessDiagnostic(diagnostics, record, { supervisorPid: owned.pid })
          else diagnostics.debug("executor diagnostic output", { text })
        })
        const drain = stream.pipeTo(new WritableStream({
          write(bytes) { const text = decoder.decode(bytes, { stream: true }); keep(text); read(text) },
          close() { const text = decoder.decode(); keep(text); read(text + "\n") },
        }))
        void drain.catch((error: unknown) => failure.reject(error))
        drains.push(drain)
        disposers.push(() => drain)
      }
    }
    // Every exit is recorded except one that answers a requested Stop: a
    // death, at startup too, and an end Flywheel made through terminate().
    void owned.exited.then(async (exit) => {
      const lifetimeMs = now() - spawnedAt
      // Read before this exit ends the generation itself: an end already
      // under way is the account's decision, and the container signals that
      // carried it out are only its execution.
      const decided = endingCause === undefined ? undefined : { senderPid: process.pid, container: owned.pid, reason: endingCause, detail: endingDetail }
      const requested = answersStop
      // An exit by a stop signal while the account's Stop waits for its answer
      // is the end of that Stop, not a death. The executor ends by its stop
      // signal only once its ordered stop settled or its lifecycle channel
      // detached, and a stop that hangs ends by SIGKILL instead. The Stop's
      // request can reach the executor after its signal stop closed its
      // channels, and the executor's own log states how its stop went.
      // stopWaitedMs is how long the Stop has waited, while it still waits.
      const stopWaitedMs = stopAskedAt === undefined || requested || decided !== undefined ? undefined : now() - stopAskedAt
      const endsStopBy = stopWaitedMs !== undefined && exit.statusOf === "payload" ? executorStopSignalOf(exit, process.platform) : undefined
      const status = exit.signal === null ? `with code ${exit.code}` : `with signal ${exit.signal}`
      const unasked = active
      // An exit that nothing asked for is the executor's own when it exited
      // with a code or crashed; any other signal came from outside it.
      const own = decided === undefined && !requested && stopAskedAt === undefined && (exit.signal === null || CRASH_SIGNALS.has(exit.signal))
      if (own) endedByItself = true
      bridge?.peerExited()
      failure.reject(new Error(`project executor exited ${status}`))
      if (endsStopBy === undefined) exited.reject(new Error(`project executor exited ${status}`))
      else exited.resolve(undefined)
      if (unasked) void terminate(exit.signal === null ? `exited with code ${exit.code}` : `stopped by signal ${exit.signal}`, exit.signal === null ? { code: exit.code } : { signal: exit.signal }, false, own)
      if (requested) return
      try {
        await deadline(Promise.allSettled(drains), EXECUTOR_OUTPUT_SETTLE_MS)
      } catch {
        // The pipes close as the process goes, so the last output follows the
        // exit within moments; a pipe some descendant still holds is not waited for.
      }
      const termination = decided ?? decisions.last()
      if (endsStopBy !== undefined) {
        log.info("executor ended by its stop signal during the account's stop", { executorPid, signal: endsStopBy, ...(termination ? { termination } : {}), stopWaitedMs })
        return
      }
      // The executor is gone with its container, so its log files are closed
      // and can be kept past routine ones for whoever reads this record.
      const logFiles = executorPid === undefined ? [] : DebugLog.markUnexpectedExit(resolveDebugLogDirectory(input.directories.projectRoot), executorPid)
      log.error("executor process exited unexpectedly", {
        executorPid, supervisorPid: owned.pid, lifetimeMs,
        ...(exit.signal === null ? { code: exit.code } : { signal: exit.signal }), statusOf: exit.statusOf,
        termination, logFiles, output: recentOutput,
      })
    })
    // Checked once the exit is watched, so an end made during the spawn
    // still leaves its record.
    checkOpen()
    step = "channels"
    const channelSet = await Promise.race([
      Promise.all([admitted.control.promise, admitted.state.promise, admitted.output.promise, admitted.lifecycle.promise]).then(([control, state, output, lifecycleEndpoint]) =>
        createProjectExecutorChannelSet({ control, state, output, lifecycle: lifecycleEndpoint })),
      failure.promise,
    ])
    checkOpen()
    startupTrace("executor channels authenticated")
    step = "admission"
    await admission
    checkOpen()
    lifecycle = channelSet.lifecycle
    step = "guardian"
    guardianGeneration = await input.launcher.guardian.openGeneration()
    checkOpen()
    const generation = guardianGeneration
    bridge = serveOwnedProcessBridge({
      endpoint: createInternalProcessSubchannel(channelSet.control, "guardian"),
      guardian: { openGeneration: async () => generation },
    })
    disposers.push(servePersistentProcessBridge({
      endpoint: createInternalProcessSubchannel(channelSet.control, "persistent"),
      manager: input.persistentProcesses, allowLaunch: input.allowPersistentLaunch,
    }), serveProjectStateChannel(input.state, channelSet.state, { kind: "executor", projectId: input.projectId, generation: input.generation }), serveProjectNotifyChannel(createInternalProcessSubchannel(channelSet.control, "notify"), input.notify))
    const runtime = connectProjectExecutionChannel(channels.output, { watchedOutput: input.watchedOutput })
    disposers.push(() => runtime.close())
    step = "first heartbeat"
    await Promise.race([listening.promise, failure.promise])
    checkOpen()
    // The account's login shell PATH goes down ahead of the start when the
    // account already knows it, and whenever its probe settles later, so the
    // executor never probes. A project that opens while the PATH is unknown
    // asks the account to probe again. A send in flight when the lifecycle socket
    // detaches has an unknown outcome, so every reattach sends the known PATH
    // again; the executor's adopt is idempotent. A channel that never
    // reattaches ends the generation at the reattach deadline.
    const sendLoginShellPath = (path: string): void => {
      void channelSet.lifecycle.send({ kind: "login_shell_path", path }).catch(() => {})
    }
    input.loginShellPath.request()
    const stopLoginShellPath = input.loginShellPath.watch(sendLoginShellPath)
    const stopLoginShellPathResend = channels.lifecycle.onReattach(() => {
      const path = input.loginShellPath.current()
      if (path !== undefined) sendLoginShellPath(path)
    })
    disposers.push(async () => {
      stopLoginShellPath()
      stopLoginShellPathResend()
    })
    step = "ready"
    await Promise.race([channelSet.lifecycle.send({ kind: "start", chatDefault: input.chatDefault() }), failure.promise])
    await Promise.race([ready.promise, failure.promise])
    checkOpen()
    active = true
    return runtime
  })()
  // A startup that fails before it reaches the admission still joins it, so
  // closure never leaves a Worker write in flight.
  const runtimeReady = startup.finally(() => admissionSettled).finally(() => startupFinished.resolve()).catch(async (error: unknown) => {
    // A full disk or a held database lock is a cause the person can act on.
    const cause = isStorageFailure(error) ? "could not write the project's saved state" : "could not start"
    const end = await terminate(cause, { error: errorMessage(error) }, false, endedByItself)
    throw new ProjectExecutorStartupError(error, end)
  })
  void runtimeReady.catch(() => {})
  return {
      closed: closed.promise, terminate: (cause, detail) => terminate(cause, detail), ready: runtimeReady,
      onWedged: (listener) => responsiveness.onWedged(listener),
      onEnding(listener) {
        if (endingCause !== undefined) {
          listener(endingCause, endingOwn)
          return () => {}
        }
        endingListeners.add(listener)
        return () => { endingListeners.delete(listener) }
      },
      settle() {
        settling ??= (async (): Promise<OwnershipClosure> => {
          const end = await closed.promise
          if (end.settled || proven) return { settled: true }
          // The same kernel proofs the first closure asked for: the launcher
          // scope re-checks each container it still holds, and the guardian
          // re-empties what it still leases to this generation.
          const proofs = await Promise.allSettled([scope.close(), guardianGeneration?.close() ?? Promise.resolve({ settled: true } as const)])
          const reasons = proofs.flatMap((proof) => proof.status === "rejected" ? [errorMessage(proof.reason)] : proof.value.settled ? [] : [proof.value.reason])
          const closure: OwnershipClosure = reasons.length === 0 ? { settled: true } : { settled: false, reason: reasons.join("; ") }
          proven = closure.settled
          if (closure.settled) log.info("executor generation settled on a second proof")
          else log.warn("executor generation is still unsettled", { reason: closure.reason })
          return closure
        })().finally(() => { settling = undefined })
        return settling
      },
      startChatDefault() {
        chatDefaultStart ??= (async () => {
          await runtimeReady
          if (!active || !lifecycle) throw new Error("project executor is not ready")
          await lifecycle.send({ kind: "start_chat_default" })
        })()
        return chatDefaultStart
      },
      async blockers() {
        await runtimeReady
        if (!active || !lifecycle) return []
        if (!blockersRead) {
          const id = ++blockersRequestId
          const reply = Promise.withResolvers<readonly ReplacementBlocker[] | undefined>()
          const answer = lifecycle.send({ kind: "blockers", id }).then(() => reply.promise)
          const read = deadline(answer, BLOCKERS_READ_MS).catch(() => latestBlockers).finally(() => { blockersRead = undefined })
          blockersRead = { id, reply, read }
        }
        return blockersRead.read
      },
      async setReplacement(state) {
        await runtimeReady
        if (!active || !lifecycle) return
        await lifecycle.send({ kind: "replacement", state })
      },
      onBlockersChanged(listener) {
        blockersChanged.add(listener)
        return () => { blockersChanged.delete(listener) }
      },
      async handoff(kind, handoffId) {
        await runtimeReady
        if (!active || !lifecycle) throw new Error("project executor is not ready")
        return await requests.handoff(lifecycle.send.bind(lifecycle), kind, handoffId, failure.promise)
      },
      async continueCapacityWaits() {
        await runtimeReady
        if (!active || !lifecycle) throw new Error("project executor is not ready")
        return await requests.continueCapacityWaits(lifecycle.send.bind(lifecycle), failure.promise)
      },
      async stop() {
        if (!active || !lifecycle) {
          answersStop = true
          return ownership(await terminate("was stopped before it was ready", {}, true))
        }
        active = false
        stopAskedAt = now()
        // The executor beats until its stop closes its channels, so the watch
        // counts on, and its stall records show a stop that stalls. The
        // generations owner ends no stopping generation on a wedge proof:
        // only this deadline ends a stop.
        const request = lifecycle
        let successorRows: SuccessorRows | undefined
        try {
          // One deadline from the start of the stop covers the request and
          // the answer: a request that waits on a detached channel spends the
          // same budget, so the account's stop never outlasts it.
          successorRows = await deadline((async () => {
            await Promise.race([request.send({ kind: "stop", clientsHold: input.clientsHold() }), exited.promise])
            return await Promise.race([stopped.promise, exited.promise])
          })(), stopDeadlineMs)
        } catch (error) {
          const end = await terminate("did not finish saving its work when it was stopped", { error: errorMessage(error), ...responsiveness.silence() })
          return { settled: false, reason: `Executor did not flush gracefully: ${String(error)}${end.settled ? "" : `; ${end.reason}`}` }
        }
        const closure = ownership(await terminate("was stopped", {}, true))
        return successorRows === undefined ? closure : { ...closure, successorRows }
      },
  }
}
