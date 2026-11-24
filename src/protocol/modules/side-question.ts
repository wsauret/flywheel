import { Schema } from "effect"
import { defineProtocolDomain, defineProtocolModule, defineProtocolMutation, type DomainReader } from "../protocol-module.js"
import type { RuntimeCursorIdentity } from "../runtime/runtime-ui-protocol-types.js"

export const SIDE_QUESTION_SURFACE = "side-question"
export const SIDE_QUESTION_COMMAND = "btw"
/** The command's one name, which its surface also heads with. */
export const SIDE_QUESTION_COMMAND_NAME = "Side question"

/** Temporary session-owned answers. Source context and provider credentials never cross this boundary. */
export interface SideQuestionExchange {
  readonly id: string
  readonly question: string
  readonly answer: string
}

export interface SideQuestionRequest extends SideQuestionExchange {
  readonly state: "running" | "done" | "error" | "stopped"
  readonly error?: string
}

export interface SideQuestionView {
  readonly revision: number
  readonly exchanges: readonly SideQuestionExchange[]
  readonly current: SideQuestionRequest | null
}

type SideQuestionHistoryView = Pick<SideQuestionView, "revision" | "exchanges">
type SideQuestionRequestView = Pick<SideQuestionView, "current">

/** One change to the request a client holds: the whole request, or text that
 *  the running answer gained. */
type SideQuestionRequestPatch =
  | { readonly kind: "side-question-request.changed"; readonly view: SideQuestionRequestView | null }
  | { readonly kind: "side-question-request.appended"; readonly text: string }

export type SideQuestionResult = { readonly ok: true; readonly requestId?: string; readonly destinationSessionId?: string } | { readonly ok: false; readonly error: string }

const exchangeFields = { id: Schema.NonEmptyString, question: Schema.String, answer: Schema.String }
const historySchema: Schema.Codec<SideQuestionHistoryView> = Schema.Struct({
  revision: Schema.Number,
  exchanges: Schema.Array(Schema.Struct(exchangeFields)),
})
const requestSchema: Schema.Codec<SideQuestionRequestView> = Schema.Struct({
  current: Schema.NullOr(Schema.Struct({
    ...exchangeFields, state: Schema.Literals(["running", "done", "error", "stopped"]), error: Schema.optionalKey(Schema.String),
  })),
})
const requestPatchSchema: Schema.Codec<SideQuestionRequestPatch> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("side-question-request.changed"), view: Schema.NullOr(requestSchema) }),
  Schema.Struct({ kind: Schema.Literal("side-question-request.appended"), text: Schema.String }),
])
const resultSchema: Schema.Codec<SideQuestionResult> = Schema.Union([
  Schema.Struct({ ok: Schema.Literal(true), requestId: Schema.optionalKey(Schema.NonEmptyString), destinationSessionId: Schema.optionalKey(Schema.NonEmptyString) }),
  Schema.Struct({ ok: Schema.Literal(false), error: Schema.String }),
])

const sideQuestionDomain = defineProtocolDomain({
  domain: "side-question",
  scope: "session",
  delivery: "latest-collapsible",
  content: "whole-value",
  snapshot: {
    query: "sideQuestionSnapshot",
    result: Schema.Struct({ snapshotPosition: Schema.Number, view: Schema.NullOr(historySchema) }),
    deadline: "control",
  },
  patch: Schema.Struct({ kind: Schema.Literal("side-question.changed"), view: Schema.NullOr(historySchema) }),
  view: { snapshot: (result) => result.view, patch: (payload) => payload.view },
})

/** Folds one request patch into the view a client holds. The host appends
 *  only to the running request, and cursor intake applies patches in order
 *  and reads the snapshot again after a gap, so an append extends the
 *  request the client holds. */
function foldRequestPatch(payload: SideQuestionRequestPatch, held: SideQuestionRequestView | undefined): SideQuestionRequestView | null {
  if (payload.kind === "side-question-request.changed") return payload.view
  const current = held?.current
  return current ? { current: { ...current, answer: current.answer + payload.text } } : held ?? null
}

const sideQuestionRequestDomain = defineProtocolDomain({
  domain: "side-question-request",
  scope: "session",
  // A running answer ships as appended text, so each patch is a change and a
  // client that missed one reads the request again.
  delivery: "durable-resnapshot",
  content: "change",
  snapshot: {
    query: "sideQuestionRequestSnapshot",
    result: Schema.Struct({ snapshotPosition: Schema.Number, view: Schema.NullOr(requestSchema) }),
    deadline: "control",
  },
  patch: requestPatchSchema,
  view: { snapshot: (result) => result.view, patch: foldRequestPatch },
})

/** Derives the aggregate without retaining client-owned history. History admission gates visibility. */
export function readSideQuestionView(read: DomainReader): SideQuestionView | undefined {
  const history = read(sideQuestionDomain)
  return history ? { ...history, current: read(sideQuestionRequestDomain)?.current ?? null } : undefined
}

export const sideQuestionCursor = (sessionId: string): RuntimeCursorIdentity => ({ scope: "session", sessionId, domain: sideQuestionDomain.domain })
export const sideQuestionRequestCursor = (sessionId: string): RuntimeCursorIdentity => ({ scope: "session", sessionId, domain: sideQuestionRequestDomain.domain })

const session = { sessionId: Schema.NonEmptyString }
/** Stop and Close address a displayed request. Clear compares the displayed revision. Stale actions change nothing. */
export const sideQuestionProtocol = defineProtocolModule({
  id: "side-question",
  domains: [sideQuestionDomain, sideQuestionRequestDomain],
  mutations: [
    defineProtocolMutation({ type: "side-question.ask", fields: { ...session, question: Schema.NonEmptyString }, result: resultSchema }),
    defineProtocolMutation({ type: "side-question.stop", fields: { ...session, requestId: Schema.NonEmptyString }, result: resultSchema }),
    defineProtocolMutation({ type: "side-question.clear", fields: { ...session, revision: Schema.Number }, result: resultSchema }),
    defineProtocolMutation({ type: "side-question.keep", fields: { ...session, exchangeId: Schema.NonEmptyString }, result: resultSchema }),
  ],
})
