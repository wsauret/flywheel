/** @jsxImportSource @opentui/solid */
import { createEffect, createMemo, createSignal, onCleanup, Show, untrack, type Accessor } from "solid-js"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { errorMessage } from "../../../infra/error-message.js"
import { blockEntryKeys, blockIdentity } from "../../../protocol/block-identity.js"
import type { LeadRow, LeadSeenState } from "../../../protocol/modules/lead.js"
import { Button } from "../../components/button.js"
import { ChatViewPane, createChatPaneInput, routeChatPaneKey, type ChatPaneHost, type ChatPaneInput, type PaneKeyEvent } from "../../components/chat-pane.js"
import { ModalFrame, MODAL_FRAME_HORIZONTAL_INSET, sessionViewerBodyHeight, sessionViewerWidth } from "../../components/modal-frame.js"
import { SessionHeaderStats } from "../../components/session-header-stats.js"
import { useTheme } from "../../context/theme.js"
import { createHeaderDisplay } from "../../hooks/create-header-display.js"
import type { ViewerHandle } from "../../components/modal-stack.js"
import { createTranscriptSelectionDrag } from "../../hooks/create-transcript-selection-drag.js"
import type { TuiStripKeyEvent } from "../../tui-module.js"
import type { TuiModuleClientHost } from "../../tui-module-client.js"
import { LeadViewCover } from "./cover.js"

export type LeadChatViewerHost = Pick<TuiModuleClientHost, "client" | "chatPane" | "viewerLayer" | "navigateSession" | "showToast" | "showSession">

/** True for `ctrl+<letter>` with no other modifier. */
export function isCtrlChord(event: Pick<TuiStripKeyEvent, "name" | "ctrl" | "meta" | "shift">, letter: string): boolean {
  return event.ctrl === true && !event.meta && !event.shift && event.name === letter
}

/** Marks a listed chat's result read once, when `shows` first answers true
 *  for its final message. A load that never brings that message leaves the
 *  row unread (PI-LEAD-005). Runs under the caller's owner. */
function createResultReadMark(host: Pick<TuiModuleClientHost, "client" | "showToast">, sessionId: string, entryId: string, shows: Accessor<boolean>): void {
  const shown = createMemo((was: boolean) => was || shows(), false)
  createEffect(() => {
    if (shown()) dispatchMark(host, { type: "lead.result.mark_read", sessionId, entryId })
  })
}

function dispatchMark(host: Pick<TuiModuleClientHost, "client" | "showToast">, mutation: { readonly type: "lead.result.mark_read"; readonly sessionId: string; readonly entryId: string } | { readonly type: "lead.chat.mark_seen"; readonly sessionId: string; readonly state: LeadSeenState; readonly entryId: string }): void {
  const report = (message: string): void => { host.showToast({ message, variant: "error" }) }
  void host.client.dispatch(mutation).then((answer) => { if (!answer.ok) report(answer.error) }, (cause: unknown) => { report(errorMessage(cause)) })
}

/** Records that the person opened a chat whose row is failed or cut, so the row shows that state no more until the
 *  chat changes state again (PI-LEAD-005). Every way of opening a chat from the list runs it. */
function markOpened(host: Pick<TuiModuleClientHost, "client" | "showToast">, row: LeadRow | undefined): void {
  if ((row?.state === "failed" || row?.state === "cut") && row.ended) dispatchMark(host, { type: "lead.chat.mark_seen", sessionId: row.sessionId, state: row.state, entryId: row.ended.entryId })
}

/** Opens a chat as an ordinary tab in front; the lead's tab stays first. `row` is the chat's row in the list, which
 *  the open marks seen; the viewer, which marked its chat when it showed it, names none. */
export function openLeadChatTab(host: Pick<TuiModuleClientHost, "client" | "navigateSession" | "showToast">, sessionId: string, row: LeadRow | undefined): void {
  markOpened(host, row)
  void host.navigateSession(sessionId).catch((cause: unknown) => { host.showToast({ message: `Open failed: ${errorMessage(cause)}`, variant: "error" }) })
}

