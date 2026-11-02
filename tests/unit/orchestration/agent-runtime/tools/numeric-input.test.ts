import { describe, expect, it } from "bun:test";

import { checkNumericRange } from "../../../../../src/orchestration/agent-runtime/tools/numeric-input.js";

describe("checkNumericRange", () => {
  it("rejects non-finite numbers", () => {
    expect("error" in checkNumericRange(Number.NaN, "limit", { min: 1 })).toBe(true);
    expect("error" in checkNumericRange(Number.POSITIVE_INFINITY, "limit", { min: 1 })).toBe(true);
  });

  it("treats exclusiveMin as strictly greater than, allowing fractions", () => {
    expect(checkNumericRange(0.1, "timeout", { exclusiveMin: 0 })).toEqual({ value: 0.1 });
    expect("error" in checkNumericRange(0, "timeout", { exclusiveMin: 0 })).toBe(true);
    const negative = checkNumericRange(-1, "timeout", { exclusiveMin: 0 });
    expect("error" in negative && negative.error).toContain("greater than 0");
  });
});
