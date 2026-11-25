import { configurationReferenceFile } from "../../infra/platform/files/paths.js";
import { errorMessage } from "../../infra/diagnostics/error-message.js";
import { canonicalModelId, legacyDottedModelId, migrateModelId } from "../../infra/providers/model-id.js";
import { withConfigOwnership, withConfigOwnershipBlocking, type ConfigOwnership } from "./config-file.js";
import type { ModelAssignmentExpected, ModelAssignmentPatch, ModelSelectionSlot } from "../../protocol/auth/model-assignment-protocol-types.js";
import { AGENT_ROLE_IDS, AUX_ROLE_IDS, DEFAULT_ROLES, type RoleId } from "./roles.js";
import { parseBriefRoleId } from "../../protocol/auth/brief-role-id.js";
import { canonicalRoleId, retiredBriefSeatWorkflow, patchRetiredConfigKeys } from "./retired-config-names.js";
import { retireConfigTables } from "./retired-config-tables.js";
import { persistedDisabledModuleIds } from "../../protocol/runtime/module-ids.js";
import { CONFIG_DEFAULTS, type FlywheelConfig } from "./schema/schema.js";
import { PERSISTED_SETTING_DEFINITIONS, persistedSettingDefinition } from "./schema/setting-definitions.js";
import { configLines, findFieldIndex, findSectionEnd, patchSemanticAssignment, removeAssignment, removeSection, escapeTomlString, quoteTomlKey, removeSemanticSubtree, replaceAssignment, rootEndIndex, sectionHasKeyLines, upsertSemanticAssignment } from "./config-assignment.js";
import { installedConfigSections } from "./schema/config-section.js";
import { decodeConfigObject } from "./loader.js";

/** A runtime config write reaches us from a live TUI handler (theme, settings
 *  toggles), where the global config file is an external boundary - it can be
 *  hand-edited into invalid TOML, made unwritable, or fail validation. Those are
 *  expected, recoverable failures the handler renders, not internal-invariant
 *  defects, so the write returns a typed value instead of throwing into the
 *  reactive handler. */
export class ConfigWriteError extends Error {
  readonly _tag = "ConfigWriteError" as const;
  constructor(message: string) {
    super(message);
    this.name = "ConfigWriteError";
  }
}

export class ConfigStaleWriteError extends ConfigWriteError {
  constructor() {
    super("The configuration changed before this update. Try again.");
    this.name = "ConfigStaleWriteError";
  }
}

/** A committed write is `ok`. `durabilityError` reports the one failure that is
 *  neither success nor rollback: the rename landed, so the new text IS the file
 *  and every reader sees it, but the directory sync that would prove it survives
 *  a crash failed. The caller keeps the committed state and republishes from a
 *  fresh read rather than pretending the change did not happen. */
export type ConfigWriteResult =
  | { readonly ok: true; readonly durabilityError?: ConfigWriteError }
  | { readonly ok: false; readonly error: ConfigWriteError };

export interface UpdateModelSelectionOptions {
  /** Startup-selected account data root the global config lives under. */
  readonly userDataRoot?: string;
  /** Override the canonical global config path. Test-only. */
  readonly configPath?: string;
}

interface RoleWriteOptions extends UpdateModelSelectionOptions {
  /** Immutable id of the profile whose role settings are edited. */
  readonly authProfileId: () => string;
}

interface ModelAssignmentMutation {
  slot: ModelSelectionSlot;
  patch: ModelAssignmentPatch;
  /** The role's profile entry that the person's client showed. A write with
   *  no client view, such as the setup of a new home, states none. */
  expected?: ModelAssignmentExpected;
}

export interface ConfigValidity {
  /** Complete registered persona role ids, never a query's selected rows. */
  roleIds?: ReadonlySet<RoleId>;
  /** Persona files that failed to load. Their roles are unknown, so while any remain the
   *  role ids are not complete and no role section is pruned (ARCH-RUNTIME-069). */
  unloadedPersonaFiles?: readonly string[];
}

