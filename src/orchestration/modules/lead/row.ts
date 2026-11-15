import { createEventProjection, parseProjectionFact, type PositionedEventProjection } from "../../../infra/event-projection.js"
import type { AsyncEventReadSurface, StoredFact } from "../../../infra/event-store-types.js"
import { heldProjection } from "../../../infra/projection-registry.js"
import { askUserLeadingContext } from "../../../infra/tools/displays/ask-user.js"
import { getToolDisplay, isHiddenFromTranscript } from "../../../infra/tools/tool-display-registry.js"
import type { StoredTailEntry } from "../../session/chat-session-run-evidence.js"
import { parseConversationTreeFact } from "../../session/conversation/conversation-facts.js"
import { isPersonEntry } from "../../session/conversation/person-entries.js"
import { chatTurnEndOf, isProducedInput, restoredWaitReadsOlder, turnEndOfEntry, type ChatTurnEnd, type TurnEndEntry } from "../../session/conversation/turn-end-record.js"
import { WAIT_EXPIRED_TAG } from "../../agent-runtime/agent-loop-wait.js"
import { CONTINUATION_MESSAGES } from "../../agent-runtime/continuation-messages.js"

/** The entries that the fold keeps for the turn-end reading, after it compacts each long run of entries that the
 *  turn-end walks read past (`compactRuns`). A turn needs older entries only while it waits on background work from a
 *  wait call further back; then the fold carries the earlier reading's background wait (`restoredWaitReadsOlder`). */
export const ROW_TAIL_ENTRIES = 64
/** The newest entries of a run that compaction keeps in place, so the entry before each stopper stays the same. */
const RUN_NEWEST = 4
/** Strings in a kept entry are cut to this length: the turn-end readers compare only short ids, flags, and the
 *  prefixes of runtime messages, and a kept tool input can otherwise hold a whole file. */
const KEPT_TEXT = 256

/** A conversation entry in the reduced form that the turn-end readers read, with the time of its batch. */
type RowTailEntry = TurnEndEntry & { readonly at: number }

/** A text of the chat with its entry and the time of its batch. */
interface Said {
  readonly entryId: string
  readonly text: string
  readonly at: number
}

/** The chat's newest output, with the time of its batch: a tool call that its transcript shows, with the call's kept
 *  input, or the first line of a text. */
type RowLatest = (
  | { readonly kind: "call"; readonly name: string; readonly input: { readonly [key: string]: unknown } }
  | { readonly kind: "text"; readonly text: string }
) & { readonly at: number }

/** What one started chat's conversation states for its row, advanced batch by batch. */
export interface RowFold {
  /** The newest entries, oldest first, at most `ROW_TAIL_ENTRIES`. */
  readonly tail: readonly RowTailEntry[]
  /** Whether older entries left the tail. */
  readonly truncated: boolean
  /** How the last turn ended (`chatTurnEndOf` over the tail), with the entry of its record and the time it was read. */
  readonly turnEnd: { readonly reading: ChatTurnEnd; readonly recordId: string | null; readonly at: number } | undefined
  /** The newest output of the chat's assistant messages, null before the first. */
  readonly latest: RowLatest | null
  /** The person's newest message: its first text block. */
  readonly request: Said | null
  /** The newest assistant message that holds no tool call. */
  readonly final: Said | null
  /** The leading context of each tool call of the newest assistant message that called a tool, by its id. */
  readonly contexts: { readonly [toolUseId: string]: string | null }
}

const EMPTY_ROW_FOLD: RowFold = { tail: [], truncated: false, turnEnd: undefined, latest: null, request: null, final: null, contexts: {} }

type StoredMessage = Extract<StoredTailEntry, { readonly kind: "message" }>["message"]

function blocksOf(content: StoredMessage["content"]): readonly { readonly type: string; readonly text?: string; readonly id?: string; readonly name?: string; readonly input?: { readonly [key: string]: unknown } }[] {
  return typeof content === "string" ? [] : content
}

