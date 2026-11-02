import { Key } from "@solid-primitives/keyed"
import { createMemo, Show } from "solid-js"

import { MODULE_SETTING_GROUPS, type ModuleProtocolRow, type ModuleSettingGroup } from "../../../../src/protocol/module-protocol-types.js"
import { useClient } from "../client-context.js"
import { createSettingRowState, ModuleSwitchRow, SettingCatalogRowView } from "./setting-rows.js"
import { Sheet, SheetLoading } from "./sheet.js"

/** Which tool modules Flywheel may use in every project, as the TUI's Autonomy section
 *  shows them: the runtime's own labels and descriptions, grouped under Tools,
 *  Web retrieval, and Model providers, with the reason a module cannot be
 *  turned on and the connection state behind a provider module.
 *
 *  The sheet reads the capability view the session keeps current from the
 *  runtime's module patches, so a change from any client repaints it in
 *  place: no read of its own to go stale, and no reload that loses the
 *  scroll position. Every write goes through the settings actions, which
 *  report a refusal in the runtime's words. */
export function CapabilitiesSheet() {
  const client = useClient()
  const settings = () => client.state().settings
  const state = createSettingRowState(client)

  interface GroupRows { readonly title: ModuleSettingGroup; readonly rows: readonly ModuleProtocolRow[] }
  interface Sections { readonly flat: readonly ModuleProtocolRow[]; readonly groups: readonly GroupRows[] }
  /** Modules with a switch, split into the ungrouped agent capabilities and the named groups. */
  const sections = createMemo((): Sections => {
    const current = settings()?.capabilities
    if (!current) return { flat: [], groups: [] }
    const withSetting = current.modules.filter((module) => module.setting !== undefined && module.setting.control === "binary")
    const flat = withSetting.filter((module) => module.setting?.group === undefined)
    const groups = MODULE_SETTING_GROUPS
      .map((title) => ({ title, rows: withSetting.filter((module) => module.setting?.group === title) }))
      .filter((group) => group.rows.length > 0)
    return { flat, groups }
  })

  return (
    <Sheet title="Capabilities" onClose={client.closeSheet}>
      <Show when={settings()} fallback={<SheetLoading />}>
        {(current) => {
          const view = () => current().capabilities
          return (
            <>
              <Show when={view().error}>{(problem) => <div class="sheet-problem">{problem()}</div>}</Show>
              <SettingCatalogRowView client={client} state={state} current={current} id="capability-preset" />
              <SettingCatalogRowView client={client} state={state} current={current} id="workflow-mode" />

              <div class="sheet-section">Agent capabilities</div>
              <Key each={sections().flat} by={(module) => module.id}>{(module) => <ModuleSwitchRow client={client} view={view()} module={module()} />}</Key>
              <Key each={sections().groups} by={(group) => group.title}>
                {(group) => (
                  <>
                    <div class="sheet-section">{group().title}</div>
                    <Key each={group().rows} by={(module) => module.id}>{(module) => <ModuleSwitchRow client={client} view={view()} module={module()} />}</Key>
                  </>
                )}
              </Key>
            </>
          )
        }}
      </Show>
    </Sheet>
  )
}
