import { installedConfigSections } from "../module-catalog.js";
import type { FlywheelConfig } from "../config/schema.js";
import type { RuntimeConfigSnapshot } from "../config/runtime-config-owner.js";
import { profileRoleSettings } from "../config/env.js";

export interface RuntimeConfigRequestCapture {
  readonly revision: number;
  readonly profileId: string;
  readonly foregroundBashHoldSeconds: FlywheelConfig["foreground_bash_hold_seconds"];
  readonly webSearchProvider: FlywheelConfig["web_search"]["provider"];
  readonly proactiveCompactionThreshold: FlywheelConfig["proactive_compaction_threshold"];
  readonly idleCompaction: FlywheelConfig["idle_compaction"];
  readonly cacheRetentionPolicies: FlywheelConfig["cache_retention"];
  /** The profile's provider-scoped numeric settings as authored, keyed by
   *  provider then setting; a provider module fills its own defaults. */
  readonly providerSettings: FlywheelConfig["profiles"][string]["providers"];
  readonly allowPersistentProcesses: FlywheelConfig["allow_persistent_processes"];
  readonly shellWriteGuard: FlywheelConfig["shell_write_guard"];
  readonly profileRoles: FlywheelConfig["profiles"][string]["roles"];
  readonly gitAiAttribution: boolean;
  readonly allowTrainingRoutes: boolean;
  readonly budget: FlywheelConfig["budget"];
  readonly workflow: FlywheelConfig["workflow"];
  readonly moduleSections: { readonly [section: string]: unknown };
}

export type CaptureRuntimeConfig = () => RuntimeConfigRequestCapture;

/** Captures next-request policies, combining persisted permission with the invocation-only CLI override without changing config. */
export function captureRuntimeConfigRequest(snapshot: RuntimeConfigSnapshot, effectiveProfileId: string, persistentProcessesForcedByCli = false): RuntimeConfigRequestCapture {
  const { config } = snapshot;
  const profile = config.profiles[effectiveProfileId];
  return deepFreeze(structuredClone({
    revision: snapshot.revision,
    profileId: effectiveProfileId,
    foregroundBashHoldSeconds: config.foreground_bash_hold_seconds,
    webSearchProvider: config.web_search.provider,
    proactiveCompactionThreshold: config.proactive_compaction_threshold,
    idleCompaction: config.idle_compaction,
    cacheRetentionPolicies: config.cache_retention,
    providerSettings: profile?.providers ?? {},
    allowPersistentProcesses: config.allow_persistent_processes || persistentProcessesForcedByCli,
    shellWriteGuard: config.shell_write_guard,
    profileRoles: profileRoleSettings(profile?.roles),
    gitAiAttribution: profile?.git_ai_attribution ?? false,
    allowTrainingRoutes: profile?.allow_training_routes ?? false,
    budget: config.budget,
    workflow: config.workflow,
    moduleSections: captureModuleRequestSections(config),
  }));
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

/** Only owner-declared nonsensitive projections enter request evidence. */
export function captureModuleRequestSections(config: FlywheelConfig): { readonly [section: string]: unknown } {
  const sections: { readonly [key: string]: unknown } = config;
  return Object.fromEntries(installedConfigSections().flatMap((section) => section.requestCapture ? [[section.key, section.requestCapture(sections[section.key])]] : []));
}
