import { Key } from "@solid-primitives/keyed"
import { Show } from "solid-js"

import type { SessionNoticeSummary } from "../client/session.js"
import { Icon, ICONS } from "./icons.js"

/** Session notices keyed by their runtime-owned scope, so equal frame
 *  projections update rows in place instead of rebuilding their DOM. */
export function SessionNotices(props: {
  readonly notices: readonly SessionNoticeSummary[]
  readonly hasHostCommand: (command: string) => boolean
  readonly runHostCommand: (command: string) => void
  readonly dismiss: (scope: string) => void
  /** Whether a dismiss of the notice under `scope` waits on the runtime. */
  readonly dismissing: (scope: string) => boolean
}) {
  return (
    <Key each={props.notices} by={(notice) => notice.scope}>
      {(notice) => (
        <div class={`notice severity-${notice().severity}`}>
          <div class="notice-text">
            <span class="notice-title">{notice().title}</span>
            <span class="notice-message">{notice().message}</span>
          </div>
          <Show when={notice().actionLabel && notice().actionCommand && props.hasHostCommand(notice().actionCommand ?? "")}>
            <button class="notice-action" onClick={() => props.runHostCommand(notice().actionCommand ?? "")}>{notice().actionLabel}</button>
          </Show>
          <button class="row-action" title="Dismiss" aria-label={`Dismiss ${notice().title}`} aria-busy={props.dismissing(notice().scope) || undefined} onClick={() => props.dismiss(notice().scope)}>
            <Icon path={ICONS.close} size={13} />
          </button>
        </div>
      )}
    </Key>
  )
}
