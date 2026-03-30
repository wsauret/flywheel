const memo = new Map<number, number>();

export function fibonacci(n: number): number {
  if (n < 0) throw new RangeError("fibonacci requires a non-negative integer");
  if (n <= 1) return n;

  const cached = memo.get(n);
  if (cached !== undefined) return cached;

  const result = fibonacci(n - 1) + fibonacci(n - 2);
  memo.set(n, result);
  return result;
}
