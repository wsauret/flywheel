/**
 * Range rejection for LLM-supplied numeric tool inputs.
 *
 * The dispatcher's `validateToolInput` enforces declared *types* (a number is
 * a number); it deliberately leaves *range* to the tools. Several tools used
 * to silently clamp out-of-range values (`limit: 0` -> 1) or forward them
 * unbounded into native addons, turning a clearly-meant request into nonsense
 * with no signal the model could act on. This helper rejects an out-of-range
 * value at the input boundary so the model gets an actionable correction
 * instead.
 *
 * Absent or non-numeric inputs fall through (`{ value: undefined }`) so callers
 * keep applying their own defaults; only a present number outside the range is
 * an error.
 */

interface NumericBound {
  /** Smallest accepted value (inclusive). */
  min?: number;
  /** Strictly-greater-than floor; for values that must be positive but allow
   *  fractions (e.g. a sub-second timeout) where an inclusive `min` cannot. */
  exclusiveMin?: number;
  /** Largest accepted value (inclusive). */
  max?: number;
}

export type NumericInputResult = { value: number | undefined } | { error: string };

function describeRange(bound: NumericBound): string {
  const lower = bound.min !== undefined ? `at least ${bound.min}` : bound.exclusiveMin !== undefined ? `greater than ${bound.exclusiveMin}` : undefined;
  const upper = bound.max !== undefined ? `at most ${bound.max}` : undefined;
  if (lower && upper) return `${lower} and ${upper}`;
  return lower ?? upper ?? "a finite number";
}

/** Reject a present numeric input that falls outside `bound`; pass through
 *  absent or non-numeric inputs so the caller can apply its default. */
export function checkNumericRange(
  value: unknown,
  name: string,
  bound: NumericBound,
): NumericInputResult {
  if (typeof value !== "number") return { value: undefined };
  const outOfRange =
    !Number.isFinite(value)
    || (bound.min !== undefined && value < bound.min)
    || (bound.exclusiveMin !== undefined && value <= bound.exclusiveMin)
    || (bound.max !== undefined && value > bound.max);
  if (outOfRange) {
    return { error: `${name} must be ${describeRange(bound)}; received ${value}. Provide a value in range and call the tool again.` };
  }
  return { value };
}
