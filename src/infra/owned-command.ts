import { Redacted } from "effect"
import { MAX_OUTPUT_BYTES, readBounded } from "./bounded-stream.js"

import type { OwnedLaunchOptions } from "./owned-subprocess-backend.js"
import type { OwnedProcess } from "./owned-subprocess.js"
import type { LauncherScope } from "./process-supervisor.js"

/** One short command, launched into a container the guardian owns, read to the
 *  end and awaited.
 *
 *  This is the shape every auxiliary launch in Flywheel has: a credential
 *  helper, a git probe, a font-cache refresh, a clipboard tool. Each one wants
 *  bounded output and a bounded wall clock, and none of them may outlive the
 *  process that asked for them. */

/** A credential is one short line. The smaller bound keeps a helper that prints
 *  a whole keyring from ever being held in memory, and output past it is
 *  refused rather than cut: half a credential is still a credential. */
export const MAX_SECRET_BYTES = 64 * 1_024

const DEFAULT_TIMEOUT_MS = 10_000

export interface OwnedCommandOptions extends Omit<OwnedLaunchOptions, "stdin"> {
  /** How long the container is held before this side ends it. */
  readonly timeoutMs?: number
  /** Maximum retained bytes per output pipe, a nonnegative integer. Defaults to
   *  MAX_OUTPUT_BYTES (1 MB). Excess bytes are discarded, but both pipes are
   *  drained and ownership settlement is awaited. Only runOwnedCommand uses
   *  this limit; credential capture always uses MAX_SECRET_BYTES. */
  readonly maxOutputBytes?: number
  /** Which side of each output pipe is retained. Defaults to `head`, preserving
   *  the first bytes. `tail` retains the newest bytes for commands whose final
   *  output carries the result. */
  readonly outputRetention?: "head" | "tail"
  /** Written to the container's standard input before it is closed. A command
   *  that reads its input, such as a clipboard writer, gets it this way instead
   *  of through a shell redirect. */
  readonly stdin?: string
  /** Ends the container when the caller's own work is cancelled. An aborted
   *  signal refuses the launch; an abort after it ends the container, and the
   *  call still reports the command once it has settled. Cancellation is not a
   *  timeout: `timedOut` stays false. */
  readonly signal?: AbortSignal
}

export interface OwnedCommandResult {
  readonly exitCode: number | null
  /** Standard output as raw bytes, bounded according to `outputRetention`.
   *  These bytes are exact and can start or end inside a multibyte character;
   *  `stdout` is their valid UTF-8 text view. */
  readonly stdoutBytes: Uint8Array
  /** UTF-8 text views omit an incomplete final character when capture is cut. */
  readonly stdout: string
  readonly stderr: string
  /** Present only when this pipe delivered bytes beyond its retention limit. */
  readonly stdoutTruncated?: true
  readonly stderrTruncated?: true
  /** True when the lease expired and the container was ended by this side. */
  readonly timedOut: boolean
}

/** One owned command, bound to a scope. Injected wherever a caller needs
 *  command output but must not hold a launch capability of its own; a fake of
 *  this shape is also what lets those callers be unit tested. */
export type OwnedCommandRunner = (
  command: readonly string[],
  options?: OwnedCommandOptions,
) => Promise<OwnedCommandResult>

export function ownedCommandRunner(scope: Pick<LauncherScope, "spawnOwned">): OwnedCommandRunner {
  return (command, options) => runOwnedCommand(scope, command, options)
}

export async function runOwnedCommand(
  scope: Pick<LauncherScope, "spawnOwned">,
  command: readonly string[],
  options: OwnedCommandOptions = {},
): Promise<OwnedCommandResult> {
  const lease = await startOwned(scope, command, options)
  const { owned } = lease

  try {
    const maxBytes = options.maxOutputBytes ?? MAX_OUTPUT_BYTES
    const retention = options.outputRetention ?? "head"
    const [stdout, stderr] = await Promise.all([
      readBounded(owned.stdout, maxBytes, retention),
      readBounded(owned.stderr, maxBytes, retention),
    ])
    // Settles only after the container is empty and the guardian answered its
    // release, so a caller acting on this result can never race the kill list.
    const exit = await owned.exited
    return {
      exitCode: exit.code,
      stdoutBytes: stdout.bytes,
      stdout: decodeOutput(stdout.bytes, stdout.truncated, retention),
      stderr: decodeOutput(stderr.bytes, stderr.truncated, retention),
      ...(stdout.truncated ? { stdoutTruncated: true as const } : {}),
      ...(stderr.truncated ? { stderrTruncated: true as const } : {}),
      timedOut: lease.timedOut(),
    }
  } finally {
    lease.release()
  }
}

/** Why one credential capture delivered nothing. Exit metadata only: a helper
 *  that fails prints its own diagnosis, and that text is exactly where a
 *  half-delivered secret would appear. */
interface OwnedSecretFailure {
  readonly exitCode: number | null
  readonly timedOut: boolean
}

export type OwnedSecretResult =
  | { readonly tag: "captured"; readonly value: Redacted.Redacted<string> }
  | { readonly tag: "failed"; readonly failure: OwnedSecretFailure }

/** Runs one credential helper and captures its standard output as a secret.
 *
 *  This is the credential-only twin of `runOwnedCommand`, and it exists because
 *  the generic shape cannot be used safely here: that one decodes both streams
 *  into plain strings, which puts the key in ordinary result fields, in every
 *  copy the caller makes of them, and in any error or log that quotes them.
 *  Here the key lives in exactly one allocation, which is cleared before this
 *  function returns, and `Redacted` is built at the single decode expression.
 *  Standard error is drained and discarded rather than captured. A helper that
 *  fails yields exit metadata and nothing else, so a partially written key is
 *  never readable. */