interface BatchModelAssignmentPatch {
  mutations?: readonly ModelAssignmentMutation[];
  validity?: ConfigValidity;
}

type UnknownObject = { [K in string]: unknown };

export function pruneStaleConfig(validity: ConfigValidity, options: RoleWriteOptions): void {
  updateModelAssignments({ validity }, options);
}

/** Set one canonical project root binding without normalizing unrelated config text. `expected` is the binding
 *  that the caller read, or undefined for none; a file that binds the project otherwise refuses the write as stale. */
export function setAuthProjectProfile(projectRoot: string, profile: string, expected: string | undefined, options: UpdateModelSelectionOptions): ConfigWriteResult {
  return updateConfigText((source) => patchAuthProjectProfile(source, projectRoot, expected, profile), options);
}

/** Remove one canonical project root binding without changing the rest of its table. `expected` is the binding
 *  that the caller read; a file that binds the project otherwise refuses the write as stale. */
export function removeAuthProjectProfile(projectRoot: string, expected: string | undefined, options: UpdateModelSelectionOptions): ConfigWriteResult {
  return updateConfigText((source) => patchAuthProjectProfile(source, projectRoot, expected, undefined), options);
}

/** Transfer only bindings to the retired id and remove its complete settings subtree in one commit. */
export function retireAuthProfileConfig(profile: string, successorId: string, options: UpdateModelSelectionOptions): ConfigWriteResult {
  return updateConfigText((source) => removeSemanticSubtree(patchAuthProjectProfileBindings(source, profile, successorId), ["profiles", profile]), options);
}

/** Materialize seeded defaults and migrate exact retired seed values. */
export function seedConfigDefaults(options: UpdateModelSelectionOptions): ConfigWriteResult {
  return updateConfigText((source) => {
    const parsed: ParsedToml = source.length > 0 ? Bun.TOML.parse(source) : {};
    const seededModules = installedConfigSections().reduce((next, section) => (section.seeds ?? []).reduce((text, seed) => {
      const path = [section.key, seed.key];
      const authored = configValueAtPath(parsed, path);
      const retired = seed.replaces?.some((value) => JSON.stringify(value) === JSON.stringify(authored)) === true;
      return authored === undefined || retired ? patchDefinedSetting(text, { path }, seed.value) : text;
    }, next), source);
    return PERSISTED_SETTING_DEFINITIONS.reduce((next, definition) => {
      if (definition.seed !== true || hasConfigPath(parsed, definition.path)) return next;
      const value = configValueAtPath(CONFIG_DEFAULTS, definition.path);
      return isTomlValue(value) ? patchDefinedSetting(next, definition, value) : next;
    }, seededModules);
  }, options);
}

/** Rewrite persisted model aliases to Flywheel's canonical identity, and
 *  retired role ids and settings to their current names.
 * Only the snapshot-date conversion of role pins is removed after 2026-12-17;
 * the alias and retired-name rewrites stay. */
export function migrateModelAssignments(options: UpdateModelSelectionOptions): ConfigWriteResult {
  return updateConfigText((source) => patchModelMigrations(patchRetiredConfigKeys(source)), options);
}


function patchModelMigrations(source: string): string {
  const parsed: ParsedToml = source.length > 0 ? Bun.TOML.parse(source) : {};
  if (!isRecord(parsed)) throw new ConfigWriteError("flywheel.toml must contain a TOML table");
  return modelAssignmentPaths(parsed).reduce((next, { path, model }) => {
    const canonical = migrateModelId(model);
    if (canonical === model) return next;
    return patchSemanticAssignment(next, path, tomlLiteral(canonical)) ?? next;
  }, source);
}

