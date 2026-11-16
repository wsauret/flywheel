import { Schema } from "effect"
import type { QuestionBlock } from "../../infra/output-blocks.js"
import { defineProtocolDomain, defineProtocolModule, defineProtocolMutation, defineProtocolQuery, type ModuleComposerStatus } from "../protocol-module.js"
import type { RuntimeCursorIdentity } from "../runtime-ui-protocol-types.js"
import type { SessionCatalogRow } from "../app-service-types.js"
import { SessionCatalogRowSchema } from "../session-catalog-protocol-schemas.js"
import { QuestionBlockSchema } from "../transcript-protocol-schemas.js"

/** The workspace-scoped `lead` contract: the project's one lead chat and
 *  whether the person dismissed it, which the control placement serves, and
 *  the rows of the chats in its list, which the execution placement
 *  serves. A module that is off answers the empty views (ARCH-STRUCTURE-026). */

export const LEAD_COMMAND = "lead"
/** The command's one name. */
export const LEAD_COMMAND_NAME = "Lead"
/** The client surface that the lead command opens: it asks for the lead chat and shows it. */
export const LEAD_SURFACE = "lead"

export type LeadRowState = "question" | "failed" | "cut" | "working" | "result" | "done"

/** The states that the person sees once a chat with that state is opened. */
export type LeadSeenState = "failed" | "cut"

/** One chat of the lead's list: it needs the person, works, holds an unread result, or is done. The client joins the
 *  title from the session catalog, so the title has one source. */
export interface LeadRow {
  readonly sessionId: string
  readonly state: LeadRowState
  /** One line that the runtime derives and no model writes, at most 240 characters: for a working chat its newest
   *  tool call as the transcript sums it up, or the start of its newest text; the first line of a question or of a
   *  result, also of the read result of a done chat; `failed` and `interrupted` for the other states. */
  readonly status: string
  /** Epoch milliseconds of the newest update or state change. The client counts the age from it. */
  readonly since: number
  /** Epoch milliseconds since the chat needs the person. Present for question, failed, and cut. */
  readonly waitingSince?: number
  /** Present for state result: the entry of the final message that the person has not read. */
  readonly result?: { readonly entryId: string }
  /** Present for states failed and cut: the entry that the person sees the state at once the chat opens, which is
   *  the record that ended the turn, or the chat's newest entry when no record does. */
  readonly ended?: { readonly entryId: string }
}

/** The designation of the lead chat. */
export interface LeadView {
  readonly leadSessionId: string | null
  readonly dismissed: boolean
}

/** The rows of the chats in the lead's list. */
export interface LeadChatsView {
  readonly rows: readonly LeadRow[]
}

type LeadChatsPatchPayload =
  | { readonly kind: "lead.row.updated"; readonly row: LeadRow }
  | { readonly kind: "lead.row.removed"; readonly sessionId: string }

/** Where one question of a listed chat stands, as the lead's question widget shows it (PI-LEAD-005): pending with the
 *  form and the leading context of its call, answered with each answer as the chat's transcript states it, skipped
 *  by the person, withdrawn by the chat, or unknown to the lead. */
export type LeadQuestionOutcome =
  | { readonly state: "pending"; readonly question: QuestionBlock; readonly context: string | null }
  | { readonly state: "answered"; readonly answers: { readonly [question: string]: string } }
  | { readonly state: "skipped" | "withdrawn" | "unknown" }

/** The answer of `lead.open`: the lead chat with its catalog row and whether this open created it, or no chat while
 *  the lead is dismissed or off. The refusal is the runtime's answer when it admits no mutation, as at a stop. */
type LeadOpenResult =
  | { readonly ok: true; readonly sessionId: null }
  | { readonly ok: true; readonly sessionId: string; readonly row: SessionCatalogRow; readonly created: boolean }
  | { readonly ok: false; readonly error: string }

/** The answer of `lead.dismiss`: the dismissed chat, or null when it dismissed none. */
type LeadDismissResult =
  | { readonly ok: true; readonly sessionId: string | null }
  | { readonly ok: false; readonly error: string }

