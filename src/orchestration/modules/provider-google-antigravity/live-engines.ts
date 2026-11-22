/** The release of every live engine use of this process when the module turns off. It imports nothing else of the
 *  module, so the module's service can release without loading the engine code. A module turned off never cancels
 *  admitted work (ARCH-RUNTIME-063); only the process's shutdown drains the engine registry (`drain`). */
const uses = new Set<() => void>()

/** Adds the release of one engine use; the returned function removes it when that use ends. */
export function registerLiveEngine(release: () => void): () => void {
  uses.add(release)
  return () => { uses.delete(release) }
}

/** Tells every live engine use of this process to let its engine go: an engine closes once its last use let it go
 *  and no prompt of it is open, so an admitted request still settles. The uses stay, so a later request launches a
 *  new engine. */
export function releaseLiveEngines(): void {
  for (const release of uses) release()
}