/** Opens one listed chat over the lead, exactly as its tab shows it (PI-LEAD-005, PI-LEAD-007): the kernel's chat
 *  pane in a frame. The person reads it, types to that chat, and answers its question there; a result it shows is
 *  read, and a failure or a cut is seen once the chat shows. Only the frame and its controls differ from a tab: Tab
 *  and Shift+Tab move through the chats in the list's order and stay at the ends, `ctrl+t` opens the chat as a tab,
 *  Close chat closes it and goes back to the lead, and Escape interrupts a running turn as in a tab and, once nothing
 *  runs, goes back to the lead, where the list keeps its selection. The lead's tab stays in front throughout. */
export function openLeadChatViewer(host: LeadChatViewerHost, input: {
  readonly sessionId: string
  readonly order: Accessor<readonly string[]>
  readonly row: (sessionId: string) => LeadRow | undefined
  readonly title: (sessionId: string) => string
  /** Closes a chat as the Sessions list's close chat does. */
  readonly closeChat: (sessionId: string) => void
  /** An entry of the first chat shown, such as its final message, that the view opens at and marks. */
  readonly landing?: string
}): void {
  const pane = host.chatPane()
  const [handle, setHandle] = createSignal<ViewerHandle>()
  const [shown, setShown] = createSignal(input.sessionId)
  const close = (): void => { handle()?.close() }
  // The chat that leaves the view for its own tab, so the view's end does not close it.
  let toTab: string | undefined
  const openAsTab = (): void => { const sessionId = untrack(shown); toTab = sessionId; close(); openLeadChatTab(host, sessionId, undefined) }
  const closeChat = (): void => { const sessionId = untrack(shown); close(); input.closeChat(sessionId) }
  let lastAt = 0
  /** The chat next to the shown one in the list, or undefined at an end. */
  const neighbour = (direction: 1 | -1): string | undefined => {
    const order = input.order()
    const at = order.indexOf(shown())
    if (at >= 0) lastAt = at
    // Once the shown chat left the list, as a closed chat does, the chat now in its place is the next one.
    return at >= 0 ? order[at + direction] : order[direction === 1 ? lastAt : lastAt - 1]
  }
  // The landing is spent on the first pane that shows the first chat, so a return to it by Tab opens it unlanded.
  let landing = input.landing
  const takeLanding = (sessionId: string): string | undefined => {
    if (sessionId !== input.sessionId) return undefined
    const once = landing
    landing = undefined
    return once
  }
  const move = (direction: 1 | -1): void => { const next = untrack(() => neighbour(direction)); if (next !== undefined) setShown(next) }
  // Each chat keeps its own keys and transcript commands while Tab moves between chats; its draft lives in the
  // shell's draft cache under its own id, as a tab's does.
  const inputs = new Map<string, ChatPaneInput>()
  const inputFor = (sessionId: string): ChatPaneInput => {
    const held = inputs.get(sessionId)
    if (held) return held
    const created = createChatPaneInput()
    inputs.set(sessionId, created)
    return created
  }
  /** The view's own keys, after the chat's question, its composer popups, and Escape's interrupt had them. */
  const viewKey = (event: PaneKeyEvent): boolean => {
    if (isCtrlChord(event, "t")) openAsTab()
    else if (event.name === "escape" && !event.ctrl && !event.meta) close()
    else if (event.name === "tab" && !event.ctrl && !event.meta) move(event.shift ? -1 : 1)
    else return false
    event.preventDefault?.()
    return true
  }
  setHandle(host.viewerLayer.push(() => <LeadViewCover><LeadChatViewer host={host} pane={pane} shown={shown} landing={takeLanding} row={input.row} title={input.title} inputFor={inputFor} toTab={(sessionId) => sessionId === toTab}
    active={() => handle()?.isActive() ?? false} focused={() => handle()?.isFocused() ?? false}
    canMove={(direction) => neighbour(direction) !== undefined} move={move} close={close} openAsTab={openAsTab} closeChat={closeChat} /></LeadViewCover>,
  {
    onKey: (event) => { routeChatPaneKey(pane, inputFor(untrack(shown)), event, viewKey) },
    // The chat's question takes a paste while it shows; every other paste reaches the focused composer, as in a tab.
    onPaste: (text) => inputFor(untrack(shown)).questionInput.paste(text),
  }))
}

