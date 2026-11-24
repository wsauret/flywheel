import { Schema } from "effect";
import type { ProtocolExposure, SettingApplication } from "./setting-definitions.js";
import { installedModules } from "../../module-catalog.js";
import type { FirstPartyModule } from "../../modules.js";

/** The module-facing half of the configuration file: what a module declares
 *  to own one retained section through its `config` contribution (ARCH-RUNTIME-064),
 *  the one typed read of that section, and the sections the installed catalog
 *  contributes. A leaf on purpose: a module home imports this and never the
 *  catalog-composing files of the config layer, which import the module
 *  registry. It reads only the light installed catalog. */

/** One issue a section owner explains in its own words, at the authored path. */
export interface ConfigOwnerIssue {
  readonly path: readonly string[];
  readonly message: string;
}

/** A retained section of `flywheel.toml` a module owns: the section's schema,
 *  which decodes its absence to the section's own default; the owner
 *  diagnostics name; how a change applies; and whether the section carries
 *  secrets. A module section is never part of the kernel config view, so a
 *  module that declares a UI-safe settings row exposes only that declared
 *  key through the generic module settings projection. `ownerIssues` lets the owner explain a table its schema
 *  can only reject as a union mismatch, in its own words, before the document
 *  is decoded. */
export interface ModuleConfigSection<S extends Schema.Top = Schema.Top> {
  readonly key: string;
  readonly schema: S;
  readonly owner: string;
  readonly applications: readonly [SettingApplication, ...SettingApplication[]];
  readonly protocolExposure: ProtocolExposure;
  /** Defaults to author on first seed, with exact retired values the owner replaces. */
  readonly seeds?: readonly { readonly key: string; readonly value: readonly number[]; readonly replaces?: readonly (readonly number[])[] }[];
  /** Explicit nonsensitive request evidence. Sections without this projection never enter a request snapshot. */
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- boundary: the decoded section crosses the module registry, which erases its type
  readonly requestCapture?: (value: unknown) => Schema.Json;
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- boundary: the module's table as the config file authors it, which the owner decodes
  readonly ownerIssues?: (raw: unknown) => readonly ConfigOwnerIssue[];
}

/** The decoded value of one module's config section. A config the loader
 *  built carries the section under its key; one built from the kernel schema
 *  alone (the defaults, a test's) holds none, and the section's own schema
 *  decodes that absence to its default. Decoding here is the strict read of
 *  current state: the section's schema is the one authority on both shapes. */
export function configSection<S extends Schema.Top & Schema.Decoder<unknown, never>>(config: { readonly [key: string]: unknown }, section: ModuleConfigSection<S>): S["Type"] {
  const sections: { readonly [key: string]: unknown } = config;
  return Schema.decodeUnknownSync(section.schema)(sections[section.key]);
}

/** Every config section the installed catalog contributes, whether or not a
 *  project enables the owner: the loader decodes them all, so a section a
 *  disabled module owns keeps its bytes and its meaning, and only the module's
 *  service reads it while the module is on. */
export function installedConfigSections(modules: readonly FirstPartyModule[] = installedModules()): readonly ModuleConfigSection[] {
  return modules.flatMap((module) => module.contributions.flatMap((contribution) => {
    if (contribution.domain !== "config") return [];
    if (contribution.id !== contribution.value.key) throw new Error(`Config contribution id ${contribution.id} must equal its section key ${contribution.value.key}`);
    return [contribution.value];
  }));
}
