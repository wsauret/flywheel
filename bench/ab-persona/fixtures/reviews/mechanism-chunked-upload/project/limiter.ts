/** Run tasks with at most `limit` of them in flight at once. Rejects with the
 *  first failure. */
export async function runLimited(tasks: readonly (() => Promise<void>)[], limit: number): Promise<void> {
  const running = new Set<Promise<void>>();
  for (const task of tasks) {
    const run: Promise<void> = task().finally(() => running.delete(run));
    running.add(run);
    if (running.size >= limit) await Promise.race(running);
  }
}
