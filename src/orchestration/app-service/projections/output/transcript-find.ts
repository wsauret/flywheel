import { createBoundedWorkerSpawner } from "../../../../infra/process/workers/bounded-worker-spawner.js"
import { embeddedEntrySpecifier, runsThroughBun } from "../../../../infra/cli-subprocess.js"
import { DebugLog } from "../../../../infra/diagnostics/debug-log.js"
import { isAgentInFlight, type AnyBlock } from "../../../../infra/output-blocks.js"
import { terminateWorker } from "../../../../infra/process/workers/worker-termination.js"
import { blockIdentity } from "../../../../protocol/block-identity.js"
import { compileFind, TRANSCRIPT_FIND_LIMIT } from "../../../../protocol/transcript-find.js"
import type { TranscriptFindMatch, TranscriptFindRequest, TranscriptFindResult } from "../../../../protocol/transcript-protocol-types.js"
import type { IndexedBlockReader } from "../../../session/conversation/transcript/branch-history-builder.js"

/** Blocks read together: the cold rows of one chunk share one batched read. */
const READ_CHUNK = 64
/** A pattern that matches for longer than this ends its scan. It stays below
 *  the client's deadline for transcript reads, so the client reads why. */
const FIND_BUDGET_MS = 10_000
/** Finds that count at once in this process. Each one can hold its own
 *  thread for the whole budget, so a find past this bound fails at once: a
 *  queue would hold it behind slow patterns past the client's deadline. */
const MAX_LIVE_FINDS = 4
let liveFinds = 0

/** The texts of one scan and the pattern to count in each, as the find
 *  thread receives them. */
export interface FindJob {
  readonly pattern: string
  readonly regex: boolean
  readonly matchCase: boolean
  readonly texts: readonly string[]
}

/** The number of matches in each text, in order. The list stops at the text
 *  whose matches take the total past `TRANSCRIPT_FIND_LIMIT`. */
type FindCounts = readonly number[]

export type FindAnswer = { readonly kind: "done"; readonly counts: FindCounts } | { readonly kind: "failed"; readonly message: string }

/** Finds a text or a pattern in a session's whole transcript from
 *  `fromBlockIndex` on, block by block in document order, from the complete
 *  blocks the executor holds: a client window holds a bounded page of them and
 *  wire-truncated bodies. A person's pattern can backtrack without end, so the
 *  matching runs on its own thread, never on the executor's event loop, and
 *  ends after a time budget. The result names the first block that can still
 *  change, so a client that follows live output asks again only from there. */
export async function findInTranscript(sequence: IndexedBlockReader, request: TranscriptFindRequest, countMatches: (job: FindJob) => Promise<FindCounts> = countOnWorker): Promise<TranscriptFindResult> {
  if (compileFind(request).kind !== "ready") throw new Error("The find pattern is not a valid regular expression")
  if (liveFinds >= MAX_LIVE_FINDS) throw new Error("Too many finds are running. Try again in a moment.")
  liveFinds += 1
  try {
    return await findFrom(sequence, request, countMatches)
  } finally {
    liveFinds -= 1
  }
}

async function findFrom(sequence: IndexedBlockReader, request: TranscriptFindRequest, countMatches: (job: FindJob) => Promise<FindCounts>): Promise<TranscriptFindResult> {
  const blockCount = sequence.blockCount
  const from = Math.min(request.fromBlockIndex, blockCount)
  // A tool row stays memoized in the resident transcript projection, as it
  // does when a client scrolls to it, until the resident cache evicts the
  // session. Each new pattern scans the whole transcript again, and the memo
  // spares that scan a read of every row from the store.
  const blocks: AnyBlock[] = []
  for (let start = from; start < blockCount; start += READ_CHUNK) {
    const indices = Array.from({ length: Math.min(READ_CHUNK, blockCount - start) }, (_, offset) => start + offset)
    blocks.push(...await Promise.all(indices.map((index) => sequence.readBlock(index))))
  }
  const counts = await countMatches({ pattern: request.pattern, regex: request.regex, matchCase: request.matchCase, texts: blocks.map((block) => searchableText(block, request.includeThinking)) })
  const matches: TranscriptFindMatch[] = []
  for (const [offset, count] of counts.entries()) {
    const block = blocks[offset]
    if (block === undefined) break
    const blockId = blockIdentity(block)
    for (let occurrence = 0; occurrence < count; occurrence += 1) matches.push({ blockId, blockIndex: from + offset, occurrence })
  }
  const more = matches.length > TRANSCRIPT_FIND_LIMIT
  // A scan that stopped at the limit counted no block past the last one.
  const counted = more ? counts.length : blocks.length
  const unsettled = blocks.slice(0, counted).findIndex((block) => !isSettled(block))
  const openFromBlockIndex = unsettled >= 0 ? from + unsettled : Math.max(from, from + counted - 1)
  return { matches: matches.slice(0, TRANSCRIPT_FIND_LIMIT), more, openFromBlockIndex, blockCount }
}

