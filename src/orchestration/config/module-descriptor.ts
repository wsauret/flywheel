import { effectiveModuleIds, installedModules, installedRetiredModuleConfig, moduleSelectionVocabulary, selectionPolicyError, type ModuleId } from "../module-catalog.js";
import { composeFirstPartyModules } from "../module-composition.js";
import type { WorkflowsMode } from "../../protocol/runtime/module-protocol-types.js";

import { canonicalModuleIds, EMPTY_MODULE_IDS, MODULE_IDS } from "../../protocol/runtime/module-ids.js";
import type { ConfigReadResult } from "./config-file.js";

interface ParsedHarnessConfig extends UnknownRecord {
  readonly modules?: unknown;
  readonly capability_modules?: unknown; // retired spelling
  readonly disabled_modules?: unknown;
  readonly enabled_modules?: unknown;
  readonly features?: unknown;
  readonly require_workflow_confirmation?: unknown;
}

interface UnknownRecord {
  readonly [key: string]: unknown;
}

/** One complete decoding of the module decisions stated by one config read. */
export interface ModuleState {
  readonly capabilities: readonly ModuleId[];
  readonly moduleIds: readonly ModuleId[];
  readonly requireWorkflowConfirmation: boolean;
  readonly workflowsMode: WorkflowsMode;
  readonly error?: string;
  /** Closed semantic identity used for compare-and-swap. It contains no authored config values. */
  readonly identity: string;
}

interface DecodedModuleState extends ModuleState {
  readonly warnings: readonly string[];
}

/** Decode the complete module descriptor without retaining source text or authored invalid values. */
export function decodeModuleState(text: string): DecodedModuleState {
  const parsed = parseModuleDocument(text);
  if (parsed === "unparseable") return invalidDescriptor({ parseError: sourceIdentity(text) }, true, "flywheel.toml cannot be parsed");
  if (parsed === "not-a-table") return invalidDescriptor({}, true, "flywheel.toml must contain a TOML table");
  return decodeModuleSelection(parsed);
}

/** The module decisions one read of the file states, or `undefined` when the
 *  read states none: the file is refused, unreadable, or not a TOML table.
 *  That is a fault of the whole document, which the runtime config status
 *  reports, so the selection in force stays as it is. */
export function observeModuleState(read: ConfigReadResult): ModuleState | undefined {
  if (read.kind === "failure") return undefined;
  const parsed = parseModuleDocument(read.kind === "text" ? read.text : "");
  return typeof parsed === "string" ? undefined : decodeModuleSelection(parsed);
}

/** What a file that states no module decision selects: default modules only. */
export function defaultModuleState(): ModuleState {
  return decodeModuleSelection({});
}

function parseModuleDocument(text: string): ParsedHarnessConfig | "unparseable" | "not-a-table" {
  try {
    const value: unknown = text.length === 0 ? {} : Bun.TOML.parse(text);
    return isRecord(value) ? value : "not-a-table";
  } catch {
    return "unparseable";
  }
}

/** Decode module-selection semantics from a parsed config without changing it.
 * Invalid input carries its error and the default selection; live owners retain
 * their last valid selection instead. Retired opt-outs require migration. */
