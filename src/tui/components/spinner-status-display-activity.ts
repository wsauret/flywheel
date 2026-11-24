import type { StreamPhase } from "../../infra/output-blocks.js"

const STATUS_CONFIRM_MS = 200
const STATUS_MIN_DWELL_MS = 400
const STATUS_MAX_LAG_MS = 500
const STATUS_IDLE_HOLD_MS = 200

export interface DisplayActivityFields {
  rawActivitySince: number
  displayActivity: StreamPhase | null
  displayActivitySince: number
  candidateActivity: StreamPhase | null
  candidateSince: number | null
  mismatchSince: number | null
}

interface DisplayActivityState extends DisplayActivityFields {
  activity: StreamPhase | null
  agentActive: boolean
  lastStreamingChars: number
  displayedChars: number
}

interface DisplayActivityInput {
  activity: StreamPhase | null
  realChars: number
  displayedChars: number
  agentActive: boolean
  nowMs: number
}

function effectiveActivity(activity: StreamPhase | null, agentActive: boolean): StreamPhase | null {
  return agentActive ? activity : null
}

function promotedActivity(activity: StreamPhase | null, rawActivitySince: number, nowMs: number): DisplayActivityFields {
  return {
    rawActivitySince,
    displayActivity: activity,
    displayActivitySince: nowMs,
    candidateActivity: null,
    candidateSince: null,
    mismatchSince: null,
  }
}

export function initialDisplayActivityState(nowMs: number): DisplayActivityFields {
  return {
    rawActivitySince: nowMs,
    displayActivity: null,
    displayActivitySince: nowMs,
    candidateActivity: null,
    candidateSince: null,
    mismatchSince: null,
  }
}

export function advanceDisplayActivity(prev: DisplayActivityState, input: DisplayActivityInput): DisplayActivityFields {
  const rawActivity = effectiveActivity(input.activity, input.agentActive)
  const previousRawActivity = effectiveActivity(prev.activity, prev.agentActive)
  const rawActivitySince = rawActivity === previousRawActivity ? prev.rawActivitySince : input.nowMs
  const charsIncreased = input.realChars > prev.lastStreamingChars
  const displayedCharsIncreased = input.displayedChars > prev.displayedChars

  if (!input.agentActive && prev.displayActivity !== null) {
    return promotedActivity(null, rawActivitySince, input.nowMs)
  }

  if (rawActivity === prev.displayActivity) {
    return {
      rawActivitySince,
      displayActivity: prev.displayActivity,
      displayActivitySince: prev.displayActivitySince,
      candidateActivity: null,
      candidateSince: null,
      mismatchSince: null,
    }
  }

  const mismatchSince = prev.mismatchSince ?? rawActivitySince
  const mismatchAge = input.nowMs - mismatchSince

  if (rawActivity === null) {
    if (!displayedCharsIncreased && (input.nowMs - rawActivitySince >= STATUS_IDLE_HOLD_MS || mismatchAge >= STATUS_MAX_LAG_MS)) {
      return promotedActivity(null, rawActivitySince, input.nowMs)
    }
    return {
      rawActivitySince,
      displayActivity: prev.displayActivity,
      displayActivitySince: prev.displayActivitySince,
      candidateActivity: null,
      candidateSince: rawActivitySince,
      mismatchSince,
    }
  }

  if (prev.displayActivity === null || (rawActivity === "generating" && charsIncreased)) {
    return promotedActivity(rawActivity, rawActivitySince, input.nowMs)
  }

  const candidateSince = prev.candidateActivity === rawActivity && prev.candidateSince !== null ? prev.candidateSince : rawActivitySince
  const candidateAge = input.nowMs - candidateSince
  const displayAge = input.nowMs - prev.displayActivitySince

  if ((candidateAge >= STATUS_CONFIRM_MS && displayAge >= STATUS_MIN_DWELL_MS) || mismatchAge >= STATUS_MAX_LAG_MS) {
    return promotedActivity(rawActivity, rawActivitySince, input.nowMs)
  }

  return {
    rawActivitySince,
    displayActivity: prev.displayActivity,
    displayActivitySince: prev.displayActivitySince,
    candidateActivity: rawActivity,
    candidateSince,
    mismatchSince,
  }
}
