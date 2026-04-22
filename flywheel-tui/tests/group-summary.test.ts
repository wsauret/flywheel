import { describe, it, expect } from "bun:test"
import {
  deriveGroupSummary,
  toolsGroupLabel,
} from "../src/tui/routes/work/components/output-blocks/group-summary.js"
import type { ToolEntry } from "../src/infra/output-blocks.js"

function entry(name: string, filePath?: string): ToolEntry {
  return {
    kind: "tool",
    name,
    detail: "",
    timestamp: Date.now(),
    ...(filePath != null ? { filePath } : {}),
  }
}

describe("deriveGroupSummary", () => {
  it("read files deduped by path, searches separate", () => {
    const children = [
      entry("read", "/a/src/foo.ts"),
      entry("read", "/a/src/foo.ts"),
      entry("glob"),
    ]
    expect(deriveGroupSummary(children)).toBe("read 1 file · 1 search")
  })

  it("counts distinct read files", () => {
    const children = [
      entry("read", "/a/src/foo.ts"),
      entry("read", "/a/src/bar.ts"),
      entry("glob"),
    ]
    expect(deriveGroupSummary(children)).toBe("read 2 files · 1 search")
  })

  it("counts commands for bash tools", () => {
    const children = [entry("bash"), entry("bash")]
    expect(deriveGroupSummary(children)).toBe("2 commands")
  })

  it("returns empty string for empty group", () => {
    expect(deriveGroupSummary([])).toBe("")
  })

  it("counts execution tools as commands", () => {
    const children = [entry("websearch"), entry("webfetch")]
    expect(deriveGroupSummary(children)).toBe("2 commands")
  })

  it("singular forms when count is 1", () => {
    expect(deriveGroupSummary([entry("read", "/a.ts")])).toBe("read 1 file")
    expect(deriveGroupSummary([entry("grep")])).toBe("1 search")
    expect(deriveGroupSummary([entry("bash")])).toBe("1 command")
  })

  it("combines reads, searches, and commands", () => {
    const children = [
      entry("read", "/a.ts"),
      entry("grep"),
      entry("bash"),
    ]
    expect(deriveGroupSummary(children)).toBe("read 1 file · 1 search · 1 command")
  })

  it("edit/write tracked separately as edited files", () => {
    const children = [
      entry("edit", "/a/src/foo.ts"),
      entry("write", "/a/src/bar.ts"),
    ]
    expect(deriveGroupSummary(children)).toBe("edited 2 files")
  })

  it("reads and edits in same group show both bins", () => {
    const children = [
      entry("read", "/a/src/foo.ts"),
      entry("edit", "/a/src/foo.ts"),
    ]
    expect(deriveGroupSummary(children)).toBe("read 1 file · edited 1 file")
  })

  it("counts glob as searches", () => {
    const children = [entry("glob"), entry("glob"), entry("grep")]
    expect(deriveGroupSummary(children)).toBe("3 searches")
  })

  it("counts powershell and repl as commands", () => {
    const children = [entry("powershell"), entry("repl")]
    expect(deriveGroupSummary(children)).toBe("2 commands")
  })
})

describe("toolsGroupLabel", () => {
  it("active", () => {
    expect(toolsGroupLabel("active")).toBe("Exploring...")
  })

  it("paused", () => {
    expect(toolsGroupLabel("paused")).toBe("Interrupted")
  })

  it("completed", () => {
    expect(toolsGroupLabel("completed")).toBe("Explored")
  })
})
