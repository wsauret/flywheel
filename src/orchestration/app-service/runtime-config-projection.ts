import { CONFIG_VALUE_ABSENT, type ConfigMutationResult, type RuntimeConfigOwner, type RuntimeConfigSnapshot } from "../config/runtime-config-owner.js"
import { PROJECT_SHOW_BUILD_DEFAULT, isPresentedSettingId } from "../config/setting-definitions.js"
import { installedModuleConfigSettings, installedProviderSettings } from "../modules.js"
import { Schema } from "effect"
import type { ModuleConfigNumberListControl, ModuleConfigSectionBooleanControl, ModuleProviderSetting } from "../../protocol/module-protocol-types.js"
import { Log } from "../../infra/log.js"
import type { FlywheelConfig } from "../config/schema.js"
import type { RuntimeUiPatchInput } from "../../protocol/runtime-ui-protocol-types.js"
import { runtimeConfigCursor, type RuntimeConfigDiagnostic, type RuntimeConfigMutation, type RuntimeConfigMutationResult, type RuntimeConfigStatusView, type RuntimeConfigView, type RuntimeConfigValues } from "../../protocol/runtime-config-protocol-types.js"
import type { NotificationEpisodeInput } from "../../infra/notification-episode.js"

const NORMALIZED_WARNING = { code: "config-normalized", message: "Some configuration values were ignored or normalized." } as const
const CONFIG_WARNING_SOURCE = "runtime:config-warning"
const CONFIG_WARNING = { sourceId: CONFIG_WARNING_SOURCE, title: "Configuration needs attention", message: "Open Settings to review highlighted configuration values.", severity: "warning", action: { kind: "open-settings" } } as const
const log = Log.create({ service: "runtime-config-protocol" })

/** The notice for highlighted values. A rejected file also drops every valid
 *  edit made in it, so the notice says which values remain in force. */
function configWarning(status: RuntimeConfigStatusView): Extract<NotificationEpisodeInput, { readonly type: "raise" }>["occurrence"] {
  return status.kind === "malformed" ? { ...CONFIG_WARNING, message: `${status.message} ${CONFIG_WARNING.message}` } : CONFIG_WARNING
}

function projectDiagnostic(diagnostic: RuntimeConfigSnapshot["diagnostics"][number]): RuntimeConfigDiagnostic | undefined {
  if (diagnostic.kind !== "setting" || !isPresentedSettingId(diagnostic.settingId)) return undefined
  return { kind: "setting", settingId: diagnostic.settingId, reason: diagnostic.reason }
}
/** The profile's provider tables with every declared key present: the
 *  authored value, or the declared default the runtime applies in its place. */
function projectProviderSettings(authored: FlywheelConfig["profiles"][string]["providers"], declared: readonly ModuleProviderSetting[]): RuntimeConfigValues["profiles"][string]["providers"] {
  const providers: { [providerId: string]: { [key: string]: number } } = {}
  for (const setting of declared) {
    const table = providers[setting.providerId] ?? {}
    table[setting.key] = authored[setting.providerId]?.[setting.key] ?? setting.defaultValue
    providers[setting.providerId] = table
  }
  return providers
}

function validModuleSetting(value: boolean | readonly number[], setting: ModuleConfigNumberListControl | ModuleConfigSectionBooleanControl): boolean {
  if (setting.control === "config-boolean") return typeof value === "boolean"
  if (typeof value === "boolean") return false
  return value.every((number, index) => Number.isInteger(number) && number >= setting.min && number <= setting.max && (index === 0 || number > (value[index - 1] ?? 0)))
}

function projectModuleSettings(config: FlywheelConfig): RuntimeConfigValues["moduleSections"] {
  const sections: { [section: string]: { [key: string]: boolean | readonly number[] } } = {}
  for (const { section, setting } of installedModuleConfigSettings()) {
    const values: { readonly [key: string]: unknown } = config
    const fields = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(values[section.key] ?? {})
    const value = setting.control === "config-boolean"
      ? Schema.decodeUnknownSync(Schema.Boolean)(fields[setting.key] ?? setting.defaultValue)
      : Schema.decodeUnknownSync(Schema.Array(Schema.Int))(fields[setting.key] ?? setting.defaultValue)
    const sectionValues = sections[section.key] ?? {}
    sectionValues[setting.key] = value
    sections[section.key] = sectionValues
  }
  return sections
}

