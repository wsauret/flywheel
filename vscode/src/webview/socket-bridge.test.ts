import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import type { HostMessage } from "../../../src/protocol/client/editor-host.js"
import { SocketBridge } from "./socket-bridge.js"

/** One account service that answers every attach with `answer` and records what it received. */
async function serve(t: { after: (fn: () => void) => void }, answer: Buffer): Promise<{ socketPath: string; received: Buffer[] }> {
  const directory = mkdtempSync(join(tmpdir(), "flywheel-socket-bridge-"))
  const socketPath = join(directory, "runtime.sock")
  const received: Buffer[] = []
  const server = net.createServer((socket) => {
    socket.once("data", (bytes) => {
      received.push(Buffer.from(bytes))
      socket.end(answer)
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  t.after(() => {
    server.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return { socketPath, received }
}

async function until(condition: () => boolean): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (!condition()) return
      clearInterval(timer)
      // oxlint-disable-next-line promise/no-multiple-resolved -- boundary: the interval is cleared before the one resolve, so it fires once
      resolve()
    }, 1)
  })
}

test("account bridge attaches before opening and forwards coalesced readiness bytes", async (t) => {
  const { socketPath, received } = await serve(t, Buffer.concat([
    Buffer.from('{"flywheel":"account.attach.ready"}\n'),
    Buffer.from([9, 8, 7]),
  ]))

  const messages: HostMessage[] = []
  const bridge = new SocketBridge({ socketPath, projectRoot: "/other/project", credential: "secret" }, (message) => messages.push(message))
  bridge.handle({ type: "socket.open", id: 4 })
  await until(() => messages.length >= 3)

  assert.deepEqual(messages.map(({ type }) => type), ["socket.opened", "socket.data", "socket.closed"])
  // The preface selects the project and nothing more: the client's identity
  // travels inside the protocol, where the runtime checks it at every attach.
  assert.equal(received[0]!.toString(), '{"flywheel":"account.attach","intent":"runtime","projectRoot":"/other/project","credential":"secret"}\n')
  assert.deepEqual(messages[1], { type: "socket.data", id: 4, bytes: new Uint8Array([9, 8, 7]) })
  bridge.dispose()
})

test("account bridge closes a channel the account service refuses, with the refusal's words", async (t) => {
  const { socketPath } = await serve(t, Buffer.from('{"flywheel":"account.attach.failed","error":"project root is not a directory"}\n'))

  const messages: HostMessage[] = []
  const bridge = new SocketBridge({ socketPath, projectRoot: "/other/project", credential: "secret" }, (message) => messages.push(message))
  bridge.handle({ type: "socket.open", id: 5 })
  await until(() => messages.length >= 1)

  assert.deepEqual(messages, [{ type: "socket.closed", id: 5, error: "project root is not a directory" }])
  bridge.dispose()
})
