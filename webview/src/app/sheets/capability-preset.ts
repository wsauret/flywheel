import { actionKey } from "../../client/action-key.js"
import { describeFailure } from "../../client/failure-message.js"
import { settingRowKey, type SettingKeys, type SettingOutcome } from "../../client/settings-actions.js"
import type { ClientContextValue } from "../client-context.js"
import type { WorkflowsMode } from "../../../../src/protocol/module-protocol-types.js"
import { CAPABILITY_PRESET_LABELS, WORKFLOWS_MODE_LABELS, WORKFLOWS_MODES, type CapabilityPresetReading } from "../../../../src/protocol/client/capabilities.js"
import type { SegmentOption } from "./controls.js"

/** The keys a preset change runs under, as a setting change does: the preset
 *  row, which reads working while any preset is written, and the preset this
 *  change writes. A different preset runs after the running one. */
export function presetKeys(preset: string): SettingKeys {
  return { row: settingRowKey("preset"), write: actionKey("setting", "preset", preset) }
}

/** Captures the module selection before asking to disable it. Cancellation writes
 * nothing; a stale selection is reported without retrying against newer state. */
export async function applyCapabilityPreset(client: Pick<ClientContextValue, "connection" | "confirm" | "report">, preset: "minimal" | "full"): Promise<SettingOutcome | undefined> {
  let outcome: SettingOutcome
  try {
    const { capabilities: current } = await client.connection.query({ type: "moduleSnapshot" })
    const expected = { moduleIds: current.moduleIds, requireWorkflowConfirmation: current.requireWorkflowConfirmation, descriptorIdentity: current.descriptorIdentity }
    if (preset === "minimal" && expected.moduleIds.length > 0 && !await client.confirm({
      title: "Use the Minimal preset?",
      detail: "All modules, including all model providers, will be disabled. Stored credentials are kept.",
      confirmLabel: "Disable all modules",
      destructive: true,
      cancelByDefault: true,
    })) return undefined
    const result = await client.connection.dispatch({ type: "settings.set_modules", preset, expected })
    outcome = result.ok ? { kind: "applied" } : { kind: "notice", severity: "warning", message: result.error }
  } catch (cause) {
    outcome = { kind: "notice", severity: "warning", message: `Flywheel did not change that capability: ${describeFailure(cause)}` }
  }
  if (outcome.kind === "notice") client.report(outcome.severity, outcome.message)
  return outcome
}

/** The preset segment's options: the two presets a person can choose, and
 *  Custom only while the selection matches neither, as a reading. */
export function presetOptions(current: CapabilityPresetReading): readonly SegmentOption<CapabilityPresetReading>[] {
  const named = PRESETS.map((value) => ({ value, label: CAPABILITY_PRESET_LABELS[value] }))
  return current === "custom" ? [...named, { value: "custom", label: CAPABILITY_PRESET_LABELS.custom }] : named
}

const PRESETS = ["minimal", "full"] as const

/** The Workflows segment's options, in the order every client lists them. */
export const WORKFLOWS_MODE_OPTIONS: readonly SegmentOption<WorkflowsMode>[] = WORKFLOWS_MODES.map((value) => ({ value, label: WORKFLOWS_MODE_LABELS[value] }))
