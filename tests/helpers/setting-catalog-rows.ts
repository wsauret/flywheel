import { MODULE_SETTING_GROUPS } from "../../src/protocol/module-protocol-types.js"
import { SETTING_SECTIONS, settingGroupHead, type SettingCatalogEntry, type SettingCatalogRow } from "../../src/protocol/setting-catalog.js"

/** Every row of the setting catalog in the order that a client lays it out:
 *  subsection rows in place, and the head rows of each module group, in group
 *  order, at the capability-groups slot. */
export function settingCatalogRows(): readonly SettingCatalogRow[] {
  return SETTING_SECTIONS.flatMap((section) => section.entries.flatMap(function rowsOf(entry: SettingCatalogEntry): readonly SettingCatalogRow[] {
    if (entry.kind === "row") return [entry]
    if (entry.kind === "subsection") return entry.entries.flatMap(rowsOf)
    return entry.id === "capability-groups" ? MODULE_SETTING_GROUPS.flatMap(settingGroupHead) : []
  }))
}

/** The catalog rows that change one value in place. */
export function inPlaceSettingCatalogRows(): readonly SettingCatalogRow[] {
  return settingCatalogRows().filter((row) => row.control === "switch" || row.control === "choice" || row.control === "number")
}
