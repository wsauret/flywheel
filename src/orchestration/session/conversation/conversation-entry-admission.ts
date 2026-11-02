import type { StoredFact } from "../../../infra/event-store-types.js"
import { InvariantViolation, type InvariantKind } from "../../../infra/invariant.js"
import type { DegradedBlock } from "../../../infra/output-blocks.js"
import type { ConversationEntry } from "./conversation-entry-types.js"
import type { DegradedEntrySource, SalvagedConversationEntry } from "./conversation-facts.js"

/** What the admission of later entries reads of one accepted entry: its
 *  parent, and whether it is a tool result or an assistant message with its
 *  tool calls. A reader that keeps only links keeps no message text. */
export interface EntryLink {
  readonly parentId: string | null
  readonly kind: "assistant" | "toolResult" | "other"
  /** The ids of the tool_use blocks of an assistant message whose content
   *  is blocks; absent for any other entry. */
  readonly toolUseIds?: readonly string[]
}

export function entryLink(entry: ConversationEntry): EntryLink {
  if (entry.kind !== "message" || (entry.message.kind !== "assistant" && entry.message.kind !== "toolResult")) return { parentId: entry.parentId, kind: "other" }
  if (entry.message.kind === "toolResult") return { parentId: entry.parentId, kind: "toolResult" }
  const content = entry.message.content
  return { parentId: entry.parentId, kind: "assistant", ...(Array.isArray(content) ? { toolUseIds: content.flatMap((block) => block.type === "tool_use" ? [block.id] : []) } : {}) }
}

/** Where admission stands before a batch: the leaf that the accepted
 *  entries moved to, and whether some earlier entry could not be decoded. */
export interface AdmissionFrontier {
  readonly leafId: string | null
  readonly unreadable: boolean
}

/** The decision for one item of an appended batch. An accepted entry carries
 *  the parent that recovery gave it and its display-only mark; a degraded
 *  item carries the leaf that its gap anchors to. */
type EntryAdmission =
  | { readonly kind: "accepted"; readonly entry: ConversationEntry; readonly link: EntryLink; readonly ordinal: number }
  | { readonly kind: "degraded"; readonly source: DegradedEntrySource; readonly anchorLeafId: string | null; readonly failureClass: DegradedBlock["failureClass"] }

/** The decisions for one batch, in item order, and the frontier after it. */
interface BatchAdmission {
  readonly admissions: readonly EntryAdmission[]
  readonly frontier: AdmissionFrontier
}

/** Decides, in order, which items of one appended batch the conversation
 *  accepts: an undecodable item is a gap that makes later missing parents
 *  continue the recovered branch, and a disconnected, duplicate, or orphan
 *  entry is a structural gap. `linkOf` answers for the entries accepted
 *  before this batch; the entries this batch accepts are visible to its later
 *  items. Every reader of a conversation's accepted entries decides through
 *  this one rule, so a reader that keeps only links counts what the tree
 *  holds. Nothing is changed: the caller applies the decisions.
 *  @throws {InvariantViolation} When a tool result names a call that its
 *  assistant message does not hold. */
