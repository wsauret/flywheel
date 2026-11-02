/** How a child process ended, in the shape Flywheel carries: an exit code, or
 *  the name of the signal that ended it. */
export interface NamedExitStatus {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

/** Reads a Bun child's exit status into the shape Flywheel carries. Bun reports
 *  a signal that has no name, such as a Linux real-time signal, as its number.
 *  That end becomes the code a shell reports for it, 128 and the signal number,
 *  which is also the value Bun's `exited` promise resolves to, so every signal
 *  Flywheel carries, logs, records, and re-raises has a name. */
export function namedExitStatus(exitCode: number | null, signalCode: NodeJS.Signals | number | null): NamedExitStatus {
  return typeof signalCode === "number" ? { code: 128 + signalCode, signal: null } : { code: exitCode, signal: signalCode }
}
