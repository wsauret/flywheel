import { errorMessage } from "../../infra/error-message.js"
import { createRuntimeFaultReporting } from "./runtime-fault-reporting.js"
import type { Log } from "../../infra/log.js"
import type { FrontendMutation, RuntimeExecutorState, RuntimeQuery } from "../../protocol/app-service-types.js"
import { ExecutorNotRunningError } from "../../protocol/runtime-protocol-schemas.js"
import { workspaceDomainCursor } from "../../protocol/runtime-ui-protocol-types.js"
import type { ExecutorWedgeWaiter, ProjectExecutorClient, ProjectExecutorStop, ProjectExecutorWaiter } from "./project-executor-client.js"
import type { SuccessorRows } from "./project-executor-protocol.js"
import type { ProjectStateResult } from "./project-state-protocol.js"
import type { ReplacementBlockerReason } from "./replacement-blockers.js"
import type { RuntimeUiBus } from "./runtime-ui-bus.js"
import type { ExecutorWedgeProof } from "./executor-responsiveness.js"
import type { BuildProof } from "../update/build-fallback.js"
import { ProjectExecutionChannelDetached, ProjectExecutionStopping } from "./project-execution-channel.js"

/** A generation that lives this long has shown that the executor can stay up,
 *  so the early deaths before it stop counting toward the restart backoff. */
const EXECUTOR_STABLE_LIFETIME_MS = 60_000
const FIRST_RESTART_DELAY_MS = 1_000
const MAX_RESTART_DELAY_MS = 30_000

/** The wait before the next attempt after `failures` failures in a row: one
 *  second, doubling, up to thirty. An executor restart after early deaths
 *  and a replacement's continuation that failed wait by this one shape. */
export function restartBackoffMs(failures: number): number {
  return Math.min(FIRST_RESTART_DELAY_MS * 2 ** Math.max(failures - 1, 0), MAX_RESTART_DELAY_MS)
}

/** One early death that recovers is invisible (PI-INTERACTION-042); a second
 *  one in a row is a crash loop, which the one notice reports
 *  (PI-INTERACTION-036) and which never holds a planned replacement. */
const NOTICE_AFTER_EARLY_DEATHS = 2
const CLOSING_MESSAGE = "This project is closing."

type SetTimer = (fire: () => void, delayMs: number) => () => void

const systemTimer: SetTimer = (fire, delayMs) => {
  const timer = setTimeout(fire, delayMs)
  timer.unref?.()
  return () => clearTimeout(timer)
}

/** Why a recovery failed, for each failure class that has a cause a person
 *  can read. Each completes "Flywheel could not restore this project's
 *  sessions. Cause: ...". */
const RECOVERY_CAUSES = {
  unsettled: "some commands it started did not stop",
  repair: "its saved history could not be repaired",
  write: "the project's saved state could not be written",
} as const

/** A recovery that could not finish. The message and `reason` are in the
 *  user's terms, and `reason` is absent when the failure has no specific
 *  cause a person can read; `detail` is the internal error, for the log only. */
class ExecutorRecoveryError extends Error {
  constructor(readonly reason: string | undefined, readonly detail: string) {
    super(`Flywheel could not restore this project's sessions.${reason === undefined ? "" : ` Cause: ${reason}.`}`)
    this.name = "ExecutorRecoveryError"
  }
}

/** Throws the failure of one recovery write, with the cause its class has. */
function requireWritten(kind: "generation.close" | "generation.recover", result: ProjectStateResult): void {
  if (result.kind === "ok") return
  if (result.kind === "refused") {
    // Only the recovery pass refuses as unsafe; any other refusal says
    // nothing a person could read about why.
    throw new ExecutorRecoveryError(result.reason === "unsafe-recovery" ? RECOVERY_CAUSES.repair : undefined, `${kind} refused: ${result.reason}${result.message === undefined ? "" : `: ${result.message}`}`)
  }
  if (result.kind === "failed") throw new ExecutorRecoveryError(RECOVERY_CAUSES.write, `${kind} failed: ${errorMessage(result.error)}`)
  throw new ExecutorRecoveryError(undefined, `unexpected ${kind} result ${result.kind}`)
}

/** One executor generation's recovery after it began to end. A failed
 *  attempt stays failed until the next ask for execution or a close. */
