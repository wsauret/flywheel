/** @jsxImportSource @opentui/solid */

import { StyledText, fg as stFg, type TextRenderable, type ScrollBoxRenderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, Show } from "solid-js"
import { Key } from "@solid-primitives/keyed"
import { mcpEnabledAction, mcpProjectEnabledAction, mcpRemovalConfirmation, mcpScopeDetail, type McpStatusRow, MCP_COMMAND_NAME } from "../../../protocol/modules/mcp.js"
import { Button } from "../../components/button.js"
import { ModalFooter } from "../../components/modal-footer.js"
import { ModalFrame } from "../../components/modal-frame.js"
import { useListSelectionReveal } from "../../hooks/use-list-selection-reveal.js"
import { useTheme } from "../../context/theme.js"
import type { TuiTheme } from "../../context/theme/resolve.js"
import { useHoverHighlight } from "../../hooks/use-hover-highlight.js"
import { useModalDimensions } from "../../hooks/use-modal-dimensions.js"
import { BOLD } from "../../utils/text-attributes.js"
import { displayWidth, truncateToWidth } from "../../utils/text.js"
import type { McpList } from "./list.js"

/** Scoped server management uses protocol rows and opening-owned review state. */
export function McpModal(props: { list: McpList }) {
  const { theme } = useTheme()
  const { modalWidth, listMaxHeight } = useModalDimensions(72)
  const rows = () => props.list.rows()
  const cursor = () => props.list.cursor()
  const review = () => props.list.review()
  const [viewport, setViewport] = createSignal<ScrollBoxRenderable>()
  const removal = createMemo(() => {
    const state = review()
    return state ? mcpRemovalConfirmation({ ...state.row, name: truncateToWidth(state.row.name, modalWidth() - 18) }) : undefined
  })
  const menu = createMemo(() => {
    const row = props.list.selected()
    return row && !review() && !props.list.pending() ? menuActions(row, props.list) : []
  })
  const keyWidth = () => Math.max(0, ...menu().map((action) => displayWidth(action.key)))
  useListSelectionReveal({
    viewport,
    revision: () => props.list.navigationRevision(),
    layout: () => [rows(), menu().length, modalWidth(), listMaxHeight()],
    elements: (scroll) => rows()?.flatMap((row) => { const element = scroll.content.findDescendantById(`mcp:${row.name}`); return element ? [element] : [] }) ?? [],
    reveal: (scroll) => {
      const row = props.list.selected()
      if (!row) return false
      scroll.scrollChildIntoView(`mcp:${row.name}`)
      return true
    },
  })
  return (
    <ModalFrame title={MCP_COMMAND_NAME} width={modalWidth()} onClose={props.list.close}>
      <box height={1} />
      <Show when={rows()} fallback={<text fg={theme.textMuted}>Loading MCP servers...</text>}>{(servers) =>
      <Show when={servers().length > 0} fallback={<text fg={theme.textMuted}>No MCP servers configured.</text>}>
        <scrollbox ref={setViewport} height={Math.min(review() ? Math.max(2, listMaxHeight() - 8) : listMaxHeight(), servers().length * 2 + menu().length)} scrollbarOptions={{ visible: false }}>
          <Key each={servers()} by="name">{(row, index) => <box id={`mcp:${row().name}`}>
            <McpRow row={row()} active={cursor() === index()} width={modalWidth() - 9} onSelect={() => { props.list.select(index()); props.list.authenticate() }} />
            <box paddingLeft={4}><text fg={theme.textMuted}>{mcpScopeDetail(row())}</text></box>
            <Show when={cursor() === index()}>
              <Key each={menu()} by="key">{(action) => <McpActionLine action={action()} keyWidth={keyWidth()} />}</Key>
            </Show>
          </box>}</Key>
        </scrollbox>
      </Show>
      }</Show>
      <Show when={props.list.pending()}>{(pending) => <text fg={theme.textMuted} wrapMode="none" overflow="hidden">{pending()}</text>}</Show>
      <Show when={review()}>{(state) => <box paddingTop={1}>
        <text fg={theme.text} wrapMode="word">{removal()?.title}</text>
        <text fg={theme.textMuted} wrapMode="word">{removal()?.message}</text>
        <box flexDirection="row" gap={1}>
          <Button label="Cancel" focused={state().focus === 0} onPress={props.list.cancel} />
          <Button label="Remove" focused={state().focus === 1} onPress={props.list.confirm} />
        </box>
      </box>}</Show>
      <box paddingTop={1}><ModalFooter rows={[review() ? "←→/tab select · enter choose · esc cancel" : props.list.pending() ? "esc/q close" : "↑↓/j/k navigate · esc/q close"]} /></box>
    </ModalFrame>
  )
}

