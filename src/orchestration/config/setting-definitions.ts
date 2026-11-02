import { Effect, Schema, SchemaTransformation } from "effect";
import { parseReleaseVersion } from "../../infra/update/version-order.js";
import { isAuthProfileName } from "../../infra/paths.js";
import { TierConfigSchema } from "../../infra/workflow-types.js";
import { CacheRetentionPolicySchema } from "../../infra/llm/provider-options.js";
import { DEFAULT_BUDGET } from "../../workflows/budget.js";
import { MODULE_IDS } from "../../protocol/module-ids.js";
import type { FirstPartyModule } from "../modules.js";
import { installedConfigSections, installedModules } from "../module-catalog.js";
import { settingCatalogRowFor, type SettingCatalogRow } from "../../protocol/setting-catalog.js";
import { DEFAULT_WRITE_SYNTAX_THEME_ID, WRITE_SYNTAX_THEME_IDS, WRITE_SYNTAX_THEME_OPTIONS, WriteSyntaxThemeIdSchema } from "../../protocol/write-syntax-theme.js";

export const DEFAULT_PROACTIVE_COMPACTION_THRESHOLD = 270_000;
export const MIN_PROACTIVE_COMPACTION_THRESHOLD = 50_000;
export const DEFAULT_THEME_SELECTION = "flywheel";
const DEFAULT_FOREGROUND_BASH_HOLD_SECONDS = 240;
const MAX_FOREGROUND_BASH_HOLD_SECONDS = 2_147_483;

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
/** A provider-scoped numeric setting as authored. `false` is the retired
 *  spelling of "off" (0), kept decoding so an existing profile table keeps
 *  its meaning; the writer never writes it again. */
const ProviderSettingValueSchema = Schema.Union([
  NonNegativeInt,
  Schema.Literal(false).pipe(Schema.decodeTo(Schema.Literal(0), SchemaTransformation.transform({ decode: () => 0 as const, encode: () => false as const }))),
]);
const AuthProfileNameSchema = Schema.String.check(Schema.makeFilter((name) => isAuthProfileName(name) || "invalid auth profile name"));
const described = <S extends Schema.Top>(schema: S, description: string) => schema.pipe(Schema.annotate({ description }));
const BudgetConfigSchema = Schema.Struct({
  max_invocations: described(NonNegativeInt.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(DEFAULT_BUDGET.max_invocations))), "Maximum attempts that a workflow can start. Flywheel checks it before each attempt; a running agent always finishes."),
  max_tokens: described(NonNegativeInt.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(DEFAULT_BUDGET.max_tokens))), "Maximum tokens that a workflow can use. Flywheel checks it before each attempt; a running agent always finishes."),
  max_wall_clock_minutes: described(NonNegativeInt.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(DEFAULT_BUDGET.max_wall_clock_minutes))), "Maximum workflow wall-clock minutes, counted from the workflow launch. Flywheel checks it before each attempt; a running agent always finishes."),
}).pipe(Schema.withDecodingDefaultType(Effect.succeed(DEFAULT_BUDGET)));

export type ApplicationMode = "live" | "next-request" | "replace-resource" | "use-time-revalidate" | "next-use";
export interface SettingApplication {
  readonly mode: ApplicationMode;
  readonly path: readonly string[];
}
export type ProtocolExposure = "ui-safe" | "secret";

/** One identity per setting (ARCH-NAMING-009): the definition id keys the store and the
 *  factory table, and this kebab rendering is the settings row's surface id. */
