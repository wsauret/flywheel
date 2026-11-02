/** @jsxImportSource @opentui/solid */

import { createMemo, Match, Show, Switch } from "solid-js"
import type { RuntimeStartupStatus } from "../../protocol/app-service-types.js"
import type { RuntimeFaultCopy } from "../../protocol/client/runtime-fault-copy.js"
import { useTheme } from "../context/theme.js"
import { BOLD } from "../utils/text-attributes.js"
import { RuntimeNotice } from "./runtime-notice.js"
import { StartupProgress } from "./startup-progress.js"

/** Shows blocking startup work before a session owns the viewport. Startup
 *  faults outrank phases, and phases outrank the pending-chat placeholder. */
export function StartupViewport(props: {
  readonly foregroundKind: "pending" | "session" | undefined
  readonly status: RuntimeStartupStatus | null
  readonly fault: RuntimeFaultCopy | null
}) {
  const { theme } = useTheme()
  const available = () => props.foregroundKind !== "session"
  const fault = () => available() ? props.fault : null
  const phase = createMemo(() => {
    const status = available() ? props.status : null
    return !props.fault && status?.kind === "phase" ? status : null
  })

  return <Switch>
    <Match when={fault()}>
      {(notice) => <RuntimeNotice notice={notice()} placement="viewport" />}
    </Match>
    <Match when={phase()}>
      {(current) => (
        <box flexGrow={1} flexDirection="column" justifyContent="center" alignItems="center" gap={1}>
          <text fg={theme.primary} attributes={BOLD}>Starting Flywheel</text>
          <text fg={theme.textMuted}>{`${current().label}...`}</text>
          <Show when={current().progress}>
            {(progress) => <StartupProgress step={progress().step} total={progress().total} width={24} />}
          </Show>
        </box>
      )}
    </Match>
    <Match when={props.foregroundKind === "pending"}>
      <box flexGrow={1} justifyContent="center" alignItems="center">
        <text fg={theme.textMuted}>Opening chat...</text>
      </box>
    </Match>
  </Switch>
}
