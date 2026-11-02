import { describe, expect, it } from "bun:test"
import type { ProvisionalDiffLine, ToolStreamingText } from "../../../../src/infra/output-blocks.js"
import type { StreamingToolTextOp } from "../../../../src/infra/output/output-block-delta.js"
import { diffStreamingEntry } from "../../../../src/infra/output/streaming-text-diff.js"
import { appendText, applyStreamingToolTextOps, type StreamingTextRejection } from "../../../../src/protocol/client/streaming-text-edits.js"

function line(index: number, text: string, partial = false): ProvisionalDiffLine {
  return { id: `l${index}`, kind: "add", text, partial }
}
function proposal(lines: ProvisionalDiffLine[]): ToolStreamingText {
  return { proposedDiff: { files: [{ id: "file-0", path: "a.ts", action: "add", hunks: [{ id: "h0", lines, omittedBefore: 0, omittedAfter: 0 }] }] } }
}
function edit(prev: ToolStreamingText, next: ToolStreamingText): StreamingToolTextOp {
  const edits = diffStreamingEntry(prev, next)
  if (edits === undefined) throw new Error("expected edits")
  return { toolUseId: "t", kind: "edit", edits }
}

const tail = (from: number, count: number) => Array.from({ length: count }, (_, i) => `line ${from + i}\n`).join("")
const pairs: readonly [string, ToolStreamingText, ToolStreamingText][] = [
  ["growing input", { content: "echo" }, { content: "echo hi" }],
  ["sliding tail", { content: tail(0, 40) }, { content: tail(15, 40) }],
  ["growing proposal", proposal([line(0, "a"), line(1, "b", true)]), proposal([line(0, "a"), line(1, "bc"), line(2, "d", true)])],
  ["rewritten line", proposal([line(0, "a")]), proposal([{ ...line(0, "a"), id: "other" }])],
  ["lost filetype", { content: "x", filetype: "ts" }, { content: "xy" }],
]

describe("applyStreamingToolTextOps", () => {
  for (const [name, prev, next] of pairs) {
    it(`rebuilds the store's entry from the edits for ${name}`, () => {
      expect(applyStreamingToolTextOps({ t: prev }, [edit(prev, next)])).toEqual({ t: next })
    })
    it(`keeps a redelivered edit for ${name} idempotent`, () => {
      const op = edit(prev, next)
      const once = applyStreamingToolTextOps({ t: prev }, [op])
      if (once === null) throw new Error("expected the edit to apply")
      expect(applyStreamingToolTextOps(once, [op])).toEqual({ t: next })
    })
  }

  it("keeps the map identity when nothing changed", () => {
    const map = { t: { content: "ab" } }
    const rejected: StreamingTextRejection[] = []
    expect(applyStreamingToolTextOps(map, [{ toolUseId: "t", kind: "edit", edits: [{ kind: "append", path: ["content"], offset: 0, text: "ab" }] }], (failure) => rejected.push(failure))).toBe(map)
    expect(applyStreamingToolTextOps(map, [{ toolUseId: "gone", kind: "remove" }], (failure) => rejected.push(failure))).toBe(map)
    expect(rejected).toEqual([])
  })

  it("sets and removes whole entries", () => {
    expect(applyStreamingToolTextOps({ a: { content: "x" } }, [{ toolUseId: "b", kind: "set", entry: { previewCheck: "No match." } }, { toolUseId: "a", kind: "remove" }])).toEqual({ b: { previewCheck: "No match." } })
  })

  it("answers null for edits against an entry or base the client does not hold", () => {
    const prefix: StreamingToolTextOp = { kind: "set", toolUseId: "prefix", entry: { content: "PRIVATE_STREAM_CONTENT" } }
    const missing: StreamingTextRejection[] = []
    expect(applyStreamingToolTextOps({}, [prefix, { toolUseId: "t", kind: "edit", edits: [{ kind: "append", path: ["content"], offset: 0, text: "PRIVATE_STREAM_CONTENT" }] }], (failure) => missing.push(failure))).toBeNull()
    expect(missing).toEqual([{ reason: "streaming-missing-entry", operationIndex: 1, operationKind: "edit", toolUseId: "t" }])
    for (const failedEdit of [
      { kind: "append" as const, path: ["content"], offset: 5, text: "PRIVATE_STREAM_CONTENT" },
      { kind: "window" as const, path: ["content"], offset: 9, drop: 2, text: "PRIVATE_STREAM_CONTENT" },
    ]) {
      const rejected: StreamingTextRejection[] = []
      expect(applyStreamingToolTextOps({ t: { content: "ab" } }, [prefix, { toolUseId: "t", kind: "edit", edits: [{ kind: "assign", path: ["filetype"], value: "ts" }, failedEdit] }], (failure) => rejected.push(failure))).toBeNull()
      expect(rejected).toEqual([{ reason: "streaming-edit-rejected", operationIndex: 1, operationKind: "edit", toolUseId: "t", editIndex: 1, editKind: failedEdit.kind }])
      expect(JSON.stringify(rejected)).not.toContain("PRIVATE_STREAM_CONTENT")
    }
  })

  it("refuses edits that would leave an entry the schema rejects", () => {
    const rejected: StreamingTextRejection[] = []
    expect(applyStreamingToolTextOps({ t: { content: "PRIVATE_STREAM_CONTENT" } }, [
      { kind: "set", toolUseId: "prefix", entry: { content: "PRIVATE_STREAM_CONTENT" } },
      { toolUseId: "t", kind: "edit", edits: [{ kind: "assign", path: ["content"], value: 3 }] },
    ], (failure) => rejected.push(failure))).toBeNull()
    expect(rejected).toEqual([{ reason: "streaming-invalid-shape", operationIndex: 1, operationKind: "edit", toolUseId: "t" }])
    expect(JSON.stringify(rejected)).not.toContain("PRIVATE_STREAM_CONTENT")
  })
})

describe("appendText", () => {
  it("extends from the offset, tolerates text already held, and refuses a missing stretch", () => {
    expect(appendText("ab", 2, "cd")).toBe("abcd")
    expect(appendText("abcd", 2, "cd")).toBe("abcd")
    expect(appendText("abc", 2, "cd")).toBe("abcd")
    expect(appendText("abx", 2, "cd")).toBeNull()
    expect(appendText("a", 2, "cd")).toBeNull()
  })
})
