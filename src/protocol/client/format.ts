/**
 * Display formatting for client transcript surfaces. Lives in the shared
 * client core so every client renders the same figures and activity words.
 */

import type { FrontendActivity } from "../app-service-types.js"

/** Reads the automatic deletion threshold: zero disables deletion. */
export function formatAutoDeleteSessionDays(days: number): string {
  return days === 0 ? "Off" : `${days} ${days === 1 ? "day" : "days"}`
}

/** Reads the deletion field's displayed value or a whole number of days.
 * Zero and Off disable deletion; invalid drafts carry the field's error. */
export function parseAutoDeleteSessionDays(text: string): { readonly value: number } | { readonly problem: string } {
  const draft = text.trim()
  if (draft.toLowerCase() === "off") return { value: 0 }
  if (/^\d+(?:\s+days?)?$/i.test(draft)) {
    const days = Number(draft.replace(/\s+days?$/i, ""))
    if (Number.isSafeInteger(days)) return { value: days }
  }
  return { problem: "Enter a whole number of days, or Off." }
}

/** Names live work. An in-flight card can arrive before its status or outlast
 *  its runner, so a missing, absent, or idle status makes no phase claim. */
export function formatActivity(activity: FrontendActivity | undefined): string {
  switch (activity) {
    case "waiting": return "Waiting"
    case "thinking": return "Thinking"
    case "generating": return "Generating"
    case "executing_tools": return "Executing"
    case "awaiting_user": return "Waiting for you"
    case "absent":
    case "idle":
    case undefined: return "Working"
  }
}

export function formatTokens(n: number, options: { preserveDecimal?: boolean } = {}): string {
  if (n < 1000) return n.toString()
  if (n < 1_000_000) return `${formatFixed(n / 1000, options.preserveDecimal)}k`
  return `${formatFixed(n / 1_000_000, options.preserveDecimal)}M`
}

function formatFixed(n: number, preserveDecimal = false): string {
  const fixed = n.toFixed(1)
  return preserveDecimal ? fixed : fixed.replace(/\.0$/, "")
}

export function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  return formatWholeSeconds(totalSec)
}

/** A duration at the precision its unit shows. Each step rounds before it
 *  picks the unit and splits hours, minutes, and seconds, so a rounded figure
 *  carries into the next unit instead of reading `60.0s` or `1m 60s`. */
export function formatDuration(ms: number): string {
  const whole = Math.round(ms)
  if (whole < 1000) return `${whole}ms`
  const tenths = Math.round(whole / 100)
  if (tenths < 600) return `${(tenths / 10).toFixed(1)}s`
  const seconds = Math.round(whole / 1000)
  return formatWholeSeconds(seconds)
}

function formatWholeSeconds(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  if (minutes < 60) return `${minutes}m ${remainder}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ${remainder}s`
}

/** Formats positive USD amounts to the nearest cent; omits nonpositive amounts. */
function formatCost(usd: number): string {
  if (usd <= 0) return ""
  return `$${usd.toFixed(2)}`
}

/** Cost figure split by billing: real API-key spend first in plain form,
 *  subscription-covered value as a "~$" estimate, each shown only when
 *  nonzero. The two parts are disjoint; they sum to the total. */
export function formatCostSplit(totalUsd: number, billedUsd: number): string {
  const billed = formatCost(billedUsd)
  const included = formatCost(totalUsd - billedUsd)
  if (billed && included) return `${billed} · ~${included}`
  if (included) return `~${included}`
  return billed
}

const SHORT_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** A moment as a date and a 24-hour clock time in the reader's zone, such as
 *  `Sep 6, 17:21`, with the year only when it is not this year. Seconds are
 *  noise on anything a person reads back later, and a 12-hour clock needs a
 *  suffix the terminal's narrow rows cannot spare. */
export function formatDateTime(ms: number, now = Date.now()): string {
  const date = new Date(ms)
  const year = date.getFullYear() === new Date(now).getFullYear() ? "" : `, ${date.getFullYear()}`
  const clock = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
  return `${SHORT_MONTHS[date.getMonth()]} ${date.getDate()}${year}, ${clock}`
}

/** System-notice line for a completed compaction. Token counts are the
 *  runtime's heuristic context estimates; paths without a measurement
 *  (failures, no-op compactions, pre-report events) fall back to the
 *  plain notice. */
export function formatCompactionReport(tokensBefore?: number, tokensAfter?: number): string {
  if (tokensBefore == null || tokensAfter == null) return "Context compacted"
  return `Context compacted: ${tokensBefore.toLocaleString("en-US")} → ${tokensAfter.toLocaleString("en-US")} tokens`
}


