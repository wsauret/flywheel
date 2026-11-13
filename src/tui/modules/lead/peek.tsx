/** @jsxImportSource @opentui/solid */
import { createEffect, createMemo, createSignal, For, onCleanup, Show, untrack, type Accessor } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { errorMessage } from "../../../infra/error-message.js"
import { chatOnlyCommandNotice } from "../../../protocol/client/slash-route.js"
import { sessionChangePathLabel } from "../../../protocol/client/session-changes-copy.js"
import type { LeadRow } from "../../../protocol/modules/lead.js"
import type { SessionChangesResult } from "../../../protocol/session-changes-protocol-types.js"
import { createChildSessionViewerInput } from "../../components/child-session-viewer.js"
import { ComposerBody, ComposerFrame, composerBodyGeometry } from "../../components/composer-frame.js"
import { ModalFrame, MODAL_FRAME_HORIZONTAL_INSET, sessionViewerBodyHeight, sessionViewerWidth } from "../../components/modal-frame.js"
import { createModalScrollController, type ModalScrollController } from "../../components/modal-scroll-controller.js"
import type { ViewerHandle } from "../../components/modal-stack.js"
import { useTheme } from "../../context/theme.js"
import type { TuiModuleClientHost } from "../../tui-module-client.js"
import { truncateToWidth } from "../../utils/text.js"
import { LeadViewCover } from "./cover.js"

export type LeadPeekHost = Pick<TuiModuleClientHost, "client" | "viewer" | "viewerLayer" | "showToast">

/** The most changed files the peek names; the rest it counts. */
const PEEK_FILES = 8
const NO_CHUNKS = () => []

type ChangedFiles = { readonly status: "loading" } | { readonly status: "ready"; readonly data: SessionChangesResult } | { readonly status: "error"; readonly error: string }

/** Opens a short look at one started chat over the lead (PI-LEAD-007): its
 *  request, its latest updates oldest first, and the files it changed, all in
 *  the chat's own words, with an input that sends the person's message to
 *  that chat. Escape goes back to the list. */
export function openLeadPeek(host: LeadPeekHost, input: { readonly row: Accessor<LeadRow>; readonly title: Accessor<string>; readonly count: Accessor<string | undefined> }): void {
  const sessionId = untrack(input.row).sessionId
  const [handle, setHandle] = createSignal<ViewerHandle>()
  const close = (): void => { handle()?.close() }
  const keys = createChildSessionViewerInput({
    onClose: close,
    // A command acts on the chat in front, and the lead is in front here.
    dispatchCommand: async (text) => {
      host.showToast({ message: chatOnlyCommandNotice(text.slice(1).split(/\s/, 1)[0] ?? "", "chat"), variant: "warning" })
      return false
    },
  })
  const submissions = untrack(() => host.viewer(sessionId).submissions)
  const send = async (text: string): Promise<boolean> => {
    try {
      const outcome = await submissions.send(sessionId, { text })
      if (outcome.kind === "draft_kept") host.showToast({ message: outcome.error, variant: "warning" })
      else if (outcome.kind === "failed") host.showToast({ message: outcome.error, variant: "error" })
      return outcome.kind === "sent" || outcome.kind === "waiting"
    } catch (cause) {
      host.showToast({ message: `Message failed: ${errorMessage(cause)}`, variant: "error" })
      return false
    }
  }
  keys.bindMessaging({ admits: () => true, shown: () => true, send, sessionId: () => sessionId })
  // The input owner sends only PageUp and PageDown here; they page the peek's content.
  const scroll = createModalScrollController()
  keys.bindOutput((type) => { scroll.pageBy(type === "page-up" ? -1 : 1) })
  setHandle(host.viewerLayer.push(() => <LeadViewCover><LeadPeek host={host} sessionId={sessionId} row={input.row} title={input.title} count={input.count} keys={keys} scroll={scroll}
    focused={() => handle()?.isFocused() ?? false} close={close} /></LeadViewCover>, { onKey: keys.onKey, onPaste: keys.onPaste }))
}