/** Rewrites role pins saved under a former spelling of a current catalog
 *  model, given each catalog model with the wire ids of its offerings. Two
 *  former spellings exist:
 *  - Releases before 2026-09-22 dotted parameter sizes (qwen3-8b as qwen3.8b).
 *    Remove this spelling and legacyDottedModelId after 2026-12-22.
 *  - Releases before 2026-10-24 named each OpenCode Go model by its wire, so a
 *    free wire such as beam-free was its own model. The model is now the
 *    snapshot that models.dev records, and the free wire is one of its routes.
 *    A pin converts to the model, not to its free route: which route serves
 *    it follows the account's free-route toggle. Remove this spelling after
 *    2027-01-24.
 *  A spelling alone cannot say which model it meant, because a genuine name
 *  such as qwen3.5-0.8b has the same shape, so a saved model converts only when
 *  it is not a current catalog model and is the former spelling of exactly one.
 *  A model with no wire ids still counts as current, so the caller can name
 *  models that no signed-in account lists. */
export async function migrateLegacyModelSpellings(options: UpdateModelSelectionOptions, catalogModels: ReadonlyMap<string, Iterable<string>>): Promise<ConfigWriteResult & { readonly rewritten: boolean }> {
  const current = new Map<string, string | undefined>();
  for (const [model, wireModelIds] of catalogModels) {
    const formers = new Set([legacyDottedModelId(model), ...[...wireModelIds].map(canonicalModelId)]);
    for (const former of formers) {
      if (former === model || catalogModels.has(former)) continue;
      current.set(former, current.has(former) ? undefined : model);
    }
  }
  const renamed = (model: string) => current.get(model);
  if (![...current.values()].some((model) => model !== undefined)) return { ok: true, rewritten: false };
  let rewritten = false;
  const result = await updateConfigTextAwaited((source) => {
    const parsed: ParsedToml = source.length > 0 ? Bun.TOML.parse(source) : {};
    if (!isRecord(parsed)) throw new ConfigWriteError("flywheel.toml must contain a TOML table");
    const next = modelAssignmentPaths(parsed).reduce((text, { path, model }) => {
      const target = renamed(model);
      return target === undefined ? text : patchSemanticAssignment(text, path, tomlLiteral(target)) ?? text;
    }, source);
    rewritten = next !== source;
    return next;
  }, options);
  return { ...result, rewritten };
}

function modelAssignmentPaths(config: UnknownObject): Array<{ readonly path: readonly string[]; readonly model: string }> {
  return roleTables(config).flatMap(({ path, roles }) => Object.entries(roles).flatMap(([roleId, role]) =>
    isRecord(role) && typeof role.model === "string" ? [{ path: [...path, roleId, "model"], model: role.model }] : []));
}

/** Each profile's role table, with its path. */
function roleTables(config: UnknownObject): Array<{ readonly path: readonly string[]; readonly roles: UnknownObject }> {
  const tables: Array<{ readonly path: readonly string[]; readonly roles: UnknownObject }> = [];
  if (!isRecord(config.profiles)) return tables;
  for (const [profileId, profile] of Object.entries(config.profiles)) {
    if (isRecord(profile) && isRecord(profile.roles)) tables.push({ path: ["profiles", profileId, "roles"], roles: profile.roles });
  }
  return tables;
}

function hasConfigPath(parsed: ParsedToml, path: readonly string[]): boolean {
  let node: unknown = parsed;
  for (const segment of path.slice(0, -1)) {
    if (!isRecord(node)) return false;
    node = node[segment];
  }
  const field = path.at(-1);
  return field !== undefined && isRecord(node) && field in node;
}

function configValueAtPath(config: ParsedToml, path: readonly string[]): TomlValue | undefined {
  let value: unknown = config;
  for (const segment of path) {
    if (!isRecord(value)) return undefined;
    value = value[segment === "disabled_modules" ? "modules" : segment];
  }
  if (path[0] === "disabled_modules" && Array.isArray(value)) return persistedDisabledModuleIds(value);
  return isTomlValue(value) ? value : undefined;
}



