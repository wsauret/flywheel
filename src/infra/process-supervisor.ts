import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"

import { readOutcomeRecord, type OutcomeRecordRead } from "./command-handover.js"
import { unmarkedEnvironment } from "./container-mark.js"
import { errorMessage } from "./error-message.js"
import { namedExitStatus } from "./exit-status.js"
import { durationMs } from "./operation-log.js"
import { onTermination, recordTermination, type TerminationCause } from "./process-container.js"
import { createProcessDiagnosticReader, KERNEL_API_SERVICE, relayProcessDiagnostic } from "./process-diagnostic-reader.js"
import { Log } from "./log.js"
import { createOwnedProcess, type OwnedProcess } from "./owned-subprocess.js"
import { handBackWord, type AdoptableCommand, type ControlledContainer, type HandedOverCommand } from "./owned-command-control.js"
import { ownedProcessBackend, type OwnedLaunchOptions, type OwnedProcessBackend } from "./owned-subprocess-backend.js"
import {
  createGuardianFrameReader,
  decodeGuardianReply,
  destroyGuardianToken,
  encodeGuardianFrame,
  guardianLeaseOutcome,
  newGuardianToken,
  stampGuardianRequest,
  type GuardianCommand,
  type GuardianLeaseOutcome,
  type GuardianReply,
  type GuardianRequest,
  type GuardianRequestBody,
} from "./process-guardian-protocol.js"
import { proveProcessEnded } from "./prove-process-ended.js"
import { startupTrace } from "./startup-trace.js"
import { platformGuardianLedger } from "./guardian-ledger.js"
import { withDeadline } from "./with-deadline.js"
import type { ProcessPriority } from "./process-priority.js"

const log = Log.create({ service: "process-supervisor" })
onTermination((decision) => { log.info("process termination diagnostic", { ...decision }) })

const DEFAULT_ACKNOWLEDGE_TIMEOUT_MS = 5_000
/** How long an owned container has between the polite stop and the kill,
 *  unless its supervisor states another grace. */
export const PROCESS_KILL_GRACE_MS = 5_000
const DEFAULT_SCOPE_CLOSE_DEADLINE_MS = 10_000
const GUARDIAN_EXIT_DEADLINE_MS = 10_000
const GUARDIAN_KILL_DEADLINE_MS = 1_000
/** The services of the records a guardian writes on the stderr this host
 *  drains: its own, its termination decisions, and a kernel API it could not
 *  open. */
const GUARDIAN_RECORD_SERVICES: ReadonlySet<string> = new Set(["process-guardian", "process-termination", KERNEL_API_SERVICE])

/** Spawns every subprocess Flywheel owns, and owns the guardian that outlives
 *  a crash of this process.
 *
 *  The contract is fail-closed in both directions. A payload never runs until
 *  the guardian has acknowledged ownership of its container, so a supervisor
 *  that dies mid-handshake leaves nothing behind. A guardian that loses its
 *  control channel terminates every container it still holds, so a host that
 *  dies after the handshake leaves nothing behind either.
 *
 *  One guardian runs at a time. The kernel's report of its exit is the one
 *  proof that it is gone: that report ends the containers it held, and the
 *  next launch starts a new guardian, with no restart of this process. A
 *  control channel that fails while the guardian lives proves nothing and ends
 *  no container. This side stops using the channel and ends that guardian the
 *  way disposal does, and the proven exit then ends its work. */
export interface ProcessSupervisor {
  spawnOwned(command: readonly string[], options?: SupervisedLaunchOptions): Promise<OwnedProcess>
  /** Takes a command another owner handed over, and backs it with this
   *  supervisor's guardian from then on. Throws when the command cannot be
   *  taken now, and leaves it with its supervisor. */
  adoptOwned(command: AdoptableCommand): Promise<AdoptionAnswer>
  /** The guardian's control authority, for a host that must open a generation
   *  of its own - one whose containers a peer thread launches because it needs
   *  their stdio. */
  readonly guardian: GuardianControl
  /** Starts the guardian and waits for protocol readiness. Repeated calls join
   *  one acquisition. */
  start(): Promise<void>
  /** Ends the control channel, which is the guardian's instruction to
   *  terminate every container still owned, then waits for it to exit. It
   *  joins an ending that a failed channel already began. */
  dispose(): Promise<void>
}

/** How the guardian whose exit ended a launch went, as the kernel reported
 *  it: its pid, its exit code or signal, and the reason its control channel
 *  failed when that failure began the guardian's end. */
export type GuardianLoss = { readonly guardianPid: number; readonly channel?: string } & ({ readonly code: number | null } | { readonly signal: string })

/** A launch as a supervisor takes it. The backend's options, plus what the
 *  launch's owner is told when the guardian's exit ends the launch, which the
 *  backend never sees. */
interface SupervisedLaunchOptions extends OwnedLaunchOptions {
  /** Called once, at the guardian's proven exit, before the supervisor ends
   *  this launch's container. So the owner can record its own decision to end
   *  the launch before the stop that carries that decision out. A supervisor
   *  that records through a peer's lease owns no guardian and never calls it. */
  readonly onGuardianLost?: (loss: GuardianLoss) => void
}

