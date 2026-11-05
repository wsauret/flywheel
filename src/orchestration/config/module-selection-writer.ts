import { configLines, findFieldIndex, findSectionEnd, keyPattern, removeAssignment, removeSection, rootEndIndex, sectionHasKeyLines } from "./config-assignment.js";
import { installedRetiredModuleConfig, MODULE_PRESETS, migrateLegacyCapabilityModules, moduleIdForSettingControl, moduleSelectionFromConfig, normalizeModuleSelection, selectionPolicyError, workflowsModeOf, type ModuleId } from "../modules.js";
import type { WorkflowsMode } from "../../protocol/module-protocol-types.js";
import { decodeModuleState, statedRetiredOptOut } from "./module-descriptor.js";
import { ConfigStaleWriteError, ConfigWriteError, patchRootField, updateConfigTextAwaited, type ConfigWriteResult, type UpdateModelSelectionOptions } from "./writer.js";

import { MODULE_IDS, persistedDisabledModuleIds } from "../../protocol/module-ids.js";
type UnknownObject = { [K in string]: unknown };

/** Add or remove one catalog module without restating the rest of the selection.
 *
 * The stated selection is re-read inside the ownership window, so concurrent
 * member changes cannot lose each other. Invalid bytes are refused unchanged;
 * only an explicit complete Full or Minimal replacement can repair them.
 * Refusal leaves the file unchanged and returns a failed ConfigWriteResult. */
export async function updateModuleMember(moduleId: ModuleId, expected: boolean, enabled: boolean, options: UpdateModelSelectionOptions): Promise<ConfigWriteResult> {
  return await updateConfigTextAwaited((source) => {
    const members = new Set(statedModuleSelection(source));
    if (members.has(moduleId) !== expected) throw new ConfigStaleWriteError();
    // A module that depends on this one stays selected and is off until
    // this one is on again (ARCH-STRUCTURE-025).
    if (enabled) members.add(moduleId);
    else members.delete(moduleId);
    assertExecutableWorkflowSelection(members, workflowConfirmationRequired(source));
    return patchModuleSelection(source, refusedOrCanonicalModules(members));
  }, options);
}

/** The Workflows control and its durable confirmation preference, changed as one
 *  commit (PI-CAP-019, PI-CAP-001). OFF removes the capability and leaves the recorded
 *  confirmation preference untouched, so returning to ASK or ON restores what
 *  the user chose. */
export async function updateWorkflowsMode(expected: WorkflowsMode, mode: WorkflowsMode, options: UpdateModelSelectionOptions): Promise<ConfigWriteResult> {
  return await updateConfigTextAwaited((source) => {
    const members = new Set(statedModuleSelection(source));
    if (workflowsModeOf([...members], workflowConfirmationRequired(source)) !== expected) throw new ConfigStaleWriteError();
    const moduleId = moduleIdForSettingControl("workflow-mode");
    if (mode === "off") {
      members.delete(moduleId);
      return patchModuleSelection(source, refusedOrCanonicalModules(members));
    }
    members.add(moduleId);
    if (mode === "ask") assertExecutableWorkflowSelection(members, true);
    const selection = refusedOrCanonicalModules(members);
    return patchRootField(patchModuleSelection(source, selection), "require_workflow_confirmation", mode === "ask");
  }, options);
}

/** Reads the persisted module selection. Invalid external state is never repaired by a settings mutation. */
function statedModuleSelection(source: string): readonly ModuleId[] {
  const parsed: unknown = source.length === 0 ? {} : Bun.TOML.parse(source);
  if (!isRecord(parsed)) throw new ConfigWriteError("flywheel.toml must contain a TOML table");
  if (Object.hasOwn(parsed, "features")) throw new ConfigWriteError('legacy "features" must migrate before capability settings can change');
  const normalized = moduleSelectionFromConfig(parsed);
  if (!normalized.ok) throw new ConfigWriteError(normalized.error);
  return normalized.moduleIds;
}

