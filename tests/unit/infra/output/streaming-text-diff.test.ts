import { describe, expect, it } from "bun:test"
import type { ProvisionalDiffLine, ToolStreamingText } from "../../../../src/infra/output-blocks.js"
import { diffStreamingEntry } from "../../../../src/infra/output/streaming-text-diff.js"

function line(index: number, text: string, partial = false): ProvisionalDiffLine {
  return { id: `file-0:content:line-${index}`, kind: "add", text, partial }
}

function proposal(lines: ProvisionalDiffLine[]): ToolStreamingText {
  return { proposedDiff: { files: [{ id: "file-0", path: "a.ts", action: "add", hunks: [{ id: "file-0:hunk-0", lines, omittedBefore: 0, omittedAfter: 0 }] }] } }
}

describe("diffStreamingEntry", () => {
  it("names growing text as one append at its old end", () => {
    expect(diffStreamingEntry({ content: "echo hi" }, { content: "echo hi\nhi\n" })).toEqual([
      { kind: "append", path: ["content"], offset: 7, text: "\nhi\n" },
    ])
  })

  it("names a sliding output tail as the prefix it dropped and the suffix it gained", () => {
    const before = Array.from({ length: 50 }, (_, i) => `line ${i}\n`).join("")
    const after = Array.from({ length: 50 }, (_, i) => `line ${i + 10}\n`).join("")
    const edits = diffStreamingEntry({ content: before }, { content: after })
    expect(edits).toEqual([{ kind: "window", path: ["content"], offset: before.length, drop: before.indexOf("line 10\n"), text: Array.from({ length: 10 }, (_, i) => `line ${i + 50}\n`).join("") }])
  })

  it("names a growing proposed diff as the lines it gained, not the diff again", () => {
    const shared = line(0, "const a = 1")
    const before = proposal([shared, line(1, "cons", true)])
    const after = proposal([shared, line(1, "const b = 2"), line(2, "exp", true)])
    expect(diffStreamingEntry(before, after)).toEqual([
      { kind: "append", path: ["proposedDiff", "files", 0, "hunks", 0, "lines", 1, "text"], offset: 4, text: "t b = 2" },
      { kind: "assign", path: ["proposedDiff", "files", 0, "hunks", 0, "lines", 1, "partial"], value: false },
      { kind: "push", path: ["proposedDiff", "files", 0, "hunks", 0, "lines"], length: 2, items: [line(2, "exp", true)] },
    ])
  })

  it("rewrites a line whose identity changed instead of editing a different line", () => {
    const before = proposal([line(0, "a")])
    const after = proposal([{ ...line(0, "a"), id: "file-0:hunk-1:line-0" }])
    expect(diffStreamingEntry(before, after)).toEqual([
      { kind: "assign", path: ["proposedDiff", "files", 0, "hunks", 0, "lines", 0], value: { ...line(0, "a"), id: "file-0:hunk-1:line-0" } },
    ])
  })

  it("answers nothing when the entry did not change", () => {
    const entry = proposal([line(0, "a")])
    expect(diffStreamingEntry(entry, proposal([line(0, "a")]))).toEqual([])
  })

  it("ships an entry that changed kind whole", () => {
    expect(diffStreamingEntry({ content: "draft" }, { previewCheck: "Old text not found." })).toBeUndefined()
    expect(diffStreamingEntry(proposal([line(0, "a")]), { content: "running" })).toBeUndefined()
  })

  it("assigns a string that neither grew nor slid", () => {
    expect(diffStreamingEntry({ content: "abc" }, { content: "xyz" })).toEqual([{ kind: "assign", path: ["content"], value: "xyz" }])
  })
})