/** The designation of a module that is off, and of a project with no lead yet. */
export const EMPTY_LEAD_VIEW: LeadView = { leadSessionId: null, dismissed: false }
/** The rows of a module that is off, and of a list that holds no chat. */
export const EMPTY_LEAD_CHATS: LeadChatsView = { rows: [] }

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

const LeadRowSchema: Schema.Codec<LeadRow> = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  state: Schema.Literals(["question", "failed", "cut", "working", "result", "done"]),
  status: Schema.String,
  since: NonNegativeInt,
  waitingSince: Schema.optionalKey(NonNegativeInt),
  result: Schema.optionalKey(Schema.Struct({ entryId: Schema.NonEmptyString })),
  ended: Schema.optionalKey(Schema.Struct({ entryId: Schema.NonEmptyString })),
})

const LeadViewSchema: Schema.Codec<LeadView> = Schema.Struct({
  leadSessionId: Schema.NullOr(Schema.NonEmptyString),
  dismissed: Schema.Boolean,
})

const LeadChatsViewSchema: Schema.Codec<LeadChatsView> = Schema.Struct({ rows: Schema.Array(LeadRowSchema) })

const leadDomain = defineProtocolDomain({
  domain: "lead",
  scope: "workspace",
  // A missed patch can hide a dismissal or a new designation, so a client resnapshots.
  delivery: "durable-resnapshot",
  content: "whole-value",
  snapshot: { query: "leadSnapshot", result: Schema.Struct({ snapshotPosition: Schema.Number, view: LeadViewSchema }), deadline: "control" },
  patch: Schema.Struct({ kind: Schema.Literal("lead.changed"), leadSessionId: Schema.NullOr(Schema.NonEmptyString), dismissed: Schema.Boolean }),
  view: { snapshot: (result) => result.view, patch: (payload) => ({ leadSessionId: payload.leadSessionId, dismissed: payload.dismissed }) },
})

/** Each patch states a whole row or its removal, so the fold replaces one row in place. */
function foldRowPatch(payload: LeadChatsPatchPayload, current: LeadChatsView | undefined): LeadChatsView {
  const rows = (current ?? EMPTY_LEAD_CHATS).rows
  switch (payload.kind) {
    case "lead.row.updated": {
      const index = rows.findIndex((row) => row.sessionId === payload.row.sessionId)
      return { rows: index === -1 ? [...rows, payload.row] : rows.with(index, payload.row) }
    }
    case "lead.row.removed": return { rows: rows.filter((row) => row.sessionId !== payload.sessionId) }
  }
}

const leadChatsDomain = defineProtocolDomain({
  domain: "leadChats",
  scope: "workspace",
  // A missed patch can hide a row, so a client resnapshots.
  delivery: "durable-resnapshot",
  content: "whole-value",
  snapshot: { query: "leadChatsSnapshot", result: Schema.Struct({ snapshotPosition: Schema.Number, view: LeadChatsViewSchema }), deadline: "control" },
  patch: Schema.Union([
    Schema.Struct({ kind: Schema.Literal("lead.row.updated"), row: LeadRowSchema }),
    Schema.Struct({ kind: Schema.Literal("lead.row.removed"), sessionId: Schema.NonEmptyString }),
  ]),
  view: { snapshot: (result) => result.view, patch: foldRowPatch },
})

export const leadCursor = (): RuntimeCursorIdentity => ({ scope: "workspace", domain: leadDomain.domain })
export const leadChatsCursor = (): RuntimeCursorIdentity => ({ scope: "workspace", domain: leadChatsDomain.domain })

/** Answers the designated lead chat, and creates it when none exists. With
 *  `launch` it answers no chat while the person dismissed the lead; with
 *  `command` it ends the dismissal. */
const leadOpen = defineProtocolMutation({
  type: "lead.open",
  fields: { reason: Schema.Literals(["launch", "command"]) },
  result: Schema.Union([
    Schema.Struct({ ok: Schema.Literal(true), sessionId: Schema.Null }),
    Schema.Struct({ ok: Schema.Literal(true), sessionId: Schema.NonEmptyString, row: SessionCatalogRowSchema, created: Schema.Boolean }),
    Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
  ]) satisfies Schema.Codec<LeadOpenResult>,
  policy: "lossless",
})

