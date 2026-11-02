import * as fs from "node:fs"

import {
  GUARDIAN_MAX_GENERATIONS,
  GUARDIAN_MAX_OWNED_CONTAINERS,
  GUARDIAN_MAX_RETIRED_TOKENS,
  createGuardianFrameReader,
  decodeGuardianRequest,
  destroyGuardianToken,
  encodeGuardianFrame,
  guardianTokenMatches,
  type GuardianToken,
  type GuardianRejection,
  type GuardianReply,
  type GuardianRequest,
} from "./process-guardian-protocol.js"
import { ownedProcessBackend } from "./owned-subprocess-backend.js"
import { emptyContainers, type ContainerIdentity, type ContainerRef, type ManagedContainer } from "./process-container.js"
import { groupMarkReading, markedOutsideGroup, type GroupMarkReading } from "./container-mark.js"
import { platformGuardianLedger, type AbandonedLease, type GuardianLedger } from "./guardian-ledger.js"
import { unsettledEmptyingStreak } from "./process-probe-streak.js"
import type { StopHold } from "./stop-hold.js"
import { formatDebugLogLine } from "./debug-log.js"
import { Log } from "./log.js"

const log = Log.create({ service: "process-guardian" })

/** The guardian is a separate process whose only job is to outlive a crashing
 *  host by exactly as long as it takes to kill what the host owned.
 *
 *  It holds no payload capability: it cannot spawn, it never sees a command
 *  line, an environment, or a secret. It receives pids the host already
 *  spawned, verifies each one leads its own container, and terminates them
 *  when the control channel ends. End of channel is the crash signal: a host
 *  that is SIGKILLed closes its pipes, and the guardian treats that exactly
 *  like an orderly shutdown request.
 *
 *  It is also the sole authority over who owns what. A lease belongs to a
 *  generation, a generation is opened before any lease of it can settle, and
 *  closing a generation is what proves the containers of one owner are gone -
 *  including an owner that died without saying anything. Nothing else keeps a
 *  second record of the same fact: the ledger is these leases' durable copy,
 *  which only this guardian and the guardian after it read. */

export interface GuardianHost {
  readonly control: ReadableStream<Uint8Array>
  send(reply: GuardianReply): void
  inspect(ref: ContainerRef): ContainerIdentity
  /** What the guardian ends for `ref`: everything the command started, also
   *  a process that left the command's process group. */
  container(ref: ContainerRef): ManagedContainer
  /** What the guardian ends for `ref` once the process group at its pid is
   *  proven not to be the launch's: only the processes the launch marked
   *  outside that group (`markedOutsideGroup`). */
  escaped(ref: ContainerRef): ManagedContainer
  /** Whether the process group `ref` names still holds a process with the
   *  launch's mark, or undefined where the kernel cannot tell
   *  (`groupMarkReading`). */
  groupMark(ref: ContainerRef): GroupMarkReading | undefined
  /** Releases whatever this side holds for `ref`. */
  forget(ref: ContainerRef): void
  sleep(ms: number): Promise<void>
  /** The durable copy of the leases, on a platform where a container
   *  outlives every process that owns it. Without one, the leases die with
   *  this process and nothing reads what an earlier guardian left. */
  readonly ledger?: GuardianLedger
}

export interface GuardianLimits {
  readonly maxContainers: number
  readonly maxGenerations: number
  readonly maxRetiredTokens: number
  readonly killGraceMs: number
}

/** How often a guardian looks again at what a dead guardian's ledger still
 *  holds: a container whose supervisor still runs, or one a probe could not
 *  answer for. The same period as a supervisor's watch of its guardian, whose
 *  check is what ends such a container. */
export const GUARDIAN_LEDGER_RECHECK_MS = 250

const DEFAULT_GUARDIAN_LIMITS: GuardianLimits = {
  maxContainers: GUARDIAN_MAX_OWNED_CONTAINERS,
  maxGenerations: GUARDIAN_MAX_GENERATIONS,
  maxRetiredTokens: GUARDIAN_MAX_RETIRED_TOKENS,
  killGraceMs: 5_000,
}

interface Lease {
  readonly generation: string
  /** How the container is addressed. The token is the lease's own key, and it
   *  travels in the reference because on a platform whose containers are named
   *  it is the container's identity. */
  readonly ref: ContainerRef
  readonly identity: string
  /** The launch's stop hold, which every end of this lease honors. */
  readonly stopHold: StopHold | null
}

