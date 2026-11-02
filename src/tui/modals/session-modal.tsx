/** @jsxImportSource @opentui/solid */

import { useTheme } from "@tui/context/theme"
import { computeResponsivePaneLayout } from "@tui/components/modal-layout"
import { useModalDimensions } from "@tui/hooks/use-modal-dimensions"
import { ModalFrame } from "@tui/components/modal-frame"
import { MODAL_FRAME_WIDTHS } from "@tui/components/modal-copy"
import { SessionPickerList } from "../session-picker/session-picker-list.js"
import { SessionPreviewPane } from "../session-picker/session-preview-pane.js"
import { useSessionPreview, type SessionPreviewAppService, type SessionPreviewReader } from "../session-picker/use-session-preview.js"
import type { SessionModalAction, SessionPickerResult } from "../hooks/use-session-modal-types.js"
import type { PickerCorruptRow } from "../session-picker/picker-types.js"
import type { StatusView } from "../../protocol/status-protocol-types.js"
import type { DiffColorMode } from "../../orchestration/config/schema.js"
import { createMemo, Show, untrack, type Accessor, type JSX } from "solid-js"
import type { TextEditorPresentation } from "../keymap/text-entry.js"
import { KERNEL_COMMAND_NAMES } from "../../protocol/command-names.js"

interface SessionModalProps {
  result: SessionPickerResult
  cursor: number
  navigationRevision: number
  actions: readonly SessionModalAction[]
  appService: SessionPreviewAppService
  onClose: () => void
  onRowClick: (rowIndex: number) => void
  filterQuery: string
  inputPresentation: TextEditorPresentation
  inputPlaceholder: string
  renaming: boolean
  renameField?: "title" | "shortTitle"
  renamePresentation: (field: "title" | "shortTitle") => TextEditorPresentation
  foregroundId?: string
  statusView: (sessionId: string) => StatusView | undefined
  now: number
  confirmDeleteSessionId?: string
  showThinking?: boolean
  diffColors?: Accessor<DiffColorMode>
}

const SESSION_MODAL_RESERVED_ROWS = 8
const SESSION_MODAL_MAX_HEIGHT = 64

export function SessionModal(props: SessionModalProps) {
  const { theme } = useTheme()
  const { modalWidth, listMaxHeight, termWidth } = useModalDimensions(MODAL_FRAME_WIDTHS.session, SESSION_MODAL_RESERVED_ROWS, SESSION_MODAL_MAX_HEIGHT)
  const layout = createMemo(() => computeResponsivePaneLayout(termWidth(), Math.max(0, modalWidth() - 4), listMaxHeight()))
  const selectedSession = createMemo(() => {
    const row = props.result.rows[props.cursor]
    return row?.kind === "session" ? row.session : undefined
  })
  const selectedCorrupt = createMemo(() => {
    const row = props.result.rows[props.cursor]
    return row?.kind === "corrupt" ? row : undefined
  })
  const selectedSessionId = createMemo(() => selectedSession()?.id)
  let reader: SessionPreviewReader | undefined
  const preview = useSessionPreview(
    () => selectedSessionId(),
    () => Math.max(1, layout().previewHeight - 4),
    untrack(() => props.appService),
    undefined,
    () => reader,
  )

  return (
    <ModalFrame title={KERNEL_COMMAND_NAMES.sessions} width={modalWidth()} onClose={() => props.onClose()}>
      <box paddingTop={1} paddingBottom={1} flexDirection={layout().mode === "split" ? "row" : "column"} gap={layout().gap}>
      <box width={layout().listWidth} flexDirection="column">
        <SessionPickerList
          result={props.result}
          cursor={props.cursor}
          navigationRevision={props.navigationRevision}
          actions={props.actions}
          theme={theme}
          height={layout().listHeight}
          rowWidth={Math.max(0, layout().listWidth)}
          foregroundId={props.foregroundId}
          statusView={props.statusView}
          now={props.now}
          confirmDeleteSessionId={props.confirmDeleteSessionId}
          onRowClick={props.onRowClick}
          filterQuery={props.filterQuery}
          inputPresentation={props.inputPresentation}
          inputPlaceholder={props.inputPlaceholder}
          renaming={props.renaming}
          renameField={props.renameField}
          renamePresentation={props.renamePresentation}
        />
      </box>
      <Show
        when={selectedCorrupt()}
        fallback={
          <SessionPreviewPane
            session={selectedSession()}
            preview={preview()}
            width={layout().previewWidth}
            height={layout().previewHeight}
            onReader={(value) => { reader = value }}
            showThinking={props.showThinking}
            diffColors={props.diffColors}
          />
        }
      >
        {(row) => <CorruptSessionPane row={row()} width={layout().previewWidth} height={layout().previewHeight} />}
      </Show>
      </box>
    </ModalFrame>
  )
}

/** Preview for session metadata that cannot be read. */
function CorruptSessionPane(props: { row: PickerCorruptRow; width: number; height: number }): JSX.Element {
  const { theme } = useTheme()
  return (
    <box
      width={props.width}
      height={props.height}
      flexDirection="column"
      border={["top", "bottom", "left", "right"]}
      borderStyle="rounded"
      borderColor={theme.borderSubtle}
      paddingLeft={1}
      paddingRight={1}
    >
      <text fg={theme.error} overflow="hidden" wrapMode="none">Unreadable Session</text>
      <text fg={theme.textMuted} overflow="hidden" wrapMode="none">{props.row.sessionId}</text>
      <box paddingTop={1}>
        <text fg={theme.textMuted} wrapMode="word">{`This session's saved data can't be read: ${props.row.reason}`}</text>
      </box>
      <box paddingTop={1}>
        <text fg={theme.text} wrapMode="word">Press d twice to delete this unreadable session.</text>
      </box>
    </box>
  )
}
