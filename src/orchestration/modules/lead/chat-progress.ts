import { parseProjectionFact } from "../../../infra/event-projection.js"
import { CorruptEventRowError, type AsyncEventStateReadSurface } from "../../../infra/event-store-types.js"
import { isProgressUpdate } from "../../../infra/llm/anthropic-narration.js"
import type { AgentGroupBlock, QuestionEntry } from "../../../infra/output-blocks.js"
import { redactSecrets } from "../../../infra/redact-secrets.js"
import { getToolDisplay, isHiddenFromTranscript, resolveToolRowPresentation } from "../../../infra/tools/tool-display-registry.js"
import { formatElapsed } from "../../../protocol/client/format.js"
import { activeTimeMs } from "../../../protocol/client/session-time.js"
import type { RuntimeTool, ToolResult } from "../../agent-runtime/tools/types.js"
import type { StoredTailEntry } from "../../session/chat-session-run-evidence.js"
import { parseConversationCheckpointFact } from "../../session/conversation-checkpoint-facts.js"
import { parseConversationTreeFact } from "../../session/conversation/conversation-facts.js"
import { isPersonEntry } from "../../session/conversation/person-entries.js"
import type { SessionManager } from "../../session/manager.js"
import { sessionDisplayName } from "../../session/schemas.js"
import { entryActivity } from "../../session-store/activity.js"
import type { SessionStore } from "../../session-store/types.js"
import type { ChatTurnEnd } from "../../session/conversation/turn-end-record.js"
import type { LeadChatReading } from "./rows.js"

export const CHAT_PROGRESS_TOOL_NAME = "chat_progress"

/** One answer stays near 4 KB of text (ARCH-CONTEXT-040). Each part before the conversation has its own bound, and the
 *  conversation takes what they leave, but always shows its newest message. Only a pending question, which the answer
 *  gives word for word, and a long list of running agents can make an answer longer. */
const DETAIL_CHARS = 4_000
const STANDING_CHARS = 600
const MESSAGE_CHARS = 1_200
/** A message cut shorter than this says little, so a page that has less budget left ends before it. */
const MESSAGE_MIN_CHARS = 120
/** The entry batches that one answer reads at most, one batch for each read, so one call costs the same for any
 *  history, and a large batch never shares a read with another (`readConversationTail`). */
const CONVERSATION_BATCHES = 32
const RECENT_CALLS = 12
const CALL_DETAIL_CHARS = 60
/** The calls come from the conversation page, which is read after the page's room is known, so the page leaves the
 *  calls line this much. */
const CALLS_CHARS = 300
const GOAL_CHARS = 100
/** The longest line that ends a page: its cursor, or the start of the conversation. */
const PAGE_END_CHARS = 64
const SPEAKER = { person: "The person", chat: "The chat" } as const
const CALLS_LABEL = "Its newest calls, newest first: "
const CONVERSATION_HEADING = "Its conversation, newest first:"

interface ChatProgressDeps {
  readonly reader: AsyncEventStateReadSurface
  readonly sessionManager: Pick<SessionManager, "read">
  readonly sessionStore: Pick<SessionStore, "get">
  /** The rows owner's reading of a listed chat that exists. */
  readonly chat: (sessionId: string) => Promise<LeadChatReading | undefined>
  readonly agentCards: (sessionId: string) => Promise<readonly AgentGroupBlock[]>
  readonly now?: () => number
}

interface ChatState {
  readonly sessionId: string
  readonly title: string
  /** The chat's live activity, in words. */
  readonly activity: string
  /** How the chat's last turn ended, in words. */
  readonly lastTurn: string
}

interface PendingQuestion {
  readonly context: string | null
  readonly questions: readonly QuestionEntry[]
}

/** Where the chat's newest checkpoint says it stands. */
interface Standing {
  readonly currentState: string
  readonly nextStep: string
}

/** A subagent or a workflow of the chat that has not finished, as its card in the chat's transcript shows it. */
interface RunningChild {
  readonly kind: string
  readonly goal: string
  readonly state: string
  readonly elapsed: string
}

/** A message of the person or a visible text of the chat, cut to fit. */
interface Said {
  readonly from: keyof typeof SPEAKER
  readonly text: string
}

/** A page of the conversation, newest first, and the cursor of the page before it while one exists. */
interface ConversationPage {
  readonly said: readonly Said[]
  readonly before: string | null
}

