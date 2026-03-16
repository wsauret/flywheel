/** @jsxImportSource @opentui/solid */
/**
 * Approval Gate Content Component
 *
 * Displays approval gate reason and info text.
 */

import { createMemo, For } from "solid-js"
import { useTheme } from "@tui/shared/context/theme"

/** Word-wrap text to fit within maxWidth. */
function wrapText(text: string, maxWidth: number): string[] {
  if (maxWidth <= 0 || text.length <= maxWidth) return [text];
  const lines: string[] = [];
  const words = text.split(" ");
  let current = "";
  for (const word of words) {
    if (!current) { current = word; }
    else if (current.length + 1 + word.length <= maxWidth) { current += " " + word; }
    else { lines.push(current); current = word; }
  }
  if (current) lines.push(current);
  return lines.length > 0 ? lines : [""];
}

export interface ApprovalGateContentProps {
  reason?: string
  modalWidth: number
}

export function ApprovalGateContent(props: ApprovalGateContentProps) {
  const themeCtx = useTheme()

  const wrappedReason = createMemo(() =>
    wrapText(props.reason || "Approval gate triggered - please review the current state", props.modalWidth - 4)
  )

  const wrappedInfo = createMemo(() =>
    wrapText("Execution paused - review the output, then press Continue to proceed or Reject to halt.", props.modalWidth - 4)
  )

  const separatorLine = () => "-".repeat(props.modalWidth)

  return (
    <>
      {/* Reason */}
      <box paddingTop={1} flexDirection="column">
        <For each={wrappedReason()}>
          {(line) => <text fg={themeCtx.theme.warning}>{line}</text>}
        </For>
      </box>

      {/* Info */}
      <box paddingTop={1} flexDirection="column">
        <For each={wrappedInfo()}>
          {(line) => <text fg={themeCtx.theme.text}>{line}</text>}
        </For>
      </box>

      {/* Separator */}
      <box paddingTop={1}>
        <text fg={themeCtx.theme.textMuted}>{separatorLine()}</text>
      </box>
    </>
  )
}
