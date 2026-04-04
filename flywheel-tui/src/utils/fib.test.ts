import { describe, expect, it } from "bun:test";
import { fib } from "./fib";

describe("fib", () => {
  it("fib(0) === 0", () => {
    expect(fib(0)).toBe(0);
  });

  it("fib(1) === 1", () => {
    expect(fib(1)).toBe(1);
  });

  it("fib(2) === 1", () => {
    expect(fib(2)).toBe(1);
  });

  it("fib(10) === 55", () => {
    expect(fib(10)).toBe(55);
  });

  it("fib(20) === 6765", () => {
    expect(fib(20)).toBe(6765);
  });

  it("throws RangeError for negative input", () => {
    expect(() => fib(-1)).toThrow(RangeError);
  });

  it("throws RangeError for non-integer input", () => {
    expect(() => fib(1.5)).toThrow(RangeError);
  });
});