/** What `chat_progress` answers: a refusal, one line for each listed chat, one listed chat as it stands, or an earlier
 *  page of one listed chat's conversation. */
export type ChatProgress =
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "roster"; readonly chats: readonly (ChatState & { readonly question: boolean })[] }
  | {
    readonly kind: "detail"
    readonly chat: ChatState
    readonly standing: Standing | null
    readonly question: PendingQuestion | null
    readonly running: readonly RunningChild[]
    /** The chat's newest calls as one line, newest first. */
    readonly calls: string | null
    readonly conversation: ConversationPage
  }
  | { readonly kind: "page"; readonly chat: ChatState; readonly cursor: string; readonly conversation: ConversationPage }

/** The chat's live activity in words. A chat that works with no turn in progress has a runner that starts. */
function liveActivity(deps: ChatProgressDeps, sessionId: string, working: boolean): string {
  const entry = deps.sessionStore.get(sessionId)
  if (entry?.kind !== "chat") return "not running"
  if (entry.waitingOnBackgroundWork) return "waiting on its background work"
  const activity = entryActivity(entry)
  if (working && (activity === "absent" || activity === "idle")) return "starting"
  switch (activity) {
    case "absent": return "not running"
    case "idle": return "at rest"
    case "awaiting_user": return "waiting for the person's answer"
    default: return "working"
  }
}

/** How the last turn ended, in words. An open turn with no live work and no record failed, as its row reads. */
function lastTurnWords(turnEnd: ChatTurnEnd | undefined, working: boolean): string {
  if (turnEnd === undefined) return "ended with an answer, or no turn ran yet"
  switch (turnEnd.end.reason) {
    case "paused": return "was cut"
    case "crash": return turnEnd.recorded || !working ? "failed" : "has not ended yet"
    case "discarded": return "was discarded"
    case "settled": return "ended with an answer"
  }
}

async function chatState(deps: ChatProgressDeps, sessionId: string) {
  const [session, reading] = await Promise.all([deps.sessionManager.read(sessionId), deps.chat(sessionId)])
  if (session?.kind !== "chat" || reading === undefined) return undefined
  const chat: ChatState = {
    sessionId,
    title: sessionDisplayName({ id: sessionId, session }),
    // A pending question decides both: a chat whose runner closed or opened again keeps it, and the store shows
    // such a chat at rest or not running (PI-INTERACTION-009).
    activity: reading.question ? "waiting for the person's answer" : liveActivity(deps, sessionId, reading.working),
    lastTurn: reading.question ? "stopped on a question for the person" : lastTurnWords(reading.turnEnd, reading.working),
  }
  // The type admits a row written before sessions recorded a directory; such a row names its paths whole.
  return { chat, reading, conversationId: session.conversationId, cwd: session.executionCwd ?? "" }
}

/** One line of state for each listed chat that still exists, read from the lead's rows. */
export async function readChatRoster(deps: ChatProgressDeps, sessionIds: readonly string[]): Promise<ChatProgress> {
  const chats = await Promise.all(sessionIds.map(async (sessionId) => {
    const state = await chatState(deps, sessionId)
    return state ? [{ ...state.chat, question: state.reading.question !== undefined }] : []
  }))
  return { kind: "roster", chats: chats.flat() }
}

/** `text`, cut to at most `chars` characters with "..." marking the cut. */
const cut = (text: string, chars: number): string => text.length <= chars ? text : `${text.slice(0, Math.max(chars - 3, 0)).trimEnd()}...`

/** Where the newest checkpoint of the chat's session says the chat stands, when that checkpoint belongs to the chat's
 *  conversation: one read of one fact. A fact that this release cannot read gives none. */
async function readStanding(reader: AsyncEventStateReadSurface, sessionId: string, conversationId: string): Promise<Standing | null> {
  const [fact] = (await reader.readSlice({ aggregateId: `session:${sessionId}`, types: ["conversation.checkpoint.updated"], order: "desc", limit: 1 }, true)).facts
  if (fact === undefined || fact instanceof CorruptEventRowError) return null
  let payload
  try {
    payload = parseProjectionFact(fact, parseConversationCheckpointFact).payload
  } catch {
    return null
  }
  const currentState = payload.checkpoint.currentState.trim()
  const nextStep = payload.checkpoint.nextStep.trim()
  if (payload.conversationId !== conversationId || (!currentState && !nextStep)) return null
  return { currentState: cut(currentState, STANDING_CHARS), nextStep: cut(nextStep, STANDING_CHARS) }
}

