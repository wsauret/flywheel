import { Result, Schema } from "effect"
import { contentEvidence } from "./content-evidence.js"
import { InvariantViolation } from "./invariant.js"
import { isRecord, type UnknownRecord } from "./record.js"
import type { ToolContentReferenceFact } from "./runtime-fact-types.js"

/** Texts at or under this UTF-8 byte count stay inline in their durable
 *  payload. Most tool results are small, so inlining keeps the common read
 *  local; only larger texts pay the content-row indirection. The dedup spec's
 *  measurement task may tune this value. */
export const TOOL_CONTENT_INLINE_MAX_BYTES = 2048

/** Stored shape of a tool-content reference: what a durable payload stores
 *  instead of large tool text. The identity resolves the bytes (per session,
 *  by sha256); bytes and preview are display evidence, so previews and search
 *  never need the content row. */
export const ToolContentReferenceSchema = Schema.Struct({
  sha256: Schema.NonEmptyString,
  bytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  preview: Schema.String,
})

export type ToolContentReference = typeof ToolContentReferenceSchema.Type

const decodeReference = Schema.decodeUnknownResult(ToolContentReferenceSchema, { onExcessProperty: "error" })

/** The value as a well-formed reference, or undefined for inline text and
 *  any other value. */
function asToolContentReference(value: unknown): ToolContentReference | undefined {
  const decoded = decodeReference(value)
  return Result.isSuccess(decoded) ? decoded.success : undefined
}

/** The value at a tool-text site: inline text, or the reference that
 *  replaced it. */
type ToolContentText = string | ToolContentReference

/** One position in a tool fact payload that can hold large tool text. */
export interface ToolTextSite {
  /** The inline text or the reference at the position. */
  readonly text: ToolContentText
  /** The top-level payload field that holds the position. Each site of one
   *  payload has its own field, so a caller can replace every site at once. */
  readonly field: string
  /** The new value of `field`, with `text` at the position. */
  replace(text: ToolContentText): ToolContentText | UnknownRecord
}

/** Where each reference-capable tool fact type holds large tool text. The
 *  writer extraction puts references only at these sites, and the hydration
 *  and the page reader look for references only at these sites. All three
 *  walk this one table, so they cannot disagree. The fact version that can
 *  hold a reference comes from `TOOL_CONTENT_REFERENCE_FACT_DEFINITIONS`.
 *  A field of any other fact never names a content row, even when it has the
 *  reference shape, for example the content evidence of `handoff.written`. */
export const TOOL_TEXT_SITES = {
  "tool.result.recorded": (payload: UnknownRecord) => [...fieldSite(payload, "content"), ...displayContentSite(payload.details)],
  "tool.execution_output.recorded": (payload: UnknownRecord) => fieldSite(payload, "output"),
} satisfies { readonly [Type in ToolContentReferenceFact["type"]]: (payload: UnknownRecord) => ToolTextSite[] }

function fieldSite(payload: UnknownRecord, field: string): ToolTextSite[] {
  const text = asToolContentText(payload[field])
  return text === undefined ? [] : [{ text, field, replace: (next) => next }]
}

/** The text site of a tool result's `details`: `displayContent` itself (the
 *  string view of search) or `displayContent.text` (the `{ text, startLine }`
 *  view of read). `details` is opaque at the fact schema, so the site is
 *  found by its structure. */
function displayContentSite(details: unknown): ToolTextSite[] {
  if (!isRecord(details)) return []
  const displayContent = details.displayContent
  const direct = asToolContentText(displayContent)
  if (direct !== undefined) return [{ text: direct, field: "details", replace: (text) => ({ ...details, displayContent: text }) }]
  if (!isRecord(displayContent)) return []
  const nested = asToolContentText(displayContent.text)
  if (nested === undefined) return []
  return [{ text: nested, field: "details", replace: (text) => ({ ...details, displayContent: { ...displayContent, text } }) }]
}

function asToolContentText(value: unknown): ToolContentText | undefined {
  return typeof value === "string" ? value : asToolContentReference(value)
}

/** Durable toolResult entry content part carrying a reference instead of
 *  inline text. Lives beside the inline `{ type: "text" }` part in the stored
 *  chat-entry schema; the conversation fold and the FTS insert seam resolve it
 *  back to an inline text part, so no consumer past those seams sees it. */
export const ToolContentReferencePartSchema = Schema.Struct({
  type: Schema.Literal("text_reference"),
  ...ToolContentReferenceSchema.fields,
})

/** One row of the session-scoped `tool_content` sidecar table: the canonical
 *  bytes a reference resolves to. The row carries no session id because it
 *  rides an `EventStoreAppend`, whose sessionId scopes it; one shape cannot
 *  name another session's content. */
export interface ToolContentRow {
  readonly sha256: string
  readonly content: string
  readonly bytes: number
}

export type ExtractedToolContent =
  | { readonly kind: "inline"; readonly text: string }
  | { readonly kind: "reference"; readonly reference: ToolContentReference; readonly row: ToolContentRow }

/** Split tool text at the inline threshold: text at or under it stays inline
 *  in its payload; larger text becomes a reference plus the content row the
 *  carrying append must persist with it. The preview follows the same policy
 *  as every fact writer's content evidence. */