export function updateModelAssignments(
  batch: BatchModelAssignmentPatch,
  options: RoleWriteOptions,
): void {
  unwrapConfigWrite(updateConfigText((source) => {
    // A save writes the current role ids, so the file must not keep a
    // retired spelling of the same seat beside them.
    const current = patchRetiredConfigKeys(source);
    const profileId = options.authProfileId();
    const stated = (batch.mutations ?? []).flatMap(({ slot, expected }) => expected === undefined ? [] : [{ roleId: slot.roleId, expected }]);
    if (stated.length > 0) {
      const config = decodeConfigText(current, options.userDataRoot);
      if (stated.some(({ roleId, expected }) => !sameExpectation(configuredRoleAssignment(config, profileId, roleId), expected))) throw new ConfigStaleWriteError();
    }
    let next = batch.validity ? patchModelMigrations(current) : current;
    for (const mutation of batch.mutations ?? []) {
      next = patchModelAssignment(next, mutation.slot, mutation.patch, profileId);
    }
    if (batch.validity) next = patchPrunedConfig(next, batch.validity, profileId);
    return next;
  }, options));
}

/** The role's model and effort in one profile of a decoded config. A row that a
 *  client shows carries this value of the published config, and a write of the
 *  role compares it with this value of the fresh bytes, so both sides read the
 *  one decode. */
export function configuredRoleAssignment(config: FlywheelConfig, profileId: string, roleId: string): ModelAssignmentExpected {
  const role = config.profiles[profileId]?.roles[canonicalRoleId(roleId)];
  const model = role?.model ?? null;
  const effort = role?.effort ?? null;
  return model === null && effort === null ? { kind: "absent" } : { kind: "value", value: { model, effort } };
}

function sameExpectation(actual: ModelAssignmentExpected, expected: ModelAssignmentExpected): boolean {
  if (actual.kind === "absent" || expected.kind === "absent") return actual.kind === expected.kind;
  return actual.value.model === expected.value.model && actual.value.effort === expected.value.effort;
}

/** Commits one persisted setting, named by its definition id, at the path its
 *  definition declares. An unknown id throws; a value that fails to decode is a
 *  typed failure, and the file is left as it was. */
export function updateDefinedSetting(id: string, value: TomlValue, options: UpdateModelSelectionOptions): ConfigWriteResult {
  const definition = persistedSettingDefinition(id);
  return updateConfigText((source) => patchDefinedSetting(source, definition, value), options);
}

export function patchDefinedSetting(source: string, definition: { readonly path: readonly string[] }, value: TomlValue): string {
  const existing = patchSemanticAssignment(source, definition.path, tomlLiteral(value));
  if (existing !== undefined) return existing;
  const [root, ...nested] = definition.path;
  if (root === undefined) return source;
  if (nested.length === 0) return patchRootField(source, root, value);
  const field = nested.at(-1);
  if (field === undefined) return source;
  return patchSectionField(source, [root, ...nested.slice(0, -1)].join("."), field, value);
}

/** Commits one text patch of the global config under file ownership: the
 *  patched document must decode, or the file is left as it was. */
function updateConfigText(
  patch: (source: string) => string,
  options: UpdateModelSelectionOptions,
): ConfigWriteResult {
  try {
    return withConfigOwnershipBlocking(options, (config) => commitConfigText(config, patch, options));
  } catch (err) {
    return { ok: false, error: err instanceof ConfigWriteError ? err : new ConfigWriteError(errorMessage(err)) };
  }
}

/** The same commit inside the awaited ownership window, for a caller that is
 *  already asynchronous and must not block the loop while another owner holds
 *  the file. */
export async function updateConfigTextAwaited(
  patch: (source: string) => string,
  options: UpdateModelSelectionOptions,
): Promise<ConfigWriteResult> {
  try {
    return await withConfigOwnership(options, (config) => commitConfigText(config, patch, options));
  } catch (err) {
    return { ok: false, error: err instanceof ConfigWriteError ? err : new ConfigWriteError(errorMessage(err)) };
  }
}

/** One read, one patch, one validated publication, inside a window the caller
 *  already owns. A patch that changes nothing writes nothing, and text that
 *  fails to parse or decode is refused before the file is touched. */