/** Write the opt-out list and drop retired spellings and the retired opt-in list atomically. */
function patchModuleSelection(source: string, selection: readonly ModuleId[]): string {
  const disabled = persistedDisabledModuleIds(selection);
  let patched = disabled.length === 0
    ? removeRootAssignmentIfPresent(source, "disabled_modules")
    : patchRootField(source, "disabled_modules", disabled);
  for (const field of ["modules", "capability_modules", "enabled_modules"]) patched = removeRootAssignmentIfPresent(patched, field);
  return patched;
}

function removeRootAssignmentIfPresent(source: string, field: string): string {
  return Object.hasOwn(parseConfigTable(source), field) ? removeRootAssignment(source, field) : source;
}

function refusedOrCanonicalModules(members: Iterable<ModuleId>): readonly ModuleId[] {
  const selected = new Set(members);
  const normalized = normalizeModuleSelection(MODULE_IDS.filter((id) => selected.has(id)));
  if (!normalized.ok) throw new ConfigWriteError(normalized.error);
  return normalized.moduleIds;
}

function parseConfigTable(source: string): UnknownObject {
  const parsed: unknown = source.length === 0 ? {} : Bun.TOML.parse(source);
  if (!isRecord(parsed)) throw new ConfigWriteError("flywheel.toml must contain a TOML table");
  return parsed;
}

/** Replace the complete optional-capability selection (PI-CAP-005). Ids are written
 *  in canonical order, so selecting the same set twice leaves the file
 *  byte-identical, and an invalid dependency is refused before the file is
 *  touched. */
export async function updateCapabilityModules(
  capabilities: readonly ModuleId[],
  options: UpdateModelSelectionOptions,
): Promise<ConfigWriteResult> {
  const selected = new Set(MODULE_IDS);
  for (const capability of MODULE_IDS) {
    if (!capabilities.includes(capability)) selected.delete(capability);
  }
  const selection = refusedOrCanonicalModules(selected);
  return await updateConfigTextAwaited((source) => {
    // Invalid bytes are refused unchanged, as by a member write.
    statedModuleSelection(source);
    assertExecutableWorkflowSelection(selection, workflowConfirmationRequired(source));
    return patchModuleSelection(source, selection);
  }, options);
}


function assertExecutableWorkflowSelection(moduleIds: Iterable<ModuleId>, requireWorkflowConfirmation: boolean): void {
  const conflict = selectionPolicyError([...moduleIds], { requireWorkflowConfirmation });
  if (conflict) throw new ConfigWriteError(conflict);
}

function workflowConfirmationRequired(source: string): boolean {
  const parsed = parseConfigTable(source);
  return parsed.require_workflow_confirmation === true;
}

export async function updatePersistentProcessPermission(expected: boolean, enabled: boolean, options: UpdateModelSelectionOptions): Promise<ConfigWriteResult> {
  return await updateConfigTextAwaited((source) => {
    const parsed = parseConfigTable(source);
    const current = parsed.allow_persistent_processes === true;
    if (current !== expected) throw new ConfigStaleWriteError();
    return patchRootField(source, "allow_persistent_processes", enabled);
  }, options);
}

/** Apply a named preset as one complete catalog replacement. Full selects every
 * module and sets Workflows to On, with no launch confirmation. Minimal selects no
 * module. Invalid current bytes are repairable only through this explicit,
 * complete replacement. */