export function projectRuntimeConfig(snapshot: RuntimeConfigSnapshot, projectRoot: string, declaredProviderSettings: readonly ModuleProviderSetting[] = installedProviderSettings()): RuntimeConfigView {
  const config = snapshot.config
  const values: RuntimeConfigValues = {
    ...(config.theme === undefined ? {} : { theme: config.theme }),
    moduleSelection: config.modules,
    allowPersistentProcesses: config.allow_persistent_processes,
    foregroundBashHoldSeconds: config.foreground_bash_hold_seconds,
    showThinking: config.show_thinking,
    idleCompaction: config.idle_compaction,
    writeSyntaxTheme: config.write_syntax_theme,
    requireWorkflowConfirmation: config.require_workflow_confirmation,
    diffColors: config.diff_colors,
    compatibleRendering: config.compatible_rendering,
    webSearchProvider: config.web_search.provider,
    fontTipDismissed: config.font_tip_dismissed,
    tabsHintDismissed: config.tabs_hint_dismissed,
    ...(config.acknowledged_release_version === undefined ? {} : { acknowledgedReleaseVersion: config.acknowledged_release_version }),
    proactiveCompactionThreshold: config.proactive_compaction_threshold,
    autoDeleteSessionDays: config.auto_delete_session_days,
    showBuild: config.projects[projectRoot]?.show_build ?? PROJECT_SHOW_BUILD_DEFAULT,
    moduleSections: projectModuleSettings(config),
    autoInstall: config.updates.auto_install,
    notificationsDesktop: config.notifications.desktop,
    profiles: Object.fromEntries(Object.entries(config.profiles).map(([id, profile]) => [id, {
      gitAiAttribution: profile.git_ai_attribution,
      allowTrainingRoutes: profile.allow_training_routes,
      roles: projectRoles(profile.roles),
      providers: projectProviderSettings(profile.providers, declaredProviderSettings),
    }])),
    keybindings: config.keybindings,
    budget: config.budget,
    workflow: config.workflow,
  }
  return {
    revision: snapshot.revision,
    values,
    status: statusView(snapshot),
    warnings: snapshot.warnings.length === 0 ? [] : [NORMALIZED_WARNING],
    diagnostics: snapshot.diagnostics.flatMap((diagnostic) => {
      const projected = projectDiagnostic(diagnostic)
      return projected === undefined ? [] : [projected]
    }),
  }
}

function statusView(snapshot: RuntimeConfigSnapshot): RuntimeConfigStatusView {
  switch (snapshot.status.kind) {
    case "valid": return { kind: "valid" }
    case "missing": return { kind: "missing", message: "The configuration file is missing. Default values are active." }
    case "malformed": return snapshot.status.fallback === "defaults"
      ? { kind: "malformed", fallback: "defaults", message: "The configuration is malformed. Default values are active." }
      : { kind: "malformed", fallback: "last-valid", message: "The configuration is malformed. The last valid values remain active." }
    case "disposed": return { kind: "disposed", message: "The configuration owner is disposed." }
  }
}

export interface RuntimeConfigProjection {
  view(): RuntimeConfigView
  refresh(): Promise<RuntimeConfigView>
  mutate(command: RuntimeConfigMutation): Promise<RuntimeConfigMutationResult>
  dispose(): Promise<void>
}

