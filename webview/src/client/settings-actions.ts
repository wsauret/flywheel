import type { RuntimeConnection } from "../../../src/protocol/client/connection.js"
import type { RuntimeConfigMutation, RuntimeConfigMutationResult } from "../../../src/protocol/runtime-config-protocol-types.js"
import type { PanelModuleSetting, PanelProviderSetting, PanelSettings } from "./session-settings.js"
import type { WriteSyntaxThemeId } from "../../../src/protocol/write-syntax-theme.js"
import type { UpdateAutoInstall } from "../../../src/protocol/update-protocol-types.js"
import type { BinaryModule } from "../../../src/protocol/module-protocol-types.js"
import { stepWorkflowsMode } from "../../../src/protocol/client/capabilities.js"
import { autoInstallOverride, autoInstallSaved, persistentProcessesOverride, persistentProcessesSaved } from "../../../src/protocol/client/runtime-policy-copy.js"
import { actionKey } from "./action-key.js"

/** The settings the client changes in place, without a picker.
 *
 *  These are runtime settings, not client settings: they live in the project's
 *  Flywheel config and apply to every client that opens it, so every one of
 *  them is a runtime mutation and none of them touches host storage. A row that
 *  needs a list to choose from, such as the model or the capability set, is a
 *  host picker until the client carries its own. */

type WorkspaceConfigSetting = Extract<RuntimeConfigMutation, { readonly target?: { readonly kind: "workspace" } }>["setting"]

export type InlineSettingAction =
  | { readonly kind: "toggle-persistent-processes" }
  | { readonly kind: "toggle-auto-install" }
  | { readonly kind: "cycle-workflow-mode"; readonly direction: -1 | 1 }
  | { readonly kind: "cycle-web-search" }
  | { readonly kind: "cycle-profile"; readonly direction: -1 | 1 }
  | { readonly kind: "set-effort"; readonly effort: string }
  | { readonly kind: "set-compaction-threshold"; readonly tokens: number }
  | { readonly kind: "set-auto-delete-session-days"; readonly days: number }
  | { readonly kind: "set-idle-compaction"; readonly on: boolean }
  | { readonly kind: "set-shell-write-guard"; readonly on: boolean }
  | { readonly kind: "set-show-thinking"; readonly on: boolean }
  | { readonly kind: "set-show-build"; readonly on: boolean }
  | { readonly kind: "set-write-syntax-theme"; readonly theme: WriteSyntaxThemeId }
  | { readonly kind: "set-diff-colors"; readonly mode: "theme" | "standard" }
  | { readonly kind: "set-web-search"; readonly provider: "chatgpt" | "exa" }
  | { readonly kind: "set-provider-setting"; readonly profileId: string; readonly setting: PanelProviderSetting; readonly value: number }
  | { readonly kind: "set-module-number-list"; readonly setting: Extract<PanelModuleSetting, { readonly control: "config-number-list" }>; readonly value: readonly number[] }
  | { readonly kind: "set-module-setting"; readonly setting: Extract<PanelModuleSetting, { readonly control: "config-boolean" }>; readonly on: boolean }
  | { readonly kind: "set-git-ai-attribution"; readonly on: boolean }
  | { readonly kind: "set-allow-training-routes"; readonly on: boolean }
  /** Binds this project to the profile `profileId`, or removes its binding when undefined. */
  | { readonly kind: "set-project-profile"; readonly profileId: string | undefined }
  | { readonly kind: "set-workflow-mode"; readonly mode: "off" | "ask" | "on" }
  | { readonly kind: "set-module"; readonly moduleId: BinaryModule; readonly on: boolean }
  | { readonly kind: "reset-defaults" }

/** One setting a person can change, named as the settings sheet names its
 *  rows. A row reads its working state and its refusal by this id, never by
 *  a write it would make. The capability preset is a row too, although its
 *  write is not an inline setting change. */
export type SettingId =
  | "persistent" | "updates" | "workflow-mode" | "web-search" | "profile" | "effort" | "compaction" | "thinking"
  | "show-build" | "write-syntax-theme" | "diff-colors" | "git-attribution" | "training-routes" | "project-profile" | "reset" | "preset"
  | "idle-compaction"
  | "shell-write-guard"
  | "auto-delete-session-days"
  | `provider-setting:${string}:${string}` | `module-setting:${string}` | `module:${string}`