/** Counts the matches of each text of `job`: the work of the find thread. */
export function countFindMatches(job: FindJob): FindCounts {
  const compiled = compileFind(job)
  if (compiled.kind !== "ready") throw new Error("The find pattern is not a valid regular expression")
  const counts: number[] = []
  let total = 0
  for (const text of job.texts) {
    const count = text === "" ? 0 : compiled.matcher(text, TRANSCRIPT_FIND_LIMIT + 1 - total).length
    counts.push(count)
    total += count
    if (total > TRANSCRIPT_FIND_LIMIT) break
  }
  return counts
}

/** Runs one job on its own Worker and ends the Worker once the job answers,
 *  fails, or runs past the budget. */
async function countOnWorker(job: FindJob): Promise<FindCounts> {
  // The generation budget applies per scan: each scan owns one Worker.
  const spawn = createBoundedWorkerSpawner("transcript-find")
  const specifier = runsThroughBun(process.execPath)
    ? new URL("transcript-find-worker.ts", import.meta.url).href
    : embeddedEntrySpecifier(import.meta.dir, "transcript-find-worker.js")
  const worker = spawn(specifier, { name: "flywheel-transcript-find", smol: true })
  DebugLog.record({ type: "runtime.worker.allocated", payload: { kind: "transcript-find" } })
  const answered = Promise.withResolvers<FindAnswer>()
  const budget = setTimeout(() => answered.resolve({ kind: "failed", message: "The find pattern took too long to match. Try a simpler pattern." }), FIND_BUDGET_MS)
  worker.addEventListener("message", (event: MessageEvent<FindAnswer>) => answered.resolve(event.data))
  worker.addEventListener("error", (event) => answered.resolve({ kind: "failed", message: `The find Worker failed: ${event.message || "it reported no cause"}` }))
  worker.addEventListener("close", () => answered.resolve({ kind: "failed", message: "The find Worker ended before it answered" }), { once: true })
  try {
    worker.postMessage(job, [])
    const answer = await answered.promise
    if (answer.kind === "failed") throw new Error(answer.message)
    return answer.counts
  } finally {
    clearTimeout(budget)
    await terminateWorker(worker)
  }
}

/** Whether a block can no longer change. A text block has no state of its
 *  own, so only the last block of a transcript counts as one that can grow. */
function isSettled(block: AnyBlock): boolean {
  switch (block.kind) {
    case "tool": return block.status !== "pending" && block.status !== "streaming" && block.status !== "blocked"
    case "thinking": return block.status === "completed"
    case "agentGroup": return !isAgentInFlight(block.status)
    case "userMessage": return !block.pending
    case "question": return block.answers !== undefined || block.cancelled === true
    default: return true
  }
}

/** The words a reader sees in one block, one field per line so that no match
 *  spans two fields. A queued message is not sent yet, and the operations of
 *  an agent card belong to the agent's own transcript. */
function searchableText(block: AnyBlock, includeThinking: boolean): string {
  switch (block.kind) {
    case "text": return block.content
    case "thinking": return includeThinking ? block.content : ""
    case "userMessage": return block.pending ? "" : joinFields([block.content, block.from?.personWords])
    case "tool": return joinFields([block.presentation.name, block.presentation.detail, block.invocationBody?.content, block.content, block.diff])
    case "agentGroup": return joinFields([block.label, block.description])
    case "question": return joinFields(block.questions.flatMap((entry) => [entry.header, entry.question, ...entry.choices.map((choice) => choice.label)]).concat(Object.values(block.answers ?? {})))
    case "system": return block.message
    case "divider": return block.label
    case "degraded": return block.notice
  }
}

function joinFields(fields: readonly (string | undefined)[]): string {
  return fields.filter((field): field is string => field !== undefined && field !== "").join("\n")
}
