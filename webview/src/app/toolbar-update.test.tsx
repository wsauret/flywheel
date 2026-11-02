import assert from "node:assert/strict"
import { test } from "node:test"

import { loadBudgetRenderFixture } from "./budget-render-test-loader.js"
import { promptSessionRename } from "./session-actions.js"
import { fakeClient, fakeClientActions, fakeSessionSummary, fakeViewState } from "./client-context-fixture.js"

// The chip is for a release a person can take or restart into. A release that
// could not start on this machine asks nothing of the person, so only the
// Status rows name it.
test("toolbar shows the update chip for a release to take and none for a release that could not start here", async () => {
  const fixture = await loadBudgetRenderFixture()
  const mounted = fixture.mountToolbarBudget()
  try {
    mounted.setUpdate({ kind: "installed", version: "1.4.0" })
    assert.equal(mounted.updateChipText(), "1.4.0 installed, restart to use it")
    mounted.setUpdate({ kind: "refused", version: "1.4.0" })
    assert.equal(mounted.updateChipText(), undefined)
  } finally {
    mounted.dispose()
  }
})

// Close, Delete, and Rename start from the command panel, which closes, so
// on the phone's chat screen no session row is there to show that they work.
// The chat's own title shows it instead.
for (const layout of ["wide", "phone"] as const) {
  test(`the ${layout} toolbar title reads working while Close, Delete, or Rename of the open chat runs`, async () => {
    const fixture = await loadBudgetRenderFixture()
    const mounted = fixture.mountToolbarActing(layout)
    try {
      for (const act of [() => mounted.actions.closeSession("session-a"), () => mounted.actions.removeSession("session-a"), () => mounted.actions.renameSession("session-a", { title: "Renamed" })]) {
        assert.equal(mounted.titleBusy(), false)
        act()
        assert.equal(mounted.titleBusy(), true)
        await mounted.release()
      }
      assert.equal(mounted.titleBusy(), false)
      mounted.actions.removeSession("session-b")
      assert.equal(mounted.titleBusy(), false)
    } finally {
      mounted.dispose()
    }
  })
}

test("the shared rename prompt initializes both fields and sends only each changed field", async () => {
  const edits: unknown[] = []
  let editTab = true
  let missingTab = false
  const idle = fakeViewState()
  const context = fakeClient({
    state: () => ({ ...idle, sessions: [fakeSessionSummary({ id: "chat", kind: "chat", title: missingTab ? "Original description" : "Tab", ...(missingTab ? {} : { shortTitle: "Tab", subtitle: "Long description" }) })] }),
    actions: fakeClientActions({ renameSession: (id, patch) => { edits.push({ id, patch }) } }),
    prompt: async (request) => {
      assert.equal(request.initialValue, missingTab ? "Original description" : "Long description")
      assert.equal(request.secondaryField?.initialValue, missingTab ? "Original descr" : "Tab")
      if (editTab) {
        request.secondaryField?.onChange("")
        assert.equal(request.secondaryField?.validate?.(), "A tab title cannot be empty.")
        assert.equal(request.validate?.("Long description"), undefined)
        request.secondaryField?.onChange("12345678901234567890")
        assert.equal(request.secondaryField?.validate?.(), undefined)
        return "Long description"
      }
      return "A description longer than the generated forty-six character limit"
    },
  })
  await promptSessionRename(context, "chat")
  editTab = false
  await promptSessionRename(context, "chat")
  missingTab = true
  await promptSessionRename(context, "chat")
  assert.deepEqual(edits, [
    { id: "chat", patch: { shortTitle: "12345678901234" } },
    { id: "chat", patch: { title: "A description longer than the generated forty-six character limit" } },
    { id: "chat", patch: { title: "A description longer than the generated forty-six character limit" } },
  ])
})
