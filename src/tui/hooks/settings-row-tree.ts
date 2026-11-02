import type { ModalDisclosureItem, ModalDisclosureNode } from "../components/modal-disclosure.js"
import type { SettingsInteractiveRow, SettingsRow, SettingsVisibleRow } from "./settings-modal-types.js"

export function settingsRowDirectMatchScore(row: SettingsInteractiveRow, query: string): number | undefined {
  const label = row.label.toLowerCase()
  if (label.startsWith(query)) return 0
  if (label.includes(query)) return 1
  return row.description?.toLowerCase().includes(query) ? 2 : undefined
}

function settingsRowMatchScore(row: SettingsInteractiveRow, query: string): number | undefined {
  const direct = settingsRowDirectMatchScore(row, query)
  if (direct !== undefined) return direct
  if ((row.kind === "group" || row.kind === "disclosure") && row.rows().some((child) => child.kind !== "separator" && settingsRowMatchScore(child, query) !== undefined)) return 3
  return undefined
}

type SettingsNode = ModalDisclosureNode<SettingsRow>

function settingsNodes(rows: readonly SettingsRow[]): SettingsNode[] {
  return rows.map((row) => row.kind === "disclosure"
    ? { item: row, disclosure: { id: row.id, interaction: "disclosure-only", children: settingsNodes(row.rows()) } }
    : { item: row })
}

function matchingSettingsNode(row: SettingsInteractiveRow, query: string): { node: SettingsNode; score: number } | undefined {
  const direct = settingsRowDirectMatchScore(row, query)
  if (row.kind !== "disclosure") {
    const score = settingsRowMatchScore(row, query)
    return score === undefined ? undefined : { node: { item: row }, score }
  }
  const children = direct === undefined ? rankedSettingsNodes(row.rows(), query) : settingsNodes(row.rows())
  const childMatches = children.some((child) => child.item.kind !== "separator")
  if (direct === undefined && !childMatches) return undefined
  return { node: { item: row, disclosure: { id: row.id, interaction: "disclosure-only", children } }, score: direct ?? 3 }
}

/** Ranks matches within their original sections and retains matching disclosures. */
export function rankedSettingsNodes(rows: readonly SettingsRow[], rawQuery: string): readonly SettingsNode[] {
  const query = rawQuery.trim().toLowerCase()
  if (query === "") return settingsNodes(rows)
  const result: SettingsNode[] = []
  let heading: Extract<SettingsRow, { kind: "separator" }> | undefined
  let section: { node: SettingsNode; score: number; index: number }[] = []
  let index = 0
  const flush = (): void => {
    if (section.length === 0) return
    if (heading !== undefined) result.push({ item: heading })
    result.push(...section.toSorted((left, right) => left.score - right.score || left.index - right.index).map((match) => match.node))
    section = []
  }
  for (const row of rows) {
    if (row.kind === "separator") { flush(); heading = row; continue }
    const match = matchingSettingsNode(row, query)
    if (match !== undefined) section.push({ ...match, index })
    index++
  }
  flush()
  return result
}

export function disclosureIds(nodes: readonly SettingsNode[]): Set<string> {
  const ids = new Set<string>()
  for (const node of nodes) {
    if (node.disclosure === undefined) continue
    ids.add(node.disclosure.id)
    for (const id of disclosureIds(node.disclosure.children)) ids.add(id)
  }
  return ids
}

export function settingsVisibleRows(rows: readonly ModalDisclosureItem<SettingsRow>[]): SettingsVisibleRow[] {
  return rows.map((row) => {
    if (row.kind !== "disclosure") return row
    if (row.disclosure === undefined) throw new Error(`Settings disclosure row is missing presentation state: ${row.id}`)
    return { ...row, disclosure: row.disclosure }
  })
}

export function findSettingsRow(rows: readonly SettingsRow[], id: string): SettingsInteractiveRow | undefined {
  for (const row of rows) {
    if (row.kind === "separator") continue
    if (row.id === id) return row
    if (row.kind === "group" || row.kind === "disclosure") {
      const child = findSettingsRow(row.rows(), id)
      if (child !== undefined) return child
    }
  }
  return undefined
}