/** The person closed the lead chat: a launch no longer opens it until the lead command. */
const leadDismiss = defineProtocolMutation({
  type: "lead.dismiss",
  fields: { sessionId: Schema.NonEmptyString },
  result: Schema.Union([
    Schema.Struct({ ok: Schema.Literal(true), sessionId: Schema.NullOr(Schema.NonEmptyString) }),
    Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
  ]) satisfies Schema.Codec<LeadDismissResult>,
  policy: "lossless",
})

/** Where one question of a chat stands (`LeadQuestionOutcome`). */
const leadQuestion = defineProtocolQuery({
  query: "lead.question",
  input: { sessionId: Schema.NonEmptyString, toolUseId: Schema.NonEmptyString },
  result: Schema.Union([
    Schema.Struct({ state: Schema.Literal("pending"), question: QuestionBlockSchema, context: Schema.NullOr(Schema.String) }),
    Schema.Struct({ state: Schema.Literal("answered"), answers: Schema.Record(Schema.String, Schema.String) }),
    Schema.Struct({ state: Schema.Literals(["skipped", "withdrawn", "unknown"]) }),
  ]) satisfies Schema.Codec<LeadQuestionOutcome>,
  deadline: "control",
})

/** The person read a listed chat's result up to `entryId`, so its row no longer holds that result. */
const leadResultMarkRead = defineProtocolMutation({
  type: "lead.result.mark_read",
  fields: { sessionId: Schema.NonEmptyString, entryId: Schema.NonEmptyString },
  result: Schema.Union([Schema.Struct({ ok: Schema.Literal(true) }), Schema.Struct({ ok: Schema.Literal(false), error: Schema.String })]),
  policy: "lossless",
})

/** The person opened a listed chat whose row is failed or cut at `entryId`, so the row shows that state no more until
 *  the chat changes state again. */
const leadChatMarkSeen = defineProtocolMutation({
  type: "lead.chat.mark_seen",
  fields: { sessionId: Schema.NonEmptyString, state: Schema.Literals(["failed", "cut"]), entryId: Schema.NonEmptyString },
  result: Schema.Union([Schema.Struct({ ok: Schema.Literal(true) }), Schema.Struct({ ok: Schema.Literal(false), error: Schema.String })]),
  policy: "lossless",
})

const NEEDS_PERSON: ReadonlySet<LeadRowState> = new Set(["question", "failed", "cut"])
const GROUP = { question: 0, failed: 0, cut: 0, working: 1, result: 2, done: 3 } as const satisfies { readonly [state in LeadRowState]: number }

/** The rows in list order: the chats that need the person first, the longest wait first, then the working chats, then
 *  the unread results, then the done chats, each of those three groups newest first. */
export function leadRowOrder(rows: readonly LeadRow[]): readonly LeadRow[] {
  return rows.toSorted((left, right) => GROUP[left.state] - GROUP[right.state]
    || (NEEDS_PERSON.has(left.state) ? (left.waitingSince ?? left.since) - (right.waitingSince ?? right.since) : right.since - left.since))
}

const REPORT_CALL_PREFIX = "lead-report:"
const QUESTION_CALL_PREFIX = "lead-question:"
const ENTRY_LINK_PREFIX = "flywheel://lead/chat/"

/** The sending id of the message by which the runtime posts a listed chat's report, its final message `entryId`, to
 *  the lead (PI-LEAD-006). The lead's clients know a report by it. */
export function leadReportCall(entryId: string): string {
  return `${REPORT_CALL_PREFIX}${entryId}`
}

/** The sending id of the message by which the runtime posts a listed chat's question, its ask_user call `toolUseId`,
 *  to the lead (PI-LEAD-005). The lead's clients show a question widget for it. */
export function leadQuestionCall(toolUseId: string): string {
  return `${QUESTION_CALL_PREFIX}${toolUseId}`
}

