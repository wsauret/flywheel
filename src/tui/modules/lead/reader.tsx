/** @jsxImportSource @opentui/solid */
import { createEffect, createMemo, createSignal, onCleanup, onMount, Show, untrack, type Accessor } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { errorMessage } from "../../../infra/error-message.js"
import { blockEntryKeys, blockIdentity } from "../../../protocol/block-identity.js"
import type { LeadRow } from "../../../protocol/modules/lead.js"
import { createModalScrollController, type ModalScrollController } from "../../components/modal-scroll-controller.js"
import { ModalFrame, MODAL_FRAME_HORIZONTAL_INSET, sessionViewerBodyHeight, sessionViewerWidth } from "../../components/modal-frame.js"
import type { ViewerHandle } from "../../components/modal-stack.js"
import { createQuestionInputRegistry, type QuestionInputContext } from "../../components/question-input.js"
import { useTheme } from "../../context/theme.js"
import { MarkdownBody } from "../../output-blocks/markdown/markdown-body.js"
import { OutputWindow, type OutputWindowCommand } from "../../output-window/output-window.js"
import type { TranscriptLayoutSlot } from "../../output-window/output-window-scroll.js"
import { QuestionDock } from "../../question-dock.js"
import type { TuiModuleClientHost } from "../../tui-module-client.js"
import { truncateToWidth } from "../../utils/text.js"
import { LeadViewCover } from "./cover.js"

type ChatBody = ReturnType<TuiModuleClientHost["viewer"]>

export type LeadReaderHost = Pick<TuiModuleClientHost, "client" | "viewerLayer" | "question" | "answerQuestion" | "cancelQuestion" | "questionDrafts" | "showToast"> & {
  readonly viewer: (sessionId: string) => Pick<ChatBody, "createSurface" | "createProcessControls" | "sessionIntro" | "showThinking" | "diffColors" | "roleView" | "childStatus" | "ensureChildViews">
}

const REQUEST_LABEL = "Request  "

/** The entry the reader starts from: the final message of a result, the
 *  crash record of a failure that has one, and the newest message of the
 *  person for every other row. */
function readerAnchor(row: LeadRow): string | undefined {
  if (row.state === "result" && row.result) return row.result.entryId
  return (row.state === "failed" ? row.failure?.entryId : undefined) ?? row.request?.entryId
}

interface LeadReaderProps {
  readonly host: LeadReaderHost
  /** The row as it was when the reader opened: reading a result removes the
   *  row, and the reader keeps showing what the person opened. */
  readonly row: LeadRow
  readonly title: Accessor<string>
  readonly count: Accessor<string | undefined>
  readonly questionInput: QuestionInputContext
  /** Scrolls the question's context. */
  readonly scroll: ModalScrollController
  /** Pages the transcript. */
  readonly command: Accessor<OutputWindowCommand | undefined>
  readonly focused: Accessor<boolean>
  readonly close: () => void
}

/** Opens one started chat's pending question, failure, or result in place,
 *  over the lead, in the chat's own words (PI-LEAD-005). Escape closes it and
 *  leaves a question pending; a result is marked read once it shows. */
export function openLeadReader(host: LeadReaderHost, input: { readonly row: LeadRow; readonly title: Accessor<string>; readonly count: Accessor<string | undefined> }): void {
  const [handle, setHandle] = createSignal<ViewerHandle>()
  const close = (): void => { handle()?.close() }
  const questionInput = createQuestionInputRegistry()
  const scroll = createModalScrollController()
  const [command, setCommand] = createSignal<OutputWindowCommand>()
  let commandId = 0
  const onKey = (event: Parameters<QuestionInputContext["input"]>[0]): void => {
    if (questionInput.input(event)) return
    if (event.name === "escape") close()
    else if (event.name !== "pageup" && event.name !== "pagedown") {
      if (input.row.state !== "question" || (event.name !== "up" && event.name !== "down")) return
      scroll.scrollBy(event.name === "up" ? -1 : 1)
    } else if (input.row.state === "question") scroll.pageBy(event.name === "pageup" ? -1 : 1)
    else setCommand({ id: ++commandId, type: event.name === "pageup" ? "page-up" : "page-down" })
    event.preventDefault?.()
  }
  setHandle(host.viewerLayer.push(() => <LeadViewCover><LeadReader host={host} row={input.row} title={input.title} count={input.count} questionInput={questionInput} scroll={scroll}
    command={command} focused={() => handle()?.isFocused() ?? false} close={close} /></LeadViewCover>, { onKey, onPaste: (text) => { questionInput.paste(text) } }))
}

function LeadReader(props: LeadReaderProps) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const width = createMemo(() => sessionViewerWidth(dimensions().width))
  const contentWidth = () => width() - MODAL_FRAME_HORIZONTAL_INSET
  onCleanup(() => { props.scroll.detach() })
  return <ModalFrame title={props.title()} width={width()} onClose={props.close}
    titleAccessory={<Show when={props.count()}>{(label) => <text fg={theme.warning}>{label()}</text>}</Show>}>
    <box flexDirection="column" height={sessionViewerBodyHeight(dimensions().height)} gap={1} paddingTop={1}>
      <Show when={props.row.state === "question"} fallback={<LeadReaderTranscript {...props} width={contentWidth()} />}>
        <LeadReaderQuestion {...props} width={contentWidth()} />
      </Show>
    </box>
  </ModalFrame>
}

/** The chat's original request on one line, then its own context word for
 *  word above the kernel's question form. The form shows only the question
 *  the row names, so a question answered elsewhere is never answered here,
 *  and a newer one never shows under this one's context. */
