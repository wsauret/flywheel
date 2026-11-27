/** The release of live engine uses of this process when the module turns off, or when an auth profile turns the
 *  provider off. It imports nothing else of the module, so the module's service can release without loading the engine
 *  code. Neither cancels admitted work (ARCH-RUNTIME-063); only the process's shutdown drains the engine registry
 *  (`drain`). */
const uses = new Set<(within: (loginDir: string) => boolean) => void>()

/** Adds the release of one engine use, which lets go each of its engines whose login directory `within` accepts; the
 *  returned function removes it when that use ends. */
export function registerLiveEngine(release: (within: (loginDir: string) => boolean) => void): () => void {
  uses.add(release)
  return () => { uses.delete(release) }
}

/** Tells every live engine use of this process to let go each engine whose login directory `within` accepts, every
 *  engine when `within` is absent: an engine closes once its last use let it go and no prompt of it is open, so an
 *  admitted request still settles. The uses stay, so a later request launches a new engine. */
export function releaseLiveEngines(within: (loginDir: string) => boolean = () => true): void {
  for (const release of uses) release(within)
}