export function settingRowId(definition: { readonly id: string }): string {
  return definition.id.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

interface SettingValueLabels {
  readonly [value: string]: string;
}

/** How a settings row edits the setting. Its name, description, and place
 *  come from the setting catalog (ARCH-PROTOCOL-066), keyed by setting id. */
type SettingPresentation =
  | { readonly kind: "none" }
  | { readonly kind: "simple-boolean"; readonly valueFormat: "yes-no" }
  | {
      readonly kind: "simple-enum";
      readonly values: readonly string[];
      readonly valueLabels?: SettingValueLabels;
      readonly valueFormat: "yes-no" | "title-case";
    }
  | { readonly kind: "validated-edit" }
  | { readonly kind: "custom-row" };

type Scalar = string | number | boolean | readonly number[];
type SettingSchema = Schema.Top;

type PersistedSettingBase = {
  readonly id: string;
  readonly schema: SettingSchema;
  readonly presentation: SettingPresentation;
  readonly applications: readonly [SettingApplication, ...SettingApplication[]];
  readonly protocolExposure: ProtocolExposure;
  readonly seed?: true;
  readonly reset?: Scalar;
};

export type PersistedSettingDefinition =
  | (PersistedSettingBase & { readonly kind: "root-scalar"; readonly ownership: "generated-writer"; readonly path: readonly [string] })
  | (PersistedSettingBase & { readonly kind: "nested-scalar"; readonly ownership: "generated-writer"; readonly path: readonly [string, ...string[]] })
  | (PersistedSettingBase & { readonly kind: "custom-writer"; readonly ownership: "custom-writer"; readonly path: readonly [string, ...string[]] })
  | (PersistedSettingBase & { readonly kind: "runtime-owned"; readonly ownership: "runtime-owned"; readonly path: readonly [string] });


const theme = { kind: "root-scalar", ownership: "generated-writer", id: "theme", path: ["theme"], applications: [{ mode: "live", path: [] }], protocolExposure: "ui-safe", schema: Schema.optionalKey(Schema.String), presentation: { kind: "custom-row" }, reset: DEFAULT_THEME_SELECTION } as const satisfies PersistedSettingDefinition;
const moduleSelection = { kind: "custom-writer", ownership: "custom-writer", id: "moduleSelection", path: ["disabled_modules"], applications: [{ mode: "next-request", path: [] }, { mode: "use-time-revalidate", path: [] }], protocolExposure: "ui-safe", schema: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(MODULE_IDS)), Schema.annotate({ description: "Disable Flywheel modules by canonical module id. Every module is on unless this list names it." })), presentation: { kind: "none" } } as const satisfies PersistedSettingDefinition;
const allowPersistentProcesses = { kind: "root-scalar", ownership: "generated-writer", id: "allowPersistentProcesses", path: ["allow_persistent_processes"], applications: [{ mode: "next-request", path: [] }, { mode: "use-time-revalidate", path: [] }], protocolExposure: "ui-safe", schema: Schema.Boolean.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(false))), presentation: { kind: "custom-row" } } as const satisfies PersistedSettingDefinition;
const foregroundBashHoldSeconds = { kind: "root-scalar", ownership: "generated-writer", id: "foregroundBashHoldSeconds", path: ["foreground_bash_hold_seconds"], applications: [{ mode: "next-request", path: [] }], protocolExposure: "ui-safe", schema: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_FOREGROUND_BASH_HOLD_SECONDS })).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(DEFAULT_FOREGROUND_BASH_HOLD_SECONDS)), Schema.annotate({ description: "Maximum seconds a foreground Bash command can hold the tool call before it transfers to managed execution." })), presentation: { kind: "none" } } as const satisfies PersistedSettingDefinition;
const showThinking = { kind: "root-scalar", ownership: "generated-writer", id: "showThinking", path: ["show_thinking"], applications: [{ mode: "live", path: [] }], protocolExposure: "ui-safe", schema: Schema.Boolean.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(false))), presentation: { kind: "simple-boolean", valueFormat: "yes-no" }, reset: false } as const satisfies PersistedSettingDefinition;
const idleCompaction = { kind: "root-scalar", ownership: "generated-writer", id: "idleCompaction", path: ["idle_compaction"], applications: [{ mode: "live", path: [] }, { mode: "use-time-revalidate", path: [] }], protocolExposure: "ui-safe", schema: Schema.Boolean.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(true))), presentation: { kind: "simple-boolean", valueFormat: "yes-no" }, reset: true } as const satisfies PersistedSettingDefinition;
const writeSyntaxTheme = { kind: "root-scalar", ownership: "generated-writer", id: "writeSyntaxTheme", path: ["write_syntax_theme"], applications: [{ mode: "live", path: [] }], protocolExposure: "ui-safe", schema: WriteSyntaxThemeIdSchema.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(DEFAULT_WRITE_SYNTAX_THEME_ID))), presentation: { kind: "simple-enum", values: WRITE_SYNTAX_THEME_IDS, valueLabels: Object.fromEntries(WRITE_SYNTAX_THEME_OPTIONS.map(({ value, label }) => [value, label])), valueFormat: "title-case" }, reset: DEFAULT_WRITE_SYNTAX_THEME_ID } as const satisfies PersistedSettingDefinition;
const requireWorkflowConfirmation = { kind: "custom-writer", ownership: "custom-writer", id: "requireWorkflowConfirmation", path: ["require_workflow_confirmation"], applications: [{ mode: "use-time-revalidate", path: [] }], protocolExposure: "ui-safe", schema: Schema.Boolean.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(false)), Schema.annotate({ description: "Require confirmation before a workflow starts." })), presentation: { kind: "none" } } as const satisfies PersistedSettingDefinition;
const diffColors = { kind: "root-scalar", ownership: "generated-writer", id: "diffColors", path: ["diff_colors"], applications: [{ mode: "live", path: [] }], protocolExposure: "ui-safe", schema: Schema.Union([Schema.Literal("theme"), Schema.Literal("standard")]).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed("theme" as const))), presentation: { kind: "simple-enum", values: ["theme", "standard"], valueFormat: "yes-no" }, reset: "theme" } as const satisfies PersistedSettingDefinition;
const compatibleRendering = { kind: "root-scalar", ownership: "generated-writer", id: "compatibleRendering", path: ["compatible_rendering"], applications: [{ mode: "live", path: [] }], protocolExposure: "ui-safe", schema: Schema.Union([Schema.Literal("auto"), Schema.Literal("on"), Schema.Literal("off")]).pipe(Schema.withDecodingDefaultType(Effect.succeed("auto" as const))), presentation: { kind: "simple-enum", values: ["auto", "on", "off"], valueFormat: "title-case" }, reset: "auto" } as const satisfies PersistedSettingDefinition;
const webSearchProvider = { kind: "nested-scalar", ownership: "generated-writer", id: "webSearchProvider", path: ["web_search", "provider"], applications: [{ mode: "next-request", path: [] }], protocolExposure: "ui-safe", schema: Schema.Union([Schema.Literal("chatgpt"), Schema.Literal("exa")]).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed("chatgpt" as const))), presentation: { kind: "simple-enum", values: ["chatgpt", "exa"], valueLabels: { chatgpt: "ChatGPT", exa: "Exa" }, valueFormat: "title-case" }, reset: "chatgpt" } as const satisfies PersistedSettingDefinition;
const fontTipDismissed = { kind: "runtime-owned", ownership: "runtime-owned", id: "fontTipDismissed", path: ["font_tip_dismissed"], applications: [{ mode: "live", path: [] }], protocolExposure: "ui-safe", schema: Schema.Boolean.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(false)), Schema.annotate({ description: "Flywheel writes whether the font tip was dismissed. Users must not set this key." })), presentation: { kind: "none" } } as const satisfies PersistedSettingDefinition;
const tabsHintDismissed = { kind: "runtime-owned", ownership: "runtime-owned", id: "tabsHintDismissed", path: ["tabs_hint_dismissed"], applications: [{ mode: "live", path: [] }], protocolExposure: "ui-safe", schema: Schema.Boolean.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(false)), Schema.annotate({ description: "Flywheel writes whether the tabs hint was dismissed. Users must not set this key." })), presentation: { kind: "none" } } as const satisfies PersistedSettingDefinition;
const acknowledgedReleaseVersion = { kind: "runtime-owned", ownership: "runtime-owned", id: "acknowledgedReleaseVersion", path: ["acknowledged_release_version"], applications: [{ mode: "live", path: [] }], protocolExposure: "ui-safe", schema: Schema.optionalKey(described(Schema.String.check(Schema.makeFilter((value) => parseReleaseVersion(value)?.precedence !== undefined || "expected a release version")), "Flywheel writes the release last dismissed in the welcome notice. Users must not set this key.")), presentation: { kind: "none" } } as const satisfies PersistedSettingDefinition;
const proactiveCompactionThreshold = { kind: "root-scalar", ownership: "generated-writer", id: "proactiveCompactionThreshold", path: ["proactive_compaction_threshold"], applications: [{ mode: "next-request", path: [] }], protocolExposure: "ui-safe", schema: Schema.Union([Schema.Literal(0), Schema.Int.check(Schema.isGreaterThanOrEqualTo(MIN_PROACTIVE_COMPACTION_THRESHOLD))]).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(DEFAULT_PROACTIVE_COMPACTION_THRESHOLD))), presentation: { kind: "validated-edit" }, reset: DEFAULT_PROACTIVE_COMPACTION_THRESHOLD } as const satisfies PersistedSettingDefinition;
const autoDeleteSessionDays = { kind: "root-scalar", ownership: "generated-writer", id: "autoDeleteSessionDays", path: ["auto_delete_session_days"], applications: [{ mode: "live", path: [] }], protocolExposure: "ui-safe", schema: NonNegativeInt.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(0))), presentation: { kind: "validated-edit" }, reset: 0 } as const satisfies PersistedSettingDefinition;
const notificationsDesktop = { kind: "nested-scalar", ownership: "generated-writer", id: "notificationsDesktop", path: ["notifications", "desktop"], applications: [{ mode: "live", path: [] }], protocolExposure: "ui-safe", schema: Schema.Boolean.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(true)), Schema.annotate({ description: "Show a desktop notification when a session asks you a question." })), presentation: { kind: "none" }, reset: true } as const satisfies PersistedSettingDefinition;
const autoInstall = { kind: "nested-scalar", ownership: "generated-writer", id: "autoInstall", path: ["updates", "auto_install"], applications: [{ mode: "live", path: [] }, { mode: "use-time-revalidate", path: [] }], protocolExposure: "ui-safe", schema: Schema.Boolean.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(true))), presentation: { kind: "custom-row" }, seed: true } as const satisfies PersistedSettingDefinition;

