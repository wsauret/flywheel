import { formatActivity, formatElapsed, formatTokens } from "../../protocol/client/format.js"
import type { ConnectionState, StreamPhase } from "../../infra/output-blocks.js"
import type { SessionNotice } from "../../infra/session-notice.js"
import { noticeSpinnerStatus } from "./spinner-status-notice.js"
import {
  advanceDisplayActivity,
  initialDisplayActivityState,
  type DisplayActivityFields,
} from "./spinner-status-display-activity.js"
import {
  advanceAnimationInternals,
  THINKING_RAMP_START_MS,
} from "./spinner-status-animation-advance.js"

type SpinnerColorMode = "normal" | "stalled" | "thinking-long"

interface MetadataSegment {
  text: string
  colored: boolean
  action?: StatusAction
}

/** A status segment a person can press: the background process list. The
 *  status line never carries session controls; Resume is a prompt key hint
 *  and Interrupt is Escape (PI-INTERACTION-043). */
type StatusAction = "background"

export interface SpinnerStatus {
  verb: string
  segments: MetadataSegment[]
  colorMode: SpinnerColorMode
  indicator: "spinner" | "circle"
  intensity: number
}

const STATUS_PADDING = 6
const METADATA_SEP = "──"
const METADATA_SEPARATOR_WIDTH = " ── ".length
export const STALL_THRESHOLDS = [10_000, 45_000, 300_000] as const
export const STALL_THRESHOLD_MS = STALL_THRESHOLDS[0]
const ACTIVITY_VERB_WIDTH = "Generating".length

function activityLabel(activity: StreamPhase | null): string {
  if (activity === null) return "Idle".padEnd(ACTIVITY_VERB_WIDTH)
  return formatActivity(activity === "tool_executing" ? "executing_tools" : activity).padEnd(ACTIVITY_VERB_WIDTH)
}

function thinkingReassurance(elapsedMs: number): string {
  if (elapsedMs >= 90_000) return "hang tight"
  if (elapsedMs >= 45_000) return "almost there"
  if (elapsedMs >= 30_000) return "this one's tricky"
  if (elapsedMs >= 20_000) return "bear with me"
  return "working on it"
}

interface SegmentInputs {
  activity: StreamPhase | null
  estimatedTokens: number
  thinkingElapsedMs: number | null
  completedThinkingMs: number | null
}

function backgroundProcessSegments(count: number): MetadataSegment[] {
  return count > 0
    ? [{ text: `${count} background process${count === 1 ? "" : "es"}`, colored: false, action: "background" }]
    : []
}

function buildSegments(s: SegmentInputs): MetadataSegment[] {
  const segs: MetadataSegment[] = []
  const thinkingElapsedMs = s.thinkingElapsedMs
  const showThinkingHint = thinkingElapsedMs !== null && thinkingElapsedMs >= THINKING_RAMP_START_MS

  if (showThinkingHint) {
    segs.push({ text: `for ${formatElapsed(thinkingElapsedMs)}`, colored: false })
  }

  if (s.estimatedTokens > 0) {
    // ↑ means waiting for the first token; ↓ means response tokens are streaming.
    const arrow = s.activity === "waiting" ? "↑" : "↓"
    segs.push({ text: `${arrow} ${formatTokens(s.estimatedTokens, { preserveDecimal: true })} tokens`, colored: false })
  }

  if (showThinkingHint) {
    segs.push({ text: thinkingReassurance(thinkingElapsedMs), colored: true })
  }

  if (s.completedThinkingMs !== null && s.completedThinkingMs >= 2000) {
    segs.push({ text: `thought for ${formatElapsed(s.completedThinkingMs)}`, colored: false })
  }

  return segs
}


function connectionStatus(state: ConnectionState): SpinnerStatus | null {
  if (state === "down") return { verb: "Disconnected", segments: [], colorMode: "stalled", intensity: 1, indicator: "spinner" }
  // Between runners the session is being re-seated, which is nobody's status.
  if (state === "reconnecting") return null
  if (state === "retrying") return { verb: "Retrying", segments: [], colorMode: "stalled", intensity: 0.5, indicator: "spinner" }
  if (state === "connecting") return { verb: "Connecting", segments: [], colorMode: "normal", intensity: 0.5, indicator: "spinner" }
  return null
}

