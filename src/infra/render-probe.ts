/**
 * Temporary diagnostics for render-pipeline investigations. Enabled only when
 * FLYWHEEL_RENDER_DEBUG is set; every call is a no-op otherwise.
 *
 * The flag is captured once at module load. The live output projector calls probe()
 * ~10x per accepted patch, so at ~50k events/step the disabled path must not
 * re-read process.env every call; the captured boolean is a single field load.
 */
import { DebugLog } from "./debug-log.js"

let enabled = !!process.env.FLYWHEEL_RENDER_DEBUG

export function renderProbeEnabled(): boolean {
  return enabled
}

/** Test-only: flip the captured flag deterministically after import, avoiding
 *  import-order sensitivity. Production never calls this. */
export function setRenderProbeEnabled(value: boolean): void {
  enabled = value
  if (!value) {
    awaitingFrame.clear()
    mountedResults.clear()
  }
}

interface RenderProbeValues {
  readonly [name: string]: number
}
export interface RenderProbeSnapshot {
  readonly counters: RenderProbeValues
  readonly gauges: RenderProbeValues
}

const counters = new Map<string, number>()
const gauges = new Map<string, number>()
const awaitingFrame = new Set<string>()
const mountedResults = new Set<string>()

export type ToolRenderPhase = "availability" | "output-sync" | "intake" | "application" | "first-frame"

/** Record one cross-realm-comparable phase timestamp. `performance.timeOrigin`
 * calibrates the monotonic clock to epoch time without reading the adjustable
 * wall clock on each phase. */
export function probeToolRenderPhase(toolUseId: string, phase: ToolRenderPhase): void {
  if (!enabled) return
  DebugLog.record({
    type: "render.tool_result.phase",
    payload: {
      toolUseId,
      phase,
      monotonicEpochMs: performance.timeOrigin + performance.now(),
    },
  })
  if (phase === "application") awaitingFrame.add(toolUseId)
}

/** Mark a settled result component that participates in the next installed-TUI
 * frame. Application remains the authority for whether the result is pending. */
export function markToolResultMounted(toolUseId: string): void {
  if (!enabled || !awaitingFrame.has(toolUseId)) return
  mountedResults.add(toolUseId)
}

/** Close the pending-result window at an OpenTUI frame. Mounted results emit
 * once; pending results outside the viewport are discarded at this frame. */
export function renderProbeFrame(): void {
  if (!enabled || awaitingFrame.size === 0) return
  for (const toolUseId of awaitingFrame) {
    if (mountedResults.has(toolUseId)) probeToolRenderPhase(toolUseId, "first-frame")
  }
  awaitingFrame.clear()
  mountedResults.clear()
}

export function probe(name: string): void {
  if (!enabled) return
  counters.set(name, (counters.get(name) ?? 0) + 1)
}

export function probeGauge(name: string, value: number): void {
  if (!enabled) return
  gauges.set(name, value)
}

export function probeDrain(): RenderProbeSnapshot {
  const snapshot = {
    counters: Object.fromEntries(counters),
    gauges: Object.fromEntries(gauges),
  }
  counters.clear()
  gauges.clear()
  return snapshot
}
