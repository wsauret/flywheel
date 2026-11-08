import assert from "node:assert/strict"
import { test } from "node:test"
import { mountComposerSubmission } from "./composer-submission-loader-fixture.js"

test("a selection added while a sent message is recalled stays when Down leaves history", async () => {
  const mounted = mountComposerSubmission({ caret: "end" })
  try {
    mounted.publishSent(["fix the parser"])
    mounted.key("ArrowUp")
    await mounted.settle()
    mounted.insertText("Selection: src/a.ts:10-20")
    mounted.key("ArrowDown")
    await mounted.settle()
    assert.equal(mounted.text(), "fix the parser\nSelection: src/a.ts:10-20")
  } finally { mounted.dispose() }
})

test("the draft that a recalled message holds aside is the draft that returned words follow and that a session switch keeps", async () => {
  const mounted = mountComposerSubmission({ caret: "end" })
  try {
    mounted.publishSent(["fix the parser"])
    mounted.type("my draft")
    mounted.key("ArrowUp")
    await mounted.settle()
    assert.equal(mounted.text(), "fix the parser")
    mounted.appendInput("chat", "unread child words")
    assert.equal(mounted.text(), "my draft\n\nunread child words")
    mounted.type("my words")
    mounted.key("ArrowUp")
    await mounted.settle()
    assert.equal(mounted.text(), "fix the parser")
    mounted.openChat("other")
    mounted.openChat("chat")
    assert.equal(mounted.text(), "my words")
  } finally { mounted.dispose() }
})
