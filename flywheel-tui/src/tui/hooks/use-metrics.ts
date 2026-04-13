import { createSignal, createMemo, createEffect, onCleanup, batch } from "solid-js"
import type { Accessor } from "solid-js"
import type { SessionEntry } from "../../orchestration/session-store-types"

export interface MetricsHook {
  elapsed: Accessor<number>
  liveTokens: Accessor<number>
  liveCost: Accessor<number>
  liveContextPercent: Accessor<number>
  thinkingElapsed: Accessor<number>
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
  const [thinkingElapsed, setThinkingElapsed] = createSignal(0)

  let elapsedTimer: ReturnType<typeof setInterval> | null = null
  let elapsedAccum = 0
  let elapsedRunStart = 0

  // Thinking elapsed — tracks seconds spent in "thinking" activity.
  // Reacts to liveActivity transitions, updates once per second while active.
  let thinkingStart = 0
  let thinkingTimer: ReturnType<typeof setInterval> | null = null

  createEffect(() => {
    const activity = liveActivity()
    if (activity === "thinking") {
      if (!thinkingTimer) {
        thinkingStart = Date.now()
        setThinkingElapsed(0)
        thinkingTimer = setInterval(() => {
          setThinkingElapsed(Math.floor((Date.now() - thinkingStart) / 1000))
        }, 1000)
      }
    } else {
      if (thinkingTimer) {
        clearInterval(thinkingTimer)
        thinkingTimer = null
        thinkingStart = 0
        setThinkingElapsed(0)
      }
    }
  })
  onCleanup(() => { if (thinkingTimer) clearInterval(thinkingTimer) })

  // Elapsed timer — runs while agent is active, pauses on idle.
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
    if (thinkingTimer) {
      clearInterval(thinkingTimer)
      thinkingTimer = null
    }
    elapsedRunStart = 0
    elapsedAccum = 0
    thinkingStart = 0
    batch(() => {
      setElapsed(0)
      setThinkingElapsed(0)
    })
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
    thinkingElapsed,
    liveActivity,
    pauseTimer,
    resetMetrics,
    resetElapsedTo,
  }
}
