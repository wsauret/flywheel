import { batch, createSignal } from "solid-js"

// Variable-height virtualization uses a Fenwick tree for prefix sums. Transcript
// rows are contiguous, and OpenTUI spacer rows represent unmounted content.
// Growth appends in place, shrink rebuilds, and surviving measurements persist.

/**
 * FenwickTree (Binary Indexed Tree) — prefix sums in O(log n). Stores per-block
 * extent *deltas* (known rows - base estimate) so the index answers "row offset
 * of block i" and "block at row offset y" fast.
 */
class FenwickTree {
  private readonly values: number[]
  private readonly tree: number[]

  constructor(size: number) {
    if (!Number.isInteger(size) || size < 0) throw new RangeError("FenwickTree size must be a non-negative integer")
    this.values = Array.from({ length: size }, () => 0)
    this.tree = Array.from({ length: size + 1 }, () => 0)
  }

  get size(): number {
    return this.values.length
  }

  set(i: number, v: number): void {
    this.assertIndex(i)
    this.add(i, v - (this.values[i] ?? 0))
  }

  add(i: number, delta: number): void {
    this.assertIndex(i)
    if (delta === 0) return
    this.values[i] = (this.values[i] ?? 0) + delta
    for (let n = i + 1; n < this.tree.length; n += n & -n) this.tree[n] = (this.tree[n] ?? 0) + delta
  }

  append(v = 0): void {
    this.values.push(v)
    this.tree.push(0)
    const n = this.size
    const lsb = n & -n
    let s = 0
    for (let j = n - lsb; j < n; j += 1) s += this.values[j] ?? 0
    this.tree[n] = s
  }

  sumPrefix(count: number): number {
    let n = Math.max(0, Math.min(Math.floor(count), this.size))
    let s = 0
    while (n > 0) {
      s += this.tree[n] ?? 0
      n -= n & -n
    }
    return s
  }

  sumRange(from: number, to: number): number {
    return to <= from ? 0 : this.sumPrefix(to) - this.sumPrefix(from)
  }

  private assertIndex(i: number): void {
    if (!Number.isInteger(i) || i < 0 || i >= this.size) throw new RangeError(`FenwickTree index ${i} is outside 0..${this.size - 1}`)
  }
}

/**
 * ItemExtentIndex — variable-height virtualization math. Every block starts at
 * `estimatedRows`. Local TUI estimates can refine unknown blocks, and layout
 * measurements become authoritative once a row is mounted. blockIndexToRowOffset
 * / rowOffsetToBlockIndex then mix base estimates + known deltas to map between
 * scroll offset and block index.
 */
class ItemExtentIndex {
  private itemCount: number
  private estimatedRows: number
  private rows = new Map<number, number>()
  private measured = new Set<number>()
  private deltas: FenwickTree
  /** Comparison count of the most recent rowOffsetToBlockIndex search (diagnostic). */
  searchSteps = 0

  constructor(itemCount: number, estimatedRows: number) {
    this.itemCount = itemCount
    this.estimatedRows = Math.max(1, estimatedRows)
    this.deltas = new FenwickTree(itemCount)
  }

  get count(): number {
    return this.itemCount
  }

  // Tail-stable extent updates: tail
  // growth appends O(log n) per new block and keeps every measurement; a shrink
  // (live reset/truncate) drops out-of-range rows and rebuilds. Measured heights
  // are invalidated by content changes, never by list growth.
  resize(itemCount: number): void {
    if (!Number.isInteger(itemCount) || itemCount < 0) throw new RangeError(`ItemExtentIndex itemCount ${itemCount} must be a non-negative integer`)
    if (itemCount === this.itemCount) return
    if (itemCount > this.itemCount) {
      for (let i = this.itemCount; i < itemCount; i += 1) this.deltas.append()
      this.itemCount = itemCount
      return
    }
    for (const k of this.rows.keys()) if (k >= itemCount) this.rows.delete(k)
    for (const k of this.measured) if (k >= itemCount) this.measured.delete(k)
    this.itemCount = itemCount
    this.rebuild()
  }

  /** Returns the row delta vs the block's prior effective extent, or undefined
   *  when the record was a no-op (out of range, measured-wins, or unchanged). */
  recordEstimated(index: number, rows: number): number | undefined {
    // A non-finite extent poisons every Fenwick prefix sum at once (all spacer
    // and offset math turns NaN); reject it at the write so the producer fails
    // loudly instead of the transcript silently rendering blank.
    if (!Number.isFinite(rows)) throw new RangeError(`ItemExtentIndex rows ${rows} for block ${index} must be finite`)
    const h = Math.max(0, rows)
    if (index < 0 || index >= this.itemCount || this.measured.has(index) || this.rows.get(index) === h) return undefined
    const prior = this.rows.get(index) ?? this.estimatedRows
    this.rows.set(index, h)
    this.deltas.set(index, h - this.estimatedRows)
    return h - prior
  }

