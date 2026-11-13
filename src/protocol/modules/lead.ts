import { Schema } from "effect"
import { defineProtocolDomain, defineProtocolModule, defineProtocolMutation, type ModuleComposerStatus } from "../protocol-module.js"
import type { RuntimeCursorIdentity } from "../runtime-ui-protocol-types.js"
import type { SessionCatalogRow } from "../app-service-types.js"
import { SessionCatalogRowSchema } from "../session-catalog-protocol-schemas.js"

/** The workspace-scoped `lead` contract: the project's one lead chat and
 *  whether the person dismissed it, which the control placement serves, and
 *  the rows of the chats that it started, which the execution placement
 *  serves. A module that is off answers the empty views (ARCH-STRUCTURE-026). */

export const LEAD_COMMAND = "lead"
/** The command's one name. */
export const LEAD_COMMAND_NAME = "Lead"
/** The client surface that the lead command opens: it asks for the lead chat and shows it. */
export const LEAD_SURFACE = "lead"

export type LeadRowState = "question" | "failed" | "cut" | "working" | "result"

/** One started chat that needs the person, works, or holds an unread result. The client joins the title from the
 *  session catalog, so the title has one source. */
export interface LeadRow {
  readonly sessionId: string
  readonly state: LeadRowState
  /** The first line of the chat's newest assistant text, at most 240 characters. */
  readonly update: string | null
  /** Epoch milliseconds of the newest update or state change. The client counts the age from it. */
  readonly since: number
  /** Epoch milliseconds since the chat needs the person. Present for question, failed, and cut. */
  readonly waitingSince?: number
  /** The newest message of the person in that chat: its entry and its text, at most 400 characters. */
  readonly request: { readonly entryId: string; readonly text: string } | null
  /** The last five update lines, oldest first. */
  readonly updates: readonly { readonly text: string; readonly at: number }[]
  /** Present for state question. The form itself comes from the kernel question view of the session. */
  readonly question?: { readonly toolUseId: string; readonly context: string | null }
  /** Present for state failed: the entry of the crash record, or null for an open turn that has no record. */
  readonly failure?: { readonly entryId: string | null }
  /** Present for state result: the entry of the final message that the person has not read. */
  readonly result?: { readonly entryId: string }
}

/** The designation of the lead chat. */
export interface LeadView {
  readonly leadSessionId: string | null
  readonly dismissed: boolean
}

/** The rows of the chats that the lead started. */
export interface LeadChatsView {
  readonly rows: readonly LeadRow[]
}

type LeadChatsPatchPayload =
  | { readonly kind: "lead.row.updated"; readonly row: LeadRow }
  | { readonly kind: "lead.row.removed"; readonly sessionId: string }

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
/** The rows of a module that is off, and of a lead that started no chat. */
export const EMPTY_LEAD_CHATS: LeadChatsView = { rows: [] }

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

const LeadRowSchema: Schema.Codec<LeadRow> = Schema.Struct({
  sessionId: Schema.NonEmptyString,
  state: Schema.Literals(["question", "failed", "cut", "working", "result"]),
  update: Schema.NullOr(Schema.String),
  since: NonNegativeInt,
  waitingSince: Schema.optionalKey(NonNegativeInt),
  request: Schema.NullOr(Schema.Struct({ entryId: Schema.NonEmptyString, text: Schema.String })),
  updates: Schema.Array(Schema.Struct({ text: Schema.String, at: NonNegativeInt })),
  question: Schema.optionalKey(Schema.Struct({ toolUseId: Schema.NonEmptyString, context: Schema.NullOr(Schema.String) })),
  failure: Schema.optionalKey(Schema.Struct({ entryId: Schema.NullOr(Schema.NonEmptyString) })),
  result: Schema.optionalKey(Schema.Struct({ entryId: Schema.NonEmptyString })),
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

/** The person read a started chat's result up to `entryId`, so its row no longer holds that result. */
const leadResultMarkRead = defineProtocolMutation({
  type: "lead.result.mark_read",
  fields: { sessionId: Schema.NonEmptyString, entryId: Schema.NonEmptyString },
  result: Schema.Union([Schema.Struct({ ok: Schema.Literal(true) }), Schema.Struct({ ok: Schema.Literal(false), error: Schema.String })]),
  policy: "lossless",
})

const NEEDS_PERSON: ReadonlySet<LeadRowState> = new Set(["question", "failed", "cut"])
const GROUP = { question: 0, failed: 0, cut: 0, working: 1, result: 2 } as const satisfies { readonly [state in LeadRowState]: number }

/** The rows in list order: the chats that need the person first, the longest wait first, then the working chats, then
 *  the unread results, each of those two groups newest first. */
export function leadRowOrder(rows: readonly LeadRow[]): readonly LeadRow[] {
  return rows.toSorted((left, right) => GROUP[left.state] - GROUP[right.state]
    || (NEEDS_PERSON.has(left.state) ? (left.waitingSince ?? left.since) - (right.waitingSince ?? right.since) : right.since - left.since))
}

/** The number of started chats that need the person: a question, a failure, or a cut. */
export function leadNeedsPerson(view: LeadChatsView): number {
  return view.rows.filter((row) => NEEDS_PERSON.has(row.state)).length
}

/** The chat that has waited longest for the person, which one key opens; none while no chat needs the person. */
export function leadLongestWaiting(view: LeadChatsView): LeadRow | undefined {
  const first = leadRowOrder(view.rows)[0]
  return first && NEEDS_PERSON.has(first.state) ? first : undefined
}

/** The count of chats that need the person, as every view shows it; none at zero. */
export function leadCountLabel(view: LeadChatsView | undefined): string | undefined {
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
export const leadChatsProtocol = defineProtocolModule({ id: "lead", domains: [leadChatsDomain], mutations: [leadResultMarkRead] })

export const leadProtocol = defineProtocolModule({
  id: "lead",
  domains: [...leadDesignationProtocol.domains, ...leadChatsProtocol.domains],
  mutations: [...leadDesignationProtocol.mutations, ...leadChatsProtocol.mutations],
  composer: { status: (read) => leadComposerStatus(read(leadChatsDomain)) },
})
