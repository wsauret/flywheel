import { createMemo, Show, useContext } from "solid-js"
import { Key } from "@solid-primitives/keyed"

import type { FrontendToolEntry } from "../../../src/protocol/app-service-types.js"
import { rowPresentation } from "../../../src/protocol/client/file-change-body.js"
import { readRowLabel, readRowPath, type RunRow } from "../../../src/protocol/client/tool-run-category.js"
import { RowTime, TranscriptClock } from "./row-time.js"
import { blockIdentity } from "../../../src/protocol/block-identity.js"

/** What a tool row says it acted on. A read names its file by basename in
 *  every row it can appear in, alone with a disclosure, compact inside a
 *  group, or merged with its neighbours, the same rule the terminal applies;
 *  a row that changed how it named a file as calls arrived would read as a
 *  different call. Every other tool shows its presentation's detail. */
export function toolRowDetail(tool: FrontendToolEntry, active: boolean): string {
  const { detail } = rowPresentation(tool, active)
  if (tool.runCategoryOverride === "execute") return detail.replace(/\s+/g, " ")
  return tool.action === "file_read" ? readRowLabel(tool) : detail
}

/** One operation with no body to open: a read inside a run, or any call a
 *  subagent made. It takes the disclosure row's layout without the hover
 *  surface, names the tool and what it acted on, and pulses its marker while
 *  the call runs. A merged read run is one of these rows naming every file.
 *  With `onOpenFile`, each file a read names is a link that opens it. A
 *  preview row (`inPreview`) takes no focus of its own and keeps its time in
 *  view while it runs, as a running heading does. */
export function CompactToolRow(props: { row: RunRow; onOpenFile?: ((path: string) => void) | undefined; inPreview?: boolean; hideTime?: boolean; endOf?: (id: string) => number | undefined }) {
  const clock = useContext(TranscriptClock)
  const timestamp = createMemo(() => props.row.kind === "readRun" ? props.row.members[0]!.timestamp : props.row.timestamp)
  const identity = createMemo(() => blockIdentity(props.row.kind === "readRun" ? props.row.members.at(-1)! : props.row))
  const running = createMemo(() => props.row.status === "pending" || props.row.status === "streaming" || props.row.status === "active" || (clock?.running?.(identity()) ?? false))
  const end = createMemo(() => (props.endOf ?? clock?.end)?.(identity()))
  const errorMessage = () => (props.row.status === "error" ? props.row.errorMessage : undefined)
  const statusMessage = () => (props.row.status === "blocked" ? props.row.statusMessage : undefined)
  const exitCode = () => (props.row.kind === "tool" ? props.row.exitCode : undefined)
  const detail = () => (props.row.kind === "tool" ? toolRowDetail(props.row, running()) : props.row.presentation.detail)
  // The files a read row names, each with the path that opens it. A row that
  // is not a read of a file keeps its plain detail.
  const readFiles = () => {
    const reads = props.row.kind === "readRun" ? props.row.members : [props.row]
    const files = reads.map((read) => ({ id: blockIdentity(read), label: readRowLabel(read), path: readRowPath(read) }))
    return files.some((file) => file.path !== undefined) ? files : undefined
  }
  const name = () => props.row.kind === "tool" ? rowPresentation(props.row, running()).name : props.row.presentation.name
  const linkedFiles = () => props.onOpenFile === undefined || !detail() ? undefined : readFiles()
  const focusable = () => !props.inPreview && !linkedFiles()?.some(file => file.path !== undefined)
  const label = () => [name(), linkedFiles()?.map(file => file.label).join(", ") ?? detail(), exitCode() !== undefined && exitCode() !== 0 ? `exit ${exitCode()}` : undefined].filter(Boolean).join(" ")
  return (
    <div class="block tool chain compact" classList={{ [`status-${props.row.status}`]: true, "execute-summary": props.row.kind === "tool" && props.row.runCategoryOverride === "execute" }}>
      <div class="disclosure static" tabIndex={focusable() ? 0 : undefined} aria-label={focusable() ? label() : undefined}>
        <span class="chevron"><span class="marker-dot" classList={{ live: running() }} /></span>
        <span class="tool-title">{name()}</span>
        <Show when={detail()}>
          <span class="tool-detail" classList={{ "tool-detail-error": props.row.status === "error" }}>
            <Show when={linkedFiles()} fallback={detail()}>
              {(files) => <Key each={files()} by="id">{(file, index) => <>
                {index() > 0 ? ", " : ""}
                <Show when={file().path} fallback={file().label}>
                  {(path) => <button class="tool-file-link" title="Open this file in the editor" onClick={() => props.onOpenFile?.(path())}>{file().label}</button>}
                </Show>
              </>}</Key>}
            </Show>
          </span>
        </Show>
        <Show when={exitCode() !== undefined && exitCode() !== 0}><span class="exit-code">exit {exitCode()}</span></Show>
        <Show when={!props.hideTime}>
          <RowTime timestamp={timestamp()} running={running()} always={props.inPreview === true && running()} end={end()} inline />
        </Show>
      </div>
      <Show when={errorMessage()}>{(message) => <div class="tool-error">{message()}</div>}</Show>
      <Show when={statusMessage()}>{(message) => <div class="tool-notice">{message()}</div>}</Show>
    </div>
  )
}
