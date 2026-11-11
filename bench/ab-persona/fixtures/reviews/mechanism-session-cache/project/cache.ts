import type { Clock } from "./types.ts";

interface Entry<V> {
  value: V;
  expiresAt: number;
  generation: number;
}

/** Read-through cache with a fixed TTL. Concurrent misses for one key share a
 *  single load. invalidate() bumps the key's generation so that a load that
 *  started before the invalidation cannot repopulate the entry. */
export class ReadThroughCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly inflight = new Map<string, Promise<V>>();
  private readonly generations = new Map<string, number>();

  constructor(
    private readonly ttlMs: number,
    private readonly clock: Clock,
  ) {}

  get(key: string, load: () => Promise<V>): Promise<V> {
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > this.clock.now()) return Promise.resolve(hit.value);
    const running = this.inflight.get(key);
    if (running) return running;
    const loading = this.loadAndStore(key, load);
    this.inflight.set(key, loading);
    return loading;
  }

  invalidate(key: string): void {
    this.entries.delete(key);
    this.generations.set(key, this.generationOf(key) + 1);
  }

  private async loadAndStore(key: string, load: () => Promise<V>): Promise<V> {
    try {
      const value = await load();
      this.entries.set(key, { value, expiresAt: this.clock.now() + this.ttlMs, generation: this.generationOf(key) });
      return value;
    } finally {
      this.inflight.delete(key);
    }
  }

  private generationOf(key: string): number {
    return this.generations.get(key) ?? 0;
  }
}
