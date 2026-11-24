/** A timestamp as the distance from now, in the shortest form that still reads:
 *  `now`, `4m`, `3h`, `2d`, then a calendar date. The session list shows this in
 *  a narrow right-hand column, so every form is at most five characters. */
export function formatTimeAgo(iso: string, now = Date.now()): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ""
  const seconds = Math.max(0, Math.round((now - then) / 1000))
  if (seconds < 60) return "now"
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.round(hours / 24)
  if (days < 7) return `${days}d`
  const date = new Date(then)
  return `${date.toLocaleString(undefined, { month: "short" })} ${date.getDate()}`
}

/** A start time on the reader's clock, with its date when it is not today. */
export function formatClock(timestamp: number, locale?: string, now = Date.now()): string {
  const parts = formatClockParts(timestamp, locale, now)
  return parts.date === undefined ? parts.time : `${parts.date} · ${parts.time}`
}

/** The same clock and optional date as separate layout parts. */
export function formatClockParts(timestamp: number, locale?: string, now = Date.now()) {
  const date = new Date(timestamp)
  const today = new Date(now)
  return {
    time: date.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" }),
    date: date.toDateString() === today.toDateString() ? undefined : date.toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" }),
  }
}

