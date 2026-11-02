import { resolve } from "node:path";
import { AuthProfileStore, findLogicalAuthProfile, type AuthProfileAccess, type AuthProfileDescriptor, type AuthProfileInspection, type AuthProfileOperation, type AuthProfilePreRemove } from "../../infra/auth/auth-profile-store.js";
import type { AuthProfileRetirements } from "../../infra/auth/auth-profile-retirements.js";
import { authDir, globalConfigFile, requireAuthProfileDisplayName, requireAuthProfileName } from "../../infra/paths.js";
import { readConfigFile } from "../config/config-file.js";
import { loadConfig } from "../config/loader.js";
import { CONFIG_DEFAULTS, type FlywheelConfig } from "../config/schema.js";
import { migrateRootProviderSettings, removeAuthProjectProfile, retireAuthProfileConfig, setAuthProjectProfile, type ConfigWriteResult } from "../config/writer.js";

const DEFAULT_PROFILE = "default";
const AUTH_PROFILE_ENV = "FLYWHEEL_AUTH_PROFILE";

type AuthProfileSource = "environment" | "project" | "sticky" | "default";

export interface AuthProfileResolution {
  readonly id: string;
  readonly persistedId: string;
  readonly displayName: string;
  readonly source: AuthProfileSource;
  readonly directory: string;
  readonly availableProfiles: readonly AuthProfileDescriptor[];
  readonly projectBinding: string | undefined;
  readonly retirements: AuthProfileRetirements;
}

export type AuthProfileDeletionPreview =
  | { readonly kind: "fresh-default"; readonly source: AuthProfileDescriptor }
  | { readonly kind: "automatic"; readonly source: AuthProfileDescriptor; readonly successor: AuthProfileDescriptor }
  | { readonly kind: "choose"; readonly source: AuthProfileDescriptor; readonly candidates: readonly AuthProfileDescriptor[] };

export type AuthProfileDeletionResult = ConfigWriteResult & {
  readonly successorId: string;
  readonly createdDefault: boolean;
};

export interface AuthProfileManagerOptions {
  readonly userDataRoot: string;
  readonly projectRoot: string;
  readonly configPath?: string;
  readonly env?: { readonly [key: string]: string | undefined };
  readonly store?: AuthProfileStore;
  readonly config?: () => Pick<FlywheelConfig, "auth">;
}

/** A create or rename would make display-name selection ambiguous. */
export class AuthProfileDisplayNameConflictError extends Error {
  readonly _tag = "AuthProfileDisplayNameConflictError" as const;
  readonly displayName: string;

  constructor(displayName: string) {
    super(`auth profile display name already exists: ${displayName}`);
    this.displayName = displayName;
  }
}

/** Owns stable profile-id selection and mutable display names. */
export class AuthProfileManager {
  readonly #userDataRoot: string;
  readonly #projectRoot: string;
  readonly #configPath: string | undefined;
  readonly #environmentSelector: string | undefined;
  readonly #store: AuthProfileStore;
  readonly #configSnapshot: (() => Pick<FlywheelConfig, "auth">) | undefined;

  constructor(options: AuthProfileManagerOptions) {
    this.#userDataRoot = options.userDataRoot;
    this.#projectRoot = resolve(options.projectRoot);
    this.#configPath = options.configPath;
    this.#environmentSelector = (options.env ?? process.env)[AUTH_PROFILE_ENV];
    this.#store = options.store ?? new AuthProfileStore(options.userDataRoot);
    this.#configSnapshot = options.config;
  }

