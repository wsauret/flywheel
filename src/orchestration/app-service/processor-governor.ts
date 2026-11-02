import { availableParallelism } from "node:os"
import { containerProcessor, type ContainerProcessor } from "../../infra/container-processor.js"
import { DebugLog } from "../../infra/debug-log.js"
import type { ContainerRef } from "../../infra/process-container.js"
import { heldContainers } from "../../infra/processor-admission.js"
import { coalesceRepeats } from "../../infra/repeat-coalescer.js"
import type { ProjectExecutorCommand, ProjectExecutorEvent } from "./project-executor-protocol.js"

/** One executor generation's complete set of shell containers. */
export type ProcessorClaims = Extract<ProjectExecutorEvent, { kind: "processor_claims" }>["claims"]
/** One executor generation's complete set of held containers. */
export type ProcessorHolds = Extract<ProjectExecutorCommand, { kind: "processor_holds" }>["held"]

/** Short enough that a burst of new heavy work is held within about a second. */
const TICK_MS = 1_000
/** Each reading of runnable threads is one instant, so demand is smoothed
 *  over the last few: a reading counts for this share, the earlier demand for
 *  the rest. */
const DEMAND_WEIGHT = 0.5
/** A container counts only from its second reading, so a short `rg` caught
 *  at one tick is never held. The first reading still seeds the demand in
 *  full: a demand that ramped up from zero would be frozen low by an early
 *  hold, admit too much, and then stop commands that already run. */
const READINGS_TO_COUNT = 2
/** A hold that keeps failing on one container records once in this window. */
const HOLD_FAILURE_WINDOW_MS = 60_000

// Captured at module load, as the other samplers do, so a test that replaces
// the global timers cannot drive the production governor.
const scheduleInterval = setInterval
const cancelInterval = clearInterval

/** The clock of the governor: a repeating timer that returns the function
 *  that cancels it. */
export interface ProcessorGovernorClock {
  readonly every: (run: () => void, ms: number) => () => void
}

/** What one executor generation holds in the governor. */
interface ProcessorAdmissionMember {
  /** The generation's complete current claim set. A container that left
   *  the set is continued if it was held and no other generation claims it. */
  claim(claims: ProcessorClaims): void
  /** Sends the generation the complete held set it was last sent, as its
   *  lifecycle channel asks after a reattach. */
  resend(): void
  /** The generation ended: every container it claimed is continued and
   *  forgotten, and later claims are ignored. */
  leave(): void
}

/** The account's processor admission as an executor generation sees it. */
export interface ProcessorAdmission {
  /** `send` receives the generation's complete held set each time it
   *  changes. */
  join(executor: { readonly projectId: string; readonly generation: number; readonly send: (held: ProcessorHolds) => void }): ProcessorAdmissionMember
}

export interface ProcessorGovernor extends ProcessorAdmission {
  /** Stops the timer and continues every held container. */
  dispose(): void
}

interface Member {
  readonly projectId: string
  readonly generation: number
  readonly send: (held: ProcessorHolds) => void
  claims: ReadonlyMap<string, ProcessorClaims[number]>
  sent: ProcessorHolds
  left: boolean
}

/** The smoothed demand of one container, in runnable threads. */
interface Measure {
  readonly cores: number
  readonly readings: number
}

interface Hold {
  readonly ref: ContainerRef
  readonly order: number
}

type ReleaseReason = "budget" | "claim_ended" | "executor_closed" | "service_stopped"

/** The account's one processor admission (ARCH-TOOLS-051, ARCH-RUNTIME-046).
 *
 *  It serves every project and every executor generation of the account, and
 *  it stops and continues containers itself, so a container that one
 *  generation registered is never left stopped by that generation's end. The
 *  timer runs only while some generation claims a container. */
