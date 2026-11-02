import type { FrontendMessageSender } from "../app-service-types.js"
import type { ToolEntry, UserMessageBlock } from "../../infra/output-blocks.js"
import { WORKFLOW_GLYPH } from "./glyphs.js"

const RELATION_NAMES = {
  parent: "parent",
  child: "child",
  sibling: "sibling",
  other: "session",
} as const satisfies { readonly [Relation in FrontendMessageSender["relation"]]: string }

/** The header of a message row that another session sent, the same in
 *  every client: the sender's name and its relation to this session. */
export function messageSenderLabel(from: Pick<FrontendMessageSender, "name" | "relation">): string {
  return `From ${from.name} (${RELATION_NAMES[from.relation]})`
}

/** The label above the words of the person that a sender attached. */
export const PERSON_WORDS_LABEL = "From the person"

/** Formats a proven session type for a message row. Workflow types carry the shared workflow marker. */
export function messageSessionTypeLabel(type: string, workflow = false): string {
  const label = type.charAt(0).toUpperCase() + type.slice(1)
  return workflow ? `${WORKFLOW_GLYPH} ${label}` : label
}

/** A message row keeps its recorded name alone when history cannot prove a type. */
export function messageSessionLabel(name: string, typeLabel?: string): string {
  return typeLabel === undefined ? name : `${typeLabel} · ${name}`
}

/** Client-only view adapter for the shared tool disclosure. The original message remains a userMessage in history and on the wire. */
export function messageDisclosureEntry(block: Pick<UserMessageBlock, "id" | "content" | "timestamp">, from: FrontendMessageSender): ToolEntry {
  return {
    kind: "tool", id: block.id, name: "message_session", action: "ui_meta", status: "completed", timestamp: block.timestamp,
    presentation: { name: "Message from", detail: messageSessionLabel(from.name, from.typeLabel) },
    invocationBody: {
      content: from.personWords ? `${block.content}\n\n${PERSON_WORDS_LABEL}\n${from.personWords}` : block.content,
      filetype: "text", presentation: "disclosure",
    },
  }
}