function composeSegments(verb: string, segments: MetadataSegment[], width: number): MetadataSegment[] {
  const budget = width - verb.length - STATUS_PADDING
  if (budget <= 0) return []

  const result: MetadataSegment[] = []
  let totalLen = 0
  for (const seg of segments) {
    const addedLen = totalLen > 0 ? METADATA_SEPARATOR_WIDTH + seg.text.length : seg.text.length
    if (totalLen + addedLen > budget) break
    result.push(seg)
    totalLen += addedLen
  }
  return result
}

export interface AnimationState extends DisplayActivityFields {
  activity: StreamPhase | null
  agentActive: boolean
  backgroundWaitActive: boolean
  connectionState: ConnectionState
  statusHeld: boolean
  thinkingStartedAt: number | null
  completedThinkingMs: number | null
  thinkingEndedAt: number | null
  displayedChars: number
  lastStreamingChars: number
  lastTokenTime: number
  timeSinceLastToken: number
  easedStallIntensity: number
  easedThinkingIntensity: number
  lastSampledAt: number
  lastEaseAt: number
}

export interface AnimationInput {
  activity: StreamPhase | null
  realChars: number
  agentActive: boolean
  backgroundWaitActive: boolean
  connectionState: ConnectionState
  compacting: boolean
  notice: SessionNotice | null
}

interface BuildStatusInputs {
  terminalWidth: number
  compacting: boolean
  activeBackgroundProcessCount: number
  /** What a parked session waits on ("Waiting on parent"), which replaces
   *  the bare Waiting while the session waits on a reply. */
  waitingOn?: string | undefined
  notice?: SessionNotice | null
  nowMs?: number
}

export function initialAnimationState(seedChars: number, nowMs = Date.now()): AnimationState {
  return {
    activity: null,
    agentActive: false,
    backgroundWaitActive: false,
    connectionState: "connected",
    statusHeld: false,
    ...initialDisplayActivityState(nowMs),
    thinkingStartedAt: null,
    completedThinkingMs: null,
    thinkingEndedAt: null,
    // Snap to live chars rather than 0: on tab switch the new session may
    // already be mid-stream, so the spinner shows the correct token count
    // immediately and smooths only subsequent growth.
    displayedChars: seedChars,
    lastStreamingChars: seedChars,
    lastTokenTime: nowMs,
    timeSinceLastToken: 0,
    easedStallIntensity: 0,
    easedThinkingIntensity: 0,
    lastSampledAt: nowMs,
    lastEaseAt: nowMs,
  }
}

export function advanceAnimation(prev: AnimationState, input: AnimationInput, nowMs: number): AnimationState {
  // A park, compaction, notice, or connection problem is not a stall: no stall
  // time builds up under it, and the activity that follows starts neutral.
  const statusHeld = input.backgroundWaitActive || input.connectionState !== "connected" || input.compacting || input.notice !== null
  const { thinking, streaming, easing } = advanceAnimationInternals(prev, input, nowMs, STALL_THRESHOLD_MS, statusHeld)

  const display = advanceDisplayActivity(prev, { activity: input.activity, realChars: input.realChars, displayedChars: streaming.displayedChars, agentActive: input.agentActive, nowMs })

  return {
    activity: input.activity,
    rawActivitySince: display.rawActivitySince,
    displayActivity: display.displayActivity,
    displayActivitySince: display.displayActivitySince,
    candidateActivity: display.candidateActivity,
    candidateSince: display.candidateSince,
    mismatchSince: display.mismatchSince,
    agentActive: input.agentActive,
    backgroundWaitActive: input.backgroundWaitActive,
    connectionState: input.connectionState,
    statusHeld,
    thinkingStartedAt: thinking.thinkingStartedAt,
    completedThinkingMs: thinking.completedThinkingMs,
    thinkingEndedAt: thinking.thinkingEndedAt,
    displayedChars: streaming.displayedChars,
    lastStreamingChars: streaming.lastStreamingChars,
    lastTokenTime: streaming.lastTokenTime,
    timeSinceLastToken: streaming.timeSinceLastToken,
    easedStallIntensity: easing.easedStallIntensity,
    easedThinkingIntensity: easing.easedThinkingIntensity,
    lastSampledAt: nowMs,
    lastEaseAt: easing.lastEaseAt,
  }
}

