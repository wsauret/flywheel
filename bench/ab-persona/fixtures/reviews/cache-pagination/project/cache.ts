import type { CacheClock } from "./types.ts";

interface Entry<T> {
  value: T;
  storedAt: number;
}

export type Lookup<T> =
  | { kind: "hit"; value: T }
  | { kind: "stale"; value: T }
  | { kind: "miss" };

const TTL_SECONDS = 30;
const STALE_GRACE_SECONDS = 120;
const NEGATIVE_TTL_SECONDS = 5;

/** Two-tier read cache. Fresh entries live in the primary map; when an entry
 *  ages past its TTL it moves to the stale tier, where it can still be served
 *  while a revalidation is in flight. The stale tier bounds primary-map churn
 *  under thundering-herd revalidation. */
export class SwrCache<T> {
  private readonly fresh = new Map<string, Entry<T>>();
  private readonly stale = new Map<string, Entry<T>>();
  private readonly empty = new Map<string, Entry<null>>();

  constructor(private readonly clock: CacheClock) {}

  get(key: string): Lookup<T> {
    const now = this.clock.now();
    const entry = this.fresh.get(key);
    if (entry) {
      if (now - entry.storedAt < TTL_SECONDS * 1000) {
        return { kind: "hit", value: entry.value };
      }
      this.fresh.delete(key);
      this.stale.set(key, entry);
    }
    const staleEntry = this.stale.get(key);
    if (staleEntry) {
      if (now - staleEntry.storedAt < (TTL_SECONDS + STALE_GRACE_SECONDS) * 1000) {
        return { kind: "stale", value: staleEntry.value };
      }
      this.stale.delete(key);
    }
    return { kind: "miss" };
  }

  set(key: string, value: T): void {
    this.stale.delete(key);
    this.fresh.set(key, { value, storedAt: this.clock.now() });
  }

  /** Cache "no results" separately so repeated misses do not hammer the
   *  source. Negative entries use a short TTL because absence changes fast. */
  markEmpty(key: string): void {
    this.empty.set(key, { value: null, storedAt: this.clock.now() });
  }

  isKnownEmpty(key: string): boolean {
    const entry = this.empty.get(key);
    if (!entry) return false;
    const ageSeconds = (this.clock.now() - entry.storedAt) / 1000;
    if (ageSeconds < NEGATIVE_TTL_SECONDS * 1000) {
      return true;
    }
    this.empty.delete(key);
    return false;
  }

  /** Remove every entry whose key starts with `prefix`. Called when a
   *  viewer's permissions change so revoked documents stop being served. */
  invalidatePrefix(prefix: string): void {
    for (const key of this.fresh.keys()) {
      if (key.startsWith(prefix)) {
        this.fresh.delete(key);
      }
    }
    for (const key of this.empty.keys()) {
      if (key.startsWith(prefix)) {
        this.empty.delete(key);
      }
    }
  }
}
