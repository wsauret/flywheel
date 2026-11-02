import type { TurnParkedContext } from "../../infra/agent-loop-events.js";
import type { RuntimeConfigOwner } from "../config/runtime-config-owner.js";

/** Reads live policy and cancels a pending deadline when either setting changes. */
export function createIdleCompactionPolicy(config: Pick<RuntimeConfigOwner, "snapshot" | "subscribe">) {
  return {
    enabled: () => config.snapshot().config.idle_compaction,
    subscribe: (cancel: () => void): (() => Promise<void>) => {
      const idle = config.subscribe("idleCompaction", cancel);
      const automatic = config.subscribe("proactiveCompactionThreshold", cancel);
      return async () => { await idle(); await automatic(); };
    },
  };
}

/** Owns one voluntary checkpoint deadline. New work or policy changes cancel it. */
export function createIdleCompaction(input: {
  enabled(): boolean;
  request(): void;
  now?: () => number;
  schedule?: (run: () => void, delayMs: number) => () => void;
}) {
  const now = input.now ?? Date.now;
  const schedule = input.schedule ?? ((run, delayMs) => {
    const timer = setTimeout(run, delayMs);
    timer.unref();
    return () => clearTimeout(timer);
  });
  let pending: (() => void) | undefined;
  const cancel = (): void => { pending?.(); pending = undefined; };
  return {
    cancel,
    park(context: TurnParkedContext): void {
      cancel();
      const cache = context.idleCache;
      if (!input.enabled() || !cache || cache.contextTokens < 200_000
        || context.park !== "idle" || context.waitRequested) return;
      const deadline = cache.observedAt + cache.ttlMs * 0.9;
      if (deadline <= now()) return;
      pending = schedule(() => {
        pending = undefined;
        if (input.enabled() && now() < cache.observedAt + cache.ttlMs) input.request();
      }, deadline - now());
    },
  };
}
