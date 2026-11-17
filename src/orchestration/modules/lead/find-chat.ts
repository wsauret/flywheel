import type { FoundChat } from "../../../protocol/transcript-protocol-types.js"
import type { RuntimeTool, ToolResult } from "../../agent-runtime/tools/types.js"

export const FIND_CHAT_TOOL_NAME = "find_chat"

/** A chat that `find_chat` answers: a found chat, and whether it is in the lead's list. */
export type LeadFoundChat = FoundChat & { readonly listed: boolean }

function chatText(chat: LeadFoundChat, rank: number): string {
  const active = chat.lastActivityAt === undefined ? "" : `, last active ${new Date(chat.lastActivityAt).toISOString().slice(0, 10)}`
  const lines = [
    `${rank}. Session ${chat.sessionId} "${chat.title}"${active}, ${chat.listed ? "in your list" : "not in your list"}.`,
    `   Match: ${chat.snippet.replace(/\s+/g, " ").trim()}`,
  ]
  if (chat.excerpt) lines.push(`   ${chat.excerpt.source === "checkpoint" ? "Current state" : "Last message"}: ${chat.excerpt.text}`)
  return lines.join("\n")
}

/** The lead's search of the project's past chats (PI-LEAD-001, PI-LEAD-018). `find` answers for the calling lead. */
export function createFindChatTool(find: (query: string) => Promise<readonly LeadFoundChat[]>): RuntimeTool {
  return {
    name: FIND_CHAT_TOOL_NAME,
    action: "ui_meta",
    description: "Search every past session of this project for earlier work, by 2 to 5 distinctive keywords, such as an artifact, PR, ticket, branch, model, or file name. It answers up to 8 sessions, best first, each with its id, the matching words, and where it stands. When none fits, try once with other keywords.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "2 to 5 distinctive keywords, separated by spaces." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
    async execute(input): Promise<ToolResult> {
      const query = typeof input.query === "string" ? input.query.trim() : ""
      if (!query) return { content: "find_chat requires `query`, 2 to 5 keywords.", outcome: "error" }
      const chats = await find(query)
      if (chats.length === 0) return { content: `No past session matches "${query}".`, outcome: "ok" }
      return { content: ["Sessions that match, best first:", ...chats.map((chat, index) => chatText(chat, index + 1))].join("\n"), outcome: "ok" }
    },
  }
}