/** What adopting a handed-over command found. `adopted`: this owner holds it
 *  like a command it launched. `ended`: its supervisor is gone and its
 *  container is proven empty, and `record` is its outcome record as read; a
 *  record this release cannot read is reported with nothing ended.
 *  `refused`: its supervisor speaks no version of the adopt word this release
 *  sends, so nothing here may stop it, and it stays with its supervisor. */
type AdoptionAnswer =
  | { readonly kind: "adopted"; readonly owned: OwnedProcess }
  | { readonly kind: "ended"; readonly record: OutcomeRecordRead }
  | { readonly kind: "refused" }

/** Adopt and release inside one generation, and nothing else: no spawn
 *  capability, no guardian credential, no control over the guardian's lifetime
 *  and no way to name another owner's generation. The pid is part of the lease
 *  because every container recorded through it watches that process: a guardian
 *  that dies is no longer a backstop, and the containers it held must end
 *  whatever thread launched them. */
export interface GuardianLease {
  request(command: GuardianCommand): Promise<GuardianLeaseOutcome>
  /** Refuses once the guardian's control channel has failed, with the answer
   *  of that guardian's ending, so no new container comes to depend on a
   *  guardian that is being ended. */
  pid(): Promise<number>
}

/** One owner's leases, from the guardian's side. Closing it is what proves the
 *  owner is gone: the guardian ends every container still leased to the
 *  generation and answers with what survived, so an owner that died without
 *  saying anything is measured rather than believed. */
export interface GuardianGeneration extends GuardianLease {
  close(): Promise<OwnershipClosure>
}

/** The authority to declare an owner. It cannot adopt anything itself. Its
 *  `pid()` refuses as a lease's does once the guardian's channel has failed. */
export interface GuardianControl {
  openGeneration(): Promise<GuardianGeneration>
  pid(): Promise<number>
}

/** Test-only synchronization points inside one acquisition, in the order they
 *  occur.
 *
 *  A barrier is awaited at its point and is given nothing but the name of that
 *  point, so it can hold an acquisition exactly where a crash test needs the
 *  host to die, and can observe neither the guardian's capability nor payload
 *  data.
 *
 *  `guardian-ready` is a control channel that completed its handshake and a
 *  generation this supervisor may lease into. `container-launched` is a
 *  container that exists while its payload is still held before exec, so
 *  nothing of the payload has run. `lease-acknowledged` is that container
 *  after the guardian answered `adopted` for it and before its payload is
 *  admitted. `target-running` is after admission, when the payload is the
 *  container's. */
type AcquisitionPhase =
  | "before-guardian-connect"
  | "guardian-ready"
  | "container-launched"
  | "lease-acknowledged"
  | "target-running"

type AcquisitionBarrier = (phase: AcquisitionPhase) => Promise<void> | void

export interface ProcessSupervisorOptions {
  readonly guardianCommand?: readonly string[]
  readonly backend?: OwnedProcessBackend
  readonly acknowledgeTimeoutMs?: number
  readonly killGraceMs?: number
  /** Records ownership through an existing lease instead of starting a
   *  guardian. A supervisor given one never starts or closes a guardian, and
   *  never opens a generation: both stay with the peer that opened the lease. */
  readonly lease?: GuardianLease
  /** Test-only. Awaited at every acquisition phase. Production supplies none,
   *  and an acquisition then has no barrier at all. */
  readonly barrier?: AcquisitionBarrier
}

/** The outcome of ending what an owner still holds. Settlement is proven, never
 *  assumed: a close that overruns its deadline, or whose containers the
 *  guardian could not empty, says so and the owner keeps holding them. */
export type OwnershipClosure =
  | { readonly settled: true }
  | { readonly settled: false; readonly reason: string }

const SETTLED: OwnershipClosure = { settled: true }

/** The guardian's control channel failed and its exit is proven. Its leases
 *  were records in that process and ended with it, and every guarded
 *  container watches the guardian and ends itself once it is gone. So a
 *  release or a close that meets this error has nothing left to settle. When
 *  the channel fails while the guardian lives, a request meets this error only
 *  after this side has ended the guardian and proven its exit. Until then the
 *  guardian's leases stay in force. */
class GuardianEndedError extends Error {
  readonly _tag = "GuardianEndedError" as const
  constructor(message: string, readonly guardianPid: number) { super(message) }
}

/** Everything one owner may launch outside this process, and nothing else. A
 *  scope can spawn and it can close; it never sees the guardian channel, the
 *  guardian's capability, or the spawn backend. Closing terminates every
 *  container the scope still holds and refuses every later launch, so
 *  ownership ends with the owner rather than with the process. */
export interface LauncherScope {
  spawnOwned(command: readonly string[], options?: SupervisedLaunchOptions): Promise<OwnedProcess>
  /** Adopts a handed-over command, which this scope then holds like one it
   *  launched. */
  adoptOwned(command: AdoptableCommand): Promise<AdoptionAnswer>
  /** A nested scope that closes with this one, for an owner whose lifetime is
   *  shorter than its parent's. */
  open(policy?: LauncherScopePolicy): LauncherScope
  /** Terminate what is still held, concurrently under one absolute deadline,
   *  so a scope holding many containers is bounded exactly like a scope
   *  holding one, and report whether that proved settlement. A container that
   *  did not settle stays this scope's, so a later call re-checks what is left
   *  instead of repeating an answer that has stopped being true.
   *
   *  With `end`, every container the scope or a nested scope holds, or
   *  acquires afterwards, is ended at once, for `end`'s reason (see
   *  `OwnedProcess.terminate`): for an owner whose processes hold nothing a
   *  stop would save. The first close that names an end decides it. */
  close(end?: TerminationCause): Promise<OwnershipClosure>
}

