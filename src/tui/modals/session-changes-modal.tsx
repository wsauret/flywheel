/** @jsxImportSource @opentui/solid */
import { createMemo, onCleanup, Show, type Accessor } from "solid-js"
import { Key } from "@solid-primitives/keyed"
import type { MutationDiff } from "../../infra/mutation-diff.js"
import type { DiffColorMode } from "../../orchestration/config/schema.js"
import type { SessionChangeFile } from "../../protocol/session-changes-protocol-types.js"
import type { SessionChangesView } from "../hooks/create-session-changes.js"
import type { SessionChangesModalHook } from "../hooks/use-session-changes-modal.js"
import { useModalDimensions } from "../hooks/use-modal-dimensions.js"
import { useTheme } from "../context/theme.js"
import { Button } from "../components/button.js"
import { ModalFrame } from "../components/modal-frame.js"
import { DiffPreview, parseDiffs } from "../output-blocks/diff-preview.js"
import { BOLD } from "../utils/text-attributes.js"
import { sessionChangeDiffStatusLine, sessionChangeFolderLabel, sessionChangePathLabel, sessionChangesLabel, sessionChangeWritersLabel, undoResultLine, type SessionChangesRow } from "../../protocol/client/session-changes-copy.js"
import { KERNEL_COMMAND_NAMES } from "../../protocol/command-names.js"

const DIFF_ACTION = { added: "add", modified: "update", removed: "delete" } as const

function NetDiff(props: { diff: MutationDiff; complete: boolean; expanded: boolean; onToggle: () => void; diffColors: Accessor<DiffColorMode> }) {
  const parsed = createMemo(() => {
    const diff = parseDiffs(props.diff.files.map(file => ({
      path: file.path, unifiedDiff: file.unifiedDiff, action: DIFF_ACTION[file.change], hideHeading: true,
      ...(file.omittedLines !== undefined ? { omittedLines: file.omittedLines } : {}),
    })), props.expanded)
    return { ...diff, files: diff.files.map(file => ({ ...file, moreBytes: !props.complete })) }
  })
  return <DiffPreview parsed={parsed()} omissions={props.diff.omissions} onToggleFile={props.onToggle} diffColors={props.diffColors} />
}

