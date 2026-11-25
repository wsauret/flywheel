import { capacityWaitReasonText, type SessionNotice } from "../../../infra/substrate/events/session-notice.js"
import { formatDateTime } from "../../../protocol/client/format.js"
import { composeSegments, type MetadataSegment, type SpinnerStatus } from "./spinner-status-model.js"

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
    const { model, reason } = notice.wait
    if (model !== undefined && reason !== undefined) segments.push({ text: `${model}: ${capacityWaitReasonText(reason)}`, colored: false })
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

function formatNoticeDelay(delayMs: number): string {
  if (delayMs < 1000) return `${Math.max(0, Math.round(delayMs))}ms`
  return `${Math.ceil(delayMs / 1000)}s`
}
