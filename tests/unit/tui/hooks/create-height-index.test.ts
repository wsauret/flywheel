import { describe, expect, it } from "bun:test"
import { createRoot } from "solid-js"
import { createHeightIndex } from "../../../../src/tui/hooks/create-height-index.js"

const flushMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

describe("createHeightIndex", () => {
  it("maps offset<->index inversely over estimates and stays consistent after measuring a subset", () => {
    createRoot((dispose) => {
      const index = createHeightIndex({ itemCount: 10, estimatedRows: 2 })

      // Pure estimate: every block is 2 rows, so block k starts at row 2k.
      for (let k = 0; k < 10; k += 1) {
        expect(index.blockIndexToRowOffset(k)).toBe(2 * k)
        expect(index.rowOffsetToBlockIndex(2 * k)).toBe(k)
      }

      // Refine block 3 to a measured 5 rows (delta +3). Its top offset is unchanged;
      // offsets above it shift; the inverse mapping stays consistent.
      index.recordMeasuredBatch([[3, 5]])
      expect(index.blockIndexToRowOffset(3)).toBe(6)
      expect(index.blockIndexToRowOffset(4)).toBe(6 + 5)
      expect(index.rowOffsetToBlockIndex(index.blockIndexToRowOffset(4))).toBe(4)
      expect(index.totalRows()).toBe(2 * 10 + 3)

      dispose()
    })
  })

  it("grows in place on tail resize, preserving measured heights", () => {
    createRoot((dispose) => {
      const index = createHeightIndex({ itemCount: 10, estimatedRows: 2 })
      index.recordMeasuredBatch([[3, 5]])
      const anchorOffset = index.blockIndexToRowOffset(5)

      index.resize(14) // live tail append: four new blocks at estimate height

      expect(index.blockIndexToRowOffset(5)).toBe(anchorOffset) // measurement survived
      expect(index.blockIndexToRowOffset(4)).toBe(2 * 3 + 5)
      expect(index.totalRows()).toBe(2 * 14 + 3)

      index.recordMeasuredBatch([[12, 7]]) // new tail blocks are measurable
      expect(index.totalRows()).toBe(2 * 14 + 3 + 5)

      dispose()
    })
  })

  it("shrinks on truncation, dropping out-of-range rows but keeping surviving measurements", () => {
    createRoot((dispose) => {
      const index = createHeightIndex({ itemCount: 10, estimatedRows: 2 })
      index.recordMeasuredBatch([[3, 5], [8, 9]])

      index.resize(6) // live truncate: block 8's measurement is gone, block 3's stays

      expect(index.totalRows()).toBe(2 * 6 + 3)
      expect(index.blockIndexToRowOffset(4)).toBe(2 * 3 + 5)

      index.resize(10) // regrow: the dropped measurement does not resurrect
      expect(index.totalRows()).toBe(2 * 10 + 3)

      dispose()
    })
  })

  it("accumulates nonzero extent corrections and drains them once per take", () => {
    createRoot((dispose) => {
      const index = createHeightIndex({ itemCount: 10, estimatedRows: 2 })

      index.recordMeasuredBatch([[2, 5], [3, 2], [4, 6]]) // block 3 matches the estimate: no correction
      index.seedEstimatedBatch([[7, 6]]) // estimate refinements accumulate too
      expect(index.takeCorrections()).toEqual([
        { blockIndex: 2, deltaRows: 3 },
        { blockIndex: 4, deltaRows: 4 },
        { blockIndex: 7, deltaRows: 4 },
      ])
      expect(index.takeCorrections()).toEqual([]) // drained

      index.recordMeasuredBatch([[2, 5]]) // unchanged re-measure: nothing accumulates
      expect(index.takeCorrections()).toEqual([])

      index.recordMeasuredBatch([[5, 9]])
      index.resize(4) // shrink invalidates pending corrections
      expect(index.takeCorrections()).toEqual([])

      dispose()
    })
  })

  it("holds reportMeasured calls for one batch and one extent bump at the frame flush", async () => {
    await createRoot(async (dispose) => {
      const index = createHeightIndex({ itemCount: 10, estimatedRows: 2 })
      const before = index.extentVersion()

      index.reportMeasured(1, 4)
      index.reportMeasured(2, 6)
      index.reportMeasured(1, 5) // last report per block wins within the flush
      await flushMicrotasks()
      // Size callbacks run between native hooks; only the frame hook applies them.
      expect(index.extentVersion()).toBe(before)

      index.flushMeasurements()

      expect(index.extentVersion()).toBe(before + 1)
      expect(index.totalRows()).toBe(2 * 10 + 3 + 4)
      expect(index.takeCorrections()).toEqual([{ blockIndex: 1, deltaRows: 3 }, { blockIndex: 2, deltaRows: 4 }])

      dispose()
    })
  })

  it("applies queued estimates in the measurement flush without marking blocks measured, and lets measurements win", () => {
    createRoot((dispose) => {
      const index = createHeightIndex({ itemCount: 10, estimatedRows: 2 })
      index.recordMeasuredBatch([[3, 7]])
      index.takeCorrections()
      const before = index.extentVersion()

      index.reportEstimated(1, 5)
      index.reportMeasured(2, 4)
      index.reportEstimated(2, 9) // a queued measurement of the block wins
      index.reportEstimated(3, 1) // a recorded measurement of the block wins
      expect(index.totalRows()).toBe(2 * 9 + 7)

      index.flushMeasurements()

      expect(index.extentVersion()).toBe(before + 1)
      expect(index.takeCorrections()).toEqual([{ blockIndex: 1, deltaRows: 3 }, { blockIndex: 2, deltaRows: 2 }])
      expect(index.hasMeasured(1)).toBe(false)
      expect(index.hasMeasured(2)).toBe(true)
      expect(index.totalRows()).toBe(2 * 7 + 5 + 4 + 7)
      dispose()
    })
  })

  it("coalesces a batch of measured updates into a single extent-changed bump", () => {
    createRoot((dispose) => {
      const index = createHeightIndex({ itemCount: 100, estimatedRows: 1 })
      const before = index.extentVersion()
      index.recordMeasuredBatch([[0, 3], [1, 4], [2, 5]])
      expect(index.extentVersion()).toBe(before + 1)
      expect(index.totalRows()).toBe(3 + 4 + 5 + 97)
      dispose()
    })
  })

  it("lets measurements win over estimates permanently", () => {
    createRoot((dispose) => {
      const index = createHeightIndex({ itemCount: 3, estimatedRows: 1, initialEstimates: [[1, 100]] })
      expect(index.totalRows()).toBe(102)

      index.recordMeasuredBatch([[1, 4]])
      expect(index.totalRows()).toBe(6)

      const measuredVersion = index.extentVersion()
      index.seedEstimatedBatch([[1, 100]])
      expect(index.totalRows()).toBe(6)
      expect(index.extentVersion()).toBe(measuredVersion)

      dispose()
    })
  })

  it("updates estimates only while a row is unmeasured", () => {
    createRoot((dispose) => {
      const index = createHeightIndex({ itemCount: 3, estimatedRows: 1 })

      index.seedEstimatedBatch([[1, 5]])
      expect(index.totalRows()).toBe(7)
      const firstVersion = index.extentVersion()

      index.seedEstimatedBatch([[1, 7]])
      expect(index.totalRows()).toBe(9)
      expect(index.extentVersion()).toBe(firstVersion + 1)

      index.recordMeasuredBatch([[1, 3]])
      expect(index.totalRows()).toBe(5)
      const measuredVersion = index.extentVersion()

      index.seedEstimatedBatch([[1, 9]])
      expect(index.totalRows()).toBe(5)
      expect(index.extentVersion()).toBe(measuredVersion)

      dispose()
    })
  })

  it("lets rendered-hidden blocks measure zero rows", () => {
    createRoot((dispose) => {
      const index = createHeightIndex({ itemCount: 4, estimatedRows: 2 })
      index.recordMeasuredBatch([[1, 0], [2, 0]])
      expect(index.totalRows()).toBe(4)
      expect(index.blockIndexToRowOffset(3)).toBe(2)
      expect(index.rowOffsetToBlockIndex(1)).toBe(0)
      expect(index.rowOffsetToBlockIndex(2)).toBe(3)
      dispose()
    })
  })

  it("preserves rendered-hidden zero rows when known extents rescale", () => {
    createRoot((dispose) => {
      const index = createHeightIndex({ itemCount: 2, estimatedRows: 2 })
      index.recordMeasuredBatch([[0, 0], [1, 4]])
      index.takeCorrections()

      index.rescaleKnown(2)

      expect(index.blockIndexToRowOffset(1)).toBe(0)
      expect(index.totalRows()).toBe(8)
      expect(index.takeCorrections()).toEqual([{ blockIndex: 1, deltaRows: 4 }])
      dispose()
    })
  })

  it("resolves offset lookups in O(log n) over a 100k-block index", () => {
    createRoot((dispose) => {
      const itemCount = 100_000
      const index = createHeightIndex({ itemCount, estimatedRows: 1 })
      index.rowOffsetToBlockIndex(73_421)
      // log2(100000) ~= 16.6; a binary search stays well under a linear scan.
      expect(index.lastSearchSteps()).toBeGreaterThan(0)
      expect(index.lastSearchSteps()).toBeLessThanOrEqual(40)
      dispose()
    })
  })

  it("rejects non-finite extents instead of poisoning the prefix sums", () => {
    createRoot((dispose) => {
      const index = createHeightIndex({ itemCount: 10, estimatedRows: 2 })
      // A between-layouts OpenTUI size report is NaN; one accepted NaN turns
      // every offset and total into NaN (the blank-loaded-session bug).
      expect(() => index.recordMeasuredBatch([[3, Number.NaN]])).toThrow(RangeError)
      expect(() => index.seedEstimatedBatch([[3, Number.POSITIVE_INFINITY]])).toThrow(RangeError)
      expect(index.totalRows()).toBe(20)
      expect(index.blockIndexToRowOffset(5)).toBe(10)
      dispose()
    })
  })
})