/** Serves the control channel until it ends, then sweeps. Rejects when the
 *  host sends a frame it could not have produced - and sweeps first, because a
 *  host that is speaking a protocol Flywheel does not define is a host whose
 *  owned processes must not be left running. */
export async function runProcessGuardian(host: GuardianHost, limits: GuardianLimits): Promise<void> {
  // The capability the first frame of this channel established. Until it
  // exists the guardian owns nothing and answers nothing, so an unauthenticated
  // peer cannot reach a single mutation.
  let capability: GuardianToken | undefined
  const leases = new Map<string, Lease>()
  const openGenerations = new Set<string>()
  const retiredTokens = new Set<string>()
  const retiredGenerations = new Set<string>()
  const closing = new Set<Promise<void>>()

  /** Drops one lease and retires its token. The backend is told too: on a
   *  platform whose containers are named, ownership is a handle this side
   *  holds, and a lease dropped without releasing it would leak that handle
   *  and keep the container alive past its owner. */
  const drop = (token: string, lease: Lease): void => {
    leases.delete(token)
    retire(retiredTokens, token, limits.maxRetiredTokens)
    host.ledger?.drop(token, process.pid)
    host.forget(lease.ref)
  }

  const retire = (retired: Set<string>, value: string, bound: number): void => {
    retired.add(value)
    if (retired.size <= bound) return
    const oldest = retired.values().next()
    if (!oldest.done) retired.delete(oldest.value)
  }

  /** The container of one lease, as this guardian is allowed to address it.
   *
   *  Each answer carries its own right. A pid that still leads the leased
   *  container may be signalled while the container holds anything. A pid whose
   *  leader is proven gone may be signalled too, because a descendant can keep
   *  the container and that descendant is still this guardian's to remove. A
   *  pid nothing could be proven about is never signalled and never released:
   *  it may be a stranger that inherited the number, and it may be the lease,
   *  and a kill on no evidence would answer that question with a corpse.
   *
   *  Identity only ever vetoes. A pid that now leads a different container is
   *  not ours, and a pid held by a process that leads no container proves the
   *  leased one gone, so either lease is released rather than signalled. */
  const ownedContainer = (lease: Lease, container: ManagedContainer = host.container(lease.ref)): ManagedContainer => {
    const standing = (): "ours" | "released" | "unproven" => {
      const identity = host.inspect(lease.ref)
      if (identity.kind === "unproven") return "unproven"
      if (identity.kind === "other" || (identity.kind === "container" && identity.identity !== lease.identity)) return "released"
      return container.populated() ? "ours" : "released"
    }
    return {
      signal: (signal, cause) => { if (standing() === "ours") container.signal(signal, cause) },
      populated: () => standing() !== "released",
      ...(lease.stopHold === null ? {} : { stopHold: lease.stopHold }),
    }
  }

  const rejected = (id: number, reason: GuardianRejection): GuardianReply => ({ v: 1, kind: "rejected", id, reason })

  const hello = (request: Extract<GuardianRequest, { kind: "hello" }>): GuardianReply => {
    // One handshake per channel. A second one is not the parent introducing
    // itself again; it is something trying to replace the credential that
    // guards every kill this process can perform. The material it offered is
    // destroyed rather than kept next to the real one.
    if (capability !== undefined) {
      destroyGuardianToken(request.capability)
      return rejected(request.id, "unauthorized")
    }
    capability = request.capability
    return { v: 1, kind: "ready", id: request.id, pid: process.pid }
  }

  /** True when a frame carries the capability this channel established. The
   *  offered material is destroyed either way: it exists for this one
   *  comparison, and nothing after it may still reach it. */
  const authorized = (request: Exclude<GuardianRequest, { kind: "hello" }>): boolean => {
    try {
      return capability !== undefined && guardianTokenMatches(capability, request.capability)
    } finally {
      destroyGuardianToken(request.capability)
    }
  }

  const open = (id: number, generation: string): GuardianReply => {
    if (openGenerations.has(generation) || retiredGenerations.has(generation)) return rejected(id, "generation-retired")
    if (openGenerations.size >= limits.maxGenerations) return rejected(id, "at-capacity")
    openGenerations.add(generation)
    return { v: 1, kind: "opened", id, generation }
  }

  const adopt = (request: Extract<GuardianRequest, { kind: "adopt" }>): GuardianReply => {
    // The generation is registered before any lease of it can settle, so a
    // container is never owned by a generation nobody declared.
    if (!openGenerations.has(request.generation)) return rejected(request.id, "unknown-generation")
    // A token names one container for the life of the guardian. Reusing a
    // live or released token is refused rather than resolved, so a host bug
    // can never redirect an existing ownership record at a different pid.
    if (retiredTokens.has(request.token) || leases.has(request.token)) return rejected(request.id, "token-retired")
    if (leases.size >= limits.maxContainers) return rejected(request.id, "at-capacity")
    const ref = { pid: request.pid, token: request.token }
    const identity = host.inspect(ref)
    // Only a reference proven to name a container may be leased: nothing else
    // names a container this guardian could later prove it ended. An adoption
    // must be answered now, so it asks once. A probe that did not answer is
    // refused with its own reason, so it never reads as a container that was
    // not there, and the next adoption asks again.
    if (identity.kind !== "container") {
      host.forget(ref)
      return rejected(request.id, identity.kind === "unproven" ? "container-unproven" : "not-a-container")
    }
    leases.set(request.token, { generation: request.generation, ref, identity: identity.identity, stopHold: request.stopHold })
    // Recorded before the answer, because the answer admits the payload.
    host.ledger?.hold({ token: request.token, pid: request.pid, identity: identity.identity, stopHold: request.stopHold })
    return { v: 1, kind: "adopted", id: request.id, token: request.token }
  }

  const release = (request: Extract<GuardianRequest, { kind: "release" }>): GuardianReply => {
    const lease = leases.get(request.token)
    if (!lease) {
      // A release the guardian already performed answers again, so a retry
      // after a lost reply costs nothing. A token nobody ever leased is
      // refused instead: answering it would report a surrender that never
      // happened.
      return retiredTokens.has(request.token) ? { v: 1, kind: "released", id: request.id, token: request.token } : rejected(request.id, "unknown-token")
    }
    if (lease.generation !== request.generation) return rejected(request.id, "unknown-token")
    drop(request.token, lease)
    return { v: 1, kind: "released", id: request.id, token: request.token }
  }

  /** Ends one generation. The generation is retired the moment the request is
   *  read, so nothing can lease into it again, and the kill that follows runs
   *  beside the channel instead of blocking every other owner behind one
   *  generation's grace.
   *
   *  Only a container proven empty stops being owned. Whatever survived stays
   *  leased to the retired generation, so a later close of it and the sweep at
   *  channel end address it again rather than reporting a settlement nobody
   *  proved. */
  const close = (request: Extract<GuardianRequest, { kind: "close" }>): void => {
    const { id, generation } = request
    if (!openGenerations.delete(generation) && !retiredGenerations.has(generation)) {
      host.send(rejected(id, "unknown-generation"))
      return
    }
    retire(retiredGenerations, generation, limits.maxGenerations)
    const leased = [...leases]
      .filter(([, lease]) => lease.generation === generation)
      .map(([token, lease]) => ({ token, lease, container: ownedContainer(lease) }))
    // The host records the closure once, with this process's answer; these
    // steps are DEBUG so the answer is not relayed twice.
    log.debug("guardian generation closing", { senderPid: process.pid, generation, containers: leased.map(({ lease }) => lease.ref.pid) })
    const emptied = (async () => {
      const settlement = await emptyContainers(leased.map((entry) => entry.container), limits.killGraceMs, host.sleep, { reason: "guardian generation close" })
      let remaining = 0
      for (const entry of leased) {
        if (settlement.kind !== "empty" && entry.container.populated()) {
          remaining += 1
          continue
        }
        drop(entry.token, entry.lease)
      }
      host.send({ v: 1, kind: "closed", id, generation, remaining })
      log.debug("guardian generation closed", { senderPid: process.pid, generation, remaining })
    })()
    closing.add(emptied)
    void emptied.finally(() => closing.delete(emptied))
  }

  /** One absolute deadline covers the whole sweep: every container gets the
   *  same grace, whatever their number, so shutdown stays bounded. */
  const sweep = async (): Promise<void> => {
    const remaining = [...leases]
    // A termination decision only when there is something to end.
    const sweeping = { senderPid: process.pid, containers: remaining.map(([, lease]) => lease.ref.pid) }
    if (remaining.length > 0) log.info("guardian control channel ended; sweeping leases", sweeping)
    else log.debug("guardian control channel ended; sweeping leases", sweeping)
    const containers = remaining.map(([, lease]) => ({ pid: lease.ref.pid, container: ownedContainer(lease) }))
    leases.clear()
    const settlement = await emptyContainers(containers.map((entry) => entry.container), limits.killGraceMs, host.sleep, { reason: "guardian control channel ended" })
    // The sweep is this process's last act, so the containers it could not
    // prove empty are recorded now; the record reaches a log only while the
    // host still reads this stderr.
    if (settlement.kind === "unsettled") log.warn("the guardian's sweep did not prove every container empty", { remaining: settlement.remaining, containers: containers.filter((entry) => entry.container.populated()).map((entry) => entry.pid) })
    // Released after the kill, never before: with a named container the handle
    // is the ownership, and closing it first would hand the container back
    // while its members were still running. A container that survived keeps
    // its record, so the next guardian ends it.
    for (const [token, lease] of remaining) {
      if (host.ledger !== undefined && (settlement.kind === "empty" || !ownedContainer(lease).populated())) host.ledger.drop(token, process.pid)
      host.forget(lease.ref)
    }
  }

  let serving = true
  let recovering: Promise<void> | undefined

  /** Ends what dead guardians left on the ledger, for as long as this
   *  guardian serves. A pass in progress when the channel ends runs beside the
   *  sweep, which never waits on it, and no pass starts after it.
   *
   *  A record whose guardian is gone names a container nobody may still own.
   *  Its supervisor decides who acts. A supervisor that still runs, with the
   *  identity the record names, watches its guardian and ends its container
   *  itself, or it serves the handover a later owner adopts it through, so
   *  this guardian only looks again later. A supervisor proven gone whose
   *  container still holds a process left an orphan, which this guardian
   *  ends as it ends its own leases, proving the container's standing before
   *  every signal. A container proven gone, or whose pid now names another
   *  container, loses its record. A group whose leader is gone and whose
   *  members all show an environment without the launch's mark is a
   *  stranger's, because a process that took the pid after the group emptied
   *  leads it: only the launch's processes outside it are ended, and the
   *  record goes once none is left. */
  const recover = async (ledger: GuardianLedger): Promise<void> => {
    const announced = new Set<string>()
    const unsettled = unsettledEmptyingStreak(log, "the guardian's recovery")
    try {
      for (;;) {
        const pending = await recoverOnce(ledger, announced, unsettled)
        if (pending === 0 || !serving) return
        await host.sleep(GUARDIAN_LEDGER_RECHECK_MS)
        if (!serving) return
      }
    } finally {
      unsettled.end()
    }
  }

  /** One pass over the ledger. Answers how many records stay to be looked at
   *  again. */
  const recoverOnce = async (ledger: GuardianLedger, announced: Set<string>, unsettled: ReturnType<typeof unsettledEmptyingStreak>): Promise<number> => {
    let pending = 0
    const orphans: Array<{ readonly lease: AbandonedLease; readonly container: ManagedContainer; readonly reach: "container" | "outside-group" }> = []
    for (const lease of ledger.abandoned()) {
      // A command this guardian adopted since is its own lease, under its
      // own record, so the dead guardian's record of it has nothing to add.
      if (leases.has(lease.token)) {
        ledger.drop(lease.token, lease.guardianPid)
        continue
      }
      const ref = { pid: lease.pid, token: lease.token }
      const identity = host.inspect(ref)
      if (identity.kind === "unproven" || (identity.kind === "container" && identity.identity === lease.identity)) {
        pending += 1
        continue
      }
      const mark = identity.kind === "absent" ? host.groupMark(ref) : undefined
      if (mark === "unproven") {
        pending += 1
        continue
      }
      const reach = mark === "unmarked" ? "outside-group" : "container"
      const recorded: Lease = { generation: "recovered", ref, identity: lease.identity, stopHold: lease.stopHold }
      const container = ownedContainer(recorded, reach === "container" ? host.container(ref) : host.escaped(ref))
      if (container.populated()) {
        orphans.push({ lease, container, reach })
        continue
      }
      if (reach === "outside-group") log.info("guardian forgetting a container whose group no process of the launch holds", { senderPid: process.pid, pid: lease.pid, guardianPid: lease.guardianPid })
      ledger.drop(lease.token, lease.guardianPid)
      host.forget(ref)
    }
    if (orphans.length === 0) return pending
    const fresh = orphans.filter(({ lease }) => !announced.has(lease.token))
    for (const { lease } of fresh) announced.add(lease.token)
    if (fresh.length > 0) {
      log.info("guardian ending containers whose guardian and supervisor are gone", {
        senderPid: process.pid,
        containers: fresh.map(({ lease, reach }) => ({ pid: lease.pid, guardianPid: lease.guardianPid, proof: lease.proof, reach })),
      })
    }
    const settlement = await emptyContainers(orphans.map(({ container }) => container), limits.killGraceMs, host.sleep, { reason: "guardian recovery: the container's guardian and supervisor are gone" })
    for (const { lease, container } of orphans) {
      if (settlement.kind !== "empty" && container.populated()) {
        pending += 1
        continue
      }
      ledger.drop(lease.token, lease.guardianPid)
      host.forget({ pid: lease.pid, token: lease.token })
    }
    if (settlement.kind === "unsettled") unsettled.observe({ remaining: settlement.remaining })
    else unsettled.end()
    return pending
  }

  const reader = createGuardianFrameReader()
  try {
    for await (const chunk of host.control) {
      for (const line of reader.push(chunk)) {
        const request = decodeGuardianRequest(line)
        if (!request) throw new Error("guardian received a frame the host could not have produced")
        if (request.kind === "hello") {
          host.send(hello(request))
          // After the answer, so recovery never delays the handshake that
          // the host's first launch waits on.
          if (recovering === undefined && host.ledger !== undefined) {
            recovering = recover(host.ledger).catch((error: unknown) => {
              log.warn("the guardian's recovery of an earlier guardian's leases failed; the next guardian tries again", { error: error instanceof Error ? error.message : String(error) })
            })
          }
          continue
        }
        // Authority is checked before the request reaches anything that can
        // mutate a lease, a generation, or a process.
        if (!authorized(request)) {
          host.send(rejected(request.id, "unauthorized"))
          continue
        }
        if (request.kind === "close") close(request)
        else if (request.kind === "open") host.send(open(request.id, request.generation))
        else if (request.kind === "adopt") host.send(adopt(request))
        else host.send(release(request))
      }
    }
  } finally {
    serving = false
    // The host bounds this process's exit by the grace and stop holds of its
    // own leases alone, so a recovery pass in progress gets one grace that
    // starts now and runs beside the generation closes and the sweep. A record
    // the cut pass did not finish stays for the next guardian.
    const recoveryCut = recovering === undefined ? Promise.resolve(false) : Promise.race([recovering.then(() => false), host.sleep(limits.killGraceMs).then(() => true)])
    await Promise.allSettled(closing)
    const [, cut] = await Promise.all([sweep(), recoveryCut])
    if (cut) log.info("guardian exiting before its recovery pass finished; the next guardian reads the records it left", { senderPid: process.pid })
    // The channel is over, so the credential that guarded it has no further
    // use. It is erased rather than left in memory for as long as this process
    // takes to exit.
    if (capability !== undefined) destroyGuardianToken(capability)
  }
}

