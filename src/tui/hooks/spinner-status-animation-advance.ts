import type { AnimationInput, AnimationState } from "./spinner-status-animation.js"

export const THINKING_RAMP_START_MS = 10_000
const THINKING_RAMP_END_MS = 20_000
const INTENSITY_RAMP_MS = 10_000
const THINKING_DISPLAY_MS = 5_000

// Easing samples at the 50ms tick cadence. Catch-up after a hidden/paused
// period is capped at EASE_DT_CAP_MS so re-foregrounding never fires a burst of
// convergence steps.
const EASE_STEP_MS = 50
const EASE_DT_CAP_MS = 200

interface ThinkingAdvance {
  thinkingStartedAt: number | null
  completedThinkingMs: number | null
  thinkingEndedAt: number | null
  displayedChars: number
}

interface StreamingAdvance {
  displayedChars: number
  lastStreamingChars: number
  lastTokenTime: number
  timeSinceLastToken: number
}

interface EasingAdvance {
  easedStallIntensity: number
  easedThinkingIntensity: number
  lastEaseAt: number
}

export interface AnimationAdvance {
  thinking: ThinkingAdvance
  streaming: StreamingAdvance
  easing: EasingAdvance
}

export function advanceAnimationInternals(
  prev: AnimationState,
  input: AnimationInput,
  nowMs: number,
  stallThresholdMs: number,
  statusHeld: boolean,
): AnimationAdvance {
  // While idle the animation tick is gated off, so prev's clocks and eased
  // intensities go stale. Both idle frames and the idle-to-active transition
  // start fresh; otherwise the first active frame reads the idle gap as a
  // stall and inherits the previous turn's color intensity.
  const freshClock = !input.agentActive || !prev.agentActive
  const resetStall = input.activity !== prev.activity || statusHeld || prev.statusHeld
  const thinking = advanceThinkingTiming(prev, input, nowMs)
  const streaming = advanceStreamingProgress(prev, input, nowMs, thinking.displayedChars, freshClock, resetStall)
  const rawStall = streaming.timeSinceLastToken >= stallThresholdMs
    ? Math.min((streaming.timeSinceLastToken - stallThresholdMs) / INTENSITY_RAMP_MS, 1)
    : 0
  const thinkingElapsedMs = thinking.thinkingStartedAt !== null ? nowMs - thinking.thinkingStartedAt : null
  const rawThinking = thinkingElapsedMs !== null
    ? Math.min(Math.max((thinkingElapsedMs - THINKING_RAMP_START_MS) / (THINKING_RAMP_END_MS - THINKING_RAMP_START_MS), 0), 1)
    : 0
  const easing = freshClock
    ? { easedStallIntensity: rawStall, easedThinkingIntensity: rawThinking, lastEaseAt: nowMs }
    : advanceEasing(prev, rawStall, rawThinking, nowMs, resetStall)
  return { thinking, streaming, easing }
}

function advanceThinkingTiming(prev: AnimationState, input: AnimationInput, nowMs: number): ThinkingAdvance {
  let thinkingStartedAt = prev.thinkingStartedAt
  let completedThinkingMs = prev.completedThinkingMs
  let thinkingEndedAt = prev.thinkingEndedAt
  let displayedChars = prev.displayedChars

  if (input.activity === "thinking" && prev.activity !== "thinking") {
    thinkingStartedAt = nowMs
    completedThinkingMs = null
    thinkingEndedAt = null
  } else if (input.activity !== "thinking" && prev.activity === "thinking" && thinkingStartedAt !== null) {
    completedThinkingMs = nowMs - thinkingStartedAt
    thinkingStartedAt = null
    thinkingEndedAt = nowMs
  }

  if (!input.agentActive) {
    completedThinkingMs = null
    thinkingStartedAt = null
    thinkingEndedAt = null
    displayedChars = 0
  }
  if (thinkingEndedAt !== null && nowMs - thinkingEndedAt > THINKING_DISPLAY_MS) {
    completedThinkingMs = null
    thinkingEndedAt = null
  }
  return { thinkingStartedAt, completedThinkingMs, thinkingEndedAt, displayedChars }
}

function advanceStreamingProgress(prev: AnimationState, input: AnimationInput, nowMs: number, seedDisplayedChars: number, freshClock: boolean, resetStall: boolean): StreamingAdvance {
  if (freshClock) {
    return { displayedChars: seedDisplayedChars, lastStreamingChars: input.realChars, lastTokenTime: nowMs, timeSinceLastToken: 0 }
  }

  const displayedChars = nextDisplayedChars(seedDisplayedChars, input.realChars)
  const charsChanged = input.realChars !== prev.lastStreamingChars
  if (resetStall || charsChanged || activityResetsStall(input.activity)) {
    return { displayedChars, lastStreamingChars: input.realChars, lastTokenTime: nowMs, timeSinceLastToken: 0 }
  }
  return {
    displayedChars,
    lastStreamingChars: prev.lastStreamingChars,
    lastTokenTime: prev.lastTokenTime,
    timeSinceLastToken: nowMs - prev.lastTokenTime,
  }
}

function nextDisplayedChars(displayedChars: number, realChars: number): number {
  if (realChars < displayedChars) return realChars
  const gap = realChars - displayedChars
  if (gap <= 0) return displayedChars
  const increment = gap < 70 ? 3 : gap < 200 ? Math.max(8, Math.ceil(gap * 0.15)) : 50
  return Math.min(displayedChars + increment, realChars)
}

function activityResetsStall(activity: AnimationInput["activity"]): boolean {
  return activity === null ||
    activity === "thinking" ||
    activity === "tool_executing"
}

function advanceEasing(prev: AnimationState, rawStall: number, rawThinking: number, nowMs: number, resetStall: boolean): EasingAdvance {
  const elapsedForEase = nowMs - prev.lastEaseAt
  const clampedDt = Math.min(elapsedForEase, EASE_DT_CAP_MS)
  const steps = clampedDt >= EASE_STEP_MS ? Math.floor(clampedDt / EASE_STEP_MS) : 0
  return {
    easedStallIntensity: resetStall ? 0 : steps > 0 ? easeToward(prev.easedStallIntensity, rawStall, steps) : prev.easedStallIntensity,
    easedThinkingIntensity: steps > 0 ? easeToward(prev.easedThinkingIntensity, rawThinking, steps) : prev.easedThinkingIntensity,
    lastEaseAt: nextEaseTimestamp(prev.lastEaseAt, elapsedForEase, steps, nowMs),
  }
}

function easeToward(current: number, target: number, steps: number): number {
  let value = current
  for (let i = 0; i < steps; i++) {
    const delta = target - value
    value += Math.abs(delta) < 0.01 ? delta : delta * 0.1
  }
  return value
}

function nextEaseTimestamp(previous: number, elapsedForEase: number, steps: number, nowMs: number): number {
  // Advance the easing clock by whole steps only, preserving sub-step residual
  // so a fast streaming burst still accumulates toward the next step. A gap
  // beyond the cap snaps the clock to now, dropping hidden/paused catch-up.
  if (elapsedForEase > EASE_DT_CAP_MS) return nowMs
  return steps > 0 ? previous + steps * EASE_STEP_MS : previous
}
