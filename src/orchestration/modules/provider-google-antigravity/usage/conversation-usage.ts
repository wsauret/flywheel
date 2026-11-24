import { Database } from "bun:sqlite"
import { Log } from "../../../../infra/log.js"
import { coalesceRepeats } from "../../../../infra/repeat-coalescer.js"
import type { AcpUsage } from "../acp/schema.js"

// agy records each model request of an engine session as one protobuf row of the table `gen_metadata(idx, data)` in
// the session's conversation database (SQLite in WAL mode). `idx` counts the session's model requests from 0, and
// every row keeps its usage. The field numbers below are agy 1.5.14's: a live probe read the rows of 12 model
// requests after each prompt and matched them with agy's ACP reports. The uncached input, the cached reads, and the
// output summed over a prompt's rows equal the prompt's ACP aggregate, and each row's three together equal the
// occupancy (`usage_update.used`) that agy reported for its request. agy writes a request's row before its call
// reaches Flywheel's MCP server. A bump of agy must re-qualify this mapping: the live tier asserts complete usage
// with cached reads on every request of a task (tests/integration/providers/antigravity-subscription-real.test.ts).

const log = Log.create({ service: "provider-google-antigravity" })

/** Field 1 of a row: the request's generation metadata (field 4 of the row is the execution id). */
const ROW_METADATA = 1
/** Field 4 of the metadata: the request's usage (field 17.2 mirrors it). */
const METADATA_USAGE = 4
/** The counts of the usage. `output` includes the thoughts; field 10 is the output without them. agy records no
 *  cache write, so a request writes none. Proto3 leaves a count of zero out. */
const USAGE_FIELDS = { input: 2, output: 3, cacheRead: 5, thoughts: 9 } as const

/** How long repeats of one fallback count before their count is recorded. */
const REPEAT_WINDOW_MS = 60_000

/** The complete usage of one or more model requests. `outputTokens` includes `reasoningTokens`. */
export interface RowUsage {
  readonly inputTokens: number
  readonly cacheReadTokens: number
  readonly outputTokens: number
  readonly reasoningTokens: number
}

/** The rows of a conversation after a position. `lastIdx` is the newest row read, or the position when there is none;
 *  a row that did not decode still moves it, because the row's request is spent. */
export type ConversationRead =
  | { readonly kind: "rows"; readonly rows: readonly RowUsage[]; readonly lastIdx: number }
  | { readonly kind: "unreadable"; readonly reason: "no-database" | "undecodable-row"; readonly lastIdx: number }

/** The fields of one protobuf message, the last of each number: a varint as its number, a length-delimited field as
 *  its bytes. Fixed-width fields are skipped. Undefined when the bytes are not one message. */
function messageFields(bytes: Uint8Array): Map<number, number | Uint8Array> | undefined {
  const fields = new Map<number, number | Uint8Array>()
  let at = 0
  const varint = (): number | undefined => {
    let value = 0
    for (let shift = 0; shift < 64 && at < bytes.length; shift += 7) {
      const byte = bytes[at++] ?? 0
      value += (byte & 0x7f) * 2 ** shift
      if (byte < 0x80) return value
    }
    return undefined
  }
  while (at < bytes.length) {
    const key = varint()
    if (key === undefined) return undefined
    const number = Math.floor(key / 8)
    const wireType = key % 8
    if (number === 0) return undefined
    if (wireType === 0) {
      const value = varint()
      if (value === undefined) return undefined
      fields.set(number, value)
    } else if (wireType === 2) {
      const length = varint()
      if (length === undefined || at + length > bytes.length) return undefined
      fields.set(number, bytes.subarray(at, at + length))
      at += length
    } else if (wireType === 1 || wireType === 5) {
      at += wireType === 1 ? 8 : 4
      if (at > bytes.length) return undefined
    } else {
      return undefined
    }
  }
  return fields
}

/** The usage of one row, or undefined when it does not hold one. The input count is required: every model request
 *  sends input. */
function rowUsage(data: Uint8Array): RowUsage | undefined {
  const metadata = messageFields(data)?.get(ROW_METADATA)
  const usage = metadata instanceof Uint8Array ? messageFields(metadata)?.get(METADATA_USAGE) : undefined
  const counts = usage instanceof Uint8Array ? messageFields(usage) : undefined
  if (counts === undefined || typeof counts.get(USAGE_FIELDS.input) !== "number") return undefined
  const count = (number: number): number | undefined => {
    const value = counts.get(number) ?? 0
    return typeof value === "number" ? value : undefined
  }
  const [inputTokens, cacheReadTokens, outputTokens, reasoningTokens] = [count(USAGE_FIELDS.input), count(USAGE_FIELDS.cacheRead), count(USAGE_FIELDS.output), count(USAGE_FIELDS.thoughts)]
  if (inputTokens === undefined || cacheReadTokens === undefined || outputTokens === undefined || reasoningTokens === undefined) return undefined
  return { inputTokens, cacheReadTokens, outputTokens, reasoningTokens }
}

/** Reads the rows after `afterIdx` of the conversation database at `path`. The database is opened read-only, so the
 *  read never writes to agy's file, and it sees what agy wrote to its WAL. */