  recordMeasured(index: number, rows: number): number | undefined {
    // Same finiteness invariant as recordEstimated: measurements come from
    // layout, and a between-layouts NaN must be dropped by the reporter.
    if (!Number.isFinite(rows)) throw new RangeError(`ItemExtentIndex rows ${rows} for block ${index} must be finite`)
    const h = Math.max(0, rows)
    if (index < 0 || index >= this.itemCount) return undefined
    const alreadyMeasured = this.measured.has(index)
    if (alreadyMeasured && this.rows.get(index) === h) return undefined
    const prior = this.rows.get(index) ?? this.estimatedRows
    this.measured.add(index)
    this.rows.set(index, h)
    this.deltas.set(index, h - this.estimatedRows)
    return h - prior
  }

  hasMeasured(index: number): boolean {
    return this.measured.has(index)
  }

  /** Demote every measured height to an estimate: the rows stay (no visual
   *  jump), but re-mounted rows can re-measure and estimate seeds can refine
   *  unmounted ones. Used when a global render config changes what rows
   *  contain (thinking/tool visibility) without discarding the extent map. */
  demoteAllToEstimates(): void {
    this.measured.clear()
  }

  /** Scale every known extent by `ratio` (old width / new width): wrapped text
   *  rows are inversely proportional to columns, so a resize keeps the spacer
   *  math roughly right until rows re-measure. */
  rescaleKnown(ratio: number): ExtentCorrection[] {
    if (!Number.isFinite(ratio) || ratio <= 0 || ratio === 1) return []
    const corrections: ExtentCorrection[] = []
    for (const [index, rows] of this.rows) {
      const next = rows === 0 ? 0 : Math.max(1, Math.round(rows * ratio))
      if (next === rows) continue
      this.rows.set(index, next)
      this.deltas.set(index, next - this.estimatedRows)
      corrections.push({ blockIndex: index, deltaRows: next - rows })
    }
    return corrections
  }

  totalRows(): number {
    return this.extentsHeight(0, this.itemCount)
  }

  // Row offset of the top of block `index`.
  offsetForIndex(index: number): number {
    const i = Math.max(0, Math.min(index, this.itemCount))
    return i === 0 ? 0 : this.extentsHeight(0, i)
  }

  // Binary-search the block whose rows span offset `y`.
  findIndexAtOffset(y: number): number {
    this.searchSteps = 0
    if (this.itemCount <= 1) return 0
    const target = Math.max(0, y)
    let lo = 0
    let hi = this.itemCount - 1
    let found = this.itemCount - 1
    while (lo <= hi) {
      this.searchSteps += 1
      const mid = Math.floor((lo + hi) / 2)
      // Rows are contiguous, so an offset exactly on a boundary belongs to the
      // next block; the comparison must be strict.
      if (target < this.endOffset(mid)) {
        found = mid
        hi = mid - 1
        continue
      }
      lo = mid + 1
    }
    return found
  }

  private extentsHeight(from: number, to: number): number {
    const a = Math.max(0, Math.min(from, this.itemCount))
    const b = Math.max(a, Math.min(to, this.itemCount))
    const span = b - a
    if (span <= 0) return 0
    return span * this.estimatedRows + this.deltas.sumRange(a, b)
  }

  private endOffset(index: number): number {
    const i = Math.max(0, Math.min(index, this.itemCount - 1))
    return this.extentsHeight(0, i + 1)
  }

  private rebuild(): void {
    this.deltas = new FenwickTree(this.itemCount)
    for (const [i, h] of this.rows) {
      if (i < 0 || i >= this.itemCount) continue
      this.deltas.set(i, h - this.estimatedRows)
    }
  }
}

export interface HeightIndexConfig {
  readonly itemCount: number
  readonly estimatedRows: number
  readonly initialEstimates?: readonly (readonly [number, number])[]
}

/** One applied extent refinement: block `blockIndex` now occupies `deltaRows`
 *  more (or fewer, negative) rows than the index previously believed. */
export interface ExtentCorrection {
  readonly blockIndex: number
  readonly deltaRows: number
}

/**
 * The imperative prefix-sum height index that drives OutputWindow's spacer
 * sizes. It lives outside the Solid graph; `extentVersion` is the only reactive
 * surface and advances once per coalesced refinement batch. The index is
 * generation-long: tail growth and width changes preserve measured extents,
 * while mounted rows correct stale measurements through onSizeChange.
 */
