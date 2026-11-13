import type { AsyncEventStateReadSurface } from "../../../infra/event-store-types.js"
import type { QuestionEntry } from "../../../infra/output-blocks.js"
import { askUserLeadingContext } from "../../../infra/tools/displays/ask-user.js"
import type { RuntimeTool, ToolResult } from "../../agent-runtime/tools/types.js"
import type { SessionManager } from "../../session/manager.js"
import { loadAgentInputProjection } from "../../session/agent-input-projection.js"
import { readChatTurnEnd, readConversationTail, type StoredTailEntry } from "../../session/chat-session-run-evidence.js"
import { isPersonEntry } from "../../session/conversation/person-entries.js"
import { sessionDisplayName } from "../../session/schemas.js"
import { entryActivity } from "../../session-store/activity.js"
import type { SessionStore } from "../../session-store/types.js"
import type { ChatTurnEnd } from "../../session/conversation/turn-end-record.js"

export const CHAT_PROGRESS_TOOL_NAME = "chat_progress"

interface ChatProgressDeps {
  readonly reader: AsyncEventStateReadSurface
  readonly sessionManager: Pick<SessionManager, "read">
  readonly sessionStore: Pick<SessionStore, "get">
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

/** What `chat_progress` answers: a refusal, one line for each started chat, or one started chat in its own words. */
export type ChatProgress =
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "roster"; readonly chats: readonly (ChatState & { readonly question: boolean })[] }
  | { readonly kind: "detail"; readonly chat: ChatState; readonly request: string | null; readonly question: PendingQuestion | null; readonly final: string | null }

/** The chat's live activity in words, and whether a runner of it is live. */
function liveActivity(deps: ChatProgressDeps, sessionId: string) {
  const entry = deps.sessionStore.get(sessionId)
  if (entry?.kind !== "chat") return { words: "not running", live: false }
  if (entry.waitingOnBackgroundWork) return { words: "waiting on its background work", live: true }
  switch (entryActivity(entry)) {
    case "absent": return { words: "not running", live: false }
    case "idle": return { words: "at rest", live: true }
    case "awaiting_user": return { words: "waiting for the person's answer", live: true }
    default: return { words: "working", live: true }
  }
}

function lastTurnWords(turnEnd: ChatTurnEnd | undefined, live: boolean): string {
  if (turnEnd === undefined) return "ended with an answer, or no turn ran yet"
  switch (turnEnd.end.reason) {
    case "paused": return "was cut"
    // An unrecorded crash is an unanswered tail, such as a newest message of the person: the turn has not ended.
    case "crash": return turnEnd.recorded ? "failed" : live ? "has not ended yet" : "stopped before it ended, and waits to resume"
    case "discarded": return "was discarded"
    case "settled": return "ended with an answer"
  }
}

async function chatState(deps: ChatProgressDeps, sessionId: string): Promise<(ChatState & { readonly conversationId: string }) | undefined> {
  const session = await deps.sessionManager.read(sessionId)
  if (session?.kind !== "chat") return undefined
  const activity = liveActivity(deps, sessionId)
  return {
    sessionId,
    conversationId: session.conversationId,
    title: sessionDisplayName({ id: sessionId, session }),
    activity: activity.words,
    lastTurn: lastTurnWords(await readChatTurnEnd(deps.reader, session.conversationId), activity.live),
  }
}

async function pendingQuestion(deps: ChatProgressDeps, sessionId: string) {
  for (const entry of (await loadAgentInputProjection(deps.reader, sessionId)).values()) {
    if (entry.kind === "pending") return entry
  }
  return undefined
}

/** One line of state for each started chat that still exists. One explicit tool call reads each chat once. */
export async function readChatRoster(deps: ChatProgressDeps, sessionIds: readonly string[]): Promise<ChatProgress> {
  const chats = await Promise.all(sessionIds.map(async (sessionId) => {
    const state = await chatState(deps, sessionId)
    if (!state) return []
    const { conversationId: _conversationId, ...chat } = state
    return [{ ...chat, question: await pendingQuestion(deps, sessionId) !== undefined }]
  }))
  return { kind: "roster", chats: chats.flat() }
}

function textOf(content: string | readonly { readonly type: string; readonly text?: string }[]): string {
  return typeof content === "string" ? content : content.flatMap((block) => block.type === "text" && block.text !== undefined ? [block.text] : []).join("\n")
}

