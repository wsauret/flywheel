import assert from "node:assert/strict"
import { test } from "node:test"
import { createSessionChangesController } from "../../../src/protocol/client/session-changes.js"
import { fileA, fileB, list, retainedDiff, runtime, settle, waitForDiff } from "../../../tests/unit/protocol/client/_session-changes-fixtures.js"
import { mountReview } from "./render-ownership-loader-fixture.js"

test("explains an empty review with one excluded file", async () => {
  const server = runtime()
  server.current.files = []
  server.listReplies.push(Promise.resolve({ ...list(7, []), excludedFileCount: 1 }))
  const controller = createSessionChangesController({ client: server.client, sessionId: "cold" })
  const mounted = mountReview(controller)
  try {
    await controller.start()
    await settle()
    assert.match(mounted.text(), /1 file is not shown because it changed or was removed after this session's last recorded write\./)
  } finally { mounted.dispose(); controller.dispose() }
})

test("renders one header per file with full counts over a collapsed net diff that the header toggles", async () => {
  const server = runtime()
  server.diffReplies.push(Promise.resolve(retainedDiff(fileA.path, `@@ -0,0 +1,45 @@\n${Array.from({ length: 45 }, (_, index) => `+net line ${index}\n`).join("")}`, 45)))
  const controller = createSessionChangesController({ client: server.client, sessionId: "cold" })
  const opened: [string, string][] = []
  const mounted = mountReview(controller, undefined, (path, executionCwd) => opened.push([path, executionCwd]))
  try {
    await controller.start()
    await settle()
    await waitForDiff(controller, fileA.fileId)
    assert.match(mounted.text(), /2 changed/)
    assert.equal(mounted.count("changes-file"), 2)
    assert.equal(mounted.count("changes-file-path"), 2, "exactly one path per file")
    assert.equal(mounted.headerText(fileA.path, "changes-file-path"), "a.txt")
    assert.doesNotMatch(mounted.text(), /\/work\//)
    assert.equal(mounted.count("changes-file-change"), 2)
    assert.equal(mounted.count("diff-file-header"), 0)
    assert.equal(mounted.changeLabel(fileA.path), "modified")
    assert.equal(mounted.changeLabel(fileB.path), "added")
    assert.equal(mounted.headerText(fileA.path, "changes-file-counts"), "+45-0")
    // A file that launched agents changed names them; the chat's own file names nobody.
    assert.equal(mounted.headerText(fileB.path, "changes-file-writers"), "by Explorer, Reviewer +1")
    assert.equal(mounted.count("changes-file-writers"), 1)
    assert.match(mounted.fileText(fileA.path), /net line 19/)
    assert.doesNotMatch(mounted.fileText(fileA.path), /net line 20/)
    assert.match(mounted.fileText(fileA.path), /25 more diff lines/)
    mounted.toggle(fileA.path)
    assert.match(mounted.fileText(fileA.path), /net line 44/)
    assert.doesNotMatch(mounted.fileText(fileA.path), /more diff lines/)
    mounted.toggle(fileA.path)
    assert.doesNotMatch(mounted.fileText(fileA.path), /net line 20/)
    mounted.click("Open a.txt in editor", fileA.path)
    assert.deepEqual(opened, [[fileA.path, "/work"]])
    assert.equal(server.mutations.length, 0)
    const large = retainedDiff(fileA.path, `@@ -0,0 +1,1200 @@\n${Array.from({ length: 1000 }, (_, index) => `+line ${index}\n`).join("")}`, 1200, 0, 9)
    server.diffReplies.push(Promise.resolve({ ...large, diff: { ...large.diff, omittedLines: 200, renderedLines: 1200 } }))
    server.current.revision = 9
    server.current.files = [{ ...fileA, editToken: { position: 9, eventId: "large-edit" } }, fileB]
    await controller.refresh()
    await settle()
    await waitForDiff(controller, fileA.fileId)
    assert.equal(mounted.headerText(fileA.path, "changes-file-counts"), "+1200-0")
  } finally { mounted.dispose(); controller.dispose() }
})

test("names a file outside the session's directory without an open-in-editor button", async () => {
  const server = runtime()
  const outside = { ...fileB, fileId: "file:canonical:outside", path: "/elsewhere/b.txt" }
  server.current.files = [fileA, outside]
  const controller = createSessionChangesController({ client: server.client, sessionId: "cold" })
  const opened: string[] = []
  const mounted = mountReview(controller, undefined, path => opened.push(path))
  try {
    await controller.start()
    await settle()
    assert.equal(mounted.headerText(outside.path, "changes-file-path"), "/elsewhere/b.txt")
    assert.equal(mounted.copyPath(outside.path), "/elsewhere/b.txt")
    assert.throws(() => mounted.click("Open /elsewhere/b.txt in editor", outside.path), /Missing/)
    mounted.click("Open a.txt in editor", fileA.path)
    assert.deepEqual(opened, [fileA.path])
  } finally { mounted.dispose(); controller.dispose() }
})
