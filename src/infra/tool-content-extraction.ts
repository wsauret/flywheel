import type { UnknownRecord } from "./record.js"
import type { SessionRuntimeFact, ToolContentReferenceFact } from "./runtime-fact-types.js"
import { extractContent, TOOL_TEXT_SITES, type ToolContentRow, type ToolTextSite } from "./tool-content.js"

// Write-side counterpart of tool-content-hydration (tool output dedup). The
// mapper stays pure and inline; a durable write site applies this map just
// before record(), so the live bus and every runtime event keep full text
// while the stored fact carries a reference. Hydration lowers the emitted
// reference shape back to the matching inline fact, so the pair round-trips.

export interface ExtractedToolContentFact {
  readonly fact: SessionRuntimeFact | ToolContentReferenceFact
  /** Rides the same record() call as the fact, so the lane commits the bytes
   *  and the reference in one unit. Absent when the fact stayed inline. */
  readonly contentRows?: readonly ToolContentRow[]
}

/** Split large tool text out of one mapped runtime fact. Text over the inline
 *  threshold at a `TOOL_TEXT_SITES` site of `tool.result.recorded` or
 *  `tool.execution_output.recorded` becomes a reference and the fact version
 *  becomes 2 for legacy mutation payloads or 4 for reference-backed evidence.
 *  A fact whose texts all fit inline keeps its version with no content rows. */
export function extractToolContentFact(fact: SessionRuntimeFact): ExtractedToolContentFact {
  // Each type has its own branch, so the version-2 fact keeps its exact type.
  if (fact.type === "tool.result.recorded") {
    const split = splitToolText(TOOL_TEXT_SITES[fact.type](fact.payload))
    if (split === undefined) return { fact }
    return fact.version === 3
      ? { fact: { ...fact, version: 4, payload: { ...fact.payload, ...split.fields } }, contentRows: split.rows }
      : { fact: { ...fact, version: 2, payload: { ...fact.payload, ...split.fields } }, contentRows: split.rows }
  }
  if (fact.type === "tool.execution_output.recorded") {
    const split = splitToolText(TOOL_TEXT_SITES[fact.type](fact.payload))
    if (split === undefined) return { fact }
    return fact.version === 3
      ? { fact: { ...fact, version: 4, payload: { ...fact.payload, ...split.fields } }, contentRows: split.rows }
      : { fact: { ...fact, version: 2, payload: { ...fact.payload, ...split.fields } }, contentRows: split.rows }
  }
  return { fact }
}

/** The replacement payload fields and the content rows for the sites whose
 *  inline text is over the threshold, or undefined when every text fits. */
function splitToolText(sites: readonly ToolTextSite[]): { readonly fields: UnknownRecord; readonly rows: readonly ToolContentRow[] } | undefined {
  const fields: UnknownRecord = {}
  const rows: ToolContentRow[] = []
  for (const site of sites) {
    if (typeof site.text !== "string") continue
    const extracted = extractContent(site.text)
    if (extracted.kind === "inline") continue
    fields[site.field] = site.replace(extracted.reference)
    rows.push(extracted.row)
  }
  return rows.length === 0 ? undefined : { fields, rows: dedupedRows(rows) }
}

/** Two fields often carry the same text (display views duplicate output). The
 *  (session_id, sha256) key makes duplicate inserts no-ops anyway; deduping
 *  here just keeps the append from carrying the bytes twice. */
function dedupedRows(rows: readonly ToolContentRow[]): readonly ToolContentRow[] {
  if (rows.length < 2) return rows
  return [...new Map(rows.map((row) => [row.sha256, row])).values()]
}
