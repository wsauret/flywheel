import { Key } from "@solid-primitives/keyed"
import { createMemo, mergeProps, Show, type Accessor } from "solid-js"
import type { FrontendOutputBlock } from "../../../src/protocol/app-service-types.js"
import { foldReadRuns } from "../../../src/protocol/client/tool-run-category.js"
import { createWebTranscript, rowIdentity, type PresentedWebBlock } from "../client/tool-runs.js"
import { Block, type BlockProps, createToolPresentation } from "./blocks.js"
import { CompactToolRow } from "./compact-tool-row.js"
import { ToolGroupBlock } from "./tool-group.js"

type FullRowsProps = Omit<BlockProps, "block"> & { compact?: false }
type CompactRowsProps = {
  compact: true
  onOpenFile?: (path: string) => void
  endOf?: (id: string) => number | undefined
}

/** Render raw blocks through the web transcript fold and presentation.
 * Compact cards show only the operations, with no process controls. */
export function TranscriptRows(props: (FullRowsProps | CompactRowsProps) & {
  blocks: readonly FrontendOutputBlock[]
  showThinking: boolean
}) {
  const present = createWebTranscript()
  const view = createMemo(() => present(props.blocks, props.showThinking))
  const compact = () => props.compact === true ? props : undefined
  const full = () => props.compact !== true ? props : undefined
  const compactRows = createMemo(() => {
    if (!compact()) return []
    const calls = view().rows.flatMap(row => row.kind === "toolGroup" ? row.children : row.kind === "tool" ? [row] : [])
    return foldReadRuns(calls)
  })
  return <>
    <Show when={compact()}>{options =>
      <Key each={compactRows()} by={rowIdentity}>{row => <CompactToolRow row={row()}
        onOpenFile={options().onOpenFile} endOf={options().endOf} />}</Key>
    }</Show>
    <Show when={full()}>{options =>
      <Key each={view().rows} by={rowIdentity}>{(row, index) => {
        const group = () => { const current = row(); return current.kind === "toolGroup" ? current : undefined }
        const block = () => { const current = row(); return current.kind !== "toolGroup" ? current : undefined }
        const renderBlock = (entry: Accessor<PresentedWebBlock>, inlineTime = false) =>
          <Block {...options()} block={entry()} inlineTime={inlineTime} />
        return <>
          <Show when={view().boundaryBefore[index()] === true}><div class="work-divider" /></Show>
          <div class="row" data-block={rowIdentity(row())}>
            <Show when={group()}>{run => <ToolGroupBlock group={run()} tailCanGrow={false}
              sessionId={options().sessionId} disclosure={options().disclosure} processStatus={options().processStatus}
              onOpenFile={options().canOpenFiles ? path => options().onOpenFile(path) : undefined}
              row={renderBlock} presentation={(entry, key) => createToolPresentation(mergeProps(options, {
                get entry() { return entry() },
                get disclosureId() { return key() },
              }))} />}</Show>
            <Show when={block()}>{entry => renderBlock(entry)}</Show>
          </div>
        </>
      }}</Key>
    }</Show>
  </>
}