function LeadChatViewer(props: {
  readonly host: LeadChatViewerHost
  readonly pane: ChatPaneHost
  readonly shown: Accessor<string>
  /** The entry a pane of this chat lands on; it answers an entry once at most. */
  readonly landing: (sessionId: string) => string | undefined
  readonly row: (sessionId: string) => LeadRow | undefined
  readonly title: (sessionId: string) => string
  readonly inputFor: (sessionId: string) => ChatPaneInput
  /** Whether the chat leaves the view for its own tab. */
  readonly toTab: (sessionId: string) => boolean
  readonly active: Accessor<boolean>
  readonly focused: Accessor<boolean>
  readonly canMove: (direction: 1 | -1) => boolean
  readonly move: (direction: 1 | -1) => void
  readonly close: () => void
  readonly openAsTab: () => void
  readonly closeChat: () => void
}) {
  const dimensions = useTerminalDimensions()
  const width = createMemo(() => sessionViewerWidth(dimensions().width))
  const paneWidth = createMemo(() => width() - MODAL_FRAME_HORIZONTAL_INSET)
  // A selection that leaves the transcript over the frame's title or controls scrolls it, as over a tab's bar.
  const selectionDrag = createTranscriptSelectionDrag(useRenderer())
  const { theme } = useTheme()
  return <box onMouseDown={selectionDrag.onMouseDown} onMouseDrag={selectionDrag.onMouseDrag} onMouseUp={selectionDrag.onMouseUp}>
    {/* One frame for each chat, so its surface, its statistics, and its transcript follow the chat the view shows. */}
    <Show when={props.shown()} keyed>{(sessionId) => {
      // The view holds the chat open as a tab does, and its end closes it as a closed tab does (PI-LEAD-003).
      const release = props.host.showSession(sessionId)
      onCleanup(() => { release(props.toTab(sessionId)) })
      const row = untrack(() => props.row(sessionId))
      const result = row?.state === "result" ? row.result : undefined
      const surface = props.pane.createSurface(() => sessionId)
      if (result) {
        createResultReadMark(props.host, sessionId, result.entryId,
          () => surface.transcript.visibleRange()?.blocks.some((block) => blockEntryKeys(blockIdentity(block)).includes(result.entryId)) ?? false)
      }
      markOpened(props.host, row)
      // The chat's statistics line, as the tab bar shows it for the chat in front: on the title row, at its right.
      const header = createHeaderDisplay({ surface, dimensions, compactionThreshold: props.pane.compactionThreshold, theme })
      return <ModalFrame title={props.title(sessionId)} width={width()} onClose={props.close}
        titleAccessory={<SessionHeaderStats header={header} surface={surface} compact={props.pane.compact} />}>
        <box flexDirection="column" width={paneWidth()} height={sessionViewerBodyHeight(dimensions().height)}>
          <ChatViewPane host={props.pane} surface={surface} input={props.inputFor(sessionId)}
            view={{ active: props.active, leave: props.close, closeChat: props.closeChat }} width={paneWidth} focused={props.focused}
            selectionDrag={selectionDrag} {...withLanding(props.landing(sessionId))} />
          <box flexDirection="row" gap={1} flexShrink={0}>
            {/* While a turn runs, Escape interrupts it instead of going back. */}
            <Button label="Back" {...(surface.interruptible() ? {} : { hotkey: "esc" })} muted onPress={props.close} />
            <Button label="Open as tab" hotkey="ctrl+t" muted onPress={props.openAsTab} />
            <Button label="Close session" muted onPress={props.closeChat} />
            <Show when={props.canMove(-1)}><Button label="Previous" hotkey="shift+tab" muted onPress={() => props.move(-1)} /></Show>
            <Show when={props.canMove(1)}><Button label="Next" hotkey="tab" muted onPress={() => props.move(1)} /></Show>
          </box>
        </box>
      </ModalFrame>
    }}</Show>
  </box>
}

function withLanding(landing: string | undefined): { readonly landing?: string } {
  return landing === undefined ? {} : { landing }
}
