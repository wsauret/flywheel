import { getDefaults, Lexer, type Token, type Tokens } from "marked"
import { errorMessage } from "../../../infra/diagnostics/error-message.js"
import { Log } from "../../../infra/diagnostics/log.js"
import { parseProjectionFact } from "../../../infra/substrate/projection/event-projection.js"
import type { AsyncEventStateReadSurface } from "../../../infra/substrate/store/event-store-types.js"
import type { TurnParkState } from "../../../infra/substrate/events/agent-loop-events.js"
import type { ChatTurnEnding } from "../../../protocol/session/chat-settlement-protocol-types.js"
import type { ConversationEntry } from "../conversation/conversation-entry-types.js"
import type { StoredConversationEntry } from "../conversation/conversation-entry-schemas.js"
import type { ConversationTree } from "../conversation/tree/conversation-tree.js"
import { isSkippedByWalk } from "../conversation/turn-end-record.js"
import type { ChatTurnStartedFact, ChatTurnStopFact, ChatTurnStoppedFact } from "../persistence/chat-turn-stop-facts.js"
import { parseSessionFact } from "../persistence/session-fact-registry.js"
import type { SessionFactWriter } from "../persistence/session-fact-writer.js"

const log = Log.create({ service: "chat-turn-stops" })

/** The most characters of a final message's first line that a stop carries.
 *  Measured final messages had a first line of 174 characters at the median
 *  and 302 at the 90th percentile, so this keeps nine of ten whole. */
const FIRST_LINE_LIMIT = 300

interface Answer { readonly entryId: string; readonly text: string }

/** The final message that `entry` holds: an assistant message that is
 *  complete and calls no tool. Undefined for any other entry. */
export function answerOf(entry: ConversationEntry | StoredConversationEntry): Answer | undefined {
  if (entry.kind !== "message") return undefined
  const { message } = entry
  if (message.kind !== "assistant" || message.incomplete === true) return undefined
  if (typeof message.content === "string") return { entryId: entry.id, text: message.content }
  if (message.content.some((block) => block.type === "tool_use")) return undefined
  return { entryId: entry.id, text: message.content.flatMap((block) => block.type === "text" ? [block.text] : []).join("\n\n") }
}

/** The first line of `text` in `token` as plain text, or undefined when
 *  the token shows none. A heading counts only when `headings` holds. */
function blockLine(token: Token, headings: boolean): string | undefined {
  switch (token.type) {
    case "blockquote":
    case "list_item": return firstBlockLine(token.tokens ?? [], headings)
    case "list": return firstBlockLine(token.items, headings)
    case "heading": return headings ? firstLine(inlineText(token.tokens ?? [])) : undefined
    case "paragraph":
    case "text": return firstLine(token.tokens ? inlineText(token.tokens) : token.text)
    case "code": return firstLine(token.text)
    case "table": return firstLine(token.header.map((cell: Tokens.TableCell) => inlineText(cell.tokens)).join(" | "))
    default: return undefined
  }
}

function firstBlockLine(tokens: readonly Token[], headings: boolean): string | undefined {
  for (const token of tokens) {
    const line = blockLine(token, headings)
    if (line !== undefined) return line
  }
  return undefined
}

/** Inline tokens as plain text: marks and HTML are dropped, and code,
 *  escapes, links, and images keep their text. */
function inlineText(tokens: readonly Token[]): string {
  return tokens.map((token) => {
    if (token.type === "html") return ""
    if (token.type === "br") return "\n"
    if ("tokens" in token && token.tokens) return inlineText(token.tokens)
    return "text" in token ? String(token.text) : ""
  }).join("")
}

function firstLine(text: string): string | undefined {
  return text.split(/\r?\n/).map((line) => line.trim()).find((line) => line.length > 0)
}

/** The first line of `text` that a list row can show, as plain text: a
 *  heading gives way to any later text, and a fence, a rule, and Markdown
 *  marks never show. A line longer than the limit is cut and ends with an
 *  ellipsis. */
export function finalMessageFirstLine(text: string): string {
  // Marked's own defaults, never the global options that a renderer in the
  // same process sets with `marked.use`, so the stored line is the same in
  // every process.
  const tokens = new Lexer(getDefaults()).lex(text)
  const line = firstBlockLine(tokens, false) ?? firstBlockLine(tokens, true) ?? ""
  const characters = Array.from(line)
  return characters.length <= FIRST_LINE_LIMIT ? line : `${characters.slice(0, FIRST_LINE_LIMIT - 1).join("")}…`
}

function stoppedFact(conversationId: string, ending: ChatTurnEnding, answer?: Answer, endedAt?: number): ChatTurnStoppedFact {
  return {
    type: "chat.turn.stopped", version: 1, actor: "flywheel",
    payload: { conversationId, ending, ...(answer ? { finalEntryId: answer.entryId, firstLine: finalMessageFirstLine(answer.text) } : {}), ...(endedAt === undefined ? {} : { endedAt }) },
  }
}

/** How a root chat's runner records its stops for the person and its turn
 *  starts (ARCH-SESSIONS-051). Every method reads only what the runner
 *  already holds in memory, so the turn start and the park read nothing
 *  from the store. */