export function buildStatus(state: AnimationState, live: BuildStatusInputs): SpinnerStatus | null {
  const notice = live.notice
  if (notice) return noticeSpinnerStatus(notice, live.terminalWidth, live.nowMs)

  const connStatus = connectionStatus(state.connectionState)
  if (connStatus) return connStatus

  if (live.compacting) {
    return { verb: "Compacting", segments: [], colorMode: "normal", intensity: 0, indicator: "spinner" }
  }

  const processSegments = backgroundProcessSegments(live.activeBackgroundProcessCount)
  if (state.backgroundWaitActive) {
    const verb = live.waitingOn ?? "Waiting"
    return { verb, segments: composeSegments(verb, processSegments, live.terminalWidth), colorMode: "normal", intensity: 0, indicator: "spinner" }
  }
  if (!state.agentActive) {
    if (processSegments.length === 0) return null
    const verb = activityLabel(null)
    return { verb, segments: composeSegments(verb, processSegments, live.terminalWidth), colorMode: "normal", intensity: 0, indicator: "circle" }
  }

  const activity = state.displayActivity ?? state.activity

  const verb = activityLabel(activity)
  const width = live.terminalWidth

  if (state.timeSinceLastToken >= STALL_THRESHOLD_MS) {
    const stalledSegments = [
      ...processSegments,
      ...buildSegments({
        activity,
        estimatedTokens: Math.round(state.displayedChars / 4),
        thinkingElapsedMs: null,
        completedThinkingMs: null,
      }),
    ]
    const segments = composeSegments(verb, stalledSegments, width)
    return { verb, segments, colorMode: "stalled", intensity: state.easedStallIntensity, indicator: "spinner" }
  }

  const thinkingElapsedMs = state.thinkingStartedAt !== null ? state.lastSampledAt - state.thinkingStartedAt : null
  const allSegments = [
    ...processSegments,
    ...buildSegments({
      activity,
      estimatedTokens: Math.round(state.displayedChars / 4),
      thinkingElapsedMs,
      completedThinkingMs: activity === "thinking" ? null : state.completedThinkingMs,
    }),
  ]
  const segments = composeSegments(verb, allSegments, width)
  const indicator = activity === null ? "circle" : "spinner"
  const colorMode: SpinnerColorMode = state.easedThinkingIntensity > 0 ? "thinking-long" : "normal"
  return { verb, segments, colorMode, intensity: state.easedThinkingIntensity, indicator }
}

export function statusEquals(a: SpinnerStatus | null, b: SpinnerStatus | null): boolean {
  if (a === null || b === null) return a === b
  if (a.verb !== b.verb || a.colorMode !== b.colorMode || a.intensity !== b.intensity || a.indicator !== b.indicator) return false
  if (a.segments.length !== b.segments.length) return false
  return a.segments.every((seg, i) => {
    const other = b.segments[i]
    return other !== undefined && seg.text === other.text && seg.colored === other.colored && seg.action === other.action
  })
}

/** Prompt-border status pieces: status text, ordinary muted metadata, and
 *  horizontal-rule filler that visually continues the prompt border. */
export interface StatusLinePart {
  text: string
  tone: "status" | "metadata" | "muted" | "border"
  action?: StatusAction
}


const BORDER_RULE = "─"
function displayVerb(verb: string): StatusLinePart[] {
  const normalized = verb.trim().replace(/(?:…|\.\.\.)+$/u, "")
  if (!["Idle", "Waiting", "Thinking", "Generating", "Executing"].includes(normalized)) {
    return [{ text: ` ${verb} `, tone: "status" }]
  }

  const borderFill = BORDER_RULE.repeat(Math.max(0, ACTIVITY_VERB_WIDTH - normalized.length))
  return borderFill
    ? [{ text: ` ${normalized} `, tone: "status" }, { text: borderFill, tone: "border" }]
    : [{ text: ` ${normalized} `, tone: "status" }]
}

/** Ordered text pieces of the prompt-border status label, excluding the
 *  animated spinner frame. Details are separated by horizontal-rule cells so
 *  the label reads as text woven into the border instead of text surrounded by gaps. */
export function statusLineParts(status: SpinnerStatus): StatusLinePart[] {
  const parts: StatusLinePart[] = displayVerb(status.verb)
  for (const seg of status.segments) {
    parts.push(
      { text: METADATA_SEP, tone: "border" },
      { text: ` ${seg.text} `, tone: seg.colored ? "status" : "metadata", ...(seg.action ? { action: seg.action } : {}) },
    )
  }
  return parts
}