/** The last text or transcript-visible tool call of a message, as the fold keeps it; undefined when it holds neither. */
function latestOf(blocks: ReturnType<typeof blocksOf>, at: number): RowLatest | undefined {
  for (const block of blocks.toReversed()) {
    if (block.type === "text" && block.text !== undefined) {
      const line = firstLine(block.text)
      if (line) return { kind: "text", text: line, at }
    } else if (block.type === "tool_use" && block.name !== undefined) {
      const input = keptInput(block.input)
      if (!isHiddenFromTranscript(getToolDisplay(block.name), input)) return { kind: "call", name: block.name, input, at }
    }
  }
  return undefined
}

function keptInput(input: { readonly [key: string]: unknown } | undefined): { readonly [key: string]: unknown } {
  return Object.fromEntries(Object.entries(input ?? {}).map(([key, value]) => [key, typeof value === "string" ? value.slice(0, KEPT_TEXT) : value]))
}

function textOf(message: StoredMessage): string {
  return typeof message.content === "string" ? message.content : blocksOf(message.content).flatMap((block) => block.type === "text" && block.text !== undefined ? [block.text] : []).join("\n")
}

/** The content that the turn-end readers read: the tool calls of an assistant message with their short inputs, and
 *  the start of a text that a runtime record or a continuation is told by. */
function keptContent(message: StoredMessage): StoredMessage["content"] {
  if (message.kind === "assistant") {
    return blocksOf(message.content).flatMap((block) => block.type === "tool_use" && block.id !== undefined && block.name !== undefined
      ? [{ type: "tool_use" as const, id: block.id, name: block.name, input: keptInput(block.input) }]
      : [])
  }
  return typeof message.content === "string" ? message.content.slice(0, KEPT_TEXT) : []
}

function reducedEntry(entry: StoredTailEntry, at: number): RowTailEntry {
  if (entry.kind !== "message") return { kind: entry.kind, id: entry.id, at }
  return { ...entry, message: { ...entry.message, content: keptContent(entry.message) }, at }
}

/** The first line of a text that holds more than spaces, trimmed. */
export const firstLine = (text: string): string => text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? ""

/** Advances the fold by the entries of one stored batch. */
export function foldRowBatch(fold: RowFold, entries: readonly StoredTailEntry[], at: number): RowFold {
  let { latest, request, final, contexts } = fold
  const added: RowTailEntry[] = []
  for (const entry of entries) {
    added.push(reducedEntry(entry, at))
    if (entry.kind !== "message") continue
    if (isPersonEntry(entry)) {
      const content = entry.message.content
      const first = typeof content === "string" ? content : content[0]?.type === "text" ? content[0].text ?? "" : ""
      request = { entryId: entry.id, text: first, at }
      continue
    }
    const { message } = entry
    if (message.kind !== "assistant" || entry.displayOnly === true) continue
    latest = latestOf(blocksOf(message.content), at) ?? latest
    const calls = blocksOf(message.content).filter((block) => block.type === "tool_use" && block.id !== undefined)
    if (calls.length === 0) final = { entryId: entry.id, text: textOf(message), at }
    else contexts = Object.fromEntries(calls.map((call) => [call.id, askUserLeadingContext(call.input) ?? null]))
  }
  const joined = [...fold.tail, ...added]
  const compacted = joined.length > ROW_TAIL_ENTRIES ? compactRuns(joined) : joined
  const tail = compacted.slice(-ROW_TAIL_ENTRIES)
  const truncated = fold.truncated || tail.length < compacted.length
  const reading = turnEndReading(tail, at)
  // A tail that no longer reaches the wait call of the same record keeps the background wait that the earlier read saw.
  const carried = truncated && reading?.recordId != null && reading.recordId === fold.turnEnd?.recordId && fold.turnEnd.reading.backgroundWait === true
    && reading.reading.backgroundWait === undefined && restoredWaitReadsOlder(tail)
  const turnEnd = carried && reading ? { ...reading, reading: { ...reading.reading, backgroundWait: true as const } } : reading
  return { tail, truncated, turnEnd, latest, request, final, contexts }
}

const CONTINUATIONS: ReadonlySet<string> = new Set(Object.values(CONTINUATION_MESSAGES).map((text) => text.slice(0, KEPT_TEXT)))

