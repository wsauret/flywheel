import { describe, expect, test } from "bun:test";
import { fibonacci } from "../src/fibonacci";

describe("fibonacci", () => {
  test("fibonacci(0) returns 0", () => {
    expect(fibonacci(0)).toBe(0);
  });

  test("fibonacci(1) returns 1", () => {
    expect(fibonacci(1)).toBe(1);
  });

  test("fibonacci(2) returns 1", () => {
    expect(fibonacci(2)).toBe(1);
  });

  test("fibonacci(10) returns 55", () => {
    expect(fibonacci(10)).toBe(55);
  });

  test("throws on negative input", () => {
    expect(() => fibonacci(-1)).toThrow("Input must be a non-negative integer");
  });

  test("throws on non-integer input", () => {
    expect(() => fibonacci(3.5)).toThrow("Input must be an integer");
  });
});
