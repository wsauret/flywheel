import { describe, expect, it } from "bun:test";
import { memoizeSuccess } from "../../../src/infra/success-memo.js";

describe("memoizeSuccess", () => {
  it("shares one load with every caller that asks while it runs", async () => {
    const cache = new Map<string, number | Promise<number>>();
    const load = Promise.withResolvers<number>();
    let loads = 0;
    const start = (): Promise<number> => {
      loads += 1;
      return load.promise;
    };

    const first = memoizeSuccess(cache, "key", start);
    const second = memoizeSuccess(cache, "key", start);

    expect(second).toBe(first);
    expect(loads).toBe(1);
    load.resolve(7);
    expect(await first).toBe(7);
    expect(await second).toBe(7);
  });

  it("replaces the promise with its value after a success", async () => {
    const cache = new Map<string, number | Promise<number>>();
    let loads = 0;

    await memoizeSuccess(cache, "key", () => {
      loads += 1;
      return Promise.resolve(7);
    });

    expect(cache.get("key")).toBe(7);
    expect(memoizeSuccess(cache, "key", () => Promise.resolve(8))).toBe(7);
    expect(loads).toBe(1);
  });

  it("removes the entry after a rejection, so the next caller loads again", async () => {
    const cache = new Map<string, number | Promise<number>>();

    const failed = memoizeSuccess(cache, "key", () => Promise.reject(new Error("read failed")));
    await expect(failed).rejects.toThrow("read failed");

    expect(cache.has("key")).toBe(false);
    expect(await memoizeSuccess(cache, "key", () => Promise.resolve(8))).toBe(8);
    expect(cache.get("key")).toBe(8);
  });

  it("never overwrites an entry that a newer load replaced", async () => {
    const cache = new Map<string, number | Promise<number>>();
    const older = Promise.withResolvers<number>();
    const pending = memoizeSuccess(cache, "key", () => older.promise);

    cache.delete("key");
    const newer = memoizeSuccess(cache, "key", () => Promise.resolve(9));
    expect(await newer).toBe(9);
    older.resolve(7);
    expect(await pending).toBe(7);

    expect(cache.get("key")).toBe(9);
  });

  it("never deletes an entry that a newer load replaced when the older load rejects", async () => {
    const cache = new Map<string, number | Promise<number>>();
    const older = Promise.withResolvers<number>();
    const pending = memoizeSuccess(cache, "key", () => older.promise);

    cache.set("key", 9);
    older.reject(new Error("read failed"));
    await Promise.allSettled([pending]);

    expect(cache.get("key")).toBe(9);
  });
});
