import { dirname } from "node:path";
import { AuthProfileStore, findLogicalAuthProfile } from "../../infra/auth/auth-profile-store.js";
import { Log } from "../../infra/log.js";
import { removeSemanticSubtree, upsertSemanticAssignment } from "./config-assignment.js";
import type { ConfigFileLocation, ConfigOwnership, ConfigReadResult } from "./config-file.js";
import { canonicalRoleId } from "./retired-config-names.js";
import { configRoleRetention, parentRoleId } from "./roles.js";

// Remove after 2027-10-16, when account-wide roles and model effort memory leave the compatibility window.
export function hasRetiredConfigTables(source: string): boolean {
  return retiredConfigTables(source).length > 0;
}

function retiredConfigTables(source: string): readonly ("roles" | "model_efforts")[] {
  try {
    const parsed: unknown = Bun.TOML.parse(source);
    return isRecord(parsed) ? (["roles", "model_efforts"] as const).filter((key) => Object.hasOwn(parsed, key)) : [];
  } catch {
    return [];
  }
}

/** Convert under already-held ownership. Validation precedes publication; returned text is committed, never a candidate. */
export function retireConfigTables(ownership: ConfigOwnership, validate: (text: string) => void, location: ConfigFileLocation): ConfigReadResult {
  const read = ownership.read();
  if (read.kind !== "text") return read;
  const tables = retiredConfigTables(read.text);
  if (tables.length === 0) return read;
  let next = tables.reduce((text, key) => removeSemanticSubtree(text, [key]), read.text);
  if (tables.includes("roles")) next = moveRootRoles(read.text, next, location);
  validate(next);
  const durability = ownership.write(next);
  for (const table of tables) {
    Log.create({ service: "config" }).warn(table === "roles"
      ? "Moved retired account-wide role settings into the auth profiles."
      : "Removed retired per-model effort memory; effort belongs to each role.", {
      code: table === "roles" ? "config-root-roles-retired" : "config-model-efforts-retired",
      ...(durability === undefined ? {} : { durability: "unconfirmed" }),
    });
  }
  return ownership.read();
}

function moveRootRoles(source: string, stripped: string, location: ConfigFileLocation): string {
  let next = stripped;
  const parsed: unknown = Bun.TOML.parse(source);
  if (!isRecord(parsed) || !isRecord(parsed.roles)) return next;
  const rootRoles = parsed.roles;
  const userDataRoot = location.userDataRoot ?? (location.configPath === undefined ? undefined : dirname(location.configPath));
  if (userDataRoot === undefined) throw new Error("config retirement requires an account data root or config path");
  const inspection = new AuthProfileStore(userDataRoot).inspect();
  const profiles = [...inspection.profiles];
  const logicalDefault = findLogicalAuthProfile(profiles, inspection.retirements, "default");
  if (logicalDefault !== undefined && !profiles.some(({ id }) => id === logicalDefault.id)) profiles.push(logicalDefault);
  for (const { id } of profiles) {
    const profile = isRecord(parsed.profiles) ? parsed.profiles[id] : undefined;
    const overrides = new Set(isRecord(profile) && isRecord(profile.roles) ? Object.keys(profile.roles).map(canonicalRoleId) : []);
    for (const [roleId, role] of Object.entries(rootRoles)) {
      const current = canonicalRoleId(roleId);
      if (configRoleRetention(current) !== "retained") continue;
      const parent = parentRoleId(current);
      // Original profile entries outrank both root entries; a copied root parent does not.
      if (overrides.has(current) || (parent !== undefined && overrides.has(parent))) continue;
      if ((current !== roleId && Object.hasOwn(rootRoles, current)) || !isRecord(role)) continue;
      // v0.0.12 selected a whole profile entry, not individual fields.
      for (const field of ["model", "effort"]) {
        if (role[field] !== undefined) next = upsertSemanticAssignment(next, ["profiles", id, "roles", current, field], JSON.stringify(role[field]));
      }
    }
  }
  return next;
}

function isRecord(value: unknown): value is { [key: string]: unknown } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
