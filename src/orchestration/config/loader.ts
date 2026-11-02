import { homedir } from "node:os";
import { resolve } from "node:path";
import { Result, Schema } from "effect";
import { errorMessage } from "../../infra/error-message.js";
import { Log } from "../../infra/log.js";
import { configurationReferenceFile } from "../../infra/paths.js";
import { installedConfigSections, installedModules } from "../module-catalog.js";
import { decodeModuleSelection } from "./module-descriptor.js";
import { buildCustomProvidersFromConfig } from "./custom-providers.js";
import { readConfigFile, withConfigOwnershipBlocking } from "./config-file.js";
import { configPath as displayConfigPath, configReference, configReferenceEntry, type ConfigReferenceEntry } from "./config-reference.js";
import { applyEnvOverrides } from "./env.js";
import { configRoleRetention } from "./roles.js";
import { canonicalRoleId, retiredBriefSeatWorkflow } from "./retired-config-names.js";
import { hasRetiredConfigTables, retireConfigTables } from "./retired-config-tables.js";
import { type FlywheelConfig, installedConfigSchema } from "./schema.js";
import { isPersistedSettingId, PERSISTED_SETTING_DEFINITIONS, type PersistedSettingId } from "./setting-definitions.js";

type ConfigErrorCode = "FILE_NOT_FOUND" | "FILE_READ_ERROR" | "PARSE_ERROR" | "VALIDATION";

export type ConfigDiagnostic =
  | { readonly kind: "setting"; readonly settingId: PersistedSettingId; readonly path: readonly string[]; readonly reason: "invalid-value" | "normalized-value" }
  | { readonly kind: "document"; readonly reason: "toml-syntax" | "unreadable" | "unmapped-setting"; readonly line?: number };

type Environment = { [K in string]: string | undefined };

type UnknownObject = { [K in string]: unknown };
interface DecodedConfigObject {
  readonly config: FlywheelConfig;
  readonly moduleError?: string;
}

export class ConfigLoadError extends Error {
  readonly _tag = "ConfigLoadError" as const;
  readonly code: ConfigErrorCode;
  readonly diagnostics: readonly ConfigDiagnostic[];