export function SessionChangesModal(props: {
  view: SessionChangesView | undefined
  controls: SessionChangesModalHook
  projectRoot: string
  diffColors: Accessor<DiffColorMode>
}) {
  const { theme } = useTheme()
  const { modalWidth, listMaxHeight } = useModalDimensions(150, 12, 40)
  const state = () => props.view?.snapshot()
  const controls = () => props.controls
  const list = () => state()?.list
  const listData = () => { const current = list(); return current && "data" in current ? current.data : undefined }
  const listError = () => { const current = list(); return current?.status === "error" ? current.error : undefined }
  // The list never loads while the summary read has failed, so that failure is the line to show.
  const summaryError = () => { const current = state()?.summary; return current?.status === "error" ? current.error : undefined }
  const gaps = () => listData()?.unknownFileMutationGaps ?? 0
  const badgeColor = (change: SessionChangeFile["change"]) => change === "added" ? theme.diffAdded : change === "removed" ? theme.diffRemoved : theme.warning

  const FolderSection = (row: Accessor<Extract<SessionChangesRow, { kind: "folder" }>>, index: Accessor<number>) => {
    const selected = () => controls().cursor() === index()
    return <box ref={element => onCleanup(controls().registerSection(row().key, element))} flexDirection="column" marginTop={index() > 0 ? 1 : 0}>
      <box ref={element => onCleanup(controls().registerHeader(row().key, element))} flexDirection="row" alignItems="center" gap={1} width="100%" paddingLeft={1} paddingRight={1}
        backgroundColor={theme.backgroundRaised} onMouseDown={() => { controls().setCursor(index()); controls().toggleExpanded(row().key) }}>
        <text fg={selected() ? theme.primary : theme.text} attributes={BOLD}>{`${selected() ? "> " : "  "}${sessionChangeFolderLabel(row(), props.projectRoot)}`}</text>
        <text fg={theme.diffRemoved}>removed</text>
        <text fg={theme.textMuted}>{controls().isExpanded(row().key) ? "▾" : "▸"}</text>
      </box>
    </box>
  }

  const FileSection = (file: Accessor<SessionChangeFile>, index: Accessor<number>) => {
    const fileId = () => file().fileId
    const currentFile = () => listData()?.files.find(candidate => candidate.fileId === fileId()) ?? file()
    const label = () => sessionChangePathLabel(currentFile().path, props.projectRoot)
    const selected = () => controls().cursor() === index()
    const diff = () => state()?.diffs.get(fileId())
    const readyDiff = () => { const current = diff(); return current?.status === "ready" ? current.diff : undefined }
    const complete = () => { const current = diff(); return current?.status === "ready" && current.complete }
    const undo = () => { const current = state()?.undo; return current?.fileId === fileId() ? current : undefined }
    const undoResult = () => { const current = undo(); return current?.status === "result" ? current.result : undefined }
    const canUndo = () => props.view?.controller.canUndo(fileId()) ?? false
    const canConfirmUndo = () => { state(); return props.view?.controller.canConfirmUndo() ?? false }
    const undoUnavailableReason = () => { state(); return props.view?.controller.undoUnavailableReason(fileId()) }
    const viewedMutation = () => { const current = state()?.viewed; return current?.fileId === fileId() ? current : undefined }
    const viewedMessage = () => {
      const current = viewedMutation()
      if (current?.status === "refused") return `Viewed refused: ${current.error}`
      if (current?.status === "unknown") return "Viewed outcome unknown; refreshing"
    }
    const viewed = () => currentFile().review.status === "viewed"
    return <box ref={element => onCleanup(controls().registerSection(fileId(), element))} flexDirection="column" marginTop={index() > 0 ? 1 : 0} paddingLeft={currentFile().folder ? 2 : 0}>
      <box ref={element => onCleanup(controls().registerHeader(fileId(), element))} flexDirection="row" alignItems="center" gap={1} width="100%" paddingLeft={1} paddingRight={1}
        backgroundColor={theme.backgroundRaised} onMouseDown={() => controls().setCursor(index())}>
        <text fg={selected() ? theme.primary : theme.text} attributes={BOLD}>{`${selected() ? "> " : "  "}${label()}`}</text>
        <text fg={badgeColor(currentFile().change)}>{currentFile().change}</text>
        <Show when={sessionChangeWritersLabel(currentFile())}>{writers => <text fg={theme.agentName} flexShrink={1} wrapMode="none" overflow="hidden">{writers()}</text>}</Show>
        <box flexGrow={1} />
        <Button label={currentFile().review.status === "unknown" ? "[-] Review unknown" : `${viewed() ? "[x]" : "[ ]"} Viewed`} hotkey="v" disabled={!props.view?.controller.canSetViewed(fileId())} onPress={() => controls().toggleViewed(currentFile())} />
        <Button label="Undo" hotkey="u" disabled={!canUndo()} onPress={() => controls().requestUndo(fileId())} />
        <Show when={!canUndo() && undoUnavailableReason()}>{reason => <text fg={theme.textMuted}>{reason()}</text>}</Show>
      </box>
      <Show when={viewedMessage()}>{message => <text fg={theme.warning}>{`  ${message()}`}</text>}</Show>
      <Show when={undo()}>{current => <box flexDirection="column" paddingLeft={2}>
        <Show when={current().status === "confirming"}>
          <text fg={theme.warning} attributes={BOLD}>{`Undo all changes to ${label()}?`}</text>
          <box flexDirection="row" gap={1}>
            <Button label="Confirm" hotkey="y" disabled={!canConfirmUndo()} onPress={() => controls().confirmUndo()} />
            <Button label="Cancel" hotkey="Esc" muted onPress={() => controls().cancelUndo()} />
          </box>
          <Show when={!canConfirmUndo()}><text fg={theme.textMuted}>{undoUnavailableReason()}</text></Show>
        </Show>
        <Show when={current().status === "submitting"}><text fg={theme.textMuted}>Undoing...</text></Show>
        <Show when={undoResult()}>{result => <text fg={result().status === "completed" ? theme.success : theme.warning}>{undoResultLine(result())}</text>}</Show>
        <Show when={current().status === "unknown"}><text fg={theme.warning}>Undo outcome unknown; refreshing</text></Show>
      </box>}</Show>
      <Show when={!viewed()}>
      <Show when={readyDiff()} fallback={<text fg={theme.textMuted}>{`  ${sessionChangeDiffStatusLine(diff())}`}</text>}>
        {ready => <NetDiff diff={ready()} complete={complete()} expanded={controls().isExpanded(fileId())} onToggle={() => controls().toggleExpanded(fileId())} diffColors={props.diffColors} />}
      </Show>
      </Show>
    </box>
  }

  return <ModalFrame title={KERNEL_COMMAND_NAMES.changes} width={modalWidth()} onClose={() => controls().close()}>
    <text fg={theme.textMuted}>{`Session: ${props.view?.controller.sessionId ?? "none"} | ${sessionChangesLabel(state()?.summary)}`}</text>
    <Show when={gaps() > 0}><text fg={theme.warning}>{`${gaps()} change${gaps() === 1 ? "" : "s"} could not be read; the list may be incomplete and Undo is unavailable`}</text></Show>
    <Show when={summaryError() ?? listError()}>{error => <text fg={theme.error}>{`Could not read changes: ${error()}`}</text>}</Show>
    <scrollbox ref={target => controls().attachScroll(target)} height={listMaxHeight()} width="100%">
      <Show when={list()?.status === "loading" && !listData() && summaryError() === undefined}><text fg={theme.textMuted}>Loading...</text></Show>
      <Show when={listData()?.files.length === 0}><text fg={theme.textMuted}>No files changed in this session.</text></Show>
      <Key each={controls().rows()} by={row => row.key}>{(row, index) => {
        const current = row()
        // A row's key fixes its kind, so each accessor keeps the latest row of the kind it mounted.
        return current.kind === "folder" ? FolderSection(() => { const latest = row(); return latest.kind === "folder" ? latest : current }, index) : FileSection(() => { const latest = row(); return latest.kind === "file" ? latest.file : current.file }, index)
      }}</Key>
    </scrollbox>
    <text fg={theme.textMuted}>Up/Down file | Enter expand | v Viewed | u Undo | PgUp/PgDn scroll | Esc close</text>
  </ModalFrame>
}
