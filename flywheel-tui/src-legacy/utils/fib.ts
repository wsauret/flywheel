/**
 * Returns the nth Fibonacci number (0-indexed).
 * fib(0) = 0, fib(1) = 1, fib(2) = 1, ...
 *
 * Iterative approach: O(n) time, O(1) space.
 *
 * @throws {RangeError} if n is negative, non-integer, or > 78 (beyond safe integer range)
 */
export function fib(n: number): number {
  if (!Number.isInteger(n)) {
    throw new RangeError(`fib() requires an integer, got ${n}`);
  }
  if (n < 0) {
    throw new RangeError(`fib() requires a non-negative integer, got ${n}`);
  }
  if (n > 78) {
    throw new RangeError(
      `fib(${n}) exceeds safe integer range; use BigInt variant for n > 78`
    );
  }

  if (n === 0) return 0;
  if (n === 1) return 1;

  let prev = 0;
  let curr = 1;
  for (let i = 2; i <= n; i++) {
    const next = prev + curr;
    prev = curr;
    curr = next;
  }
  return curr;
}
