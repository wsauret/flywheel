interface Entry {
  readonly value: string;
  readonly expiresAt: number;
}

/** A string cache whose entries expire `ttlMs` after they are set. */
export class TtlCache {
  readonly #entries = new Map<string, Entry>();

  constructor(private readonly ttlMs: number, private readonly now: () => number = Date.now) {}

  get(key: string): string | undefined {
    const entry = this.#entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.#entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: string): void {
    this.#entries.set(key, { value, expiresAt: this.now() + this.ttlMs });
  }

  /** Remove the entry under `key`. */
  invalidate(key: string): void {
    this.#entries.delete(key);
  }

  get size(): number {
    return this.#entries.size;
  }
}
