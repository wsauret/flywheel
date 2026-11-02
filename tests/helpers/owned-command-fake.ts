import type { OwnedCommandOptions, OwnedCommandResult, OwnedCommandRunner } from "../../src/infra/owned-command.js"

export interface RecordedCommand {
  readonly command: readonly string[]
  readonly options: OwnedCommandOptions | undefined
}

/** One container's outcome. `stdout` may be bytes, because a caller reading
 *  binary output (a clipboard image) reads those rather than the text view. */
export function ownedCommandResult(stdout: string | Uint8Array = "", exitCode = 0): OwnedCommandResult {
  const stdoutBytes = typeof stdout === "string" ? new TextEncoder().encode(stdout) : stdout
  return { exitCode, stdoutBytes, stdout: new TextDecoder().decode(stdoutBytes), stderr: "", timedOut: false }
}

/** A runner for a caller that holds no launch capability of its own. It records
 *  every command, so a test can prove what was asked for and where, and answers
 *  with `answer` or with a clean empty exit. */
export function fakeOwnedCommandRunner(
  answer: (command: readonly string[], options: OwnedCommandOptions | undefined) => Promise<OwnedCommandResult> =
    () => Promise.resolve(ownedCommandResult()),
): { run: OwnedCommandRunner; calls: RecordedCommand[] } {
  const calls: RecordedCommand[] = []
  const run: OwnedCommandRunner = (command, options) => {
    calls.push({ command, options })
    return answer(command, options)
  }
  return { run, calls }
}