const persistedSettingDefinitions = [theme, moduleSelection, allowPersistentProcesses, foregroundBashHoldSeconds, showThinking, idleCompaction, writeSyntaxTheme, requireWorkflowConfirmation, diffColors, compatibleRendering, webSearchProvider, fontTipDismissed, tabsHintDismissed, acknowledgedReleaseVersion, proactiveCompactionThreshold, autoDeleteSessionDays, autoInstall, notificationsDesktop ] as const satisfies readonly PersistedSettingDefinition[];
export const PERSISTED_SETTING_DEFINITIONS: readonly PersistedSettingDefinition[] = persistedSettingDefinitions;
export type PersistedSettingId = (typeof persistedSettingDefinitions)[number]["id"];

export function isPersistedSettingId(id: string): id is PersistedSettingId {
  return persistedSettingDefinitions.some((definition) => definition.id === id);
}

/** Ids of the settings a Settings row presents. */
export type PresentedSettingId = Exclude<(typeof persistedSettingDefinitions)[number], { readonly presentation: { readonly kind: "none" } }>["id"];

export function isPresentedSettingId(id: string): id is PresentedSettingId {
  return persistedSettingDefinitions.some((definition) => definition.id === id && definition.presentation.kind !== "none");
}

/** The catalog row that names, describes, and places a presented setting. A
 *  presented setting the catalog has no row for does not compile here. */