interface ExecutorRecovery {
  readonly attempt: Promise<void>
  state: "running" | "recovered" | "failed"
}

export interface ProjectExecutorGeneration {
  readonly generation: number
  readonly owner: ProjectExecutorClient
  /** The executor answered `ready`; until then it is still opening. */
  ready: boolean
  /** Resolves true once the generation reports ready, or false when it
   *  begins to end before that. */
  readonly started: Promise<boolean>
  /** Present from the moment the generation begins to end: the project is
   *  paused, and this recovers it. */
  recovery?: ExecutorRecovery
  /** Sessions a person was interrupting when the account ended this
   *  generation as wedged; their recovery records the person's interrupt.
   *  Written once, before the end begins, so the recovery reads it whole. */
  readonly interruptedSessionIds: Set<string>
}

/** Who asks a paused project for execution again, which schedules the
 *  restart of its ended generation:
 *  - `person`: a person's own input, such as a message, a Resume,
 *    or an answer to a question.
 *  - `surface`: a client's open tab that activates or reattaches its
 *    session, or reads its transcript, which only the executor serves.
 *  - `runtime`: a successor's continuation of the work a replacement cut.
 *  Other work asks nothing: it joins a scheduled restart, is answered at
 *  once while none is scheduled, and never schedules one. While a planned
 *  replacement is requested, only a person's input schedules a restart,
 *  because the successor opens the project for the rest. */
export type ExecutionAsker = "person" | "surface" | "runtime"

/** Who asks a paused project for execution with `command`, which may
 *  schedule the restart of its ended generation: a client's open tab that
 *  activates its session, or a person's own input. The one place that tells
 *  them apart, because only a person's input restarts the executor while a
 *  planned replacement is requested. Other work asks nothing: it waits for a
 *  restart that is scheduled and never schedules one. */
export function executionAskerOf(command: FrontendMutation): ExecutionAsker | undefined {
  if (command.type === "session.activate") return "surface"
  return command.type === "session.send"
    || command.type === "chat.resume" || command.type === "workflow.resume" || command.type === "workflow.restart" || command.type === "subagent.resume"
    || command.type === "question.answer" || command.type === "question.cancel"
    || command.type === "session.delete" && command.inactiveBefore === undefined
    || command.type === "chat.open" && command.initialMessage !== undefined
    ? "person"
    : undefined
}

/** Transcript and mutation-evidence reads ask as the surface that opens them.
 * Only the executor serves these reads (ARCH-RUNTIME-016). Other reads leave the project paused. */
export function readAskerOf(request: RuntimeQuery): ExecutionAsker | undefined {
  return request.type === "outputWindow" || request.type === "outputRange" || request.type === "outputGroupChildren" || request.type === "outputBlockBody"
    || request.type === "mutationFiles" || request.type === "mutationPatchWindow"
    ? "surface"
    : undefined
}

export interface ProjectExecutorGenerationsOptions {
  readonly reportFault?: import("./runtime-fault-reporting.js").RuntimeFaultReporter
  /** Starts executor generation `generation`. */
  readonly spawn: (generation: number) => ProjectExecutorClient
  /** Wires a ready generation into the project. The returned function
   *  unwires it when the generation begins to end. */
  readonly serve: (record: ProjectExecutorGeneration, runtime: Awaited<ProjectExecutorClient["ready"]>) => () => void
  /** The state Worker's write for one step of a generation's recovery. */
  readonly execution: (operation:
    | { readonly kind: "generation.close"; readonly generation: number }
    | { readonly kind: "generation.recover"; readonly generation: number; readonly interruptedSessionIds: readonly string[] }) => Promise<ProjectStateResult>
  /** Told when the execution coordinates clients hold become void: a new
   *  generation starts, or the current one begins to recover. */
  readonly onReset: () => void
  /** Told whenever what a replacement waits on may have changed. */
  readonly changed: () => void
  /** Whether a planned replacement is requested now. Read at each wedge
   *  proof, so the request waits on every generation for as long as it
   *  stands, with no registration to withdraw. */
  readonly replacementRequested: () => boolean
  /** Records the stop's handoff rows and answers whether the successor opens
   *  this project. Absent when no account handoff owns recovery. */
  readonly handoffRecovery?: (rows: SuccessorRows) => Promise<boolean>
  /** After all other writers settle, releases the sole serving holder atomically.
   * False retains the holder and requires this generation's full recovery. */
  readonly releaseForHandoff?: () => Promise<boolean>
  /** Where the executor state is published for every client. */
  readonly bus: Pick<RuntimeUiBus, "publish">
  /** The fallback of the build the executors run from, which each
   *  generation that reports ready proves, and each that ends before ready
   *  by a failure of its own counts against: its own exit or crash, or a
   *  wedge the account proved. Absent when no build is proved or left, as in
   *  a composition no account serves. */
  readonly buildProof?: BuildProof
  readonly log: Pick<ReturnType<typeof Log.create>, "debug" | "info" | "warn" | "error">
  readonly now?: () => number
  readonly setTimer?: SetTimer
}