export interface LauncherScopePolicy {
  readonly priority?: ProcessPriority
}

/** The launch authority of one command: a scope for the containers this
 *  process launches, and the guardian control a peer thread's generation is
 *  opened through for the containers it must launch itself. */
export interface LauncherContext {
  readonly scope: LauncherScope
  readonly guardian: GuardianControl
  /** Starts the guardian now instead of at the first launch, so its handshake
   *  overlaps other startup work. Repeated calls join one acquisition, and a
   *  rejected start is not cached: the first launch starts a fresh guardian. */
  startGuardian(): Promise<void>
}

/** A scope as its parent holds it: the scope, and the longest stop hold of
 *  what it still holds, which the parent's close deadline must cover. */
interface NestedScope extends LauncherScope {
  longestStopHoldMs(): number
}

/** Builds a scope over one supervisor's launch and adoption capabilities. They
 *  are the only thing a scope holds, so a holder can never widen them.
 *  `settled` runs once the scope's own close proved settlement, which is when
 *  a nested scope leaves its parent. */
export function createLauncherScope(
  owner: Pick<ProcessSupervisor, "spawnOwned" | "adoptOwned">,
  closeDeadlineMs: number = DEFAULT_SCOPE_CLOSE_DEADLINE_MS,
  policy: LauncherScopePolicy = {},
  settled: () => void = () => {},
): NestedScope {
  // Each held container with the bound of its stop hold, 0 for none.
  const held = new Map<OwnedProcess, number>()
  const children = new Set<NestedScope>()
  // Containers that exist for nobody yet: recorded before the first await of
  // their acquisition and resolved once each one is held or ended, so a close
  // can never prove a settlement a container being born is about to break.
  const acquiring = new Set<Promise<string | undefined>>()
  let closed = false
  let closing: Promise<OwnershipClosure> | null = null
  // Set by a close that ends what the scope holds at once, and kept, so a
  // container whose acquisition finishes afterwards is ended the same way.
  let ending: TerminationCause | undefined

  /** Ends one container and reports what stopped it from settling, or nothing
   *  once it surrendered ownership. */
  const settleContainer = (owned: OwnedProcess): Promise<string | undefined> =>
    owned.terminate(ending).then(
      (exit) => (exit.ownership === "surrendered" ? undefined : `container ${owned.pid} exited without surrendering ownership`),
      (err) => `container ${owned.pid} failed to settle: ${errorMessage(err)}`,
    )

  // A container's own end waits its stop hold before the grace, so the close
  // deadline covers the longest hold, and a parent's covers its children's.
  const longestStopHoldMs = (): number => Math.max(0, ...held.values(), ...[...children].map((child) => child.longestStopHoldMs()))

  const runClose = async (): Promise<OwnershipClosure> => {
    const deadlineMs = closeDeadlineMs + longestStopHoldMs()
    // Every settlement is asked for before anything is awaited, and each one
    // carries the reason it would report if the shared deadline arrives first,
    // so a scope holding many containers is bounded exactly like one holding a
    // single container.
    const settling = [
      ...[...children].map((child) => ({
        overrun: `a nested scope did not close within ${deadlineMs}ms`,
        // A child that proved settlement left `children` through its own
        // `settled` callback before its close answered.
        outcome: child.close(ending).then(
          (closure) => (closure.settled ? undefined : closure.reason),
          (err) => `a nested scope failed to close: ${errorMessage(err)}`,
        ),
      })),
      ...[...held.keys()].map((owned) => ({
        overrun: `container ${owned.pid} did not settle within ${deadlineMs}ms`,
        outcome: settleContainer(owned),
      })),
      ...[...acquiring].map((acquisition) => ({
        overrun: `a container did not finish being acquired within ${deadlineMs}ms`,
        outcome: acquisition,
      })),
    ]
    if (settling.length === 0) return SETTLED

    const overran = Symbol("overran")
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<typeof overran>((resolve) => { timer = setTimeout(() => { resolve(overran) }, deadlineMs) })
    const reasons: string[] = []
    try {
      for (const settlement of settling) {
        const answer = await Promise.race([settlement.outcome, deadline])
        if (answer === overran) reasons.push(settlement.overrun)
        else if (answer !== undefined) reasons.push(answer)
      }
    } finally {
      clearTimeout(timer)
    }
    // What did not settle is still held: a container leaves `held` by its own
    // settlement and a nested scope leaves `children` by proving settlement,
    // never because a close gave up on either.
    return reasons.length === 0 ? SETTLED : { settled: false, reason: reasons.join("; ") }
  }

  /** Holds `owned` until its ownership ends: at an exit the guardian
   *  answered, or at a handover, after which the command is a later owner's.
   *  Answers the process as the scope's holders see it. */
  const hold = (owned: OwnedProcess, stopHoldMs = 0): OwnedProcess => {
    const handOver = owned.handOver
    const holding: OwnedProcess = handOver === undefined ? owned : {
      ...owned,
      handOver: async (request) => {
        const answer = await handOver(request)
        if (answer.kind === "handed_over") held.delete(holding)
        return answer
      },
    }
    held.set(holding, stopHoldMs)
    // Ownership ends with the guardian's answer: a container that exited
    // without one is still this scope's to account for.
    void owned.exited.then((exit) => {
      if (exit.ownership === "surrendered") held.delete(holding)
    })
    return holding
  }

  /** Runs one acquisition and holds the container it yields, if any. A close
   *  that began meanwhile owns that container too, and ends it. */
  const acquire = async <Answer>(
    obtain: () => Promise<Answer>,
    container: (answer: Answer) => OwnedProcess | undefined,
    answering: (answer: Answer, holding: OwnedProcess) => Answer,
    stopHoldMs = 0,
  ): Promise<Answer> => {
    if (closed) throw new Error("launcher scope is closed")
    let acquired: (unsettled: string | undefined) => void = () => {}
    const acquisition = new Promise<string | undefined>((resolve) => { acquired = resolve })
    acquiring.add(acquisition)
    let unsettled: string | undefined
    try {
      const answer = await obtain()
      const owned = container(answer)
      if (owned === undefined) return answer
      // Re-checked after the await: a close that began while the container
      // was starting owns this container too, and must not leave it behind.
      if (closed) {
        unsettled = await settleContainer(owned)
        // A container that could not settle is still this scope's, so a
        // later close addresses it again instead of forgetting it.
        if (unsettled !== undefined) hold(owned, stopHoldMs)
        throw new Error("launcher scope is closed")
      }
      return answering(answer, hold(owned, stopHoldMs))
    } finally {
      acquired(unsettled)
      acquiring.delete(acquisition)
    }
  }

  return {
    spawnOwned: (command, options) => acquire(
      () => owner.spawnOwned(command, {
        ...options,
        ...(policy.priority === undefined ? {} : { priority: policy.priority }),
      }),
      (owned) => owned,
      (_owned, holding) => holding,
      options?.stopHold?.boundMs,
    ),
    adoptOwned: (command) => acquire(
      () => owner.adoptOwned(command),
      (answer) => (answer.kind === "adopted" ? answer.owned : undefined),
      (_answer, holding) => ({ kind: "adopted", owned: holding }),
    ),
    longestStopHoldMs,
    open(childPolicy = {}) {
      const child = createLauncherScope(owner, closeDeadlineMs, { priority: policy.priority ?? childPolicy.priority }, () => { children.delete(child) })
      // A closed scope cannot be mutated back into an owner, and a child it
      // could not close would be owned by nobody.
      if (closed) void child.close(ending)
      else children.add(child)
      return child
    },
    close(end) {
      ending ??= end
      if (!closed) {
        // A termination decision only when it ends something: a close that
        // holds nothing is routine and records at DEBUG.
        const holding = { senderPid: process.pid, containers: [...held.keys()].map((owned) => owned.pid), acquiring: acquiring.size, children: children.size, caller: new Error("launcher scope closing").stack?.split("\n").slice(1, 5).join("\n") }
        if (held.size > 0 || acquiring.size > 0 || children.size > 0) log.info("launcher scope closing", holding)
        else log.debug("launcher scope closing", holding)
      }
      closed = true
      // A close that proved settlement is final. One that did not is a fact
      // about a moment, so asking again re-checks what is still held instead of
      // repeating an answer that may have stopped being true.
      closing ??= runClose().then((closure) => {
        if (closure.settled) settled()
        else closing = null
        return closure
      })
      return closing
    },
  }
}