export function presentedSettingRow(id: PresentedSettingId): SettingCatalogRow {
  return settingCatalogRowFor(id);
}

export function persistedSettingDefinition(id: string): PersistedSettingDefinition {
  const definition = persistedSettingDefinitions.find((candidate) => candidate.id === id);
  if (definition === undefined) throw new Error(`Unknown persisted setting: ${id}`);
  return definition;
}

/** The definitions a plain cycle row edits, keyed by id. */
export const SIMPLE_SETTING_DEFINITIONS = { showThinking, idleCompaction, writeSyntaxTheme, diffColors, compatibleRendering, webSearchProvider } as const satisfies { readonly [K in PresentedSettingId]?: PersistedSettingDefinition & { readonly id: K; readonly presentation: { readonly kind: "simple-boolean" | "simple-enum" } } };

type DefinitionOwnedRootField = (typeof persistedSettingDefinitions)[number]["path"][0] extends infer AuthoredRoot
  ? AuthoredRoot extends "disabled_modules" ? "modules" : AuthoredRoot
  : never;
type DefinitionOwnedRootFields = { readonly [K in DefinitionOwnedRootField]: SettingSchema };

const autoInstallPath = ["updates", "auto_install"] as const satisfies typeof autoInstall.path;
const notificationsDesktopPath = ["notifications", "desktop"] as const satisfies typeof notificationsDesktop.path;
const webSearchProviderPath = ["web_search", "provider"] as const satisfies typeof webSearchProvider.path;