export interface HeightIndex {
  blockIndexToRowOffset(index: number): number
  rowOffsetToBlockIndex(offset: number): number
  totalRows(): number
  /** Seed estimated heights, coalescing them into one extent bump. Estimates
   *  refine unknown blocks only; once a block has a real layout measurement,
   *  estimates can never overwrite it. */
  seedEstimatedBatch(entries: readonly (readonly [number, number])[]): void
  /** Record a batch of measured heights, coalescing them into one extent bump. */
  recordMeasuredBatch(entries: readonly (readonly [number, number])[]): void
  /** Queue one layout measurement until the next flushMeasurements, which
   *  applies every queued report as one batch with a single extent bump. */
  reportMeasured(index: number, rows: number): void
  /** Queue the laid-out height of a row whose content still holds its final
   *  height. The same flush records it as an estimate: native layout already
   *  holds these rows, so the index follows them without marking the block
   *  measured. A measurement of the block, queued or recorded, wins. */
  reportEstimated(index: number, rows: number): void
  /** True once the block has a real layout measurement. Drives the mount-once
   *  latch: virtualization begins only after every mounted row is measured. */
  hasMeasured(index: number): boolean
  /** Apply queued reportMeasured and reportEstimated entries. The scroll controller calls it
   *  after the rows of a frame's first layout reported, and in its next frame
   *  decision for the reports that later layout rounds queued. Measurement
   *  demotion flushes mounted rows immediately, before estimates can reseed.
   *  Flushing after each callback instead would rerun the reactive geometry
   *  once per reporting row in the middle of the frame. */
  flushMeasurements(): void
  /** Demote all measured heights to estimates, keeping their values. The
   * caller must restore mounted measurements before reseeding estimates. */
  demoteAllToEstimates(): void
  /** Scale all known extents by oldCols/newCols on a terminal resize; the
   *  resulting corrections flow through takeCorrections like any other. */
  rescaleKnown(ratio: number): void
  /** Grow (tail append) or shrink (live reset/truncate) to the generation's block
   *  count, preserving measured heights. Called synchronously from the index memo
   *  as part of the snapshot change that carries the new count, so it makes no
   *  reactive writes of its own — every geometry consumer already re-evaluates. */
  resize(itemCount: number): void
  /** Drain nonzero extent changes since the last take. Each take follows an
   *  extentVersion bump, making the correction effect the single reader that
   *  turns these deltas into scroll compensation. */
  takeCorrections(): readonly ExtentCorrection[]
  extentVersion(): number
  /** Comparison count of the most recent offset lookup (perf diagnostic). */
  lastSearchSteps(): number
}

export function createHeightIndex(config: HeightIndexConfig): HeightIndex {
  const model = new ItemExtentIndex(config.itemCount, config.estimatedRows)
  for (const [index, rows] of config.initialEstimates ?? []) model.recordEstimated(index, rows)
  const [extentVersion, setExtentVersion] = createSignal(0)
  const bump = () => setExtentVersion((v) => v + 1)
  let pendingCorrections: ExtentCorrection[] = []

  function apply<T>(entries: readonly (readonly [number, T])[], record: (index: number, value: T) => number | undefined): void {
    batch(() => {
      let changed = false
      for (const [index, value] of entries) {
        const delta = record(index, value)
        if (delta === undefined) continue
        changed = true
        if (delta !== 0) pendingCorrections.push({ blockIndex: index, deltaRows: delta })
      }
      if (changed) bump()
    })
  }

  const pendingReports = new Map<number, { readonly rows: number; readonly measured: boolean }>()
  function flushMeasurements(): void {
    if (pendingReports.size === 0) return
    const entries = [...pendingReports.entries()]
    pendingReports.clear()
    apply(entries, (index, { rows, measured }) => measured ? model.recordMeasured(index, rows) : model.recordEstimated(index, rows))
  }

  return {
    blockIndexToRowOffset: (index) => model.offsetForIndex(index),
    rowOffsetToBlockIndex: (offset) => model.findIndexAtOffset(offset),
    totalRows: () => model.totalRows(),
    seedEstimatedBatch: (entries) => apply(entries, (index, rows) => model.recordEstimated(index, rows)),
    recordMeasuredBatch: (entries) => apply(entries, (index, rows) => model.recordMeasured(index, rows)),
    reportMeasured: (index, rows) => { pendingReports.set(index, { rows, measured: true }) },
    reportEstimated: (index, rows) => {
      if (pendingReports.get(index)?.measured !== true) pendingReports.set(index, { rows, measured: false })
    },
    hasMeasured: (index) => model.hasMeasured(index),
    flushMeasurements,
    demoteAllToEstimates: () => model.demoteAllToEstimates(),
    rescaleKnown: (ratio) => {
      const corrections = model.rescaleKnown(ratio)
      if (corrections.length === 0) return
      batch(() => {
        pendingCorrections.push(...corrections)
        bump()
      })
    },
    resize: (itemCount) => {
      // A shrink (live reset/truncate) invalidates the geometry the pending
      // corrections were measured against; compensating from them would drift.
      if (itemCount < model.count) pendingCorrections = []
      model.resize(itemCount)
    },
    takeCorrections: () => {
      if (pendingCorrections.length === 0) return pendingCorrections
      const taken = pendingCorrections
      pendingCorrections = []
      return taken
    },
    extentVersion,
    lastSearchSteps: () => model.searchSteps,
  }
}