/** Argv that runs the guardian from source. A packaged binary has no module
 *  path, so it passes its own guardian argv instead. */
function defaultGuardianCommand(): readonly string[] {
  return [process.execPath, fileURLToPath(new URL("process-guardian.ts", import.meta.url))]
}

export function createProcessSupervisor(options: ProcessSupervisorOptions = {}): ProcessSupervisor {
  const backend = options.backend ?? ownedProcessBackend
  const guardianCommand = options.guardianCommand ?? defaultGuardianCommand()
  const acknowledgeTimeoutMs = options.acknowledgeTimeoutMs ?? DEFAULT_ACKNOWLEDGE_TIMEOUT_MS
  const killGraceMs = options.killGraceMs ?? PROCESS_KILL_GRACE_MS
  const barrier = options.barrier
  const injected = options.lease
  let disposed = false

  // Every launch this supervisor still owns, recorded before its adoption can
  // settle and kept until the container does. A guardian that has exited is
  // no longer anyone's crash backstop, so its proven exit ends what it was
  // holding, including a container whose acknowledgement was still in flight.
  const live = new Set<LaunchOwner>()

  // One guardian per supervisor at a time, started on first use and shared by
  // every later spawn. A failed start is not cached, and a guardian that exits
  // is forgotten, so the next spawn starts a new one rather than inheriting a
  // dead channel forever. `own` is this supervisor's generation in it, opened
  // once and shared by every spawn. A supervisor that records through a peer's
  // lease has neither: the generation that owns its containers is the peer's.
  let channel: Promise<GuardianChannel> | undefined
  let own: Promise<GuardianLease> | undefined
  // The guardian whose exit the next one follows, kept until a new one is
  // ready so that its start names what it replaces.
  let replaces: number | undefined

  const guardianEnded = (ended: Promise<GuardianChannel>, { ready, ...loss }: GuardianExit): void => {
    // A guardian whose handshake failed can exit after a newer one started,
    // and its exit then clears nothing of the newer one.
    if (channel !== ended) return
    channel = undefined
    own = undefined
    // A guardian that never answered its handshake held nothing and replaces
    // nothing: its failed start already recorded its end.
    if (!ready) return
    replaces ??= loss.guardianPid
    const abandoned = [...live]
    live.clear()
    const record = { ...loss, containers: abandoned.length }
    if (disposed) log.info("the process guardian ended; ending the containers it held", record)
    else log.warn("the process guardian ended; ending the containers it held", record)
    // Each owner records its own decision before its container is ended, so
    // the end it sees names the guardian's loss and not the stop word that
    // carries the end out. An owner that fails keeps no container from ending.
    for (const owner of abandoned) {
      try {
        owner.onGuardianLost?.(loss)
      } catch (err) {
        log.error("a launch owner failed when told of its guardian's loss", { guardianPid: loss.guardianPid, error: errorMessage(err) })
      } finally {
        owner.end()
      }
    }
  }

  const guardian = (): Promise<GuardianChannel> => {
    if (injected) throw new Error("this supervisor records ownership through a peer's lease and owns no guardian")
    // Disposal ends the guardian and forgets it, and nothing may start another.
    if (disposed) throw new Error("process supervisor is disposed")
    if (!channel) {
      startupTrace("guardian start")
      const started: Promise<GuardianChannel> = startGuardian(guardianCommand, acknowledgeTimeoutMs, (exit) => { guardianEnded(started, exit) }, replaces)
      channel = started
      started.then(
        () => {
          replaces = undefined
          startupTrace("guardian ready")
        },
        () => { if (channel === started) channel = undefined },
      )
    }
    return channel
  }

  const lease = (): Promise<GuardianLease> => {
    if (injected) return Promise.resolve(injected)
    if (!own) {
      const opening = guardian().then(openGeneration)
      own = opening
      opening.catch(() => { if (own === opening) own = undefined })
    }
    return own
  }

  /** Owns `container` as `token` until its guardian answers the release of
   *  it, or until it is handed over, which a launch that allowed it and every
   *  adopted command may be. */
  const ownContainer = (control: GuardianLease, token: string, container: ControlledContainer, owner: LaunchOwner, handover: boolean): OwnedProcess => {
    const owned: OwnedProcess = createOwnedProcess({
      pid: container.pid,
      token,
      child: container.child,
      release: () => releaseLease(control, token),
      stop: (end) => { container.stop(end) },
      ...(handover ? {
        handOver: async (request) => {
          const acknowledgement = await container.handOver(request, acknowledgeTimeoutMs)
          if (acknowledgement === "exited") return { kind: "exited", exit: await owned.exited }
          if (acknowledgement === "unacknowledged") return { kind: "unacknowledged" }
          // The supervisor holds the command alone now: neither this
          // supervisor's loss of its guardian nor that guardian's sweep may
          // reach it.
          live.delete(owner)
          try {
            await releaseLease(control, token)
          } catch (err) {
            log.warn("a handed-over command kept its lease; the guardian ends it when this process ends", { token, error: errorMessage(err) })
          }
          return { kind: "handed_over" }
        },
      } : {}),
    })
    owner.end = () => { void owned.terminate() }
    void owned.exited.then(() => live.delete(owner))
    return owned
  }

  /** Adopts a handed-over command whose channel nothing serves: its
   *  supervisor is gone, or runs but cannot be reached. What the supervisor
   *  left is ended before the command is reported ended, so no payload
   *  outlives the owner that reports its end. Throws when the supervisor may
   *  still run. A record this release cannot read names no container it may
   *  end, so it is reported as it is. */
  const unservedAdoption = async (command: HandedOverCommand): Promise<AdoptionAnswer> => {
    const read = readOutcomeRecord(command.recordPath)
    if (read.kind === "unreadable") return { kind: "ended", record: read }
    const empty = await backend.emptyUnserved(command, read.kind === "record" ? read.record.supervisorIdentity : undefined, killGraceMs)
    if (!empty) throw new Error("the command's supervisor may still run, but its channel does not answer")
    return { kind: "ended", record: readOutcomeRecord(command.recordPath) }
  }

  return {
    guardian: {
      openGeneration: async () => await openGeneration(await guardian()),
      pid: async () => await (await guardian()).pidForLease(),
    },
    async start() {
      if (disposed) throw new Error("process supervisor is disposed")
      await lease()
    },
    async spawnOwned(command, { onGuardianLost, ...launchOptions } = {}) {
      if (disposed) throw new Error("process supervisor is disposed")
      await barrier?.("before-guardian-connect")
      const control = await lease()
      await barrier?.("guardian-ready")
      const token = `owned:${randomUUID()}`
      // The token names the container, so it is chosen before the launch rather
      // than after: a platform whose containers are named creates one under
      // this name, and the guardian later reaches it by the same name.
      startupTrace("owned launch start")
      const launch = backend.launch(command, { ...launchOptions, killGraceMs, token, guardianPid: await control.pid() })
      startupTrace("owned container launched")
      // Recorded before the acknowledgement can arrive: a guardian lost in the
      // middle of this handshake must find this container in the one record
      // its loss sweeps.
      const owner: LaunchOwner = { end: () => { launch.stop() }, ...(onGuardianLost === undefined ? {} : { onGuardianLost }) }
      live.add(owner)
      try {
        await barrier?.("container-launched")
        const outcome = await withDeadline(control.request({ kind: "adopt", token, pid: launch.pid, stopHold: launchOptions.stopHold ?? null }), acknowledgeTimeoutMs)
        if (outcome.kind !== "adopted") throw new Error(`guardian refused ownership of ${token}: ${outcome.kind === "rejected" ? outcome.reason : outcome.kind}`)
        await barrier?.("lease-acknowledged")
      } catch (err) {
        live.delete(owner)
        launch.stop()
        // The acknowledgement may still be travelling: a lease the guardian
        // grants after this acquisition gave up would own a container nobody
        // holds, so the release that compensates it is sent now. It follows
        // the adopt on an ordered channel, and a guardian that never adopted
        // refuses it.
        void control.request({ kind: "release", token }).catch((releaseErr) => {
          log.warn("could not compensate an abandoned adoption", { token, error: errorMessage(releaseErr) })
        })
        throw err
      }
      launch.admit()
      startupTrace("owned container admitted")
      const owned = ownContainer(control, token, launch, owner, launchOptions.handover === true)
      await barrier?.("target-running")
      return owned
    },
    async adoptOwned(command) {
      if (disposed) throw new Error("process supervisor is disposed")
      const control = await lease()
      const guardianPid = await control.pid()
      const reached = await backend.reach(command, killGraceMs)
      if (reached === undefined) return await unservedAdoption(command)
      const word = handBackWord(command)
      const answer = await reached.adopt(guardianPid, acknowledgeTimeoutMs, word)
      if (answer.kind === "refused") return answer
      if (answer.kind === "gone") return await unservedAdoption(command)
      // Leased only after the supervisor's answer: an adoption it never
      // answered leaves this guardian untouched, and a lease this owner cannot
      // complete hands the command back to the supervisor alone.
      const owner: LaunchOwner = { end: () => { answer.container.stop() } }
      live.add(owner)
      let leased: GuardianLeaseOutcome
      try {
        leased = await withDeadline(control.request({ kind: "adopt", token: command.token, pid: command.pid, stopHold: null }), acknowledgeTimeoutMs)
      } catch (err) {
        live.delete(owner)
        reached.handBack(word)
        // The lease may still be travelling: one granted after this gave up
        // would own a container its supervisor holds alone again, so the
        // release that compensates it follows it on the ordered channel.
        void control.request({ kind: "release", token: command.token }).catch((releaseErr: unknown) => {
          log.warn("could not compensate an abandoned adoption", { token: command.token, error: errorMessage(releaseErr) })
        })
        throw err
      }
      if (leased.kind === "rejected" && leased.reason === "not-a-container") {
        // The supervisor exited after it answered: its container settles as
        // an adopted one does, once its channel ends.
        live.delete(owner)
        await answer.container.child.exited
        return { kind: "ended", record: readOutcomeRecord(command.recordPath) }
      }
      if (leased.kind !== "adopted") {
        live.delete(owner)
        reached.handBack(word)
        throw new Error(`guardian refused ownership of ${command.token}: ${leased.kind === "rejected" ? leased.reason : leased.kind}`)
      }
      return { kind: "adopted", owned: ownContainer(control, command.token, answer.container, owner, true) }
    },
    async dispose() {
      if (disposed) return
      disposed = true
      const started = channel
      if (!started) return
      await started.then((control) => control.shutdown()).catch((err) => {
        log.warn("guardian disposal did not prove the guardian ended", { error: errorMessage(err) })
      })
    },
  }
}