function commitConfigText(config: ConfigOwnership, patch: (source: string) => string, options: UpdateModelSelectionOptions): ConfigWriteResult {
  const { userDataRoot } = options;
  const read = retireConfigTables(config, (candidate) => decodeConfigText(candidate, userDataRoot), options);
  if (read.kind === "failure") throw new ConfigWriteError("Config file was refused or unreadable");
  const source = read.kind === "text" ? read.text : "";
  const next = patch(source);
  if (next === source) return { ok: true };
  Bun.TOML.parse(next);
  decodeConfigText(next, userDataRoot);
  const durability = config.write(next);
  return durability ? { ok: true, durabilityError: new ConfigWriteError(errorMessage(durability)) } : { ok: true };
}

/** The model-assignment writers reach us from non-UI flows whose callers expect
 *  a loud failure (a save-effort result contract), so they collapse the typed
 *  result back to a throw at their seam. */
function unwrapConfigWrite(result: ConfigWriteResult): void {
  if (!result.ok) throw result.error;
}

function decodeConfigText(text: string, userDataRoot?: string): FlywheelConfig {
  const parsed = Bun.TOML.parse(text);
  if (!isRecord(parsed)) throw new ConfigWriteError("Config file is not a table");
  const decoded = decodeConfigObject(parsed, [], configurationReferenceFile(userDataRoot ?? resolveConfigRoot()));
  if (decoded.moduleError) throw new ConfigWriteError(decoded.moduleError);
  return decoded.config;
}

function resolveConfigRoot(): string {
  return process.env.HOME ? `${process.env.HOME}/.flywheel` : ".flywheel";
}



function patchModelAssignment(source: string, slot: ModelSelectionSlot, patch: ModelAssignmentPatch, profileId: string): string {
  const path = ["profiles", profileId, "roles", slot.roleId];
  if (!hasConfigPath(Bun.TOML.parse(source), path)) {
    const lines = configLines(source);
    const fieldLines = assignmentFieldLines(patch);
    if (fieldLines.length === 0) return source;
    const prefix = lines.length === 1 && lines[0] === "" ? [] : lines.slice(0, -1);
    return [...prefix, prefix.length > 0 ? "" : undefined, `[${sectionName(slot, profileId)}]`, ...fieldLines, ""]
      .filter((line): line is string => line !== undefined)
      .join("\n");
  }

  // Retirement can create dotted assignments without an explicit role header.
  // Update semantic paths so a save does not redefine their TOML table.
  let next = removeSemanticSubtree(source, [...path, "provider"]);
  for (const field of ["model", "effort"] as const) {
    const value = patch[field];
    if (value === undefined) continue;
    next = value === null
      ? removeSemanticSubtree(next, [...path, field])
      : upsertSemanticAssignment(next, [...path, field], `"${escapeTomlString(value)}"`);
  }
  const parsed = Bun.TOML.parse(next);
  if (!hasConfigPath(parsed, [...path, "model"]) && !hasConfigPath(parsed, [...path, "effort"])) {
    next = removeSemanticSubtree(next, path);
  }
  return next;
}

function patchPrunedConfig(source: string, validity: ConfigValidity, profileId: string): string {
  if (!validity.roleIds || (validity.unloadedPersonaFiles?.length ?? 0) > 0) return source;
  const lines = configLines(source);
  for (let i = 0; i < lines.length - 1;) {
    const section = sectionFromHeader(lines[i]?.trim() ?? "", profileId);
    if (!section || sectionIsValid(section, validity)) {
      i += 1;
      continue;
    }
    removeSection(lines, i, findSectionEnd(lines, i));
  }
  return lines.join("\n");
}

interface ParsedSectionHeader {
  roleId?: string;
}

function sectionIsValid(section: ParsedSectionHeader, validity: ConfigValidity): boolean {
  const roleId = section.roleId === undefined ? undefined : canonicalRoleId(section.roleId);
  if (roleId && validity.roleIds && !validity.roleIds.has(roleId)) {
    if (retiredBriefSeatWorkflow(roleId) !== undefined) return true;
    if (AGENT_ROLE_IDS.includes(roleId)) return true;
    if (roleId in DEFAULT_ROLES) return true;
    // Auxiliary roles remain config-only, so no slot list vouches for them.
    if (AUX_ROLE_IDS.includes(roleId)) return true;
    const selector = parseBriefRoleId(roleId);
    if (selector) {
      return selector.personaRole === undefined
        || validity.roleIds.has(selector.personaRole)
        || AGENT_ROLE_IDS.includes(selector.personaRole)
        || selector.personaRole in DEFAULT_ROLES;
    }
    return false;
  }
  return true;
}