/** How the turn-end walks read an entry that they read past: `inert` for one that no walk reads (a label, or a
 *  display-only entry), `settled` for a settled record, and for produced input a key of every field that the wait and
 *  delivery rules read (`endsOpenWait`, `messageDisposition`). Undefined for an entry at which a walk stops or whose
 *  place it reads, such as a turn continuation. */
function runClass(entry: RowTailEntry): string | undefined {
  if (entry.kind === "label" || entry.kind === "session_info") return "inert"
  const message = entry.message
  if (entry.kind !== "message" || !message) return undefined
  const end = turnEndOfEntry(entry)
  if (end) return end.reason === "settled" ? "settled" : undefined
  if (entry.displayOnly === true) return "inert"
  if (!isProducedInput(message) || (typeof message.content === "string" && CONTINUATIONS.has(message.content))) return undefined
  const { producer } = message
  const notified = "backgroundNotificationIds" in message && Array.isArray(message.backgroundNotificationIds) && message.backgroundNotificationIds.length > 0
  const expired = typeof message.content === "string" && message.content.startsWith(`<${WAIT_EXPIRED_TAG}>`)
  return JSON.stringify([message.origin, producer?.kind, producer?.sessionId, producer?.hop, producer?.envelope?.relation, message.replyRequired, notified, expired])
}

/** Compacts each run of entries that the turn-end walks read past. Those walks read such a run only for which kinds of
 *  entry it holds and for its newest settled record, so a run keeps its first entry (a reset's opening), the newest
 *  entry of each class, and its newest entries, in their order, and drops the rest. */
function compactRuns(entries: readonly RowTailEntry[]): readonly RowTailEntry[] {
  const kept: RowTailEntry[] = []
  let run: RowTailEntry[] = []
  const flush = (): void => {
    if (run.length <= RUN_NEWEST + 1) {
      kept.push(...run)
    } else {
      const middle = run.slice(1, -RUN_NEWEST)
      const newest = new Map<string, RowTailEntry>()
      for (const entry of middle) {
        const kind = runClass(entry)
        if (kind !== undefined && kind !== "inert") newest.set(kind, entry)
      }
      const representatives = new Set(newest.values())
      kept.push(...run.slice(0, 1), ...middle.filter((entry) => representatives.has(entry)), ...run.slice(-RUN_NEWEST))
    }
    run = []
  }
  for (const entry of entries) {
    if (runClass(entry) !== undefined) {
      run.push(entry)
      continue
    }
    flush()
    kept.push(entry)
  }
  flush()
  return kept
}

function turnEndReading(tail: readonly RowTailEntry[], at: number): RowFold["turnEnd"] {
  const reading = chatTurnEndOf(tail)
  if (reading === undefined) return undefined
  // A recorded end that is not settled is the newest such record: the walk of `chatTurnEndOf` stops at it.
  const record = reading.recorded && reading.end.reason !== "settled"
    ? tail.findLast((entry) => { const end = turnEndOfEntry(entry); return end !== undefined && end.reason !== "settled" })
    : undefined
  return { reading, recordId: record?.id ?? null, at: record?.at ?? at }
}

function reduceRowFact(fold: RowFold, fact: StoredFact): RowFold {
  const parsed = parseProjectionFact(fact, parseConversationTreeFact)
  return parsed.type === "chat.entries.appended" ? foldRowBatch(fold, parsed.payload.entries, fact.timestamp) : fold
}

/** The held fold of one started chat's conversation (`lead-row:<sessionId>`). The rows owner pins the key and keeps
 *  the instance that this answers, and feeds it each stored batch through `apply`. A batch that this release cannot
 *  parse leaves the fold as it was. */
export function leadRowFold(reader: AsyncEventReadSurface, sessionId: string, conversationId: string): PositionedEventProjection<RowFold> {
  return heldProjection(reader, `lead-row:${sessionId}`, () => createEventProjection<RowFold>(reader, {
    name: `lead-row:${sessionId}`,
    aggregateId: `conversation:${conversationId}`,
    factTypes: ["chat.entries.appended"],
    initialState: () => EMPTY_ROW_FOLD,
    reduce: reduceRowFact,
    reduceUnreadableFact: (fold) => fold,
  }))
}
