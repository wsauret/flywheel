import { describe, expect, test } from "bun:test";
import { add, subtract, multiply, divide } from "./calculator";

describe("calculator", () => {
  // --- add ---
  test("add returns the sum of two positive numbers", () => {
    expect(add(2, 3)).toBe(5);
  });

  test("add handles negative numbers", () => {
    expect(add(-4, -6)).toBe(-10);
  });

  test("add with zero returns the other operand", () => {
    expect(add(7, 0)).toBe(7);
  });

  // --- subtract ---
  test("subtract returns the difference of two numbers", () => {
    expect(subtract(10, 4)).toBe(6);
  });

  test("subtract with negative numbers", () => {
    expect(subtract(-3, -8)).toBe(5);
  });

  test("subtract a number from itself returns zero", () => {
    expect(subtract(42, 42)).toBe(0);
  });

  // --- multiply ---
  test("multiply returns the product of two numbers", () => {
    expect(multiply(3, 7)).toBe(21);
  });

  test("multiply by zero returns zero", () => {
    expect(multiply(999, 0)).toBe(0);
  });

  test("multiply with a negative number returns a negative result", () => {
    expect(multiply(-5, 3)).toBe(-15);
  });

  // --- divide ---
  test("divide returns the quotient of two numbers", () => {
    expect(divide(20, 4)).toBe(5);
  });

  test("divide a positive number by zero returns Infinity", () => {
    expect(divide(1, 0)).toBe(Infinity);
  });

  test("divide zero by zero returns NaN", () => {
    expect(divide(0, 0)).toBeNaN();
  });

  // --- edge cases ---
  test("divide with negative divisor returns correct sign", () => {
    expect(divide(10, -2)).toBe(-5);
  });

  test("add with large floating-point numbers", () => {
    expect(add(0.1, 0.2)).toBeCloseTo(0.3, 10);
  });

  test("multiply two negative numbers returns a positive result", () => {
    expect(multiply(-4, -5)).toBe(20);
  });
});
