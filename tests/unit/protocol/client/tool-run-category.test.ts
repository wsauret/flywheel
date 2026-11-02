import { describe, expect, it } from "bun:test"
import { getToolDisplay } from "../../../../src/infra/tools/tool-display-registry.js"
import { mergeableRead, readRowPath, toolRunCategoryFor } from "../../../../src/protocol/client/tool-run-category.js"

describe("toolRunCategoryFor", () => {
  it("folds reads, listings, and searches into explore and shell and bookkeeping calls into exec", () => {
    expect(toolRunCategoryFor({ name: "read", action: "file_read" })).toBe("explore")
    expect(toolRunCategoryFor({ name: "list", action: "list" })).toBe("explore")
    expect(toolRunCategoryFor({ name: "search", action: "search" })).toBe("explore")
    expect(toolRunCategoryFor({ name: "bash", action: "shell_exec" })).toBe("exec")
    for (const name of ["message_session", "note_write", "memory", "skill_manage", "papercut_log", "process"]) {
      expect(toolRunCategoryFor({ name, action: getToolDisplay(name).action })).toBe("exec")
    }
  })

  it("keeps every other action standalone, and a tool with no known action too", () => {
    expect(toolRunCategoryFor({ name: "edit", action: "file_edit" })).toBeNull()
    expect(toolRunCategoryFor({ name: "mystery" })).toBeNull()
  })

  it("stands a shell command that declares mutations alone, as an edit does", () => {
    expect(toolRunCategoryFor({ name: "bash", action: "shell_exec", declaresMutation: true })).toBeNull()
    // A script's own calls stay in its run, edits included.
    expect(toolRunCategoryFor({ name: "bash", action: "shell_exec", declaresMutation: true, runCategoryOverride: "execute" })).toBe("execute")
  })

  it("lets the execute override and the script carrier win over the action", () => {
    expect(toolRunCategoryFor({ name: "read", action: "file_read", runCategoryOverride: "execute" })).toBe("execute")
    expect(toolRunCategoryFor({ name: "code" })).toBe("execute")
  })
})

describe("mergeableRead", () => {
  it("is a read that names something", () => {
    expect(mergeableRead({ action: "file_read", presentation: { name: "Read", detail: "a.ts" }, status: "completed" })).toBe(true)
    expect(mergeableRead({ action: "file_read", presentation: { name: "Read", detail: "" }, status: "streaming" })).toBe(true)
    expect(mergeableRead({ action: "file_read", presentation: { name: "Load Skill", detail: "" }, status: "completed" })).toBe(false)
    expect(mergeableRead({ action: "search", presentation: { name: "Search", detail: "x" }, status: "completed" })).toBe(false)
    expect(mergeableRead({ presentation: { name: "Read", detail: "a.ts" }, status: "completed" })).toBe(false)
  })
})

describe("readRowPath", () => {
  it("reads the path of the file a read row linked, and none for a resource or another tool", () => {
    expect(readRowPath({ action: "file_read", linkUri: "file:///work/docs/My%20Notes.md" })).toBe("/work/docs/My Notes.md")
    expect(readRowPath({ action: "file_read", linkUri: "file:///C:/work/a.ts" })).toBe("C:/work/a.ts")
    expect(readRowPath({ action: "file_read" })).toBeUndefined()
    expect(readRowPath({ action: "search", linkUri: "file:///work/a.ts" })).toBeUndefined()
  })
})
