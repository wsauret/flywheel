const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 60_000;

/** Exponential backoff with full jitter. `attempt` is the number of attempts
 *  already completed, so the first retry (attempt=1) waits ~500ms-1s. */
export function backoffMs(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** attempt);
  return Math.floor(ceiling / 2 + random() * (ceiling / 2));
}
