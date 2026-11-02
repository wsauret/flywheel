import type { OutputRangeAnchor } from "../../protocol/transcript-protocol-types.js"

interface ProjectRangeBudgetOptions<Raw, Projected> {
  readonly records: readonly Raw[]
  readonly maxBytes: number
  readonly fromTail: boolean
  /** Records the window keeps whatever they cost, so an anchor window is never
   *  returned half-empty. */
  readonly minRecords: number
  readonly project: (record: Raw) => Projected | Promise<Projected>
  readonly measure: (record: Projected) => number
}

/** The first read-ahead batch of a range. Later batches double up to one
 *  state page of rows. */
const FIRST_BATCH = 16
const MAX_BATCH = 256

/** The projected records of one range that fit its byte budget, spent in
 *  range order. Records are projected together in batches that double in
 *  size, so a range whose rows read durable state costs a few batched state
 *  reads, not one round trip for each row. The budget stops the walk at the
 *  batch that crosses it, so at most that one batch is projected and not
 *  kept: never more than the records the range kept, plus the first batch. */
export async function projectRecordsWithinRangeBudget<Raw, Projected>(options: ProjectRangeBudgetOptions<Raw, Projected>): Promise<Projected[]> {
  const { maxBytes, fromTail, project, measure } = options
  const records = fromTail ? options.records.toReversed() : options.records
  const minimum = Math.min(records.length, Math.max(1, options.minRecords))
  const selected: Projected[] = []
  const inRangeOrder = () => fromTail ? selected.toReversed() : selected
  let bytes = 0
  let size = FIRST_BATCH
  for (let start = 0; start < records.length; start += size, size = Math.min(size * 2, MAX_BATCH)) {
    for (const projected of await Promise.all(records.slice(start, start + size).map((record) => project(record)))) {
      const recordBytes = measure(projected)
      if (selected.length >= minimum && bytes + recordBytes > maxBytes) return inRangeOrder()
      selected.push(projected)
      bytes += recordBytes
    }
  }
  return inRangeOrder()
}

export function trimOutputRangeFromTail(anchor: OutputRangeAnchor): boolean {
  return anchor.kind === "tail" || anchor.kind === "beforeBlock"
}

export function minOutputRangeRecords(anchor: OutputRangeAnchor, recordCount: number): number {
  return recordCount > 1 && (anchor.kind === "beforeBlock" || anchor.kind === "afterBlock") ? 2 : 1
}
