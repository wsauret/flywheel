import { DebugLog } from "./debug-log.js"
import { errorMessage } from "./error-message.js"

export interface StartupCounts {
  [name: string]: number
}

export type StartupStageEnd = (outcome?: "ready" | "failed" | "incomplete", counts?: Readonly<StartupCounts>) => void

export interface StartupStageSummary {
  readonly status: "pending" | "running" | "ready" | "failed" | "incomplete"
  readonly count: number
  /** Sum of completed invocation durations in milliseconds, including overlapping work. */
  readonly durationMs: number
  readonly maxMs: number
  readonly startOffsetMs?: number
  readonly endOffsetMs?: number
  readonly counts: Readonly<StartupCounts>
}

interface StartupContext {
  readonly [name: string]: string
}

interface StartupStages {
  [name: string]: StartupStageSummary
}
type StartupRecordBase = {
  readonly owner: string
  readonly context: StartupContext
  /** Wall-clock milliseconds since timeline creation, not the sum of stage durations. */
  readonly elapsedMs: number
}

export type StartupTimelineRecord =
  | (StartupRecordBase & { readonly type: "startup.started" })
  | (StartupRecordBase & {
    readonly type: "startup.finished"
    readonly outcome: "ready" | "failed" | "incomplete"
    /** When the owner's first frame or first answer was ready, if it was. */
    readonly foregroundReadyMs?: number
    readonly stages: Readonly<StartupStages>
    /** Why startup failed, when the owner passed its error. */
    readonly error?: string
  })

export interface StartupTimelineOptions {
  readonly owner: string
  readonly stages: readonly string[]
  readonly context: StartupContext
  /** Monotonic start captured before the diagnostic sink opened, in the same clock as now. */
  readonly originMs?: number
  readonly now?: () => number
  readonly emit?: (record: StartupTimelineRecord) => void
}

/** Offsets and durations to a tenth of a millisecond: the clock's sub-microsecond
 *  digits describe no startup and cost a line its width. */
function roundMs(milliseconds: number): number {
  return Math.round(milliseconds * 10) / 10
}

/** The record's type is the diagnostic family, so the payload does not repeat it. */
function recordStartup({ type, ...payload }: StartupTimelineRecord): void {
  DebugLog.record({ type, payload })
}

/** Records two lifecycle snapshots: the start, at DEBUG, and one summary when
 *  startup finishes, which carries the first-frame checkpoint. Stage durations
 *  sum completed invocations, even when they overlap. */
export function createStartupTimeline({ owner, stages, context, originMs, now = () => performance.now(), emit = recordStartup }: StartupTimelineOptions) {
  const names = new Set(stages)
  const origin = originMs ?? now()
  const summaries = new Map<string, {
    status: StartupStageSummary["status"]
    count: number
    durationMs: number
    maxMs: number
    startOffsetMs?: number
    endOffsetMs?: number
    counts: StartupCounts
    active: number
    failed: boolean
  }>()
  for (const stage of names) summaries.set(stage, { status: "pending", count: 0, durationMs: 0, maxMs: 0, counts: {}, active: 0, failed: false })
  const recordBase = { owner, context: { ...context } }
  const elapsed = () => now() - origin
  /** The stages at finish: one still running there did not complete. */
  const snapshot = (): Readonly<StartupStages> => {
    const result: StartupStages = {}
    for (const [name, stage] of summaries) {
      result[name] = {
        status: stage.active > 0 ? "incomplete" : stage.status,
        count: stage.count,
        durationMs: roundMs(stage.durationMs),
        maxMs: roundMs(stage.maxMs),
        ...(stage.startOffsetMs === undefined ? {} : { startOffsetMs: roundMs(stage.startOffsetMs) }),
        ...(stage.endOffsetMs === undefined ? {} : { endOffsetMs: roundMs(stage.endOffsetMs) }),
        counts: { ...stage.counts },
      }
    }
    return result
  }
  let finished = false
  let foregroundReadyMs: number | undefined
  const recordCompleted = (name: string, startMs: number, endMs: number, outcome: "ready" | "failed" | "incomplete" = "ready", counts: Readonly<StartupCounts> = {}): void => {
    if (finished) return
    const stage = summaries.get(name)
    if (!stage) throw new Error(`Unknown startup stage: ${name}`)
    const duration = endMs - startMs
    stage.startOffsetMs ??= startMs - origin
    stage.count += 1
    stage.durationMs += duration
    stage.maxMs = Math.max(stage.maxMs, duration)
    stage.endOffsetMs = endMs - origin
    stage.failed ||= outcome === "failed"
    stage.status = stage.failed ? "failed" : stage.active > 0 ? "running" : outcome
    for (const [key, value] of Object.entries(counts)) stage.counts[key] = (stage.counts[key] ?? 0) + value
  }
  emit({ type: "startup.started", ...recordBase, elapsedMs: 0 })

  return {
    /** Include an already measured stage using timestamps from this timeline's monotonic clock. */
    recordCompleted,
    begin(name: string): StartupStageEnd {
      const stage = summaries.get(name)
      if (!stage) throw new Error(`Unknown startup stage: ${name}`)
      if (finished) return () => {}
      const start = elapsed()
      stage.startOffsetMs ??= start
      stage.active += 1
      stage.status = stage.failed ? "failed" : "running"
      let ended = false
      return (outcome = "ready", counts = {}) => {
        if (ended || finished) return
        ended = true
        stage.active -= 1
        recordCompleted(name, origin + start, now(), outcome, counts)
      }
    },
    foregroundReady(): void {
      if (finished || foregroundReadyMs !== undefined) return
      foregroundReadyMs = roundMs(elapsed())
    },
    finish(outcome: "ready" | "failed" | "incomplete" = "ready", error?: unknown): void {
      if (finished) return
      finished = true
      emit({
        type: "startup.finished", ...recordBase, outcome, elapsedMs: roundMs(elapsed()),
        ...(foregroundReadyMs === undefined ? {} : { foregroundReadyMs }),
        stages: snapshot(),
        ...(error === undefined ? {} : { error: errorMessage(error) }),
      })
    },
  }
}
