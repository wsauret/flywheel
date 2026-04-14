import { createSignal, createMemo, createEffect, onCleanup } from "solid-js"
import type { Accessor } from "solid-js"
import type { SessionEntry } from "../../orchestration/session-store-types.js"

export interface MetricsHook {
  elapsed: Accessor<number>
  liveTokens: Accessor<number>
  liveCost: Accessor<number>
  liveContextPercent: Accessor<number>
  liveActivity: Accessor<"idle" | "thinking" | "generating" | "tool_executing">
  pauseTimer(): void
  resetMetrics(): void
  resetElapsedTo(ms: number): void
}

export function useMetrics(entry: () => SessionEntry | undefined): MetricsHook {
  const liveTokens = createMemo(() => entry()?.tokens ?? 0)
  const liveCost = createMemo(() => entry()?.cost ?? 0)
  const liveContextPercent = createMemo(() => entry()?.contextPercent ?? 0)
  const liveActivity = createMemo((): "idle" | "thinking" | "generating" | "tool_executing" => entry()?.modelActivity ?? "idle")

  const [elapsed, setElapsed] = createSignal(0)

  let elapsedTimer: ReturnType<typeof setInterval> | null = null
  let elapsedAccum = 0
  let elapsedRunStart = 0

  createEffect(() => {
    if (liveActivity() !== "idle") startTimer()
    else pauseTimer()
  })

  function startTimer(): void {
    if (elapsedTimer) return
    elapsedRunStart = Date.now()
    elapsedTimer = setInterval(() => setElapsed(elapsedAccum + (Date.now() - elapsedRunStart)), 1000)
  }

  function pauseTimer(): void {
    if (!elapsedTimer) return
    elapsedAccum += Date.now() - elapsedRunStart
    clearInterval(elapsedTimer)
    elapsedTimer = null
  }

  function resetMetrics(): void {
    if (elapsedTimer) {
      clearInterval(elapsedTimer)
      elapsedTimer = null
    }
    elapsedRunStart = 0
    elapsedAccum = 0
    setElapsed(0)
  }

  function resetElapsedTo(ms: number): void {
    elapsedAccum = ms
    setElapsed(ms)
  }

  onCleanup(() => pauseTimer())

  return {
    elapsed,
    liveTokens,
    liveCost,
    liveContextPercent,
    liveActivity,
    pauseTimer,
    resetMetrics,
    resetElapsedTo,
  }
}
