import { errorDetail, errorMessage } from "../../infra/error-message.js"
import { Log } from "../../infra/log.js"
import { durationMs, logCompletion } from "../../infra/operation-log.js"
import { PROCESS_KILL_GRACE_MS } from "../../infra/process-supervisor.js"

/** The one runtime shutdown order. Owners inside a phase are independent: their
 *  interruption is requested together and every one of their settlements is
 *  joined before the next phase is asked for anything. */
const RUNTIME_SHUTDOWN_PHASES = [
  "stop-runners",
  "flush-durable-state",
  "dispose-availability",
  "drain-clients",
  "close-client-streams",
  "release-state",
] as const

export type RuntimeShutdownPhase = (typeof RUNTIME_SHUTDOWN_PHASES)[number]

/** Diagnostic only. When a phase has been settling for this long the barrier
 *  logs the owners it still waits for and repeats their interruption request.
 *  It never resolves a join, so it is not a deadline that anything survives by
 *  being slow: the owner alone reports that it is settled. */
const RUNTIME_SHUTDOWN_DIAGNOSTIC_INTERVAL_MS = 5_000
const RUNTIME_SHUTDOWN_SETTLEMENT_GRACE_MS = 5_000
/** The process-wide bound on the whole shutdown handshake. It belongs to a
 *  watchdog outside the barrier: a barrier that cannot reach settlement is
 *  ended by the process going away, never by the barrier abandoning an owner.
 *  A project executor arms its own hard exit with it when it starts to stop. */
export const RUNTIME_SHUTDOWN_HANDSHAKE_TIMEOUT_MS = RUNTIME_SHUTDOWN_DIAGNOSTIC_INTERVAL_MS * RUNTIME_SHUTDOWN_PHASES.length + RUNTIME_SHUTDOWN_SETTLEMENT_GRACE_MS

// The shutdown bounds nest, each one derived from the one inside it, so an
// outer owner never ends an inner shutdown that its own bound still allows:
// a project executor's own hard exit, then the account's wait for that
// executor, then the account's own drain, which stays under the 60 s stop
// timeout that the launchd and systemd registrations give the service.

/** A terminal client's own hard-exit bound, armed when it starts to stop. */
export const RUNTIME_SHUTDOWN_HARD_EXIT_MS = RUNTIME_SHUTDOWN_HANDSHAKE_TIMEOUT_MS + RUNTIME_SHUTDOWN_SETTLEMENT_GRACE_MS
/** How long the executor's answer to a stop, or its exit, takes to reach the
 *  account after the executor's own shutdown has ended. */
const EXECUTOR_EXIT_PROOF_GRACE_MS = 5_000
/** How long the account waits for a project executor it asked to stop: the
 *  executor's own hard-exit bound and the grace for its answer, so the
 *  account never cuts a flush that the executor's bound still allows. */
export const PROJECT_EXECUTOR_STOP_DEADLINE_MS = RUNTIME_SHUTDOWN_HANDSHAKE_TIMEOUT_MS + EXECUTOR_EXIT_PROOF_GRACE_MS
/** What the account's drain allows after a stop that passed its deadline,
 *  beyond the kill grace: the proof that the kill emptied the executor's
 *  container, that generation's recovery, and the later drain phases. */
const EXECUTOR_RECOVERY_ALLOWANCE_MS = 10_000
/** The account service's own hard-exit bound, armed when its drain starts.
 *  It holds the executor stop deadline, the kill grace of a stop that
 *  missed it, and the recovery allowance. A process that waits for a
 *  predecessor account service to exit waits this long before it treats it
 *  as wedged. */
export const ACCOUNT_DRAIN_HARD_EXIT_MS = PROJECT_EXECUTOR_STOP_DEADLINE_MS + PROCESS_KILL_GRACE_MS + EXECUTOR_RECOVERY_ALLOWANCE_MS

/** One resource owner's participation in the barrier.
 *
 *  requestInterruption asks the owner to stop and returns as soon as the
 *  request is delivered; it MUST be idempotent while the owner is settling,
 *  because the diagnostic interval repeats it then. A throw or rejection means
 *  the owner was never asked, which blocks the later phases. A request after
 *  a settlement that rejected is a later barrier run asking the owner again.
 *
 *  settled is the owner's stable settlement join: the same settlement on every
 *  call until a request asks again, resolved by the owner when its work is
 *  settled and rejected when it ended unsafely. The barrier never resolves it
 *  and never abandons it. */
export interface RuntimeShutdownOwner {
  readonly owner: string
  requestInterruption(): void | Promise<void>
  settled(): Promise<void>
}

/** Adapts one idempotent asynchronous teardown to the owner protocol: the first
 *  interruption request starts it, a repeated request joins the same work, and
 *  settled() is that single settlement. A teardown that throws or rejects is the
 *  owner reporting an unsafe end, so it surfaces through settled() (where the
 *  barrier blocks the later phases) rather than as an undelivered request.
 *  Such a settlement stays the answer of the run that saw it; the next
 *  request, which only a later run makes, starts the teardown again. */