/** Asks the guardian to forget `token`. A guardian that has exited has
 *  nothing left to forget but its durable record of the lease, which this side
 *  removes in its place: the container is empty or handed over, so no later
 *  guardian has anything to end for it. Only that guardian's record goes: a
 *  guardian that adopted the command since keeps its own. */
async function releaseLease(control: GuardianLease, token: string): Promise<void> {
  let outcome: GuardianLeaseOutcome
  try {
    outcome = await control.request({ kind: "release", token })
  } catch (err) {
    if (err instanceof GuardianEndedError) return platformGuardianLedger?.drop(token, err.guardianPid)
    throw err
  }
  if (outcome.kind !== "released") throw new Error(`guardian refused the release of ${token}: ${outcome.kind === "rejected" ? outcome.reason : outcome.kind}`)
}

/** What ends one launch, whatever stage it reached. Before the payload is
 *  admitted only the container exists, so the launch is stopped; afterwards the
 *  owned process is the one authority that may settle it. */
interface LaunchOwner {
  end(): void
  /** The launch's `onGuardianLost`, told before `end` when the guardian's
   *  exit ends the launch. */
  readonly onGuardianLost?: (loss: GuardianLoss) => void
}

/** Declares one owner to the guardian and hands back the only surface that can
 *  lease into it or end it. */