export function providerSettingId(setting: Pick<PanelProviderSetting, "providerId" | "key">): SettingId {
  return `provider-setting:${setting.providerId}:${setting.key}`
}

export function moduleSettingId(setting: PanelModuleSetting): SettingId {
  return `module-setting:${"section" in setting ? `${setting.section}.${setting.key}` : setting.setting}`
}

/** The key every control of the setting `id` reads working under, and that
 *  every write to the setting runs in order under. */
export function settingRowKey(id: SettingId): string {
  return actionKey("setting", id)
}

/** The one setting a change writes. A cycle and a direct set of the same
 *  setting share it. */
export function settingTarget(action: InlineSettingAction): SettingId {
  switch (action.kind) {
    case "toggle-persistent-processes": return "persistent"
    case "toggle-auto-install": return "updates"
    case "cycle-workflow-mode":
    case "set-workflow-mode": return "workflow-mode"
    case "cycle-web-search":
    case "set-web-search": return "web-search"
    case "cycle-profile": return "profile"
    case "set-effort": return "effort"
    case "set-compaction-threshold": return "compaction"
    case "set-auto-delete-session-days": return "auto-delete-session-days"
    case "set-idle-compaction": return "idle-compaction"
    case "set-shell-write-guard": return "shell-write-guard"
    case "set-show-thinking": return "thinking"
    case "set-show-build": return "show-build"
    case "set-write-syntax-theme": return "write-syntax-theme"
    case "set-diff-colors": return "diff-colors"
    case "set-provider-setting": return providerSettingId(action.setting)
    case "set-module-number-list":
    case "set-module-setting": return moduleSettingId(action.setting)
    case "set-git-ai-attribution": return "git-attribution"
    case "set-allow-training-routes": return "training-routes"
    case "set-project-profile": return "project-profile"
    case "set-module": return `module:${action.moduleId}`
    case "reset-defaults": return "reset"
  }
}

export interface SettingKeys { readonly row: string; readonly write: string }

/** The keys a setting change runs under in the actions layer.
 *
 *  `row` names the setting. Every control for the setting reads its working
 *  state there, and every write to the setting runs in order under it, so a
 *  write never states an expected value that an earlier write is still
 *  changing. `write` adds the value a direct set writes: the same value
 *  joins the running write, and another value runs after it, so the latest
 *  choice lands last. A toggle or a cycle has no value of its own, so a
 *  repeat joins it. */
export function settingKeys(action: InlineSettingAction): SettingKeys {
  const row = settingRowKey(settingTarget(action))
  const value = settingValue(action)
  if (action.kind === "set-provider-setting") return { row, write: actionKey("setting", settingTarget(action), action.profileId, value) }
  return { row, write: value === undefined ? row : actionKey("setting", settingTarget(action), value) }
}

/** The value a direct set writes, or undefined for a change that is relative
 *  to the current value. */
function settingValue(action: InlineSettingAction): string | undefined {
  switch (action.kind) {
    case "toggle-persistent-processes":
    case "toggle-auto-install":
    case "cycle-workflow-mode":
    case "cycle-web-search":
    case "cycle-profile":
    case "reset-defaults": return undefined
    case "set-effort": return action.effort
    case "set-compaction-threshold": return String(action.tokens)
    case "set-auto-delete-session-days": return String(action.days)
    case "set-idle-compaction":
    case "set-shell-write-guard":
    case "set-show-thinking":
    case "set-show-build":
    case "set-module-setting":
    case "set-module":
    case "set-git-ai-attribution":
    case "set-allow-training-routes": return String(action.on)
    case "set-project-profile": return action.profileId ?? ""
    case "set-write-syntax-theme": return action.theme
    case "set-diff-colors": return action.mode
    case "set-web-search": return action.provider
    case "set-provider-setting": return String(action.value)
    case "set-module-number-list": return action.value.join(",")
    case "set-workflow-mode": return action.mode
  }
}

/** What a setting change came to, in words a person can read. A setting that
 *  appears to have been set and was not is worse than one that failed, so a
 *  refusal is always reported. */
export type SettingOutcome =
  | { readonly kind: "applied" }
  | { readonly kind: "notice"; readonly severity: "info" | "warning"; readonly message: string }

/** Whether a compaction threshold is one the runtime accepts: off, or a whole
 *  number of tokens large enough to be worth a checkpoint and reset. */