/** The one owner of a project's executor generations: which one is current,
 *  when a new one may start, how an ended one recovers, and what a person
 *  should know about it.
 *
 *  A generation reads as ending from the moment it begins to end, not when
 *  its closure settles: its recovery starts then, and the project is paused
 *  until something asks for execution again (`ExecutionAsker`). That ask
 *  schedules a restart, which starts the executor only after the restart
 *  backoff: a generation that died before it lived
 *  `EXECUTOR_STABLE_LIFETIME_MS` after
 *  it reported ready, or while it opened, counts as an early death, and each early death in a row doubles the wait from
 *  one second up to thirty. The restart stays scheduled until a generation
 *  it starts reports ready: one that dies while it opens is recovered in
 *  turn and followed by the next after the next backoff step. The wait
 *  delays the input and never refuses it, so an open session still comes
 *  back on its own; only a recovery that fails refuses it, in the user's
 *  terms. A generation that stays up for the stable lifetime ends the count.
 *  While a planned replacement is requested, only a person's own input
 *  schedules a restart, whose work the replacement then cuts and the
 *  successor continues. An open tab or the runtime schedules none: the
 *  project stays paused, holds nothing, and answers other work at once, and
 *  the ask waits for a person's input or the close. The successor opens the
 *  project.
 *  A recovery attempt that failed is run again by the next ask or
 *  by the close, never by a passive read; an attempt that failed because the
 *  closure was unsettled first asks for fresh proof.
 *
 *  It alone ends a generation that still runs on the proof that it is
 *  wedged, and only while something waits for that generation to answer:
 *  its own start while it opens, a person's interrupt, a successor's
 *  continuation handoff, or a requested replacement. The cause comes from
 *  the generation's state: one still opening could not start, which counts
 *  as an early death like every failed start, and a ready one stopped
 *  answering. A silent generation that nothing waits on is only recorded by
 *  its watch.
 *
 *  The executor state it publishes follows what is true: `restarting` only
 *  while a restart is scheduled after repeated early deaths, which lasts
 *  until a generation it starts reports ready; `recovery_failed` while the
 *  current generation's recovery has failed. */
