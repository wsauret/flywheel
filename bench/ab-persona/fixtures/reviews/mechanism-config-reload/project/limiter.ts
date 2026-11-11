import type { ConfigStore } from "./config.ts";

export interface RateLimiter {
  /** Whether this client may make one more request now. */
  allow(clientId: string): boolean;
}

interface Window {
  startedAt: number;
  count: number;
}

const WINDOW_MS = 60_000;

/** Fixed one-minute windows per client, with a burst allowance on top of the
 *  per-minute budget for clients that were idle in the previous window. */
export function createRateLimiter(config: ConfigStore, now: () => number): RateLimiter {
  const { requestsPerMinute, burst } = config.current().limits;
  const windows = new Map<string, Window>();
  const idleLastWindow = new Set<string>();

  return {
    allow(clientId) {
      const time = now();
      let window = windows.get(clientId);
      if (window === undefined || time - window.startedAt >= WINDOW_MS) {
        if (window === undefined || time - window.startedAt >= 2 * WINDOW_MS) idleLastWindow.add(clientId);
        else idleLastWindow.delete(clientId);
        window = { startedAt: time, count: 0 };
        windows.set(clientId, window);
      }
      const budget = requestsPerMinute + (idleLastWindow.has(clientId) ? burst : 0);
      if (window.count >= budget) return false;
      window.count++;
      return true;
    },
  };
}
