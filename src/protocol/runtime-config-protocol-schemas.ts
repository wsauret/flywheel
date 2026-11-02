import { Schema } from "effect"
import { parseReleaseVersion } from "../infra/update/version-order.js"
import type {
  RuntimeConfigMutation,
  RuntimeConfigMutationResult,
  RuntimeConfigPatchPayload,
  RuntimeConfigSnapshotResult,
  RuntimeConfigView,
} from "./runtime-config-protocol-types.js"
import { WriteSyntaxThemeIdSchema } from "./write-syntax-theme.js"

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const ReleaseVersionSchema = Schema.String.check(Schema.makeFilter((value) => parseReleaseVersion(value)?.precedence !== undefined || "expected a release version"))
const ConfigStatusSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("valid") }),
  Schema.Struct({ kind: Schema.Literal("missing"), message: Schema.Literal("The configuration file is missing. Default values are active.") }),
  Schema.Struct({ kind: Schema.Literal("malformed"), fallback: Schema.Literal("defaults"), message: Schema.Literal("The configuration is malformed. Default values are active.") }),
  Schema.Struct({ kind: Schema.Literal("malformed"), fallback: Schema.Literal("last-valid"), message: Schema.Literal("The configuration is malformed. The last valid values remain active.") }),
  Schema.Struct({ kind: Schema.Literal("disposed"), message: Schema.Literal("The configuration owner is disposed.") }),
])
const TierConfigViewSchema = Schema.Struct({ model: Schema.optionalKey(Schema.String), effort: Schema.optionalKey(Schema.Literals(["low", "medium", "high", "xhigh", "max", "ultra"])) })
const RuntimeConfigValuesSchema = Schema.Struct({
  theme: Schema.optionalKey(Schema.String), moduleSelection: Schema.Array(Schema.String), allowPersistentProcesses: Schema.Boolean, foregroundBashHoldSeconds: Schema.Int,
  showThinking: Schema.Boolean, idleCompaction: Schema.Boolean, writeSyntaxTheme: WriteSyntaxThemeIdSchema, requireWorkflowConfirmation: Schema.Boolean, diffColors: Schema.Literals(["theme", "standard"]), compatibleRendering: Schema.Literals(["auto", "on", "off"]), webSearchProvider: Schema.Literals(["chatgpt", "exa"]),
  fontTipDismissed: Schema.Boolean, tabsHintDismissed: Schema.Boolean, proactiveCompactionThreshold: Schema.Int, autoDeleteSessionDays: NonNegativeInt, showBuild: Schema.Boolean, moduleSections: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Union([Schema.Boolean, Schema.Array(Schema.Int)]))), autoInstall: Schema.Boolean, notificationsDesktop: Schema.Boolean,
  acknowledgedReleaseVersion: Schema.optionalKey(ReleaseVersionSchema),
  profiles: Schema.Record(Schema.String, Schema.Struct({ gitAiAttribution: Schema.Boolean, allowTrainingRoutes: Schema.Boolean, roles: Schema.Record(Schema.String, TierConfigViewSchema), providers: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Number)) })), keybindings: Schema.Record(Schema.String, Schema.String),
  budget: Schema.Struct({ max_invocations: NonNegativeInt, max_tokens: NonNegativeInt, max_wall_clock_minutes: NonNegativeInt }), workflow: Schema.Struct({ max_attempts: NonNegativeInt }),
})
const RuntimeConfigSettingIdSchema = Schema.Literals([
  "theme", "moduleSelection", "allowPersistentProcesses", "foregroundBashHoldSeconds", "showThinking", "idleCompaction", "writeSyntaxTheme",
  "requireWorkflowConfirmation", "diffColors", "compatibleRendering", "webSearchProvider",
  "fontTipDismissed", "tabsHintDismissed", "acknowledgedReleaseVersion", "proactiveCompactionThreshold", "autoDeleteSessionDays", "allowTrainingRoutes",
  "autoInstall", "notificationsDesktop",
])
const RuntimeConfigDiagnosticSchema = Schema.Struct({
  kind: Schema.Literal("setting"),
  settingId: RuntimeConfigSettingIdSchema,
  reason: Schema.Literals(["invalid-value", "normalized-value"]),
})
const RuntimeConfigViewSchema: Schema.Codec<RuntimeConfigView> = Schema.Struct({ revision: NonNegativeInt, values: RuntimeConfigValuesSchema, status: ConfigStatusSchema, warnings: Schema.Array(Schema.Struct({ code: Schema.Literal("config-normalized"), message: Schema.Literal("Some configuration values were ignored or normalized.") })), diagnostics: Schema.Array(RuntimeConfigDiagnosticSchema) })
export const RuntimeConfigSnapshotResultSchema: Schema.Codec<RuntimeConfigSnapshotResult> = Schema.Struct({ snapshotPosition: Schema.Number, config: RuntimeConfigViewSchema })
export const RuntimeConfigPatchPayloadSchema: Schema.Codec<RuntimeConfigPatchPayload> = Schema.Struct({ kind: Schema.Literal("config.changed"), config: RuntimeConfigViewSchema })
const configExpectedSchema = <S extends Schema.Top>(value: S) => Schema.Union([
  Schema.Struct({ kind: Schema.Literal("absent") }),
  Schema.Struct({ kind: Schema.Literal("value"), value }),
])
const configSettingMutationSchema = <Id extends string, S extends Schema.Top>(id: Id, value: S) => Schema.Struct({ id: Schema.Literal(id), expected: configExpectedSchema(value), desired: value })
const workspaceSettingMutationSchema = Schema.Union([
  configSettingMutationSchema("autoDeleteSessionDays", NonNegativeInt),
  configSettingMutationSchema("theme", Schema.String), configSettingMutationSchema("moduleSelection", Schema.Array(Schema.String)), configSettingMutationSchema("allowPersistentProcesses", Schema.Boolean),
  configSettingMutationSchema("foregroundBashHoldSeconds", Schema.Number), configSettingMutationSchema("showThinking", Schema.Boolean), configSettingMutationSchema("idleCompaction", Schema.Boolean), configSettingMutationSchema("writeSyntaxTheme", WriteSyntaxThemeIdSchema),
  configSettingMutationSchema("requireWorkflowConfirmation", Schema.Boolean), configSettingMutationSchema("diffColors", Schema.Literals(["theme", "standard"])), configSettingMutationSchema("compatibleRendering", Schema.Literals(["auto", "on", "off"])),
  configSettingMutationSchema("webSearchProvider", Schema.Literals(["chatgpt", "exa"])), configSettingMutationSchema("fontTipDismissed", Schema.Boolean), configSettingMutationSchema("tabsHintDismissed", Schema.Boolean),
  configSettingMutationSchema("acknowledgedReleaseVersion", ReleaseVersionSchema),
  configSettingMutationSchema("proactiveCompactionThreshold", Schema.Number), Schema.Struct({ ...configSettingMutationSchema("module", Schema.Union([Schema.Boolean, Schema.Array(Schema.Number)])).fields, section: Schema.String, key: Schema.String }), configSettingMutationSchema("autoInstall", Schema.Boolean), configSettingMutationSchema("notificationsDesktop", Schema.Boolean),
])
const profileSettingMutationSchema = Schema.Union([
  configSettingMutationSchema("gitAiAttribution", Schema.Boolean),
  configSettingMutationSchema("allowTrainingRoutes", Schema.Boolean),
  Schema.Struct({ id: Schema.Literal("provider"), providerId: Schema.NonEmptyString, key: Schema.NonEmptyString, expected: configExpectedSchema(Schema.Number), desired: Schema.Number }),
])
export const RuntimeConfigMutationSchema: Schema.Codec<RuntimeConfigMutation> = Schema.Union([
  Schema.Struct({ type: Schema.Literal("config.mutate"), target: Schema.optionalKey(Schema.Struct({ kind: Schema.Literal("workspace") })), setting: workspaceSettingMutationSchema }),
  Schema.Struct({ type: Schema.Literal("config.mutate"), target: Schema.Struct({ kind: Schema.Literal("profile"), profileId: Schema.NonEmptyString }), setting: profileSettingMutationSchema }),
  Schema.Struct({ type: Schema.Literal("config.mutate"), target: Schema.Struct({ kind: Schema.Literal("project") }), setting: configSettingMutationSchema("showBuild", Schema.Boolean) }),
  Schema.Struct({ type: Schema.Literal("config.reset"), profileId: Schema.NonEmptyString }),
])
export const RuntimeConfigMutationResultSchema: Schema.Codec<RuntimeConfigMutationResult> = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("stale"), message: Schema.Literal("The configuration changed before this update. Try again.") }), Schema.Struct({ kind: Schema.Literal("lock-failed"), message: Schema.Literal("The configuration is busy. Try again.") }),
  Schema.Struct({ kind: Schema.Literal("parse-or-decode-failed"), message: Schema.Literal("The configuration is invalid and was not changed.") }), Schema.Struct({ kind: Schema.Literal("write-not-applied"), message: Schema.Literal("The configuration could not be saved.") }),
  Schema.Struct({ kind: Schema.Literal("write-outcome-unknown"), message: Schema.Literal("Saving the configuration could not be verified. Refresh before trying again.") }),
  Schema.Struct({ kind: Schema.Literal("disposed"), message: Schema.Literal("Configuration updates are unavailable.") }), Schema.Struct({ kind: Schema.Literal("committed"), revision: NonNegativeInt }),
  Schema.Struct({ kind: Schema.Literal("committed-with-durability-warning"), revision: NonNegativeInt, warning: Schema.Literal("The configuration was saved, but publication verification or durability could not be confirmed.") }),
  Schema.Struct({ kind: Schema.Literal("committed-with-degraded-application"), revision: NonNegativeInt, errors: Schema.Tuple([Schema.Literal("A runtime component could not apply the configuration change.")]), durabilityWarning: Schema.optionalKey(Schema.Literal("The configuration was saved, but publication verification or durability could not be confirmed.")) }),
])
