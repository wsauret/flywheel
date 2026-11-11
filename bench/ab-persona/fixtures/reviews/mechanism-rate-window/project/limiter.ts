import type { WindowStore } from "./types.ts";

/** Sliding-window rate limiter: at most `limit` requests per key in any
 *  `windowMs` span. The load balancer routes requests by key, so one process
 *  owns each key. A key's window is loaded from the store on its first use
 *  after a restart and saved after every allowed request. */
export class SlidingWindowLimiter {
  private readonly windows = new Map<string, number[]>();
  private readonly hydrating = new Map<string, Promise<number[]>>();

  constructor(
    private readonly store: WindowStore,
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly clock: () => number,
  ) {}

  /** Take one slot for `key` if the window has room. */
  async acquire(key: string): Promise<boolean> {
    const stamps = this.windows.get(key) ?? (await this.hydrate(key));
    const now = this.clock();
    while (stamps.length > 0 && stamps[0]! <= now - this.windowMs) stamps.shift();
    if (stamps.length >= this.limit) return false;
    stamps.push(now);
    await this.store.save(key, stamps);
    return true;
  }

  private hydrate(key: string): Promise<number[]> {
    const pending = this.hydrating.get(key);
    if (pending !== undefined) return pending;
    const loading = this.store
      .load(key)
      .then((stamps) => {
        this.windows.set(key, stamps);
        return stamps;
      })
      .finally(() => this.hydrating.delete(key));
    this.hydrating.set(key, loading);
    return loading;
  }
}