export async function applyModulePreset(
  preset: keyof typeof MODULE_PRESETS,
  expected: { readonly descriptorIdentity: string },
  options: UpdateModelSelectionOptions,
): Promise<ConfigWriteResult> {
  return await updateConfigTextAwaited((source) => {
    const current = decodeModuleState(source);
    if (current.identity !== expected.descriptorIdentity) throw new ConfigStaleWriteError();
    const selection = preset === "full" ? MODULE_IDS : [];
    const parsed = parseConfigTable(source);
    const hasRetiredSelection = Object.hasOwn(parsed, "modules") || Object.hasOwn(parsed, "capability_modules");
    const hasDisabledSelection = Object.hasOwn(parsed, "disabled_modules");
    const hasLegacyFeatures = Object.hasOwn(parsed, "features");
    if (hasRetiredSelection && hasLegacyFeatures) throw new ConfigWriteError('flywheel.toml cannot state both "modules" and legacy "features"');
    if (hasDisabledSelection && hasRetiredSelection) throw new ConfigWriteError('flywheel.toml cannot state both "disabled_modules" and retired module selection');
    if (hasDisabledSelection && hasLegacyFeatures) throw new ConfigWriteError('flywheel.toml cannot state both "disabled_modules" and legacy "features"');
    if (Object.hasOwn(parsed, "enabled_modules") && (hasLegacyFeatures || hasRetiredSelection)) throw new ConfigWriteError('flywheel.toml cannot state "enabled_modules" with a retired module selection');
    const patched = patchModuleSelection(source, selection);
    return preset === "full" ? patchRootField(patched, "require_workflow_confirmation", false) : patched;
  }, options);
}

export interface ModuleMigration {
  readonly write: ConfigWriteResult;
  /** One user-visible sentence when the file stated both authorities. */
  readonly notice?: string;
}

type RetiredModuleConfig = ReturnType<typeof installedRetiredModuleConfig>[number];

function retiredField(setting: RetiredModuleConfig): string { return `${setting.section}.${setting.key}`; }

/** Migrates every retired capability authority in one global-lock commit. */
export async function migrateCapabilityModules(options: UpdateModelSelectionOptions): Promise<ModuleMigration> {
  let notice: string | undefined;
  const write = await updateConfigTextAwaited((source) => {
    const parsed: unknown = source.length > 0 ? Bun.TOML.parse(source) : {};
    if (!isRecord(parsed)) throw new ConfigWriteError("flywheel.toml must contain a TOML table");
    const hasRetiredSelection = Object.hasOwn(parsed, "modules") || Object.hasOwn(parsed, "capability_modules");
    const hasDisabledSelection = Object.hasOwn(parsed, "disabled_modules");
    const hasLegacyFeatures = Object.hasOwn(parsed, "features");
    if (Object.hasOwn(parsed, "enabled_modules") && (hasLegacyFeatures || hasRetiredSelection)) throw new ConfigWriteError('flywheel.toml cannot state "enabled_modules" with a retired module selection');
    if (hasDisabledSelection && hasRetiredSelection) {
      throw new ConfigWriteError('flywheel.toml cannot state both "disabled_modules" and retired module selection');
    }
    if (hasDisabledSelection && hasLegacyFeatures) {
      throw new ConfigWriteError('flywheel.toml cannot state both "disabled_modules" and legacy "features"');
    }
    if (hasRetiredSelection && hasLegacyFeatures) {
      throw new ConfigWriteError('flywheel.toml cannot state both "modules" and legacy "features"');
    }
    const retired = installedRetiredModuleConfig().map((setting) => ({ setting, state: statedRetiredOptOut(parsed, setting) }));
    const invalid = retired.find(({ state }) => state === "invalid");
    if (invalid) throw new ConfigWriteError(`Invalid obsolete config value "${retiredField(invalid.setting)}": expected a Boolean`);
    if (!hasRetiredSelection && !hasLegacyFeatures && !Object.hasOwn(parsed, "enabled_modules") && retired.every(({ state }) => state === "absent")) {
      const normalized = moduleSelectionFromConfig(parsed);
      if (!normalized.ok) throw new ConfigWriteError(normalized.error);
      return source;
    }
    let selection = hasLegacyFeatures
      ? migrateLegacyCapabilityModules(parsed.features)
      : moduleSelectionFromConfig(parsed);
    if (!selection.ok) throw new ConfigWriteError(selection.error);
    const optedOut = new Set(retired.flatMap(({ setting, state }) => state === "disabled" ? [setting.moduleId] : []));
    if (optedOut.size > 0 && !hasRetiredSelection && !hasLegacyFeatures && !hasDisabledSelection) {
      selection = normalizeModuleSelection(selection.moduleIds.filter((id) => !optedOut.has(id)));
      if (!selection.ok) throw new ConfigWriteError(selection.error);
    }
    let next = patchModuleSelection(source, selection.moduleIds);
    if (hasLegacyFeatures) next = removeRootAssignment(next, "features");
    const notices: string[] = [];
    for (const { setting, state } of retired) {
      if (state === "absent") continue;
      const field = retiredField(setting);
      const removed = removeRetiredOptOut(next, setting);
      if (removed === undefined || statesRetiredAuthority(removed, setting)) throw new ConfigWriteError(`flywheel.toml states the obsolete ${field} in a form Flywheel cannot remove exactly; the module selection decides ${setting.label}, so delete that field by hand.`);
      next = removed;
      if (hasRetiredSelection || hasDisabledSelection) notices.push(`flywheel.toml stated a module selection and the obsolete ${field}; the module selection decides ${setting.label} and the obsolete field was removed.`);
    }
    if (notices.length > 0) notice = notices.join(" ");
    return next;
  }, options);
  return notice === undefined || !write.ok ? { write } : { write, notice };
}