export function patchRootField(source: string, field: string, value: TomlValue): string {
  const lines = configLines(source);
  const rootEnd = rootEndIndex(lines);
  const nextLine = `${field} = ${tomlLiteral(value)}`;
  const index = findFieldIndex(lines, 0, rootEnd, field);
  if (index >= 0) replaceAssignment(lines, index, nextLine);
  else lines.splice(rootEnd, 0, nextLine);
  return lines.join("\n");
}

function patchSectionField(source: string, section: string, field: string, value: TomlValue): string {
  const lines = configLines(source);
  const header = `[${section}]`;
  const nextLine = `${field} = ${tomlLiteral(value)}`;
  const sectionStart = lines.findIndex((line) => line.trim() === header);
  if (sectionStart === -1) {
    const prefix = lines.length === 1 && lines[0] === "" ? [] : lines.slice(0, -1);
    return [...prefix, prefix.length > 0 ? "" : undefined, header, nextLine, ""]
      .filter((line): line is string => line !== undefined)
      .join("\n");
  }

  const sectionEnd = findSectionEnd(lines, sectionStart);
  const index = findFieldIndex(lines, sectionStart + 1, sectionEnd, escapeRegex(field));
  if (index >= 0) replaceAssignment(lines, index, nextLine);
  else lines.splice(sectionStart + 1, 0, nextLine);
  return lines.join("\n");
}

/** Persist one registered profile boolean while preserving sibling overlays. */
export function patchProfileBoolean(
  source: string,
  profileId: string,
  definition: { readonly key: string; readonly defaultValue: false },
  value: boolean,
): string {
  const lines = configLines(source);
  const expectedPath = ["profiles", profileId];
  const field = definition.key;
  const sectionStart = lines.findIndex((line) => {
    const path = sectionHeaderPath(line.trim());
    return path?.length === expectedPath.length && expectedPath.every((key, index) => path[index] === key);
  });
  if (sectionStart < 0) {
    if (!value) return source;
    const descendant = lines.findIndex((line) => {
      const path = sectionHeaderPath(line.trim());
      return path !== undefined && path.length > expectedPath.length && expectedPath.every((key, index) => path[index] === key);
    });
    const header = `[profiles.${quoteTomlKey(profileId)}]`;
    if (descendant >= 0) {
      lines.splice(descendant, 0, header, `${field} = true`, "");
      return lines.join("\n");
    }
    const prefix = lines.length === 1 && lines[0] === "" ? [] : lines.slice(0, -1);
    return [...prefix, prefix.length > 0 ? "" : undefined, header, `${field} = true`, ""]
      .filter((line): line is string => line !== undefined)
      .join("\n");
  }

  let sectionEnd = findSectionEnd(lines, sectionStart);
  const fieldIndex = findFieldIndex(lines, sectionStart + 1, sectionEnd, field);
  if (value) {
    if (fieldIndex >= 0) replaceAssignment(lines, fieldIndex, `${field} = true`);
    else lines.splice(sectionStart + 1, 0, `${field} = true`);
    return lines.join("\n");
  }
  if (fieldIndex < 0) return source;
  sectionEnd -= removeAssignment(lines, fieldIndex);
  if (!sectionHasKeyLines(lines, sectionStart + 1, sectionEnd)) removeSection(lines, sectionStart, sectionEnd);
  return lines.join("\n");
}

/** Persist one project's `show_build` under `projects.<canonical root>`. */
export function patchProjectShowBuild(source: string, projectRoot: string, value: boolean): string {
  return patchSemanticAssignment(source, ["projects", projectRoot, "show_build"], tomlLiteral(value))
    ?? patchSectionField(source, `projects.${quoteTomlKey(projectRoot)}`, "show_build", value);
}

