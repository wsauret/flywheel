import { createMemo, createSignal, Show } from "solid-js"
import { Key } from "@solid-primitives/keyed"

import type { BuiltInCommandDescriptor } from "../../../../src/protocol/command-catalog-protocol-types.js"
import { usesPerCommand } from "../../../../src/protocol/client/command-menu.js"
import { COMMAND_MENU_SECTIONS } from "../../client/command-choices.js"
import { useClient } from "../client-context.js"
import { offeredCommandGroups } from "../surfaces.js"
import { Sheet, SheetRow } from "./sheet.js"
import { KERNEL_COMMAND_NAMES } from "../../../../src/protocol/command-names.js"

/** Commands: the whole command menu, readable. The `/` panel keeps the
 *  catalog behind its filter and shows descriptions only on hover, which a
 *  phone never has; this sheet is where a person learns what a command does
 *  before typing it. Built-in commands come in command-menu order. Picking a
 *  row puts the command in the composer. */

function usesLabel(count: number | undefined): string | undefined {
  if (count === undefined) return undefined
  return count === 1 ? "1 use" : `${count} uses`
}

/** One row: a command under its own token, with the aliases that also reach it. */
function detailOf(command: BuiltInCommandDescriptor): string {
  const also = command.aliases.length === 0 ? undefined : `Also ${command.aliases.map((alias) => `/${alias}`).join(", ")}`
  return [command.title === command.id ? undefined : command.title, command.description, also].filter((part): part is string => part !== undefined && part.length > 0).join(". ")
}

export function CommandsSheet() {
  const client = useClient()
  const [filter, setFilter] = createSignal("")
  const uses = createMemo(() => usesPerCommand(client.state().commandUsage.map((use) => [use.name, use.count] as const), client.state().builtInCommands))
  const matches = (command: BuiltInCommandDescriptor) => {
    const query = filter().trim().toLowerCase()
    return query === "" || [command.id, command.title, command.description, ...command.aliases].some((text) => text.toLowerCase().includes(query))
  }
  const groups = createMemo(() => {
    const catalog = offeredCommandGroups(client)
    return [
      { kind: "top", title: COMMAND_MENU_SECTIONS.top, commands: catalog.top },
      { kind: "chat", title: COMMAND_MENU_SECTIONS.chat, commands: catalog.chat },
      { kind: "rest", title: COMMAND_MENU_SECTIONS.rest, commands: [...catalog.more, ...catalog.rest] },
    ].map((group) => ({ ...group, commands: group.commands.filter(matches) })).filter((group) => group.commands.length > 0)
  })
  const pick = (command: BuiltInCommandDescriptor) => {
    client.closeSheet()
    client.insertText(`/${command.id} `)
  }
  return (
    <Sheet title={KERNEL_COMMAND_NAMES.help} onClose={client.closeSheet}>
      <input
        class="sheet-search"
        type="search"
        placeholder="Search commands"
        aria-label="Search commands"
        value={filter()}
        onInput={(event) => setFilter(event.currentTarget.value)}
      />
      {/* Focus opens on the list, as the Sessions sheet does: a focused field
          raises the phone keyboard over the list the sheet exists to show. */}
      <div role="list" aria-label="Commands" tabIndex={-1} data-autofocus>
        <Key each={groups()} by="kind">
          {(group) => (
            <>
              <div class="sheet-section">{group().title}</div>
              <Key each={group().commands} by="id">
                {(command) => (
                  <SheetRow label={`/${command().id}`} detail={detailOf(command())} value={usesLabel(uses().get(command().id))} onClick={() => pick(command())} />
                )}
              </Key>
            </>
          )}
        </Key>
        <Show when={groups().length === 0}>
          <SheetRow label="No command matches" detail="Try a shorter word." />
        </Show>
      </div>
    </Sheet>
  )
}
