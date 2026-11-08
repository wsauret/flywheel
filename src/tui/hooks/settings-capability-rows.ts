import { formatModuleNumberList, parseModuleNumberList } from "../../protocol/client/module-number-list.js"
import type { Accessor } from "solid-js"
import type { RuntimeAuthView } from "../../protocol/auth-status-protocol-types.js"
import { MODULE_SETTING_GROUPS, type BinaryModule, type ModuleConfigBooleanSettingId, type ModuleConfigNumberListControl, type ModuleConfigSettingControl, type ModuleProtocolRow, type ModuleSettingGroup, type RuntimeModulesView, type WorkflowsMode } from "../../protocol/module-protocol-types.js"
import { providerModuleValue } from "../auth-status-presentation.js"
import { CAPABILITY_PRESET_LABELS, capabilityPreset, moduleUnavailableReason, stepWorkflowsMode, WORKFLOWS_MODE_LABELS } from "../../protocol/client/capabilities.js"
import { settingsGroupDescription } from "../components/modal-copy.js"
import { settingCatalogRow, shownOn } from "../../protocol/setting-catalog.js"
import { cycleRowActions, type SettingsEditResult, type SettingsRow } from "./settings-modal-types.js"

type BooleanControl = ModuleConfigBooleanSettingId | Extract<ModuleConfigSettingControl, { readonly section: string; readonly control: "config-boolean" }>

type RuntimePolicyResult = { ok: true } | { ok: false; error: { message: string } }

/** What the module rows read and write: the runtime's published capability
 *  projection and its mutations, the auth view a provider row reads its
 *  status from, and the config store a module's boolean rows live in. */
export interface CapabilityRowDeps {
  readonly capabilities: {
    view: Accessor<RuntimeModulesView | undefined>
    setModule: (moduleId: BinaryModule, expected: boolean, enabled: boolean) => Promise<RuntimePolicyResult>
    setModules: (preset: "minimal" | "full", expected: { readonly moduleIds: readonly BinaryModule[]; readonly requireWorkflowConfirmation: boolean; readonly descriptorIdentity: string }) => Promise<RuntimePolicyResult>
    setWorkflowMode: (expected: WorkflowsMode, mode: WorkflowsMode) => Promise<RuntimePolicyResult>
  }
  readonly auth: Accessor<RuntimeAuthView | undefined>
  readonly config: {
    numberList: (setting: ModuleConfigNumberListControl) => readonly number[] | undefined
    updateNumberList: (setting: ModuleConfigNumberListControl, value: readonly number[]) => Promise<RuntimePolicyResult>
    boolean: (setting: BooleanControl) => boolean | undefined
    updateBoolean: (setting: BooleanControl, value: boolean) => Promise<RuntimePolicyResult>
  }
  readonly save: (input: { save: () => Promise<RuntimePolicyResult>; label: string; success: string }) => Promise<void>
  readonly confirm: (label: string, message: string, actionLabel: string, onConfirm: () => void) => void
  /** The kernel rows that sit at the head of one group, such as the web retrieval provider. */
  readonly groupHead: (group: ModuleSettingGroup) => readonly SettingsRow[]
}

function yesNo(value: boolean): string {
  return value ? "YES" : "NO"
}

/** One module's boolean configuration row. It follows the module's own row
 *  into its group and vanishes with the module, since the row is a
 *  contribution and not a kernel setting. */
function configRow(module: ModuleProtocolRow, control: ModuleConfigSettingControl, deps: CapabilityRowDeps): SettingsRow {
  if (control.control === "config-number-list") {
    const current = (): readonly number[] | undefined => deps.config.numberList(control)
    return {
      kind: "edit", id: `${module.id}:${control.section}:${control.key}`, label: control.label, description: control.description,
      value: () => formatModuleNumberList(current() ?? [], control),
      unavailableReason: () => current() === undefined ? "Configuration is still loading" : undefined,
      edit: {
        hint: `Increasing whole numbers from ${control.min} to ${control.max}, comma separated. Empty turns this off.`,
        current: () => current()?.join(", ") ?? "",
        initialDraft: () => current()?.join(", ") ?? "",
        submit: (text) => {
          const values = parseModuleNumberList(text, control)
          if (values === undefined) return { ok: false, error: `Use increasing whole numbers from ${control.min} to ${control.max}.` }
          if (values.join(",") === current()?.join(",")) return { ok: true }
          return deps.config.updateNumberList(control, values).then((result): SettingsEditResult => result.ok ? { ok: true } : { ok: false, error: result.error.message })
        },
      },
    }
  }
  const setting = "section" in control ? control : control.setting
  const id = "section" in control ? `${control.section}:${control.key}` : control.setting
  return {
    kind: "cycle", id: `${module.id}:${id}`, label: control.label, description: control.description,
    value: () => { const current = deps.config.boolean(setting); return current === undefined ? "" : yesNo(current) },
    unavailableReason: () => deps.config.boolean(setting) === undefined ? "Configuration is still loading" : undefined,
    // oxlint-disable-next-line solid/reactivity -- boundary: callback becomes a keyboard event handler.
    ...cycleRowActions(() => {
      const current = deps.config.boolean(setting)
      if (current === undefined) return
      void deps.save({ save: () => deps.config.updateBoolean(setting, !current), label: control.label, success: `${control.label} ${current ? "disabled" : "enabled"}` })
    }),
  }
}