export function readConversationRows(path: string, afterIdx: number): ConversationRead {
  let records: { readonly idx: number; readonly data: Uint8Array }[]
  try {
    const db = new Database(path, { readonly: true })
    try {
      records = db.query<{ idx: number; data: Uint8Array }, [number]>("SELECT idx, data FROM gen_metadata WHERE idx > ? ORDER BY idx").all(afterIdx)
    } finally {
      db.close()
    }
  } catch {
    return { kind: "unreadable", reason: "no-database", lastIdx: afterIdx }
  }
  const lastIdx = records.at(-1)?.idx ?? afterIdx
  const rows: RowUsage[] = []
  for (const record of records) {
    const usage = rowUsage(record.data)
    if (usage === undefined) return { kind: "unreadable", reason: "undecodable-row", lastIdx }
    rows.push(usage)
  }
  return { kind: "rows", rows, lastIdx }
}

const ZERO: RowUsage = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0, reasoningTokens: 0 }

function add(sum: RowUsage, row: RowUsage): RowUsage {
  return {
    inputTokens: sum.inputTokens + row.inputTokens,
    cacheReadTokens: sum.cacheReadTokens + row.cacheReadTokens,
    outputTokens: sum.outputTokens + row.outputTokens,
    reasoningTokens: sum.reasoningTokens + row.reasoningTokens,
  }
}

const total = (usage: RowUsage): number => usage.inputTokens + usage.cacheReadTokens + usage.outputTokens

/** Why the rows of a request did not state its usage, or the rows of a prompt differ from its aggregate, with the
 *  numbers that show it. */
type UsageWarning =
  | { readonly reason: "no-database" | "undecodable-row" }
  | { readonly reason: "no-row"; readonly used: number }
  | { readonly reason: "occupancy-differs"; readonly used: number; readonly rowTotal: number; readonly rows: number }
  | {
    readonly reason: "aggregate-differs"
    readonly rowInput: number; readonly rowCacheRead: number; readonly rowOutput: number
    readonly input: number; readonly cacheRead: number; readonly cacheWrite: number; readonly output: number
  }

/** The model-request usage of one engine session, which the bridge reads as each of the session's requests settles. */
export interface UsageLedger {
  /** Starts the sums of a new prompt of the session. */
  startPrompt(): void
  /**
   * The complete usage of the model requests that ran for the request that settles now: the rows after those of the
   * session's last settled request. `used` is the last occupancy that agy reported for the request
   * (`usage_update.used`), or 0 when it reported none. Undefined when the rows cannot state the usage exactly: the
   * database or a row cannot be read, there is no row, or the newest row's total is not `used`. Each such case
   * records one warning, and its repeats on the session are counted.
   */
  settle(used: number): RowUsage | undefined
  /** Compares the rows of the prompt that ended with agy's aggregate for it, and records a warning when they
   *  differ. The rows stay the usage. A prompt with a request whose rows could not be read is not compared. */
  endPrompt(aggregate: AcpUsage): void
  /** Records the counts of repeated warnings. Call it when the session retires. */
  close(): void
}

/** The ledger of the engine session `sessionId` of the process `processId`, which reads its rows through `read`. */
export function createUsageLedger(options: { readonly processId: string; readonly sessionId: string; readonly read: (afterIdx: number) => ConversationRead }): UsageLedger {
  const ids = { processId: options.processId, sessionId: options.sessionId }
  let lastIdx = -1
  /** The rows of the open prompt, or undefined once a read of it failed. */
  let prompt: RowUsage | undefined = ZERO
  const warnings = coalesceRepeats<UsageWarning>({
    windowMs: REPEAT_WINDOW_MS,
    first: (_reason, warning) => {
      log.warn(warning.reason === "aggregate-differs" ? "Google Antigravity prompt usage differs from the usage of its model requests" : "Google Antigravity request usage not read from its model requests", { ...ids, ...warning })
    },
    repeated: (reason, repeats) => {
      log.warn("Google Antigravity request usage warning repeated", { ...ids, reason, count: repeats.count, windowMs: repeats.windowMs })
    },
  })
  const warn = (warning: UsageWarning): void => { warnings.observe(warning.reason, warning) }
  const fallback = (warning: UsageWarning): undefined => {
    warn(warning)
    return undefined
  }
  return {
    startPrompt() {
      prompt = ZERO
    },
    settle(used) {
      const read = options.read(lastIdx)
      lastIdx = read.lastIdx
      if (read.kind === "unreadable") {
        prompt = undefined
        return fallback({ reason: read.reason })
      }
      const usage = read.rows.reduce(add, ZERO)
      if (prompt !== undefined) prompt = add(prompt, usage)
      const newest = read.rows.at(-1)
      if (newest === undefined) return fallback({ reason: "no-row", used })
      if (used > 0 && total(newest) !== used) return fallback({ reason: "occupancy-differs", used, rowTotal: total(newest), rows: read.rows.length })
      return usage
    },
    endPrompt(aggregate) {
      if (prompt === undefined) return
      if (prompt.inputTokens === aggregate.inputTokens && prompt.cacheReadTokens === aggregate.cachedReadTokens && prompt.outputTokens === aggregate.outputTokens && aggregate.cachedWriteTokens === 0) return
      warn({
        reason: "aggregate-differs", rowInput: prompt.inputTokens, rowCacheRead: prompt.cacheReadTokens, rowOutput: prompt.outputTokens,
        input: aggregate.inputTokens, cacheRead: aggregate.cachedReadTokens, cacheWrite: aggregate.cachedWriteTokens, output: aggregate.outputTokens,
      })
    },
    close() {
      warnings.end()
    },
  }
}