async function openGeneration(channel: GuardianChannel): Promise<GuardianGeneration> {
  const generation = `gen:${randomUUID()}`
  const opened = await channel.send({ kind: "open", generation })
  if (opened.kind !== "opened") throw new Error(`guardian refused a generation: ${refusalReason(opened)}`)
  return {
    pid: () => channel.pidForLease(),
    request: async (command) => guardianLeaseOutcome(await channel.send({ ...command, generation })),
    async close() {
      // The decision records when it is made, with who asked, so a closure
      // that hangs, or a process killed while it waits, still leaves it.
      log.info("guardian generation closing", { senderPid: process.pid, guardianPid: channel.pid, generation, caller: new Error("guardian generation closing").stack?.split("\n").slice(1, 5).join("\n") })
      const started = performance.now()
      // The guardian is the record, so its answer is the proof: it ends every
      // container still leased here and reports what survived. An owner that
      // died without releasing anything is measured exactly like one that
      // asked. The closure records only that proof.
      const settle = (closure: OwnershipClosure, evidence: { readonly remaining?: number; readonly guardianExited?: true } = {}): OwnershipClosure => {
        const proof = { generation, settled: closure.settled, ...evidence, closureMs: durationMs(started) }
        if (closure.settled) log.info("guardian generation closed", proof)
        else log.error("guardian generation closed unsettled", { ...proof, reason: closure.reason })
        return closure
      }
      let closed: GuardianReply
      try {
        closed = await channel.send({ kind: "close", generation })
      } catch (err) {
        if (err instanceof GuardianEndedError) return settle(SETTLED, { guardianExited: true })
        return settle({ settled: false, reason: `the guardian could not be asked to close ${generation}: ${errorMessage(err)}` })
      }
      if (closed.kind !== "closed") return settle({ settled: false, reason: `the guardian refused to close ${generation}: ${refusalReason(closed)}` })
      if (closed.remaining === 0) return settle(SETTLED, { remaining: 0 })
      return settle({ settled: false, reason: `${closed.remaining} container(s) of ${generation} outlived the guardian's kill` }, { remaining: closed.remaining })
    },
  }
}

