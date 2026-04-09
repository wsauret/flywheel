import { createSignal, createMemo, onCleanup, batch } from "solid-js"
import type { Accessor } from "solid-js"
import type { SessionEntry } from "../../orchestration/session-registry"

export interface MetricsHook {
  elapsed: Accessor<number>
  liveTokens: Accessor<number>
  liveCost: Accessor<number>
  liveContextPercent: Accessor<number>
  workStartTime: Accessor<number>
  spinnerTick: Accessor<number>
  thinkingElapsed: Accessor<number>
  liveActivity: Accessor<"idle" | "thinking" | "generating" | "tool_executing">
  startTimer(): void
  pauseTimer(): void

  resetMetrics(): void
  resetElapsedTo(ms: number): void
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠸", "⠴", "⠦", "⠇"]

export function useMetrics(entry: () => SessionEntry | undefined): MetricsHook {
  // Store-derived memos — read directly from the registry entry
  const liveTokens = createMemo(() => entry()?.tokens ?? 0)
  const liveCost = createMemo(() => entry()?.cost ?? 0)
  const liveContextPercent = createMemo(() => entry()?.contextPercent ?? 0)
  const liveActivity = createMemo(() => entry()?.modelActivity ?? "idle")

  // Leaf signals — local transient state, not duplicated from the store
  const [workStartTime, setWorkStartTime] = createSignal(0)
  const [elapsed, setElapsed] = createSignal(0)
  const [spinnerTick, setSpinnerTick] = createSignal(0)
  const [thinkingElapsed, setThinkingElapsed] = createSignal(0)

  let elapsedTimer: ReturnType<typeof setInterval> | null = null
  let elapsedAccum = 0
  let elapsedRunStart = 0
  let thinkingStart = 0

  const spinnerTimer = setInterval(() => {
    setSpinnerTick((t) => (t + 1) % SPINNER_FRAMES.length)
    // Derive thinking elapsed from liveActivity — no external ref needed
    const activity = liveActivity()
    if (activity === "thinking") {
      if (thinkingStart === 0) thinkingStart = Date.now()
      setThinkingElapsed(Math.floor((Date.now() - thinkingStart) / 1000))
    } else {
      if (thinkingStart !== 0) {
        thinkingStart = 0
        setThinkingElapsed(0)
      }
    }
  }, 150)
  onCleanup(() => clearInterval(spinnerTimer))

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
    // Stop any running timer first — prevents pauseTimer() from re-accumulating
    // stale time after we reset elapsedAccum to 0.
    if (elapsedTimer) {
      clearInterval(elapsedTimer)
      elapsedTimer = null
    }
    elapsedRunStart = 0
    elapsedAccum = 0
    thinkingStart = 0
    // Only reset leaf signals — the 4 store-derived memos (liveTokens, liveCost,
    // liveContextPercent, liveActivity) reset implicitly when the store entry is cleared.
    batch(() => {
      setWorkStartTime(Date.now())
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
    workStartTime,
    spinnerTick,
    thinkingElapsed,
    liveActivity,
    startTimer,
    pauseTimer,
    resetMetrics,
    resetElapsedTo,
  }
}

export { SPINNER_FRAMES }
