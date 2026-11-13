import { Schema } from "effect"
import { defineProtocolDomain, defineProtocolModule, defineProtocolMutation } from "../protocol-module.js"
import type { RuntimeCursorIdentity } from "../runtime-ui-protocol-types.js"

/** The workspace-scoped `lead` contract: the project's one lead chat, whether
 *  the person dismissed it, and the rows of the chats that it started. A
 *  module that is off answers the empty view (ARCH-STRUCTURE-026). */

export const LEAD_COMMAND = "lead"
/** The command's one name. */
export const LEAD_COMMAND_NAME = "Lead"

type LeadRowState = "question" | "failed" | "cut" | "working" | "result"

interface LeadRow {
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

export interface LeadView {
  readonly leadSessionId: string | null
  readonly dismissed: boolean
  readonly rows: readonly LeadRow[]
}

type LeadPatchPayload = { readonly kind: "lead.changed"; readonly leadSessionId: string | null; readonly dismissed: boolean }

/** The answer of `lead.open` and `lead.dismiss`: the chat that the mutation opened or dismissed, or null when it did
 *  neither. The refusal is the runtime's answer when it admits no mutation, as at a stop. */
type LeadMutationResult =
  | { readonly ok: true; readonly sessionId: string | null }
  | { readonly ok: false; readonly error: string }

/** The view of a module that is off, and of a project with no lead yet. */
export const EMPTY_LEAD_VIEW: LeadView = { leadSessionId: null, dismissed: false, rows: [] }

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
  rows: Schema.Array(LeadRowSchema),
})

const LeadPatchPayloadSchema: Schema.Codec<LeadPatchPayload> = Schema.Struct({
  kind: Schema.Literal("lead.changed"),
  leadSessionId: Schema.NullOr(Schema.NonEmptyString),
  dismissed: Schema.Boolean,
})

const LeadMutationResultSchema: Schema.Codec<LeadMutationResult> = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), sessionId: Schema.NullOr(Schema.NonEmptyString) }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
])

const leadDomain = defineProtocolDomain({
  domain: "lead",
  scope: "workspace",
  // A missed patch can hide a dismissal or a new designation, so a client resnapshots.
  delivery: "durable-resnapshot",
  content: "whole-value",
  snapshot: { query: "leadSnapshot", result: Schema.Struct({ snapshotPosition: Schema.Number, view: LeadViewSchema }), deadline: "control" },
  patch: LeadPatchPayloadSchema,
  view: {
    snapshot: (result) => result.view,
    patch: (payload, current) => ({ rows: current?.rows ?? [], leadSessionId: payload.leadSessionId, dismissed: payload.dismissed }),
  },
})

export const leadCursor = (): RuntimeCursorIdentity => ({ scope: "workspace", domain: leadDomain.domain })

/** Answers the designated lead chat, and creates it when none exists. With
 *  `launch` it answers no chat while the person dismissed the lead; with
 *  `command` it ends the dismissal. */
const leadOpen = defineProtocolMutation({
  type: "lead.open",
  fields: { reason: Schema.Literals(["launch", "command"]) },
  result: LeadMutationResultSchema,
  policy: "lossless",
})

/** The person closed the lead chat: a launch no longer opens it until the lead command. */
const leadDismiss = defineProtocolMutation({
  type: "lead.dismiss",
  fields: { sessionId: Schema.NonEmptyString },
  result: LeadMutationResultSchema,
  policy: "lossless",
})

export const leadProtocol = defineProtocolModule({
  id: "lead",
  domains: [leadDomain],
  mutations: [leadOpen, leadDismiss],
})
