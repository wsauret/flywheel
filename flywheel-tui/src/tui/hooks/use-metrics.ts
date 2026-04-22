import { createSignal, createMemo, createEffect, onCleanup } from "solid-js"
import type { Accessor } from "solid-js"
import type { ModelActivity } from "../../infra/output-blocks.js"
import type { SessionEntry } from "../../orchestration/session-store-types.js"

export interface MetricsHook {
  elapsed: Accessor<number>
  episodeElapsed: Accessor<number>
  liveTokens: Accessor<number>
  liveCost: Accessor<number>
  liveContextPercent: Accessor<number>
  liveActivity: Accessor<ModelActivity>
  pauseTimer(): void
  resetMetrics(): void
  resetElapsedTo(ms: number): void
}

export function useMetrics(entry: () => SessionEntry | undefined): MetricsHook {
  const liveTokens = createMemo(() => entry()?.tokens ?? 0)
  const liveCost = createMemo(() => entry()?.cost ?? 0)
  const liveContextPercent = createMemo(() => entry()?.contextPercent ?? 0)
  const liveActivity = createMemo((): ModelActivity => entry()?.modelActivity ?? "idle")

  // Why effect + setInterval, not a memo: elapsed time is wall-clock-driven,
  // not derivable from reactive state. The effect starts/stops the timer based
  // on liveActivity; the mutable accumulators track time across pause/resume cycles.
  const [elapsed, setElapsed] = createSignal(0)
  const [episodeElapsed, setEpisodeElapsed] = createSignal(0)

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
    elapsedTimer = setInterval(() => {
      const sinceStart = Date.now() - elapsedRunStart
      setElapsed(elapsedAccum + sinceStart)
      setEpisodeElapsed(sinceStart)
    }, 1000)
  }

  function pauseTimer(): void {
    if (!elapsedTimer) return
    elapsedAccum += Date.now() - elapsedRunStart
    clearInterval(elapsedTimer)
    elapsedTimer = null
    setEpisodeElapsed(0)
  }

  function resetMetrics(): void {
    if (elapsedTimer) {
      clearInterval(elapsedTimer)
      elapsedTimer = null
    }
    elapsedRunStart = 0
    elapsedAccum = 0
    setElapsed(0)
    setEpisodeElapsed(0)
  }

  function resetElapsedTo(ms: number): void {
    elapsedAccum = ms
    setElapsed(ms)
  }

  onCleanup(() => pauseTimer())

  return {
    elapsed,
    episodeElapsed,
    liveTokens,
    liveCost,
    liveContextPercent,
    liveActivity,
    pauseTimer,
    resetMetrics,
    resetElapsedTo,
  }
}