/** A conversation cursor: the entries of the batch at `position` before `index`, then every older batch. */
interface Cursor {
  readonly position: number
  readonly index: number
}

const cursorText = ({ position, index }: Cursor): string => `${position}:${index}`

function parseCursor(text: string): Cursor | undefined {
  const match = /^(\d+):(\d+)$/.exec(text)
  return match ? { position: Number(match[1]), index: Number(match[2]) } : undefined
}

type StoredMessage = Extract<StoredTailEntry, { readonly kind: "message" }>["message"]

/** The words of a message that its transcript shows as text: its text, and the progress updates that the agent said
 *  to the person, redacted as the transcript redacts them. Other thinking is private. */
function textOf(content: StoredMessage["content"]): string {
  if (typeof content === "string") return content.trim()
  return content.flatMap((block) => {
    if (block.type === "text") return [block.text]
    return block.type === "thinking" && isProgressUpdate(block) ? [redactSecrets(block.thinking)] : []
  }).join("\n").trim()
}

const pageRead = (conversationId: string, beforePosition: number | undefined) => ({
  aggregateId: `conversation:${conversationId}`, types: ["chat.entries.appended"], order: "desc" as const, limit: 1,
  ...(beforePosition === undefined ? {} : { beforePosition }),
})

/** One page of the conversation from `from` back, newest first: the person's messages and the chat's visible text,
 *  never tool output, thinking, or tool inputs. Its lines, each with its speaker, take at most `room` characters, but
 *  the newest message always shows. It reads one entry batch at a time, at most `CONVERSATION_BATCHES`, then one more
 *  to learn whether an earlier page exists. `onCall` sees each call of the entries that the page walks, newest first.
 *  A batch that this release cannot read is passed over. */
async function readConversationPage(reader: AsyncEventStateReadSurface, conversationId: string, from: Cursor | undefined, room: number, onCall: (name: string, input: unknown) => void): Promise<ConversationPage> {
  const said: Said[] = []
  let left = room
  let beforePosition = from === undefined ? undefined : from.index > 0 ? from.position + 1 : from.position
  for (let read = 0; read < CONVERSATION_BATCHES; read += 1) {
    const [batch] = (await reader.readSlice(pageRead(conversationId, beforePosition), true)).facts
    if (batch === undefined) return { said, before: null }
    const position = batch instanceof CorruptEventRowError ? batch.row.position : batch.position
    beforePosition = position
    if (batch instanceof CorruptEventRowError) continue
    let fact
    try {
      fact = parseProjectionFact(batch, parseConversationTreeFact)
    } catch {
      continue
    }
    if (fact.type !== "chat.entries.appended") continue
    const { entries } = fact.payload
    const end = from !== undefined && from.index > 0 && from.position === position ? Math.min(from.index, entries.length) : entries.length
    for (let index = end - 1; index >= 0; index -= 1) {
      const entry = entries[index]
      if (entry?.kind !== "message" || entry.displayOnly === true) continue
      const { message } = entry
      const speaker = isPersonEntry(entry) ? "person" : message.kind === "assistant" ? "chat" : undefined
      if (speaker === undefined) continue
      if (message.kind === "assistant" && typeof message.content !== "string") {
        for (const block of message.content.toReversed()) if (block.type === "tool_use") onCall(block.name, block.input)
      }
      const text = textOf(message.content)
      if (!text) continue
      // The line's speaker, ": ", and the newline that ends it.
      const frame = SPEAKER[speaker].length + 3
      if (said.length > 0 && left - frame < MESSAGE_MIN_CHARS) return { said, before: cursorText({ position, index: index + 1 }) }
      const shown = cut(text, Math.min(MESSAGE_CHARS, Math.max(left - frame, MESSAGE_MIN_CHARS)))
      said.push({ from: speaker, text: shown })
      left -= frame + shown.length
    }
  }
  if (beforePosition === undefined) return { said, before: null }
  const [earlier] = (await reader.readSlice(pageRead(conversationId, beforePosition), true)).facts
  return { said, before: earlier === undefined ? null : cursorText({ position: beforePosition, index: 0 }) }
}

/** One call of the chat: its tool, and the sentence that its transcript row shows. */
interface Call {
  readonly tool: string
  readonly sentence: string
}

/** The chat's newest calls, newest first, by tool: repeats of one tool count, and a single call adds its row's
 *  sentence, which names its target. The line stays within `CALLS_CHARS`. */
