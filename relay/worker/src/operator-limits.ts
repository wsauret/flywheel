/** The limits the relay's operator sets with Worker variables
 *  (`worker/wrangler.jsonc`, or the dashboard), so they change with a deploy
 *  of the configuration and no code change. A variable that is not set, or
 *  that does not parse, takes the default here. */

/** What one runtime id's channels may carry in one UTC day, in GiB
 *  (`RELAY_DAILY_GIB`). Production's heaviest runtime id sent 205,889
 *  WebSocket messages in its busiest UTC day of the 29 to 2026-10-27, and a
 *  sealed frame of transcript traffic is a few KiB, so a heavy day is under
 *  1 GiB; the default is about ten times that. */
const DEFAULT_DAILY_GIB = 8

/** The bytes one runtime id's channels may carry today, from `RELAY_DAILY_GIB`. */
export function dailyBudgetBytes(configured: string | undefined): number {
  const gib = Number(configured)
  return (configured !== undefined && configured.trim() !== "" && Number.isFinite(gib) && gib > 0 ? gib : DEFAULT_DAILY_GIB) * 1024 ** 3
}

/** Bytes counted on one UTC day. */
export interface DayBytes {
  readonly day: string
  readonly bytes: number
}

export function utcDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10)
}

/** The bytes `value` counts on `day`; a count from an earlier day is spent. */
export function bytesOn(value: unknown, day: string): number {
  if (typeof value !== "object" || value === null || !("day" in value) || !("bytes" in value)) return 0
  return value.day === day && typeof value.bytes === "number" ? value.bytes : 0
}

/** Which runtimes the relay admits (`RELAY_ADMISSION`), the operator's lever
 *  when the relay is abused: `open` admits every runtime, `existing` only a
 *  runtime id that has attached before, and `closed` none. Sockets already
 *  attached stay attached; the lever acts on each runtime's next attach. */
type RelayAdmission = "open" | "existing" | "closed"

export function relayAdmission(configured: string | undefined): RelayAdmission {
  const value = configured?.trim().toLowerCase()
  return value === "existing" || value === "closed" ? value : "open"
}