/** The capability rows of the Autonomy section, each family in its own
 *  place: the preset, the workflow mode, the switches of the modules in no
 *  group, and one group row per module group with its modules' rows. */
export interface CapabilityRows {
  readonly preset: SettingsRow | undefined
  readonly workflowMode: SettingsRow | undefined
  readonly ungrouped: readonly SettingsRow[]
  readonly groups: readonly SettingsRow[]
}

export function capabilityRows(deps: CapabilityRowDeps): CapabilityRows {
  const view = deps.capabilities.view()
  if (!view) return { preset: undefined, workflowMode: undefined, ungrouped: [], groups: [] }
  // The runtime keeps the last valid selection in force, so a row shows
  // its value even while the stated selection is invalid. Only a complete
  // replacement, such as a preset, repairs that selection, so the member
  // toggles stay locked until then.
  const lockedReason = (module: ModuleProtocolRow) => (): string | undefined => view.error ?? moduleUnavailableReason(view, module)
  const workflowModule = view.modules.find((module) => module.setting?.control === "workflow-mode")
  const workflowRow = settingCatalogRow("workflow-mode")
  const workflowMode: SettingsRow | undefined = workflowModule === undefined ? undefined : {
    kind: "cycle", id: workflowRow.id, label: workflowRow.label, description: workflowRow.description,
    value: () => WORKFLOWS_MODE_LABELS[view.workflowsMode],
    lockedReason: lockedReason(workflowModule),
    // oxlint-disable-next-line solid/reactivity -- boundary: callback becomes a keyboard event handler.
    ...cycleRowActions((direction) => {
      const next = stepWorkflowsMode(view.workflowsMode, direction)
      void deps.save({ save: () => deps.capabilities.setWorkflowMode(view.workflowsMode, next), label: workflowRow.label, success: `${workflowRow.label} set to ${WORKFLOWS_MODE_LABELS[next]}` })
    }),
  }
  type GroupedRow = { readonly row: SettingsRow; readonly group: ModuleSettingGroup | undefined }
  const rows = view.modules.flatMap((module): readonly GroupedRow[] => {
    const setting = module.setting
    if (setting?.control !== "binary") return []
    const own: SettingsRow = {
      kind: "cycle", id: module.id, label: setting.label, description: setting.description,
      value: () => {
        const enabled = view.moduleIds.includes(module.id)
        if (setting.group === undefined) return yesNo(enabled)
        if (!enabled) return "Off"
        if (setting.providerId === undefined) return "On"
        return providerModuleValue(deps.auth()?.providers.find((status) => status.providerId === setting.providerId))
      },
      lockedReason: lockedReason(module),
      // oxlint-disable-next-line solid/reactivity -- boundary: callback becomes a keyboard event handler.
      ...cycleRowActions(() => {
        const enabled = !view.moduleIds.includes(module.id)
        void deps.save({
          save: () => deps.capabilities.setModule(module.id, !enabled, enabled),
          label: setting.label,
          success: `${setting.label} ${enabled ? "enabled" : "disabled"}`,
        })
      }),
    }
    // A module's configuration rows show only while it is on; off, it offers nothing to configure.
    const config = module.effective ? (module.configSettings ?? []).filter((control) => shownOn(control, "terminal")).map((control) => configRow(module, control, deps)) : []
    return [own, ...config].map((row) => ({ row, group: setting.group }))
  })
  const groups = MODULE_SETTING_GROUPS.filter((group) => rows.some((entry) => entry.group === group)).map((group): SettingsRow => {
    const groupRows = [...deps.groupHead(group), ...rows.flatMap((entry) => entry.group === group ? [entry.row] : [])]
    return { kind: "disclosure", id: `capability-group:${group}`, label: group, description: settingsGroupDescription(group), rows: () => groupRows }
  })
  const presetRow = settingCatalogRow("capability-preset")
  const preset: SettingsRow = {
    kind: "single-select", id: presetRow.id, label: presetRow.label,
    description: presetRow.description,
    value: () => CAPABILITY_PRESET_LABELS[capabilityPreset(view)],
    filterable: false,
    options: () => [
      { kind: "choice", id: "full", label: CAPABILITY_PRESET_LABELS.full },
      { kind: "choice", id: "minimal", label: CAPABILITY_PRESET_LABELS.minimal },
    ],
    currentId: () => {
      const current = capabilityPreset(view)
      return current === "custom" ? undefined : current
    },
    onSelect: (next) => {
      if (next !== "full" && next !== "minimal") return
      const expected = { moduleIds: view.moduleIds, requireWorkflowConfirmation: view.requireWorkflowConfirmation, descriptorIdentity: view.descriptorIdentity }
      const save = () => { void deps.save({ save: () => deps.capabilities.setModules(next, expected), label: presetRow.label, success: `Capabilities set to ${CAPABILITY_PRESET_LABELS[next]}` }) }
      if (next === "minimal" && expected.moduleIds.length > 0) {
        deps.confirm("Minimal preset", "Disable all modules, including all model providers? Stored credentials are kept.", "Disable all modules", save)
      } else save()
    },
  }
  return { preset, workflowMode, ungrouped: rows.flatMap((entry) => entry.group === undefined ? [entry.row] : []), groups }
}
