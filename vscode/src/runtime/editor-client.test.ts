import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"

import { resolveEditorClient } from "./editor-client.js"

const IDENTITY = "ab".repeat(32)

/** One account service that answers every attach with `answer` and records what it received. */
async function serve(t: { after: (fn: () => void) => void }, answer: string | undefined): Promise<{ socketPath: string; received: string[] }> {
  const directory = mkdtempSync(join(tmpdir(), "flywheel-editor-client-"))
  const socketPath = join(directory, "runtime.sock")
  const received: string[] = []
  const server = net.createServer((socket) => {
    socket.once("data", (bytes) => {
      received.push(Buffer.from(bytes).toString())
      if (answer !== undefined) socket.end(answer)
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  t.after(() => {
    server.close()
    rmSync(directory, { recursive: true, force: true })
  })
  return { socketPath, received }
}

test("resolves the bundle the account service names for a client attach", async (t) => {
  const { socketPath, received } = await serve(t, `{"flywheel":"account.client","dir":"/runtime/webview/editor","identity":"${IDENTITY}"}\n`)
  const bundle = await resolveEditorClient({ socketPath, projectRoot: "/project", credential: "secret" })
  assert.deepEqual(bundle, { dir: "/runtime/webview/editor", identity: IDENTITY })
  assert.deepEqual(received, ['{"flywheel":"account.attach","intent":"client","host":"editor","credential":"secret"}\n'])
})

test("rejects with the account service's own error", async (t) => {
  const { socketPath } = await serve(t, '{"flywheel":"account.attach.failed","error":"editor client is missing: /runtime/webview/editor/webview.js"}\n')
  await assert.rejects(
    resolveEditorClient({ socketPath, projectRoot: "/project", credential: "secret" }),
    { message: "editor client is missing: /runtime/webview/editor/webview.js" },
  )
})

test("rejects an answer that is not a client bundle", async (t) => {
  const { socketPath } = await serve(t, '{"flywheel":"account.attach.ready"}\n')
  await assert.rejects(
    resolveEditorClient({ socketPath, projectRoot: "/project", credential: "secret" }),
    { message: "account service answered a client request with ready" },
  )
})

test("rejects when the account service closes without answering", async (t) => {
  const { socketPath } = await serve(t, "")
  await assert.rejects(
    resolveEditorClient({ socketPath, projectRoot: "/project", credential: "secret" }),
    { message: "account service closed before naming its client" },
  )
})

test("rejects when the account service does not answer in time", async (t) => {
  const { socketPath } = await serve(t, undefined)
  await assert.rejects(
    resolveEditorClient({ socketPath, projectRoot: "/project", credential: "secret" }, 20),
    { message: "account service did not name its client within 20ms" },
  )
})

test("rejects when there is no account service at the path", async () => {
  await assert.rejects(resolveEditorClient({ socketPath: join(tmpdir(), "flywheel-editor-client-absent.sock"), projectRoot: "/project", credential: "secret" }))
})
