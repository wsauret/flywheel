import { Clock, Duration, Effect } from "effect";

export function controlledClock() {
  let now = 1;
  let sleepCalls = 0;
  const sleepers = new Set<{ at: number; resume: (effect: Effect.Effect<void>) => void }>();
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => now,
    currentTimeMillis: Effect.sync(() => now),
    currentTimeNanosUnsafe: () => BigInt(now) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(now) * 1_000_000n),
    sleep: (duration) => Effect.callback<void>((resume) => {
      sleepCalls += 1;
      const sleeper = { at: now + Duration.toMillis(duration), resume };
      sleepers.add(sleeper);
      return Effect.sync(() => { sleepers.delete(sleeper); });
    }),
  };
  const flush = async (): Promise<void> => {
    await Promise.resolve();
    await Promise.resolve();
  };
  return {
    clock,
    get sleepCalls() { return sleepCalls; },
    get pendingSleeps() { return sleepers.size; },
    async advance(ms: number): Promise<void> {
      await flush();
      now += ms;
      for (const sleeper of sleepers) {
        if (sleeper.at > now) continue;
        sleepers.delete(sleeper);
        sleeper.resume(Effect.void);
      }
      await flush();
    },
  };
}
