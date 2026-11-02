import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { Effect } from "effect"

import { openNodeSocket } from "./node-socket.js"

test("account socket sends attach before protocol bytes and preserves coalesced readiness bytes", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "flywheel-node-socket-"))
  const socketPath = join(directory, "runtime.sock")
  const received: Buffer[] = []
  const server = net.createServer((socket) => {
    socket.once("data", (bytes) => {
      received.push(Buffer.from(bytes))
      socket.end(Buffer.concat([
        Buffer.from('{"flywheel":"account.attach.ready"}\n'),
        Buffer.from([1, 2, 3]),
      ]))
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  t.after(() => {
    server.close()
    rmSync(directory, { recursive: true, force: true })
  })

  const first = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const stream = yield* openNodeSocket({
      socketPath,
      projectRoot: "/canonical/project",
      credential: "secret",
    })
    const reader = stream.readable.getReader()
    const read = yield* Effect.promise(() => reader.read())
    const bytes = read.value === undefined
      ? undefined
      : typeof read.value === "string"
        ? new TextEncoder().encode(read.value)
        : Uint8Array.from(read.value)
    yield* Effect.promise(() => reader.cancel())
    return bytes
  })))
  assert.equal(received[0]!.toString(), '{"flywheel":"account.attach","intent":"runtime","projectRoot":"/canonical/project","credential":"secret"}\n')
  assert.deepEqual([...first!], [1, 2, 3])
})
