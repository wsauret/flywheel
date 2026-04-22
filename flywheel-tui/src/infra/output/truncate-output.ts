interface ArrayTruncationResult<T> {
  lines: T[];
  truncated: boolean;
  omitted: number;
}

export function truncateArrayHead<T>(items: T[], maxLines: number): ArrayTruncationResult<T> {
  if (items.length <= maxLines) return { lines: items, truncated: false, omitted: 0 };

  const head = items.slice(0, maxLines);
  const omitted = items.length - maxLines;

  return { lines: head, truncated: true, omitted };
}
