import { createSignal } from "solid-js"
import { scrollEdges } from "./scroll-edges.js"

import { actionKey } from "../client/action-key.js"
import { useClient } from "./client-context.js"
import { Icon, ICONS } from "./icons.js"
import { SessionList } from "./session-list.js"
import { useSessionActions } from "./session-actions.js"

/** The always-visible session list a wide container earns: the terminal's tab
 *  bar and sessions modal folded into one column beside the transcript. A
 *  narrow container gets the same list as a sheet instead. */
export function SessionRail() {
  const client = useClient()
  const [filter, setFilter] = createSignal("")
  const actions = useSessionActions()
  return (
    <aside class="rail" aria-label="Sessions">
      <div class="rail-head">
        <label class="rail-search">
          <Icon path={ICONS.search} size={13} />
          <input
            type="search"
            placeholder="Search chats"
            aria-label="Search chats"
            value={filter()}
            onInput={(event) => setFilter(event.currentTarget.value)}
          />
        </label>
        <button class="ghost" title="New chat" aria-label="New chat" aria-busy={client.actions.working(actionKey("new-chat")) || undefined} onClick={() => client.actions.newSession()}>
          <Icon path={ICONS.plus} />
        </button>
      </div>
      <div class="rail-list scroll-edges" ref={scrollEdges} role="listbox" aria-label="Chats">
        <SessionList
          sessions={client.state().sessions}
          errors={client.state().sessionErrors}
          selected={client.state().sessionId}
          grouped
          filter={filter()}
          actions={actions}
        />
      </div>
    </aside>
  )
}
