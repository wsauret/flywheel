import type { OwnedCommandRunner } from "./owned-command.js"

/** A `--version` call takes about 150 ms. */
const VERSION_BOUND_MS = 10_000

/** What `<engine> --version` names, run through the caller's owned-command runner. Both bundled engines, `claude`
 *  and `agy`, print the version first and exit: the call reads no login, writes no file, and sends nothing. Rejects
 *  with the reason that it named none. */
export async function readEngineVersion(engine: string, run: OwnedCommandRunner): Promise<string> {
  const result = await run([engine, "--version"], { timeoutMs: VERSION_BOUND_MS })
  if (result.timedOut) throw new Error(`it did not answer --version within ${VERSION_BOUND_MS / 1000} s`)
  if (result.exitCode !== 0) throw new Error(`its --version call exited with code ${String(result.exitCode)}`)
  const version = /^(\d+\.\d+\.\d+)\b/u.exec(result.stdout.trim())?.[1]
  if (version === undefined) throw new Error("its --version output names no version")
  return version
}
