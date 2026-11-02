import { For } from "solid-js"

import { useClient } from "../client-context.js"
import { modKeyLabel, SHORTCUTS } from "../shortcuts.js"
import { Sheet } from "./sheet.js"
import { KERNEL_COMMAND_NAMES } from "../../../../src/protocol/command-names.js"

/** Every key the client answers, from the one table the shell acts on. */
export function ShortcutsSheet() {
  const client = useClient()
  const mod = modKeyLabel(navigator.platform)
  return (
    <Sheet title={KERNEL_COMMAND_NAMES.shortcuts} onClose={client.closeSheet}>
      <div class="shortcut-list" role="list">
        <For each={SHORTCUTS}>
          {(shortcut) => (
            <div class="sheet-row shortcut-row" role="listitem">
              <span class="sheet-row-main"><span class="sheet-row-label">{shortcut.label}</span></span>
              <span class="shortcut-keys">
                <For each={shortcut.keys}>{(key) => <kbd>{key === "Mod" ? mod : key}</kbd>}</For>
              </span>
            </div>
          )}
        </For>
      </div>
    </Sheet>
  )
}
