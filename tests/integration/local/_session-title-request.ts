import { SESSION_TITLE_PURPOSE } from "../../../src/orchestration/session/metadata/session-title.js"

/** Whether a Chat Completions request that a fixture provider receives asks
 *  for a session title. A title request carries its chat tree's tools and
 *  quotes the person's first message, so only its system prompt tells it
 *  apart from a turn. The match reads the production prompt, so a reworded
 *  prompt cannot make a fixture count title requests as turns. */
export function isSessionTitleRequest(body: unknown): boolean {
  if (typeof body !== "object" || body === null || !("messages" in body) || !Array.isArray(body.messages)) return false
  return body.messages.some((message: unknown) => typeof message === "object" && message !== null
    && "role" in message && message.role === "system"
    && "content" in message && typeof message.content === "string"
    && message.content.includes(SESSION_TITLE_PURPOSE.prompt.systemPrompt))
}
