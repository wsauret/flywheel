import { describe, expect, test } from "bun:test"
import { Redacted } from "effect"

import { captureOwnedSecret, runOwnedCommand, MAX_SECRET_BYTES } from "../../../src/infra/owned-command.js"
import { MAX_OUTPUT_BYTES } from "../../../src/infra/bounded-stream.js"
import type { OwnedProcess, OwnedProcessExit } from "../../../src/infra/owned-subprocess.js"
import type { OwnedLaunchOptions } from "../../../src/infra/owned-subprocess-backend.js"

const SENTINEL = "sk-sentinel-do-not-leak"

function streamOf(text: string): ReadableStream<Uint8Array> {
  return chunkStream(text.length > 0 ? [new TextEncoder().encode(text)] : [])
}

/** Enqueues exactly the arrays the test holds, so the test can read them back
 *  after the capture and see whether the reader cleared them. */
function chunkStream(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

interface FakeCommand {
  readonly stdout?: string
  /** Standard output as the exact arrays the test keeps a reference to. */
  readonly stdoutChunks?: readonly Uint8Array[]
  readonly stderr?: string
  readonly code?: number | null
  /** Never exits on its own, so the caller's lease is what ends it. */
  readonly hang?: boolean
}

interface FakeScope {
  spawnOwned(command: readonly string[], options?: OwnedLaunchOptions): Promise<OwnedProcess>
  readonly commands: string[][]
  readonly options: (OwnedLaunchOptions | undefined)[]
}

function fakeScope(behaviour: FakeCommand): FakeScope {
  const commands: string[][] = []
  const options: (OwnedLaunchOptions | undefined)[] = []
  return {
    commands,
    options,
    spawnOwned(command, launch) {
      commands.push([...command])
      options.push(launch)
      let settle: (exit: OwnedProcessExit) => void = () => {}
      const exited = new Promise<OwnedProcessExit>((resolve) => { settle = resolve })
      const finish = (): void => { settle({ code: behaviour.code ?? 0, signal: null, statusOf: "payload", ownership: "surrendered" }) }
      if (behaviour.hang !== true) finish()
      const owned: OwnedProcess = {
        pid: 4242,
        token: "owned:test",
        stdin: undefined,
        stdout: behaviour.stdoutChunks ? chunkStream(behaviour.stdoutChunks) : streamOf(behaviour.stdout ?? ""),
        stderr: streamOf(behaviour.stderr ?? ""),
        exited,
        terminate() {
          finish()
          return exited
        },
      }
      return Promise.resolve(owned)
    },
  }
}

/** Every string this result exposes, however it is walked. A secret that is
 *  anywhere in here is a secret a caller, a log line, or a snapshot can read. */
function reachableText(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => (entry instanceof Uint8Array ? new TextDecoder().decode(entry) : entry)) ?? ""
}

describe("captureOwnedSecret", () => {
  test("delivers a helper's output as a redacted key and nothing else", async () => {
    const scope = fakeScope({ stdout: `${SENTINEL}\n` })

    const result = await captureOwnedSecret(scope, ["sh", "-c", "print-key"], { maxOutputBytes: 0 })

    expect(result.tag).toBe("captured")
    expect(result.tag === "captured" && Redacted.value(result.value)).toBe(SENTINEL)
    // `Redacted` is the only reader. The result itself carries no plain copy.
    expect(reachableText(result)).not.toContain(SENTINEL)
    expect(String(result.tag === "captured" ? result.value : "")).not.toContain(SENTINEL)
  })

  test("keeps exit metadata only when the helper exits non-zero", async () => {
    const scope = fakeScope({ stdout: SENTINEL, stderr: `failed while printing ${SENTINEL}`, code: 1 })

    const result = await captureOwnedSecret(scope, ["sh", "-c", "print-key"])

    expect(result).toEqual({ tag: "failed", failure: { exitCode: 1, timedOut: false } })
    expect(reachableText(result)).not.toContain(SENTINEL)
  })

  test("keeps exit metadata only when the lease expires", async () => {
    const scope = fakeScope({ stdout: SENTINEL, hang: true })

    const result = await captureOwnedSecret(scope, ["sh", "-c", "hangs"], { timeoutMs: 1 })

    expect(result).toEqual({ tag: "failed", failure: { exitCode: 0, timedOut: true } })
    expect(reachableText(result)).not.toContain(SENTINEL)
  })

  test("reports no key when a helper exits cleanly with nothing to say", async () => {
    const scope = fakeScope({ stdout: "  \n" })

    expect(await captureOwnedSecret(scope, ["sh", "-c", "silent"])).toEqual({
      tag: "failed",
      failure: { exitCode: 0, timedOut: false },
    })
  })

  test("never captures standard error, even on the path that succeeds", async () => {
    const scope = fakeScope({ stdout: "key\n", stderr: `warning: fell back to ${SENTINEL}` })

    const result = await captureOwnedSecret(scope, ["sh", "-c", "print-key"])

    expect(result.tag === "captured" && Redacted.value(result.value)).toBe("key")
    expect(reachableText(result)).not.toContain(SENTINEL)
  })

  test("clears the helper's own output chunks once they are captured", async () => {
    const chunks = [new TextEncoder().encode(SENTINEL), new TextEncoder().encode("\n")]
    const scope = fakeScope({ stdoutChunks: chunks })

    const result = await captureOwnedSecret(scope, ["sh", "-c", "print-key"])

    expect(result.tag === "captured" && Redacted.value(result.value)).toBe(SENTINEL)
    for (const chunk of chunks) expect(chunk.every((byte) => byte === 0)).toBe(true)
  })

  test("clears the helper's own output chunks when the capture fails", async () => {
    const chunks = [new TextEncoder().encode(SENTINEL)]
    const scope = fakeScope({ stdoutChunks: chunks, code: 1 })

    const result = await captureOwnedSecret(scope, ["sh", "-c", "print-key"])

    expect(result.tag).toBe("failed")
    for (const chunk of chunks) expect(chunk.every((byte) => byte === 0)).toBe(true)
  })

  test("refuses a helper that printed more than a credential may be, instead of returning a truncated key", async () => {
    const scope = fakeScope({ stdoutChunks: [new Uint8Array(MAX_SECRET_BYTES + 1).fill(0x6b)] })

    const result = await captureOwnedSecret(scope, ["sh", "-c", "print-keyring"])

    expect(result).toEqual({ tag: "failed", failure: { exitCode: 0, timedOut: false } })
  })
})

