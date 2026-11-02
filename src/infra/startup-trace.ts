import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { Log } from "./log.js"

const enabled = process.env.FLYWHEEL_BOOT_TRACE === "1"
const startedAt = performance.now()

export function startupTrace(label: string): void {
  if (!enabled) return
  const elapsedMs = Math.round(performance.now() - startedAt)
  Log.writeDiagnosticStderr(`[boot +${elapsedMs}ms] ${label}\n`)
}

interface FrameSource {
  readonly frameId: number
  on(event: "frame", listener: (frame: { frameId: number }) => void): void
  off(event: "frame", listener: (frame: { frameId: number }) => void): void
}

/** Traces the shell mount and then the first frame drawn after it, which the
 * release gate times startup by. A terminal reply that arrives before the mount
 * can present a frame of the empty tree, so the earlier first frame does not
 * show content. */
export function traceShellMount(renderer: FrameSource): void {
  startupTrace("shell onMount")
  if (!enabled) return
  const mountFrameId = renderer.frameId
  const contentFrame = (frame: { frameId: number }): void => {
    if (frame.frameId <= mountFrameId) return
    startupTrace("content frame")
    renderer.off("frame", contentFrame)
  }
  renderer.on("frame", contentFrame)
}

export interface ReleaseMemorySample {
  readonly timestampMs: number
  readonly heapUsed: number
  readonly rss: number
  readonly phase?: string
}

const phaseObservers = new Set<(phase: string) => void>()

/** Captures a synchronous boundary which a timer cannot observe. Ordinary launches do no work. */
export function observeReleaseMemoryPhase(phase: string): void {
  for (const observe of phaseObservers) observe(phase)
}

/** Measurement-only evidence. The serving owner writes one file on disposal, never a diagnostic stream. */
export interface ReleaseMemoryEvidence {
  readonly runId: string
  readonly role: string
  readonly pid: number
  readonly cadenceMs: number
  readonly samples: readonly ReleaseMemorySample[]
}

/** A fixed epoch plus a monotonic clock lets the harness and executor share interval bounds.
 * Bun's hrtime and nanoseconds clocks instead start anew in each process. */
export function releaseMeasurementNow(): number {
  return performance.timeOrigin + performance.now()
}

/** Starts bounded release measurements only when the harness supplies both an evidence directory and a run identity.
 * Disposal stops sampling and writes once. The caller owns directory creation and disposal before process exit. */
export function startReleaseMemorySampler(options: {
  readonly role: string
  readonly pid?: number
  readonly environment?: NodeJS.ProcessEnv
  readonly capacity?: number
  readonly now?: () => number
  readonly memory?: () => { readonly heapUsed: number; readonly rss: number }
  readonly schedule?: (observe: () => void, cadenceMs: number) => () => void
  readonly sink?: (path: string, evidence: ReleaseMemoryEvidence) => void
}): { dispose(): void } | undefined {
  const environment = options.environment ?? process.env
  const directory = environment.FLYWHEEL_RELEASE_MEMORY_DIRECTORY
  const runId = environment.FLYWHEEL_RELEASE_MEMORY_RUN
  if (!directory || !runId) return undefined
  const pid = options.pid ?? process.pid
  const now = options.now ?? releaseMeasurementNow
  const memory = options.memory ?? (() => process.memoryUsage())
  const capacity = options.capacity ?? 4096
  const cadenceMs = 100
  const samples: ReleaseMemorySample[] = []
  const phases: ReleaseMemorySample[] = []
  let cursor = 0
  let disposed = false
  const observe = () => {
    if (disposed) return
    const { heapUsed, rss } = memory()
    samples[cursor] = { timestampMs: now(), heapUsed, rss }
    cursor = (cursor + 1) % capacity
  }
  observe()
  const observePhase = (phase: string) => {
    const { heapUsed, rss } = memory()
    phases.push({ timestampMs: now(), heapUsed, rss, phase })
  }
  phaseObservers.add(observePhase)
  const stop = (options.schedule ?? ((tick, cadence) => {
    const timer = setInterval(tick, cadence)
    timer.unref()
    return () => clearInterval(timer)
  }))(observe, cadenceMs)
  return {
    dispose() {
      if (disposed) return
      disposed = true
      stop()
      phaseObservers.delete(observePhase)
      const ordered = samples.length < capacity ? samples : [...samples.slice(cursor), ...samples.slice(0, cursor)]
      const evidence = { runId, role: options.role, pid, cadenceMs, samples: [...ordered, ...phases].sort((a, b) => a.timestampMs - b.timestampMs) }
      const path = join(directory, `${options.role}-${pid}.json`)
      const sink = options.sink ?? ((file, value) => writeFileSync(file, `${JSON.stringify(value)}\n`))
      sink(path, evidence)
    },
  }
}
