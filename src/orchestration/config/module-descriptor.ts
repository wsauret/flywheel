import { effectiveModuleIds, installedRetiredModuleConfig, migrateLegacyCapabilityModules, moduleSelectionFromConfig, selectionPolicyError, workflowsModeOf, type ModuleId } from "../modules.js";
import type { WorkflowsMode } from "../../protocol/module-protocol-types.js";

import { canonicalModuleIds, MODULE_IDS } from "../../protocol/module-ids.js";
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
  const statedField = hasFeatures ? "features" : hasDisabled ? "disabled_modules" : Object.hasOwn(parsed, "enabled_modules") ? "enabled_modules" : Object.hasOwn(parsed, "capability_modules") ? "capability_modules" : "modules"; // retired spellings
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
