import { describe, expect, test } from "bun:test"

import { projectTools, ToolSummaryCollisionError } from "../../../../../../src/orchestration/modules/provider-google-antigravity/tools/tool-projection.js"

const EDIT_SCHEMA = {
  type: "object" as const,
  properties: {
    path: { type: "string" },
    edits: { type: "array", items: { type: "object", properties: { old_string: { type: "string" }, toolSummary: { type: "string" } } } },
  },
  required: ["path", "edits"],
}

describe("the Antigravity tool projection", () => {
  test("lists each tool with its function description and its schema as Flywheel declares it, nested toolSummary included", () => {
    const wire = { kind: "custom" as const, grammar: { syntax: "lark" as const, definition: "start: /.+/" }, functionDescription: "Applies a patch given as text." }
    expect(projectTools([
      { name: "edit", description: "Replaces text.", input_schema: EDIT_SCHEMA },
      { name: "apply_patch", description: "Freeform patch.", input_schema: { type: "object", properties: { input: { type: "string" } } }, wire },
    ])).toEqual([
      { name: "edit", description: "Replaces text.", inputSchema: EDIT_SCHEMA },
      { name: "apply_patch", description: "Applies a patch given as text.", inputSchema: { type: "object", properties: { input: { type: "string" } } } },
    ])
  })

  test("refuses a tool whose own parameter is named toolSummary, which the engine reserves", () => {
    const tools = [
      { name: "read", description: "Reads.", input_schema: { type: "object", properties: { path: { type: "string" } } } },
      { name: "echo", description: "Echoes.", input_schema: { type: "object", properties: { toolSummary: { type: "string" } } } },
    ]
    expect(() => projectTools(tools)).toThrow(ToolSummaryCollisionError)
    expect(() => projectTools(tools)).toThrow("The tool echo declares the parameter toolSummary")
  })
})