export const DEFINITION_OWNED_SCHEMA_FIELDS = {
  theme: theme.schema,
  modules: moduleSelection.schema,
  allow_persistent_processes: allowPersistentProcesses.schema,
  foreground_bash_hold_seconds: foregroundBashHoldSeconds.schema,
  show_thinking: showThinking.schema,
  idle_compaction: idleCompaction.schema,
  write_syntax_theme: writeSyntaxTheme.schema,
  require_workflow_confirmation: requireWorkflowConfirmation.schema,
  diff_colors: diffColors.schema,
  compatible_rendering: compatibleRendering.schema,
  font_tip_dismissed: fontTipDismissed.schema,
  tabs_hint_dismissed: tabsHintDismissed.schema,
  acknowledged_release_version: acknowledgedReleaseVersion.schema,
  proactive_compaction_threshold: proactiveCompactionThreshold.schema,
  auto_delete_session_days: autoDeleteSessionDays.schema,
  [autoInstallPath[0]]: Schema.Struct({ [autoInstallPath[1]]: autoInstall.schema }).pipe(Schema.withDecodingDefaultType(Effect.succeed({ [autoInstallPath[1]]: true }))),
  [webSearchProviderPath[0]]: Schema.Struct({ [webSearchProviderPath[1]]: webSearchProvider.schema }).pipe(Schema.withDecodingDefaultType(Effect.succeed({ [webSearchProviderPath[1]]: "chatgpt" as const }))),
  [notificationsDesktopPath[0]]: Schema.Struct({ [notificationsDesktopPath[1]]: notificationsDesktop.schema }).pipe(Schema.withDecodingDefaultType(Effect.succeed({ [notificationsDesktopPath[1]]: true }))),
} as const satisfies DefinitionOwnedRootFields;

const retained = <K extends string, S extends SettingSchema>(key: K, schema: S, owner: string, applications: readonly [SettingApplication, ...SettingApplication[]], protocolExposure: ProtocolExposure) => ({ kind: "retained-section" as const, id: key, key, schema, owner, applications, protocolExposure, presentation: { kind: "none" as const } });
const PROFILE_BOOLEAN_SETTING_DEFINITIONS = {
  gitAiAttribution: { key: "git_ai_attribution", defaultValue: false },
  allowTrainingRoutes: { key: "allow_training_routes", defaultValue: false },
} as const;
export const PROJECT_SHOW_BUILD_DEFAULT = false;
export type ProfileBooleanSettingId = keyof typeof PROFILE_BOOLEAN_SETTING_DEFINITIONS;
export type ProfileBooleanSettingDefinition = (typeof PROFILE_BOOLEAN_SETTING_DEFINITIONS)[ProfileBooleanSettingId];