export function validCompactionThreshold(tokens: number): boolean {
  return Number.isInteger(tokens) && (tokens === 0 || tokens >= 50_000)
}

/** A provider setting as typed: a whole number inside the declared bounds,
 *  or the declared off value. */
export function parseProviderSetting(text: string, setting: PanelProviderSetting): { readonly value: number } | { readonly problem: string } {
  const value = Number(text.replaceAll(",", "").trim())
  if (!Number.isInteger(value) || value < setting.min || value > setting.max) return { problem: `A whole number from ${setting.min.toLocaleString()} to ${setting.max.toLocaleString()}, or ${setting.off} to turn it off.` }
  return { value }
}

/** The workspace switch each direct set writes. */
const WORKSPACE_SWITCHES = { "set-idle-compaction": "idleCompaction", "set-shell-write-guard": "shellWriteGuard", "set-show-thinking": "showThinking" } as const

/** `autoInstall` is the live update view's policy, read beside the settings
 *  snapshot because it changes on its own patch stream, not on config reads. */
export async function applyInlineSetting(connection: RuntimeConnection, action: InlineSettingAction, current: PanelSettings, autoInstall: UpdateAutoInstall | undefined): Promise<SettingOutcome> {
  switch (action.kind) {
    case "toggle-persistent-processes": {
      // The switch writes the stored setting also while the command line
      // forces the policy on: the stored setting is what the next run reads.
      const state = current.persistentProcesses
      const enabled = !state.persisted
      const result = await connection.dispatch({ type: "settings.set_persistent_processes", expected: state.persisted, enabled })
      return policyOutcome(result, persistentProcessesOverride(state) === undefined ? undefined : persistentProcessesSaved(state, enabled))
    }
    case "toggle-auto-install": {
      const state = autoInstall
      if (state === undefined) return { kind: "notice", severity: "warning", message: "The update policy has not been read yet; try again in a moment." }
      // The toggle writes `persisted`; `effective` is what the runtime derives
      // from it, and writing back the derived value would fight the override.
      const enabled = !state.persisted
      const result = await connection.dispatch({ type: "settings.set_update_auto_install", expected: state.persisted, value: enabled })
      return policyOutcome(result, autoInstallOverride(state) === undefined ? undefined : autoInstallSaved(state, enabled))
    }
    case "set-module-setting": {
      const setting = moduleSettingInForce(current, action.setting)
      if (action.on === setting.value) return { kind: "applied" }
      if ("section" in setting) return writeSetting(connection, { id: "module", section: setting.section, key: setting.key, expected: { kind: "value", value: setting.value }, desired: action.on })
      return writeSetting(connection, { id: setting.setting, expected: { kind: "value", value: setting.value }, desired: action.on })
    }
    case "cycle-workflow-mode":
      return capabilityOutcome(await connection.dispatch({ type: "settings.set_workflow_mode", expected: current.workflowMode, mode: stepWorkflowsMode(current.workflowMode, action.direction) }))
    case "set-workflow-mode":
      if (action.mode === current.workflowMode) return { kind: "applied" }
      return capabilityOutcome(await connection.dispatch({ type: "settings.set_workflow_mode", expected: current.workflowMode, mode: action.mode }))
    case "set-module": {
      const enabled = current.capabilities.moduleIds.includes(action.moduleId)
      if (action.on === enabled) return { kind: "applied" }
      return capabilityOutcome(await connection.dispatch({ type: "settings.set_module", moduleId: action.moduleId, expected: enabled, enabled: action.on }))
    }
    case "cycle-profile": {
      // Re-read rather than trusting the snapshot: profiles can be created or
      // deleted from other clients, and the cycle order comes from the
      // runtime's own current list.
      const status = await connection.query({ type: "authStatusSnapshot", scope: { kind: "defaults" } })
      const profile = status.auth.profile
      if (profile.availableProfiles.length < 2) return { kind: "applied" }
      const index = profile.availableProfiles.findIndex((candidate) => candidate.id === profile.id)
      const count = profile.availableProfiles.length
      const next = profile.availableProfiles[(Math.max(0, index) + action.direction + count) % count]
      if (next === undefined) return { kind: "applied" }
      const result = await connection.dispatch({ type: "auth.profile.select", scope: { kind: "defaults" }, id: next.id })
      if ("ok" in result && !result.ok) return { kind: "notice", severity: "warning", message: result.error }
      const warning = "warning" in result ? result.warning : undefined
      return warning === undefined ? { kind: "applied" } : { kind: "notice", severity: "warning", message: warning }
    }
    case "cycle-web-search":
      return writeSetting(connection, {
        id: "webSearchProvider",
        expected: { kind: "value", value: current.webSearchProvider },
        desired: current.webSearchProvider === "chatgpt" ? "exa" : "chatgpt",
      })
    case "set-web-search":
      if (action.provider === current.webSearchProvider) return { kind: "applied" }
      return writeSetting(connection, { id: "webSearchProvider", expected: { kind: "value", value: current.webSearchProvider }, desired: action.provider })
    case "set-idle-compaction":
    case "set-shell-write-guard":
    case "set-show-thinking": {
      const id = WORKSPACE_SWITCHES[action.kind]
      if (action.on === current[id]) return { kind: "applied" }
      return writeSetting(connection, { id, expected: { kind: "value", value: current[id] }, desired: action.on })
    }
    case "set-show-build":
      if (action.on === current.showBuild) return { kind: "applied" }
      return writeProjectSetting(connection, { id: "showBuild", expected: { kind: "value", value: current.showBuild }, desired: action.on })
    case "set-write-syntax-theme":
      if (action.theme === current.writeSyntaxTheme) return { kind: "applied" }
      return writeSetting(connection, { id: "writeSyntaxTheme", expected: { kind: "value", value: current.writeSyntaxTheme }, desired: action.theme })
    case "set-diff-colors":
      if (action.mode === current.diffColors) return { kind: "applied" }
      return writeSetting(connection, { id: "diffColors", expected: { kind: "value", value: current.diffColors }, desired: action.mode })
    case "set-module-number-list": {
      const setting = moduleSettingInForce(current, action.setting)
      return writeSetting(connection, { id: "module", section: setting.section, key: setting.key, expected: { kind: "value", value: [...setting.value] }, desired: [...action.value] })
    }
    case "set-provider-setting": {
      // Disposal commits a draft even after a profile switch. The new profile's
      // reading cannot supply an expectation for the profile the field left.
      const id = providerSettingId(action.setting)
      const inForce = current.profileId === action.profileId ? current.providerSettings.find((candidate) => providerSettingId(candidate) === id) : undefined
      const value = (inForce ?? action.setting).value
      if (action.value === value) return { kind: "applied" }
      return writeProfileSetting(connection, action.profileId, { id: "provider", providerId: action.setting.providerId, key: action.setting.key, expected: { kind: "value", value }, desired: action.value })
    }
    case "set-git-ai-attribution":
      if (action.on === current.gitAiAttribution) return { kind: "applied" }
      return writeProfileSetting(connection, current.profileId, { id: "gitAiAttribution", expected: { kind: "value", value: current.gitAiAttribution }, desired: action.on })
    case "set-allow-training-routes":
      if (action.on === current.allowTrainingRoutes) return { kind: "applied" }
      return writeProfileSetting(connection, current.profileId, { id: "allowTrainingRoutes", expected: { kind: "value", value: current.allowTrainingRoutes }, desired: action.on })
    case "set-project-profile": {
      const result = await connection.dispatch(action.profileId === undefined
        ? { type: "auth.profile.unbind_current_project", scope: { kind: "defaults" } }
        : { type: "auth.profile.bind_current_project", scope: { kind: "defaults" }, id: action.profileId })
      if ("ok" in result && !result.ok) return { kind: "notice", severity: "warning", message: result.error }
      const warning = "warning" in result ? result.warning : undefined
      return warning === undefined ? { kind: "applied" } : { kind: "notice", severity: "warning", message: warning }
    }
    case "reset-defaults":
      return settingOutcome(await connection.dispatch({ type: "config.reset", profileId: current.profileId }))
    case "set-auto-delete-session-days":
      if (action.days === current.autoDeleteSessionDays) return { kind: "applied" }
      return writeSetting(connection, { id: "autoDeleteSessionDays", expected: { kind: "value", value: current.autoDeleteSessionDays }, desired: action.days })
    case "set-compaction-threshold":
      if (action.tokens === current.compactionThreshold) return { kind: "applied" }
      return writeSetting(connection, {
        id: "proactiveCompactionThreshold",
        expected: { kind: "value", value: current.compactionThreshold },
        desired: action.tokens,
      })
    case "set-effort": {
      if (current.seatModel === undefined) return { kind: "applied" }
      // Scoped to the session the snapshot was read for: the inline slider
      // steers this conversation, not the defaults every new session inherits.
      const scope = current.seatSessionId === undefined ? { kind: "defaults" } as const : { kind: "session", sessionId: current.seatSessionId } as const
      // Re-read rather than trusting the snapshot: the row names a stop by its
      // string form, and the typed effort value the mutation wants comes from
      // the runtime's own current list.
      const slot = current.seatSlot
      const efforts = await connection.query({ type: "effortOptions", scope, slot, model: current.seatModel })
      const picked = efforts.find((entry) => entry.selectable && String(entry.effort) === action.effort)
      if (!picked) return { kind: "applied" }
      await connection.dispatch({ type: "model.save_effort", scope, slot, model: current.seatModel, effort: picked.effort })
      return { kind: "applied" }
    }
  }
}