/** Persist one provider-scoped numeric setting under
 *  `profiles.<profile>.providers.<provider>` without changing sibling overlays. */
export function patchProfileProviderSetting(source: string, profileId: string, providerId: string, key: string, value: number): string {
  const path = ["profiles", profileId, "providers", providerId];
  const semantic = patchSemanticAssignment(source, [...path, key], tomlLiteral(value));
  if (semantic !== undefined) return semantic;
  const lines = configLines(source);
  const sectionStart = lines.findIndex((line) => {
    const candidate = sectionHeaderPath(line.trim());
    return candidate?.length === path.length && path.every((segment, index) => candidate[index] === segment);
  });
  if (sectionStart >= 0) {
    lines.splice(sectionStart + 1, 0, `${key} = ${tomlLiteral(value)}`);
    return lines.join("\n");
  }
  const descendant = lines.findIndex((line) => {
    const candidate = sectionHeaderPath(line.trim());
    return candidate !== undefined && candidate.length > path.length && path.every((segment, index) => candidate[index] === segment);
  });
  const header = `[${path.map(quoteTomlKey).join(".")}]`;
  if (descendant >= 0) {
    lines.splice(descendant, 0, header, `${key} = ${tomlLiteral(value)}`, "");
    return lines.join("\n");
  }
  const prefix = lines.length === 1 && lines[0] === "" ? [] : lines.slice(0, -1);
  return [...prefix, prefix.length > 0 ? "" : undefined, header, `${key} = ${tomlLiteral(value)}`, ""].filter((line): line is string => line !== undefined).join("\n");
}

/** Copy every retired root `providers.<provider>` numeric setting to each
 *  profile that does not state it, and remove the root table, in one commit.
 *  The retired root spelling `false` means off, which profiles spell 0. */
export function migrateRootProviderSettings(profileIds: readonly string[], options: UpdateModelSelectionOptions): ConfigWriteResult {
  return updateConfigText((source) => {
    const parsed: ParsedToml = source.length === 0 ? {} : Bun.TOML.parse(source);
    const providers = isRecord(parsed) ? parsed.providers : undefined;
    if (!isRecord(providers)) return source;
    let next = source;
    for (const [providerId, table] of Object.entries(providers)) {
      if (!isRecord(table)) continue;
      for (const [key, raw] of Object.entries(table)) {
        const value = raw === false ? 0 : raw;
        if (!(typeof value === "number" && Number.isInteger(value) && value >= 0)) continue;
        for (const profileId of profileIds) {
          if (!hasConfigPath(parsed, ["profiles", profileId, "providers", providerId, key])) next = patchProfileProviderSetting(next, profileId, providerId, key, value);
        }
        const lines = configLines(next);
        const section = lines.findIndex((line) => {
          const path = sectionHeaderPath(line.trim());
          return path?.length === 2 && path[0] === "providers" && path[1] === providerId;
        });
        if (section < 0) throw new Error("root provider settings must use their canonical provider table");
        const end = findSectionEnd(lines, section);
        const field = findFieldIndex(lines, section + 1, end, escapeRegex(key));
        if (field < 0) continue;
        const removed = removeAssignment(lines, field);
        if (!sectionHasKeyLines(lines, section + 1, end - removed)) removeSection(lines, section, end - removed);
        next = lines.join("\n");
      }
    }
    return next;
  }, options);
}

function patchAuthProjectProfile(source: string, projectRoot: string, expected: string | undefined, profile: string | undefined): string {
  if (projectBinding(source, projectRoot) !== expected) throw new ConfigStaleWriteError();
  const lines = configLines(source);
  const start = lines.findIndex((line) => line.trim() === "[auth.project_profiles]");
  if (start < 0) return profile === undefined ? source : patchSectionField(source, "auth.project_profiles", quoteTomlKey(projectRoot), profile);
  const end = findSectionEnd(lines, start);
  const index = findFieldIndex(lines, start + 1, end, escapeRegex(quoteTomlKey(projectRoot)));
  if (index < 0) return profile === undefined ? source : patchSectionField(source, "auth.project_profiles", quoteTomlKey(projectRoot), profile);
  if (profile === undefined) removeAssignment(lines, index);
  else replaceAssignment(lines, index, `${quoteTomlKey(projectRoot)} = ${tomlLiteral(profile)}`);
  return lines.join("\n");
}