export function createRuntimeConfigProjection(options: {
  readonly owner: RuntimeConfigOwner
  /** Canonical root of the attached project: the key its project settings are read and written under. */
  readonly projectRoot: string
  readonly publish: (patch: RuntimeUiPatchInput) => void
  readonly notify?: (episode: NotificationEpisodeInput) => void
}): RuntimeConfigProjection {
  let view = projectRuntimeConfig(options.owner.snapshot(), options.projectRoot)
  let warningActive: boolean | undefined
  const publishWarningCondition = (next: RuntimeConfigView): void => {
    const hasWarnings = next.diagnostics.length > 0
    if (warningActive === undefined && !hasWarnings) {
      warningActive = false
      return
    }
    if (hasWarnings === warningActive) return
    options.notify?.(hasWarnings ? { type: "raise", occurrence: configWarning(next.status) } : { type: "resolve", sourceId: CONFIG_WARNING_SOURCE })
    warningActive = hasWarnings
  }
  publishWarningCondition(view)
  const publish = (snapshot: RuntimeConfigSnapshot): RuntimeConfigView => {
    if (snapshot.revision === view.revision) return view
    view = projectRuntimeConfig(snapshot, options.projectRoot)
    publishWarningCondition(view)
    options.publish({ cursor: runtimeConfigCursor(), payload: { kind: "config.changed", config: view } })
    return view
  }
  const unsubscribe = options.owner.subscribeAll((snapshot) => { publish(snapshot) })
  return {
    view: () => view,
    refresh: async () => publish(await options.owner.refresh()),
    mutate: async (command) => {
      let result: ConfigMutationResult
      if (command.type === "config.reset") {
        result = await options.owner.resetSettings(command.profileId)
      } else if (command.setting.id === "module") {
        const { section: sectionKey, key, expected, desired } = command.setting
        const declared = installedModuleConfigSettings().find(({ moduleId, setting }) => view.values.moduleSelection.includes(moduleId) && setting.section === sectionKey && setting.key === key)
        if (!declared || !validModuleSetting(desired, declared.setting)) return { kind: "parse-or-decode-failed", message: "The configuration is invalid and was not changed." }
        result = await options.owner.mutateModuleSetting(declared.section, key, expected.kind === "absent" ? declared.setting.defaultValue : expected.value, desired, declared.setting.defaultValue)
      } else if (command.setting.id === "showBuild") {
        const { expected, desired } = command.setting
        result = await options.owner.mutateProjectShowBuild(options.projectRoot, expected.kind === "absent" ? PROJECT_SHOW_BUILD_DEFAULT : expected.value, desired)
      } else if (command.setting.id === "gitAiAttribution" || command.setting.id === "allowTrainingRoutes") {
        if (command.target?.kind !== "profile") return { kind: "parse-or-decode-failed", message: "The configuration is invalid and was not changed." }
        const { expected, desired } = command.setting
        result = await options.owner.mutateProfileBoolean(command.setting.id, command.target.profileId, expected.kind === "absent" ? false : expected.value, desired)
      } else if (command.setting.id === "provider") {
        // Only a declared key within its declared bounds is a setting; anything
        // else is a malformed request, not a value to store.
        const { providerId, key, expected, desired } = command.setting
        const declared = installedProviderSettings().find((setting) => setting.providerId === providerId && setting.key === key)
        if (command.target?.kind !== "profile" || declared === undefined || !Number.isInteger(desired) || desired < declared.min || desired > declared.max) {
          return { kind: "parse-or-decode-failed", message: "The configuration is invalid and was not changed." }
        }
        result = await options.owner.mutateProfileProviderSetting(command.target.profileId, providerId, key, expected.kind === "absent" ? declared.defaultValue : expected.value, desired, declared.defaultValue)
      } else {
        const { id, expected, desired } = command.setting
        result = await options.owner.mutate(id, expected.kind === "absent" ? CONFIG_VALUE_ABSENT : expected.value, desired)
      }
      if (!result.ok) return failedMutation(result)
      publish(result.snapshot)
      if (result.subscriberOutcome.kind === "committed-but-degraded") {
        return {
          kind: "committed-with-degraded-application",
          revision: result.snapshot.revision,
          errors: ["A runtime component could not apply the configuration change."],
          ...(result.durabilityWarning === undefined ? {} : { durabilityWarning: "The configuration was saved, but publication verification or durability could not be confirmed." }),
        }
      }
      return result.durabilityWarning === undefined
        ? { kind: "committed", revision: result.snapshot.revision }
        : { kind: "committed-with-durability-warning", revision: result.snapshot.revision, warning: "The configuration was saved, but publication verification or durability could not be confirmed." }
    },
    dispose: unsubscribe,
  }
}

function failedMutation(result: Extract<ConfigMutationResult, { readonly ok: false }>): RuntimeConfigMutationResult {
  log.error("runtime-config-mutation-failed", { code: "runtime-config-mutation-failed" })
  switch (result.kind) {
    case "stale": return { kind: "stale", message: "The configuration changed before this update. Try again." }
    case "disposed": return { kind: "disposed", message: "Configuration updates are unavailable." }
    case "lock-failed": return { kind: "lock-failed", message: "The configuration is busy. Try again." }
    case "parse-or-decode-failed": return { kind: "parse-or-decode-failed", message: "The configuration is invalid and was not changed." }
    case "write-not-applied": return { kind: "write-not-applied", message: "The configuration could not be saved." }
    case "write-outcome-unknown": return { kind: "write-outcome-unknown", message: "Saving the configuration could not be verified. Refresh before trying again." }
  }
}

function projectRoles(roles: FlywheelConfig["profiles"][string]["roles"]): RuntimeConfigValues["profiles"][string]["roles"] {
  return Object.fromEntries(Object.entries(roles).map(([id, role]) => [id, {
    ...(role.model === undefined ? {} : { model: role.model }),
    ...(role.effort === undefined ? {} : { effort: role.effort }),
  }]))
}
