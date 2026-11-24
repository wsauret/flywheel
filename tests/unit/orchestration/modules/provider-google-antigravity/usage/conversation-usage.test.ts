import { Database } from "bun:sqlite"
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { join } from "node:path"
import { Log } from "../../../../../../src/infra/log.js"
import { createUsageLedger, readConversationRows, type ConversationRead } from "../../../../../../src/orchestration/modules/provider-google-antigravity/usage/conversation-usage.js"
import { temporaryDirectories } from "../../../../../helpers/directories.js"

const temporary = temporaryDirectories()
const warn = spyOn(Log.create({ service: "provider-google-antigravity" }), "warn").mockImplementation(() => {})
afterEach(() => { warn.mockClear() })

// A protobuf writer for rows of the shape that agy 1.5.14 writes to `gen_metadata`.
const varint = (value: number): number[] => {
  const bytes: number[] = []
  let rest = value
  while (rest >= 0x80) {
    bytes.push((rest % 0x80) | 0x80)
    rest = Math.floor(rest / 0x80)
  }
  return [...bytes, rest]
}
type Value = number | string | Uint8Array
const field = (number: number, value: Value): number[] => {
  if (typeof value === "number") return [...varint(number * 8), ...varint(value)]
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value
  return [...varint(number * 8 + 2), ...varint(bytes.length), ...bytes]
}
const message = (...fields: (readonly [number, Value])[]): Uint8Array => Uint8Array.from(fields.flatMap(([number, value]) => field(number, value)))

interface Counts {
  readonly input: number
  readonly output: number
  readonly cacheRead?: number
  readonly thoughts?: number
}

/** One model request's row: the request body (only on the newest row), the usage, its mirror, the model, and the
 *  request id. Proto3 leaves a count of zero out. */
function row(idx: number, counts: Counts, body = false): Uint8Array {
  const { input, output, cacheRead = 0, thoughts = 0 } = counts
  const usage = message(
    [1, 1320], [2, input], [3, output],
    ...cacheRead === 0 ? [] : [[5, cacheRead] as const],
    [6, 24], [7, "HvQFa7SnHMvykPIPu4u1wQU"],
    ...thoughts === 0 ? [] : [[9, thoughts] as const],
    [10, output - thoughts], [11, "HvQFa7SnHMvykPIPu4u1wQU"],
  )
  const metadata = message(
    ...body ? [[1, new Uint8Array(60_000).fill(0x61)] as const, [2, message([1, "contents"])] as const] : [],
    [3, 1320], [4, usage], [17, message([2, usage])], [19, "gemini-3.8-flash-n"],
    [20, message([1, "request_id"], [2, `ee2fe6c6-56bb-48b6-b3b4-f3e71cac71f9-${String(idx)}`])],
  )
  return message([1, metadata], [4, "5fb9ddbe-4e1f-4749-bf92-2fa071a0b8d3"])
}

/** A conversation database as agy keeps it: WAL mode, held open by its writer. */
function conversation(rows: readonly Uint8Array[] = []) {
  const path = join(temporary("antigravity-conversation-"), "c.db")
  const writer = new Database(path)
  writer.run("PRAGMA journal_mode = WAL")
  writer.run("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, size INTEGER, data BLOB)")
  let next = 0
  const add = (...added: readonly Uint8Array[]) => {
    for (const data of added) writer.query("INSERT INTO gen_metadata (idx, size, data) VALUES (?, 0, ?)").run(next++, data)
  }
  add(...rows)
  return { path, add, close: () => { writer.close() } }
}

describe("agy conversation usage", () => {
  test("reads the usage of each row after a position from a database that its writer holds open", () => {
    const db = conversation([row(0, { input: 4772, output: 1 }), row(1, { input: 2120, output: 30, cacheRead: 2732 })])
    db.add(row(2, { input: 2132, output: 54, cacheRead: 2823, thoughts: 20 }, true))
    try {
      expect(readConversationRows(db.path, 0)).toEqual({
        kind: "rows",
        lastIdx: 2,
        rows: [
          { inputTokens: 2120, cacheReadTokens: 2732, outputTokens: 30, reasoningTokens: 0 },
          { inputTokens: 2132, cacheReadTokens: 2823, outputTokens: 54, reasoningTokens: 20 },
        ],
      })
      expect(readConversationRows(db.path, 2)).toEqual({ kind: "rows", lastIdx: 2, rows: [] })
      // The writer still owns the database: it can write the next row.
      db.add(row(3, { input: 1, output: 1 }))
      expect(readConversationRows(db.path, 2)).toMatchObject({ lastIdx: 3 })
    } finally {
      db.close()
    }
  })

  test("a missing database and a row that does not decode are unreadable, and a read past an undecodable row moves past it", () => {
    expect(readConversationRows(join(temporary("antigravity-conversation-"), "none.db"), -1)).toEqual({ kind: "unreadable", reason: "no-database", lastIdx: -1 })
    const db = conversation([row(0, { input: 10, output: 1 }), Uint8Array.from([0x0a, 0x05, 0x01])])
    try {
      expect(readConversationRows(db.path, -1)).toEqual({ kind: "unreadable", reason: "undecodable-row", lastIdx: 1 })
      // A row without its input count is not a model request's usage.
      db.add(message([1, message([4, message([3, 5])])]))
      expect(readConversationRows(db.path, 1)).toEqual({ kind: "unreadable", reason: "undecodable-row", lastIdx: 2 })
    } finally {
      db.close()
    }
  })
})

