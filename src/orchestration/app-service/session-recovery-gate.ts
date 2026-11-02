import { AsyncLocalStorage } from "node:async_hooks"
import { errorMessage } from "../../infra/error-message.js"
import type { AsyncEventStateReadSurface } from "../../infra/event-store-types.js"
import type { EventStoreWriteAdmission } from "../../infra/event-store-writer-lane-types.js"
import { Log } from "../../infra/log.js"

const log = Log.create({ service: "session-recovery-gate" })

/** One session that a dead owner left owing recovery, and how its cut turn
 *  ended: a person's interrupt or an unexpected exit. */
export interface OwedRecovery {
  readonly sessionId: string
  readonly cause: "crash" | "interrupted"
}

export interface SessionRecoveryGate {
  /** Adds sessions that owe recovery. Each one recovers once: at its first
   *  write, or when `settle` names it, whichever comes first. */
  owe(owed: readonly OwedRecovery[]): void
  /** The writer lane's admission: an append that writes an owed session waits
   *  for that session's recovery. Recovery's own writes pass. */
  readonly admission: EventStoreWriteAdmission
  /** Recovers each named session that still owes recovery. */
  settle(sessionIds: readonly string[]): Promise<void>
  /** The sessions that still owe recovery, in the order they were owed. */
  owed(): readonly string[]
}

/** Recovers each owed session exactly once, before any other write lands in
 *  it. A recovery runs inside an async context that names the sessions it
 *  recovers, so the writes it makes to them pass, and a recovery that writes
 *  another owed session, such as a child's into its parent, recovers that
 *  session inside the same context. Independent recoveries run one after
 *  another, so two of them can never wait on each other. A recovery that
 *  fails is reported and releases its session: an unreadable history never
 *  holds a later append (ARCH-SUBSTRATE-013). */
export function createSessionRecoveryGate(recover: (owed: OwedRecovery) => Promise<void>): SessionRecoveryGate {
  const owed = new Map<string, OwedRecovery>()
  const running = new Map<string, { started: boolean; readonly done: Promise<void> }>()
  const recovering = new AsyncLocalStorage<ReadonlySet<string>>()
  let chain: Promise<void> = Promise.resolve()

  async function run(entry: OwedRecovery, inside: ReadonlySet<string>): Promise<void> {
    await recovering.run(new Set([...inside, entry.sessionId]), async () => {
      try {
        await recover(entry)
      } catch (cause) {
        log.warn("session recovery failed; the session stays paused and takes later writes", { sessionId: entry.sessionId, error: errorMessage(cause) })
      } finally {
        owed.delete(entry.sessionId)
      }
    })
  }

  function recoverOnce(sessionId: string): Promise<void> {
    const inside = recovering.getStore()
    const existing = running.get(sessionId)
    // A recovery that writes a session whose own recovery still waits in the
    // chain starts that recovery now, inside its context: the queued run
    // waits for this one, so waiting for it here would never end.
    if (existing && (existing.started || !inside)) return existing.done
    const entry = owed.get(sessionId)
    if (!entry) return existing?.done ?? Promise.resolve()
    const state = { started: inside !== undefined, done: Promise.resolve() }
    if (inside) {
      state.done = run(entry, inside)
    } else {
      // A top-level recovery waits for the one before it, so no two trees of
      // recoveries interleave and none can wait on another.
      state.done = chain.then(async () => {
        if (state.started || !owed.has(sessionId)) return
        state.started = true
        await run(entry, new Set())
      })
      chain = state.done
    }
    running.set(sessionId, state)
    void state.done.finally(() => { if (running.get(sessionId) === state) running.delete(sessionId) })
    return state.done
  }

  /** Recovers the named sessions one at a time: two recoveries that started
   *  together under one context could each write the other and wait forever. */
  async function recoverEach(sessionIds: readonly string[]): Promise<void> {
    for (const sessionId of sessionIds) await recoverOnce(sessionId)
  }

  function pending(sessionIds: readonly string[]): readonly string[] {
    const inside = recovering.getStore()
    return sessionIds.filter((sessionId) => owed.has(sessionId) && !inside?.has(sessionId))
  }

  return {
    owe(entries) {
      for (const entry of entries) if (!owed.has(entry.sessionId)) owed.set(entry.sessionId, entry)
    },
    admission(sessionIds) {
      const waiting = pending(sessionIds)
      return waiting.length === 0 ? null : recoverEach(waiting)
    },
    settle: (sessionIds) => recoverEach(pending(sessionIds)),
    owed: () => [...owed.keys()],
  }
}

/** The session or workflow an aggregate id names, keyed as owed recoveries
 *  are, or none for any other aggregate. */
export function recoveryOwnersOf(aggregateId: string): readonly string[] {
  const match = /^(?:session|workflow):(.+)$/.exec(aggregateId)
  return match?.[1] ? [match[1]] : []
}

/** A reader whose sequence reads settle the session they name first. A caller
 *  reads a sequence to guard a later write, so a recovery that committed
 *  after the read would refuse that write as a concurrent change. The reader
 *  also carries the same settle as `settleBefore`: a sequence read inside an
 *  ordered lane would start a recovery there, and a recovery that needs the
 *  same lane would wait behind its caller forever. */
export function settlingGuardReads<R extends Pick<AsyncEventStateReadSurface, "aggregateSeq" | "settleBefore">>(reader: R, gate: Pick<SessionRecoveryGate, "settle">): R {
  return {
    ...reader,
    async aggregateSeq(aggregateId: string): Promise<number> {
      await gate.settle(recoveryOwnersOf(aggregateId))
      return await reader.aggregateSeq(aggregateId)
    },
    settleBefore: (sessionIds) => gate.settle(sessionIds),
  }
}
