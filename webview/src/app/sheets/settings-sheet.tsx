import { For, Show } from "solid-js"

import { renderSettingEntries, SETTING_SECTIONS } from "../../../../src/protocol/setting-catalog.js"
import { useClient } from "../client-context.js"
import { browserSettingRenderers, createSettingRowState } from "./setting-rows.js"
import { Sheet, SheetLoading } from "./sheet.js"
import { KERNEL_COMMAND_NAMES } from "../../../../src/protocol/command-names.js"

/** Every setting, in the setting catalog's sections, edited in place.
 *
 *  The command panel is a launcher with a short curated head; this sheet is
 *  the complete list, and both read the same snapshot. The catalog names and
 *  orders every row (ARCH-PROTOCOL-066); a row that describes the terminal
 *  itself, such as its theme or font, has no row here. */
export function SettingsSheet() {
  const client = useClient()
  const settings = () => client.state().settings
  const state = createSettingRowState(client)

  return (
    <Sheet title={KERNEL_COMMAND_NAMES.settings} onClose={client.closeSheet}>
      <Show when={settings()} fallback={<SheetLoading />}>
        {(current) => {
          const renderers = browserSettingRenderers(client, state, current)
          return (
            <>
              <Show when={current().configStatus}>{(status) => <div class="sheet-problem">{status()}</div>}</Show>
              <For each={SETTING_SECTIONS}>
                {(section) => (
                  <>
                    <div class="sheet-section">{section.title}</div>
                    {renderSettingEntries("browser", section.entries, renderers)}
                  </>
                )}
              </For>
            </>
          )
        }}
      </Show>
    </Sheet>
  )
}