/** The module setting as `current` holds it, so a write states the value in
 *  force when it runs, not the one its row showed at the tap. A setting that
 *  `current` no longer lists keeps the row's value, and the runtime refuses
 *  the write if that value is stale. */
function moduleSettingInForce<S extends PanelModuleSetting>(current: PanelSettings, setting: S): S {
  const id = moduleSettingId(setting)
  return current.moduleSettings.find((candidate): candidate is S => candidate.control === setting.control && moduleSettingId(candidate) === id) ?? setting
}

type DispatchResult = { readonly ok: true } | { readonly ok: false; readonly error: string }

/** A capability write's result. The runtime states a refusal, such as a
 *  dependency that must be turned off first, in its own words. */
function capabilityOutcome(result: DispatchResult): SettingOutcome {
  return result.ok ? { kind: "applied" } : { kind: "notice", severity: "warning", message: `Flywheel did not change that capability: ${result.error}` }
}

/** A runtime policy write's result. `saved` says what a write changed while
 *  an override holds the policy for this run, because the switch alone cannot
 *  show that the change waits for the next run. */
function policyOutcome(result: DispatchResult, saved: string | undefined): SettingOutcome {
  if (!result.ok) return { kind: "notice", severity: "warning", message: `Flywheel did not change that setting: ${result.error}` }
  return saved === undefined ? { kind: "applied" } : { kind: "notice", severity: "info", message: saved }
}