  constructor(message: string, code: ConfigErrorCode, diagnostics: readonly ConfigDiagnostic[] = []) {
    super(message);
    this.name = "ConfigLoadError";
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

interface LoadResult {
  config: FlywheelConfig;
  warnings: string[];
  /** Present when the file states a module selection this runtime cannot understand. */
  moduleError?: string;
  diagnostics: readonly ConfigDiagnostic[];
}

export function loadConfig(
  configPath?: string,
  env: Environment = process.env,
  userDataRoot = resolve(homedir(), ".flywheel"),
): LoadResult {
  const text = configPath ? readTomlFile(configPath, userDataRoot) : "";
  const result = decodeCanonicalConfigText(text, env, userDataRoot, configPath ? resolve(configPath) : undefined);
  publishWarnings(result.warnings);
  return result;
}

/** Decode one canonical TOML document with the same environment overlay as the file loader. This seam is effect-free. */
export function decodeCanonicalConfigText(
  text: string,
  env: Environment = process.env,
  userDataRoot = resolve(homedir(), ".flywheel"),
  diagnosticPath?: string,
): LoadResult {
  const warnings: string[] = [];
  const diagnostics: ConfigDiagnostic[] = [];
  const guide = configurationReferenceFile(userDataRoot);
  let raw = parseTomlText(text, guide, diagnosticPath);
  // The file's retired role spellings yield to the environment's current
  // ones only after both name the same seat.
  canonicalizeRoleKeys(raw);
  const envResult = applyEnvOverrides(env);
  if (envResult.errors.length > 0) {
    throw new ConfigLoadError(
      `Invalid environment overrides: ${envResult.errors.join(", ")}\n\nConfiguration reference: ${guide}`,
      "VALIDATION",
      [{ kind: "document", reason: "unmapped-setting" }],
    );
  }
  const { roles: _processRoles, ...ordinaryOverrides } = envResult.overrides;
  raw = deepMerge(raw, ordinaryOverrides);
  const decoded = decodeConfigObject(raw, warnings, guide, diagnostics);
  if (warnings.length > 0 && diagnostics.length === 0) diagnostics.push({ kind: "document", reason: "unmapped-setting" });
  return { config: decoded.config, warnings, diagnostics: mergeDiagnostics(diagnostics), moduleError: decoded.moduleError };
}

const log = Log.create({ service: "config" });

// A warning describes a standing condition of the config file, and loadConfig
// re-runs throughout a process. Deduplicate consecutive warning sets without
// persisting authored paths or identifiers in diagnostics.
let publishedWarningSet: string | undefined;

function publishWarnings(warnings: string[]): void {
  if (warnings.length === 0) {
    publishedWarningSet = undefined;
    return;
  }
  const identity = new Bun.CryptoHasher("sha256").update(warnings.join("\0")).digest("hex");
  if (publishedWarningSet === identity) return;
  publishedWarningSet = identity;
  log.warn("Configuration values were ignored or normalized", {
    code: "config-normalized",
    warningCount: warnings.length,
  });
}

/** Normalize tolerated retired syntax, then strictly decode one external config object. */
export function decodeConfigObject(raw: UnknownObject, warnings: string[], guide: string, diagnostics: ConfigDiagnostic[] = []): DecodedConfigObject {
  // Remove after 2027-10-16. File readers commit this retirement before decode; pure decoding never grants root roles authority.
  delete raw.roles;
  stripRetiredCompactionConfig(raw);
  canonicalizeRoleKeys(raw);
  warnRetiredBriefSettings(raw, warnings);
  stripUnknownRoleKeys(raw, warnings);
  stripLegacyRoleProviderKeys(raw, warnings);
  stripRetiredOpenAIIdentity(raw);
  stripRetiredIntroHintsVersion(raw);
  const ownerIssues = [...sectionOwnerIssues(raw), ...cacheRetentionIssues(raw)];
  const moduleError = normalizeCapabilityModules(raw, warnings);
  normalizeRetiredWorkflowSection(raw);
  normalizePersistentProcessPermission(raw, warnings, diagnostics);
  const decode = Schema.decodeUnknownResult(installedConfigSchema(), {
    errors: "all",
    onExcessProperty: "error",
  });
  let result = decode(raw);
  if (Result.isFailure(result)) {
    // Unknown keys are tolerated at this external boundary: a stale key from a
    // removed feature or a key written by a newer Flywheel must not reject a
    // working config. Prune and warn; only faults on recognized keys are fatal.
    const schemaIssues = collectSchemaIssues(result.failure.issue);
    for (const issue of schemaIssues.filter((candidate) => candidate.unknownKey)) {
      pruneRawPath(raw, issue.path);
      warnings.push(unknownKeyWarning(issue.path, guide));
      diagnostics.push({ kind: "document", reason: "unmapped-setting" });
    }
    const fatal = schemaIssues.filter((issue) => !issue.unknownKey && !ownerIssues.some((owned) => isDescendant(issue.path, owned.path)));
    if (fatal.length > 0 || ownerIssues.length > 0) {
      const issues = [...fatal, ...ownerIssues];
      throw new ConfigLoadError(formatValidationIssues(issues, guide), "VALIDATION", mergeDiagnostics(diagnostics, diagnosticsForIssues(issues)));
    }
    result = decode(raw);
    if (Result.isFailure(result)) {
      const issues = collectSchemaIssues(result.failure.issue);
      throw new ConfigLoadError(formatValidationIssues(issues, guide), "VALIDATION", mergeDiagnostics(diagnostics, diagnosticsForIssues(issues)));
    }
  } else if (ownerIssues.length > 0) {
    throw new ConfigLoadError(formatValidationIssues(ownerIssues, guide), "VALIDATION", mergeDiagnostics(diagnostics, diagnosticsForIssues(ownerIssues)));
  }
  warnings.push(...buildCustomProvidersFromConfig(result.success.custom_providers).warnings);
  return { config: result.success, moduleError };
}

/** Normalizes external module selection while leaving refused bytes untouched on disk.
 *  The persisted disabled_modules key owns the selection; modules and
 *  capability_modules are its retired spellings, migrated at startup. */
function normalizeCapabilityModules(raw: UnknownObject, warnings: string[]): string | undefined {
  const selection = decodeModuleSelection(raw);
  delete raw["capability_modules"]; // retired spelling
  delete raw["disabled_modules"];
  delete raw["enabled_modules"]; // retired opt-in list
  delete raw["features"];
  raw.modules = selection.moduleIds;
  if (selection.error !== undefined) warnings.push(`WARNING: ${selection.error}`);
  warnings.push(...selection.warnings);
  return selection.error;
}

/** The workflow key owns the section; queue is its retired spelling, read here
 *  and nowhere downstream. Remove the queue conversion after 2026-12-18.
 *  `max_attempts` was `max_steps` until 2026-10-16; a section with both keeps
 *  `max_attempts`. Remove the max_steps conversion after 2027-04-30. */
function normalizeRetiredWorkflowSection(raw: UnknownObject): void {
  if (!Object.hasOwn(raw, "workflow") && Object.hasOwn(raw, "queue")) {
    raw.workflow = raw["queue"]; // retired spelling
  }
  delete raw["queue"]; // retired spelling
  const workflow = raw.workflow;
  if (!isRecord(workflow) || !Object.hasOwn(workflow, "max_steps")) return;
  if (!Object.hasOwn(workflow, "max_attempts")) workflow.max_attempts = workflow["max_steps"]; // retired spelling
  delete workflow["max_steps"]; // retired spelling
}

/** Rename each retired role id in every role table to its current id
 *  (refer to `canonicalRoleId`), so every reader after the file boundary
 *  sees one spelling of each seat. A table that holds both spellings keeps
 *  the current one. The startup rewrite writes the same names to the file
 *  (refer to `migrateModelAssignments`). */
function canonicalizeRoleKeys(raw: UnknownObject): void {
  const tables = profileRoleTables(raw).map(({ roles }) => roles);
  for (const roles of tables) {
    for (const roleId of Object.keys(roles)) {
      const current = canonicalRoleId(roleId);
      if (current === roleId) continue;
      if (!Object.hasOwn(roles, current)) roles[current] = roles[roleId];
      Reflect.deleteProperty(roles, roleId);
    }
  }
}

function stripRetiredOpenAIIdentity(raw: UnknownObject): void {
  delete raw["openai_auth"];
  delete raw["openai_email"];
}

/** intro_hints_seen_version recorded which release last showed the intro hints.
 *  Seeing a hint is not dismissing it, so the value carries nothing into
 *  tabs_hint_dismissed; it is dropped without an unknown-key warning.
 *  Remove the conversion after 2027-01-01. */
function stripRetiredIntroHintsVersion(raw: UnknownObject): void {
  delete raw["intro_hints_seen_version"]; // retired spelling
}

/** summarize_compaction chose between summary and reset compaction; reset is
 *  now the only compaction, so the value carries nothing forward.
 *  Remove the conversion after 2027-04-01. */
function stripRetiredCompactionConfig(raw: UnknownObject): void {
  delete raw["summarize_compaction"]; // retired setting
  const tables = profileRoleTables(raw).map(({ roles }) => roles);
  for (const roles of tables) {
    for (const roleId of Object.keys(roles)) {
      if (configRoleRetention(roleId) === "retired") Reflect.deleteProperty(roles, roleId);
    }
  }
}

/** A malformed external permission cannot authorize a persistent process. The
 * original file remains unchanged, so a later settings write can repair it. */
export function normalizePersistentProcessPermission(raw: UnknownObject, warnings: string[], diagnostics: ConfigDiagnostic[] = []): void {
  if (raw.allow_persistent_processes === undefined || typeof raw.allow_persistent_processes === "boolean") return;
  raw.allow_persistent_processes = false;
  warnings.push('WARNING: Invalid config value "allow_persistent_processes". Persistent processes stay off until flywheel.toml is corrected.');
  diagnostics.push({ kind: "setting", settingId: "allowPersistentProcesses", path: ["allow_persistent_processes"], reason: "normalized-value" });
}

function stripUnknownRoleKeys(raw: UnknownObject, warnings: string[]): void {
  for (const { profileId, roles: profileRoles } of profileRoleTables(raw)) {
    const profileInvalid = Object.keys(profileRoles).filter((roleId) => configRoleRetention(roleId) === "unknown");
    if (profileInvalid.length === 0) continue;
    for (const roleId of profileInvalid) Reflect.deleteProperty(profileRoles, roleId);
    warnings.push(`Pruned unknown role id(s) from [profiles.${profileId}.roles]: ${profileInvalid.join(", ")}. Delete them from flywheel.toml or define matching personas or briefs.`);
  }
}

// Remove with the retired brief conversion after 2027-04-30.
function warnRetiredBriefSettings(raw: UnknownObject, warnings: string[]): void {
  const tables = profileRoleTables(raw).map(({ profileId, roles }) => ({ path: `profiles.${profileId}.roles`, roles }));
  for (const { path, roles } of tables) {
    for (const roleId of objectKeys(roles)) {
      const workflowId = retiredBriefSeatWorkflow(roleId);
      if (workflowId !== undefined) {
        warnings.push(`The setting for "${roleId}" in [${path}] is kept. Its brief retired with the ${workflowId} workflow. Per-brief defaults no longer apply. Set the Workflow Agent default, or set this agent's model in its workflow session.`);
      } else if (roleId.startsWith("brief.")) {
        warnings.push(`The setting for "${roleId}" in [${path}] is kept. The default picker no longer lists briefs, and per-brief defaults no longer apply. Set the Workflow Agent default, or set this agent's model in its workflow session.`);
      }
    }
  }
}

function profileRoleTables(raw: UnknownObject): Array<{ profileId: string; roles: UnknownObject }> {
  if (!isRecord(raw.profiles)) return [];
  const tables: Array<{ profileId: string; roles: UnknownObject }> = [];
  for (const [profileId, profile] of Object.entries(raw.profiles)) {
    if (isRecord(profile) && isRecord(profile.roles)) tables.push({ profileId, roles: profile.roles });
  }
  return tables;
}

// The pre-router config schema let a role pin an access provider. Routing is
// now automatic, so the key is ignored instead of rejected: failing the whole
// config over a setting that no longer exists would break working setups.
function stripLegacyRoleProviderKeys(raw: UnknownObject, warnings: string[]): void {
  const tables = profileRoleTables(raw).map(({ profileId, roles }) => ({ path: `profiles.${profileId}.roles`, roles }));
  for (const { path, roles } of tables) {
    for (const [roleId, role] of Object.entries(roles)) {
      if (!isRecord(role) || !Object.hasOwn(role, "provider")) continue;
      Reflect.deleteProperty(role, "provider");
      warnings.push(`Ignored ${path}.${roleId}.provider: access-provider routing is now automatic. Delete the key from flywheel.toml.`);
    }
  }
}

function objectKeys(cause: unknown): string[] {
  return isRecord(cause) ? Object.keys(cause) : [];
}

/** Remove one authored key so a tolerated unknown key cannot fail the strict re-decode. */
function pruneRawPath(raw: UnknownObject, path: readonly string[]): void {
  const parent = path.slice(0, -1).reduce<unknown>((node, segment) => (isRecord(node) ? node[segment] : undefined), raw);
  const key = path[path.length - 1];
  // oxlint-disable-next-line typescript/no-dynamic-delete -- boundary: raw external TOML object, pruned once before decode; no hot path
  if (isRecord(parent) && key !== undefined) delete parent[key];
}

function unknownKeyWarning(path: readonly string[], guide: string): string {
  const siblings = recognizedSiblings(path.slice(0, -1));
  const recognized = siblings.length > 0 ? ` Recognized keys: ${siblings.join(", ")}.` : "";
  return `WARNING: Unrecognized config key "${displayConfigPath(path)}". The key is ignored.${recognized} Configuration reference: ${guide}`;
}

interface ConfigIssue {
  readonly path: readonly string[];
  readonly actual?: unknown;
  readonly unknownKey?: true;
  /** The section owner's own wording of a shape issue; it replaces the schema's line. */
  readonly message?: string;
}

/** The issues every installed module section explains about its own
 *  authored table, before the document is decoded. A schema issue under one
 *  of these paths is the same mismatch said worse, so the owner's line wins. */
function sectionOwnerIssues(raw: UnknownObject): ConfigIssue[] {
  return installedConfigSections().flatMap((section) => section.ownerIssues?.(raw[section.key]) ?? []);
}

function cacheRetentionIssues(raw: UnknownObject): ConfigIssue[] {
  if (!isRecord(raw.cache_retention)) return [];
  const declared = new Map(installedModules().flatMap((module) => module.contributions.flatMap((contribution) =>
    contribution.domain === "providers" ? [[contribution.id, contribution.value.definition.cacheRetentionPolicies] as const] : [])));
  return Object.entries(raw.cache_retention).flatMap(([provider, value]) => {
    const policies = declared.get(provider);
    if (policies?.some((policy) => policy === value)) return [];
    return [{
      path: ["cache_retention", provider],
      actual: value,
      message: policies === undefined
        ? "This provider has no configurable cache-retention policy."
        : `Allowed policies: ${policies.join(", ")}.`,
    }];
  });
}

function collectSchemaIssues(issue: unknown, prefix: readonly string[] = []): ConfigIssue[] {
  if (!isRecord(issue)) return [];
  if (issue._tag === "Pointer" && Array.isArray(issue.path)) {
    const path = issue.path.filter((part): part is string | number => typeof part === "string" || typeof part === "number").map(String);
    return collectSchemaIssues(issue.issue, [...prefix, ...path]);
  }
  if (Array.isArray(issue.issues) && issue.issues.length > 0) return issue.issues.flatMap((child) => collectSchemaIssues(child, prefix));
  if (isRecord(issue.issue)) return collectSchemaIssues(issue.issue, prefix);
  if (issue._tag === "UnexpectedKey") return [{ path: prefix, actual: issue.actual, unknownKey: true }];
  const actual = isRecord(issue.actual) && issue.actual._tag === "Some" ? issue.actual.value : isRecord(issue.actual) ? undefined : issue.actual;
  return [{ path: prefix, ...(actual === undefined ? {} : { actual }) }];
}

function diagnosticsForIssues(issues: readonly ConfigIssue[]): ConfigDiagnostic[] {
  const diagnostics = new Map<string, ConfigDiagnostic>();
  for (const issue of issues) {
    const definition = PERSISTED_SETTING_DEFINITIONS.find((candidate) =>
      candidate.presentation.kind !== "none"
      && candidate.path.length === issue.path.length
      && candidate.path.every((segment, index) => segment === issue.path[index]));
    const diagnostic: ConfigDiagnostic = definition === undefined || !isPersistedSettingId(definition.id)
      ? { kind: "document", reason: "unmapped-setting" }
      : { kind: "setting", settingId: definition.id, path: definition.path, reason: "invalid-value" };
    diagnostics.set(diagnostic.kind === "setting" ? diagnostic.settingId : diagnostic.reason, diagnostic);
  }
  return [...diagnostics.values()];
}

function mergeDiagnostics(...groups: readonly (readonly ConfigDiagnostic[])[]): ConfigDiagnostic[] {
  const merged = new Map<string, ConfigDiagnostic>();
  for (const diagnostic of groups.flat()) {
    const key = diagnostic.kind === "setting"
      ? `${diagnostic.kind}:${diagnostic.settingId}:${diagnostic.reason}`
      : `${diagnostic.kind}:${diagnostic.reason}`;
    merged.set(key, diagnostic);
  }
  return [...merged.values()];
}

function formatValidationIssues(issues: readonly ConfigIssue[], guide: string): string {
  const unique = new Map<string, ConfigIssue>();
  for (const issue of issues) {
    const key = issue.path.join("\u0000");
    if (!unique.has(key)) unique.set(key, issue);
  }
  const lines = [...unique.values()]
    .toSorted((left, right) => comparePaths(displayConfigPath(left.path), displayConfigPath(right.path)))
    .map(formatIssue);
  return `Invalid configuration:\n${lines.join("\n")}\n\nConfiguration reference: ${guide}`;
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isDescendant(path: readonly string[], parent: readonly string[]): boolean {
  return path.length > parent.length && parent.every((segment, index) => path[index] === segment);
}

function formatIssue(issue: ConfigIssue): string {
  const entry = configReferenceEntry(issue.path);
  const path = displayConfigPath(issue.path);
  const found = safeFound(issue.actual, entry);
  if (issue.message !== undefined) return `- ${path}: ${issue.message}`;
  if (issue.unknownKey) {
    const siblings = recognizedSiblings(issue.path.slice(0, -1));
    return `- ${path}: found ${found}; recognized keys: ${siblings.length > 0 ? siblings.join(", ") : "none"}; default: not applicable.`;
  }
  return `- ${path}: found ${found}; expected ${entry?.type ?? "a recognized configuration value"}${allowed(entry)}; default: ${defaultText(entry)}.`;
}

function recognizedSiblings(parent: readonly string[]): string[] {
  const names = new Set<string>();
  for (const entry of configReference().entries) {
    if (entry.schemaSegments.length <= parent.length) continue;
    if (!parent.every((segment, index) => entry.schemaSegments[index] === "*" || entry.schemaSegments[index] === segment)) continue;
    const name = entry.authoredSegments[parent.length];
    if (name !== undefined && name !== "*") names.add(name);
  }
  return [...names].toSorted();
}

function allowed(entry: ConfigReferenceEntry | undefined): string {
  const values = entry?.constraints?.enum;
  if (Array.isArray(values) && values.every((value) => typeof value === "string" || typeof value === "number" || typeof value === "boolean")) {
    return `; allowed values: ${values.map(String).join(", ")}`;
  }
  const minimum = numericConstraint(entry?.constraints, "minimum");
  const maximum = numericConstraint(entry?.constraints, "maximum");
  if (minimum !== undefined || maximum !== undefined) return `; allowed range: ${minimum ?? "unbounded"} to ${maximum ?? "unbounded"}`;
  return "";
}

function numericConstraint(value: unknown, key: "minimum" | "maximum"): number | undefined {
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = numericConstraint(child, key);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (typeof value[key] === "number") return value[key];
  for (const child of Object.values(value)) {
    const found = numericConstraint(child, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function defaultText(entry: ConfigReferenceEntry | undefined): string {
  if (entry?.sensitivity !== "public" || entry.defaultState.kind !== "decoded") return "not applicable";
  const value = entry.defaultState.value;
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? JSON.stringify(value) : "not applicable";
}

function safeFound(value: unknown, entry: ConfigReferenceEntry | undefined): string {
  if (entry?.sensitivity === "public" && (typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null)) {
    return JSON.stringify(value);
  }
  return safeType(value);
}

function safeType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (isRecord(value)) return "table";
  return value === undefined ? "missing value" : typeof value;
}

function readTomlFile(filePath: string, userDataRoot: string): string {
  const absPath = resolve(filePath);
  try {
    const content = readConfigFile(absPath);
    if (content === undefined) throw new ConfigLoadError(`Config file not found: ${absPath}`, "FILE_NOT_FOUND");
    if (!hasRetiredConfigTables(content)) return content;
    return withConfigOwnershipBlocking({ configPath: absPath }, (ownership) => {
      const read = retireConfigTables(ownership, (candidate) => {
        const decoded = decodeCanonicalConfigText(candidate, {}, undefined, absPath);
        if (decoded.moduleError !== undefined) throw new ConfigLoadError(decoded.moduleError, "VALIDATION");
      }, { configPath: absPath, userDataRoot });
      if (read.kind === "failure") throw new ConfigLoadError(`Cannot read config file: ${absPath}`, "FILE_READ_ERROR");
      return read.kind === "text" ? read.text : "";
    });
  } catch (err) {
    if (err instanceof ConfigLoadError) throw err;
    throw new ConfigLoadError(`Cannot read config file: ${absPath} (${errorMessage(err)})`, "FILE_READ_ERROR");
  }
}

function parseTomlText(content: string, guide: string, diagnosticPath?: string): UnknownObject {
  try {
    const parsed = content.length === 0 ? {} : Bun.TOML.parse(content);
    if (!isRecord(parsed)) throw new ConfigLoadError(`Config file is not a table\n\nConfiguration reference: ${guide}`, "PARSE_ERROR", [{ kind: "document", reason: "toml-syntax" }]);
    return parsed;
  } catch (err) {
    if (err instanceof ConfigLoadError) throw err;
    const line = provenTomlErrorLine(content);
    throw new ConfigLoadError(
      `Failed to parse config file${diagnosticPath === undefined ? "" : ` ${diagnosticPath}`}${line === undefined ? "" : ` at line ${line}`}\n\nConfiguration reference: ${guide}`,
      "PARSE_ERROR",
      [{ kind: "document", reason: "toml-syntax", ...(line === undefined ? {} : { line }) }],
    );
  }
}

function provenTomlErrorLine(content: string): number | undefined {
  const lines = content.split("\n");
  let lastValid = 0;
  for (let index = 1; index <= lines.length; index += 1) {
    try {
      Bun.TOML.parse(lines.slice(0, index).join("\n"));
      lastValid = index;
    } catch (error) {
      if (isIncompleteTomlPrefix(error)) continue;
      if (lastValid === index - 1) return index;
    }
  }
  return undefined;
}

function isIncompleteTomlPrefix(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes("unterminated") || message.includes("to close a table header");
}

function isRecord(cause: unknown): cause is UnknownObject {
  return cause !== null && typeof cause === "object" && !Array.isArray(cause);
}

function deepMerge(
  target: UnknownObject,
  source: UnknownObject,
) {
  const result = { ...target };
  for (const [key, val] of Object.entries(source)) {
    const existing = result[key];
    if (isRecord(val) && isRecord(existing)) {
      result[key] = deepMerge(existing, val);
    } else {
      result[key] = val;
    }
  }
  return result;
}
