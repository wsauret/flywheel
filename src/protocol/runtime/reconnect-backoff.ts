const RECONNECT_BASE_MS = 250
const RECONNECT_MAX_MS = 30_000
export const MAX_RECONNECT_ATTEMPT = 16

/** Exponential backoff with jitter, so several clients recovering from one
 *  runtime restart do not arrive together. The runtime's relay control channel
 *  waits by the same rule, so a relay outage sees one retry shape from both
 *  sides. */
export function reconnectBackoffMs(attempt: number, random: () => number = Math.random): number {
  const grown = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS)
  return grown * (0.5 + random() * 0.5)
}