export function extractContent(text: string): ExtractedToolContent {
  const evidence = contentEvidence(text)
  if (evidence.bytes <= TOOL_CONTENT_INLINE_MAX_BYTES) return { kind: "inline", text }
  return {
    kind: "reference",
    reference: { sha256: evidence.sha256, bytes: evidence.bytes, preview: evidence.preview },
    row: { sha256: evidence.sha256, content: text, bytes: evidence.bytes },
  }
}

/** Read side of the sidecar: the exact text for a session-scoped reference,
 *  or null when no content row exists for (sessionId, sha256). */
export interface ContentResolver {
  resolve(sessionId: string, sha256: string): string | null
}

/** Where a reference was read from, for the canonical invariant a failed
 *  resolution throws. Matches the identity fields of a StoredFact. */
export interface ToolContentFactIdentity {
  readonly eventType: string
  readonly eventPosition: number
  readonly aggregateId: string
}

/** Read one reference's stored bytes without proving them. A missing content
 *  row is Flywheel-owned durable state that broke its own promise and throws
 *  the canonical InvariantViolation. The cross-process read port ships bytes
 *  this way; proving them belongs to the reader's hydration seam below. */
export function readToolContentReference(
  toolContent: ContentResolver,
  sessionId: string,
  reference: ToolContentReference,
  at: ToolContentFactIdentity,
): string {
  const content = toolContent.resolve(sessionId, reference.sha256)
  if (content === null) {
    throw new InvariantViolation({
      kind: "missing-producer-event",
      eventType: at.eventType,
      eventPosition: at.eventPosition,
      aggregateId: at.aggregateId,
      detail: `tool content row ${reference.sha256} is missing for session ${sessionId}`,
    })
  }
  return content
}

/** Resolve one reference to its exact bytes and prove them. This is the
 *  reader's one verification point for referenced text: every durable reader
 *  hydrates through it, while pages and the read port carry bytes unverified,
 *  so a sha256 or byte-count mismatch surfaces exactly where the text is used,
 *  as the canonical InvariantViolation rather than a silent fall back to the
 *  preview. */
export function resolveToolContentReference(
  toolContent: ContentResolver,
  sessionId: string,
  reference: ToolContentReference,
  at: ToolContentFactIdentity,
): string {
  const content = readToolContentReference(toolContent, sessionId, reference, at)
  const evidence = contentEvidence(content)
  if (evidence.sha256 !== reference.sha256 || evidence.bytes !== reference.bytes) {
    throw new InvariantViolation({
      kind: "schema-mismatch",
      eventType: at.eventType,
      eventPosition: at.eventPosition,
      aggregateId: at.aggregateId,
      detail: `tool content row for ${reference.sha256} resolved to sha256 ${evidence.sha256} (${evidence.bytes} bytes, expected ${reference.bytes})`,
    })
  }
  return content
}

const decodeReferencePart = Schema.decodeUnknownResult(ToolContentReferencePartSchema, { onExcessProperty: "error" })

/** The writer gate for referenced text (ARCH-BOUNDARIES-004): admit the reference
 * positions supported by persisted chat entries and prove, once at append,
 * that each referenced row landed in this commit unit and matches its
 * reference. Only tool-result text parts can carry content references. The
 * resolver must see rows written in the append transaction before this check
 * runs. Readers prove the bytes again at the hydration seam because durable
 * state outlives the writer; nothing between the two proves them a third time. */
export function assertChatEntriesToolContentReferences(
  payload: unknown,
  toolContent: ContentResolver,
  sessionId: string,
  at: ToolContentFactIdentity,
): void {
  for (const part of chatEntryReferenceParts(payload)) {
    const reference = referencePartReference(part)
    if (reference === undefined) {
      throw new InvariantViolation({
        kind: "schema-mismatch",
        eventType: at.eventType,
        eventPosition: at.eventPosition,
        aggregateId: at.aggregateId,
        detail: "chat entry tool-content reference part is malformed",
      })
    }
    resolveToolContentReference(toolContent, sessionId, reference, at)
  }
}

/** The reference of one `text_reference` content part, or undefined when
 *  the part is malformed. This strict decode is the one parser of reference
 *  parts: the write gate, the page reader, and the search index all use it,
 *  so a part that one of them rejects, the others reject too. */
export function referencePartReference(part: unknown): ToolContentReference | undefined {
  const decoded = decodeReferencePart(part)
  if (Result.isFailure(decoded)) return undefined
  const { sha256, bytes, preview } = decoded.success
  return { sha256, bytes, preview }
}

/** The well-formed references of a `chat.entries.appended` payload: the
 *  reference parts that the write gate above proves. A malformed part holds
 *  no reference here, because the hydration of that fact reports it. */
export function chatEntryToolContentReferences(payload: unknown): ToolContentReference[] {
  return [...chatEntryReferenceParts(payload)].flatMap((part) => {
    const reference = referencePartReference(part)
    return reference === undefined ? [] : [reference]
  })
}

/** The reference parts of the toolResult entries of a chat payload, not yet
 *  decoded. Only a toolResult text part can become a reference part.
 *  @yields {unknown} one `text_reference` part, in entry and part order. */
function* chatEntryReferenceParts(payload: unknown): Generator<unknown> {
  if (!isRecord(payload) || !Array.isArray(payload.entries)) return
  for (const entry of payload.entries) {
    if (!isRecord(entry) || entry.kind !== "message" || !isRecord(entry.message) || entry.message.kind !== "toolResult") continue
    if (!Array.isArray(entry.message.content)) continue
    for (const part of entry.message.content) {
      if (isRecord(part) && part.type === "text_reference") yield part
    }
  }
}
