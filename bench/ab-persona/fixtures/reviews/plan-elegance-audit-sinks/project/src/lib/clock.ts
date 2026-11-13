/** The current time as an ISO 8601 UTC string. Tests replace the clock through the `now` parameter of their caller. */
export function nowIso(now: Date = new Date()): string {
  return now.toISOString();
}