/** Runs the guardian on this process's standard control streams, and exits
 *  this process when the guardian returns. The exit is what bounds a recovery
 *  pass that the guardian cut: its waits would otherwise keep the process
 *  running past the host's exit deadline. */
export async function runProcessGuardianMain(): Promise<never> {
  // The host drains this stderr and relays each record to its own log, with
  // the guardian that wrote it, so the records go there and to no file.
  await Log.init({ forward: (record) => {
    const line = formatDebugLogLine(record)
    if (line !== null) fs.writeSync(2, line)
  } })
  await runProcessGuardian({
    control: Bun.stdin.stream(),
    // Synchronous fd write, not a stream: each reply reaches the host before
    // the next request mutates guardian state.
    send: (reply) => { fs.writeSync(1, encodeGuardianFrame(reply)) },
    inspect: (ref) => ownedProcessBackend.inspect(ref),
    container: (ref) => ownedProcessBackend.ending(ref),
    escaped: (ref) => markedOutsideGroup(ref.pid, ref.token),
    groupMark: (ref) => groupMarkReading(ref.token, ref.pid),
    forget: (ref) => { ownedProcessBackend.forget(ref) },
    sleep: (ms) => Bun.sleep(ms),
    ...(platformGuardianLedger === undefined ? {} : { ledger: platformGuardianLedger }),
  }, DEFAULT_GUARDIAN_LIMITS)
  process.exit(0)
}

if (import.meta.main) await runProcessGuardianMain()