export function decodeModuleSelection(parsed: ParsedHarnessConfig): DecodedModuleState {
  // A workflow starts without a question unless the person turns confirmation on.
  const requireWorkflowConfirmation = parsed.require_workflow_confirmation === true;
  const retired = installedRetiredModuleConfig().map((setting) => ({ setting, state: statedRetiredOptOut(parsed, setting) }));
  const identityInput = {
    modules: parsed.modules,
    capabilityModules: parsed.capability_modules, // retired spelling
    disabledModules: parsed.disabled_modules,
    enabledModules: parsed.enabled_modules,
    features: parsed.features,
    requireWorkflowConfirmation,
    retired,
  };
  const pending = retired.find(({ state }) => state !== "absent");
  if (pending) {
    const field = `${pending.setting.section}.${pending.setting.key}`;
    const reason = pending.state === "invalid" ? "expected a Boolean" : "requires migration or removal";
    return invalidDescriptor(identityInput, requireWorkflowConfirmation, `flywheel.toml ${field} ${reason}`);
  }
  const hasFeatures = Object.hasOwn(parsed, "features");
  const hasModules = Object.hasOwn(parsed, "modules") || Object.hasOwn(parsed, "capability_modules"); // retired spelling
  const hasDisabled = Object.hasOwn(parsed, "disabled_modules");
  if (hasFeatures && hasModules) return invalidDescriptor(identityInput, requireWorkflowConfirmation, 'flywheel.toml cannot state both "modules" and legacy "features"');
  if (hasFeatures && hasDisabled) return invalidDescriptor(identityInput, requireWorkflowConfirmation, 'flywheel.toml cannot state both "disabled_modules" and legacy "features"');
  if (hasFeatures && Object.hasOwn(parsed, "enabled_modules")) return invalidDescriptor(identityInput, requireWorkflowConfirmation, 'flywheel.toml cannot state both "enabled_modules" and legacy "features"');

  // The key the person wrote, so an error names what they can find in the file.
  const statedField = hasFeatures ? "features" : (["disabled_modules", "enabled_modules", "capability_modules"] as const).find((key) => Object.hasOwn(parsed, key)) ?? "modules"; // retired spellings
  const normalized = hasFeatures ? migrateLegacyCapabilityModules(parsed.features) : moduleSelectionFromConfig(parsed);
  if (!normalized.ok) return invalidDescriptor(identityInput, requireWorkflowConfirmation, selectionError(statedField, normalized.error));
  const conflict = selectionPolicyError(normalized.moduleIds, { requireWorkflowConfirmation });
  if (conflict) return invalidDescriptor(identityInput, requireWorkflowConfirmation, selectionError(statedField, conflict));
  const effective = effectiveModuleIds(normalized.moduleIds);
  const capabilities = MODULE_IDS.filter((capability) => effective.includes(capability));
  return Object.freeze({ ...moduleDescriptor(capabilities, normalized.moduleIds, requireWorkflowConfirmation), warnings: normalized.warnings });
}

export function moduleDescriptor(
  capabilities: readonly ModuleId[],
  moduleIds: readonly ModuleId[],
  requireWorkflowConfirmation: boolean,
  error?: string,
  identity?: string,
): ModuleState {
  const canonical = canonicalModuleIds(capabilities);
  return Object.freeze({
    capabilities: Object.freeze([...canonical]),
    moduleIds: Object.freeze([...moduleIds]),
    requireWorkflowConfirmation,
    workflowsMode: workflowsModeOf(canonical, requireWorkflowConfirmation),
    ...(error === undefined ? {} : { error }),
    identity: identity ?? `valid:${moduleIds.join("+")}|${requireWorkflowConfirmation ? "confirm" : "auto"}`,
  });
}

function invalidDescriptor(value: unknown, requireWorkflowConfirmation: boolean, error: string): DecodedModuleState {
  return Object.freeze({ ...moduleDescriptor(MODULE_IDS, MODULE_IDS, requireWorkflowConfirmation, error, `invalid:${new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex")}`), warnings: Object.freeze([]) });
}

/** What a parsed document states about one installed module's retired opt-out. */
export function statedRetiredOptOut(parsed: unknown, setting: ReturnType<typeof installedRetiredModuleConfig>[number]): "enabled" | "disabled" | "absent" | "invalid" {
  if (!isRecord(parsed)) return "absent";
  const section = parsed[setting.section];
  if (section === undefined) return "absent";
  if (!isRecord(section)) return "invalid";
  if (!Object.hasOwn(section, setting.key)) return "absent";
  const value = section[setting.key];
  if (typeof value !== "boolean") return "invalid";
  return value ? "enabled" : "disabled";
}