export function profileBooleanSettingDefinition(id: ProfileBooleanSettingId): ProfileBooleanSettingDefinition {
  return PROFILE_BOOLEAN_SETTING_DEFINITIONS[id];
}
// Keyed by section name so adding or removing a section never re-indexes the
// schema-fields map below; positional indexing broke silently three times.
const RETAINED_CONFIG_SECTIONS = {
  cache_retention: retained("cache_retention", described(Schema.Record(Schema.String, CacheRetentionPolicySchema).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed({})), Schema.annotate({ exampleKey: "openai_api" })), "Prompt-cache retention keyed by API provider id. Omitted entries preserve existing defaults; provider selects the provider-managed policy."), "provider cache policy", [{ mode: "next-request", path: [] }], "ui-safe"),
  profiles: retained("profiles", described(Schema.Record(Schema.String, Schema.Struct({ git_ai_attribution: described(Schema.Boolean.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(PROFILE_BOOLEAN_SETTING_DEFINITIONS.gitAiAttribution.defaultValue))), "Add AI attribution to Git commits created for this profile."), allow_training_routes: described(Schema.Boolean.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(PROFILE_BOOLEAN_SETTING_DEFINITIONS.allowTrainingRoutes.defaultValue))), "Allow model routes that may use requests for training for this profile."), roles: described(Schema.Record(Schema.String, TierConfigSchema).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed({})), Schema.annotate({ exampleKey: "review role" })), "Role overrides keyed by user-defined role name."), providers: described(Schema.Record(Schema.String, described(Schema.Record(Schema.String, ProviderSettingValueSchema), "Numeric settings the provider module declares, keyed by setting.")).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed({})), Schema.annotate({ exampleKey: "provider id" })), "Provider-scoped settings keyed by provider id; each provider module declares its keys and defaults.") })).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed({})), Schema.annotate({ exampleKey: "work" })), "Auth profile overlays keyed by profile name."), "auth profile overlays", [{ mode: "next-request", path: [] }], "ui-safe"),
  keybindings: retained("keybindings", described(Schema.Record(Schema.String, Schema.String.pipe(Schema.annotate({ exampleValue: "ctrl+g" }))).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed({})), Schema.annotate({ exampleKey: "help" })), "Key chords of TUI commands keyed by command id, such as help = \"ctrl+g\". keys.md lists the command ids."), "TUI keymap", [{ mode: "live", path: [] }], "ui-safe"),
  budget: retained("budget", BudgetConfigSchema, "workflow budget", [{ mode: "next-request", path: [] }], "ui-safe"),
  workflow: retained("workflow", Schema.Struct({ max_attempts: described(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1000 })).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(50))), "The most attempts that one workflow run can make, when its file declares no guardrails.max_attempts.") }).pipe(Schema.withDecodingDefaultType(Effect.succeed({ max_attempts: 50 }))), "workflow", [{ mode: "next-request", path: [] }], "ui-safe"),
  auth: retained("auth", Schema.Struct({ project_profiles: described(Schema.Record(Schema.String, AuthProfileNameSchema).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed({})), Schema.annotate({ exampleKey: "/workspace/project" })), "Auth profiles keyed by canonical project root.") }).pipe(Schema.withDecodingDefaultType(Effect.succeed({ project_profiles: {} }))), "auth project bindings", [{ mode: "replace-resource", path: [] }], "secret"),
  projects: retained("projects", described(Schema.Record(Schema.String, Schema.Struct({ show_build: described(Schema.Boolean.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(PROJECT_SHOW_BUILD_DEFAULT))), "Show the build on this project's cards.") })).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed({})), Schema.annotate({ exampleKey: "/workspace/project" })), "Project settings keyed by canonical project root."), "project settings", [{ mode: "live", path: [] }], "ui-safe"),
  custom_providers: retained("custom_providers", described(Schema.Record(Schema.String, Schema.Struct({
    base_url: described(Schema.NonEmptyString, "Base URL of the custom provider."),
    models: described(Schema.Array(Schema.NonEmptyString).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed([]))), "Model ids served by the custom provider."),
    display_name: Schema.optionalKey(described(Schema.NonEmptyString, "Display name of the custom provider.")),
    catalog_id: Schema.optionalKey(described(Schema.NonEmptyString, "Catalog id used for model metadata.")),
    context_limit: Schema.optionalKey(described(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)), "Context token limit for this provider.")),
  })).pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed({})), Schema.annotate({ exampleKey: "acme" })), "Custom providers keyed by user-defined provider id."), "custom model providers", [{ mode: "replace-resource", path: [] }], "secret"),
} as const;

