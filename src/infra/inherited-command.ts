import { MAX_OUTPUT_BYTES, readBounded } from "./bounded-stream.js"
import { namedExitStatus } from "./exit-status.js"

interface ProcessEnvironment {
  readonly [key: string]: string | undefined
}

export interface InheritedCommandOptions {
  readonly cwd?: string
  readonly env?: ProcessEnvironment
  readonly output: "inherit" | "capture"
  readonly stdin?: "inherit" | "ignore"
  readonly maxOutputBytes?: number
}

export interface InheritedCommandResult {
  readonly exitCode: number
  readonly signalCode: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly stdoutTruncated: boolean
  readonly stderrTruncated: boolean
}

type InheritedSpawnOptions = {
  readonly cwd?: string
  readonly env?: ProcessEnvironment
  readonly stdin: "inherit" | "ignore"
  readonly stdout: "inherit" | "pipe"
  readonly stderr: "inherit" | "pipe"
  readonly detached: false
  readonly windowsHide: true
}

type InheritedSpawn = (
  command: string[],
  options: InheritedSpawnOptions,
) => {
  readonly stdout: ReadableStream<Uint8Array> | undefined
  readonly stderr: ReadableStream<Uint8Array> | undefined
  readonly exited: Promise<number>
  readonly signalCode: NodeJS.Signals | number | null
}

/** Runs a child of an already-owned payload, in its existing process group or
 * job. It creates no supervisor, admission channel, or survival path. Output
 * is inherited or bounded and fully drained; the result awaits child exit.
 * Launch and stream failures reject. Omitted cwd and env inherit this process. */
export async function runInheritedCommand(
  command: readonly string[],
  options: InheritedCommandOptions,
  spawn: InheritedSpawn = (argv, spawnOptions) => Bun.spawn(argv, { ...spawnOptions, stderr: spawnOptions.stderr, windowsHide: true }),
): Promise<InheritedCommandResult> {
  const child = spawn([...command], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    stdin: options.stdin ?? "inherit",
    stdout: options.output === "capture" ? "pipe" : "inherit",
    stderr: options.output === "capture" ? "pipe" : "inherit",
    detached: false,
    windowsHide: true,
  })
  const bound = options.maxOutputBytes ?? MAX_OUTPUT_BYTES
  const [stdout, stderr, exitCode] = await Promise.all([
    readBounded(child.stdout, bound, "head"),
    readBounded(child.stderr, bound, "head"),
    child.exited,
  ])
  return {
    exitCode,
    signalCode: namedExitStatus(exitCode, child.signalCode).signal,
    stdout: new TextDecoder().decode(stdout.bytes),
    stderr: new TextDecoder().decode(stderr.bytes),
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
  }
}