  async resolve(): Promise<AuthProfileResolution> {
    return this.#store.withOperation((operation) => this.#resolve({
      profiles: operation.list(),
      stickyProfile: operation.readStickyProfile(),
      retirements: operation.retirements(),
    }));
  }

  /** Resolve the effective profile without changing the auth store. */
  inspect(): AuthProfileResolution {
    return this.#resolve(this.#store.inspect());
  }

  /** Move the retired account-global provider settings under every auth profile while holding the canonical profile operation lock. */
  async migrateProviderSettings(): Promise<ConfigWriteResult> {
    return this.#store.withOperation((operation) => {
      const stored = operation.list().map(({ id }) => id);
      const profiles = stored.includes(DEFAULT_PROFILE) || operation.retirements()[DEFAULT_PROFILE] !== undefined ? stored : [DEFAULT_PROFILE, ...stored];
      return migrateRootProviderSettings(profiles, this.#configLocation());
    });
  }

  /** Admit the effective immutable profile directory. A missing implicit default
   * can be created for first login. */
  async acquireAccess(options: { readonly createDefault?: boolean } = {}): Promise<AuthProfileAccess> {
    return this.#store.withOperation((operation) => {
      const resolution = this.#resolve({
        profiles: operation.list(),
        stickyProfile: operation.readStickyProfile(),
        retirements: operation.retirements(),
      });
      const access = operation.open(resolution.id);
      if (access !== undefined) return access;
      const sticky = operation.readStickyProfile();
      // The implicit Default exists only in name until its first use. An
      // environment selector that names it asks for it as plainly as having
      // no selection at all does.
      const namesImplicitDefault = resolution.source === "environment" || (resolution.projectBinding === undefined && (sticky === undefined || sticky === DEFAULT_PROFILE));
      if (options.createDefault === true && resolution.id === DEFAULT_PROFILE && namesImplicitDefault) {
        return operation.create(DEFAULT_PROFILE);
      }
      throw new Error(`auth profile does not exist: ${resolution.id}`);
    });
  }

  async create(displayName: string): Promise<string> {
    requireAuthProfileDisplayName(displayName);
    return this.#store.withOperation((operation) => {
      const profiles = operation.list();
      assertUniqueDisplayName(profiles, displayName);
      const id = availableProfileId(this.#reservedIds(operation), displayName);
      operation.create(id, displayName).close();
      return id;
    });
  }

  async select(id: string): Promise<void> {
    requireAuthProfileName(id);
    if (this.#environmentSelector !== undefined) throw new Error("cannot switch the environment-selected auth profile");
    await this.#store.withOperation((operation) => {
      if (!operation.list().some((profile) => profile.id === id)) throw new Error(`auth profile does not exist: ${id}`);
      operation.writeStickyProfile(id);
    });
  }

  async bind(id: string): Promise<ConfigWriteResult> {
    requireAuthProfileName(id);
    return this.#store.withOperation((operation) => {
      if (!operation.list().some((profile) => profile.id === id)) throw new Error(`auth profile does not exist: ${id}`);
      return setAuthProjectProfile(this.#projectRoot, id, this.#configLocation());
    });
  }

  async unbind(): Promise<ConfigWriteResult> {
    return this.#store.withOperation(() => removeAuthProjectProfile(this.#projectRoot, this.#configLocation()));
  }

  async rename(id: string, displayName: string): Promise<void> {
    requireAuthProfileName(id);
    requireAuthProfileDisplayName(displayName);
    await this.#store.withOperation((operation) => {
      const profiles = operation.list();
      if (!profiles.some((profile) => profile.id === id)) throw new Error(`auth profile does not exist: ${id}`);
      const environmentId = this.#environmentSelector === undefined ? undefined : resolveEnvironmentProfile(operation.retirements()[this.#environmentSelector] ?? this.#environmentSelector, profiles).id;
      if (environmentId === id) throw new Error("cannot rename the environment-selected auth profile");
      assertUniqueDisplayName(profiles, displayName, id);
      operation.rename(id, displayName);
    });
  }

  /** Describe the current stored survivors. Confirmation must pass its exact successor to delete. */
  async previewDelete(id: string): Promise<AuthProfileDeletionPreview> {
    return this.#store.withOperation((operation) => this.#deletionPreview(id, operation));
  }

  /** Confirm an exact successor id, or null for a fresh Default only when no survivor exists.
   * Publish a durable transfer, then clean config, sticky selection and the source tree.
   * Repeating a retired id resumes cleanup using its recorded successor, never a new selection. */
  async delete(id: string, preRemove: AuthProfilePreRemove | undefined, successorId: string | null): Promise<AuthProfileDeletionResult> {
    requireAuthProfileName(id);
    return this.#store.withOperation(async (operation) => {
      let destination = operation.retirements()[id];
      let createdDefault = false;
      if (destination === undefined) {
        const preview = this.#deletionPreview(id, operation);
        if (successorId !== null) {
          if (!operation.list().some((profile) => profile.id === successorId && profile.id !== id)) throw new Error(`auth profile transfer destination does not exist: ${successorId}`);
          destination = successorId;
        } else if (preview.kind !== "fresh-default") {
          throw new Error("auth profile deletion preview changed; choose a destination from a fresh preview");
        } else {
          destination = availableProfileId([...this.#reservedIds(operation), id], "Default");
          createdDefault = true;
        }
        try {
          if (createdDefault) operation.create(destination, "Default").close();
          operation.retire(id, destination);
        } catch (error) {
          // Publication can succeed before directory sync fails. Never erase that successor.
          if (createdDefault && operation.retirements()[id] === undefined) await operation.discardUnpublished(destination);
          throw error;
        }
      } else if (successorId !== null && (operation.retirements()[successorId] ?? successorId) !== destination) {
        throw new Error("auth profile transfer already committed to another destination");
      }
      const sticky = operation.readStickyProfile();
      const result = retireAuthProfileConfig(id, destination, this.#configLocation());
      const transfer = { successorId: destination, createdDefault };
      if (!result.ok) return { ...result, ...transfer };
      if (result.durabilityError !== undefined) return { ok: false, error: result.durabilityError, ...transfer };
      if (sticky === id || (createdDefault && sticky === undefined)) operation.writeStickyProfile(destination);
      await operation.delete(id, preRemove);
      return { ...result, ...transfer };
    });
  }

  #deletionPreview(id: string, operation: AuthProfileOperation): AuthProfileDeletionPreview {
    requireAuthProfileName(id);
    const profiles = operation.list();
    const source = findLogicalAuthProfile(profiles, operation.retirements(), id);
    if (source === undefined) throw new Error(`auth profile does not exist: ${id}`);
    const candidatesForEnvironment = profiles.some((profile) => profile.id === source.id) ? profiles : [source, ...profiles];
    if (this.#environmentSelector !== undefined && resolveEnvironmentProfile(operation.retirements()[this.#environmentSelector] ?? this.#environmentSelector, candidatesForEnvironment).id === id) throw new Error("cannot delete the environment-selected auth profile; unset FLYWHEEL_AUTH_PROFILE and try again");
    const candidates = profiles.filter((profile) => profile.id !== id);
    const successor = candidates[0];
    return successor === undefined ? { kind: "fresh-default", source }
      : candidates.length === 1 ? { kind: "automatic", source, successor }
        : { kind: "choose", source, candidates };
  }

  #reservedIds(operation: AuthProfileOperation): readonly string[] {
    const config = readConfigFile(this.#configPath ?? globalConfigFile(this.#userDataRoot));
    const parsed = config === undefined ? undefined : Bun.TOML.parse(config);
    const configured = parsed !== null && typeof parsed === "object" && "profiles" in parsed ? parsed.profiles : undefined;
    const configuredIds = configured !== null && typeof configured === "object" ? Object.keys(configured) : [];
    return [...operation.list().map((profile) => profile.id), ...Object.keys(operation.retirements()), ...configuredIds];
  }

  #resolve(inspection: AuthProfileInspection): AuthProfileResolution {
    const storedProfiles = inspection.profiles;
    const canonical = (id: string): string => inspection.retirements[id] ?? id;
    const resolutionProfiles = storedProfiles.some((profile) => profile.id === DEFAULT_PROFILE) || inspection.retirements[DEFAULT_PROFILE] !== undefined
      ? storedProfiles
      : [{ id: DEFAULT_PROFILE, displayName: "Default" }, ...storedProfiles];
    const binding = this.#config().auth.project_profiles[this.#projectRoot];
    const projectBinding = binding === undefined ? undefined : canonical(binding);
    const sticky = inspection.stickyProfile === undefined ? undefined : canonical(inspection.stickyProfile);
    const persistedId = projectBinding ?? sticky ?? canonical(DEFAULT_PROFILE);
    const selected = this.#environmentSelector !== undefined
      ? { ...resolveEnvironmentProfile(canonical(this.#environmentSelector), resolutionProfiles), source: "environment" as const }
      : projectBinding !== undefined
        ? { id: projectBinding, displayName: displayNameOf(resolutionProfiles, projectBinding), source: "project" as const }
        : sticky !== undefined
          ? { id: sticky, displayName: displayNameOf(resolutionProfiles, sticky), source: "sticky" as const }
          : { id: canonical(DEFAULT_PROFILE), displayName: displayNameOf(resolutionProfiles, canonical(DEFAULT_PROFILE)), source: "default" as const };
    const availableProfiles = storedProfiles.some((profile) => profile.id === DEFAULT_PROFILE) || selected.id === DEFAULT_PROFILE || storedProfiles.length === 0
      ? resolutionProfiles
      : storedProfiles;
    return Object.freeze({
      ...selected,
      persistedId,
      directory: authDir(this.#userDataRoot, selected.id),
      availableProfiles: Object.freeze([...availableProfiles]),
      projectBinding,
      retirements: inspection.retirements,
    });
  }

  #config(): Pick<FlywheelConfig, "auth"> {
    if (this.#configSnapshot !== undefined) return this.#configSnapshot();
    const path = this.#configPath ?? globalConfigFile(this.#userDataRoot);
    return readConfigFile(path) === undefined ? CONFIG_DEFAULTS : loadConfig(path, {}).config;
  }

  #configLocation(): { readonly userDataRoot?: string; readonly configPath?: string } {
    return this.#configPath === undefined ? { userDataRoot: this.#userDataRoot } : { configPath: this.#configPath };
  }
}

function resolveEnvironmentProfile(selector: string, profiles: readonly AuthProfileDescriptor[]): Pick<AuthProfileDescriptor, "id" | "displayName"> {
  const exact = profiles.find((profile) => profile.id === selector);
  if (exact !== undefined) return exact;
  const matches = profiles.filter((profile) => profile.displayName.toLowerCase() === selector.toLowerCase());
  return matches.length === 1 ? matches[0] ?? { id: selector, displayName: selector } : { id: selector, displayName: selector };
}

function displayNameOf(profiles: readonly AuthProfileDescriptor[], id: string): string {
  return profiles.find((profile) => profile.id === id)?.displayName ?? (id === DEFAULT_PROFILE ? "Default" : id);
}

function assertUniqueDisplayName(profiles: readonly AuthProfileDescriptor[], displayName: string, exceptId?: string): void {
  const normalized = displayName.toLowerCase();
  if (profiles.some((profile) => profile.id !== exceptId && profile.displayName.toLowerCase() === normalized)) throw new AuthProfileDisplayNameConflictError(displayName);
}

function availableProfileId(reservedIds: readonly string[], displayName: string): string {
  const slug = displayName.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  const ids = new Set(reservedIds);
  if (slug !== "" && !ids.has(slug)) return requireAuthProfileName(slug);
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${slug}-${suffix}`;
    if (!ids.has(candidate)) return requireAuthProfileName(candidate);
  }
}
