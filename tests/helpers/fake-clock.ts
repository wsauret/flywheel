import { spyOn } from "bun:test";

/** One timer of the virtual clock: when it is due, and its callback. */
interface VirtualTimer {
  readonly at: number;
  readonly run: () => void;
}

/**
 * Runs `work` on a virtual clock. Whenever `work` waits, the clock moves to its next timer, so a flow that sleeps for
 * seconds between requests, such as a device-code poll, runs at once and `Date.now()` still reads the time that the
 * flow waited. Returns what `work` returns, or rejects with its error. `work` must wait only on timers and on promises
 * that settle without one, such as a faked `fetch`.
 *
 * Only a timer that a call of the global `setTimeout` makes during `work` joins the virtual clock. A timer that other
 * code schedules through a reference that it took earlier, such as the process-wide event-loop sampler, keeps real
 * time and never runs on this clock. Bun's fake timers adopt such timers too: a wait of seconds then steps through
 * each 50 ms sampler tick, and work that an earlier test file left running can stall the loop on the frozen clock.
 */
export async function onFakeClock<T>(work: () => Promise<T>): Promise<T> {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const pending = new Map<unknown, VirtualTimer>();
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const timers = spyOn(globalThis, "setTimeout").mockImplementation(new Proxy(realSetTimeout, {
    apply(_target, _receiver, [handler, delay, ...args]: Parameters<typeof setTimeout>) {
      // A real handle, already cleared, names the virtual timer, so `clearTimeout` can find it.
      const handle = realSetTimeout(() => {}, 0);
      realClearTimeout(handle);
      pending.set(handle, { at: now + (delay ?? 0), run: () => { if (typeof handler === "function") handler(...args); } });
      return handle;
    },
  }));
  const clears = spyOn(globalThis, "clearTimeout").mockImplementation(new Proxy(realClearTimeout, {
    apply(_target, _receiver, [handle]: Parameters<typeof clearTimeout>) {
      if (!pending.delete(handle)) realClearTimeout(handle);
    },
  }));
  try {
    let settled = false;
    const running = work();
    running.then(() => { settled = true; }, () => { settled = true; });
    while (!settled) {
      // Each turn lets every pending callback of `work` run before the clock moves.
      await new Promise<void>((resolve) => setImmediate(resolve));
      const next = settled ? undefined : nextTimer(pending);
      if (!next) continue;
      pending.delete(next.handle);
      now = Math.max(now, next.timer.at);
      next.timer.run();
    }
    return await running;
  } finally {
    clears.mockRestore();
    timers.mockRestore();
    clock.mockRestore();
  }
}

/** The earliest due timer; of timers due at once, the one set first. */
function nextTimer(pending: ReadonlyMap<unknown, VirtualTimer>): { readonly handle: unknown; readonly timer: VirtualTimer } | undefined {
  let next: { readonly handle: unknown; readonly timer: VirtualTimer } | undefined;
  for (const [handle, timer] of pending) if (!next || timer.at < next.timer.at) next = { handle, timer };
  return next;
}