export interface ChatTurnStops {
  /** A turn started or a parked turn continued. */
  started(): void
  /** The model ended the turn with `ending`; the park that follows decides. */
  turnEnded(ending: ChatTurnEnding): void
  /** The loop parked as `park`: an idle park after a turn end is the stop. */
  parked(park: TurnParkState): Promise<void>
  /** The run ended on a failure or a refusal that nothing continues. The
   *  stop is queued at once, so a caller need not wait for its write. */
  runEnded(ending: ChatTurnEnding): Promise<void>
}

const NO_STOPS: ChatTurnStops = { started() {}, turnEnded() {}, parked: async () => {}, runEnded: async () => {} }

/** The recorder of one runner life. A stop is recorded only after a start of
 *  this life: a compaction or a maintenance start of a chat at rest ends a
 *  turn of its own, and that turn's park must not state a second stop.
 *  Writes run in order, so a start never lands after the stop that follows
 *  it. A failed write is reported and never fails the turn. A run that no
 *  person reads (`attended` false) records nothing. A completed stop names
 *  the newest final message since the person's last message in `branch`,
 *  the conversation as the runner's tree writer holds it: each stop replaces
 *  the one before it, so a turn that says nothing new names the answer that
 *  the person has still not read. */
export function createChatTurnStops(input: {
  readonly sessionId: string
  readonly conversationId: string
  readonly writer: Pick<SessionFactWriter, "record">
  readonly branch: Pick<ConversationTree, "newestSincePersonMessage">
  readonly attended: boolean
}): ChatTurnStops {
  if (!input.attended) return NO_STOPS
  const { sessionId, conversationId, writer, branch } = input
  let startedSinceStop = false
  let owed: ChatTurnEnding | undefined
  let writes = Promise.resolve()
  /** Queues `fact` behind every earlier write. `onStored` runs once the
   *  store holds it. */
  const write = (fact: ChatTurnStopFact, onStored?: () => void): Promise<void> => {
    writes = writes.then(async () => {
      try {
        if (await writer.record(fact)) onStored?.()
        else log.warn("chat turn fact not recorded", { sessionId, type: fact.type, reason: "writer closed" })
      } catch (error) {
        log.warn("chat turn fact not recorded", { sessionId, type: fact.type, error: errorMessage(error) })
      }
    })
    return writes
  }
  const stop = (ending: ChatTurnEnding): Promise<void> => {
    const fact = stoppedFact(conversationId, ending, ending.kind === "completed" ? branch.newestSincePersonMessage(answerOf) : undefined)
    startedSinceStop = false
    owed = undefined
    const { finalEntryId } = fact.payload
    return write(fact, () => { log.info("chat stopped for the person", { sessionId, conversationId, ending: ending.kind, ...(finalEntryId ? { finalEntryId } : {}) }) })
  }
  return {
    started() {
      startedSinceStop = true
      owed = undefined
      const fact: ChatTurnStartedFact = { type: "chat.turn.started", version: 1, actor: "flywheel", payload: { conversationId } }
      void write(fact)
    },
    turnEnded(ending) { owed = ending },
    async parked(park) {
      if (park === "idle" && owed && startedSinceStop) await stop(owed)
    },
    async runEnded(ending) {
      if (startedSinceStop) await stop(ending)
    },
  }
}

/** The final message that a branch ends with, and the time it was written:
 *  its newest entry that a turn walk reads is an assistant message that
 *  calls no tool. */
function finalAnswerOf(branch: readonly ConversationEntry[]): { readonly answer: Answer; readonly at: number } | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index]
    if (!entry || isSkippedByWalk(entry)) continue
    const answer = answerOf(entry)
    return answer && { answer, at: Date.parse(entry.timestamp) }
  }
  return undefined
}

/** Records the stop that a dead owner of a root chat left out: its last turn
 *  started, it answered, and the owner died before the stop. The newest of
 *  the session's start and stop facts must be a start, so a conversation
 *  from before stops were recorded gets none. `branchOf` returns the
 *  recovered branch of the start's conversation, or undefined when recovery
 *  holds that conversation back. The caller decides that the owner's work no
 *  longer owes the chat a result. Returns the recorded fact, or undefined. */
export async function recoverChatTurnStop(input: {
  readonly reader: Pick<AsyncEventStateReadSurface, "readLatestByAggregateAndTypes">
  readonly writer: Pick<SessionFactWriter, "record">
  readonly sessionId: string
  readonly branchOf: (conversationId: string) => Promise<readonly ConversationEntry[] | undefined>
}): Promise<ChatTurnStoppedFact | undefined> {
  const { reader, writer, sessionId } = input
  const latest = await reader.readLatestByAggregateAndTypes(`session:${sessionId}`, ["chat.turn.stopped", "chat.turn.started"])
  const newest = latest.reduce<(typeof latest)[number] | undefined>((found, fact) => !found || fact.position > found.position ? fact : found, undefined)
  if (!newest) return undefined
  const fact = parseProjectionFact(newest, parseSessionFact<ChatTurnStopFact>)
  if (fact.type !== "chat.turn.started") return undefined
  const { conversationId } = fact.payload
  const branch = await input.branchOf(conversationId)
  const final = branch ? finalAnswerOf(branch) : undefined
  if (!final) return undefined
  const { answer } = final
  // The turn ended at its final message, not at this recovery, so a list
  // that orders chats by their latest turn keeps this one in its place.
  const stopped = stoppedFact(conversationId, { kind: "completed" }, answer, final.at)
  if (!await writer.record(stopped)) return undefined
  log.info("owed chat stop recorded", { sessionId, conversationId, ending: "completed", finalEntryId: answer.entryId })
  return stopped
}