function sourceIdentity(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

/** What is wrong with the stated selection. It names only the problem: what
 *  stays in force meanwhile depends on what came before, which only the live
 *  owner knows. */
function selectionError(field: string, error: string): string {
  const unknown = /^Unknown (disabled_modules|module) id\(s\): (.*)$/u.exec(error);
  if (unknown?.[2] !== undefined) {
    const ids = unknown[2].split(", ");
    return `flywheel.toml ${unknown[1] === "module" ? field : unknown[1]} contains unknown ${ids.length === 1 ? "id" : "ids"} ${ids.map((id) => `"${id}"`).join(", ")}`;
  }
  return `flywheel.toml ${field} is invalid: ${error.replace(/\.$/u, "")}`;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const MODULE_ID_SET: ReadonlySet<string> = new Set(MODULE_IDS)

function canonicalModuleIdSpelling(id: string): string {
  return moduleSelectionVocabulary().retiredSpellings.get(id) ?? id
}

export function workflowsModeOf(selected: readonly ModuleId[], confirmationRequired: boolean): WorkflowsMode {
  if (!selected.includes(moduleSelectionVocabulary().workflowsModuleId)) return "off"
  return confirmationRequired ? "ask" : "on"
}

export const MODULE_PRESETS = {
  minimal: { moduleIds: EMPTY_MODULE_IDS, workflowsMode: "off" },
  full: { moduleIds: MODULE_IDS, workflowsMode: "on" },
} as const


export type ModuleSelection =
  | { readonly ok: true; readonly moduleIds: readonly ModuleId[]; readonly warnings: readonly string[] }
  | { readonly ok: false; readonly error: string }

/** Decodes an external module selection against the wire vocabulary. */
export function normalizeModuleSelection(value: unknown): ModuleSelection {
  if (value === undefined) return selectedCapabilityModules(MODULE_IDS)
  if (!Array.isArray(value)) return { ok: false, error: 'Invalid config value "modules": expected an array of registered module ids' }
  if (!value.every((member) => typeof member === "string")) return { ok: false, error: 'Invalid config value "modules": every member must be a registered module id' }
  const selected = new Set(value.map(canonicalModuleIdSpelling))
  const unknown = [...selected].filter((id) => !MODULE_ID_SET.has(id)).sort()
  if (unknown.length > 0) return { ok: false, error: `Unknown module id(s): ${unknown.join(", ")}` }
  return selectedCapabilityModules(MODULE_IDS.filter((id) => selected.has(id)))
}

/** The id of the retired add-on that let agents write workflows; the workflows module absorbed it. */
const RETIRED_WORKFLOWS_ADD_ON = "adhoc-workflows"

/** The persisted opt-out list: the default-on modules that the person turned off. */
function persistedDisabledModules(value: unknown): ModuleSelection {
  if (value === undefined) return { ok: true, moduleIds: [], warnings: [] }
  if (!Array.isArray(value)) return { ok: false, error: 'Invalid config value "disabled_modules": expected an array of registered module ids' }
  if (!value.every((member) => typeof member === "string")) return { ok: false, error: 'Invalid config value "disabled_modules": every member must be a registered module id' }
  // The opt-out of the retired add-on module becomes Workflows Off. Remove after 2027-04-30.
  const converted = value.includes(RETIRED_WORKFLOWS_ADD_ON)
  const workflows = moduleSelectionVocabulary().workflowsModuleId
  const members = new Set(value.map((id) => canonicalModuleIdSpelling(id === RETIRED_WORKFLOWS_ADD_ON ? workflows : id)))
  const unknown = [...members].filter((id) => !MODULE_ID_SET.has(id)).sort()
  if (unknown.length > 0) return { ok: false, error: `Unknown disabled_modules id(s): ${unknown.join(", ")}` }
  return { ok: true, moduleIds: MODULE_IDS.filter((id) => members.has(id)), warnings: converted ? [`flywheel.toml disabled_modules names "${RETIRED_WORKFLOWS_ADD_ON}", the retired Ad hoc workflows module. Flywheel reads it as "${workflows}", so Workflows is Off. The next settings change writes "${workflows}" in its place.`] : [] }
}

/** The modules that the retired `enabled_modules` list could name: the opt-in modules there were, each of which is
 *  now either on by default (`provider-claude-agent-sdk`) or replaced by one that is (`provider-claude-subscription`,
 *  replaced by the Agent SDK provider). Every module is on by default now, so such a list states the default
 *  selection. A read takes it as no difference, and startup and the next selection write remove it. Any other value
 *  is invalid, as it was. Remove the conversion after 2027-04-08. */
const RETIRED_ENABLED_MODULES_ERROR = 'Invalid config value "enabled_modules": every module is on unless disabled_modules names it, so remove enabled_modules'

/** Decodes one parsed config's sole module-selection authority. */
export function moduleSelectionFromConfig(parsed: {
  readonly modules?: unknown
  readonly capability_modules?: unknown // retired spelling of modules; remove the conversion after 2026-12-18
  readonly disabled_modules?: unknown
  readonly enabled_modules?: unknown
}): ModuleSelection {
  const hasDisabled = Object.hasOwn(parsed, "disabled_modules")
  const hasModules = Object.hasOwn(parsed, "modules")
  const hasCapabilityModules = Object.hasOwn(parsed, "capability_modules")
  if (hasDisabled && (hasModules || hasCapabilityModules)) return { ok: false, error: 'Cannot state both "disabled_modules" and a retired spelling ("modules" or "capability_modules")' }
  if (Object.hasOwn(parsed, "enabled_modules") && (hasModules || hasCapabilityModules)) return { ok: false, error: 'Cannot state "enabled_modules" with a retired spelling ("modules" or "capability_modules")' }
  if (hasModules || hasCapabilityModules) {
    const migrated = migrateModuleSelection(hasModules ? parsed.modules : parsed.capability_modules) // retired spelling
    if (!migrated.ok) return migrated
    return selectedCapabilityModules(canonicalModuleIds([...migrated.moduleIds, ...moduleSelectionVocabulary().enabledSinceModulesSnapshot]))
  }
  const disabled = persistedDisabledModules(parsed.disabled_modules)
  if (!disabled.ok) return disabled
  const enabled = parsed.enabled_modules
  if (enabled !== undefined && !(Array.isArray(enabled) && enabled.every((id) => typeof id === "string" && moduleSelectionVocabulary().retiredOptInModuleIds.has(id)))) return { ok: false, error: RETIRED_ENABLED_MODULES_ERROR }
  return selectedCapabilityModules(MODULE_IDS.filter((id) => !disabled.moduleIds.includes(id)), disabled.warnings)
}

/** Expands retired aggregate IDs only when the complete selection is otherwise valid. */
function migrateModuleSelection(value: unknown): ModuleSelection {
  if (!Array.isArray(value) || !value.every((member) => typeof member === "string")) {
    return { ok: false, error: 'Invalid config value "modules": every member must be a registered or retired module id' }
  }
  const { retiredExpansions } = moduleSelectionVocabulary()
  const expanded = value.map(canonicalModuleIdSpelling).flatMap((id): readonly string[] => {
    if (MODULE_ID_SET.has(id)) return [id]
    return retiredExpansions.get(id) ?? []
  })
  const unknown = value.map(canonicalModuleIdSpelling).filter((id) => !MODULE_ID_SET.has(id) && !retiredExpansions.has(id))
  if (unknown.length > 0) return { ok: false, error: `Unknown module id(s): ${[...new Set(unknown)].sort().join(", ")}` }
  const selected = new Set(expanded)
  return selectedCapabilityModules(MODULE_IDS.filter((id) => selected.has(id)))
}

/** Converts the retired five-choice selection without changing any former core module. */
export function migrateLegacyCapabilityModules(value: unknown): ModuleSelection {
  const { legacyFeatureTokens } = moduleSelectionVocabulary()
  const tokens = new Set(legacyFeatureTokens.values())
  if (!Array.isArray(value) || !value.every((member) => typeof member === "string" && tokens.has(member))) {
    return { ok: false, error: 'Invalid legacy config value "features": expected only workflows, skills, subagents, learning, and background_commands' }
  }
  const selectedLegacy = new Set(value)
  // The features vocabulary predates the kebab module ids: a module maps back
  // to its features token before membership decides whether it stays on.
  return selectedCapabilityModules(MODULE_IDS.filter((id) => {
    const token = legacyFeatureTokens.get(id)
    return token === undefined || selectedLegacy.has(token)
  }))
}

function selectedCapabilityModules(moduleIds: readonly ModuleId[], warnings: readonly string[] = []): ModuleSelection {
  try {
    const selected = new Set(moduleIds)
    composeFirstPartyModules(installedModules(), MODULE_IDS.filter((id) => !selected.has(id)))
    return { ok: true, moduleIds: Object.freeze([...moduleIds]), warnings: Object.freeze([...warnings]) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
