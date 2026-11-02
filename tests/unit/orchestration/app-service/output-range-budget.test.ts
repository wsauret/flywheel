/** The byte budget of one hydrated range: which records it keeps, and that it
 *  builds no record past the read-ahead batch that crosses the budget. */

import { describe, expect, it } from "bun:test"
import { minOutputRangeRecords, projectRecordsWithinRangeBudget, trimOutputRangeFromTail } from "../../../../src/orchestration/app-service/output-range-budget.js"
import { hydrateDerivedOutputRange } from "../../../../src/orchestration/app-service/transcript-queries.js"
import { indexOutputBlocks } from "../../../../src/orchestration/session/conversation/branch-history-builder.js"
import { blockIdentity } from "../../../../src/protocol/block-identity.js"
import { Schema } from "effect"
import { HydratedOutputRangeSchema, OutputRangeRequestSchema } from "../../../../src/protocol/transcript-protocol-schemas.js"

interface Raw {
  readonly id: string
  readonly bytes: number
}

function raws(...bytes: readonly number[]): Raw[] {
  return bytes.map((size, index) => ({ id: `raw-${index}`, bytes: size }))
}

async function budgeted(records: readonly Raw[], maxBytes: number, options?: { readonly fromTail?: boolean; readonly minRecords?: number }) {
  const projected: string[] = []
  const kept = await projectRecordsWithinRangeBudget({
    records,
    maxBytes,
    fromTail: options?.fromTail ?? false,
    minRecords: options?.minRecords ?? 1,
    project: (record: Raw) => {
      projected.push(record.id)
      return { id: record.id, bytes: record.bytes }
    },
    measure: (record) => record.bytes,
  })
  return { kept: kept.map((record) => record.id), projected }
}

describe("the byte budget of one hydrated range", () => {
  it("returns the whole surviving visible interval before soft block and byte budgets", async () => {
    const blocks = Array.from({ length: 12 }, (_, i) => ({ kind: "text" as const, id: `e:${i}`, content: "x".repeat(100), timestamp: 0 }))
    const history = { ...indexOutputBlocks(blocks), consistencyToken: "current" }
    for (const maxBlocks of [1, 10]) for (const maxBytes of [1, 300, 100_000]) {
      const request = Schema.decodeUnknownSync(OutputRangeRequestSchema)({
        anchor: { kind: "residentSpan", blockIds: ["text:e:3", "text:removed-middle", "text:e:7", "text:removed-end"], candidates: ["text:e:2"] },
        maxBlocks, maxBytes,
      })
      const range = Schema.decodeUnknownSync(HydratedOutputRangeSchema)(await hydrateDerivedOutputRange(history, request))
      if (range.kind !== "ok") throw new Error("expected protected range")
      const start = range.window.startBlockIndex
      if (start === null) throw new Error("expected contiguous range")
      expect(range.blocks.slice(3 - start, 8 - start).map(blockIdentity)).toEqual(blocks.slice(3, 8).map(blockIdentity))
      expect(range.membership).toEqual([
        { blockId: "text:e:3", index: 3 }, { blockId: "text:removed-middle", index: null },
        { blockId: "text:e:7", index: 7 }, { blockId: "text:removed-end", index: null }, { blockId: "text:e:2", index: 2 },
      ])
      expect(range.window.endBlockIndex).toBe(start + range.blocks.length - 1)
      if (maxBytes === 1) expect(range.blocks.map(blockIdentity)).toEqual(blocks.slice(3, 8).map(blockIdentity))
    }
  })

  it("projects no record past the read-ahead batch that crosses the budget", async () => {
    const { kept, projected } = await budgeted(raws(...Array.from({ length: 100 }, () => 1)), 40)

    expect(kept).toEqual(Array.from({ length: 40 }, (_, index) => `raw-${index}`))
    // Batches of 16 and then 32 records reach the record that crosses the
    // budget; the 52 records behind that batch are never projected.
    expect(projected).toEqual(Array.from({ length: 48 }, (_, index) => `raw-${index}`))
  })

  it("keeps the minimum records of an anchor window even when they exceed the budget", async () => {
    const { kept } = await budgeted(raws(100, 100, 100), 1, { minRecords: 2 })

    expect(kept).toEqual(["raw-0", "raw-1"])
  })

  it("spends the budget from the tail for a backwards anchor and returns the records in order", async () => {
    const { kept, projected } = await budgeted(raws(10, 10, 10, 10), 25, { fromTail: true })

    expect(kept).toEqual(["raw-2", "raw-3"])
    expect(projected).toEqual(["raw-3", "raw-2", "raw-1", "raw-0"])
  })

  it("names the anchors that read backwards and the windows that keep two records", () => {
    expect(trimOutputRangeFromTail({ kind: "tail" })).toBe(true)
    expect(trimOutputRangeFromTail({ kind: "beforeBlock", blockId: "text:a" })).toBe(true)
    expect(trimOutputRangeFromTail({ kind: "afterBlock", blockId: "text:a" })).toBe(false)
    expect(minOutputRangeRecords({ kind: "beforeBlock", blockId: "text:a" }, 3)).toBe(2)
    expect(minOutputRangeRecords({ kind: "beforeBlock", blockId: "text:a" }, 1)).toBe(1)
    expect(minOutputRangeRecords({ kind: "tail" }, 3)).toBe(1)
  })
})
