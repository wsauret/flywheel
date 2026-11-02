import { strict as assert } from "node:assert"
import { test } from "node:test"

import { composerModel } from "./composer.js"

const childRoles = {
  assignments: { chat: { model: "wrong-chat", effort: "low" } },
  serving: { slot: { kind: "role" as const, roleId: "brief.build.at.worker" }, selection: { model: "gpt-6-astra", effort: "medium" } },
}
const activeModel = { model: "gpt-6-luna", effort: "high" }

test("the child composer names the runtime serving selection, not its chat assignment", () => {
  assert.deepEqual(composerModel("subagent", childRoles, activeModel), childRoles.serving.selection)
  assert.deepEqual(composerModel("workflow-agent", childRoles, activeModel), childRoles.serving.selection)
})

test("a chat names the active model resolved for that conversation", () => {
  assert.deepEqual(composerModel("chat", undefined, activeModel), activeModel)
})

test("an unread child assignment does not borrow another session's active model", () => {
  assert.equal(composerModel("workflow-agent", undefined, activeModel), undefined)
})
