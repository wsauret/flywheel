import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { FileReadLedger, lineRangeOfByteSpans } from "../../../../../src/orchestration/agent-runtime/tools/file-read-ledger.js"

const text = (value: string) => Buffer.from(value, "utf8")
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

describe("file read ledger", () => {
  it("maps byte spans to the lines they touch", () => {
    const bytes = text("one\ntwo\nthree\nfour\n")
    expect(lineRangeOfByteSpans(bytes, [{ start: 4, end: 7 }])).toEqual({ start: 2, end: 2 })
    expect(lineRangeOfByteSpans(bytes, [{ start: 4, end: 14 }])).toEqual({ start: 2, end: 3 })
    expect(lineRangeOfByteSpans(bytes, [{ start: 8, end: 8 }])).toEqual({ start: 3, end: 3 })
    expect(lineRangeOfByteSpans(bytes, [{ start: bytes.length, end: bytes.length }])).toEqual({ start: 5, end: 5 })
    expect(lineRangeOfByteSpans(bytes, [])).toBeUndefined()
  })

  it("reports unread, changed, and uncovered evidence and nothing after a full read", () => {
    const ledger = new FileReadLedger()
    const content = text("a\nb\nc\nd\n")
    expect(ledger.staleness("/repo/a", content)).toEqual({ kind: "unread" })

    ledger.recordRead("/repo/a", hash(content), [{ start: 1, end: 2 }], 10)
    expect(ledger.staleness("/repo/a", content, { start: 2, end: 2 })).toBeUndefined()
    expect(ledger.staleness("/repo/a", content, { start: 3, end: 4 })).toEqual({ kind: "uncovered", lines: { start: 3, end: 4 } })
    expect(ledger.staleness("/repo/a", text("a\nB\nc\nd\n"), { start: 2, end: 2 })).toEqual({ kind: "changed", sincePosition: 10 })

    ledger.recordRead("/repo/a", hash(content), [{ start: 3, end: 4 }], 11)
    expect(ledger.staleness("/repo/a", content, { start: 1, end: 4 })).toBeUndefined()

    ledger.recordRead("/repo/a", hash(content), "full", 12)
    expect(ledger.staleness("/repo/a", content, { start: 1, end: 4 })).toBeUndefined()
  })

  it("treats search matches as seen lines without a content hash", () => {
    const ledger = new FileReadLedger()
    const content = text("a\nb\nc\n")
    ledger.recordSeen("/repo/a", [{ start: 2, end: 2 }], 5)
    expect(ledger.staleness("/repo/a", content, { start: 2, end: 2 })).toBeUndefined()
    expect(ledger.staleness("/repo/a", text("changed"), { start: 2, end: 2 })).toBeUndefined()
    expect(ledger.staleness("/repo/a", content, { start: 1, end: 1 })).toEqual({ kind: "uncovered", lines: { start: 1, end: 1 } })
  })

  it("counts a verified publication as a full read and forgets deleted files", () => {
    const ledger = new FileReadLedger()
    ledger.recordPublished("/repo/a", text("new"), 3)
    expect(ledger.staleness("/repo/a", text("new"), { start: 1, end: 1 })).toBeUndefined()
    ledger.forget("/repo/a")
    expect(ledger.staleness("/repo/a", text("new"))).toEqual({ kind: "unread" })
  })

  it("replaces coverage on a new fingerprint and merges only matching fingerprints", () => {
    const ledger = new FileReadLedger()
    const before = text("a\nb\nc")
    const after = text("a\nb\nC")
    ledger.recordRead("/repo/a", hash(before), "full", 1)
    ledger.recordRead("/repo/a", hash(after), [{ start: 1, end: 1 }], 2)
    expect(ledger.staleness("/repo/a", after, { start: 2, end: 2 })).toEqual({ kind: "uncovered", lines: { start: 2, end: 2 } })
    ledger.recordRead("/repo/a", hash(after), [{ start: 2, end: 3 }], 3)
    expect(ledger.staleness("/repo/a", after, { start: 1, end: 3 })).toBeUndefined()
    expect(ledger.staleness("/repo/a", before)).toEqual({ kind: "changed", sincePosition: 3 })
    ledger.recordPublished("/repo/a", before, 4)
    expect(ledger.staleness("/repo/a", after)).toEqual({ kind: "changed", sincePosition: 4 })
  })
})