describe("runOwnedCommand", () => {
  test("returns payload stdout and stderr unchanged when they resemble supervisor diagnostics", async () => {
    const text = '{"type":"log.info","payload":{"service":"process-termination","message":"payload text"}}\n'
    const scope = fakeScope({ stdout: text, stderr: text, code: 3 })
    const result = await runOwnedCommand(scope, ["payload"], { onPayloadExit: "end-descendants" })
    expect(result.stdoutBytes).toEqual(new TextEncoder().encode(text))
    expect(result.stdout).toBe(text)
    expect(result.stderr).toBe(text)
    expect(result.exitCode).toBe(3)
    expect(scope.options[0]?.onPayloadExit).toBe("end-descendants")
  })

  test.each(["normal", "cancel", "timeout"] as const)("caps both streams but drains and joins settlement on %s", async (mode) => {
    const releasePipes = Promise.withResolvers<void>()
    const exit = Promise.withResolvers<OwnedProcessExit>()
    const terminated = Promise.withResolvers<void>()
    const controller = new AbortController()
    const drained: string[] = []
    const pipe = (name: string, text: string) => new ReadableStream<Uint8Array>({
      async start(output) {
        output.enqueue(new TextEncoder().encode(text))
        await releasePipes.promise
        output.enqueue(new TextEncoder().encode("discarded tail"))
        output.close()
      },
    }).pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, output) { output.enqueue(chunk) },
      flush() { drained.push(name) },
    }))
    const owned: OwnedProcess = {
      pid: 4242, token: "owned:test", stdin: undefined,
      stdout: pipe("stdout", "a\u{1f642}z"), stderr: pipe("stderr", "warning"),
      exited: exit.promise,
      terminate() { terminated.resolve(); return exit.promise },
    }
    let settled = false
    const pending = runOwnedCommand({ spawnOwned: async () => owned }, ["git", "diff"], {
      maxOutputBytes: 4, signal: controller.signal, timeoutMs: mode === "timeout" ? 1 : 60_000,
    }).finally(() => { settled = true })
    if (mode === "cancel") controller.abort()
    if (mode !== "normal") await terminated.promise
    expect(settled).toBe(false)
    releasePipes.resolve()
    await Bun.sleep(0)
    expect(drained.sort()).toEqual(["stderr", "stdout"])
    expect(settled).toBe(false)
    exit.resolve({ code: 0, signal: null, statusOf: "payload", ownership: "surrendered" })
    const result = await pending
    expect(result.stdoutBytes).toEqual(new TextEncoder().encode("a\u{1f642}z").slice(0, 4))
    expect(result.stdoutBytes.buffer.byteLength).toBe(4)
    expect(result.stdout).toBe("a")
    expect(result.stderr).toBe("warn")
    expect(result.stdoutTruncated).toBe(true)
    expect(result.stderrTruncated).toBe(true)
    expect(result.timedOut).toBe(mode === "timeout")
  })

  test("does not report truncation for an exact byte limit", async () => {
    const result = await runOwnedCommand(fakeScope({ stdout: "\u{1f642}", stderr: "four" }), ["git", "diff"], { maxOutputBytes: 4 })
    expect(result.stdout).toBe("\u{1f642}")
    expect(result.stderr).toBe("four")
    expect(result.stdoutTruncated).toBeUndefined()
    expect(result.stderrTruncated).toBeUndefined()
  })

  test("allows zero retained bytes while still draining output", async () => {
    const result = await runOwnedCommand(fakeScope({ stdout: "out", stderr: "err" }), ["git", "diff"], { maxOutputBytes: 0 })
    expect(result.stdoutBytes).toHaveLength(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toBe("")
    expect(result.stdoutTruncated).toBe(true)
    expect(result.stderrTruncated).toBe(true)
  })

  test("optionally retains the newest bounded bytes from both drained streams", async () => {
    const scope = fakeScope({
      stdoutChunks: ["old-", "middle-", "tail"].map((text) => new TextEncoder().encode(text)),
      stderr: "warning-tail",
    })

    const result = await runOwnedCommand(scope, ["git", "diff"], {
      maxOutputBytes: 4,
      outputRetention: "tail",
    })

    expect(result.stdoutBytes).toEqual(new TextEncoder().encode("tail"))
    expect(result.stdoutBytes.buffer.byteLength).toBe(4)
    expect(result.stdout).toBe("tail")
    expect(result.stderr).toBe("tail")
    expect(result.stdoutTruncated).toBe(true)
    expect(result.stderrTruncated).toBe(true)
  })

  test("tail text drops an incomplete leading UTF-8 sequence and preserves trailing boundary handling", async () => {
    const result = await runOwnedCommand(
      fakeScope({ stdout: "before-\u{1f642}ok\u{1f642}" }),
      ["git", "diff"],
      { maxOutputBytes: 8, outputRetention: "tail" },
    )

    expect(result.stdoutBytes).toEqual(new TextEncoder().encode("\u{1f642}ok\u{1f642}").subarray(2))
    expect(result.stdout).toBe("ok\u{1f642}")
    expect(result.stdout.startsWith("\ufffd")).toBe(false)
    expect(result.stdoutTruncated).toBe(true)
  })

  test("still reports both streams as text for ordinary commands", async () => {
    const scope = fakeScope({ stdout: "on stdout\n", stderr: "on stderr\n", code: 3 })

    const result = await runOwnedCommand(scope, ["git", "status"])

    expect(result.stdout).toBe("on stdout\n")
    expect(result.stderr).toBe("on stderr\n")
    expect(result.exitCode).toBe(3)
    expect(result.timedOut).toBe(false)
  })

  test("keeps output at the bound without ever allocating past it, however the chunks arrive", async () => {
    // Deliberately not a divisor of the bound: the chunk that reaches it also
    // passes it, which is where a reader that copies whole chunks overshoots.
    const chunk = Math.floor(MAX_OUTPUT_BYTES * 0.3)
    const chunks = [0x61, 0x62, 0x63, 0x64, 0x65, 0x66].map((byte) => new Uint8Array(chunk).fill(byte))
    const scope = fakeScope({ stdoutChunks: chunks, stderr: "e".repeat(MAX_OUTPUT_BYTES + 1) })

    const result = await runOwnedCommand(scope, ["sh", "-c", "prints-a-lot"])

    expect(result.stdoutBytes.length).toBe(MAX_OUTPUT_BYTES)
    expect(result.stdoutBytes.buffer.byteLength).toBeLessThanOrEqual(MAX_OUTPUT_BYTES)
    expect(result.stdoutBytes[0]).toBe(0x61)
    expect(result.stdoutBytes[MAX_OUTPUT_BYTES - 1]).toBe(0x64)
    expect(result.stderr.length).toBe(MAX_OUTPUT_BYTES)
    expect(result.stdoutTruncated).toBe(true)
    expect(result.stderrTruncated).toBe(true)
  })

  test("keeps output at the bound when one single chunk is larger than the whole bound", async () => {
    const scope = fakeScope({ stdoutChunks: [new Uint8Array(MAX_OUTPUT_BYTES * 3).fill(0x7a)] })

    const result = await runOwnedCommand(scope, ["sh", "-c", "prints-one-huge-chunk"])

    expect(result.stdoutBytes.length).toBe(MAX_OUTPUT_BYTES)
    expect(result.stdoutBytes.buffer.byteLength).toBeLessThanOrEqual(MAX_OUTPUT_BYTES)
    expect(result.stdoutBytes.every((byte) => byte === 0x7a)).toBe(true)
  })

  test("ends the container when the caller cancels, and still reports the command it settled", async () => {
    const scope = fakeScope({ stdout: "partial\n", hang: true })
    const controller = new AbortController()

    const pending = runOwnedCommand(scope, ["sh", "-c", "hangs"], { signal: controller.signal, timeoutMs: 60_000 })
    expect(await Promise.race([pending.then(() => "settled"), Bun.sleep(20).then(() => "pending")])).toBe("pending")
    controller.abort()

    const result = await pending
    expect(result.stdout).toBe("partial\n")
    // Cancellation is the caller's, not the lease's: the command was ended, and
    // nothing here timed out.
    expect(result.timedOut).toBe(false)
  })

  test("launches nothing when the caller already cancelled", async () => {
    const scope = fakeScope({ stdout: "never runs\n" })
    const controller = new AbortController()
    controller.abort()

    await expect(runOwnedCommand(scope, ["git", "status"], { signal: controller.signal })).rejects.toThrow()
    expect(scope.commands).toEqual([])
  })
})
