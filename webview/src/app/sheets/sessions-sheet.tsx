import { createSignal } from "solid-js"

import { actionKey } from "../../client/action-key.js"
import { useClient } from "../client-context.js"
import { Icon, ICONS } from "../icons.js"
import { SessionList } from "../session-list.js"
import { useSessionActions } from "../session-actions.js"
import { Sheet } from "./sheet.js"
import { KERNEL_COMMAND_NAMES } from "../../../../src/protocol/command-names.js"

/** The session list as a sheet, for a container too narrow to hold the rail.
 *  The same rows, actions, and search as the rail; only the frame differs. */
export function SessionsSheet() {
  const client = useClient()
  const [filter, setFilter] = createSignal("")
  const actions = useSessionActions()
  // Focus opens on the search field under a fine pointer, where the sheet is
  // a keyboard switcher: Mod+K, type, Enter. Under a coarse pointer a focused
  // field raises the phone keyboard over the very list the sheet exists to
  // show, so there the list takes focus and a person who wants to filter taps
  // the field.
  const searchFirst = matchMedia("(pointer: fine)").matches
  return (
    <Sheet
      title={KERNEL_COMMAND_NAMES.sessions}
      onClose={client.closeSheet}
      tools={
        <button class="ghost" title="New chat" aria-label="New chat" aria-busy={client.actions.working(actionKey("new-chat")) || undefined} onClick={() => { client.actions.newSession(); client.closeSheet() }}>
          <Icon path={ICONS.plus} />
        </button>
      }
    >
      <input
        class="sheet-search"
        type="search"
        placeholder="Search chats"
        aria-label="Search chats"
        value={filter()}
        onInput={(event) => setFilter(event.currentTarget.value)}
        data-autofocus={searchFirst ? true : undefined}
      />
      <div role="listbox" aria-label="Chats" tabIndex={-1} data-autofocus={searchFirst ? undefined : true}>
        <SessionList
          sessions={client.state().sessions}
          errors={client.state().sessionErrors}
          selected={client.state().sessionId}
          grouped
          filter={filter()}
          actions={actions}
        />
      </div>
    </Sheet>
  )
}
