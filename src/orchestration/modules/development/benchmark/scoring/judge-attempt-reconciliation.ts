/** Counts judge attempts that have no matching successful score.
 *
 * Successful scores that require no judge call do not reduce the count. Repeated
 * attempts for one score identity consume at most one successful score each.
 */
export function failedJudgeCallCount(
  attemptKeys: readonly string[],
  successfulScoreKeys: readonly string[],
): number {
  const attemptsByScore = new Map<string, number>();
  for (const key of attemptKeys) attemptsByScore.set(key, (attemptsByScore.get(key) ?? 0) + 1);
  for (const key of successfulScoreKeys) {
    const attempts = attemptsByScore.get(key) ?? 0;
    if (attempts > 0) attemptsByScore.set(key, attempts - 1);
  }
  return [...attemptsByScore.values()].reduce((total, attempts) => total + attempts, 0);
}