interface McpMenuAction {
  readonly key: string
  readonly label: string
  readonly destructive: boolean
  readonly run: () => void
}

function menuActions(row: McpStatusRow, list: McpList): readonly McpMenuAction[] {
  const project = mcpProjectEnabledAction(row)
  return [
    ...(row.status === "needs_auth" ? [{ key: "enter", label: "Authenticate", destructive: false, run: list.authenticate }] : []),
    { key: "e", label: mcpEnabledAction(row).label, destructive: false, run: () => list.setEnabled() },
    ...(project ? [{ key: "p", label: project.label, destructive: false, run: () => list.setEnabled(true) }] : []),
    { key: "d", label: "Remove", destructive: true, run: list.remove },
  ]
}

/** One menu line: the key column aligns across lines, and the hover highlight
 *  hugs the text so it never reads as the selected server row. */
function McpActionLine(props: { action: McpMenuAction; keyWidth: number }) {
  const { theme } = useTheme()
  const hover = useHoverHighlight()
  return (
    <box paddingLeft={3} flexDirection="row">
      <box flexDirection="row" paddingLeft={1} paddingRight={1} selectable={false} backgroundColor={hover.background()}
        {...hover.handlers} onMouseDown={() => props.action.run()}>
        <text selectable={false} flexShrink={0} fg={theme.primary} attributes={BOLD}>{props.action.key.padEnd(props.keyWidth + 2)}</text>
        <text selectable={false} wrapMode="none" overflow="hidden" fg={props.action.destructive ? theme.error : theme.text}>{props.action.label}</text>
      </box>
    </box>
  )
}

function McpRow(props: { row: McpStatusRow; active: boolean; width: number; onSelect: () => void }) {
  const { theme } = useTheme()
  const content = createMemo(() => rowContent(props.row, props.active, props.width, theme))
  return (
    <box selectable={false} backgroundColor={props.active ? theme.backgroundElement : undefined} paddingLeft={2} paddingRight={1} onMouseDown={() => props.onSelect()}>
      <text ref={(element: TextRenderable) => { createEffect(() => { element.content = content() }) }} overflow="hidden" wrapMode="none" />
    </box>
  )
}

function rowContent(row: McpStatusRow, active: boolean, width: number, theme: TuiTheme): StyledText {
  const left = `${active ? ">" : " "} ${truncateToWidth(row.name, Math.floor((width - 3) / 2))}`
  const statusDetail = row.status === "needs_auth" ? "authentication required" : row.error ? `${row.status}: ${row.error}` : `${row.status.padEnd(8)} ${toolsField(row.toolCount)}`
  const detail = truncateToWidth(statusDetail, width - displayWidth(left) - 1)
  return new StyledText([
    stFg(active ? theme.primary : theme.textMuted)(left),
    stFg(theme.text)(" ".repeat(Math.max(1, width - displayWidth(left) - displayWidth(detail)))),
    stFg(row.status === "ready" ? theme.success : row.status === "failed" || row.status === "needs_auth" ? theme.warning : theme.textMuted)(detail),
  ])
}

/** Fixed-width count and unit so the status column aligns across rows; the
 *  singular form pads with a trailing space to keep the right edge stable. */
function toolsField(count: number): string {
  return `${String(count).padStart(3)} tool${count === 1 ? " " : "s"}`
}
