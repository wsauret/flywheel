/** @jsxImportSource @opentui/solid */
import { createEffect, createMemo, createSignal, Show, untrack, type Accessor } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { errorMessage } from "../../../infra/error-message.js"
import { blockEntryKeys, blockIdentity } from "../../../protocol/block-identity.js"
import { sessionControls } from "../../../protocol/client/session-controls.js"
import type { LeadRow, LeadSeenState } from "../../../protocol/modules/lead.js"
import { Button } from "../../components/button.js"
import { ChildSessionBody } from "../../components/child-session-body.js"
import { createChildSessionViewerInput, type ChildSessionViewerInput } from "../../components/child-session-viewer.js"
import { ModalFrame, MODAL_FRAME_HORIZONTAL_INSET, sessionViewerBodyHeight, sessionViewerWidth } from "../../components/modal-frame.js"
import type { ViewerHandle } from "../../components/modal-stack.js"
import type { TuiStripKeyEvent } from "../../tui-module.js"
import type { TuiModuleClientHost } from "../../tui-module-client.js"
import { useTheme } from "../../context/theme.js"
import { LeadViewCover } from "./cover.js"

export type LeadChatViewerHost = Pick<TuiModuleClientHost, "client" | "viewer" | "viewerLayer" | "question" | "answerQuestion" | "cancelQuestion" | "questionDrafts" | "navigateSession" | "dispatchCommand" | "showToast">

/** True for `ctrl+<letter>` with no other modifier. */
export function isCtrlChord(event: Pick<TuiStripKeyEvent, "name" | "ctrl" | "meta" | "shift">, letter: string): boolean {
  return event.ctrl === true && !event.meta && !event.shift && event.name === letter
}

/** Marks a started chat's result read once, when `shows` first answers true
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

/** Records that the person opened a chat whose row is failed or cut, so the row leaves the list until the chat
 *  changes state again (PI-LEAD-005). Every way of opening a chat from the list runs it. */
function markOpened(host: Pick<TuiModuleClientHost, "client" | "showToast">, row: LeadRow | undefined): void {
  if ((row?.state === "failed" || row?.state === "cut") && row.ended) dispatchMark(host, { type: "lead.chat.mark_seen", sessionId: row.sessionId, state: row.state, entryId: row.ended.entryId })
}

/** Opens a chat as an ordinary tab in front; the lead's tab stays first. `row` is the chat's row in the list, which
 *  the open marks seen; the viewer, which marked its chat when it showed it, names none. */
export function openLeadChatTab(host: Pick<TuiModuleClientHost, "client" | "navigateSession" | "showToast">, sessionId: string, row: LeadRow | undefined): void {
  markOpened(host, row)
  void host.navigateSession(sessionId).catch((cause: unknown) => { host.showToast({ message: `Open failed: ${errorMessage(cause)}`, variant: "error" }) })
}

/** Opens one started chat's full conversation over the lead (PI-LEAD-005,
 *  PI-LEAD-007). The person reads it, types to that chat, and answers its
 *  question there; a result it shows is read, and a failure or a cut is seen
 *  once the chat shows. Tab and Shift+Tab move through
 *  the chats in the list's order and stay at the ends, `ctrl+t` opens the
 *  chat as a tab, and Escape goes back to the lead, where the list keeps its
 *  selection. */
export function openLeadChatViewer(host: LeadChatViewerHost, input: {
  readonly sessionId: string
  readonly order: Accessor<readonly string[]>
  readonly row: (sessionId: string) => LeadRow | undefined
  readonly title: (sessionId: string) => string
  /** An entry of the first chat shown, such as its final message, that the view opens at and marks. */
  readonly landing?: string
}): void {
  const [handle, setHandle] = createSignal<ViewerHandle>()
  const [shown, setShown] = createSignal(input.sessionId)
  const close = (): void => { handle()?.close() }
  const openAsTab = (): void => { const sessionId = untrack(shown); close(); openLeadChatTab(host, sessionId, undefined) }
  let lastAt = 0
  /** The chat next to the shown one in the list, or undefined at an end. */
  const neighbour = (direction: 1 | -1): string | undefined => {
    const order = input.order()
    const at = order.indexOf(shown())
    if (at >= 0) lastAt = at
    // Once the shown chat left the list, as a read result does, the chat now in its place is the next one.
    return at >= 0 ? order[at + direction] : order[direction === 1 ? lastAt : lastAt - 1]
  }
  // The landing is spent on the first body that shows the first chat, so a return to it by Tab opens it unlanded.
  let landing = input.landing
  const takeLanding = (sessionId: string): string | undefined => {
    if (sessionId !== input.sessionId) return undefined
    const once = landing
    landing = undefined
    return once
  }
  const move = (direction: 1 | -1): void => { const next = untrack(() => neighbour(direction)); if (next !== undefined) setShown(next) }
  // Each chat keeps its own draft and its own pending send while Tab moves between chats.
  const inputs = new Map<string, ChildSessionViewerInput>()
  const inputFor = (sessionId: string): ChildSessionViewerInput => {
    const held = inputs.get(sessionId)
    if (held) return held
    const created = createChildSessionViewerInput({ onClose: close, dispatchCommand: host.dispatchCommand })
    // Tab never types into the composer here, also at either end of the list.
    created.bindAgentMove((direction) => { move(direction); return true })
    // The question dock owns Left and Right for its options.
    created.bindBack(() => untrack(() => host.question(sessionId)) === undefined ? "close" : "none")
    inputs.set(sessionId, created)
    return created
  }
  const onKey = (event: Parameters<ChildSessionViewerInput["onKey"]>[0]): void => {
    if (isCtrlChord(event, "t")) { event.preventDefault?.(); openAsTab() } else inputFor(untrack(shown)).onKey(event)
  }
  setHandle(host.viewerLayer.push(() => <LeadViewCover><LeadChatViewer host={host} shown={shown} landing={takeLanding} row={input.row} title={input.title} inputFor={inputFor}
    active={() => handle()?.isActive() ?? false} focused={() => handle()?.isFocused() ?? false}
    canMove={(direction) => neighbour(direction) !== undefined} move={move} close={close} openAsTab={openAsTab} /></LeadViewCover>,
  { onKey, onPaste: (text) => { inputFor(untrack(shown)).onPaste(text) } }))
}

