import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { ModelAssignmentRow } from "../../../src/protocol/model-assignment-protocol-types.js"
import { roleGroups } from "./model-roles.js"

/** The role browser's rows, held to the runtime's order and to the one glyph
 *  rule the product states: the inheritance mark appears only when both the
 *  model and the effort match the inherited pair (PI-MODEL-008). */

const assignment = (roleId: string, model: string, matchesInheritedPair = false): ModelAssignmentRow =>
  ({ slot: { kind: "role", roleId }, label: roleId, model, effort: "medium", modelSource: "explicit", matchesInheritedPair })

describe("roleGroups", () => {
  test("groups consecutive roles under the runtime's group names and marks unassigned seats", () => {
    const roles = [
      { id: "chat", label: "Chat", description: "Answers you", group: "core" },
      { id: "workflow-agent", label: "Workflow", description: "Runs workflows", group: "agents" },
      { id: "reviewer", label: "Reviewer", description: "Reviews work", group: "agents" },
      { id: "advisor", label: "Advisor", description: "Second opinion", group: "agents" },
      { id: "learner", label: "Learner", description: "Background", group: "background" },
      { id: "custom", label: "Custom", description: "Unknown group", group: "misc" },
    ]
    const groups = roleGroups(roles, [assignment("chat", "gpt-5", true)])
    assert.deepEqual(groups.map((group) => [group.title, group.rows.map((row) => row.value)]), [
      ["Core", ["gpt-5 · medium ↳"]],
      ["Agents", ["not assigned", "not assigned", "not assigned"]],
      ["Background", ["not assigned"]],
      ["misc", ["not assigned"]],
    ])
    assert.equal(groups[0]?.rows[0]?.detail, "Answers you")
    assert.deepEqual(groups.filter(({ title }) => title === "Agents").map(({ rows }) => rows.map(({ label }) => label)), [
      ["Workflow", "Reviewer", "Advisor"],
    ])
  })
})

