/**
 * The recovery policy of one run that continues without a person: an agent
 * of a workflow, a subagent child, or a headless task, which runs with no
 * person at the keyboard, and a chat's turn, which only waits for model
 * capacity (PI-MODEL-039). It is the `recover` hook of the run's turns
 * (`runWithResilience`) and decides, after each run that failed, whether the
 * run continues from its recorded conversation. The provider walk owns every
 * retry and failover inside one request; this policy owns only that decision.
 * A chat lets every other failure stand, as before: a person decides there
 * whether to send again.
 *
 * - A fault that needs a person ends the run: a request the provider
 *   rejected, a refused credential or grant, a model that the profile does
 *   not configure, a content refusal that the run could not repair, a context
 *   overflow.
 * - A failure that a limit of the run ended stands: an output overflow ends
 *   only after the agent loop spent its continuation limit, and a run again
 *   would grant that limit again (PI-AGENT-023).
 * - A wait that a known event ends is not an attempt. When the walk found no
 *   candidate and every candidate that waiting can help states when it serves
 *   again, the run waits until then, judged by the wall clock, so a machine
 *   that slept through the time continues when it wakes. As it starts to
 *   wait, a run that a project executor serves arms its durable capacity
 *   wait (`capacity-wait.ts`), so the wait survives the process; a headless
 *   task's wait lives and ends with its own process. When the time comes, the run that continues keeps
 *   the wait armed until it ends (`settle`), so an exit during its first
 *   request leaves the wait owed; a run that finds the routes still spent
 *   arms it again at the next time. A person's message, an interrupt, and
 *   the run's cancellation withdraw it at once. When the model's access is pending, the
 *   run waits until the profile's access audit settles, and then takes the
 *   counted rule below.
 * - Any other fault can clear. The run continues after a pause of 5 s, 10 s,
 *   20 s, 40 s, 80 s, and 160 s, and the seventh fault in a row ends it. A run
 *   that served a model request starts the count over, so only six fresh
 *   attempts in a row with no served request end the run.
 *
 * A wait shows as one status notice that names the agent and when it
 * continues, and only the end of that wait removes it. It has no action: the
 * agent needs nothing from the person. An interrupt ends the wait, and the
 * next run opens interrupted, so the agent parks as an interrupted agent does.
 * The run's cancellation ends the wait, and the turn ends aborted.
 */

