import assert from "node:assert/strict"
import { test } from "node:test"

import { createSessionChangesController } from "../../../src/protocol/client/session-changes.js"
import { fileA, fileB, fileC, runtime, settle } from "../../../tests/unit/protocol/client/_session-changes-fixtures.js"
import { mountReview } from "./render-ownership-loader-fixture.js"

test("groups deleted files under their removed folder across pages, and the folder header discloses each file with its own controls", async () => {
  const server = runtime()
  const folder = { path: "/work/dl", files: 2 }
  const inFolder = (name: string, position: number) => ({ ...fileC, fileId: `file:dl:${name}`, path: `/work/dl/${name}`, editToken: { position, eventId: `edit-${name}` }, folder })
  server.current.files = [fileA, inFolder("x.bin", 4), inFolder("y.txt", 5), fileB]
  server.current.fileCount = 4
  server.current.pageSize = 2
  const controller = createSessionChangesController({ client: server.client, sessionId: "cold" })
  const mounted = mountReview(controller)
  try {
    await controller.start()
    await controller.loadMoreFiles()
    await settle()
    assert.match(mounted.fileText("/work/dl"), /dl\/ \(2 files\)/)
    assert.throws(() => mounted.fileNode("/work/dl/x.bin"))
    assert.equal(mounted.disabled("Undo", fileB.path), false)
    mounted.toggle("/work/dl")
    await settle()
    for (const path of ["/work/dl/x.bin", "/work/dl/y.txt"]) {
      assert.match(mounted.fileText(path), /Undo/)
      assert.equal(mounted.checked(path), false)
    }
    mounted.toggle("/work/dl")
    assert.throws(() => mounted.fileNode("/work/dl/y.txt"))
    server.current.files = server.current.files.map(file => file.folder ? { ...file, folder: { ...file.folder, files: 3 } } : file)
    server.current.revision = 9
    server.change()
    await settle()
    assert.match(mounted.fileText("/work/dl"), /dl\/ \(3 files\)/)
  } finally { mounted.dispose(); controller.dispose() }
})