/** The host's end of one guardian control channel. It holds the capability,
 *  stamps every request with it and with a correlation id, and is the only
 *  thing on this side that can reach the guardian at all. */
interface GuardianChannel {
  readonly pid: number
  /** `pid`, for a container that is about to depend on the guardian. Once the
   *  channel has failed it refuses with the answer of the guardian's ending. */
  pidForLease(): Promise<number>
  send(body: GuardianRequestBody): Promise<GuardianReply>
  /** Ends the guardian and proves its exit. Repeated calls, and a failed
   *  channel, join one ending. */
  shutdown(): Promise<void>
}

/** What the kernel reported when one guardian exited: the loss its launches'
 *  owners are told, and `ready`, whether the guardian had answered its
 *  handshake. */
type GuardianExit = GuardianLoss & { readonly ready: boolean }

interface PendingRequest {
  readonly resolve: (reply: GuardianReply) => void
  readonly reject: (err: Error) => void
}

async function startGuardian(
  command: readonly string[],
  readyTimeoutMs: number,
  onEnded: (exit: GuardianExit) => void,
  replaces: number | undefined,
): Promise<GuardianChannel> {
  // Rotated per guardian and never written anywhere but this pipe: the
  // capability is what separates this host from anything else that could reach
  // a process with the authority to kill trees.
  const capability = newGuardianToken()
  // Detached: a terminal SIGINT reaches the foreground process group, and the
  // guardian must survive exactly the events the host does not. Unmarked for
  // the same reason: ending the container this host runs in must leave the
  // guardian to sweep what the host owned.
  const proc = Bun.spawn({ cmd: [...command], stdio: ["pipe", "pipe", "pipe"], env: unmarkedEnvironment(undefined), detached: true, windowsHide: true })
  const decoder = new TextDecoder()
  const forwardDiagnostic = createProcessDiagnosticReader((_line, record) => {
    if (record !== undefined && GUARDIAN_RECORD_SERVICES.has(record.payload.service)) relayProcessDiagnostic(log, record, { guardianPid: proc.pid })
  })
  void proc.stderr.pipeTo(new WritableStream({
    write(chunk) { forwardDiagnostic(decoder.decode(chunk, { stream: true })) },
    close() { forwardDiagnostic(decoder.decode() + "\n") },
  })).catch(() => {})
  const pending = new Map<number, PendingRequest>()
  let nextId = 0
  let answered = false
  // The longest stop hold any lease asked of this guardian, from this host or
  // a peer that leases through it. The guardian's sweep waits that hold
  // before its TERM, so the exit bound below covers it.
  let longestStopHoldMs = 0
  let channelFailure: string | undefined
  let failure: Promise<Error> | undefined

  // The kernel's report is the one proof that the guardian is gone, and with
  // it every lease it held. Registered before anything awaits the exit, so
  // the owner hears of it before any request learns the answer.
  void proc.exited.then(() => {
    const { code, signal } = namedExitStatus(proc.exitCode, proc.signalCode)
    onEnded({ guardianPid: proc.pid, ...(signal === null ? { code } : { signal }), ...(channelFailure === undefined ? {} : { channel: channelFailure }), ready: answered })
  })

  // Closing stdin is the guardian's instruction to end every container still
  // leased and exit. The ending reports why the exit could not be proven, or
  // nothing once the guardian exited.
  let ending: Promise<string | undefined> | undefined
  const end = (): Promise<string | undefined> => {
    ending ??= (async () => {
      try {
        await proc.stdin.end()
      } catch {
        // The pipe closed with the guardian, which is the instruction given.
      }
      try {
        return await proveProcessEnded(proc, GUARDIAN_EXIT_DEADLINE_MS + longestStopHoldMs, GUARDIAN_KILL_DEADLINE_MS)
      } finally {
        // This channel is the capability's only use, so it is erased when the
        // channel ends, whatever the guardian did. A request stamped after this
        // fails rather than reaching a guardian nobody is watching.
        destroyGuardianToken(capability)
      }
    })()
    return ending
  }

  // A channel that ends, or that sends a frame Flywheel does not define, proves
  // nothing about the guardian: its leases stay in force until it exits. So
  // this side stops using the channel and ends the guardian the way disposal
  // does, and every request after it meets the answer of that ending.
  const fail = (reason: string): void => {
    // A disposal that closed stdin ends the channel as the guardian exits, and
    // that end is not a failure of the channel.
    if (ending === undefined) channelFailure = reason
    failure = end().then((unproven) => (unproven === undefined
      ? new GuardianEndedError(reason, proc.pid)
      : new Error(`${reason}, and the guardian could not be proven ended: ${unproven}`)))
    const lost = [...pending.values()]
    pending.clear()
    void failure.then((error) => { for (const request of lost) request.reject(error) })
  }

  void (async () => {
    const reader = createGuardianFrameReader()
    try {
      for await (const chunk of proc.stdout) {
        for (const line of reader.push(chunk)) {
          const reply = decodeGuardianReply(line)
          if (!reply) throw new Error("guardian sent a frame Flywheel does not define")
          // Correlated by id, so an answer can only settle the one request that
          // asked for it, whatever else is in flight.
          pending.get(reply.id)?.resolve(reply)
          pending.delete(reply.id)
        }
      }
      fail("guardian control channel ended")
    } catch (err) {
      fail(`guardian control channel failed: ${errorMessage(err)}`)
    }
  })()

  const refusal = (settled: Promise<Error>): Promise<never> => settled.then((error) => { throw error })

  const exchange = (build: (id: number) => GuardianRequest): Promise<GuardianReply> => {
    if (failure) return refusal(failure)
    return new Promise<GuardianReply>((resolve, reject) => {
      const id = ++nextId
      pending.set(id, { resolve, reject })
      try {
        proc.stdin.write(encodeGuardianFrame(build(id)))
        proc.stdin.flush()
      } catch (err) {
        pending.delete(id)
        reject(new Error(`guardian control write failed: ${errorMessage(err)}`))
      }
    })
  }

  // The handshake is the first frame of the channel, which is what binds the
  // capability to this connection: the guardian answers nothing before it and
  // accepts no second one.
  let ready: GuardianReply
  const handshakeStarted = performance.now()
  try {
    ready = await withDeadline(exchange((id) => ({ v: 1, kind: "hello", id, capability })), readyTimeoutMs)
    if (ready.kind !== "ready") throw new Error(`guardian answered the handshake with ${refusalReason(ready)}`)
    answered = true
    // The crash backstop of every container this process launches from now on.
    log.info("guardian started", { senderPid: process.pid, guardianPid: ready.pid, handshakeMs: durationMs(handshakeStarted), ...(replaces === undefined ? {} : { replaces }) })
  } catch (err) {
    recordTermination({ container: proc.pid, target: proc.pid, signal: "SIGKILL", reason: "guardian handshake failed" })
    proc.kill("SIGKILL")
    destroyGuardianToken(capability)
    throw new Error(`process guardian never became ready: ${errorMessage(err)}`, { cause: err })
  }

  const pid = ready.pid
  return {
    pid,
    pidForLease: () => (failure ? refusal(failure) : Promise.resolve(pid)),
    send: (body) => { longestStopHoldMs = Math.max(longestStopHoldMs, body.kind === "adopt" ? body.stopHold?.boundMs ?? 0 : 0); return exchange((id) => stampGuardianRequest(body, id, capability)) },
    async shutdown() {
      const unproven = await end()
      // A guardian that outlived its kill still holds the authority to end
      // containers, so the caller is told rather than handed a resolved
      // promise it would read as proof.
      if (unproven) throw new Error(`the guardian could not be proven ended: ${unproven}`)
    },
  }
}

function refusalReason(reply: GuardianReply): string {
  return reply.kind === "rejected" ? reply.reason : reply.kind
}
