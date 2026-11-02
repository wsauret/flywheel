/** @jsxImportSource @opentui/solid */

import { useTheme } from "@tui/context/theme"
import { BOLD } from "@tui/utils/text-attributes"
import { For, type JSX } from "solid-js"

/** A headed block. The blank line sits before the heading so headings never float away from their content. */
export function Section(props: { title: string; children: JSX.Element; first?: boolean }) {
  const { theme } = useTheme()
  return <box flexDirection="column" marginTop={props.first ? 0 : 1}><text fg={theme.text} attributes={BOLD}>{props.title}</text>{props.children}</box>
}

export type FactTone = "text" | "muted" | "success" | "warning" | "error"
export interface Fact { readonly label: string; readonly value: string; readonly tone?: FactTone; readonly wrap?: boolean }

/** Label and value rows that share one label column, so values start together. */
export function Facts(props: { rows: readonly Fact[] }) {
  const { theme } = useTheme()
  const width = () => Math.max(0, ...props.rows.map((row) => row.label.length))
  const color = (tone: FactTone | undefined) => tone === "muted" ? theme.textMuted : tone === "success" ? theme.success : tone === "warning" ? theme.warning : tone === "error" ? theme.error : theme.text
  return <box flexDirection="column"><For each={props.rows}>{(row) => <box flexDirection="row" gap={2} alignItems="flex-start"><text fg={theme.textMuted} flexShrink={0}>{row.label.padEnd(width())}</text><text fg={color(row.tone)} flexShrink={1} overflow="hidden" wrapMode={row.wrap ? "word" : "none"} truncate={!row.wrap}>{row.value}</text></box>}</For></box>
}
