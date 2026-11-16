/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal, For, Show, untrack } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { bg as stBg, fg as stFg, StyledText, type RGBA } from "@opentui/core"
import type { LeadRow } from "../../../protocol/modules/lead.js"
import { useTheme } from "../../context/theme.js"
import { useTickPool } from "../../context/tick-pool-context.js"
import type { TuiStripKeyEvent, TuiStripProps } from "../../tui-module.js"
import { bindStyledTextContent } from "../../utils/reactive-text.js"
import { useHoverHighlight } from "../../hooks/use-hover-highlight.js"
import { isCtrlChord } from "./chat-viewer.js"
import { useLeadScreen, type LeadScreen } from "./client.js"
import { followSelection, layoutLeadRow, leadAge, leadListWindow, leadTitleColumn, LEAD_STATE_LOOK } from "./list-model.js"

/** The columns the list keeps clear on each side, so its rows line up with the text inside the composer frame above. */
const SIDE_INSET = 2
const HINT = "↑↓ move · enter open · ctrl+t tab · x close · esc input"
/** The close mark at the right end of the row under the pointer. Its columns stay reserved on every row, so the row's
 *  text never moves when the mark shows. */
const CLOSE_MARK = " ×"

/** The list of the chats in use, below the lead's input (PI-LEAD-004). It
 *  shows only on the lead's own screen and only while a chat has a row. */
export function LeadStrip(props: TuiStripProps) {
  const screen = useLeadScreen()
  return <Show when={props.sessionId === screen.leadSessionId() && screen.rows().length > 0}>
    <LeadList strip={props} screen={screen} />
  </Show>
}

function LeadList(props: { readonly strip: TuiStripProps; readonly screen: LeadScreen }) {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const tick = useTickPool().createSharedTick(1000, () => true)
  const now = createMemo(() => { tick(); return Date.now() })
  const rows = (): readonly LeadRow[] => props.screen.rows()
  const ids = createMemo(() => rows().map((row) => row.sessionId))
  // Each move is a new object, so choosing the chat already chosen still counts as a choice.
  const [chosen, setChosen] = createSignal<{ readonly id: string | undefined }>({ id: undefined })
  // The selection is a chat, not an index: it follows its chat when the rows reorder.
  const selection = createMemo<{ readonly ids: readonly string[]; readonly chosen: { readonly id: string | undefined }; readonly id: string | undefined }>((previous) => {
    const next = ids()
    const choice = chosen()
    return { ids: next, chosen: choice, id: choice === previous.chosen ? followSelection(previous.ids, next, previous.id) : choice.id }
  }, { ids: [], chosen: { id: undefined }, id: undefined })
  const selectedIndex = (): number | undefined => {
    const index = ids().indexOf(selection().id ?? "")
    return index < 0 ? undefined : index
  }
  // The claim lasts for the list's lifetime, so it is taken once.
  const claim = untrack(() => props.strip.keys).claim({ chords: ["up", "down", "enter", "ctrl+t", "x"], onKey })
  const window = createMemo<ReturnType<typeof leadListWindow>>((previous) => leadListWindow({
    total: rows().length, selected: claim.focused() ? selectedIndex() : undefined, start: claim.focused() ? previous.start : 0, terminalRows: dimensions().height,
  }), { start: 0, count: 0, above: 0, below: 0 })
  const visible = createMemo(() => rows().slice(window().start, window().start + window().count))
  const titleColumn = createMemo(() => leadTitleColumn(visible().map((row) => props.screen.title(row.sessionId))))

  function onKey(event: TuiStripKeyEvent): boolean {
    if (!claim.focused()) {
      if (event.ctrl || event.meta || event.shift || event.name !== "down" || !props.strip.composer.empty()) return false
      setChosen({ id: ids()[0] })
      claim.setFocused(true)
      return true
    }
    const row = rows().find((candidate) => candidate.sessionId === selection().id)
    if (isCtrlChord(event, "t")) {
      if (row) props.screen.openTab(row.sessionId)
      return true
    }
    if (event.ctrl || event.meta || event.shift) return false
    const index = selectedIndex() ?? 0
    switch (event.name) {
      case "up":
        if (index === 0) claim.setFocused(false)
        else setChosen({ id: ids()[index - 1] })
        return true
      case "down": setChosen({ id: ids()[Math.min(index + 1, ids().length - 1)] }); return true
      case "return":
      case "enter": if (row) props.screen.openChat(row.sessionId); return true
      case "escape": claim.setFocused(false); return true
      case "x": if (row) close(row.sessionId); return true
      default: return false
    }
  }

  /** Closes a chat and moves the selection to the next row, or to the row before at the end, or gives focus back to
   *  the input when no row is left. The row leaves once the runtime records the close. */
  function close(sessionId: string): void {
    const order = ids()
    const index = order.indexOf(sessionId)
    const next = order[index + 1] ?? order[index - 1]
    if (claim.focused()) {
      if (next === undefined) claim.setFocused(false)
      else setChosen({ id: next })
    }
    props.screen.closeChat(sessionId)
  }

  const width = () => Math.max(1, props.strip.width() - 2 * SIDE_INSET - CLOSE_MARK.length)
  function rowContent(row: LeadRow, age: string): StyledText {
    const look = LEAD_STATE_LOOK[row.state]
    const layout = layoutLeadRow({ state: row.state, title: props.screen.title(row.sessionId), status: row.status, age }, { width: width(), titleColumn: titleColumn() })
    const selected = claim.focused() && selection().id === row.sessionId
    const paint = (color: RGBA) => (text: string) => selected ? stBg(theme.selectionBackground)(stFg(theme.selectionForeground)(text)) : stFg(color)(text)
    return new StyledText([paint(theme[look.tone])(layout.mark), paint(theme.text)(layout.title), paint(theme.textMuted)(`${layout.status}${layout.age}`)])
  }

  return <box flexDirection="column" flexShrink={0} paddingLeft={SIDE_INSET} paddingRight={SIDE_INSET}>
    <Show when={window().above > 0}><text fg={theme.textMuted} wrapMode="none">{`+${window().above} above`}</text></Show>
    <For each={visible()}>{(row) => {
      // The clock ticks each second, and a row's text changes only when its age does.
      const age = createMemo(() => leadAge(row.since, now()))
      const hover = useHoverHighlight()
      // A press opens the chat and leaves focus and the selection as they were, so closing the chat goes back to the
      // input or the row that had focus before (PI-LEAD-005).
      return <box flexDirection="row" selectable={false} backgroundColor={hover.background()} {...hover.handlers} onMouseDown={() => { props.screen.openChat(row.sessionId) }}>
        <text selectable={false} flexGrow={1} ref={bindStyledTextContent(() => rowContent(row, age()))} wrapMode="none" overflow="hidden" />
        <box selectable={false} flexShrink={0} width={CLOSE_MARK.length} onMouseDown={(event) => { event.stopPropagation(); close(row.sessionId) }}>
          <text selectable={false} fg={theme.textMuted} wrapMode="none">{hover.hovered() ? CLOSE_MARK : " ".repeat(CLOSE_MARK.length)}</text>
        </box>
      </box>
    }}</For>
    <Show when={window().below > 0}><text fg={theme.textMuted} wrapMode="none">{`+${window().below} more`}</text></Show>
    <Show when={claim.focused()}><text fg={theme.textMuted} wrapMode="none">{HINT}</text></Show>
  </box>
}
