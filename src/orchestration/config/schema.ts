import { Schema } from "effect";
import type { FirstPartyModule } from "../modules.js";
import { installedConfigSections, installedModules } from "../module-catalog.js";
import {
  DEFINITION_OWNED_SCHEMA_FIELDS,
  PERSISTED_SETTING_DEFINITIONS,
  RETAINED_CONFIG_SCHEMA_FIELDS,
  RETAINED_CONFIG_SECTION_DEFINITIONS,
} from "./setting-definitions.js";

/** The kernel's own configuration: every root key the kernel owns. A module
 *  section rides beside these under its own key, decoded by the section's
 *  schema and read through `configSection`. */
export const FlywheelConfigSchema = Schema.Struct({
  ...DEFINITION_OWNED_SCHEMA_FIELDS,
  ...RETAINED_CONFIG_SCHEMA_FIELDS,
});

export type FlywheelConfig = typeof FlywheelConfigSchema.Type;
export type DiffColorMode = FlywheelConfig["diff_colors"];
export type CompatibleRenderingMode = FlywheelConfig["compatible_rendering"];
export type WebSearchProvider = FlywheelConfig["web_search"]["provider"];


export const CONFIG_DEFAULTS: FlywheelConfig = Schema.decodeUnknownSync(FlywheelConfigSchema)({});

/** Root keys the loader recognizes, in their persisted ownership order: the
 *  kernel's, then one per config contribution of the installed catalog. */
export function flywheelConfigKeys(modules: readonly FirstPartyModule[] = installedModules()): readonly string[] {
  return [
    ...new Set(PERSISTED_SETTING_DEFINITIONS.map((definition) => definition.path[0])),
    ...RETAINED_CONFIG_SECTION_DEFINITIONS.map((definition) => definition.key),
    ...installedConfigSections(modules).map((section) => section.key),
  ];
}

function composeConfigSchema(modules: readonly FirstPartyModule[]) {
  return Schema.Struct({
    ...FlywheelConfigSchema.fields,
    ...Object.fromEntries(installedConfigSections(modules).map((section) => [section.key, section.schema])),
  });
}

let installedSchema: ReturnType<typeof composeConfigSchema> | undefined;

/** The schema the loader decodes a document with: the kernel's fields beside
 *  every installed module's section. Composed on first read, after the
 *  catalog is installed; a catalog other than the installed one is a test's. */
export function installedConfigSchema(modules?: readonly FirstPartyModule[]): ReturnType<typeof composeConfigSchema> {
  if (modules) return composeConfigSchema(modules);
  installedSchema ??= composeConfigSchema(installedModules());
  return installedSchema;
}
