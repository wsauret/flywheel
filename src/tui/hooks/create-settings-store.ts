import type { Accessor } from "solid-js"
import { Schema } from "effect"
import { MODAL_SETTINGS_DEFAULTS, type ProfileBooleanSettingId } from "../../orchestration/config/setting-definitions.js"
import type { ModuleConfigBooleanSettingId, ModuleConfigNumberListControl, ModuleConfigSettingControl, ModuleProviderSetting } from "../../protocol/module-protocol-types.js"
import type { CompatibleRenderingMode, DiffColorMode, WebSearchProvider } from "../../orchestration/config/schema.js"
import { WriteSyntaxThemeIdSchema, type WriteSyntaxThemeId } from "../../protocol/write-syntax-theme.js"
import type { getFontStatus, fontInstallSummary, installBundledFont } from "../../orchestration/font-installer.js"
import type { RuntimeClient } from "../../protocol/app-service-types.js"
import type { RuntimeConfigMutationResult, RuntimeConfigStatusView, RuntimeConfigView } from "../../protocol/runtime-config-protocol-types.js"
import { mutateRuntimeConfig, type RuntimeConfigCache } from "./shell-state.js"

type SectionBooleanControl = Extract<ModuleConfigSettingControl, { readonly section: string; readonly control: "config-boolean" }>
type BooleanControl = ModuleConfigBooleanSettingId | SectionBooleanControl

type LocalSettingOverrides = {
  diffColors: DiffColorMode
  writeSyntaxTheme: WriteSyntaxThemeId
  compatibleRendering: CompatibleRenderingMode
  webSearchProvider: WebSearchProvider
}

type WidenSetting<T> = T extends boolean ? boolean : T extends number ? number : T
type SettingsValues = {
  [K in keyof typeof MODAL_SETTINGS_DEFAULTS]: K extends keyof LocalSettingOverrides
    ? LocalSettingOverrides[K]
    : WidenSetting<typeof MODAL_SETTINGS_DEFAULTS[K]>
}
type LocalSettingsKey = keyof SettingsValues

function isLocalSettingsKey(key: string): key is LocalSettingsKey {
  return key in MODAL_SETTINGS_DEFAULTS
}

type SettingsPublication =
  | { readonly kind: "pending" }
  | { readonly kind: "ready"; readonly view: RuntimeConfigView }
  | { readonly kind: "error"; readonly message: string }

type SettingsMutationResult =
  | { readonly ok: true; readonly notice?: string }
  | { readonly ok: false; readonly error: Error }

export interface SettingsStore {
  readonly publication: Accessor<SettingsPublication>
  readonly values: SettingsValues
  readonly diagnostics: Accessor<RuntimeConfigView["diagnostics"]>
  /** The configuration file's state, which says what an invalid value leaves in force. */
  readonly status: Accessor<RuntimeConfigStatusView>
  profileBoolean(profileId: string, key: ProfileBooleanSettingId): boolean | undefined
  /** The value in force for one provider-scoped numeric setting, or undefined before the view is published. */
  profileProviderSetting(profileId: string, setting: ModuleProviderSetting): number | undefined
  updateProfileBoolean(profileId: string, key: ProfileBooleanSettingId, value: boolean): Promise<SettingsMutationResult>
  /** This project's Show build setting, or undefined before the view is published. */
  showBuild(): boolean | undefined
  updateShowBuild(value: boolean): Promise<SettingsMutationResult>
  updateProfileProviderSetting(profileId: string, setting: ModuleProviderSetting, value: number): Promise<SettingsMutationResult>
  update(key: LocalSettingsKey, value: SettingsValues[LocalSettingsKey]): Promise<SettingsMutationResult>
  /** A boolean setting a module owns the row for, or undefined before the view is published. */
  configNumberList(setting: ModuleConfigNumberListControl): readonly number[] | undefined
  updateConfigNumberList(setting: ModuleConfigNumberListControl, value: readonly number[]): Promise<SettingsMutationResult>
  configBoolean(setting: BooleanControl): boolean | undefined
  updateConfigBoolean(setting: BooleanControl, value: boolean): Promise<SettingsMutationResult>
  resetDefaults(profileId: string): Promise<SettingsMutationResult>
  presentation: {
    read(definitionId: string): boolean | string
    update(definitionId: string, value: boolean | string): Promise<SettingsMutationResult>
  }
}

