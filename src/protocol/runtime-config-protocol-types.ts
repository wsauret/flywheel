import type { RuntimePosition } from "./runtime-ui-protocol-types.js"
import type { WriteSyntaxThemeId } from "./write-syntax-theme.js"

interface RuntimeConfigDictionary<Value> { readonly [key: string]: Value }
interface RuntimeConfigProfile {
  readonly gitAiAttribution: boolean
  readonly allowTrainingRoutes: boolean
  readonly roles: RuntimeConfigDictionary<RuntimeConfigRole>
  /** Provider-scoped numeric settings, keyed by provider then by the setting
   *  key each provider module declares. Every declared key is present: the
   *  runtime fills the declared default where the profile authored none. */
  readonly providers: RuntimeConfigDictionary<RuntimeConfigDictionary<number>>
}
type RuntimeConfigRole = {
  readonly model?: string
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max" | "ultra"
}

export interface RuntimeConfigValues {
  readonly theme?: string
  readonly moduleSelection: readonly string[]
  readonly allowPersistentProcesses: boolean
  readonly foregroundBashHoldSeconds: number
  readonly showThinking: boolean
  readonly idleCompaction: boolean
  readonly writeSyntaxTheme: WriteSyntaxThemeId
  readonly requireWorkflowConfirmation: boolean
  readonly diffColors: "theme" | "standard"
  readonly compatibleRendering: "auto" | "on" | "off"
  readonly webSearchProvider: "chatgpt" | "exa"
  readonly fontTipDismissed: boolean
  readonly tabsHintDismissed: boolean
  readonly acknowledgedReleaseVersion?: string
  readonly proactiveCompactionThreshold: number
  readonly autoDeleteSessionDays: number
  /** Whether cards in the attached project show their build. Resolved for that
   *  project only; the runtime never sends other projects' settings. */
  readonly showBuild: boolean
  /** Only declared numeric-list keys from UI-safe module sections. */
  readonly moduleSections: RuntimeConfigDictionary<RuntimeConfigDictionary<boolean | readonly number[]>>
  readonly autoInstall: boolean
  /** Whether the terminal and the browser page the desktop when a session asks the person a question. */
  readonly notificationsDesktop: boolean
  readonly profiles: RuntimeConfigDictionary<RuntimeConfigProfile>
  readonly keybindings: RuntimeConfigDictionary<string>
  readonly budget: { readonly max_invocations: number; readonly max_tokens: number; readonly max_wall_clock_minutes: number }
  readonly workflow: { readonly max_attempts: number }
}

export type RuntimeConfigStatusView =
  | { readonly kind: "valid" }
  | { readonly kind: "missing"; readonly message: "The configuration file is missing. Default values are active." }
  | { readonly kind: "malformed"; readonly fallback: "defaults"; readonly message: "The configuration is malformed. Default values are active." }
  | { readonly kind: "malformed"; readonly fallback: "last-valid"; readonly message: "The configuration is malformed. The last valid values remain active." }
  | { readonly kind: "disposed"; readonly message: "The configuration owner is disposed." }

interface RuntimeConfigWarning {
  readonly code: "config-normalized"
  readonly message: "Some configuration values were ignored or normalized."
}

type RuntimeConfigSettingId =
  | "theme" | "moduleSelection" | "allowPersistentProcesses" | "foregroundBashHoldSeconds"
  | "showThinking" | "idleCompaction" | "writeSyntaxTheme" | "requireWorkflowConfirmation" | "diffColors" | "compatibleRendering"
  | "webSearchProvider" | "fontTipDismissed" | "tabsHintDismissed" | "acknowledgedReleaseVersion"
  | "proactiveCompactionThreshold" | "autoDeleteSessionDays" | "gitAiAttribution" | "allowTrainingRoutes"
  | "autoInstall" | "notificationsDesktop"

export type RuntimeConfigDiagnostic = {
  readonly kind: "setting"
  readonly settingId: RuntimeConfigSettingId
  readonly reason: "invalid-value" | "normalized-value"
}

export interface RuntimeConfigView {
  readonly revision: number
  readonly values: RuntimeConfigValues
  readonly status: RuntimeConfigStatusView
  readonly warnings: readonly RuntimeConfigWarning[]
  readonly diagnostics: readonly RuntimeConfigDiagnostic[]
}

export interface RuntimeConfigSnapshotResult {
  readonly snapshotPosition: RuntimePosition
  readonly config: RuntimeConfigView
}

export type RuntimeConfigPatchPayload = { readonly kind: "config.changed"; readonly config: RuntimeConfigView }