function LeadChatViewer(props: {
  readonly host: LeadChatViewerHost
  readonly shown: Accessor<string>
  /** The entry a body of this chat lands on; it answers an entry once at most. */
  readonly landing: (sessionId: string) => string | undefined
  readonly row: (sessionId: string) => LeadRow | undefined
  readonly title: (sessionId: string) => string
  readonly inputFor: (sessionId: string) => ChildSessionViewerInput
  readonly active: Accessor<boolean>
  readonly focused: Accessor<boolean>
  readonly canMove: (direction: 1 | -1) => boolean
  readonly move: (direction: 1 | -1) => void
  readonly close: () => void
  readonly openAsTab: () => void
}) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const width = createMemo(() => sessionViewerWidth(dimensions().width))
  return <ModalFrame title={props.title(props.shown())} width={width()} onClose={props.close}>
    {/* One body for each chat, so the surface and its transcript follow the chat the view shows. */}
    <Show when={props.shown()} keyed>{(sessionId) => {
      const body = props.host.viewer(sessionId)
      const surface = body.createSurface(() => sessionId)
      const row = untrack(() => props.row(sessionId))
      const landing = props.landing(sessionId)
      const result = row?.state === "result" ? row.result : undefined
      if (result) {
        createResultReadMark(props.host, sessionId, result.entryId,
          () => surface.transcript.visibleRange()?.blocks.some((block) => blockEntryKeys(blockIdentity(block)).includes(result.entryId)) ?? false)
      }
      markOpened(props.host, row)
      const admits = () => sessionControls(surface.summary() ?? undefined).message
      const send = async (text: string): Promise<boolean> => {
        try {
          const outcome = await body.submissions.send(sessionId, { text })
          if (outcome.kind === "draft_kept") props.host.showToast({ message: outcome.error, variant: "warning" })
          else if (outcome.kind === "failed") props.host.showToast({ message: outcome.error, variant: "error" })
          return outcome.kind === "sent" || outcome.kind === "waiting"
        } catch (cause) {
          props.host.showToast({ message: `Message failed: ${errorMessage(cause)}`, variant: "error" })
          return false
        }
      }
      return <ChildSessionBody {...body} agentKind="chat" sessionId={sessionId} surface={surface} input={props.inputFor(sessionId)}
        active={props.active} focused={props.focused} width={width() - MODAL_FRAME_HORIZONTAL_INSET} height={sessionViewerBodyHeight(dimensions().height)}
        messaging={{ admits, shown: admits, send, sessionId: () => sessionId }} placeholder="Message this chat" controls={() => ({})}
        {...(landing === undefined ? {} : { landing })}
        question={{ view: () => props.host.question(sessionId), answer: props.host.answerQuestion, cancel: props.host.cancelQuestion, leave: props.close, drafts: props.host.questionDrafts }}
        header={<text fg={theme.textMuted} flexShrink={0}>{sessionId}</text>}
        navigation={<box flexDirection="row" gap={1} flexShrink={0}>
          <Button label="Back" hotkey="esc" muted onPress={props.close} />
          <Button label="Open as tab" hotkey="ctrl+t" muted onPress={props.openAsTab} />
          <Show when={props.canMove(-1)}><Button label="Previous chat" hotkey="shift+tab" muted onPress={() => props.move(-1)} /></Show>
          <Show when={props.canMove(1)}><Button label="Next chat" hotkey="tab" muted onPress={() => props.move(1)} /></Show>
        </box>} />
    }}</Show>
  </ModalFrame>
}
