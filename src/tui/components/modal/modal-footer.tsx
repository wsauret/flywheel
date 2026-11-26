/** @jsxImportSource @opentui/solid */

import { For } from "solid-js"
import { useTheme } from "@tui/context/theme"

export function ModalFooter(props: { readonly rows: readonly string[]; readonly align?: "left" | "center" }) {
  const { theme } = useTheme()
  return (
    <box flexDirection="column" height={props.rows.length} alignItems={props.align === "left" ? "flex-start" : "center"}>
      <For each={props.rows}>{(row) => <text fg={theme.textMuted} overflow="hidden" wrapMode="none" truncate>{row || " "}</text>}</For>
    </box>
  )
}