/** The profile id that `source` binds to `projectRoot`, if any. */
function projectBinding(source: string, projectRoot: string): string | undefined {
  const parsed: ParsedToml = source.length === 0 ? {} : Bun.TOML.parse(source);
  const auth = isRecord(parsed) ? parsed.auth : undefined;
  const bindings = isRecord(auth) ? auth.project_profiles : undefined;
  const bound = isRecord(bindings) ? bindings[projectRoot] : undefined;
  return typeof bound === "string" ? bound : undefined;
}

function patchAuthProjectProfileBindings(source: string, profile: string, successorId: string): string {
  const parsed: ParsedToml = source.length === 0 ? {} : Bun.TOML.parse(source);
  const auth = isRecord(parsed) ? parsed.auth : undefined;
  const bindings = isRecord(auth) ? auth.project_profiles : undefined;
  if (!isRecord(bindings)) return source;
  const projectRoots = Object.entries(bindings).flatMap(([projectRoot, selected]) => selected === profile ? [projectRoot] : []);
  if (projectRoots.length === 0) return source;
  let next = source;
  for (const projectRoot of projectRoots) {
    const patched = patchSemanticAssignment(next, ["auth", "project_profiles", projectRoot], tomlLiteral(successorId));
    if (patched === undefined) throw new Error("project profile binding has no authored assignment");
    next = patched;
  }
  return next;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}


type TomlScalar = string | number | boolean;

/** Every value these writers publish. Lists stay on one line so repeated setting changes do not move unrelated bytes. */
/** A TOML document as `Bun.TOML.parse` returns it. */
type ParsedToml = ReturnType<typeof Bun.TOML.parse>

type TomlValue = TomlScalar | readonly (string | number)[];

function isTomlValue(value: unknown): value is TomlValue {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return true;
  return Array.isArray(value) && value.every((member) => typeof member === "string" || typeof member === "number");
}

function tomlLiteral(value: TomlValue): string {
  if (typeof value === "string") return `"${escapeTomlString(value)}"`;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return `[${value.map((member) => typeof member === "string" ? `"${escapeTomlString(member)}"` : String(member)).join(", ")}]`;
}

function assignmentFieldLines(patch: ModelAssignmentPatch): string[] {
  const lines: string[] = [];
  if (patch.model !== undefined && patch.model !== null) lines.push(`model = "${escapeTomlString(patch.model)}"`);
  if (patch.effort !== undefined && patch.effort !== null) lines.push(`effort = "${escapeTomlString(patch.effort)}"`);
  return lines;
}

function isRecord(value: unknown): value is UnknownObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sectionFromHeader(header: string, profileId: string): ParsedSectionHeader | undefined {
  const path = sectionHeaderPath(header);
  const prefix = ["profiles", profileId, "roles"];
  if (path?.length !== prefix.length + 1 || !prefix.every((key, index) => path[index] === key)) return undefined;
  return { roleId: path[prefix.length] };
}

function sectionHeaderPath(header: string): readonly string[] | undefined {
  if (!/^\[.+\]$/.test(header)) return undefined;
  try {
    const path: string[] = [];
    let node: unknown = Bun.TOML.parse(`${header}\n`);
    while (isRecord(node)) {
      const keys = Object.keys(node);
      if (keys.length === 0) return path;
      if (keys.length !== 1) return undefined;
      const key = keys[0];
      if (key === undefined) return undefined;
      path.push(key);
      node = node[key];
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function sectionName(slot: ModelSelectionSlot, profileId: string): string {
  const role = `roles.${quoteTomlKey(slot.roleId)}`;
  return `profiles.${quoteTomlKey(profileId)}.${role}`;
}

