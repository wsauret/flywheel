import { fg as stFg, type RGBA, type TextChunk } from "@opentui/core"
import type { SessionCatalogRow } from "../../protocol/app-service-types.js"
import type { PickerRow, PickerSessionRow } from "./picker-types.js"

export interface DiffStatChunkColors {
  readonly success: RGBA
  readonly warning: RGBA
  readonly error: RGBA
  readonly muted: RGBA
}

export function flattenSessionRows(
  rows: readonly SessionCatalogRow[],
  now: Date | number = Date.now(),
): PickerRow[] {
  const roots = [...rows].sort(byStartedDesc)

  const flattened: PickerRow[] = []
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

function sessionRow(
  session: SessionCatalogRow,
  category: string,
): PickerSessionRow {
  return {
    kind: "session",
    id: session.id,
    session,
    category,
  }
}
