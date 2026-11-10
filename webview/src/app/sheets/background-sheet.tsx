import { createMemo, createSignal, Show, type Accessor } from "solid-js"
import { keyedRows } from "../keyed-rows.js"

import type { BackgroundWorkRow } from "../../../../src/protocol/background-index-protocol-types.js"
import {
  backgroundIndexEntries,
  backgroundRowDetail,
  canStopBackgroundRow,
  stopBackgroundRow,
  type BackgroundIndexFilter,
  type BackgroundIndexEntry,
} from "../../../../src/protocol/client/background-index.js"
import { actionKey } from "../../client/action-key.js"
import { useClient } from "../client-context.js"
import { SheetEmpty, SheetLoading, SheetRow } from "./sheet.js"
import { WorkspaceSurface } from "../workspace-surface.js"
import { useClientExtensions } from "../client-extensions.js"
import { KERNEL_COMMAND_NAMES } from "../../../../src/protocol/command-names.js"

/** The background index of the selected chat, as the terminal's `/bg` modal
 *  lists it: the chat's background commands and every child it started, in
 *  the order they started, a nested child under the child that started it.
 *  The runtime answers the rows from durable facts, so a long chat that loads
 *  lazily still lists work whose card is outside the loaded window. The
 *  client follows the index from the chat's selection, so the sheet opens on
 *  held rows and row patches change them in place. A tap
 *  lands on the row's card, a child opens with Open or Enter, and Stop ends
 *  the launching call after a confirmation. */

const TAIL_LINES = 6
const FILTER_KEY = "flywheel.background.filter"

/** The Active or All choice of this browser. A host with no storage, or
 *  one that denies it, keeps the choice for the life of the page. */
function readFilter(): BackgroundIndexFilter {
  try {
    return localStorage.getItem(FILTER_KEY) === "all" ? "all" : "active"
  } catch {
    return "active"
  }
}

function writeFilter(filter: BackgroundIndexFilter): void {
  try {
    localStorage.setItem(FILTER_KEY, filter)
  } catch {
    // Storage denied: the choice lasts for this page and no longer.
  }
}

function tailOf(text: string | undefined): readonly string[] {
  if (!text) return []
  return text.replace(/\r?\n$/, "").split(/\r?\n/).slice(-TAIL_LINES)
}

export function BackgroundSheet(props: { readonly docked?: boolean; readonly onClose?: () => void } = {}) {
  const client = useClient()
  const extensions = useClientExtensions()
  const state = client.state
  const [filter, setFilter] = createSignal(readFilter())
  const chatId = () => state().sessionId
  const index = () => state().backgroundIndex
  const rows = createMemo<readonly BackgroundWorkRow[]>(() => {
    const current = index()
    return current !== undefined && "rows" in current ? current.rows ?? [] : []
  })
  const entries = createMemo(() => backgroundIndexEntries(rows(), filter()))
  const choose = (next: BackgroundIndexFilter) => {
    setFilter(next)
    writeFilter(next)
  }
  const tail = (row: BackgroundWorkRow) => row.kind === "command" && row.status === "running" ? tailOf(state().streamingToolText[row.id]?.content) : []
  const land = (row: BackgroundWorkRow) => {
    const sessionId = chatId()
    if (sessionId === undefined) return
    if (!props.docked) client.closeSheet()
    void client.actions.openAround(sessionId, row.cardToolUseId).then((blockId) => client.markBlock(blockId))
  }
  const open = (row: BackgroundWorkRow) => {
    const destination = row.target
    if (destination === undefined) return
    if (!props.docked) client.closeSheet()
    if (destination.kind !== "session") {
      extensions.some(extension => extension.openTarget?.(destination))
      return
    }
    const sessionId = destination.sessionId
    // The chat that lists the row is the place Back returns to.
    const link = { label: row.title, parentSessionId: chatId() }
    if (client.stack) client.stack.openChat(sessionId, link)
    else client.actions.selectSession(sessionId, link)
  }
  const select = (row: BackgroundWorkRow) => {
    if (row.kind === "command" && row.target !== undefined) open(row)
    else land(row)
  }
  const stop = (row: BackgroundWorkRow) => {
    void client.confirm({ title: `Stop ${row.title}?`, detail: "The work ends now. Its output so far stays in the transcript.", confirmLabel: "Stop", destructive: true })
      .then((confirmed) => {
        if (confirmed) void client.actions.run(actionKey("stop-tool", row.id), () => stopBackgroundRow(client.connection, row))
      })
  }
  const empty = () => {
    const current = index()
    if (current?.status === "error") return `Flywheel could not read the background work: ${current.error}`
    return rows().length === 0 ? "No background work in this chat." : "No active background work. Choose All to see finished work."
  }
  const renderEntry = (entry: Accessor<BackgroundIndexEntry>) => (
    <div class="background-row" classList={{ "background-row-done": entry().dimmed }} style={{ "--background-depth": entry().depth }}>
      <SheetRow label={entry().row.title} detail={backgroundRowDetail(entry().row)} onClick={() => select(entry().row)} onEnter={entry().row.target === undefined ? undefined : () => open(entry().row)}>
        <Show when={entry().row.target !== undefined}>
          <button class="tool-action" onClick={(event) => { event.stopPropagation(); open(entry().row) }}>Open</button>
        </Show>
        <Show when={canStopBackgroundRow(entry().row)}>
          <button class="tool-action" aria-busy={client.actions.working(actionKey("stop-tool", entry().row.id)) || undefined} onClick={(event) => { event.stopPropagation(); stop(entry().row) }}>Stop</button>
        </Show>
      </SheetRow>
      <Show when={tail(entry().row).length > 0}>
        <pre class="background-tail">{tail(entry().row).join("\n")}</pre>
      </Show>
    </div>
  )
  return (
    <WorkspaceSurface title={KERNEL_COMMAND_NAMES.bg} docked={props.docked} onClose={props.onClose ?? client.closeSheet} tools={
      <div class="background-filter" role="group" aria-label="Show">
        <button class="ghost-text" aria-pressed={filter() === "active"} onClick={() => choose("active")}>Active</button>
        <button class="ghost-text" aria-pressed={filter() === "all"} onClick={() => choose("all")}>All</button>
      </div>
    } contentRef={(parent) => keyedRows(parent, entries, entry => entry.row.id, renderEntry)}>
      <Show when={chatId() !== undefined} fallback={<SheetEmpty>Select a chat to see its background work.</SheetEmpty>}>
        <Show when={entries().length === 0}><Show when={index()?.status !== "loading"} fallback={<SheetLoading />}><SheetEmpty>{empty()}</SheetEmpty></Show></Show>
      </Show>
    </WorkspaceSurface>
  )
}