export function shutdownOwner(owner: string, stop: () => Promise<void>): RuntimeShutdownOwner {
  let settlement: Promise<void> | null = null
  let rejected = false
  const start = (): Promise<void> => {
    if (settlement === null) {
      const run = Promise.resolve().then(stop)
      run.catch(() => { if (settlement === run) rejected = true })
      settlement = run
    }
    return settlement
  }
  return {
    owner,
    requestInterruption: () => {
      if (rejected) {
        rejected = false
        settlement = null
      }
      void start().catch(() => {})
    },
    settled: start,
  }
}

export interface RuntimeShutdownRequest {
  /** Closes admission, before any interruption is requested: work that is
   *  never admitted has nothing to interrupt and nothing to settle. */
  readonly closeAdmission?: () => void
  readonly owners: Readonly<RuntimeShutdownOwners>
  readonly diagnosticIntervalMs?: number
  /** Injected diagnostic timer (default setTimeout), so a test fires the
   *  interval deterministically without sleeping. */
  readonly setDiagnosticTimer?: (fire: () => void, delayMs: number) => () => void
}

type RuntimeShutdownFailure =
  | { readonly kind: "interruption-request-failed"; readonly owner: string; readonly error: unknown }
  | { readonly kind: "settled-unsafe"; readonly owner: string; readonly error: unknown }

/** settled: every phase's owners settled safely, in order. blocked: the named
 *  phase reported at least one unsafe outcome, so no later phase was asked for
 *  anything. A run that reaches neither stays pending: non-settlement is not an
 *  outcome the barrier invents on an owner's behalf. */
export type RuntimeShutdownResult =
  | { readonly kind: "settled" }
  | { readonly kind: "blocked"; readonly phase: RuntimeShutdownPhase; readonly failures: readonly RuntimeShutdownFailure[] }

interface RuntimeShutdownLogFields {
  [field: string]: unknown
}

export interface RuntimeShutdownOwners {
  [phase: string]: readonly RuntimeShutdownOwner[] | undefined
}

export interface AccountShutdownRequest {
  readonly closeAdmission: () => void
  readonly joinOpenings: () => Promise<void>
  readonly flushWriters: () => Promise<void>
  readonly projectBarriers: readonly (() => Promise<void>)[]
  readonly closeSharedResources: () => Promise<void>
}

export type AccountShutdownResult =
  | { readonly kind: "settled" }
  | { readonly kind: "blocked"; readonly stage: "join-openings" | "flush-writers" | "project-barriers" | "shared-resources"; readonly error: unknown }

/** Closes account admission, settles construction and writes, then releases
 * project generations before the process-scoped resources they borrow. */
export async function runAccountShutdownBarrier(request: AccountShutdownRequest): Promise<AccountShutdownResult> {
  request.closeAdmission()
  const stages = [
    ["join-openings", request.joinOpenings],
    ["flush-writers", request.flushWriters],
    // Each project closes to its own bound: one that fails is reported only
    // once every sibling has settled, so no sibling's stop is cut short.
    ["project-barriers", async () => {
      const outcomes = await Promise.allSettled(request.projectBarriers.map((barrier) => barrier()))
      const failures = outcomes.flatMap((outcome) => outcome.status === "rejected" ? [outcome.reason] : [])
      if (failures.length > 0) throw new AggregateError(failures, `Some projects did not close: ${failures.map(errorMessage).join("; ")}`)
    }],
    ["shared-resources", request.closeSharedResources],
  ] as const
  for (const [stage, settle] of stages) {
    try {
      await settle()
    } catch (error) {
      return { kind: "blocked", stage, error }
    }
  }
  return { kind: "settled" }
}

const log = Log.create({ service: "runtime-shutdown" })

/** One run per request value. A caller that gives up waiting cancels nothing,
 *  and concurrent callers join the run that is already interrupting the owners
 *  rather than starting a second one over the same resources. A run that ended
 *  blocked is not kept: the next call asks every owner that did not settle
 *  again, and joins the settlements of the owners that did. */
const runs = new WeakMap<RuntimeShutdownRequest, Promise<RuntimeShutdownResult>>()

/** Single source of truth for runtime shutdown: admission closes, then each
 *  ordered phase requests interruption for its independent owners and joins
 *  every settlement. The barrier advances only on a settled phase, so an
 *  unsafe or unsettled owner blocks the later phases instead of letting the
 *  teardown run over resources that are still live. */
export function runRuntimeShutdownBarrier(request: RuntimeShutdownRequest): Promise<RuntimeShutdownResult> {
  const running = runs.get(request)
  if (running) return running
  const pending = Promise.withResolvers<RuntimeShutdownResult>()
  runs.set(request, pending.promise)
  void driveBarrier(request).then((result) => {
    if (result.kind === "blocked") runs.delete(request)
    pending.resolve(result)
  }, pending.reject)
  return pending.promise
}

