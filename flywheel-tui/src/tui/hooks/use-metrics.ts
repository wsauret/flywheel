import { createSignal, onCleanup } from "solid-js"
import type { Accessor } from "solid-js"

export interface MetricsHook {
  elapsed: Accessor<number>
  liveTokens: Accessor<number>
  liveCost: Accessor<number>
  workStartTime: Accessor<number>
  spinnerTick: Accessor<number>
  thinkingElapsed: Accessor<number>
  liveActivity: Accessor<"idle" | "thinking" | "generating" | "tool_executing">
  setTokens(n: number): void
  setCost(n: number): void
  setActivity(a: "idle" | "thinking" | "generating" | "tool_executing"): void
  startTimer(): void
  pauseTimer(): void
  stopTimer(): void
  resetMetrics(): void
  resetElapsedTo(ms: number): void
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠸", "⠴", "⠦", "⠇"]

export function useMetrics(): MetricsHook {
  const [liveTokens, setLiveTokens] = createSignal(0)
  const [liveCost, setLiveCost] = createSignal(0)
  const [workStartTime, setWorkStartTime] = createSignal(0)
  const [elapsed, setElapsed] = createSignal(0)
  const [spinnerTick, setSpinnerTick] = createSignal(0)
  const [thinkingElapsed, setThinkingElapsed] = createSignal(0)
  const [liveActivity, setLiveActivity] = createSignal<"idle" | "thinking" | "generating" | "tool_executing">("idle")

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

  function stopTimer(): void { pauseTimer() }

  function resetMetrics(): void {
    setWorkStartTime(Date.now())
    setElapsed(0)
    elapsedAccum = 0
    setLiveTokens(0)
    setLiveCost(0)
    thinkingStart = 0
    setThinkingElapsed(0)
    setLiveActivity("idle")
  }

  function resetElapsedTo(ms: number): void {
    elapsedAccum = ms
    setElapsed(ms)
  }

  onCleanup(() => stopTimer())

  return {
    elapsed,
    liveTokens,
    liveCost,
    workStartTime,
    spinnerTick,
    thinkingElapsed,
    liveActivity,
    setTokens: setLiveTokens,
    setCost: setLiveCost,
    setActivity: setLiveActivity,
    startTimer,
    pauseTimer,
    stopTimer,
    resetMetrics,
    resetElapsedTo,
  }
}

export { SPINNER_FRAMES }
