import { NativeSession } from "@opentui/core"
import { Writable } from "node:stream"

/** Captures native terminal bytes. The renderer takes ownership of the supplied session. */
export function captureNativeOutput(width: number, height: number) {
  const chunks: Buffer[] = []
  const sink = Object.assign(new Writable({
    write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done() },
  }), { columns: width, rows: height })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- boundary: OpenTUI's renderer config types its supported custom Writable sink as NodeJS.WriteStream, and a real tty.WriteStream needs a terminal file descriptor that a unit test has not
  const stdout = sink as NodeJS.WriteStream
  return { chunks, stdout, nativeSession: new NativeSession(sink) }
}