import { abortableSleep, mergeAbortSignals } from "../../infra/abort.js"
import type { TurnParkState } from "../../infra/agent-loop-events.js"
import { DebugLog } from "../../infra/debug-log.js"
import { errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import type { SessionNotice, SessionNoticeOperation } from "../../infra/session-notice.js"
import { sleepUntil } from "../../infra/wall-clock-sleep.js"
import { capacityWaitNotice, type CapacityWaitAuthority, type CapacityWaitWithdrawal } from "../session/capacity-wait.js"
import type { TurnInterruption } from "../session/conversation/turn-end-record.js"
import type { DeliveryOutcome } from "../session/live-session-control.js"
import { CONTINUATION_MESSAGES } from "./continuation-messages.js"
import type { AgentFailureReason, AgentRunResult } from "./types.js"

/** How many fresh attempts in a row with no served request a run makes
 *  before its failure stands. */
const UNATTENDED_ATTEMPT_LIMIT = 6

/** The pause before the first fresh attempt. Each later pause doubles it. */
const FIRST_PAUSE_MS = 5_000

/** The longest that a wait for the model's access audit lasts before the
 *  run asks the providers again. */
export const WAIT_LIMIT_MS = 6 * 60 * 60 * 1000

const log = Log.create({ service: "unattended-recovery" })

interface UnattendedRecoveryDeps {
  readonly sessionId: string
  /** The notice scope and diagnostic id: the attempt id, the child run id, or
   *  the headless conversation id. */
  readonly runId: string
  readonly caller: "workflow-agent" | "subagent" | "headless" | "chat"
  /** The agent's name, which the wait notice states. */
  readonly agentName: string
  readonly onNotice: (operation: SessionNoticeOperation) => void
  /** Resolves when the profile's model discovery, its access audit included,
   *  has settled; rejects when it fails or its signal aborts. Absent for a
   *  chat, whose recovery waits only for capacity. */
  readonly awaitAccessSettled?: (signal: AbortSignal) => Promise<void>
  /** Holds the caller's own liveness watchdog open for the length of a wait,
   *  and returns its release. */
  readonly holdAlive?: () => () => void
  /** The durable authority of the run's capacity waits. Absent where no
   *  executor serves the project: the wait then lives in memory only. */
  readonly capacity?: CapacityWaitAuthority
  readonly now?: () => number
  /** Resolves after `ms`, or at once when `signal` aborts. */
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

type NextRun = { readonly requestContext?: string }

interface UnattendedRecovery {
  /** The `recover` hook of the run's turns: the request context of the next
   *  run, or null when the failure stands. `servedRequests` is the progress of
   *  the run that failed, and `signal` the run's effective cancellation, which
   *  ends every wait. */
  recover(failure: AgentFailureReason, servedRequests: number, signal: AbortSignal): Promise<NextRun | null>
  /** Ends the wait that runs now, for an interrupt by `by`. False when no
   *  wait runs. */
  cutWait(by: TurnInterruption): boolean
  /** Ends the capacity wait that runs now for a person's message, and the
   *  run continues at once with it. False when no capacity wait runs. */
  continueNow(): boolean
  /** The interrupt that ended the last wait, once: the run after the wait
   *  opens interrupted by it. */
  takeCutInterrupt(): TurnInterruption | undefined
  /** The run's turns ended with `result`: the capacity wait that the run
   *  continued from, in this process or an earlier one, is withdrawn. */
  settle(result: Pick<AgentRunResult, "terminal">): Promise<void>
  /** A chat's turn parked as `park`: a chat's runner outlives its turns, so
   *  its park, not the run's end, ends the turn that continued from a
   *  capacity wait, and that wait is withdrawn. */
  parked(park: TurnParkState): Promise<void>
}

/** How a wait ended: at its time or end event, at the interrupt of
 *  `cutWait`, at the run's cancellation, at a rejected end event, or at a
 *  person's message (`continueNow`). */
type WaitEnd = "ended" | "cut" | "cancelled" | "rejected" | "message"

/** What one wait does besides waiting for its time. */
interface WaitPlan {
  /** States the wait while it runs. */
  readonly notice?: (nextAttemptAt: number, delayMs: number) => SessionNotice
  /** An event that ends the wait before its time. */
  readonly until?: (signal: AbortSignal) => Promise<void>
  /** Reads the wall clock, so a machine that slept through the time
   *  continues when it wakes; a pause runs one timer. */
  readonly wallClock?: boolean
}

/** The withdrawal that an end of a capacity wait records, or undefined
 *  when its time came: the run that continues keeps the wait armed. */
function withdrawalOf(end: WaitEnd): CapacityWaitWithdrawal | undefined {
  switch (end) {
    case "ended":
    case "rejected": return undefined
    case "message": return "message"
    case "cut": return "interrupted"
    case "cancelled": return "cancelled"
  }
}

export function createUnattendedRecovery(deps: UnattendedRecoveryDeps): UnattendedRecovery {
  const now = deps.now ?? Date.now
  // The wait ends early when its signal aborts, which is the expected end of
  // a cut wait, so that rejection is the wait's end and not a failure.
  const sleep = deps.sleep ?? ((ms: number, signal: AbortSignal) => abortableSleep(ms, signal).catch(() => undefined))
  // Live notice state only: each run has a scope of its own, which only the
  // end of its wait resolves, because one session holds the notices of many
  // agents and each healthy request resolves the whole provider scope.
  const scope = `unattended:wait:${deps.runId}`
  let streak = 0
  let served = 0
  interface Wait { readonly controller: AbortController; cutBy: TurnInterruption | undefined; message: boolean }
  let waiting: Wait | null = null
  let capacityWaiting = false
  let cutInterrupt: TurnInterruption | undefined
  // The arms whose answer from the account is outstanding. The ledger
  // applies a withdrawal after the arm before it, so while one is
  // outstanding a withdrawal is issued in order and not awaited: the run
  // never waits for the account's answer.
  let armsOutstanding = 0
  const awaitWithdrawal = async (withdrawn: Promise<void> | undefined): Promise<void> => {
    if (armsOutstanding === 0) await withdrawn
  }

  // One INFO record per decision, with ids, kinds, and counts only.
  const record = (decision: "wait" | "interrupted" | "restart" | "fail", failure: AgentFailureReason, delayMs?: number): void => {
    DebugLog.record({
      type: "agent.unattended.recovery",
      sessionId: deps.sessionId,
      payload: { caller: deps.caller, runId: deps.runId, decision, failure: failure.kind, streak, ...(delayMs === undefined ? {} : { delayMs }), served },
    })
  }

  /** Waits from `startedAt` until `atMs`, or until the plan's `until`
   *  settles first. The caller reads the clock once for both, so a pause
   *  lasts exactly its span. */
  async function wait(failure: AgentFailureReason, signal: AbortSignal, startedAt: number, atMs: number, plan: WaitPlan = {}): Promise<WaitEnd> {
    const { notice, until, wallClock = false } = plan
    const nextAttemptAt = Math.max(startedAt, atMs)
    const delayMs = nextAttemptAt - startedAt
    const current: Wait = { controller: new AbortController(), cutBy: undefined, message: false }
    const waitSignal = mergeAbortSignals(current.controller.signal, signal)
    waiting = current
    const release = deps.holdAlive?.()
    const shown = notice?.(nextAttemptAt, delayMs)
    if (shown) deps.onNotice({ type: "upsert", notice: shown })
    let end: WaitEnd = "ended"
    try {
      const elapsed = wallClock ? sleepUntil(nextAttemptAt, waitSignal, { now, sleep }) : sleep(delayMs, waitSignal)
      if (until) {
        const settled = until(waitSignal).then((): WaitEnd => "ended", (): WaitEnd => "rejected")
        end = await Promise.race([elapsed.then((): WaitEnd => "ended"), settled])
      } else await elapsed
    } finally {
      waiting = null
      // Ends whichever of the time and the end event is still pending.
      current.controller.abort()
      if (shown) deps.onNotice({ type: "resolve", id: shown.id })
      release?.()
    }
    // A cut decides before the run's cancellation: a chat's interrupt cuts
    // the wait and then cancels the turn, and the turn end names the cut.
    if (current.cutBy !== undefined) {
      cutInterrupt = current.cutBy
      record("interrupted", failure)
      return "cut"
    }
    if (signal.aborted) return "cancelled"
    if (current.message) return "message"
    return end
  }

  async function freshAttempt(failure: AgentFailureReason, signal: AbortSignal): Promise<NextRun | null> {
    streak += 1
    if (streak > UNATTENDED_ATTEMPT_LIMIT) {
      record("fail", failure)
      return null
    }
    const delayMs = FIRST_PAUSE_MS * 2 ** (streak - 1)
    record("restart", failure, delayMs)
    const count = streak
    const startedAt = now()
    await wait(failure, signal, startedAt, startedAt + delayMs, {
      notice: (nextAttemptAt, waitMs) => ({
        id: scope,
        scope,
        presentation: "provider.reconnect_progress",
        severity: "warning",
        title: "Recovering from a provider fault",
        message: `The model request of agent "${deps.agentName}" failed. The agent continues at ${new Date(nextAttemptAt).toLocaleString()}.`,
        retry: { count, delayMs: waitMs, nextAttemptAt },
        startedAt: now(),
        updatedAt: now(),
      }),
    })
    return failure.kind === "stream_stalled" ? { requestContext: CONTINUATION_MESSAGES.stream_stalled } : {}
  }

  /** Waits for the capacity the walk stated while its durable authority is
   *  armed, so the wait reaches its time also while the account's answer to
   *  the arm is outstanding. A row that cannot be written leaves the wait in
   *  memory: continuing wins over a refused write. */
  async function capacityWait(failure: AgentFailureReason, atMs: number, signal: AbortSignal): Promise<NextRun> {
    record("wait", failure, Math.max(0, atMs - now()))
    let end: WaitEnd = "cancelled"
    if (deps.capacity) {
      armsOutstanding += 1
      void deps.capacity.arm(atMs).catch((error: unknown) => {
        log.warn("a capacity wait could not be armed; it waits in memory only", { sessionId: deps.sessionId, runId: deps.runId, error: errorMessage(error) })
      }).finally(() => { armsOutstanding -= 1 })
    }
    capacityWaiting = true
    try {
      end = await wait(failure, signal, now(), atMs, {
        notice: (nextAttemptAt) => capacityWaitNotice({ sessionId: deps.sessionId, agentName: deps.agentName, atMs: nextAttemptAt, now: now() }),
        wallClock: true,
      })
    } finally {
      capacityWaiting = false
      const withdrawal = withdrawalOf(end)
      if (withdrawal !== undefined) await awaitWithdrawal(deps.capacity?.withdraw(withdrawal))
    }
    return {}
  }

  async function accessWait(failure: AgentFailureReason, awaitAccessSettled: (signal: AbortSignal) => Promise<void>, signal: AbortSignal): Promise<NextRun | null> {
    record("wait", failure)
    const startedAt = now()
    const end = await wait(failure, signal, startedAt, startedAt + WAIT_LIMIT_MS, { until: awaitAccessSettled })
    if (end === "cancelled") return null
    if (end === "cut") return {}
    return await freshAttempt(failure, signal)
  }

  return {
    async recover(failure, servedRequests, signal) {
      served = servedRequests
      if (servedRequests > 0) streak = 0
      if (deps.caller === "chat") {
        return failure.kind === "api_error" && failure.recovery.kind === "at"
          ? await capacityWait(failure, failure.recovery.atMs, signal)
          : null
      }
      switch (failure.kind) {
        case "api_error":
          switch (failure.recovery.kind) {
            case "at": return await capacityWait(failure, failure.recovery.atMs, signal)
            case "retry": return await freshAttempt(failure, signal)
            case "none": break
          }
          break
        case "stream_stalled":
        case "transient_disconnect":
        case "api_overloaded":
          return await freshAttempt(failure, signal)
        case "model_unavailable":
          if (failure.missing === "access" && deps.awaitAccessSettled) return await accessWait(failure, deps.awaitAccessSettled, signal)
          break
      }
      record("fail", failure)
      return null
    },
    cutWait(by) {
      if (waiting === null || waiting.controller.signal.aborted) return false
      waiting.cutBy = by
      waiting.controller.abort()
      return true
    },
    continueNow() {
      if (waiting === null || !capacityWaiting || waiting.controller.signal.aborted) return false
      waiting.message = true
      waiting.controller.abort()
      return true
    },
    takeCutInterrupt() {
      const by = cutInterrupt
      cutInterrupt = undefined
      return by
    },
    async settle(result) {
      await awaitWithdrawal(deps.capacity?.settle(result.terminal.kind === "aborted" ? "cancelled" : "continued"))
    },
    async parked(park) {
      await awaitWithdrawal(deps.capacity?.settle(park === "interrupted" ? "interrupted" : "continued"))
    },
  }
}

/** `deliver` that also ends the recovery's capacity wait when it accepts a
 *  person's message, so the turn starts at once with it (PI-MODEL-039). A
 *  message of another session leaves the wait as it is. */
export function endingCapacityWaitOnPersonMessage<M extends { readonly producer?: { readonly kind: string } }, D>(
  recovery: Pick<UnattendedRecovery, "continueNow">,
  deliver: (message: M, decide: D) => Promise<DeliveryOutcome>,
): (message: M, decide: D) => Promise<DeliveryOutcome> {
  return async (message, decide) => {
    const outcome = await deliver(message, decide)
    return outcome.status !== "refused" && message.producer?.kind !== "session" && recovery.continueNow() ? { status: "delivered", startsTurn: true } : outcome
  }
}