type RuntimeConfigExpected<T> = { readonly kind: "absent" } | { readonly kind: "value"; readonly value: T }

type RuntimeConfigSettingMutation<Id extends string, Value> = {
  readonly id: Id
  readonly expected: RuntimeConfigExpected<Value>
  readonly desired: Value
}

type RuntimeConfigWorkspaceSetting =
  | RuntimeConfigSettingMutation<"theme", string>
  | RuntimeConfigSettingMutation<"moduleSelection", readonly string[]>
  | RuntimeConfigSettingMutation<"allowPersistentProcesses", boolean>
  | RuntimeConfigSettingMutation<"foregroundBashHoldSeconds", number>
  | RuntimeConfigSettingMutation<"showThinking", boolean>
  | RuntimeConfigSettingMutation<"idleCompaction", boolean>
  | RuntimeConfigSettingMutation<"writeSyntaxTheme", WriteSyntaxThemeId>
  | RuntimeConfigSettingMutation<"requireWorkflowConfirmation", boolean>
  | RuntimeConfigSettingMutation<"diffColors", "theme" | "standard">
  | RuntimeConfigSettingMutation<"compatibleRendering", "auto" | "on" | "off">
  | RuntimeConfigSettingMutation<"webSearchProvider", "chatgpt" | "exa">
  | RuntimeConfigSettingMutation<"fontTipDismissed", boolean>
  | RuntimeConfigSettingMutation<"tabsHintDismissed", boolean>
  | RuntimeConfigSettingMutation<"acknowledgedReleaseVersion", string>
  | RuntimeConfigSettingMutation<"proactiveCompactionThreshold", number>
  | RuntimeConfigSettingMutation<"autoDeleteSessionDays", number>
  | (RuntimeConfigSettingMutation<"module", boolean | readonly number[]> & { readonly section: string; readonly key: string })
  | RuntimeConfigSettingMutation<"autoInstall", boolean>
  | RuntimeConfigSettingMutation<"notificationsDesktop", boolean>

/** One provider-scoped numeric setting. The runtime accepts only a key a
 *  provider module declares, within its declared bounds. */
type RuntimeConfigProviderSetting = RuntimeConfigSettingMutation<"provider", number> & { readonly providerId: string; readonly key: string }

type RuntimeConfigProfileSetting =
  | RuntimeConfigSettingMutation<"gitAiAttribution", boolean>
  | RuntimeConfigSettingMutation<"allowTrainingRoutes", boolean>
  | RuntimeConfigProviderSetting

export type RuntimeConfigMutation =
  | { readonly type: "config.mutate"; readonly target?: { readonly kind: "workspace" }; readonly setting: RuntimeConfigWorkspaceSetting }
  | { readonly type: "config.mutate"; readonly target: { readonly kind: "profile"; readonly profileId: string }; readonly setting: RuntimeConfigProfileSetting }
  /** The runtime derives the project from the connection's project, so a client never names one. */
  | { readonly type: "config.mutate"; readonly target: { readonly kind: "project" }; readonly setting: RuntimeConfigSettingMutation<"showBuild", boolean> }
  /** Puts every user-facing setting back to its default, including the named
   *  profile's provider-scoped settings. The runtime owns the defaults, so a
   *  client never restates them. */
  | { readonly type: "config.reset"; readonly profileId: string }

export type RuntimeConfigMutationResult =
  | { readonly kind: "stale"; readonly message: "The configuration changed before this update. Try again." }
  | { readonly kind: "lock-failed"; readonly message: "The configuration is busy. Try again." }
  | { readonly kind: "parse-or-decode-failed"; readonly message: "The configuration is invalid and was not changed." }
  | { readonly kind: "write-not-applied"; readonly message: "The configuration could not be saved." }
  | { readonly kind: "write-outcome-unknown"; readonly message: "Saving the configuration could not be verified. Refresh before trying again." }
  | { readonly kind: "disposed"; readonly message: "Configuration updates are unavailable." }
  | { readonly kind: "committed"; readonly revision: number }
  | { readonly kind: "committed-with-durability-warning"; readonly revision: number; readonly warning: "The configuration was saved, but publication verification or durability could not be confirmed." }
  | { readonly kind: "committed-with-degraded-application"; readonly revision: number; readonly errors: readonly ["A runtime component could not apply the configuration change."]; readonly durabilityWarning?: "The configuration was saved, but publication verification or durability could not be confirmed." }

export function runtimeConfigCursor() {
  return { scope: "workspace", domain: "config" } as const
}