/** A phase that takes this long holds the process's exit where a person
 *  waits for it, so its completion records at the default level. */
const SLOW_SHUTDOWN_PHASE_MS = 2_000

async function driveBarrier(request: RuntimeShutdownRequest): Promise<RuntimeShutdownResult> {
  const start = performance.now()
  log.debug("shutdown barrier start")
  request.closeAdmission?.()
  // The barrier's one record carries every phase it ran; the owner that asked
  // for the shutdown records why.
  const phases: { readonly phase: RuntimeShutdownPhase; readonly durationMs: number }[] = []
  for (const phase of RUNTIME_SHUTDOWN_PHASES) {
    const owners = request.owners[phase] ?? []
    if (owners.length === 0) continue
    const phaseStart = performance.now()
    const failures = await settlePhase(phase, owners, request)
    phases.push({ phase, durationMs: durationMs(phaseStart) })
    if (failures.length > 0) {
      log.error("shutdown barrier blocked", { phase, durationMs: durationMs(start), phases, failures: failures.map(describeFailure) })
      return { kind: "blocked", phase, failures }
    }
  }
  log.info("shutdown barrier settled", { durationMs: durationMs(start), phases })
  return { kind: "settled" }
}

async function settlePhase(
  phase: RuntimeShutdownPhase,
  owners: readonly RuntimeShutdownOwner[],
  request: RuntimeShutdownRequest,
): Promise<readonly RuntimeShutdownFailure[]> {
  const start = performance.now()
  const failures: RuntimeShutdownFailure[] = []
  const awaiting = new Set<RuntimeShutdownOwner>(owners)
  const disarmDiagnostic = armDiagnostic(phase, awaiting, request)
  try {
    await Promise.all(owners.map(async (owner) => {
      try {
        await owner.requestInterruption()
      } catch (err) {
        failures.push({ kind: "interruption-request-failed", owner: owner.owner, error: err })
      }
    }))
    // A failed request does not prove the owner stayed live or stopped. Its stable
    // settlement is still the only settlement boundary, so every owner is joined.
    await Promise.all(owners.map(async (owner) => {
      try {
        await owner.settled()
      } catch (err) {
        failures.push({ kind: "settled-unsafe", owner: owner.owner, error: err })
      } finally {
        awaiting.delete(owner)
      }
    }))
  } finally {
    disarmDiagnostic()
  }
  logCompletion(log, "shutdown phase done", { phase, owners: owners.map((owner) => owner.owner), failures: failures.length }, { durationMs: durationMs(start), slowMs: SLOW_SHUTDOWN_PHASE_MS })
  return failures
}

/** Repeats the interruption request for the owners a phase still waits for.
 *  Re-armed after every fire, because an owner that ignored one request may
 *  still observe the next, and disarmed when the phase's joins are done. */
function armDiagnostic(
  phase: RuntimeShutdownPhase,
  awaiting: ReadonlySet<RuntimeShutdownOwner>,
  request: RuntimeShutdownRequest,
): () => void {
  const delayMs = request.diagnosticIntervalMs ?? RUNTIME_SHUTDOWN_DIAGNOSTIC_INTERVAL_MS
  const setTimer = request.setDiagnosticTimer ?? ((fire, ms) => {
    const handle = setTimeout(fire, ms)
    return () => clearTimeout(handle)
  })
  let cancel: (() => void) | null = null
  const arm = (): void => {
    cancel = setTimer(() => {
      cancel = null
      const stalled = [...awaiting]
      if (stalled.length === 0) return
      log.warn("shutdown phase still settling; repeating the interruption request", { phase, delayMs, owners: stalled.map((owner) => owner.owner) })
      for (const owner of stalled) repeatInterruptionRequest(phase, owner)
      arm()
    }, delayMs)
  }
  arm()
  return () => { cancel?.(); cancel = null }
}

/** The outcome is already owned by the first request and the settlement join, so
 *  a repeat that fails changes nothing and is logged rather than reported. */
function repeatInterruptionRequest(phase: RuntimeShutdownPhase, owner: RuntimeShutdownOwner): void {
  const onFailure = (err: unknown): void =>
    log.error("repeated interruption request failed", { phase, owner: owner.owner, error: errorMessage(err), errorDetail: errorDetail(err) })
  try {
    const delivered = owner.requestInterruption()
    if (delivered instanceof Promise) delivered.catch(onFailure)
  } catch (err) {
    onFailure(err)
  }
}

function describeFailure(failure: RuntimeShutdownFailure): RuntimeShutdownLogFields {
  return { kind: failure.kind, owner: failure.owner, error: errorMessage(failure.error), errorDetail: errorDetail(failure.error) }
}