/** The ask_user call that a question message names; undefined for any other message. */
export function leadQuestionEntry(message: { readonly id: string; readonly from: { readonly sessionId: string } }): string | undefined {
  const call = sessionMessageCall(message)
  return call?.startsWith(QUESTION_CALL_PREFIX) ? call.slice(QUESTION_CALL_PREFIX.length) || undefined : undefined
}

/** The sending call of a message from another session, read from the entry id `msg:<sender>:<call>` that the message
 *  holds; undefined for any other message. A chat's own `message_session` call is its tool use. */
export function sessionMessageCall(message: { readonly id: string; readonly from: { readonly sessionId: string } }): string | undefined {
  const prefix = `msg:${message.from.sessionId}:`
  return message.id.startsWith(prefix) ? message.id.slice(prefix.length) || undefined : undefined
}

/** The final message entry that a report names; undefined for any other message. */
export function leadReportEntry(message: { readonly id: string; readonly from: { readonly sessionId: string } }): string | undefined {
  const call = sessionMessageCall(message)
  return call?.startsWith(REPORT_CALL_PREFIX) ? call.slice(REPORT_CALL_PREFIX.length) || undefined : undefined
}

/** Whether an entry id names a message from another session, `msg:<sender>:<call>`: a report, or a message that a
 *  chat sent with `message_session`, such as a milestone (PI-LEAD-006). No person asked for it, so it starts a turn of
 *  its own in the lead's transcript. */
export function isSessionMessageEntry(entryId: string): boolean {
  return entryId.startsWith("msg:")
}

/** The link of a line that opens a chat at one entry, such as a report's final message or the call that sent a
 *  message. */
export function leadEntryLink(sessionId: string, entryId: string): string {
  return `${ENTRY_LINK_PREFIX}${encodeURIComponent(sessionId)}/${encodeURIComponent(entryId)}`
}

export function parseLeadEntryLink(uri: string): { readonly sessionId: string; readonly entryId: string } | undefined {
  if (!uri.startsWith(ENTRY_LINK_PREFIX)) return undefined
  const [sessionId, entryId, ...rest] = uri.slice(ENTRY_LINK_PREFIX.length).split("/")
  return sessionId && entryId && rest.length === 0 ? { sessionId: decodeURIComponent(sessionId), entryId: decodeURIComponent(entryId) } : undefined
}

/** The number of listed chats that need the person: a question, a failure, or a cut. */
export function leadNeedsPerson(view: LeadChatsView): number {
  return view.rows.filter((row) => NEEDS_PERSON.has(row.state)).length
}

/** The count of chats that need the person, as every view shows it; none at zero. */
function leadCountLabel(view: LeadChatsView | undefined): string | undefined {
  const count = view ? leadNeedsPerson(view) : 0
  return count === 0 ? undefined : count === 1 ? "1 needs you" : `${count} need you`
}

/** The count of chats that need the person, on the composer border of every view. */
function leadComposerStatus(view: LeadChatsView | undefined): readonly ModuleComposerStatus[] {
  const text = leadCountLabel(view)
  return text === undefined ? [] : [{ id: "lead", text, tone: "warning" }]
}

/** The part of the contract that the module's control part answers, so the first tab never waits for the executor
 *  (ARCH-STRUCTURE-045). */
export const leadDesignationProtocol = defineProtocolModule({ id: "lead", domains: [leadDomain], mutations: [leadOpen, leadDismiss] })

/** The part of the contract that the module's execution service answers. */
export const leadChatsProtocol = defineProtocolModule({ id: "lead", domains: [leadChatsDomain], queries: [leadQuestion], mutations: [leadResultMarkRead, leadChatMarkSeen] })

export const leadProtocol = defineProtocolModule({
  id: "lead",
  domains: [...leadDesignationProtocol.domains, ...leadChatsProtocol.domains],
  queries: leadChatsProtocol.queries,
  mutations: [...leadDesignationProtocol.mutations, ...leadChatsProtocol.mutations],
  composer: { status: (read) => leadComposerStatus(read(leadChatsDomain)) },
})
