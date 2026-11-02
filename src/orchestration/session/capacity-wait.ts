/**
 * The durable side of a capacity wait (PI-MODEL-039, ARCH-SESSIONS-039).
 *
 * An agent that finds every route spent until a stated time waits for that
 * time and then continues its own turn. Before it waits, it records one
 * continuation row for its session, in the home of the planned-replacement
 * rows, with the time it continues at. The account learns the project's
 * earliest owed time first and acknowledges it, and only then is the row
 * written, so no row exists that the account cannot wake: an account wake
 * with no row finds nothing to continue. The row outlives the process: the
 * executor that serves the project next continues each session that holds
 * one, and the account opens a project that no executor serves at its
 * time.
 *
 * When the time comes, the row stays: the run that continues takes it over,
 * so an exit during the resumed request leaves the wait owed. The end of the
 * turn that continued withdraws it: the run's end, or a chat's park. A
 * person's message, an interrupt, and a Stop withdraw it too; a run
 * that finds the routes still spent arms it again at the next time.
 *
 * Each session holds at most one row: an agent of a workflow holds a row of
 * its own session (`workflow-agent`). The executor's composition registers
 * the one ledger of its event store, which reads the rows once and then
 * keeps them in memory.
 */

import { DebugLog } from "../../infra/debug-log.js"
import { errorMessage } from "../../infra/error-message.js"
import type { AsyncEventStateReadSurface, AsyncEventWriter } from "../../infra/event-store-types.js"
import { Log } from "../../infra/log.js"
import type { SessionNotice } from "../../infra/session-notice.js"
import {
  authorizePlannedSessionContinuation,
  capacityContinuations,
  continuationTargetId,
  readPlannedSessionContinuationAsync,
  retirePlannedSessionContinuation,
  type PlannedContinuationTarget,
} from "./planned-session-continuation.js"

const log = Log.create({ service: "capacity-wait" })

/** Why a capacity wait's authority changed: an agent armed it before it
 *  waited, the account re-armed it after a restart, the account fired it
 *  when its time came, or its wait was withdrawn. */
type CapacityWaitEvent = "armed" | "rearmed" | "fired" | "withdrawn"

/** The one diagnostic record of a capacity wait's authority change. Ids and
 *  times only. */
export function recordCapacityWait(event: CapacityWaitEvent, fields: { readonly sessionId?: string; readonly projectRoot?: string; readonly continuesAt?: number | null; readonly reason?: string }): void {
  DebugLog.record({
    type: "agent.capacity_wait",
    ...(fields.sessionId === undefined ? {} : { sessionId: fields.sessionId }),
    payload: { event, ...fields },
  })
}

/** The one notice of a session's capacity wait, which every client shows
 *  while it waits: the live wait raises it, and a detail read derives it
 *  from the durable row while no run of the session waits (PI-MODEL-039).
 *  One id per session, so the two are the same notice. */
export function capacityWaitNotice(input: { readonly sessionId: string; readonly agentName: string; readonly atMs: number; readonly now: number }): SessionNotice {
  const id = `capacity-wait:${input.sessionId}`
  return {
    id,
    scope: id,
    presentation: "provider.reconnect_progress",
    severity: "warning",
    title: "Waiting for model capacity",
    message: `No provider can run the model of agent "${input.agentName}" now. The agent continues at ${new Date(input.atMs).toLocaleString()}.`,
    wait: { agentName: input.agentName, continuesAt: input.atMs },
    startedAt: input.now,
    updatedAt: input.now,
  }
}

/** How an agent's capacity wait ended: the run that continued it ended, a
 *  person's message continued it, an interrupt cut it, the run's
 *  cancellation ended it, or its continuation was refused. */
export type CapacityWaitWithdrawal = "continued" | "message" | "interrupted" | "cancelled" | "refused"

/** The durable authority of one session's capacity wait. */
export interface CapacityWaitAuthority {
  /** Records that the session owes its continuation at `atMs`, before the
   *  agent waits: the account's wake first, then the row. Resolves once
   *  both are durable. Rejects when either could not be written, and then
   *  no row exists; the agent waits in memory only. */
  arm(atMs: number): Promise<void>
  /** Withdraws the session's capacity row, whether this run armed it or an
   *  earlier executor left it. Never rejects. It does nothing once the
   *  executor's stop began, so the wait outlives the stop. */
  withdraw(reason: CapacityWaitWithdrawal): Promise<void>
  /** Withdraws the session's capacity row as `withdraw` does, but only while
   *  a run of this executor holds the wait: the turn that continued from it
   *  ended. A turn that never continued from the row, such as the park of a
   *  runner that attached after a restart, leaves the wait owed. */
  settle(reason: CapacityWaitWithdrawal): Promise<void>
}

/** What the executor's composition holds of its ledger. */
export interface CapacityWaitLedger {
  /** Whether a run of this executor holds the session's wait now: it armed
   *  the row, or this executor's continuation started the run that owns it. */
  held(sessionId: string): boolean
  /** Marks the session's row as owned by the run its continuation started. */
  hold(sessionId: string): void
  /** Withdraws the session's row with no run of it in this process. */
  retire(sessionId: string, reason: CapacityWaitWithdrawal): Promise<void>
  /** The earliest continue time of the project's capacity rows, or null. */
  wakeAt(): Promise<number | null>
  /** The executor's stop began: from now on no wait is withdrawn, so every
   *  row the stop leaves continues in the next executor. */
  close(): void
  dispose(): void
}

