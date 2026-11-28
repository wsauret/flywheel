import { fg as stFg, type RGBA, type TextChunk } from "@opentui/core"
import type { SessionCatalogRow } from "../../../protocol/runtime/app-service-types.js"
import type { GroupedChat, SessionListGroup } from "../../../protocol/client/session/session-list-groups.js"
import type { StoppedChat } from "../../../protocol/session/unread-protocol-types.js"
import type { ChatTurnEnding } from "../../../protocol/session/chat-settlement-protocol-types.js"
import type { PickerFoundRow, PickerRow, PickerSessionRow } from "./picker-types.js"

export interface DiffStatChunkColors {
  readonly success: RGBA
  readonly warning: RGBA
  readonly error: RGBA
  readonly muted: RGBA
}

/** The picker's rows for chats in the places that `groupSessionList` gives
 *  them: a heading above each group that has a chat, and a spacer between
 *  groups (PI-INTERACTION-184). */
export function flattenSessionRows(grouped: readonly GroupedChat<SessionCatalogRow>[]): PickerRow[] {
  const flattened: PickerRow[] = []
  let group: SessionListGroup | undefined
  for (const { row, group: next, lastActiveAt, stopped } of grouped) {
    if (next !== group) {
      if (group !== undefined) flattened.push({ kind: "header", id: `spacer:${next}`, label: "" })
      flattened.push({ kind: "header", id: `header:${next}`, label: next })
      group = next
    }
    flattened.push({ kind: "session", id: row.id, session: row, group: next, lastActiveAt, ...(stopped ? { stopped } : {}) })
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

/** The terminal lines a picker row takes: a chat found by its messages adds
 *  its matching words and, when known, where it stands, and a chat that
 *  stopped unread adds what it stopped with. */
export function pickerRowLines(row: PickerRow): number {
  if (row.kind === "found") return row.found.excerpt ? 3 : 2
  return row.kind === "session" && row.stopped && stopDetail(row.stopped) !== undefined ? 2 : 1
}

/** When a row's chat was last active, in milliseconds: the time that its
 *  place gives a listed chat, and a found chat's newest entry, which the
 *  search read, or else the catalog's last update. */
export function pickerRowLastActive(row: PickerSessionRow | PickerFoundRow): number {
  if (row.kind === "session") return row.lastActiveAt
  return row.found.lastActivityAt ?? new Date(row.session.lastUpdated).getTime()
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
