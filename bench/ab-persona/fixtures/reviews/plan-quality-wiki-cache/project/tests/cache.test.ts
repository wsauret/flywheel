import { expect, test } from "bun:test";
import { TtlCache } from "../src/cache";

test("an entry expires after the ttl", () => {
  let now = 0;
  const cache = new TtlCache(1000, () => now);
  cache.set("a", "1");
  now = 999;
  expect(cache.get("a")).toBe("1");
  now = 1000;
  expect(cache.get("a")).toBeUndefined();
});

test("invalidate removes an entry", () => {
  const cache = new TtlCache(1000);
  cache.set("page:a:html", "x");
  cache.invalidate("page:a:html");
  expect(cache.get("page:a:html")).toBeUndefined();
});
