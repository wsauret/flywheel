/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal, For, Show, untrack } from "solid-js"
import { useTerminalDimensions } from "@opentui/solid"
import { bg as stBg, fg as stFg, StyledText, type RGBA } from "@opentui/core"
import type { LeadRow } from "../../../protocol/modules/lead.js"
import { useTheme } from "../../context/theme.js"
import { useTickPool } from "../../context/tick-pool-context.js"
import type { TuiStripKeyEvent, TuiStripProps } from "../../tui-module.js"
import { bindStyledTextContent } from "../../utils/reactive-text.js"
import { useLeadScreen, type LeadScreen } from "./client.js"
import { followSelection, layoutLeadRow, leadAge, leadListWindow, LEAD_STATE_LOOK } from "./list-model.js"

/** The columns the list keeps clear on each side, so its rows line up inside the composer frame below. */
const SIDE_INSET = 2

/** The list of the chats the lead started, above the lead's input
 *  (PI-LEAD-004). It shows only on the lead's own screen and only while a
 *  chat has a row. */
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
  const claim = untrack(() => props.strip.keys).claim({ chords: ["up", "down", "enter", "space", "ctrl+g"], onKey })
  const window = createMemo<ReturnType<typeof leadListWindow>>((previous) => leadListWindow({
    total: rows().length, selected: claim.focused() ? selectedIndex() : undefined, start: claim.focused() ? previous.start : 0, terminalRows: dimensions().height,
  }), { start: 0, count: 0, more: 0 })
  const visible = createMemo(() => rows().slice(window().start, window().start + window().count))

  function move(step: -1 | 1): void {
    const index = Math.min(Math.max(0, (selectedIndex() ?? 0) + step), ids().length - 1)
    setChosen({ id: ids()[index] })
  }

  function onKey(event: TuiStripKeyEvent): boolean {
    const plain = !event.ctrl && !event.meta && !event.shift
    if (event.ctrl && !event.meta && !event.shift && event.name === "g") return props.screen.openLongestWaiting()
    if (!claim.focused()) {
      if (!plain || event.name !== "down" || !props.strip.composer.empty()) return false
      setChosen({ id: ids()[0] })
      claim.setFocused(true)
      return true
    }
    if (!plain) return false
    switch (event.name) {
      case "up": move(-1); return true
      case "down": move(1); return true
      case "return":
      case "enter": {
        const row = rows().find((candidate) => candidate.sessionId === selection().id)
        if (row) props.screen.openReader(row)
        return true
      }
      // The peek opens on Space (L13); until then Space only never types.
      case "space": return true
      case "escape": claim.setFocused(false); return true
      default: return false
    }
  }

  const width = () => Math.max(1, props.strip.width() - 2 * SIDE_INSET)
  function rowContent(row: LeadRow, age: string): StyledText {
    const look = LEAD_STATE_LOOK[row.state]
    const layout = layoutLeadRow({ state: row.state, title: props.screen.title(row.sessionId), update: row.update, age }, width())
    const selected = claim.focused() && selection().id === row.sessionId
    const paint = (color: RGBA) => (text: string) => selected ? stBg(theme.selectionBackground)(stFg(theme.selectionForeground)(text)) : stFg(color)(text)
    return new StyledText([
      paint(theme[look.tone])(look.mark), paint(theme.textMuted)(layout.prefix.slice(look.mark.length)), paint(theme.text)(layout.title), paint(theme.textMuted)(`${layout.separator}${layout.update}${layout.gap}${layout.age}`),
    ])
  }
  const hint = () => claim.focused() ? "↑↓ move · enter open · esc input" : "↓ list · ctrl+g longest wait"

  return <box flexDirection="column" flexShrink={0} paddingLeft={SIDE_INSET} paddingRight={SIDE_INSET}>
    <For each={visible()}>{(row) => {
      // The clock ticks each second, and a row's text changes only when its age does.
      const age = createMemo(() => leadAge(row.since, now()))
      return <text ref={bindStyledTextContent(() => rowContent(row, age()))} wrapMode="none" overflow="hidden" />
    }}</For>
    <Show when={window().more > 0}><text fg={theme.textMuted} wrapMode="none">{`+${window().more} more`}</text></Show>
    <text fg={theme.textMuted} wrapMode="none">{hint()}</text>
  </box>
}
