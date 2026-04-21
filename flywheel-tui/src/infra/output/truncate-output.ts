/**
 * Array-level truncation for pre-processed line arrays (styled diff lines,
 * highlighted code lines). Keeps head and tail items, omitting the middle.
 * The caller is responsible for rendering the omitted-count indicator.
 *
 * Head gets `floor(maxLines / 2)` items, tail gets the remainder after
 * reserving one slot for the caller's ellipsis element.
 */
export interface ArrayTruncationResult<T> {
  lines: T[];
  truncated: boolean;
  omitted: number;
}

export function truncateArrayMiddle<T>(items: T[], maxLines: number): ArrayTruncationResult<T> {
  if (items.length <= maxLines) return { lines: items, truncated: false, omitted: 0 };

  const headCount = Math.floor(maxLines / 2);
  const tailCount = maxLines - headCount - 1;
  const omitted = items.length - headCount - tailCount;

  const head = items.slice(0, headCount);
  const tail = tailCount > 0 ? items.slice(-tailCount) : [];

  return { lines: [...head, ...tail], truncated: true, omitted };
}
