/** @jsxImportSource @opentui/solid */

import type { TuiFaultNotice } from "../tui-module.js"
import { Show } from "solid-js"
import { Button } from "./button.js"
import { useTheme } from "../context/theme.js"
import { BOLD } from "../utils/text-attributes.js"

/** The runtime's one notice. Before the first session it takes the viewport;
 *  after, it sits above the composer and the transcript stays readable. A
 *  fault reads in the error color and a warning, which asks nothing of the
 *  person, in the warning color. */
export function RuntimeNotice(props: { readonly notice: TuiFaultNotice; readonly placement: "viewport" | "composer" }) {
  const { theme } = useTheme()
  return <box flexDirection="column" {...(props.placement === "viewport"
    ? { flexGrow: 1, justifyContent: "center", alignItems: "center", gap: 1 } as const
    : { paddingLeft: 2, paddingRight: 1, paddingBottom: 1 } as const)}>
    <text fg={props.notice.tone === "fault" ? theme.error : theme.warning} attributes={BOLD}>{props.notice.title}</text>
    <text fg={theme.textMuted}>{props.notice.remedy}</text>
    <text fg={theme.textMuted}>{props.notice.detail}</text>
    <Show when={props.notice.copyReport}>{(copy) => <Button label="Copy report" onPress={copy()} />}</Show>
  </box>
}
