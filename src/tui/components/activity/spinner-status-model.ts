import type { ConnectionState, StreamPhase } from "../../../infra/substrate/events/output-blocks.js"
import type { SessionNotice } from "../../../infra/substrate/events/session-notice.js"
import type { DisplayActivityFields } from "./spinner-status-display-activity.js"

export type SpinnerColorMode = "normal" | "stalled" | "thinking-long"

/** A status segment a person can press: the background process list. The
 *  status line never carries session controls; Resume is a prompt key hint
 *  and Interrupt is Escape (PI-INTERACTION-043, PI-INTERACTION-103). */
export type StatusAction = "background"

export interface MetadataSegment {
  text: string
  colored: boolean
  action?: StatusAction
}

export interface SpinnerStatus {
  verb: string
  segments: MetadataSegment[]
  colorMode: SpinnerColorMode
  indicator: "spinner" | "circle"
  intensity: number
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

const STATUS_PADDING = 6
const METADATA_SEPARATOR_WIDTH = " ── ".length

/** The leading segments that fit on one status line of `width` cells after the verb. */
export function composeSegments(verb: string, segments: MetadataSegment[], width: number): MetadataSegment[] {
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
