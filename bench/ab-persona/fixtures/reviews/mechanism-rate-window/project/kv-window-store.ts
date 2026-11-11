import type { KeyValue, WindowStore } from "./types.ts";

/** A WindowStore over the key-value service. Entries expire on their own
 *  one window after the last save, so idle keys cost nothing. */
export function kvWindowStore(kv: KeyValue, windowMs: number): WindowStore {
  return {
    async load(key) {
      const text = await kv.get(`rate:${key}`);
      return text === undefined ? [] : (JSON.parse(text) as number[]);
    },
    async save(key, stamps) {
      await kv.set(`rate:${key}`, JSON.stringify(stamps), windowMs);
    },
  };
}
