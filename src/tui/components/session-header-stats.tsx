/** @jsxImportSource @opentui/solid */
import { Show } from "solid-js"
import type { HeaderDisplay } from "../hooks/create-header-display.js"
import type { SessionSurface } from "../hooks/create-session-surface.js"
import { bindStyledTextContent } from "../utils/reactive-text.js"
import { ContextControl } from "./context-control.js"

/** A chat's statistics line with its context control, which opens the chat's
 *  context reading and compacts that chat. The tab bar shows it for the tab in
 *  front, and a view of a chat shows it for the chat it shows (PI-LEAD-005). */
export function SessionHeaderStats(props: {
  readonly header: HeaderDisplay
  readonly surface: Pick<SessionSurface, "sessionId" | "status">
  readonly compact: (sessionId: string) => Promise<boolean>
}) {
  const stats = () => props.header.headerStats()
  return <box position="relative" height={1}>
    <text ref={bindStyledTextContent(() => stats().content)} overflow="hidden" wrapMode="none" />
    <Show when={stats().context}>
      {(context) =>
      // One control for each chat, so a reading opened for one chat closes when another shows.
      <Show when={props.surface.sessionId()} keyed>
        {(sessionId) => <ContextControl overlayLeft={context().left} label={context().label} color={context().color} copy={props.header.contextCopy()}
          compacting={(props.surface.status()?.compactionStartedAt ?? null) !== null} onCompact={() => props.compact(sessionId)} />}
      </Show>
      }
    </Show>
  </box>
}
