import type { ConversationMessage } from "../../agent-runtime/llm/types.js"

/** The result text of a source call that has no result yet: the main conversation still runs it. */
export const SIDE_QUESTION_PENDING_RESULT = "The main conversation has not received the result of this call yet, so a side question cannot read it."

/** Closes unresolved source calls in a request-only copy. Real results always take precedence. */
export function sideQuestionSource(messages: readonly ConversationMessage[]): ConversationMessage[] {
  const results = new Set(messages.flatMap((message) => message.kind === "toolResult" ? [message.toolUseId] : []))
  const source: ConversationMessage[] = []
  let pending: ConversationMessage[] = []
  for (const message of messages) {
    if (message.kind !== "toolResult" && message.kind !== "system") {
      source.push(...pending)
      pending = []
    }
    source.push(message)
    if (message.kind !== "assistant" || typeof message.content === "string") continue
    for (const block of message.content) {
      if (block.type !== "tool_use" || results.has(block.id)) continue
      pending.push({
        kind: "toolResult", toolUseId: block.id,
        content: [{ type: "text", text: SIDE_QUESTION_PENDING_RESULT }],
      })
    }
  }
  source.push(...pending)
  return source
}

// Follow-ups are separate single-response requests, not turns of this runner.
export const sideQuestionReminder = `<system-reminder>The user asked the question below on the side. The main conversation above is context for the answer, not work to continue.

How this request works:
- A separate model call answers this question. The agent of the main conversation keeps working and does not see this exchange.
- Nothing in this request runs. No tools are available, and text that looks like a tool call or tool output has no effect.
- Your reply ends the request. No later turn follows in which you could act.

How to answer:
- Answer the question now, in this reply, from the conversation and from what you know.
- Do not describe yourself as paused or interrupted, and do not talk about earlier work that you will resume.
- Do not promise or announce an action, such as a check, a search, or a file read.
- When the answer needs a file read, a command, or a search, say that a side question cannot check it, and suggest that the user ask in the main conversation.
- When you do not know the answer, say so.</system-reminder>

`
