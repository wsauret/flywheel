import type { PersonEntryRef } from "../../session/conversation/person-entries.js"
import type { SessionMessaging } from "../../session/session-messaging.js"
import type { RuntimeTool, RuntimeToolInput, ToolResult } from "../../agent-runtime/tools/types.js"

export const ROUTE_REQUEST_TOOL_NAME = "route_request"

/** What the lead names for one route: the lead chat, the target, and how many earlier turns of the person go too. */
export interface RouteInput {
  readonly leadSessionId: string
  readonly kind: "new" | "existing"
  /** The target of an `existing` route. */
  readonly chat?: string
  readonly earlierTurns: number
}

/** What one route did. `started` is `now` when this call started the chat, `earlier` when the same entries started
 *  it before, and absent for a route to a chat in the lead's list. `recorded` is false when
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

function parseInput(input: RuntimeToolInput): { readonly kind: "new" | "existing"; readonly chat?: string; readonly note?: string; readonly earlierTurns: number } | string {
  const { kind, chat, note, earlier_turns: earlierTurns = 0 } = input
  if (kind !== "new" && kind !== "existing") return 'route_request requires kind "new" or "existing".'
  if (typeof earlierTurns !== "number" || !Number.isInteger(earlierTurns) || earlierTurns < 0) return "route_request `earlier_turns` must be a whole number, 0 or more."
  const target = typeof chat === "string" ? chat.trim() : ""
  if (kind === "existing" && !target) return 'route_request with kind "existing" requires `chat`, the id of a chat in your list.'
  if (kind === "new" && target) return 'route_request with kind "new" takes no `chat`.'
  const text = typeof note === "string" ? note.trim() : ""
  return { kind, ...(target ? { chat: target } : {}), ...(text ? { note: text } : {}), earlierTurns }
}

function outcomeText(outcome: Extract<RouteOutcome, { ok: true }>, note: string | undefined): string {
  const target = `chat ${outcome.sessionId} "${outcome.title}"`
  const lines = [
    outcome.started === "now" ? `Started ${target} with the person's messages.`
      : outcome.started === "earlier" ? `These messages already started ${target}.`
        : `Forwarded the person's messages to ${target}.`,
    ...(outcome.recorded ? [] : ["The chat already had them, so nothing was sent again."]),
    "The messages, by their first line:",
    ...outcome.entries.map((entry) => `- ${entry.firstLine || "(no text)"}`),
  ]
  if (note) lines.push(note)
  return lines.join("\n")
}

/** The note's line in the result: whether the chat received it. */
function noteLine(status: "delivered" | "held" | "refused" | "skipped"): string {
  switch (status) {
    case "delivered": return "Your note was delivered as a message from you."
    case "held": return "Your note waits until the chat runs again."
    case "refused": return "Your note was not delivered."
    case "skipped": return "Your note was not sent again."
  }
}

/** The tool through which the lead routes a request (PI-LEAD-002, ARCH-SESSIONS-051). The runtime forwards the
 *  person's own messages of the lead's newest turn, and of `earlier_turns` earlier turns, unchanged; the model names
 *  only the target and supplies no request text. An optional note goes after them as a message from the lead,
 *  through the kernel's session messaging. `route` answers for the calling lead. */
export function createRouteRequestTool(route: (input: RouteInput) => Promise<RouteOutcome>, sessions: SessionMessaging): RuntimeTool {
  return {
    name: ROUTE_REQUEST_TOOL_NAME,
    action: "ui_meta",
    // The lead's transcript shows the route's heading and row, so a silent route answers the person.
    answersPerson: true,
    description: "Give the person's request to a chat. The runtime sends the person's own messages of your newest turn to that chat unchanged, with their attachments, as messages from the person; you never write the request yourself. With kind \"new\", a new chat starts with them. With kind \"existing\", they go to a chat in your list, named by `chat`, when the request belongs to that chat's work. `earlier_turns` adds the person's messages of that many earlier turns, for a request that the person stated over several turns. `note` is your own optional message to the chat, which it shows as a message from you after the person's messages: use it only for what the person's words do not hold, never to restate them. Call it only when the person asked for work, never in reaction to a chat's event. The result names the chat.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["new", "existing"], description: "\"new\" starts a new chat; \"existing\" gives the request to a chat in your list." },
        chat: { type: "string", description: "Only with kind \"existing\": the id of a chat in your list." },
        note: { type: "string", description: "Optional: your own short message to the chat, sent after the person's messages. Never a restatement of the request." },
        earlier_turns: { type: "integer", minimum: 0, description: "How many earlier turns of the person to send too, oldest first. Default 0: the person's messages of your newest turn only." },
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
      const outcome = await route({ leadSessionId: sessionId, kind: parsed.kind, ...(parsed.chat ? { chat: parsed.chat } : {}), earlierTurns: parsed.earlierTurns })
      if (!outcome.ok) return { content: `Not routed: ${outcome.reason}.`, outcome: "error" }
      let note: string | undefined
      if (parsed.note) {
        // A route that the journal already held sent its note the first time.
        const sent = outcome.recorded
          ? (await sessions.send({ sender: { sessionId, conversationId, toolUseId, hop: context.turnHop?.() ?? 0 }, target: "session", to: outcome.sessionId, text: parsed.note, personWords: () => undefined })).status
          : "skipped"
        note = noteLine(sent)
      }
      return { content: outcomeText(outcome, note), outcome: "ok", details: { targetName: outcome.title } }
    },
  }
}