/** Whether this text still states the obsolete authority. Text that no longer
 *  parses counts as stating it: a rewrite is a removal only when a second parse
 *  proves the field is gone. */
function statesRetiredAuthority(text: string, setting: RetiredModuleConfig): boolean {
  try {
    return statedRetiredOptOut(text.length > 0 ? Bun.TOML.parse(text) : {}, setting) !== "absent";
  } catch {
    return true;
  }
}

/** Remove every byte that states the obsolete opt-out, and the section it
 *  leaves empty. The forms are the ones Bun's TOML parser accepts for it: a
 *  dotted root key, a root inline table, or the `enabled` assignment of the
 *  obsolete section, each with bare or quoted keys.
 *
 *  Undefined when the file states it in another form, or as an inline table
 *  that also states unrelated keys: the caller then leaves every byte alone
 *  rather than guessing at a rewrite. */
function removeRetiredOptOut(source: string, setting: RetiredModuleConfig): string | undefined {
  const lines = configLines(source);
  const rootEnd = rootEndIndex(lines);
  const dotted = findFieldIndex(lines, 0, rootEnd, `${keyPattern(setting.section)}\\s*\\.\\s*${keyPattern(setting.key)}`);
  if (dotted >= 0) {
    removeAssignment(lines, dotted);
    return lines.join("\n");
  }
  const inline = findFieldIndex(lines, 0, rootEnd, keyPattern(setting.section));
  if (inline >= 0) {
    if (!statesOptOutAlone(source, setting)) return undefined;
    removeAssignment(lines, inline);
    return lines.join("\n");
  }
  const header = new RegExp(`^\\[\\s*${keyPattern(setting.section)}\\s*\\]$`);
  const sectionStart = lines.findIndex((line) => header.test(line.trim()));
  if (sectionStart === -1) return undefined;
  const field = findFieldIndex(lines, sectionStart + 1, findSectionEnd(lines, sectionStart), keyPattern(setting.key));
  if (field < 0) return undefined;
  removeAssignment(lines, field);
  const sectionEnd = findSectionEnd(lines, sectionStart);
  if (!sectionHasKeyLines(lines, sectionStart + 1, sectionEnd)) removeSection(lines, sectionStart, sectionEnd);
  return lines.join("\n");
}

function removeRootAssignment(source: string, field: string): string {
  const lines = configLines(source);
  const index = findFieldIndex(lines, 0, rootEndIndex(lines), keyPattern(field));
  if (index < 0) throw new ConfigWriteError(`flywheel.toml states ${field} in a form Flywheel cannot remove exactly`);
  removeAssignment(lines, index);
  return lines.join("\n");
}

/** Whether the obsolete table states the opt-out and nothing else, so removing
 *  the whole assignment removes exactly the obsolete authority. */
function statesOptOutAlone(source: string, setting: RetiredModuleConfig): boolean {
  const parsed: unknown = Bun.TOML.parse(source);
  const section = isRecord(parsed) ? parsed[setting.section] : undefined;
  return isRecord(section) && Object.keys(section).length === 1 && Object.hasOwn(section, setting.key);
}

function isRecord(value: unknown): value is UnknownObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
