import type { StreamLivenessOptions } from "../../../../../src/orchestration/agent-runtime/llm/stream-liveness.js";

type LivenessClock = NonNullable<StreamLivenessOptions["clock"]>;

/** A liveness clock that moves only when the test advances it. `advance` fires
 *  each due timer at its own due time, in order, including timers that a fired
 *  timer arms within the advanced span. */
export function controlledClock() {
  let now = 1;
  let timersSet = 0;
  let order = 0;
  const timers = new Set<{ at: number; order: number; callback: () => void }>();
  const clock: LivenessClock = {
    now: () => now,
    setTimer: (callback, delayMs) => {
      timersSet += 1;
      const timer = { at: now + delayMs, order: order++, callback };
      timers.add(timer);
      return () => { timers.delete(timer); };
    },
  };
  const flush = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  };
  const nextDue = (until: number) => [...timers]
    .filter((timer) => timer.at <= until)
    .sort((a, b) => a.at - b.at || a.order - b.order)[0];
  return {
    clock,
    /** How many timers the clock armed. */
    get sleepCalls() { return timersSet; },
    get pendingSleeps() { return timers.size; },
    async advance(ms: number): Promise<void> {
      await flush();
      const until = now + ms;
      for (let timer = nextDue(until); timer; timer = nextDue(until)) {
        timers.delete(timer);
        now = timer.at;
        timer.callback();
      }
      now = until;
      await flush();
    },
  };
}
