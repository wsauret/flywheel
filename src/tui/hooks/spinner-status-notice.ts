import type { SessionNotice } from "../../infra/session-notice.js"
import { formatDateTime } from "../../protocol/client/format.js"
import type { SpinnerStatus } from "./spinner-status-animation.js"

interface MetadataSegment {
  text: string
  colored: boolean
}

const STATUS_PADDING = 6
const METADATA_SEPARATOR_WIDTH = " ── ".length

export function noticeSpinnerStatus(notice: SessionNotice, width: number, nowMs = Date.now()): SpinnerStatus {
  // Only status-channel notices reach this line (shell-state routes pinned
  // and toast presentations to their own surfaces), so every notice here is
  // in-flight progress.
  const retry = notice.retry
  const verb = retry
    ? "Retrying"
    : notice.severity === "error"
      ? "Disconnected"
      : "Waiting"
  const segments: MetadataSegment[] = [{ text: notice.title, colored: notice.severity !== "info" }]
  if (notice.wait) {
    segments.push({ text: `${notice.wait.agentName} continues at ${formatDateTime(notice.wait.continuesAt, nowMs)}`, colored: false })
  }
  if (retry) {
    const attempt = retry.maxRetries ? `${retry.count}/${retry.maxRetries}` : `${retry.count}`
    segments.push({ text: `retry ${attempt}`, colored: false })
    const remainingMs = retry.nextAttemptAt !== undefined
      ? Math.max(0, retry.nextAttemptAt - nowMs)
      : retry.delayMs
    if (remainingMs !== undefined) segments.push({ text: formatNoticeDelay(remainingMs), colored: true })
  }
  if (notice.action) {
    segments.push({ text: notice.action.command ?? notice.action.label, colored: true })
  }
  return {
    verb,
    segments: composeSegments(verb, segments, width),
    colorMode: notice.severity === "info" ? "normal" : "stalled",
    intensity: notice.severity === "error" ? 1 : notice.severity === "warning" ? 0.5 : 0,
    indicator: "spinner",
  }
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

function formatNoticeDelay(delayMs: number): string {
  if (delayMs < 1000) return `${Math.max(0, Math.round(delayMs))}ms`
  return `${Math.ceil(delayMs / 1000)}s`
}