function LeadReaderQuestion(props: LeadReaderProps & { readonly width: number }) {
  const { theme } = useTheme()
  const sessionId = untrack(() => props.row.sessionId)
  const toolUseId = untrack(() => props.row.question?.toolUseId)
  const pending = createMemo(() => {
    const question = props.host.question(sessionId)
    return question?.toolUseId === toolUseId ? question : undefined
  })
  const seen = createMemo((was: boolean) => was || pending() !== undefined, false)
  // The request text can hold several lines; the frame shows its start on one.
  const request = () => props.row.request && truncateToWidth(props.row.request.text.replace(/\s+/g, " ").trim(), props.width - REQUEST_LABEL.length, "…")
  const settle = (settled: boolean): boolean => { if (settled) props.close(); return settled }
  return <>
    <Show when={request()}>{(text) => <text flexShrink={0} wrapMode="none" overflow="hidden">
      <span style={{ fg: theme.textMuted }}>{REQUEST_LABEL}</span><span style={{ fg: theme.text }}>{text()}</span>
    </text>}</Show>
    <Show when={props.row.question?.context}>{(context) =>
      <scrollbox ref={props.scroll.attach} flexGrow={1} flexShrink={1} minHeight={1} scrollY scrollX={false}>
        <MarkdownBody cache={true}>{context()}</MarkdownBody>
      </scrollbox>
    }</Show>
    <Show when={pending()} fallback={<text flexShrink={0} fg={theme.textMuted}>
      {`${seen() || props.host.question(sessionId) ? "This question was answered elsewhere." : "Loading the question…"} · esc back`}
    </text>}>{(question) =>
      <QuestionDock sessionId={sessionId} question={question()} drafts={props.host.questionDrafts} input={props.questionInput} width={props.width} captureFocus={props.focused}
        onAnswer={(answers) => props.host.answerQuestion(sessionId, question().toolUseId, answers).then(settle)}
        onCancel={() => props.host.cancelQuestion(sessionId, question().toolUseId).then(settle)}
        escape="leave" onLeave={props.close} />
    }</Show>
  </>
}

/** Marks a started chat's result read once, when `shows` first answers true
 *  for its final message. A load that never brings that message leaves the
 *  row unread (PI-LEAD-005). Runs under the caller's owner. */
export function createResultReadMark(host: Pick<TuiModuleClientHost, "client" | "showToast">, sessionId: string, entryId: string, shows: Accessor<boolean>): void {
  const report = (message: string): void => { host.showToast({ message, variant: "error" }) }
  const shown = createMemo((was: boolean) => was || shows(), false)
  createEffect(() => {
    if (!shown()) return
    void host.client.dispatch({ type: "lead.result.mark_read", sessionId, entryId })
      .then((answer) => { if (!answer.ok) report(answer.error) }, (cause: unknown) => { report(errorMessage(cause)) })
  })
}

/** The chat's transcript in the kernel's output window, placed with the
 *  anchor entry at the top once the window that holds it has loaded. */
function LeadReaderTranscript(props: LeadReaderProps & { readonly width: number }) {
  const { theme } = useTheme()
  const sessionId = untrack(() => props.row.sessionId)
  const anchor = untrack(() => readerAnchor(props.row))
  const body = untrack(() => props.host.viewer(sessionId))
  const surface = body.createSurface(() => sessionId)
  const processControls = body.createProcessControls(sessionId)
  const [loaded, setLoaded] = createSignal(anchor === undefined)
  const settled = (): void => { setLoaded(true) }
  // Mounted after the surface's own effects retain and open the transcript.
  onMount(() => { if (anchor !== undefined) void surface.transcript.loadAround(anchor).then(settled, settled) })
  const anchorIndex = createMemo(() => {
    const snapshot = surface.transcript.visibleRange()
    const at = anchor === undefined ? -1 : snapshot?.blocks.findIndex((block) => blockEntryKeys(blockIdentity(block)).includes(anchor)) ?? -1
    return at < 0 ? undefined : (snapshot?.window.startBlockIndex ?? 0) + at
  })
  // The window mounts once, with the anchor as its starting place, or with no
  // place when the load ends without the anchor.
  const slot = createMemo<TranscriptLayoutSlot | undefined>((previous) => {
    if (previous) return previous
    const blockIndex = anchorIndex()
    if (blockIndex !== undefined) return { restoreAnchor: { blockIndex, rowOffsetWithinBlock: 0 } }
    return loaded() ? {} : undefined
  })
  const result = untrack(() => props.row.state === "result" ? props.row.result : undefined)
  if (result) createResultReadMark(untrack(() => props.host), sessionId, result.entryId, () => anchorIndex() !== undefined)
  return <>
    <box flexGrow={1} minHeight={0} flexShrink={1} flexDirection="column">
      <Show when={slot()} fallback={<text fg={theme.textMuted}>{"Loading the chat…"}</text>}>{(layoutSlot) =>
        <Show when={surface.sessionKind()}>{(kind) =>
          <OutputWindow transcript={surface.transcript} layoutSlot={layoutSlot()}
            sessionIntro={{ ...body.sessionIntro, sessionKind: kind, availableWidth: () => props.width }}
            running={surface.agentState() === "active"} command={props.command()} showThinking={body.showThinking}
            streamingToolText={surface.streamingToolText()} diffColors={body.diffColors} onNearEdge={surface.pageOutput}
            processControls={processControls} roleView={body.roleView}
            childStatus={(childSessionId) => body.childStatus(childSessionId, sessionId)} ensureChildViews={body.ensureChildViews} />
        }</Show>
      }</Show>
    </box>
    <text flexShrink={0} fg={theme.textMuted}>{"pgup pgdn scroll · esc back"}</text>
  </>
}
