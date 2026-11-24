import type { InputReloadCheckpoint } from "./input-reload-checkpoint.js"

/** A mounted client can keep serving input while its host needs an upgrade. */
export class ClientHostUpgradeRequired extends Error {}

/** Captures owners only after preparation. Accepted changes during storage writes
 *  restart the save; admission closes synchronously with the final comparison. */
export function createInputReload(options: {
  readonly signal?: AbortSignal
  readonly prepare: () => Promise<void>
  readonly settled: () => Promise<void>
  readonly capture: () => InputReloadCheckpoint
  readonly save: (checkpoint: InputReloadCheckpoint) => Promise<void>
  readonly hold: () => () => void
  readonly commit: () => Promise<void>
  readonly report: (message: string) => void
}) {
  let replacing: Promise<void> | undefined
  const run = async () => {
    let release: (() => void) | undefined
    let committed = false
    try {
      await options.prepare()
      // oxlint-disable-next-line no-unreachable-loop -- false positive: `continue` repeats this loop, which oxlint misreads inside a try with catch and finally
      for (;;) {
        await options.settled()
        if (options.signal?.aborted) return
        const checkpoint = options.capture()
        const revision = JSON.stringify(checkpoint)
        await options.save(checkpoint)
        await options.settled()
        if (options.signal?.aborted) return
        if (revision !== JSON.stringify(options.capture())) continue
        release = options.hold()
        await options.commit()
        committed = true
        return
      }
    } catch (cause) {
      release?.()
      if (!options.signal?.aborted) options.report(cause instanceof ClientHostUpgradeRequired
        ? "This Flywheel host is older than the client the runtime serves. Update it to continue. Your unsent input is still here."
        : "Flywheel could not replace this client. Your unsent input is still here.")
    } finally {
      if (!committed) replacing = undefined
    }
  }
  return {
    replace(): Promise<void> { replacing ??= run(); return replacing },
    /** True from the replacement's start until it fails, and for good once
     *  it commits: the checkpoint it saves is then the one the next page
     *  reads, and no other write may replace it. */
    get replacing(): boolean { return replacing !== undefined },
  }
}
