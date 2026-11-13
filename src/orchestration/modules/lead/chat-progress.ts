import type { QuestionEntry } from "../../../infra/output-blocks.js"
import type { RuntimeTool, ToolResult } from "../../agent-runtime/tools/types.js"
import type { SessionManager } from "../../session/manager.js"
import { sessionDisplayName } from "../../session/schemas.js"
import { entryActivity } from "../../session-store/activity.js"
import type { SessionStore } from "../../session-store/types.js"
import type { ChatTurnEnd } from "../../session/conversation/turn-end-record.js"
import type { LeadChatReading } from "./rows.js"

export const CHAT_PROGRESS_TOOL_NAME = "chat_progress"

interface ChatProgressDeps {
  readonly sessionManager: Pick<SessionManager, "read">
  readonly sessionStore: Pick<SessionStore, "get">
  /** The rows owner's reading of a started chat that exists. */
  readonly chat: (sessionId: string) => Promise<LeadChatReading | undefined>
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

async function chatState(deps: ChatProgressDeps, sessionId: string): Promise<{ readonly chat: ChatState; readonly reading: LeadChatReading } | undefined> {
  const [session, reading] = await Promise.all([deps.sessionManager.read(sessionId), deps.chat(sessionId)])
  if (session?.kind !== "chat" || reading === undefined) return undefined
  return {
    reading,
    chat: {
      sessionId,
      title: sessionDisplayName({ id: sessionId, session }),
      activity: liveActivity(deps, sessionId, reading.working),
      lastTurn: lastTurnWords(reading.turnEnd, reading.working),
    },
  }
}

/** One line of state for each started chat that still exists, read from the lead's rows. */
export async function readChatRoster(deps: ChatProgressDeps, sessionIds: readonly string[]): Promise<ChatProgress> {
  const chats = await Promise.all(sessionIds.map(async (sessionId) => {
    const state = await chatState(deps, sessionId)
    return state ? [{ ...state.chat, question: state.reading.question !== undefined }] : []
  }))
  return { kind: "roster", chats: chats.flat() }
}

/** One started chat in its own words, read from the lead's rows: the person's newest message, the pending question
 *  with its context, and the final message of its newest completed turn. */
export async function readChatDetail(deps: ChatProgressDeps, sessionId: string): Promise<ChatProgress> {
  const state = await chatState(deps, sessionId)
  if (!state) return { kind: "refused", reason: `chat ${sessionId} no longer exists` }
  const { reading } = state
  return {
    kind: "detail",
    chat: state.chat,
    request: reading.request,
    final: reading.final || null,
    question: reading.question ? { context: reading.question.context, questions: reading.question.questions } : null,
  }
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