/** A person's message as its text: the first block, without the bodies of attached files. */
function personText(content: string | readonly { readonly type: string; readonly text?: string }[]): string {
  if (typeof content === "string") return content
  const first = content[0]
  return first?.type === "text" ? first.text ?? "" : ""
}

/** One started chat in its own words: the person's newest message, the pending question with its context, and the
 *  final message of its last completed turn. It reads the chat's newest entry batches back until it holds all three,
 *  or to the start of the conversation. A final message is an assistant message with no tool call, so while a turn
 *  runs the final message is that of an earlier turn, before the person's newest message. */
export async function readChatDetail(deps: ChatProgressDeps, sessionId: string): Promise<ChatProgress> {
  const state = await chatState(deps, sessionId)
  if (!state) return { kind: "refused", reason: `chat ${sessionId} no longer exists` }
  const pending = await pendingQuestion(deps, sessionId)
  let request: string | null = null
  let final: string | null = null
  let context: string | null = null
  let askFound = pending === undefined
  const tail = await readConversationTail(deps.reader, state.conversationId, (batch: readonly StoredTailEntry[]) => {
    for (let index = batch.length - 1; index >= 0 && !(request !== null && askFound && final !== null); index -= 1) {
      const entry = batch[index]
      if (entry?.kind !== "message") continue
      if (isPersonEntry(entry)) {
        request ??= personText(entry.message.content)
        continue
      }
      const { message } = entry
      if (message.kind !== "assistant") continue
      const blocks = typeof message.content === "string" ? [] : message.content
      const ask = blocks.find((block) => block.type === "tool_use" && block.id === pending?.toolUseId)
      if (ask?.type === "tool_use") {
        context = askUserLeadingContext(ask.input) ?? null
        askFound = true
      }
      if (final === null && !blocks.some((block) => block.type === "tool_use")) final = textOf(message.content) || null
    }
    return request !== null && askFound && final !== null
  })
  if (tail === undefined) return { kind: "refused", reason: `the conversation of chat ${sessionId} cannot be read` }
  const { conversationId: _conversationId, ...chat } = state
  return { kind: "detail", chat, request, final, question: pending ? { context, questions: pending.request } : null }
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

/** The model-visible text of one answer. The chat's own words follow their labels unchanged. */
function progressText(progress: Exclude<ChatProgress, { kind: "refused" }>): string {
  if (progress.kind === "roster") {
    if (progress.chats.length === 0) return "You have started no chats."
    return ["The chats that you started:", ...progress.chats.map((chat) => `- ${headline(chat)}${chat.question ? " A question waits for the person." : ""}`)].join("\n")
  }
  return [
    headline(progress.chat),
    "",
    "The person's newest message in that chat:",
    progress.request ?? "(none)",
    "",
    progress.question ? `The chat's pending question for the person, word for word:\n${questionText(progress.question)}` : "No question waits for the person.",
    "",
    "The final message of its last turn:",
    progress.final ?? "(none yet)",
  ].join("\n")
}

/** The read-only tool through which the lead reads the progress of the chats that it started (PI-LEAD-001,
 *  PI-LEAD-006). `progress` answers for the calling lead. */
export function createChatProgressTool(progress: (chat: string | undefined) => Promise<ChatProgress>): RuntimeTool {
  return {
    name: CHAT_PROGRESS_TOOL_NAME,
    action: "ui_meta",
    description: "Read the progress of the chats that you started. Without `chat`, it lists each of them with its id, its title, its live activity, whether a question waits for the person, and how its last turn ended. With `chat`, it answers that chat in its own words: the person's newest message there, the chat's pending question with its context and options word for word, and the final message of its last turn. It reads only chats that you started.",
    inputSchema: {
      type: "object",
      properties: {
        chat: { type: "string", description: "The id of one chat that you started. Omit it to list every chat that you started." },
      },
      additionalProperties: false,
    },
    isConcurrencySafe: true,
    async execute(input): Promise<ToolResult> {
      const chat = typeof input.chat === "string" && input.chat.trim() ? input.chat.trim() : undefined
      const answer = await progress(chat)
      if (answer.kind === "refused") return { content: `Not read: ${answer.reason}.`, outcome: "error" }
      return { content: progressText(answer), outcome: "ok" }
    },
  }
}