describe("usage ledger of one engine session", () => {
  const ids = { processId: "p1", sessionId: "s1" }

  /** A ledger over the database `db`, which counts its reads. */
  function ledgerOf(path: string) {
    const reads: number[] = []
    const ledger = createUsageLedger({ ...ids, read: (afterIdx) => { reads.push(afterIdx); return readConversationRows(path, afterIdx) } })
    return { ledger, reads }
  }

  test("each settled request sums its own rows, and a prompt whose rows match its aggregate records nothing", () => {
    const db = conversation()
    try {
      const { ledger, reads } = ledgerOf(db.path)
      ledger.startPrompt()
      db.add(row(0, { input: 2120, output: 30, cacheRead: 2732 }))
      expect(ledger.settle(4882)).toEqual({ inputTokens: 2120, cacheReadTokens: 2732, outputTokens: 30, reasoningTokens: 0 })
      // Two model requests of one Flywheel request, such as one around a call that agy runs itself.
      db.add(row(1, { input: 2132, output: 54, cacheRead: 2823, thoughts: 4 }), row(2, { input: 100, output: 6, cacheRead: 5000 }))
      expect(ledger.settle(5106)).toEqual({ inputTokens: 2232, cacheReadTokens: 7823, outputTokens: 60, reasoningTokens: 4 })
      ledger.endPrompt({ inputTokens: 4352, outputTokens: 90, cachedReadTokens: 10555, cachedWriteTokens: 0, thoughtTokens: 4, totalTokens: 14997 })
      expect(reads).toEqual([-1, 0])
      expect(warn).not.toHaveBeenCalled()
      ledger.close()
    } finally {
      db.close()
    }
  })

  test("a prompt whose rows differ from its aggregate records one warning with numbers only", () => {
    const db = conversation()
    try {
      const { ledger } = ledgerOf(db.path)
      ledger.startPrompt()
      db.add(row(0, { input: 4772, output: 1 }))
      expect(ledger.settle(4773)).toEqual({ inputTokens: 4772, cacheReadTokens: 0, outputTokens: 1, reasoningTokens: 0 })
      ledger.endPrompt({ inputTokens: 4000, outputTokens: 1, cachedReadTokens: 772, cachedWriteTokens: 0, thoughtTokens: 0, totalTokens: 4773 })
      expect(warn.mock.calls).toEqual([[expect.any(String), { ...ids, reason: "aggregate-differs", rowInput: 4772, rowCacheRead: 0, rowOutput: 1, input: 4000, cacheRead: 772, cacheWrite: 0, output: 1 }]])
      ledger.close()
    } finally {
      db.close()
    }
  })

  const fallbacks: ReadonlyArray<readonly [string, (afterIdx: number) => ConversationRead, number, string]> = [
    ["the database is missing", (afterIdx) => ({ kind: "unreadable", reason: "no-database", lastIdx: afterIdx }), 1000, "no-database"],
    ["a row does not decode", () => ({ kind: "unreadable", reason: "undecodable-row", lastIdx: 0 }), 1000, "undecodable-row"],
    ["agy reported a model request but recorded no row", (afterIdx) => ({ kind: "rows", lastIdx: afterIdx, rows: [] }), 1000, "no-row"],
    ["the newest row's total differs from agy's occupancy report", () => ({ kind: "rows", lastIdx: 0, rows: [{ inputTokens: 900, cacheReadTokens: 0, outputTokens: 10, reasoningTokens: 0 }] }), 1000, "occupancy-differs"],
  ]
  test.each(fallbacks)("a request settles without row usage when %s, and repeats of that record once and then count", (_name, read, used, reason) => {
    const ledger = createUsageLedger({ ...ids, read })
    ledger.startPrompt()
    expect(ledger.settle(used)).toBeUndefined()
    expect(ledger.settle(used)).toBeUndefined()
    expect(warn.mock.calls).toEqual([[expect.any(String), expect.objectContaining({ ...ids, reason })]])
    // A prompt with a request whose rows were not read has no sum to compare with its aggregate.
    if (reason === "no-database" || reason === "undecodable-row") {
      ledger.endPrompt({ inputTokens: 1, outputTokens: 1, cachedReadTokens: 0, cachedWriteTokens: 0, thoughtTokens: 0, totalTokens: 2 })
      expect(warn).toHaveBeenCalledTimes(1)
    }
    ledger.close()
    expect(warn.mock.calls[1]).toEqual([expect.any(String), { ...ids, reason, count: 1, windowMs: expect.any(Number) }])
  })
})
