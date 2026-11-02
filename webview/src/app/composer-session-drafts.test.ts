import assert from "node:assert/strict"
import { test } from "node:test"
import { mountComposerSubmission } from "./composer-submission-loader-fixture.js"
import { textContent } from "./render-ownership-host-fixture.js"
import { createComposerDrafts } from "../client/composer-drafts.js"

test("an inactive nonresident draft settles and transfers once through its owner", () => {
  const drafts = createComposerDrafts(() => undefined, "child")
  const parent = { text: "parent draft", attachments: [] }
  drafts.move("parent", { text: "sent edits", attachments: [] }, false)
  assert.deepEqual(drafts.settle("child", "sent", parent), parent)
  const result = drafts.finish("child", "parent", parent)
  assert.equal(result.moved, true)
  assert.equal(result.active.text, "parent draft\n\n edits")
  assert.equal(drafts.move("child", result.active, false), undefined)
})

for (const runOutcome of ["stopped", "failed", "cancelled"] as const) {
  test(`a ${runOutcome} child keeps its draft for Resume with no question or editable prompt`, () => {
    const mounted = mountComposerSubmission()
    try {
      mounted.publishQuestion(true)
      assert.equal(mounted.question(), true)
      mounted.openSubagent()
      mounted.type("keep for Resume")
      mounted.openStoppedSubagent(runOutcome)
      assert.equal(mounted.question(), false)
      assert.equal(mounted.editable(), false)
      assert.equal(mounted.resumeOffered(), true)
      assert.equal(mounted.text(), "keep for Resume")
      assert.equal(mounted.elements().some(node => textContent(node).includes("finished.")), false)
      mounted.openSubagent()
      assert.equal(mounted.text(), "keep for Resume")
    } finally { mounted.dispose() }
  })
}

test("each session keeps its own unsent words and files, and a session with none opens empty", async () => {
  const mounted = mountComposerSubmission()
  try {
    mounted.type("for the chat")
    await mounted.attach("removed.txt")
    await mounted.attach("notes.txt")
    mounted.remove("removed.txt")
    mounted.openChat("other")
    assert.equal(mounted.text(), "")
    assert.equal(mounted.attachmentCount(), 0)
    mounted.type("for the other")
    mounted.openChat("chat")
    assert.equal(mounted.text(), "for the chat")
    assert.equal(mounted.attachmentCount(), 1)
    const saved = mounted.capture()
    assert.equal(saved.active.attachments[0]?.marker, "[File #2 notes.txt]")
    mounted.openChat("other")
    assert.equal(mounted.text(), "for the other")
    assert.equal(mounted.attachmentCount(), 0)
  } finally { mounted.dispose() }
})

test("the ordinary child body retains its draft, model reading, and composer across equivalent publications", async () => {
  const mounted = mountComposerSubmission()
  try {
    mounted.type("parent draft")
    mounted.openSubagent()
    assert.equal(mounted.text(), "")
    assert.equal(mounted.model(), "Model: child-model, medium effort")
    assert.equal(mounted.placeholder(), "Message this subagent")
    const field = mounted.field()
    const subscriptions = [...mounted.roleSubscriptions]
    mounted.type("child draft")
    mounted.appendInput("chat", "returned words")
    for (let pass = 0; pass < 2; pass++) mounted.refresh()
    assert.equal(mounted.field(), field)
    assert.equal(mounted.text(), "child draft")
    assert.deepEqual(mounted.roleSubscriptions, subscriptions)
    mounted.openSubagent("nested")
    mounted.type("nested draft")
    mounted.openSubagent()
    assert.equal(mounted.text(), "child draft")
    assert.equal(mounted.model(), "Model: child-model, medium effort")
    mounted.send()
    await mounted.accept()
    assert.equal(mounted.sent.at(-1)?.text, "child draft")
    mounted.openChat("chat")
    assert.equal(mounted.text(), "parent draft\n\nreturned words")
  } finally { mounted.dispose() }
})

test("a handoff refusal keeps the edited draft and returns it once when the subagent finishes", async () => {
  const mounted = mountComposerSubmission()
  try {
    mounted.type("parent draft")
    mounted.openSubagent()
    mounted.type("refused words")
    mounted.send()
    mounted.type("refused words and edits")
    await mounted.refuse("handoff")
    assert.equal(mounted.text(), "refused words and edits")
    assert.deepEqual(mounted.reports, ["This agent has started its handoff and cannot read another message. Your draft was kept."])
    mounted.completeSubagent()
    mounted.openChat("chat")
    assert.equal(mounted.text(), "parent draft\n\nrefused words and edits")
    mounted.openSubagent()
    assert.equal(mounted.text(), "")
    mounted.openChat("chat")
    assert.equal(mounted.text(), "parent draft\n\nrefused words and edits")
  } finally { mounted.dispose() }
})

for (const inactive of [false, true]) {
  test(`an accepted child send clears only its source draft before finish (inactive=${inactive})`, async () => {
    const mounted = mountComposerSubmission()
    try {
      mounted.type("parent draft")
      mounted.openSubagent()
      mounted.type("sent")
      mounted.send()
      mounted.type("sent edits")
      if (inactive) mounted.openChat("chat")
      await mounted.accept()
      if (inactive) {
        assert.equal(mounted.text(), "parent draft")
        mounted.openSubagent()
      }
      assert.equal(mounted.text(), " edits")
      mounted.completeSubagent(inactive ? "partial" : "completed")
      const notice = mounted.elements().find(node => node.properties.class === "composer-finished-notice")
      assert.ok(notice)
      assert.notEqual(notice.parent?.properties.class, "composer-field")
      const field = mounted.elements().find(node => node.properties.class === "composer-field")
      assert.deepEqual(field?.properties.style, { display: "none" }, "a finished viewer shows its notice, not composer controls")
      mounted.openChat("chat")
      assert.equal(mounted.text(), "parent draft\n\n edits")
    } finally { mounted.dispose() }
  })
}

for (const accepted of [false, true]) {
  test(`a child receipt settles after finish and navigation without touching the selected draft (accepted=${accepted})`, async () => {
    const mounted = mountComposerSubmission()
    try {
      mounted.type("parent draft")
      mounted.openSubagent()
      mounted.type("sent")
      mounted.send()
      mounted.type("sent edits")
      mounted.completeSubagent()
      mounted.openChat("other")
      mounted.type("other draft")
      if (accepted) await mounted.accept()
      else await mounted.refuse()
      assert.equal(mounted.text(), "other draft")
      mounted.openChat("chat")
      assert.equal(mounted.text(), `parent draft\n\n${accepted ? " edits" : "sent edits"}`)
    } finally { mounted.dispose() }
  })
}
