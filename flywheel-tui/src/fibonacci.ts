const memo = new Map<number, number>();

/**
 * Returns the nth Fibonacci number (0-indexed) using memoization.
 *
 * fibonacci(0) = 0, fibonacci(1) = 1, fibonacci(2) = 1, fibonacci(3) = 2, ...
 *
 * @throws {Error} If n is negative or not an integer.
 */
export function fibonacci(n: number): number {
  if (!Number.isInteger(n)) {
    throw new Error("Input must be an integer");
  }
  if (n < 0) {
    throw new Error("Input must be a non-negative integer");
  }
  if (n <= 1) return n;

  const cached = memo.get(n);
  if (cached !== undefined) return cached;

  const result = fibonacci(n - 1) + fibonacci(n - 2);
  memo.set(n, result);
  return result;
}
