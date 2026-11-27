import { fg as stFg, type RGBA, type TextChunk } from "@opentui/core"
import type { SessionCatalogRow } from "../../../protocol/runtime/app-service-types.js"
import type { NeedsYou } from "../../../protocol/client/session/needs-you.js"
import type { StoppedChat } from "../../../protocol/session/unread-protocol-types.js"
import type { ChatTurnEnding } from "../../../protocol/session/chat-settlement-protocol-types.js"
import type { PickerFoundRow, PickerRow, PickerSessionRow } from "./picker-types.js"

export interface DiffStatChunkColors {
  readonly success: RGBA
  readonly warning: RGBA
  readonly error: RGBA
  readonly muted: RGBA
}

/** The heading of the chats that need the person, which lead the list. */
export const NEEDS_YOU_GROUP = "Needs you"

/** Lists the chats that need the person first, in the order of `needsYou`:
 *  the chats that wait on a question, then the chats that stopped unread,
 *  newest first within each kind. Every other chat follows in its group by
 *  the date it started (PI-INTERACTION-184). */
export function flattenSessionRows(
  rows: readonly SessionCatalogRow[],
  now: Date | number = Date.now(),
  needsYou: NeedsYou["rows"] = [],
): PickerRow[] {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const needing = needsYou.flatMap((need) => {
    const session = byId.get(need.sessionId)
    return session ? [sessionRow(session, NEEDS_YOU_GROUP, need.kind === "stopped" ? need.stopped : undefined)] : []
  })
  const needingIds = new Set(needing.map((row) => row.session.id))
  const roots = rows.filter((row) => !needingIds.has(row.id)).sort(byStartedDesc)

  const flattened: PickerRow[] = []
  if (needing.length > 0) {
    flattened.push({ kind: "header", id: `header:${NEEDS_YOU_GROUP}`, label: NEEDS_YOU_GROUP }, ...needing)
  }
  let currentCategory = ""

  for (const root of roots) {
    const category = dateGroup(startedAt(root), now)
    if (category !== currentCategory) {
      currentCategory = category
      if (flattened.length > 0) {
        flattened.push({ kind: "header", id: `spacer:${category}`, label: "" })
      }
      flattened.push({ kind: "header", id: `header:${category}`, label: category })
    }
    flattened.push(sessionRow(root, category))
  }

  return flattened
}

export function formatCompactTimeAgo(nowMs: number, thenMs: number): string {
  const elapsedMs = Math.max(0, nowMs - thenMs)
  const minutes = Math.floor(elapsedMs / 60_000)
  const hours = Math.floor(minutes / 60)
  const days = Math.floor(hours / 24)
  const weeks = Math.floor(days / 7)
  const months = Math.floor(days / 30)

  if (minutes < 1) return "1m"
  if (minutes < 60) return `${minutes}m`
  if (hours < 24) return `${hours}h`
  if (days < 7) return `${days}d`
  if (weeks <= 4) return `${weeks}w`
  return `${months}mo`
}

export function parseSessionIdQuery(query: string, knownIds: ReadonlySet<string>): string | null {
  const trimmed = query.trim()
  return knownIds.has(trimmed) ? trimmed : null
}

export function timeAgoColumnWidth(labels: readonly string[]): number {
  let width = 0
  for (const label of labels) width = Math.max(width, label.length)
  return width
}

export function buildDiffStatChunks(
  diffStats: SessionCatalogRow["diffStats"],
  colors: DiffStatChunkColors,
): TextChunk[] {
  const { added, modified, removed } = diffStats ?? { added: 0, modified: 0, removed: 0 }
  const allZero = added === 0 && modified === 0 && removed === 0
  const success = allZero ? colors.muted : colors.success
  const warning = allZero ? colors.muted : colors.warning
  const error = allZero ? colors.muted : colors.error

  return [
    stFg(success)(`+${added}`),
    stFg(colors.muted)(" "),
    stFg(warning)(`~${modified}`),
    stFg(colors.muted)(" "),
    stFg(error)(`-${removed}`),
  ]
}

function byStartedDesc(a: SessionCatalogRow, b: SessionCatalogRow): number {
  return new Date(startedAt(b)).getTime() - new Date(startedAt(a)).getTime()
}

function startedAt(session: SessionCatalogRow): string {
  return session.createdAt ?? session.lastUpdated
}

function dateGroup(input: string, now: Date | number): string {
  const date = new Date(input)
  const today = new Date(now)
  const yesterday = new Date(today)
  yesterday.setDate(today.getDate() - 1)

  if (date.toDateString() === today.toDateString()) return "Today"
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday"
  return date.toDateString()
}

function sessionRow(session: SessionCatalogRow, category: string, stopped?: StoppedChat): PickerSessionRow {
  return { kind: "session", id: session.id, session, category, stopped }
}

/** The terminal lines a picker row takes: a chat found by its messages adds
 *  its matching words and, when known, where it stands, and a chat that
 *  stopped unread adds what it stopped with. */
export function pickerRowLines(row: PickerRow): number {
  if (row.kind === "found") return row.found.excerpt ? 3 : 2
  return row.kind === "session" && row.stopped && stopDetail(row.stopped) !== undefined ? 2 : 1
}

/** When a row's chat was last active, in milliseconds: the stop of a chat
 *  that stopped unread, a found chat's newest entry, which the search read,
 *  or else the catalog's last update. */
export function pickerRowLastActive(row: PickerSessionRow | PickerFoundRow): number {
  if (row.kind === "session" && row.stopped) return row.stopped.stoppedAt
  return row.kind === "found" && row.found.lastActivityAt !== undefined ? row.found.lastActivityAt : new Date(row.session.lastUpdated).getTime()
}

type TurnFailureKind = Extract<ChatTurnEnding, { readonly kind: "failed" }>["failure"]

/** The words for each way a run fails, as the person reads them. */
const FAILURE_WORDS = {
  local_persistence_error: "Could not save the conversation",
  context_overflow: "The conversation is too long for the model",
  output_overflow: "The answer was longer than the model allows",
  api_error: "The model provider returned an error",
  model_unavailable: "The model is not available",
  transient_disconnect: "The connection to the model provider dropped",
  stream_stalled: "The model stopped responding",
  api_overloaded: "The model provider is overloaded",
} as const satisfies { readonly [kind in TurnFailureKind]: string }

/** What a stopped chat stopped with: the first line of its final message,
 *  or the words for its error. None for a final message with no text. */
export function stopDetail(stopped: StoppedChat): string | undefined {
  const { ending } = stopped
  if (ending.kind === "failed") return FAILURE_WORDS[ending.failure]
  if (ending.kind === "refused") return "The model provider refused the conversation"
  return stopped.firstLine || undefined
}
