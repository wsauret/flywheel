import { Key } from "@solid-primitives/keyed"
import { createMemo } from "solid-js"
import type { FrontendOutputBlock } from "../../../src/protocol/app-service-types.js"
import { foldReadRuns } from "../../../src/protocol/client/tool-run-category.js"
import { foldTranscript } from "../../../src/protocol/client/transcript-model.js"
import { rowIdentity, stretchCalls } from "../client/tool-runs.js"
import { CompactToolRow } from "./compact-tool-row.js"

/** A card's operations as compact rows with no process controls: the calls of
 *  every tool stretch in order, with consecutive reads folded into one row. */
export function CompactToolRows(props: {
  blocks: readonly FrontendOutputBlock[]
  onOpenFile?: (path: string) => void
  endOf?: (id: string) => number | undefined
}) {
  const rows = createMemo(() => foldReadRuns(foldTranscript(props.blocks, false).rows.flatMap(row => row.kind === "toolStretch" ? stretchCalls(row) : [])))
  return <Key each={rows()} by={rowIdentity}>{row => <CompactToolRow row={row()} onOpenFile={props.onOpenFile} endOf={props.endOf} />}</Key>
}