export async function captureOwnedSecret(
  scope: Pick<LauncherScope, "spawnOwned">,
  command: readonly string[],
  options: OwnedCommandOptions = {},
): Promise<OwnedSecretResult> {
  const lease = await startOwned(scope, command, options)
  const { owned } = lease

  const buffer = new Uint8Array(MAX_SECRET_BYTES)
  try {
    const [capture] = await Promise.all([
      readSecretInto(owned.stdout, buffer),
      discard(owned.stderr),
    ])
    const exit = await owned.exited
    const failure: OwnedSecretFailure = { exitCode: exit.code, timedOut: lease.timedOut() }
    const value = trimAscii(buffer.subarray(0, capture.size))
    // A stream that passed the bound delivered no key: what the buffer holds is
    // the first part of one, and a cut credential is refused rather than
    // returned as if the helper had printed it.
    if (capture.overflowed || failure.timedOut || failure.exitCode !== 0 || value.length === 0) return { tag: "failed", failure }
    return { tag: "captured", value: Redacted.make(new TextDecoder().decode(value)) }
  } finally {
    buffer.fill(0)
    lease.release()
  }
}

interface OwnedLease {
  readonly owned: OwnedProcess
  timedOut(): boolean
  release(): void
}

/** Starts the container, delivers any standard input, and holds the lease that
 *  ends it. Shared by both readers so the launch contract has one shape. */
async function startOwned(
  scope: Pick<LauncherScope, "spawnOwned">,
  command: readonly string[],
  options: OwnedCommandOptions,
): Promise<OwnedLease> {
  options.signal?.throwIfAborted()
  const owned = await scope.spawnOwned(command, launchOptions(options))

  // Closed rather than left open, so a command that reads stdin sees
  // end-of-file instead of waiting for input nobody will send.
  if (options.stdin !== undefined) owned.stdin?.write(options.stdin)
  owned.stdin?.end()

  let expired = false
  let ended = false
  const end = (): void => {
    if (ended) return
    ended = true
    void owned.terminate()
  }
  const handle = setTimeout(() => {
    expired = true
    end()
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  // Attached before the aborted state is read, so a signal that fires while the
  // container was starting is never missed.
  options.signal?.addEventListener("abort", end)
  if (options.signal?.aborted) end()
  return {
    owned,
    timedOut: () => expired,
    release: () => {
      clearTimeout(handle)
      options.signal?.removeEventListener("abort", end)
    },
  }
}

function launchOptions(options: OwnedCommandOptions): OwnedLaunchOptions {
  return {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
    ...(options.onPayloadExit === undefined ? {} : { onPayloadExit: options.onPayloadExit }),
  }
}

/** Leading and trailing ASCII whitespace removed while the output is still
 *  bytes, so trimming never produces a second plaintext copy of the key. */
function trimAscii(bytes: Uint8Array): Uint8Array {
  const isSpace = (byte: number): boolean => byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d || byte === 0x0b || byte === 0x0c
  let start = 0
  let end = bytes.length
  while (start < end && isSpace(bytes[start] ?? 0)) start += 1
  while (end > start && isSpace(bytes[end - 1] ?? 0)) end -= 1
  return bytes.subarray(start, end)
}

function decodeOutput(bytes: Uint8Array, truncated: boolean, retention: "head" | "tail"): string {
  const start = truncated && retention === "tail" ? validUtf8TailStart(bytes) : 0
  return new TextDecoder().decode(bytes.subarray(start), { stream: truncated })
}

function validUtf8TailStart(bytes: Uint8Array): number {
  let start = 0
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1
  const first = bytes[start]
  if (first === undefined || first < 0x80) return start
  const width = first < 0xe0 ? 2 : first < 0xf0 ? 3 : first < 0xf8 ? 4 : 1
  if (width === 1 || start + width > bytes.length) return afterLeadingSequence(bytes, start)
  for (let offset = 1; offset < width; offset += 1) {
    if (((bytes[start + offset] ?? 0) & 0xc0) !== 0x80) return afterLeadingSequence(bytes, start)
  }
  return start
}

function afterLeadingSequence(bytes: Uint8Array, start: number): number {
  let offset = start + 1
  while (offset < bytes.length && ((bytes[offset] ?? 0) & 0xc0) === 0x80) offset += 1
  return offset
}

/** How much of a credential stream one buffer holds, and whether the stream
 *  held more than the buffer could take. */
interface SecretCapture {
  readonly size: number
  readonly overflowed: boolean
}

/** Reads a credential stream into one caller-owned allocation and reports what
 *  it holds.
 *
 *  Unlike `readBounded` this never accumulates the chunks: only what still fits
 *  is copied, and every chunk is cleared as soon as it is read. So the number
 *  of plaintext copies of the key is one, and that one is the caller's, which
 *  the caller clears. */
async function readSecretInto(stream: ReadableStream<Uint8Array> | undefined, buffer: Uint8Array): Promise<SecretCapture> {
  if (!stream) return { size: 0, overflowed: false }
  let size = 0
  let overflowed = false
  for await (const chunk of stream) {
    const capacity = buffer.length - size
    const take = Math.min(capacity, chunk.length)
    if (take > 0) {
      buffer.set(chunk.subarray(0, take), size)
      size += take
    }
    if (take < chunk.length) overflowed = true
    chunk.fill(0)
  }
  return { size, overflowed }
}

/** Drained and dropped. The stream is still read to the end, because a producer
 *  blocked on a full pipe would never exit and its container would never
 *  settle. */
async function discard(stream: ReadableStream<Uint8Array> | undefined): Promise<void> {
  if (!stream) return
  for await (const chunk of stream) chunk.fill(0)
}
