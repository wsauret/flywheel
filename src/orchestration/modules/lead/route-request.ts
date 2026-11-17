import { firstLineOf, type PersonEntryRef } from "../../session/conversation/person-entries.js"
import type { SessionMessaging } from "../../session/session-messaging.js"
import type { RuntimeTool, RuntimeToolInput, ToolResult } from "../../agent-runtime/tools/types.js"

export const ROUTE_REQUEST_TOOL_NAME = "route_request"

/** What the lead names for one route: the lead chat, the target, how many earlier turns of the person go too, and
 *  for a split request the passages of the person's messages that this route sends. */
export interface RouteInput {
  readonly leadSessionId: string
  readonly kind: "new" | "existing"
  /** The target of an `existing` route. */
  readonly chat?: string
  readonly earlierTurns: number
  readonly parts?: readonly string[]
}

/** What one route did. `started` is `now` when this call started the chat, `earlier` when the same entries started
 *  it before, and absent for a route to an earlier chat. `recorded` is false when
 *  the journal already held this forward, as after a repeated call. */
export type RouteOutcome =
  | { readonly ok: false; readonly reason: string }
  | {
    readonly ok: true
    readonly sessionId: string
    readonly title: string
    readonly started?: "now" | "earlier"
    readonly entries: readonly PersonEntryRef[]
    readonly recorded: boolean
  }

function parseInput(input: RuntimeToolInput): Omit<RouteInput, "leadSessionId"> & { readonly note?: string } | string {
  const { kind, chat, note, parts, earlier_turns: earlierTurns = 0 } = input
  if (kind !== "new" && kind !== "existing") return 'route_request requires kind "new" or "existing".'
  if (typeof earlierTurns !== "number" || !Number.isInteger(earlierTurns) || earlierTurns < 0) return "route_request `earlier_turns` must be a whole number, 0 or more."
  const passages = parts === undefined ? undefined
    : Array.isArray(parts) && parts.length > 0 && parts.every((part): part is string => typeof part === "string") ? parts : null
  if (passages === null) return "route_request `parts` must be a list of one or more passages of the person's messages."
  const target = typeof chat === "string" ? chat.trim() : ""
  if (kind === "existing" && !target) return 'route_request with kind "existing" requires `chat`, the id of a session.'
  if (kind === "new" && target) return 'route_request with kind "new" takes no `chat`.'
  const text = typeof note === "string" ? note.trim() : ""
  return { kind, ...(target ? { chat: target } : {}), ...(text ? { note: text } : {}), earlierTurns, ...(passages ? { parts: passages } : {}) }
}

function outcomeText(outcome: Extract<RouteOutcome, { ok: true }>, parts: readonly string[] | undefined, note: string | undefined): string {
  const target = `session ${outcome.sessionId} "${outcome.title}"`
  const words = parts ? "these parts of the person's messages" : "the person's messages"
  const lines = [
    outcome.started === "now" ? `Started ${target} with ${words}.`
      : outcome.started === "earlier" ? `These ${parts ? "parts" : "messages"} already started ${target}.`
        : `Forwarded ${words} to ${target}.`,
    ...(outcome.recorded ? [] : ["The session already had them, so nothing was sent again."]),
    parts ? "The parts, by their first line:" : "The messages, by their first line:",
    ...(parts ?? outcome.entries.map((entry) => entry.text)).map((text) => `- ${firstLineOf(text) || "(no text)"}`),
  ]
  if (note) lines.push(note)
  return lines.join("\n")
}

/** The note's line in the result: whether the chat received it. */
function noteLine(status: "delivered" | "held" | "refused" | "skipped"): string {
  switch (status) {
    case "delivered": return "Your note was delivered as a message from you."
    case "held": return "Your note waits until the session runs again."
    case "refused": return "Your note was not delivered."
    case "skipped": return "Your note was not sent again."
  }
}

