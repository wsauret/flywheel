import { createSignal } from "solid-js"
import { scrollEdges } from "./scroll-edges.js"

import { actionKey } from "../client/action-key.js"
import { useClient } from "./client-context.js"
import { Icon, ICONS } from "./icons.js"
import { SessionList } from "./session-list.js"
import { useSessionActions } from "./session-actions.js"

/** The session list as the phone's own screen: the one a chat sits above and
 *  a back swipe returns to. Its header names the project and the machine the
 *  phone is attached to, and is the way to the machines sheet, the way a chat
 *  header names the chat. The rows, actions, and search are the rail's. */
export function SessionsScreen() {
  const client = useClient()
  const [filter, setFilter] = createSignal("")
  const actions = useSessionActions()
  const placement = () => client.stack?.placement()
  return (
    <section class="screen-sessions" aria-label="Sessions">
      <header class="toolbar">
        <button class="toolbar-sessions" aria-haspopup="dialog" aria-busy={(() => { const action = placement()?.action; return action?.kind === "command" && client.actions.commandWorking(client.state().sessionId, action.id) })() || undefined} onClick={() => {
          const action = placement()?.action
          if (action?.kind === "surface") client.openSurface(action.id)
          else if (action?.kind === "command") client.actions.invokeCommand(action.id)
        }}>
          <span class="toolbar-heading">
            <span class="toolbar-title">{placement()?.project ?? "Flywheel"}</span>
            <span class="toolbar-subtitle">{placement()?.machine ?? "No machine selected"}</span>
          </span>
          <Icon path={ICONS.chevronDown} />
        </button>
        <span class="toolbar-spacer" />
        <button class="ghost" title="New chat" aria-label="New chat" aria-busy={client.actions.working(actionKey("new-chat")) || undefined} onClick={() => { client.actions.newSession(); client.stack?.openChat() }}>
          <Icon path={ICONS.plus} />
        </button>
      </header>
      <div class="screen-tools">
        <label class="rail-search">
          <Icon path={ICONS.search} size={13} />
          {/* Not focused on arrival: a focused field raises the keyboard over
              the very list this screen exists to show. */}
          <input
            type="search"
            placeholder="Search chats"
            aria-label="Search chats"
            value={filter()}
            onInput={(event) => setFilter(event.currentTarget.value)}
          />
        </label>
      </div>
      <div class="rail-list scroll-edges" ref={scrollEdges} role="listbox" aria-label="Chats">
        <SessionList
          sessions={client.state().sessions}
          errors={client.state().sessionErrors}
          selected={client.state().sessionId}
          shown={client.stack?.screen() === "sessions"}
          grouped
          filter={filter()}
          actions={actions}
        />
      </div>
    </section>
  )
}