export function createProcessorGovernor(options: {
  readonly processor?: ContainerProcessor
  readonly clock?: ProcessorGovernorClock
  readonly budget?: number
} = {}): ProcessorGovernor {
  const processor = options.processor ?? containerProcessor()
  const clock = options.clock ?? systemClock
  const budget = options.budget ?? availableParallelism()
  const members = new Set<Member>()
  const measures = new Map<string, Measure>()
  const held = new Map<string, Hold>()
  let cancelTick: (() => void) | undefined

  const failures = coalesceRepeats<{ readonly member: Member; readonly cores: number }>({
    windowMs: HOLD_FAILURE_WINDOW_MS,
    first: (token, { member, cores }) => {
      DebugLog.record({ type: "runtime.processor_admission.hold_failed", payload: { projectId: member.projectId, generation: member.generation, token, cores: rounded(cores), budget } })
    },
    repeated: (token, repeats) => {
      DebugLog.record({ type: "runtime.processor_admission.hold_failed", payload: { token, repeats: repeats.count, windowMs: repeats.windowMs, budget } })
    },
  })

  /** Every live claim by token. During a handover the old and the new
   *  generation can both claim one container, and either one serves. */
  const claimed = (): Map<string, { readonly claim: ProcessorClaims[number]; readonly member: Member }> => {
    const all = new Map<string, { readonly claim: ProcessorClaims[number]; readonly member: Member }>()
    for (const member of members) for (const claim of member.claims.values()) if (!all.has(claim.token)) all.set(claim.token, { claim, member })
    return all
  }

  const record = (type: "runtime.processor_admission.held" | "runtime.processor_admission.released", member: Pick<Member, "projectId" | "generation"> | undefined, token: string, fields: { readonly reason?: ReleaseReason }): void => {
    DebugLog.record({
      type,
      payload: {
        ...(member === undefined ? {} : { projectId: member.projectId, generation: member.generation }),
        token, cores: rounded(measures.get(token)?.cores ?? 0), budget, waiting: held.size, ...fields,
      },
    })
  }

  /** Continues a held container whose last claim is gone and drops what the
   *  governor knew of it. */
  const forget = (token: string, member: Member, reason: ReleaseReason): void => {
    for (const other of members) if (other.claims.has(token)) return
    failures.end(token)
    const hold = held.get(token)
    if (hold !== undefined) {
      processor.release(hold.ref)
      held.delete(token)
      record("runtime.processor_admission.released", member, token, { reason })
    }
    measures.delete(token)
  }

  /** Sends each generation whose held set changed its complete new set. A
   *  release changes `ahead` for every newer held container, of every
   *  project. */
  const publish = (): void => {
    const queue = [...held].sort(([, a], [, b]) => a.order - b.order)
    const ahead = new Map(queue.map(([token], index) => [token, index]))
    for (const member of members) {
      const next: ProcessorHolds = [...member.claims.keys()].flatMap((token) => {
        const position = ahead.get(token)
        return position === undefined ? [] : [{ token, ahead: position }]
      }).sort((a, b) => a.ahead - b.ahead)
      if (sameHolds(member.sent, next)) continue
      member.sent = next
      member.send(next)
    }
  }

  const stopTicking = (): void => {
    cancelTick?.()
    cancelTick = undefined
  }

  const tick = (): void => {
    const claims = claimed()
    if (claims.size === 0) {
      stopTicking()
      return
    }
    const readings = processor.demand([...claims.values()].map(({ claim }) => ({ token: claim.token, pid: claim.pid })))
    for (const [token, threads] of readings) {
      // A held container runs nothing, so it keeps the demand it had before
      // its hold: that is what it would ask for again once released.
      if (held.has(token)) continue
      const last = measures.get(token)
      measures.set(token, last === undefined
        ? { cores: threads, readings: 1 }
        : { cores: last.cores * (1 - DEMAND_WEIGHT) + threads * DEMAND_WEIGHT, readings: last.readings + 1 })
    }
    const demand = (token: string): number => {
      const measure = measures.get(token)
      return measure === undefined || measure.readings < READINGS_TO_COUNT ? 0 : measure.cores
    }
    const wanted = heldContainers([...claims.values()].map(({ claim }) => ({ id: claim.token, order: claim.order, exempt: claim.exempt, cores: demand(claim.token) })), budget)
    const holds: string[] = []
    const releases: string[] = []
    for (const token of wanted) {
      const entry = claims.get(token)
      if (entry === undefined || held.has(token)) continue
      const ref = { token, pid: entry.claim.pid }
      if (processor.hold(ref)) {
        held.set(token, { ref, order: entry.claim.order })
        holds.push(token)
      } else {
        failures.observe(token, { member: entry.member, cores: measures.get(token)?.cores ?? 0 })
      }
    }
    for (const [token, hold] of held) {
      if (wanted.has(token)) continue
      processor.release(hold.ref)
      held.delete(token)
      failures.end(token)
      releases.push(token)
    }
    // Recorded once every decision of the tick is made, so each record
    // states how many containers wait after it.
    for (const token of holds) record("runtime.processor_admission.held", claims.get(token)?.member, token, {})
    for (const token of releases) record("runtime.processor_admission.released", claims.get(token)?.member, token, { reason: "budget" })
    if (holds.length + releases.length > 0) publish()
  }

  return {
    join(executor) {
      const member: Member = { projectId: executor.projectId, generation: executor.generation, send: executor.send, claims: new Map(), sent: [], left: false }
      members.add(member)
      return {
        claim(claims) {
          if (member.left) return
          const previous = member.claims
          const known = claimed()
          member.claims = new Map(claims.map((claim) => [claim.token, claim]))
          // A governor that ended without releasing, such as a service that
          // crashed, can have left a container stopped that an executor now
          // claims again. Continuing a running container does nothing, so
          // every container new to this governor is continued once.
          for (const claim of claims) if (!known.has(claim.token)) processor.release({ token: claim.token, pid: claim.pid })
          for (const token of previous.keys()) if (!member.claims.has(token)) forget(token, member, "claim_ended")
          if (member.claims.size > 0 && cancelTick === undefined) cancelTick = clock.every(tick, TICK_MS)
          publish()
        },
        resend: () => { member.send(member.sent) },
        leave() {
          if (member.left) return
          member.left = true
          members.delete(member)
          const claims = member.claims
          member.claims = new Map()
          for (const token of claims.keys()) forget(token, member, "executor_closed")
          publish()
          if (claimed().size === 0) stopTicking()
        },
      }
    },
    dispose() {
      stopTicking()
      for (const [token, hold] of held) {
        processor.release(hold.ref)
        held.delete(token)
        record("runtime.processor_admission.released", undefined, token, { reason: "service_stopped" })
      }
      failures.end()
      measures.clear()
      for (const member of members) member.left = true
      members.clear()
    },
  }
}

const systemClock: ProcessorGovernorClock = {
  every(run, ms) {
    const timer = scheduleInterval(run, ms)
    // Admission never holds the account service open.
    timer.unref()
    return () => cancelInterval(timer)
  },
}

function rounded(cores: number): number {
  return Math.round(cores * 100) / 100
}

function sameHolds(a: ProcessorHolds, b: ProcessorHolds): boolean {
  return a.length === b.length && a.every((hold, index) => hold.token === b[index]?.token && hold.ahead === b[index]?.ahead)
}