function callsLine(calls: readonly Call[]): string | null {
  if (calls.length === 0) return null
  const line = [...Map.groupBy(calls, (call) => call.tool)]
    .map(([tool, group]) => group.length > 1 ? `${tool} x${group.length}` : `${tool} (${cut(group[0]?.sentence ?? "", CALL_DETAIL_CHARS)})`)
    .join(", ")
  return cut(line, CALLS_CHARS - CALLS_LABEL.length)
}

function runningState(block: AgentGroupBlock): string {
  switch (block.status) {
    case "queued": return "queued"
    case "pending": return "starting"
    case "paused": return `paused by the ${block.pausedBy}`
  }
  const card = block.containerKind === "workflow" ? block.card : undefined
  if (card) return `running, ${card.done} of ${card.total} agents done${card.failed > 0 ? `, ${card.failed} failed` : ""}`
  return block.activity ? `running, newest call: ${cut(`${block.activity.name} ${block.activity.detail}`.trim(), CALL_DETAIL_CHARS)}` : "running"
}

/** The subagents and workflows of the chat that have not finished, from the agent cards of its live transcript. */
async function runningChildren(deps: ChatProgressDeps, sessionId: string): Promise<readonly RunningChild[]> {
  const cards = await deps.agentCards(sessionId)
  const now = (deps.now ?? Date.now)()
  return cards.map((block) => ({
    kind: block.containerKind === "workflow" ? "workflow" : `subagent${block.agentType ? ` ${block.agentType}` : ""}`,
    goal: cut(block.description && block.description !== block.label ? `${block.label}: ${block.description}` : block.label, GOAL_CHARS),
    state: runningState(block),
    elapsed: formatElapsed(activeTimeMs(block.duration ?? 0, block.activeStartedAt, now)),
  }))
}

/** The characters that a conversation page has after `lines`, less the line that ends it. */
const pageRoom = (lines: readonly string[]): number => DETAIL_CHARS - lines.join("\n").length - 1 - PAGE_END_CHARS

/** One listed chat as it stands, from the lead's rows, its newest checkpoint, its live transcript, and one bounded
 *  page of its conversation; with `before`, the page of its conversation before that cursor. */
export async function readChatDetail(deps: ChatProgressDeps, sessionId: string, before?: string): Promise<ChatProgress> {
  const from = before === undefined ? undefined : parseCursor(before)
  if (before !== undefined && from === undefined) return { kind: "refused", reason: `"${before}" is not a cursor that an earlier answer named` }
  const state = await chatState(deps, sessionId)
  if (!state) return { kind: "refused", reason: `chat ${sessionId} no longer exists` }
  if (before !== undefined) {
    const room = pageRoom(pageHeadLines(state.chat, before))
    return { kind: "page", chat: state.chat, cursor: before, conversation: await readConversationPage(deps.reader, state.conversationId, from, room, () => {}) }
  }
  const calls: Call[] = []
  const onCall = (tool: string, input: unknown): void => {
    if (calls.length >= RECENT_CALLS || isHiddenFromTranscript(getToolDisplay(tool), input)) return
    const { sentence } = resolveToolRowPresentation(tool, input, state.cwd)
    calls.push({ tool, sentence: `${sentence.name} ${sentence.detail}`.trim() })
  }
  const { question } = state.reading
  const [standing, running] = await Promise.all([readStanding(deps.reader, sessionId, state.conversationId), runningChildren(deps, sessionId)])
  const head: DetailHead = { chat: state.chat, standing, question: question ? { context: question.context, questions: question.questions } : null, running }
  // The calls line and the blank line before it are not known yet, so the page leaves them their bound.
  const room = pageRoom([...detailHeadLines(head), "", CONVERSATION_HEADING]) - CALLS_CHARS - 2
  const conversation = await readConversationPage(deps.reader, state.conversationId, undefined, room, onCall)
  return { kind: "detail", ...head, calls: callsLine(calls), conversation }
}

function questionText({ context, questions }: PendingQuestion): string {
  const lines = context === null ? [] : ["Context:", context]
  for (const question of questions) {
    lines.push(`Question${question.header ? ` (${question.header})` : ""}: ${question.question}`, question.multiSelect ? "Options (more than one can be picked):" : "Options:")
    for (const choice of question.choices) {
      if (choice.kind === "freeform") lines.push(`- ${choice.label} (free text)`)
      else lines.push(`- ${choice.label}${choice.description ? `: ${choice.description}` : ""}${choice.recommended ? " (recommended)" : ""}`)
    }
  }
  return lines.join("\n")
}

