import type { ModuleProtocolRow, ModulePreset, RuntimeModulesView, WorkflowsMode } from "../module-protocol-types.js"

/** How every client reads and names the runtime's capability view, so the
 *  terminal and the web client show one vocabulary for one selection. */

/** Which preset the selection matches. Custom is a reading, never a choice:
 *  the runtime stores no preset name, only the selection a preset wrote. */
export type CapabilityPresetReading = ModulePreset | "custom"

export const CAPABILITY_PRESET_LABELS = { minimal: "Minimal", full: "Full", custom: "Custom" } as const satisfies { readonly [Reading in CapabilityPresetReading]: string }

/** What the Capabilities entry changes. The module selection lives in the
 *  account's one config file, so a change applies to every
 *  project, and the entry says so wherever a client offers it. */
export const CAPABILITIES_DETAIL = "Which tool modules Flywheel can use, in every project"

/** Minimal is no modules at all. Full is every installed module on, with
 *  workflows asking first and no module error. */
export function capabilityPreset(view: Pick<RuntimeModulesView, "moduleIds" | "error" | "workflowsMode" | "modules">): CapabilityPresetReading {
  if (view.moduleIds.length === 0) return "minimal"
  if (view.error === undefined && view.workflowsMode === "ask" && view.modules.every((module) => !module.installed || module.effective)) return "full"
  return "custom"
}

/** The Workflows modes in the order every client lists and steps them. */
export const WORKFLOWS_MODES: readonly WorkflowsMode[] = ["on", "ask", "off"]

export const WORKFLOWS_MODE_LABELS = { off: "Off", ask: "Ask first", on: "On" } as const satisfies { readonly [Mode in WorkflowsMode]: string }

/** The mode one step from `mode` in `WORKFLOWS_MODES`, wrapping at either end. */
export function stepWorkflowsMode(mode: WorkflowsMode, direction: -1 | 1): WorkflowsMode {
  const count = WORKFLOWS_MODES.length
  return WORKFLOWS_MODES[((WORKFLOWS_MODES.indexOf(mode) + direction) % count + count) % count] ?? "off"
}

/** The modules a person can turn on or off here: installed, with a control. */
export function switchableModules(view: Pick<RuntimeModulesView, "modules">): readonly ModuleProtocolRow[] {
  return view.modules.filter((module) => module.installed && module.setting !== undefined)
}

/** Why `module` cannot be turned on now, or undefined when it can. A
 *  selection-wide error is not a reason of one module: a client shows it once
 *  for the whole view. */
export function moduleUnavailableReason(view: Pick<RuntimeModulesView, "moduleIds" | "modules">, module: ModuleProtocolRow): string | undefined {
  if (!module.installed) return "Unavailable in this build"
  const missing = module.dependencies.filter((dependency) => !view.moduleIds.includes(dependency))
  if (missing.length > 0) {
    const labels = missing.map((dependency) => view.modules.find((candidate) => candidate.id === dependency)?.setting?.label ?? dependency)
    return `Enable ${labels.join(", ")} first`
  }
  return module.dependencyError
}

/** Whether the selection has every model provider turned off. Then no
 *  provider can be connected, and the way back is the Capabilities control. */
export function everyProviderOff(view: Pick<RuntimeModulesView, "modules">): boolean {
  return !view.modules.some((module) => module.effective && module.setting?.group === "Model providers")
}