interface CapacityLedger {
  readonly reader: AsyncEventStateReadSurface
  readonly writer: AsyncEventWriter
  readonly recordWake: ((at: number | null) => Promise<void>) | undefined
  /** The continue time of each session's row, read once and then kept. */
  readonly rows: Promise<Map<string, number>>
  readonly held: Set<string>
  /** Row writes of each session, one at a time, in the order they were asked. */
  readonly chains: Map<string, Promise<void>>
  closed: boolean
}

const ledgers = new WeakMap<AsyncEventStateReadSurface, CapacityLedger>()

/** Registers the one capacity ledger of an executor's event store. `store`
 *  is the store every agent's live control registers with; `reader` and
 *  `writer` read and write the continuation rows. `recordWake` tells the
 *  account the project's earliest owed time and resolves once the account
 *  recorded it; absent where no account serves the project. */
export function registerCapacityWaits(store: AsyncEventStateReadSurface, rows: {
  readonly reader: AsyncEventStateReadSurface
  readonly writer: AsyncEventWriter
  readonly recordWake?: (at: number | null) => Promise<void>
}): CapacityWaitLedger {
  let loaded: Promise<Map<string, number>> | undefined
  const ledger: CapacityLedger = {
    reader: rows.reader, writer: rows.writer, recordWake: rows.recordWake,
    // One read of the project's rows, on first use, which every later change advances.
    get rows() {
      loaded ??= capacityContinuations(rows.reader).then((owed) => new Map(owed.map(({ target, continuesAt }) => [continuationTargetId(target), continuesAt] as const)))
      return loaded
    },
    held: new Set(), chains: new Map(), closed: false,
  }
  ledgers.set(store, ledger)
  return {
    held: (sessionId) => ledger.held.has(sessionId),
    hold: (sessionId) => { ledger.held.add(sessionId) },
    retire: (sessionId, reason) => withdraw(ledger, sessionId, reason),
    wakeAt: async () => earliest(await ledger.rows),
    close: () => { ledger.closed = true },
    dispose: () => { if (ledgers.get(store) === ledger) ledgers.delete(store) },
  }
}

/** The authority of the capacity wait of `target`'s session, or undefined
 *  when no ledger is registered for `store`. `runId` is the child run a
 *  `subagent` row continues. */
export function capacityWaitAuthority(
  store: AsyncEventStateReadSurface,
  input: { readonly target: PlannedContinuationTarget; readonly runId?: string },
): CapacityWaitAuthority | undefined {
  const ledger = ledgers.get(store)
  if (!ledger) return undefined
  const sessionId = continuationTargetId(input.target)
  return {
    arm: (atMs) => inChain(ledger, sessionId, async () => {
      const rows = await ledger.rows
      const before = rows.get(sessionId)
      rows.set(sessionId, atMs)
      ledger.held.add(sessionId)
      try {
        await ledger.recordWake?.(earliest(rows))
        const current = await readPlannedSessionContinuationAsync(ledger.reader, sessionId)
        // A replacement's row of the session stays: its successor continues
        // the session, which waits again there.
        if (current?.handoffId === undefined && current?.continuesAt !== atMs) {
          await authorizePlannedSessionContinuation({ reader: ledger.reader, writer: ledger.writer, continuation: { target: input.target, ...(input.runId === undefined ? {} : { runId: input.runId }), continuesAt: atMs } })
        }
      } catch (error) {
        if (before === undefined) rows.delete(sessionId)
        else rows.set(sessionId, before)
        throw error
      }
      recordCapacityWait("armed", { sessionId, continuesAt: atMs })
    }),
    withdraw: (reason) => withdraw(ledger, sessionId, reason),
    settle: (reason) => withdraw(ledger, sessionId, reason, { heldOnly: true }),
  }
}

function earliest(rows: ReadonlyMap<string, number>): number | null {
  return rows.size === 0 ? null : Math.min(...rows.values())
}

function withdraw(ledger: CapacityLedger, sessionId: string, reason: CapacityWaitWithdrawal, options: { readonly heldOnly?: true } = {}): Promise<void> {
  if (ledger.closed) return Promise.resolve()
  return inChain(ledger, sessionId, async () => {
    // Read in the chain, after the arm before it set the hold.
    if (!ledger.held.delete(sessionId) && options.heldOnly) return
    const rows = await ledger.rows
    if (!rows.delete(sessionId)) return
    await retirePlannedSessionContinuation({ reader: ledger.reader, writer: ledger.writer, sessionId, capacity: true })
    recordCapacityWait("withdrawn", { sessionId, reason })
    // A wake later than the account holds is harmless: the account opens
    // the project, which finds nothing owed and reports the time again.
    void ledger.recordWake?.(earliest(rows)).catch((error: unknown) => { log.warn("the account could not record the project's capacity wake", { error: errorMessage(error) }) })
  }).catch((error: unknown) => { log.warn("a capacity wait's row could not be withdrawn", { sessionId, error: errorMessage(error) }) })
}

function inChain(ledger: CapacityLedger, sessionId: string, step: () => Promise<void>): Promise<void> {
  const next = (ledger.chains.get(sessionId) ?? Promise.resolve()).then(step)
  const settled = next.catch(() => {})
  ledger.chains.set(sessionId, settled)
  void settled.then(() => { if (ledger.chains.get(sessionId) === settled) ledger.chains.delete(sessionId) })
  return next
}