function LeadPeek(props: {
  readonly host: LeadPeekHost
  readonly sessionId: string
  readonly row: Accessor<LeadRow>
  readonly title: Accessor<string>
  readonly count: Accessor<string | undefined>
  readonly keys: ReturnType<typeof createChildSessionViewerInput>
  /** Scrolls the request, the updates, and the files. */
  readonly scroll: ModalScrollController
  readonly focused: Accessor<boolean>
  readonly close: () => void
}) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const width = createMemo(() => sessionViewerWidth(dimensions().width))
  const contentWidth = () => width() - MODAL_FRAME_HORIZONTAL_INSET
  const line = (text: string) => truncateToWidth(text.replace(/\s+/g, " ").trim(), contentWidth(), "…")
  // The changes are read once, while the peek shows (ARCH-PROTOCOL-045).
  const [files, setFiles] = createSignal<ChangedFiles>({ status: "loading" })
  let open = true
  onCleanup(() => { open = false; props.scroll.detach() })
  void untrack(() => props.host.client.query({ type: "sessionChanges", sessionId: props.sessionId, offset: 0, maxFiles: PEEK_FILES, maxBytes: 64 * 1024 }))
    .then((data) => { if (open) setFiles({ status: "ready", data }) }, (cause: unknown) => { if (open) setFiles({ status: "error", error: errorMessage(cause) }) })
  const filesText = createMemo((): readonly string[] => {
    const state = files()
    if (state.status === "loading") return ["Loading…"]
    if (state.status === "error") return [`Changes unavailable: ${state.error}`]
    if (state.data.totalFiles === 0) return ["No changed files"]
    const more = state.data.totalFiles - state.data.files.length
    return [...state.data.files.map((file) => sessionChangePathLabel(file.path, state.data.executionCwd)), ...(more > 0 ? [`+${more} more`] : [])]
  })
  const updates = () => props.row().updates.slice(-5)
  const section = (label: string) => <text fg={theme.textMuted} flexShrink={0}>{label}</text>
  return <ModalFrame title={props.title()} width={width()} onClose={props.close}
    titleAccessory={<Show when={props.count()}>{(label) => <text fg={theme.warning}>{label()}</text>}</Show>}>
    {/* The view keeps the session viewers' size; the content scrolls, and the input and the hint always show. */}
    <box flexDirection="column" height={sessionViewerBodyHeight(dimensions().height)} gap={1} paddingTop={1}>
      <scrollbox ref={props.scroll.attach} flexGrow={1} flexShrink={1} minHeight={1} scrollY scrollX={false}>
        <box flexDirection="column" gap={1}>
          <box flexDirection="column" flexShrink={0}>
            {section("Request")}
            <text fg={theme.text} wrapMode="word">{props.row().request?.text ?? "No request"}</text>
          </box>
          <box flexDirection="column" flexShrink={0}>
            {section("Latest updates")}
            <Show when={updates().length > 0} fallback={<text fg={theme.textMuted}>{"No updates yet"}</text>}>
              <For each={updates()}>{(update) => <text fg={theme.text} wrapMode="none" overflow="hidden">{line(update.text)}</text>}</For>
            </Show>
          </box>
          <box flexDirection="column" flexShrink={0}>
            {section("Changed files")}
            <For each={filesText()}>{(text) => <text fg={files().status === "ready" ? theme.text : theme.textMuted} wrapMode="none" overflow="hidden">{line(text)}</text>}</For>
          </box>
        </box>
      </scrollbox>
      <ComposerFrame theme={theme} width={contentWidth()} bodyHeight={composerBodyGeometry(contentWidth(), props.keys.lines()).height}
        topRightChunks={NO_CHUNKS} bottomLeftChunks={NO_CHUNKS} bottomRightChunks={NO_CHUNKS} controls={NO_CHUNKS} actions={{}} onMouseDown={() => props.keys.focus()}>
        <ComposerBody theme={theme} width={contentWidth()} lines={props.keys.lines()} text={props.keys.text()} placeholder="Message this chat" onSubmit={props.keys.submit}
          attach={(prompt) => {
            props.keys.attach(prompt)
            createEffect(() => { if (props.focused()) prompt.focus(); else prompt.blur() })
            onCleanup(() => prompt.blur())
          }} />
      </ComposerFrame>
      <text fg={theme.textMuted} flexShrink={0}>{"enter send · pgup pgdn scroll · esc back"}</text>
    </box>
  </ModalFrame>
}