export const RETAINED_CONFIG_SECTION_DEFINITIONS = Object.values(RETAINED_CONFIG_SECTIONS);

export const RETAINED_CONFIG_SCHEMA_FIELDS = {
  cache_retention: RETAINED_CONFIG_SECTIONS.cache_retention.schema,
  profiles: RETAINED_CONFIG_SECTIONS.profiles.schema,
  keybindings: RETAINED_CONFIG_SECTIONS.keybindings.schema,
  budget: RETAINED_CONFIG_SECTIONS.budget.schema,
  workflow: RETAINED_CONFIG_SECTIONS.workflow.schema,
  auth: RETAINED_CONFIG_SECTIONS.auth.schema,
  projects: RETAINED_CONFIG_SECTIONS.projects.schema,
  custom_providers: RETAINED_CONFIG_SECTIONS.custom_providers.schema,
} as const;

/** The kernel's own definitions: every persisted setting and every retained section the kernel owns. */
const KERNEL_SETTING_DEFINITIONS = [...persistedSettingDefinitions, ...RETAINED_CONFIG_SECTION_DEFINITIONS] as const;
export type SettingDefinitionId = (typeof KERNEL_SETTING_DEFINITIONS)[number]["id"];
export type SettingDefinition = (typeof KERNEL_SETTING_DEFINITIONS)[number] | ReturnType<typeof retained<string, SettingSchema>>;

function composeSettingDefinitions(modules: readonly FirstPartyModule[]): readonly SettingDefinition[] {
  return [...KERNEL_SETTING_DEFINITIONS, ...installedConfigSections(modules).map((section) => retained(section.key, section.schema, section.owner, section.applications, section.protocolExposure))];
}

let installedSettingDefinitions: readonly SettingDefinition[] | undefined;

/** Every setting definition in force: the kernel's, then one retained section
 *  per config contribution of the installed catalog. Composed on first read
 *  rather than at load, because the catalog locks on its first read and a
 *  source run installs the development catalog after this module loads. A
 *  catalog other than the installed one is a test's. */
export function settingDefinitions(modules?: readonly FirstPartyModule[]): readonly SettingDefinition[] {
  if (modules) return composeSettingDefinitions(modules);
  installedSettingDefinitions ??= composeSettingDefinitions(installedModules());
  return installedSettingDefinitions;
}

export const MODAL_SETTINGS_DEFAULTS = {
  showThinking: showThinking.reset,
  idleCompaction: idleCompaction.reset,
  writeSyntaxTheme: writeSyntaxTheme.reset,
  diffColors: diffColors.reset,
  compatibleRendering: compatibleRendering.reset,
  webSearchProvider: webSearchProvider.reset,
  proactiveCompactionThreshold: proactiveCompactionThreshold.reset,
  autoDeleteSessionDays: autoDeleteSessionDays.reset,
} as const;
