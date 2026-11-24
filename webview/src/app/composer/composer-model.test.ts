import { strict as assert } from "node:assert"
import { test } from "node:test"

import { mountComposerSubmission } from "./composer-submission-loader-fixture.js"

const activeModel = { model: "session-model", effort: "low" }

test("the child composer names the runtime serving selection, not its chat assignment", () => {
  const mounted = mountComposerSubmission({ activeModel })
  try {
    mounted.openSubagent("child")
    assert.equal(mounted.model(), "Model: child-model, medium effort")
  } finally { mounted.dispose() }
})

test("a workflow agent's composer names its serving selection, not the session's active model", () => {
  const mounted = mountComposerSubmission({ activeModel })
  try {
    mounted.openWorkflow(true)
    mounted.openAgent("json")
    assert.equal(mounted.model(), "Model: gpt-6-luna, high effort")
  } finally { mounted.dispose() }
})

test("a chat names the active model resolved for that conversation", () => {
  const mounted = mountComposerSubmission({ activeModel })
  try {
    assert.equal(mounted.model(), "Model: session-model, low effort")
  } finally { mounted.dispose() }
})

test("an unread child assignment does not borrow another session's active model", () => {
  const mounted = mountComposerSubmission({ activeModel })
  try {
    // The runtime has no role reading for this child.
    mounted.openSubagent("grandchild")
    assert.equal(mounted.model(), undefined)
  } finally { mounted.dispose() }
})

test("an unread workflow agent assignment does not borrow the session's active model", () => {
  const mounted = mountComposerSubmission({ activeModel })
  try {
    // The runtime has no role reading for item "unread".
    mounted.openWorkflow(true)
    mounted.openAgent("unread")
    assert.equal(mounted.model(), undefined)
  } finally { mounted.dispose() }
})
