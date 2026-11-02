import type { HeartbeatClock } from "../../src/protocol/modules/remote/relay-channel.js"

/** A heartbeat clock that stays still while socket and crypto setup settles. */
export function manualHeartbeatClock(): { readonly clock: HeartbeatClock; readonly advance: (ms: number) => void; readonly now: () => number } {
  let now = 0
  const timers = new Set<{ readonly intervalMs: number; readonly callback: () => void; next: number }>()
  return {
    now: () => now,
    clock: {
      every(intervalMs, callback) {
        const timer = { intervalMs, callback, next: now + intervalMs }
        timers.add(timer)
        return () => { timers.delete(timer) }
      },
    },
    advance(ms) {
      const target = now + ms
      for (;;) {
        const next = Math.min(...[...timers].map((timer) => timer.next))
        if (next > target) break
        now = next
        for (const timer of [...timers]) {
          if (timer.next !== next || !timers.has(timer)) continue
          timer.next += timer.intervalMs
          timer.callback()
        }
      }
      now = target
    },
  }
}
