import { Schema } from "effect"
import { MODULE_IDS, type ModuleId } from "./module-ids.js"
import type { RuntimePosition } from "./runtime-ui-protocol-types.js"
import type { SettingHost } from "./setting-catalog.js"

/** How the workflows capability answers a launch: refused, gated behind a
 *  confirmation, or immediate. Derived from the selection, never stored, so
 *  the model surface, the launch boundary, and the Settings row agree. */
export type WorkflowsMode = "off" | "ask" | "on"

/** The Settings control a module declares beside its registration. The
 *  registry's settings contribution states this exact shape, so the row a
 *  client renders is the declaration itself rather than a projection that
 *  could drift from it. */
/** The Settings groups a module row can sit under. Ungrouped rows are the
 *  agent capabilities every client lists first. */
export type ModuleSettingGroup = "Tools" | "Web retrieval" | "Model providers" | "Model & spend" | "Interface" | "Remote"
export const MODULE_SETTING_GROUPS: readonly ModuleSettingGroup[] = ["Tools", "Web retrieval", "Model providers", "Model & spend", "Interface", "Remote"]

export type ModuleSettingControl =
  | { readonly control: "binary"; readonly label: string; readonly description: string; readonly group?: ModuleSettingGroup }
  | { readonly control: "workflow-mode"; readonly label: string; readonly description: string; readonly group?: undefined }
  | ModuleNumberSettingControl
  | ModuleConfigSettingControl

/** A numeric, profile-scoped setting a provider module declares. It is stored
 *  under the provider's table in each auth profile, so the TOML key is
 *  `profiles.<profile>.providers.<providerId>.<key>`. `off` is the value
 *  that means the setting is not in force; clients render it as such. */
interface ModuleNumberSettingControl {
  readonly control: "number"
  readonly key: string
  readonly label: string
  readonly description: string
  readonly min: number
  readonly max: number
  readonly off: number
  readonly defaultValue: number
  readonly group?: "Model providers"
}

/** A boolean configuration setting a module owns the row for. The value lives
 *  under the named key of the runtime config view, so the row reads and
 *  writes it through the ordinary config mutation and vanishes with the module. */
interface KernelConfigBooleanControl extends HostRestriction {
  readonly control: "config-boolean"
  readonly setting: ModuleConfigBooleanSettingId
  readonly label: string
  readonly description: string
  readonly group?: ModuleSettingGroup
}

/** A configuration row that describes one client host itself, such as the
 *  browser's own notifications. Every client honors it as it honors the
 *  `host` of a setting catalog row (ARCH-PROTOCOL-066). */
interface HostRestriction {
  /** The only host that shows this row. Absent means every host. */
  readonly host?: SettingHost
}

export interface ModuleConfigSectionBooleanControl extends HostRestriction {
  readonly control: "config-boolean"
  readonly section: string
  readonly key: string
  readonly defaultValue: boolean
  readonly label: string
  readonly description: string
  readonly group?: ModuleSettingGroup
}
export type ModuleConfigBooleanControl = KernelConfigBooleanControl | ModuleConfigSectionBooleanControl

/** The boolean workspace settings a module may claim a row for. */
export type ModuleConfigBooleanSettingId = "notificationsDesktop"

/** A workspace list of increasing integers, validated against its module declaration. */
export interface ModuleConfigNumberListControl extends HostRestriction {
  readonly control: "config-number-list"
  readonly section: string
  readonly key: string
  readonly defaultValue: readonly number[]
  readonly suffix?: string
  readonly label: string
  readonly description: string
  readonly min: number
  readonly max: number
  readonly group?: ModuleSettingGroup
}
export type ModuleConfigSettingControl = ModuleConfigBooleanControl | ModuleConfigNumberListControl

export type ModuleSetting = Exclude<ModuleSettingControl, ModuleNumberSettingControl | ModuleConfigSettingControl> & { readonly providerId?: string }

/** A declared numeric setting bound to the provider it scopes. */
export type ModuleProviderSetting = ModuleNumberSettingControl & { readonly providerId: string }

export interface ModuleProtocolRow {
  readonly id: ModuleId
  readonly installed: boolean
  readonly effective: boolean
  readonly dependencies: readonly ModuleId[]
  readonly dependencyError?: string
  readonly setting?: ModuleSetting
  /** The module's provider-scoped numeric settings; their values live in the
   *  config view under each profile's `providers`. */
  readonly providerSettings?: readonly ModuleProviderSetting[]
  /** The module's boolean configuration rows; their values live in the config view. */
  readonly configSettings?: readonly ModuleConfigSettingControl[]
}

/** The workspace capability domain: one runtime-wide view of the optional
 *  capabilities this account selected (ARCH-PROTOCOL-036). It is the client's sole source
 *  for the Settings rows and for every capability-sensitive surface, so no
 *  selection is ever copied into startup props or a client store.
 *
 *  Delivery is latest-collapsible: one patch carries the complete view, so the
 *  newest supersedes anything it overtook and a client that missed one needs no
 *  resnapshot. `workflowsMode` is derived here rather than stored, so the model
 *  surface, the launch boundary, and the Settings row cannot disagree. An
 *  absent `error` is the cleared state; an unreadable selection keeps the last
 *  valid live set and publishes the reason it did not apply the new bytes. */
export interface RuntimeModulesView {
  readonly capabilities: readonly ModuleId[]
  readonly moduleIds: readonly ModuleId[]
  /** Closed identity of the decoded descriptor for semantic compare-and-swap. */
  readonly descriptorIdentity: string
  readonly modules: readonly ModuleProtocolRow[]
  readonly warnings: readonly string[]
  readonly requireWorkflowConfirmation: boolean
  readonly workflowsMode: WorkflowsMode
  readonly persistentProcesses: {
    readonly persisted: boolean
    readonly effective: boolean
    readonly forcedByCli: boolean
  }
  readonly error?: string
}

export interface RuntimeModuleSnapshotResult {
  readonly snapshotPosition: RuntimePosition
  readonly capabilities: RuntimeModulesView
}

export type ModulePatchPayload = { readonly kind: "modules.changed"; readonly capabilities: RuntimeModulesView }

/** The two named selections a client may ask for. No preset name is stored:
 *  the runtime writes the complete set the preset means and the client derives
 *  Minimal, Full, or Custom from the published selection. */
export const ModulePresetSchema = Schema.Literals(["minimal", "full"])
export type ModulePreset = typeof ModulePresetSchema.Type

/** A catalog module id carried at the protocol boundary after external normalization. */
export const BinaryModuleIdSchema = Schema.Literals(MODULE_IDS)
export type BinaryModule = typeof BinaryModuleIdSchema.Type

export function capabilitiesCursor() {
  return { scope: "workspace", domain: "modules" } as const
}