/** The tool through which the lead routes a request (PI-LEAD-002, ARCH-SESSIONS-051). The runtime forwards the
 *  person's own messages of the lead's newest turn, and of `earlier_turns` earlier turns, unchanged; the model names
 *  only the target and supplies no request text. For a split request, `parts` names passages of those messages, which
 *  the runtime accepts only when the messages hold them word for word. An optional note goes after them as a message from the lead,
 *  through the kernel's session messaging. `route` answers for the calling lead. */
export function createRouteRequestTool(route: (input: RouteInput) => Promise<RouteOutcome>, sessions: SessionMessaging): RuntimeTool {
  return {
    name: ROUTE_REQUEST_TOOL_NAME,
    action: "ui_meta",
    // The lead's transcript shows the route's heading and row, so a silent route answers the person.
    answersPerson: true,
    description: "Give the person's request to a session. The runtime sends the person's own messages of your newest turn to that session unchanged, with their attachments, as messages from the person; you never write the request yourself. With kind \"new\", a new session starts with them. With kind \"existing\", they go to the session named by `chat`, any session of this project whose work the request continues, also one that find_chat found. `earlier_turns` adds the person's messages of that many earlier turns, for a request that the person stated over several turns. `parts` splits one message that asks for several separate pieces of work, such as two sessions: call route_request once for each piece, and set `parts` to the passages of the person's messages that this piece needs, each copied exactly from the person's words. The session then receives only those passages, in that order, as one message from the person with its attachments. Never write a part yourself: a part that the person's messages do not hold word for word refuses the route. Leave `parts` out when the whole message is one piece of work. `note` is your own optional message to the session, which it shows as a message from you after the person's messages: use it only for what the person's words do not hold, never to restate them. Call it only when the person asked for work, never in reaction to a session's event. The result names the session.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["new", "existing"], description: "\"new\" starts a new session; \"existing\" gives the request to an earlier session." },
        chat: { type: "string", description: "Only with kind \"existing\": the id of the session." },
        note: { type: "string", description: "Optional: your own short message to the session, sent after the person's messages. Never a restatement of the request." },
        earlier_turns: { type: "integer", minimum: 0, description: "How many earlier turns of the person to send too, oldest first. Default 0: the person's messages of your newest turn only." },
        parts: { type: "array", items: { type: "string" }, minItems: 1, description: "Only when one message asks for several separate pieces of work: the passages of the person's messages that this piece needs, each copied exactly from the person's words, in the order to send. Never a part that you wrote." },
      },
      required: ["kind"],
      additionalProperties: false,
    },
    // Two routes of one assistant message run in order, so the second reads the facts of the first.
    isConcurrencySafe: false,
    deferUntilAssistantCommitted: true,
    async execute(input, context): Promise<ToolResult> {
      const parsed = parseInput(input)
      if (typeof parsed === "string") return { content: parsed, outcome: "error" }
      const { sessionId, conversationId, toolUseId } = context
      if (!sessionId || !conversationId || !toolUseId) return { content: "route_request runs only in the lead chat.", outcome: "error" }
      const outcome = await route({ leadSessionId: sessionId, kind: parsed.kind, ...(parsed.chat ? { chat: parsed.chat } : {}), earlierTurns: parsed.earlierTurns, ...(parsed.parts ? { parts: parsed.parts } : {}) })
      if (!outcome.ok) return { content: `Not routed: ${outcome.reason}.`, outcome: "error" }
      let note: string | undefined
      if (parsed.note) {
        // A route that the journal already held sent its note the first time.
        const sent = outcome.recorded
          ? (await sessions.send({ sender: { sessionId, conversationId, toolUseId, hop: context.turnHop?.() ?? 0 }, target: "session", to: outcome.sessionId, text: parsed.note, personWords: () => undefined })).status
          : "skipped"
        note = noteLine(sent)
      }
      return { content: outcomeText(outcome, parsed.parts, note), outcome: "ok", details: { targetName: outcome.title, targetSessionId: outcome.sessionId } }
    },
  }
}