/** One config write, with what the client believed still true.
 *
 *  The runtime refuses a write whose `expected` no longer matches, which is what
 *  stops a second client, or a hand edit of the file, being silently
 *  overwritten by a menu somebody opened a minute ago. */
async function writeSetting(connection: RuntimeConnection, setting: WorkspaceConfigSetting): Promise<SettingOutcome> {
  return settingOutcome(await connection.dispatch({ type: "config.mutate", setting }))
}

type ProfileConfigSetting = Extract<RuntimeConfigMutation, { readonly target: { readonly kind: "profile" } }>["setting"]
type ProjectConfigSetting = Extract<RuntimeConfigMutation, { readonly target: { readonly kind: "project" } }>["setting"]

async function writeProjectSetting(connection: RuntimeConnection, setting: ProjectConfigSetting): Promise<SettingOutcome> {
  return settingOutcome(await connection.dispatch({ type: "config.mutate", target: { kind: "project" }, setting }))
}

async function writeProfileSetting(connection: RuntimeConnection, profileId: string, setting: ProfileConfigSetting): Promise<SettingOutcome> {
  return settingOutcome(await connection.dispatch({ type: "config.mutate", target: { kind: "profile", profileId }, setting }))
}

function settingOutcome(result: RuntimeConfigMutationResult): SettingOutcome {
  switch (result.kind) {
    case "committed":
      return { kind: "applied" }
    case "committed-with-durability-warning":
      return { kind: "notice", severity: "info", message: result.warning }
    case "write-outcome-unknown":
      return { kind: "notice", severity: "warning", message: result.message }
    case "committed-with-degraded-application":
      // The file changed and something in the runtime did not follow. A
      // setting that reads as set while behaving as unset is the worst of the
      // outcomes here, so it is the loudest.
      return { kind: "notice", severity: "warning", message: `Saved, but not fully in effect: ${result.errors.join(" ")} Restarting the runtime should apply it.${result.durabilityWarning === undefined ? "" : ` ${result.durabilityWarning}`}` }
    default:
      return { kind: "notice", severity: "warning", message: `The setting did not change. ${result.message}` }
  }
}
