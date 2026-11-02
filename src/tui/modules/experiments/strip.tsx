/** @jsxImportSource @opentui/solid */

import { StyledText, bold as stBold, fg as stFg, type TextRenderable } from "@opentui/core"
import { createEffect, createMemo, Index, Show } from "solid-js"
import { experimentViewDomain } from "../../../protocol/modules/experiments.js"
import { Button } from "../../components/button.js"
import { useTheme } from "../../context/theme.js"
import { useSpinnerFrame } from "../../hooks/use-spinner-frame.js"
import type { TuiStripProps } from "../../tui-module.js"
import { renderDashboardLines } from "./dashboard-lines.js"

/** The surface the strip's button and the `/experiment dashboard` outcome open. */
export const DASHBOARD_SURFACE = "experiment-dashboard"

/** Recent runs shown above the composer; the dashboard surface shows every run. */
const PANEL_MAX_ROWS = 3

/** Lines the panel adds above the dashboard rows: the title row. */
const TITLE_INDENT = "  "

export function ExperimentStrip(props: TuiStripProps) {
  const { theme } = useTheme()
  const view = () => props.read(experimentViewDomain)
  const spinner = useSpinnerFrame(() => view()?.running ?? false)
  // One reserved cell: the frame while running, a space otherwise, so the
  // title never shifts when a run starts or settles.
  const spinnerCell = () => (view()?.running ? spinner() : " ")
  const lines = createMemo(() => {
    const current = view()
    return current ? renderDashboardLines(current, props.width(), theme, PANEL_MAX_ROWS) : []
  })
  const title = () => {
    const current = view()
    const name = current?.name ? ` · ${current.name}` : ""
    return new StyledText([
      stFg(theme.textMuted)(TITLE_INDENT),
      stFg(theme.primary)(spinnerCell()),
      stFg(theme.textMuted)(" "),
      stBold(stFg(theme.primary)("Experiment")),
      stFg(theme.textMuted)(name),
      stFg(theme.textMuted)(current?.active ? "" : " · off"),
    ])
  }
  return (
    <Show when={view()}>
      <box flexDirection="column" width={props.width()} paddingBottom={1} selectable={false}>
        <box flexDirection="row" justifyContent="space-between" height={1}>
          <text ref={(el: TextRenderable) => { createEffect(() => { el.content = title() }) }} overflow="hidden" wrapMode="none" />
          <Button label="Dashboard" onPress={() => props.openSurface(DASHBOARD_SURFACE)} muted />
        </box>
        <Index each={lines()}>
          {(line) => <text ref={(el: TextRenderable) => { createEffect(() => { el.content = new StyledText([...line()]) }) }} overflow="hidden" wrapMode="none" height={1} />}
        </Index>
      </box>
    </Show>
  )
}
