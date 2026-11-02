import { describe, expect, test } from "bun:test"
import { buildModelModalItems } from "../../../../src/tui/modals/model-modal-helpers.js"
import type { ModelAssignmentRow } from "../../../../src/protocol/model-assignment-protocol-types.js"
import { fakeRow } from "./_model-modal-fixtures"

const NONE: ReadonlySet<string> = new Set()

describe("model modal grouping", () => {
  test("Chat leads one Agents section with Workflow first and personas in role order", () => {
    const rows: ModelAssignmentRow[] = [
      fakeRow("chat", "Chat"),
      fakeRow("explorer", "Explorer"),
      fakeRow("reviewer", "Reviewer"),
      fakeRow("workflow-agent", "Workflow"),
    ]
    const items = buildModelModalItems(rows, NONE)
    const itemLabels = items.map((item) => item.kind === "assignment" ? item.row.slot.roleId : item.kind === "heading" ? item.title : item.kind)
    expect(itemLabels).toEqual(["chat", "spacer", "Agents", "workflow-agent", "reviewer", "explorer"])
  })

  test("Reviewer expands to subtype rows in metadata order", () => {
    const rows = [
      fakeRow("reviewer", "Reviewer"),
      fakeRow("reviewer-security", "Security"),
      fakeRow("reviewer-design", "Design"),
      fakeRow("reviewer-quality", "Quality"),
      fakeRow("reviewer-uat", "UAT"),
      fakeRow("reviewer-elegance", "Elegance"),
      fakeRow("reviewer-performance", "Performance"),
      fakeRow("reviewer-data-integrity", "Data Integrity"),
      fakeRow("reviewer-mechanism", "Mechanism"),
    ]
    const collapsed = buildModelModalItems(rows, NONE)
    expect(collapsed.flatMap((item) => item.kind === "assignment" ? [item.row.slot.roleId] : [])).toEqual(["reviewer"])
    expect(collapsed.find((item) => item.kind === "assignment")).toMatchObject({ disclosure: { id: "reviewer", expanded: false, interaction: "primary-and-disclosure" } })
    const expanded = buildModelModalItems(rows, new Set(["reviewer"]))
      .flatMap((item) => item.kind === "assignment" ? [{ roleId: item.row.slot.roleId, depth: item.depth }] : [])
    expect(expanded).toEqual([
      { roleId: "reviewer", depth: 0 },
      { roleId: "reviewer-quality", depth: 1 },
      { roleId: "reviewer-elegance", depth: 1 },
      { roleId: "reviewer-design", depth: 1 },
      { roleId: "reviewer-data-integrity", depth: 1 },
      { roleId: "reviewer-performance", depth: 1 },
      { roleId: "reviewer-security", depth: 1 },
      { roleId: "reviewer-mechanism", depth: 1 },
      { roleId: "reviewer-uat", depth: 1 },
    ])
  })

  test("sections follow the shared role-group order: Agents before Background", () => {
    const rows: ModelAssignmentRow[] = [
      fakeRow("chat", "Chat"),
      fakeRow("learning-review", "Learning Review"),
      fakeRow("title-generation", "Title Generation"),
      fakeRow("workflow-agent", "Workflow"),
    ]
    const items = buildModelModalItems(rows, NONE)
    const itemLabels = items.map((item) => item.kind === "assignment" ? item.row.slot.roleId : item.kind === "heading" ? item.title : item.kind)
    expect(itemLabels).toEqual(["chat", "spacer", "Agents", "workflow-agent", "spacer", "Background", "learning-review", "title-generation"])
  })
})