export function createProjectExecutorGenerations(options: ProjectExecutorGenerationsOptions) {
  const { log } = options
  const now = options.now ?? Date.now
  const setTimer = options.setTimer ?? systemTimer
  let generation = 0
  let closing = false
  /** Resolves when the close begins, which answers every ask that waits for
   *  a person's input. */
  const closeBegun = Promise.withResolvers<void>()
  let earlyDeaths = 0
  let streakSince: number | undefined
  let lastCause: string | undefined
  let resumeAt = 0
  let cancelStable: (() => void) | undefined
  let restartScheduled: Promise<ProjectExecutorGeneration> | undefined
  /** Resolves when the next restart is scheduled, which the asks that wait
   *  for a person's input then join. */
  let restartBegun = Promise.withResolvers<void>()
  /** The ended generation whose asks began to wait for a person's input,
   *  so that wait is recorded once. */
  let waitRecordedFor: ProjectExecutorGeneration | undefined
  let recoveryFailure: ExecutorRecoveryError | undefined
  const backoffWaits = new Set<() => void>()
  /** The registered waiters, each with the resolve of its wait. */
  const waiters = new Set<{ readonly waiter: ProjectExecutorWaiter; readonly resolve: (settled: Promise<void>) => void }>()
  /** The generations the account ended on a wedge proof: an end that is the
   *  executor's own failure, though the account carried it out. */
  const wedgedEnds = new WeakSet<ProjectExecutorGeneration>()
  /** The close's stop of one generation, which that generation's recovery reads. */
  let stopping: { readonly record: ProjectExecutorGeneration; readonly result: Promise<ProjectExecutorStop> } | undefined
  let pendingHandoff: { readonly record: ProjectExecutorGeneration; readonly rows: SuccessorRows; readonly release: () => Promise<boolean> } | undefined

  const crashLooping = (): boolean => earlyDeaths >= NOTICE_AFTER_EARLY_DEATHS
  const state = (): RuntimeExecutorState => {
    if (recoveryFailure !== undefined) return { kind: "recovery_failed", ...(recoveryFailure.reason === undefined ? {} : { cause: recoveryFailure.reason }) }
    if (restartScheduled !== undefined && crashLooping() && streakSince !== undefined && lastCause !== undefined) {
      return { kind: "restarting", since: streakSince, cause: lastCause }
    }
    return { kind: "serving" }
  }
  const faultReporting = createRuntimeFaultReporting<RuntimeExecutorState>({
    initial: { kind: "serving" },
    ...(options.reportFault === undefined ? {} : { report: options.reportFault }),
    publish: (executor) => { options.bus.publish({ cursor: workspaceDomainCursor("executor"), payload: { kind: "executor.changed", executor } }) },
  })
  const publish = (): void => {
    const next = state()
    faultReporting.update(next, next.kind === "recovery_failed" ? recoveryFailure : undefined)
  }

  /** Records how a generation ended. Its lifetime counts from the moment it
   *  reported ready, so one that ended while it opened is always an early death. */
  const recordEnd = (readyAt: number | undefined, cause: string): void => {
    cancelStable?.()
    cancelStable = undefined
    const at = now()
    lastCause = cause
    if (readyAt !== undefined && at - readyAt >= EXECUTOR_STABLE_LIFETIME_MS) {
      earlyDeaths = 0
      streakSince = undefined
      resumeAt = at
      return
    }
    earlyDeaths += 1
    streakSince ??= at
    resumeAt = at + restartBackoffMs(earlyDeaths)
  }

  /** Resolves once the restart backoff allows a new generation, or at close. */
  const backoff = (): Promise<void> => {
    const delayMs = resumeAt - now()
    if (delayMs <= 0 || closing) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const release = (): void => {
        cancel()
        backoffWaits.delete(release)
        resolve()
      }
      const cancel = setTimer(release, delayMs)
      backoffWaits.add(release)
    })
  }

  const attempt = async (record: ProjectExecutorGeneration, retry: boolean): Promise<void> => {
    const stop = stopping?.record === record ? await stopping.result : undefined
    // A retry after an unsettled closure asks the kernel again; the first
    // closure is a fact about a moment that may have stopped being true.
    const closure = retry ? await record.owner.settle() : await record.owner.closed
    // An unsettled closure may leave executor work alive; recovering over it
    // would race that work, so the attempt fails and the next one asks again.
    if (!closure.settled) throw new ExecutorRecoveryError(RECOVERY_CAUSES.unsettled, closure.reason)
    const closed = await options.execution({ kind: "generation.close", generation: record.generation })
    // A retry finds the generation already closed by the attempt before it.
    if (closed.kind !== "refused" || closed.reason !== "closed-generation") requireWritten("generation.close", closed)
    if (closing && stop?.settled && stop.successorRows !== undefined && options.releaseForHandoff !== undefined && await options.handoffRecovery?.(stop.successorRows)) {
      pendingHandoff = { record, rows: stop.successorRows, release: options.releaseForHandoff }
      return
    }
    requireWritten("generation.recover", await options.execution({ kind: "generation.recover", generation: record.generation, interruptedSessionIds: [...record.interruptedSessionIds] }))
    // A stop that did not flush left its sessions to this recovery, which
    // repaired them; the record says so rather than calling it a clean stop.
    if (stop !== undefined && !stop.settled) log.error("executor stop did not settle; recovery repaired its generation", { generation: record.generation, reason: stop.reason })
  }

  /** Starts the generation's recovery, joins the attempt that is running, or
   *  runs a failed one again. */
  const recover = (record: ProjectExecutorGeneration): Promise<void> => {
    const prior = record.recovery
    if (prior && prior.state !== "failed") return prior.attempt
    // Every failure reaches a waiter in the user's terms; the internal error
    // is logged below.
    const recoveryStarted = now()
    const attempted = attempt(record, prior !== undefined).catch((error: unknown) => {
      throw error instanceof ExecutorRecoveryError ? error : new ExecutorRecoveryError(undefined, errorMessage(error))
    })
    const recovery: ExecutorRecovery = { attempt: attempted, state: "running" }
    record.recovery = recovery
    if (!prior) options.onReset()
    void recovery.attempt.then(
      () => {
        recovery.state = "recovered"
        recoveryFailure = undefined
        // Recovery that repaired interrupted sessions or succeeded on a retry
        // is a state change; a clean stop's completion is routine.
        const fields = { generation: record.generation, interruptedSessions: record.interruptedSessionIds.size, retry: prior !== undefined, durationMs: now() - recoveryStarted }
        if (fields.interruptedSessions > 0 || fields.retry) log.info("executor generation recovered", fields)
        else log.debug("executor generation recovered", fields)
      },
      (error: unknown) => {
        recovery.state = "failed"
        const failure = error instanceof ExecutorRecoveryError ? error : new ExecutorRecoveryError(undefined, errorMessage(error))
        recoveryFailure = failure
        log.error("executor recovery failed; the next input runs it again", { generation: record.generation, reason: failure.reason, error: failure.detail })
      },
    ).finally(() => {
      publish()
      options.changed()
    })
    // Recovery in progress is itself a replacement blocker; the owner is told at both ends.
    options.changed()
    publish()
    return recovery.attempt
  }

  /** Starts a recovery nobody waits on; its failure is logged where it happens. */
  const recoverUnawaited = (record: ProjectExecutorGeneration): void => {
    recover(record).catch(() => {})
  }

  /** Ends `record` on a wedge proof when anything waits for it to answer,
   *  once, and answers every registered waiter once that end and its
   *  recovery have settled. A waiter stays registered until its signal
   *  withdraws it, so it also waits on the generation a restart starts. */
  const endWedgedIfAwaited = (record: ProjectExecutorGeneration, proof: ExecutorWedgeProof): void => {
    if (record.recovery || closing) return
    const counted = [...waiters]
    const waitedBy = [...new Set<ExecutorWedgeWaiter>([
      ...(record.ready ? [] : ["start" as const]),
      ...counted.map(({ waiter }) => waiter.kind),
      ...(options.replacementRequested() ? ["replacement" as const] : []),
    ])]
    if (waitedBy.length === 0) return
    for (const { waiter } of counted) if (waiter.kind === "interrupt" && waiter.sessionId !== undefined) record.interruptedSessionIds.add(waiter.sessionId)
    const cause = record.ready ? "stopped answering, so Flywheel ended it" : "could not start"
    wedgedEnds.add(record)
    const end = record.owner.terminate(cause, { ...proof, waitedBy, interruptedSessionIds: [...record.interruptedSessionIds] })
    const settled = Promise.allSettled([end, recover(record)]).then(() => {})
    for (const { resolve } of counted) resolve(settled)
  }

  const acquire = (): ProjectExecutorGeneration => {
    options.onReset()
    const next = ++generation
    const owner = options.spawn(next)
    const started = Promise.withResolvers<boolean>()
    const record: ProjectExecutorGeneration = { generation: next, owner, ready: false, started: started.promise, interruptedSessionIds: new Set() }
    let readyAt: number | undefined
    let unserve: (() => void) | undefined
    void owner.ready.then((runtime) => {
      if (record.recovery) return
      record.ready = true
      readyAt = now()
      // The stable lifetime counts from ready: a slow opening is not time
      // the executor has shown it can stay up.
      cancelStable?.()
      cancelStable = setTimer(() => {
        cancelStable = undefined
        earlyDeaths = 0
        streakSince = undefined
        publish()
      }, EXECUTOR_STABLE_LIFETIME_MS)
      unserve = options.serve(record, runtime)
      options.buildProof?.executorReady()
      publish()
      started.resolve(true)
    }, () => { started.resolve(false) })
    // Told before any caller awaiting readiness hears that it failed, so the
    // generation reads as paused from the first moment it serves nothing.
    owner.onEnding((cause, own) => {
      unserve?.()
      unserve = undefined
      // An end while the project closes is a stop the account asked for,
      // never the executor's own failure.
      if (!closing) {
        recordEnd(readyAt, cause)
        if (readyAt === undefined && (own || wedgedEnds.has(record))) options.buildProof?.failedToOpen()
      }
      recoverUnawaited(record)
      started.resolve(false)
    })
    owner.onWedged((proof) => endWedgedIfAwaited(record, proof))
    return record
  }

  let current = acquire()

  /** Recovers the ended generation, waits out the backoff, and starts the
   *  next one, until a generation reports ready. A recovery that fails, or
   *  the close, ends the restart. */
  const restart = async (): Promise<ProjectExecutorGeneration> => {
    for (;;) {
      await recover(current)
      // One record per restart, when it is decided: the wait before it
      // starts is part of the decision, so a restart that never starts
      // because the close came first still left its reason.
      log.info("executor restarting", { after: current.generation, cause: lastCause, earlyDeaths, delayMs: Math.max(0, resumeAt - now()) })
      await backoff()
      if (closing) throw new Error(CLOSING_MESSAGE)
      current = acquire()
      if (await current.started && !current.recovery) return current
    }
  }

  /** Waits until a restart is scheduled, which the caller then joins, or
   *  until the close, which it answers as closing. */
  const nextRestart = async (): Promise<void> => {
    await Promise.race([restartBegun.promise, closeBegun.promise])
    if (closing) throw new Error(CLOSING_MESSAGE)
  }

  const serving = (asker?: ExecutionAsker): Promise<ProjectExecutorGeneration> => {
    if (restartScheduled) return restartScheduled
    const record = current
    if (!record.recovery) {
      if (record.ready) return Promise.resolve(record)
      // An opening generation is handed out once it reports ready. One that
      // ends first leaves the project paused, and the input is taken again
      // as a paused project takes it.
      return record.started.then((ready) => ready && !record.recovery ? record : serving(asker))
    }
    if (asker === undefined) return Promise.reject(new ExecutorNotRunningError())
    // While a planned replacement is requested, only a person's own input
    // schedules a restart here, and the replacement then cuts that work and
    // the successor continues it. An open tab or the runtime schedules
    // nothing: the project stays paused, holds nothing, and answers other
    // work at once, and the ask waits for a person's input to schedule the
    // restart, which it then joins, or for the close.
    if (asker !== "person" && options.replacementRequested()) {
      if (waitRecordedFor !== record) {
        waitRecordedFor = record
        log.info("executor restart waits for a person's input while a replacement is requested", { after: record.generation })
      }
      return nextRestart().then(() => serving(asker))
    }
    restartScheduled = restart().finally(() => {
      restartScheduled = undefined
      publish()
      options.changed()
    })
    restartBegun.resolve()
    restartBegun = Promise.withResolvers()
    publish()
    options.changed()
    return restartScheduled
  }

  const withdraw = async (call: (runtime: Awaited<ProjectExecutorClient["ready"]>) => Promise<void>): Promise<void> => {
    const record = current
    if (record.recovery || !await record.started || record.recovery) return
    const runtime = await record.owner.ready
    for (;;) {
      try {
        await call(runtime)
        return
      } catch (error) {
        // The channel holds a send made while it is detached until a socket
        // reattaches, so the call goes to this same generation again.
        if (error instanceof ProjectExecutionChannelDetached) continue
        // A refusal says that this generation stops. Its end also closes the
        // channel, which fails the call after the end has begun.
        if (error instanceof ProjectExecutionStopping || record.recovery) return
        throw error
      }
    }
  }

  return {
    get current(): ProjectExecutorGeneration { return current },
    /** What a person should know about the executor; each change is also
     *  published on the `executor` workspace domain. */
    get state(): RuntimeExecutorState { return faultReporting.state() },
    failedReport: faultReporting.failedReport,
    /** Whether an ask has scheduled a restart that has not yet produced a
     *  ready generation; work sent now reaches that generation. */
    get restartScheduled(): boolean { return restartScheduled !== undefined },
    /** What the executor holds against a planned replacement: `live` when
     *  the current generation serves and answers for its own work,
     *  `recovery` while an ended generation recovers, `opening` while a
     *  generation opens or an ask waits for one, and nothing when the
     *  project is paused with no ask waiting or its recovery failed. A crash
     *  loop holds nothing: its scheduled restart and the generations it
     *  starts give way, so a replacement's successor build takes over. An
     *  open tab's or the runtime's ask that waits for a person's input while
     *  a replacement is requested schedules nothing, so it holds nothing. */
    replacementHold(): ReplacementBlockerReason | "live" | undefined {
      const record = current
      if (record.recovery?.state === "running") return "recovery"
      if (!record.recovery && record.ready) return "live"
      if (restartScheduled === undefined && record.recovery) return undefined
      return crashLooping() ? undefined : "opening"
    },
    /** The generation work runs on, handed out only once it has reported
     *  ready. In a paused project, an ask schedules the restart; other work,
     *  and a concurrent ask, joins the restart that is scheduled. With none
     *  scheduled, other work is refused in plain words that ask for nothing.
     *  A restart refuses only when a recovery fails, or at close. */
    serving,
    /** Runs `call`, an idempotent withdrawal of something that the
     *  generation serving now shows, such as a hidden session, on that
     *  generation only. A call that a detached transport cut is sent again
     *  to it. The end of that generation also completes the call, which then
     *  never reaches a successor: a successor shows only what clients
     *  activate in it. A paused project shows nothing, so the call is
     *  complete at once. Other failures reject. */
    withdraw,
    /** Registers `waiter` as waiting for the serving generation to answer,
     *  until the signal withdraws it. It covers every generation that serves
     *  while it waits: the live one, the one opening, and the one a scheduled
     *  restart starts. Each of them proven wedged meanwhile is ended, and the
     *  returned promise resolves once the first such end and its recovery
     *  have settled, whatever their outcome: a recovery that failed is
     *  published, not thrown to the waiter. It never resolves while nothing
     *  is ended. */
    endIfWedged(input: { readonly signal: AbortSignal; readonly waiter: ProjectExecutorWaiter }): Promise<void> {
      const { promise, resolve } = Promise.withResolvers<void>()
      if (input.signal.aborted) return promise
      const entry = { waiter: input.waiter, resolve }
      waiters.add(entry)
      input.signal.addEventListener("abort", () => { waiters.delete(entry) }, { once: true })
      return promise
    },
    /** Stops and fences the current generation, waiting through its shutdown
     *  bound. Recovers it now unless an eligible handoff awaits `finishClose`.
     *  Resolves with the
     *  successor rows the stop counted after a planned replacement's cut;
     *  undefined when no stop answered, as for a generation that had already
     *  ended. */
    async close(): Promise<SuccessorRows | undefined> {
      await faultReporting.dispose()
      closing = true
      closeBegun.resolve()
      cancelStable?.()
      for (const release of backoffWaits) release()
      const record = current
      let stop: Promise<ProjectExecutorStop> | undefined
      if (!record.recovery) {
        // Recorded before the stop is asked for: a stop can begin the
        // generation's end, and so its recovery, before it returns.
        const stopped = Promise.withResolvers<ProjectExecutorStop>()
        stopping = { record, result: stopped.promise }
        stop = stopped.promise
        stopped.resolve(record.owner.stop())
      }
      await recover(record)
      return (await stop)?.successorRows
    },
    /** Finalizes an eligible handoff after durable flush and before state disposal.
     * Other close and crash paths already recovered in `close`. A failed pass
     * remains pending so the shutdown owner's next attempt retries it. */
    async finishClose(): Promise<void> {
      if (!pendingHandoff) return
      const { record, rows, release } = pendingHandoff
      if (await release()) {
        log.info("executor recovery handed to replacement", { generation: record.generation, ...rows, interruptedSessions: record.interruptedSessionIds.size, reason: "exclusive recorded handoff releases project" })
      } else {
        requireWritten("generation.recover", await options.execution({ kind: "generation.recover", generation: record.generation, interruptedSessionIds: [...record.interruptedSessionIds] }))
      }
      pendingHandoff = undefined
    },
  }
}
