/** A pid for a scripted process table that no process on a supported platform
 *  can hold, so it never equals the test process's own pid. Distinct `n` give
 *  distinct pids.
 *
 *  Product code skips `process.pid` in every membership listing, because a
 *  supervisor never counts itself in its own container. A scripted member that
 *  shared the test process's pid would silently leave the listing. Linux pids
 *  stay below 2^22 (PID_MAX_LIMIT) and macOS pids below 100000. Windows gives
 *  out multiples of 4, an implementation detail rather than a contract, so
 *  every pid here is above 2^22 and odd. */
export function fakePid(n: number): number {
  return 2 ** 22 + 2 * n + 1
}