export function admitEntries(
  event: StoredFact,
  items: readonly (ConversationEntry | SalvagedConversationEntry)[],
  linkOf: (id: string) => EntryLink | undefined,
  frontier: AdmissionFrontier,
): BatchAdmission {
  const accepted = new Map<string, EntryLink>()
  const link = (id: string | null) => id === null ? undefined : accepted.get(id) ?? linkOf(id)
  let { leafId, unreadable } = frontier
  // The admitted items are already hydrated, so a structural gap takes its
  // entry from the fact as stored: a tool-content reference stays a reference.
  const storedEntries = typeof event.payload === "object" && event.payload !== null && "entries" in event.payload && Array.isArray(event.payload.entries) ? event.payload.entries : []
  const admissions: EntryAdmission[] = []
  for (const [index, item] of items.entries()) {
    if (item.kind === "degraded") {
      admissions.push({ kind: "degraded", source: item.source, anchorLeafId: leafId, failureClass: "decode_failure" })
      unreadable = true
      continue
    }
    let entry = item.kind === "entry" ? item.entry : item
    const ordinal = item.kind === "entry" ? item.ordinal : index
    if (unreadable) entry = continuedAfterUnreadable(entry, link, leafId)
    entry = displayOnlyHistoricalFinalizedResult(entry, link)
    if (isDisconnected(entry, link) || link(entry.id) || isOrphanToolResult(entry, link, event)) {
      admissions.push({ kind: "degraded", source: { ordinal, sourceEntryId: entry.id, ...(entry.parentId ? { sourceParentId: entry.parentId } : {}), raw: storedEntries[ordinal] }, anchorLeafId: leafId, failureClass: "structural_violation" })
      continue
    }
    const acceptedLink = entryLink(entry)
    accepted.set(entry.id, acceptedLink)
    admissions.push({ kind: "accepted", entry, link: acceptedLink, ordinal })
    leafId = entry.kind === "leaf" ? entry.targetId : entry.id
  }
  return { admissions, frontier: { leafId, unreadable } }
}

type LinkLookup = (id: string | null) => EntryLink | undefined

/** An entry whose parent was lost to an unreadable row continues the
 *  recovered branch from the last readable entry, so the readable history
 *  after a gap stays in the transcript and in model context. Only the
 *  recovered view reads the new parent: the stored entry keeps its own, and
 *  the gap row stays in front of it. A tool result keeps its gap, because
 *  its call was in the lost part and a result without its call is no
 *  valid exchange. */
function continuedAfterUnreadable(entry: ConversationEntry, link: LinkLookup, leafId: string | null): ConversationEntry {
  if (entry.kind === "leaf" || entry.parentId === null || link(entry.parentId)) return entry
  if (entry.kind === "message" && entry.message.kind === "toolResult") return entry
  return { ...entry, parentId: leafId }
}

/** The assistant message that a tool result answers: the first ancestor
 *  past the chain of tool results under it. */
function answeredAssistant(entry: ConversationEntry, link: LinkLookup): EntryLink | undefined {
  let parent = link(entry.parentId)
  while (parent?.kind === "toolResult") parent = link(parent.parentId)
  return parent?.kind === "assistant" ? parent : undefined
}

function displayOnlyHistoricalFinalizedResult(entry: ConversationEntry, link: LinkLookup): ConversationEntry {
  if (entry.kind !== "message" || entry.message.kind !== "toolResult" || !entry.id.startsWith("ftr-")) return entry
  const toolUseIds = answeredAssistant(entry, link)?.toolUseIds
  if (toolUseIds === undefined || toolUseIds.includes(entry.message.toolUseId)) return entry
  // Event 13001163 established that finalized-result recovery before
  // 2026-09-19 could append a stale checkpoint beneath another call's
  // assistant. Preserve immutable history for display, but exclude that
  // deterministic derivative from model context.
  // Remove this rule after support for stores written before that date ends.
  return { ...entry, displayOnly: true }
}

function isDisconnected(entry: ConversationEntry, link: LinkLookup): boolean {
  return (entry.parentId !== null && !link(entry.parentId))
    || (entry.kind === "leaf" && entry.targetId !== null && !link(entry.targetId))
}

function isOrphanToolResult(entry: ConversationEntry, link: LinkLookup, event: StoredFact): boolean {
  if (entry.kind !== "message" || entry.message.kind !== "toolResult") return false
  const toolUseIds = answeredAssistant(entry, link)?.toolUseIds
  if (toolUseIds === undefined || toolUseIds.length === 0) return true
  if (!toolUseIds.includes(entry.message.toolUseId)) {
    if (entry.displayOnly === true && entry.id.startsWith("ftr-")) return false
    throw chatTreeViolation(event, "orphan-event", `tool result ${entry.message.toolUseId} conflicts with preceding tool identity`)
  }
  return false
}

export function chatTreeViolation(event: StoredFact, kind: InvariantKind, detail: string): InvariantViolation {
  return new InvariantViolation({
    kind,
    eventType: event.type,
    eventPosition: event.position,
    aggregateId: event.aggregateId,
    detail,
  })
}