export interface SettingsOperations {
  getFontStatus: typeof getFontStatus
  installBundledFont: typeof installBundledFont
  fontInstallSummary: typeof fontInstallSummary
}

function resultOf(result: RuntimeConfigMutationResult): SettingsMutationResult {
  switch (result.kind) {
    case "committed": return { ok: true }
    case "committed-with-durability-warning": return { ok: true, notice: result.warning }
    case "committed-with-degraded-application": return {
      ok: true,
      notice: result.durabilityWarning === undefined
        ? "The configuration was saved, but a runtime component did not apply the change."
        : `A runtime component did not apply the change. ${result.durabilityWarning}`,
    }
    default: return { ok: false, error: new Error(result.message) }
  }
}


/** A reactive settings view over the runtime-owned configuration cache. Writes
 * use compare-and-swap mutations and become visible only through publication. */
export function createSettingsStore(config: RuntimeConfigCache, appService: Pick<RuntimeClient, "dispatch">): SettingsStore {
  const publication = (): SettingsPublication => {
    const view = config.view()
    if (!view) return { kind: "pending" }
    return view.status.kind === "disposed" ? { kind: "error", message: view.status.message } : { kind: "ready", view }
  }
  const readyValues = (): RuntimeConfigView["values"] | undefined => {
    const state = publication()
    return state.kind === "ready" ? state.view.values : undefined
  }
  const values: SettingsValues = {
    get showThinking() { return readyValues()?.showThinking ?? MODAL_SETTINGS_DEFAULTS.showThinking },
    get idleCompaction() { return readyValues()?.idleCompaction ?? MODAL_SETTINGS_DEFAULTS.idleCompaction },
    get autoDeleteSessionDays() { return readyValues()?.autoDeleteSessionDays ?? MODAL_SETTINGS_DEFAULTS.autoDeleteSessionDays },
    get writeSyntaxTheme() { return readyValues()?.writeSyntaxTheme ?? MODAL_SETTINGS_DEFAULTS.writeSyntaxTheme },
    get diffColors() { return readyValues()?.diffColors ?? MODAL_SETTINGS_DEFAULTS.diffColors },
    get compatibleRendering() { return readyValues()?.compatibleRendering ?? MODAL_SETTINGS_DEFAULTS.compatibleRendering },
    get webSearchProvider() { return readyValues()?.webSearchProvider ?? MODAL_SETTINGS_DEFAULTS.webSearchProvider },
    get proactiveCompactionThreshold() { return readyValues()?.proactiveCompactionThreshold ?? MODAL_SETTINGS_DEFAULTS.proactiveCompactionThreshold },
  }
  const update = async (key: LocalSettingsKey, value: SettingsValues[LocalSettingsKey]): Promise<SettingsMutationResult> => {
    const state = publication()
    if (state.kind !== "ready") return { ok: false, error: new Error(state.kind === "pending" ? "Configuration is still loading" : state.message) }
    switch (key) {
      case "showThinking": return resultOf(await mutateRuntimeConfig(config, appService, { type: "config.mutate", setting: { id: "showThinking", expected: { kind: "value", value: state.view.values.showThinking }, desired: Boolean(value) } }))
      case "idleCompaction": return resultOf(await mutateRuntimeConfig(config, appService, { type: "config.mutate", setting: { id: "idleCompaction", expected: { kind: "value", value: state.view.values.idleCompaction }, desired: Boolean(value) } }))
      case "autoDeleteSessionDays": return resultOf(await mutateRuntimeConfig(config, appService, { type: "config.mutate", setting: { id: "autoDeleteSessionDays", expected: { kind: "value", value: state.view.values.autoDeleteSessionDays }, desired: typeof value === "number" ? value : 0 } }))
      case "writeSyntaxTheme":
        if (!Schema.is(WriteSyntaxThemeIdSchema)(value)) return { ok: false, error: new Error(`Invalid setting value: ${key}`) }
        return resultOf(await mutateRuntimeConfig(config, appService, { type: "config.mutate", setting: { id: "writeSyntaxTheme", expected: { kind: "value", value: state.view.values.writeSyntaxTheme }, desired: value } }))
      case "diffColors": return resultOf(await mutateRuntimeConfig(config, appService, { type: "config.mutate", setting: { id: "diffColors", expected: { kind: "value", value: state.view.values.diffColors }, desired: value === "standard" ? "standard" : "theme" } }))
      case "compatibleRendering": return resultOf(await mutateRuntimeConfig(config, appService, { type: "config.mutate", setting: { id: "compatibleRendering", expected: { kind: "value", value: state.view.values.compatibleRendering }, desired: value === "on" || value === "off" ? value : "auto" } }))
      case "webSearchProvider": return resultOf(await mutateRuntimeConfig(config, appService, { type: "config.mutate", setting: { id: "webSearchProvider", expected: { kind: "value", value: state.view.values.webSearchProvider }, desired: value === "exa" ? "exa" : "chatgpt" } }))
      case "proactiveCompactionThreshold": return resultOf(await mutateRuntimeConfig(config, appService, { type: "config.mutate", setting: { id: "proactiveCompactionThreshold", expected: { kind: "value", value: state.view.values.proactiveCompactionThreshold }, desired: typeof value === "number" ? value : 0 } }))
    }
  }
  const configNumberList = (setting: ModuleConfigNumberListControl): readonly number[] | undefined => {
    const published = readyValues()
    if (published === undefined) return undefined
    const value = published.moduleSections[setting.section]?.[setting.key]
    return typeof value === "boolean" ? setting.defaultValue : value ?? setting.defaultValue
  }
  const updateConfigNumberList = async (setting: ModuleConfigNumberListControl, value: readonly number[]): Promise<SettingsMutationResult> => {
    const state = publication()
    if (state.kind !== "ready") return { ok: false, error: new Error(state.kind === "pending" ? "Configuration is still loading" : state.message) }
    const expected = state.view.values.moduleSections[setting.section]?.[setting.key] ?? setting.defaultValue
    return resultOf(await mutateRuntimeConfig(config, appService, { type: "config.mutate", setting: { id: "module", section: setting.section, key: setting.key, expected: { kind: "value", value: expected }, desired: [...value] } }))
  }
  const configBoolean = (setting: BooleanControl): boolean | undefined => {
    const published = readyValues()
    if (!published) return undefined
    if (typeof setting === "string") return published[setting]
    const value = published.moduleSections[setting.section]?.[setting.key]
    return typeof value === "boolean" ? value : setting.defaultValue
  }
  const updateConfigBoolean = async (setting: BooleanControl, value: boolean): Promise<SettingsMutationResult> => {
    const state = publication()
    if (state.kind !== "ready") return { ok: false, error: new Error(state.kind === "pending" ? "Configuration is still loading" : state.message) }
    if (typeof setting !== "string") {
      const expected = configBoolean(setting) ?? setting.defaultValue
      return resultOf(await mutateRuntimeConfig(config, appService, { type: "config.mutate", setting: { id: "module", section: setting.section, key: setting.key, expected: { kind: "value", value: expected }, desired: value } }))
    }
    return resultOf(await mutateRuntimeConfig(config, appService, { type: "config.mutate", setting: { id: setting, expected: { kind: "value", value: state.view.values[setting] }, desired: value } }))
  }
  const profileBoolean = (profileId: string, key: ProfileBooleanSettingId): boolean | undefined => {
    const state = publication()
    return state.kind === "ready" ? state.view.values.profiles[profileId]?.[key] ?? false : undefined
  }
  const profileProviderSetting = (profileId: string, setting: ModuleProviderSetting): number | undefined => {
    const state = publication()
    return state.kind === "ready" ? state.view.values.profiles[profileId]?.providers[setting.providerId]?.[setting.key] ?? setting.defaultValue : undefined
  }
  const updateProfileBoolean = async (profileId: string, key: ProfileBooleanSettingId, value: boolean): Promise<SettingsMutationResult> => {
    const state = publication()
    if (state.kind !== "ready") return { ok: false, error: new Error(state.kind === "pending" ? "Configuration is still loading" : state.message) }
    const expected = state.view.values.profiles[profileId]?.[key] ?? false
    const command = {
      type: "config.mutate",
      target: { kind: "profile", profileId },
      setting: { id: key, expected: { kind: "value", value: expected }, desired: value },
    } as const
    const result = await appService.dispatch(command)
    if (result.kind !== "committed" && result.kind !== "committed-with-durability-warning" && result.kind !== "committed-with-degraded-application") return resultOf(result)
    await config.settlePublication(command, result.revision)
    const published = config.view()
    return published !== undefined && published.revision >= result.revision && published.values.profiles[profileId]?.[key] === value
      ? resultOf(result)
      : { ok: false, error: new Error("Configuration updates are unavailable.") }
  }
  const updateProfileProviderSetting = async (profileId: string, setting: ModuleProviderSetting, value: number): Promise<SettingsMutationResult> => {
    const state = publication()
    if (state.kind !== "ready") return { ok: false, error: new Error(state.kind === "pending" ? "Configuration is still loading" : state.message) }
    const expected = state.view.values.profiles[profileId]?.providers[setting.providerId]?.[setting.key] ?? setting.defaultValue
    const command = { type: "config.mutate", target: { kind: "profile", profileId }, setting: { id: "provider", providerId: setting.providerId, key: setting.key, expected: { kind: "value", value: expected }, desired: value } } as const
    const result = await appService.dispatch(command)
    if (result.kind !== "committed" && result.kind !== "committed-with-durability-warning" && result.kind !== "committed-with-degraded-application") return resultOf(result)
    await config.settlePublication(command, result.revision)
    const published = config.view()
    return published !== undefined && published.revision >= result.revision && published.values.profiles[profileId]?.providers[setting.providerId]?.[setting.key] === value
      ? resultOf(result)
      : { ok: false, error: new Error("Configuration updates are unavailable.") }
  }
  const showBuild = (): boolean | undefined => readyValues()?.showBuild
  const updateShowBuild = async (value: boolean): Promise<SettingsMutationResult> => {
    const state = publication()
    if (state.kind !== "ready") return { ok: false, error: new Error(state.kind === "pending" ? "Configuration is still loading" : state.message) }
    return resultOf(await mutateRuntimeConfig(config, appService, { type: "config.mutate", target: { kind: "project" }, setting: { id: "showBuild", expected: { kind: "value", value: state.view.values.showBuild }, desired: value } }))
  }
  return {
    publication,
    values,
    diagnostics: () => {
      const state = publication()
      return state.kind === "ready" ? state.view.diagnostics : []
    },
    status: (): RuntimeConfigStatusView => {
      const state = publication()
      return state.kind === "ready" ? state.view.status : { kind: "valid" }
    },
    profileBoolean,
    updateProfileBoolean,
    showBuild,
    updateShowBuild,
    profileProviderSetting,
    updateProfileProviderSetting,
    update,
    configNumberList,
    updateConfigNumberList,
    configBoolean,
    updateConfigBoolean,
    presentation: {
      read(definitionId) {
        if (!isLocalSettingsKey(definitionId)) throw new Error(`Unknown simple presentation setting: ${definitionId}`)
        const value = values[definitionId]
        if (typeof value === "boolean" || typeof value === "string") return value
        throw new Error(`Invalid simple presentation value: ${definitionId}`)
      },
      async update(definitionId, value) {
        if (!isLocalSettingsKey(definitionId)) throw new Error(`Invalid presentation setting write: ${definitionId}`)
        switch (definitionId) {
          case "showThinking":
          case "idleCompaction":
            if (typeof value !== "boolean") throw new Error(`Invalid presentation setting value: ${definitionId}`)
            return update(definitionId, value)
          case "writeSyntaxTheme":
            if (!Schema.is(WriteSyntaxThemeIdSchema)(value)) throw new Error(`Invalid presentation setting value: ${definitionId}`)
            return update(definitionId, value)
          case "diffColors":
            if (value !== "theme" && value !== "standard") throw new Error(`Invalid presentation setting value: ${definitionId}`)
            return update(definitionId, value)
          case "compatibleRendering":
            if (value !== "auto" && value !== "on" && value !== "off") throw new Error(`Invalid presentation setting value: ${definitionId}`)
            return update(definitionId, value)
          case "webSearchProvider":
            if (value !== "chatgpt" && value !== "exa") throw new Error(`Invalid presentation setting value: ${definitionId}`)
            return update(definitionId, value)
          default: throw new Error(`Invalid presentation setting write: ${definitionId}`)
        }
      },
    },
    async resetDefaults(profileId) {
      const state = publication()
      if (state.kind !== "ready") return { ok: false, error: new Error(state.kind === "pending" ? "Configuration is still loading" : state.message) }
      return resultOf(await mutateRuntimeConfig(config, appService, { type: "config.reset", profileId }))
    },
  }
}
