import { describe, expect, test } from "bun:test";
import { discountFor, tierFor } from "../src/tiers";

describe("tiers", () => {
  test("a balance earns the highest tier whose threshold it meets", () => {
    expect(tierFor(0)).toBe("bronze");
    expect(tierFor(999)).toBe("bronze");
    expect(tierFor(1000)).toBe("silver");
    expect(tierFor(5000)).toBe("gold");
  });

  test("each tier has its discount", () => {
    expect(discountFor("gold")).toBe(0.1);
    expect(discountFor("bronze")).toBe(0);
  });
});
