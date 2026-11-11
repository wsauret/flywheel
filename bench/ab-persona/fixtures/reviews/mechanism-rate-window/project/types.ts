/** Where request timestamps survive a restart. */
export interface WindowStore {
  /** The saved timestamps for `key`, oldest first, or [] when none are saved. */
  load(key: string): Promise<number[]>;
  save(key: string, stamps: readonly number[]): Promise<void>;
}

export interface KeyValue {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string, ttlMs: number): Promise<void>;
}