const headline = (chat: ChatState): string => `Chat ${chat.sessionId} "${chat.title}": ${chat.activity}; its last turn ${chat.lastTurn}.`

function conversationLines({ said, before }: ConversationPage): string[] {
  const lines = said.length === 0 ? ["(no messages)"] : said.map(({ from, text }) => `${SPEAKER[from]}: ${text}`)
  lines.push(before === null ? "That is the start of the conversation." : `Earlier messages: call again with before "${before}".`)
  return lines
}

function runningLines(running: readonly RunningChild[]): string[] {
  if (running.length === 0) return ["It runs no other agent now."]
  return ["The agents that it runs now:", ...running.map((child) => `- ${child.kind} "${child.goal}", for ${child.elapsed}: ${child.state}`)]
}

type DetailHead = Pick<Extract<ChatProgress, { kind: "detail" }>, "chat" | "standing" | "question" | "running">

/** The lines of a detail answer before its calls and its conversation. */
function detailHeadLines({ chat, standing, question, running }: DetailHead): string[] {
  return [
    headline(chat),
    "",
    ...(standing ? ["Where its checkpoint says it stands:", standing.currentState || "(not stated)", `Next step: ${standing.nextStep || "(not stated)"}`] : ["It has no checkpoint."]),
    "",
    question ? `The chat's pending question for the person, word for word:\n${questionText(question)}` : "No question waits for the person.",
    "",
    ...runningLines(running),
  ]
}

const pageHeadLines = (chat: ChatState, cursor: string): string[] => [headline(chat), "", `Its conversation before cursor "${cursor}", newest first:`]

/** The model-visible text of one answer. The chat's own words follow their labels unchanged, except where a bound
 *  cuts them, which "..." marks. */
function progressText(progress: Exclude<ChatProgress, { kind: "refused" }>): string {
  switch (progress.kind) {
    case "roster":
      if (progress.chats.length === 0) return "Your list holds no chats."
      return ["The chats in your list:", ...progress.chats.map((chat) => `- ${headline(chat)}${chat.question ? " A question waits for the person." : ""}`)].join("\n")
    case "page":
      return [...pageHeadLines(progress.chat, progress.cursor), ...conversationLines(progress.conversation)].join("\n")
    case "detail":
      return [
        ...detailHeadLines(progress),
        ...(progress.calls ? ["", `${CALLS_LABEL}${progress.calls}`] : []),
        "",
        CONVERSATION_HEADING,
        ...conversationLines(progress.conversation),
      ].join("\n")
  }
}

/** The read-only tool through which the lead reads the progress of the chats in its list (PI-LEAD-001,
 *  PI-LEAD-006, PI-LEAD-019). `progress` answers for the calling lead. */
export function createChatProgressTool(progress: (chat: string | undefined, before: string | undefined) => Promise<ChatProgress>): RuntimeTool {
  return {
    name: CHAT_PROGRESS_TOOL_NAME,
    action: "ui_meta",
    description: "Read the progress of the chats in your list: every chat of this project that is in use, whoever started it. Without `chat`, it lists each of them with its id, its title, its live activity, whether a question waits for the person, and how its last turn ended. With `chat`, it answers where that chat stands: its checkpoint's current state and next step, its pending question with its context and options word for word, the agents that it runs now, its newest calls, and its conversation newest first without tool output. Pass `before` with the cursor that an answer names to read earlier messages. It reads only chats in your list.",
    inputSchema: {
      type: "object",
      properties: {
        chat: { type: "string", description: "The id of one chat in your list. Omit it to list every chat in your list." },
        before: { type: "string", description: "The cursor that an earlier answer about this chat named. Needs `chat`." },
      },
      additionalProperties: false,
    },
    isConcurrencySafe: true,
    async execute(input): Promise<ToolResult> {
      const chat = typeof input.chat === "string" && input.chat.trim() ? input.chat.trim() : undefined
      const before = typeof input.before === "string" && input.before.trim() ? input.before.trim() : undefined
      if (before !== undefined && chat === undefined) return { content: "Not read: `before` needs `chat`.", outcome: "error" }
      const answer = await progress(chat, before)
      if (answer.kind === "refused") return { content: `Not read: ${answer.reason}.`, outcome: "error" }
      return { content: progressText(answer), outcome: "ok" }
    },
  }
}
