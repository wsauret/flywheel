/** Descriptor-contained storage for account-global authentication profiles. */

import { lstatSync, watch as watchDirectory } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { acquireLockIn, releaseLockIn } from "../ownership-file-lock.js";
import { ContainedDirectory } from "../descriptor-directory.js";
import { lockedJsonRevision } from "./locked-json-store.js";
import { AUTH_PROFILE_RETIREMENTS_FILE, readAuthProfileRetirements, retireAuthProfile, type AuthProfileRetirements } from "./auth-profile-retirements.js";
import { ensurePrivateRootDirectory } from "../private-path.js";
import { isAuthProfileDisplayName, requireAuthProfileDisplayName, requireAuthProfileName } from "../paths.js";

const AUTH_DIRECTORY = "auth";
const PROFILES_DIRECTORY = "profiles";
const PROFILE_LOCKS_DIRECTORY = "profile-locks";
const LOCK_FILE = ".profiles.lock";
const STICKY_FILE = ".active-profile";
const MANIFEST_FILE = ".profile-operation.json";
const PROFILE_FILE = "profile.json";
const AUTH_STORE_FILE = "auth.json";
const MAX_MARKER_BYTES = 1024;
const MAX_MANIFEST_BYTES = 16 * 1024;
const MAX_PROFILE_BYTES = 16 * 1024;
const LEGACY_PROFILE_FILES = ["auth.json"] as const;
const LEGACY_MIGRATION_MANIFEST = { kind: "legacy-profile-migration", operationId: "legacy-to-default-v1", from: "account-root", to: "default" } as const;
const RETIRED_PROFILE_FILES = ["openai-models.json", "copilot-models.json"] as const;
const DEFAULT_PROFILE = "default";
const MAX_LEGACY_FILE_BYTES = 16 * 1024 * 1024;
const AUTHORITY_WATCH_DEBOUNCE_MS = 25;
const AUTHORITY_WATCH_REVALIDATE_MS = 250;

type LegacyProfileFile = typeof LEGACY_PROFILE_FILES[number];
type MigrationFaultStage = `before:${LegacyProfileFile}` | `after:${LegacyProfileFile}`;

export interface AuthProfileDescriptor {
  readonly id: string;
  readonly displayName: string;
}

export interface AuthProfileInspection {
  readonly profiles: readonly AuthProfileDescriptor[];
  readonly stickyProfile: string | undefined;
  readonly retirements: AuthProfileRetirements;
}

/** Find a live stored profile or the unretired logical Default, without creating a directory. */
export function findLogicalAuthProfile(profiles: readonly AuthProfileDescriptor[], retirements: AuthProfileRetirements, id: string): AuthProfileDescriptor | undefined {
  return profiles.find((profile) => profile.id === id)
    ?? (id === DEFAULT_PROFILE && retirements[id] === undefined ? { id, displayName: "Default" } : undefined);
}

export interface AuthProfileStoreOptions {
  /** Test seam for simulating process failure around durable migration moves. */
  readonly migrationFault?: (stage: MigrationFaultStage) => void;
}

export interface ActiveProfileWatcherOptions {
  readonly debounceMs?: number;
  readonly revalidateMs?: number;
  readonly watchDirectory?: (directory: string, onChanged: () => void) => { close: () => void };
}

export interface ActiveProfileWatcher {
  dispose(): void;
}

/** A path-based mutation names a profile directory that no longer exists. */
export class AuthProfileDirectoryNotFoundError extends Error {
  readonly _tag = "AuthProfileDirectoryNotFoundError" as const;
  readonly directory: string;

  constructor(directory: string) {
    super(`auth profile directory does not exist: ${directory}`);
    this.directory = directory;
  }
}

/** Access to one admitted immutable profile directory. The caller closes it. */
export class AuthProfileAccess {
  readonly #directory: ContainedDirectory;
  readonly #lockDirectory: ContainedDirectory;
  readonly #lockName: string;
  readonly authDirectory: string;

  constructor(directory: ContainedDirectory, lockDirectory: ContainedDirectory, profileId: string, authDirectory: string) {
    this.#directory = directory;
    this.#lockDirectory = lockDirectory;
    this.#lockName = profileLockName(profileId);
    this.authDirectory = authDirectory;
  }

  readFile(name: string, maxBytes: number): Buffer | undefined {
    return this.#directory.readFile(name, maxBytes);
  }

  writeFile(name: string, content: string): void {
    const failure = this.#directory.writeFile(name, content);
    if (failure !== undefined) throw failure;
  }

  removeFile(name: string): void {
    this.#directory.removeFile(name);
  }

  async withLock<T>(use: () => T | Promise<T>): Promise<T> {
    const hold = await acquireLockIn(this.#lockDirectory, this.#lockName);
    try {
      return await use();
    } finally {
      releaseLockIn(this.#lockDirectory, hold);
    }
  }

  close(): void {
    this.#directory.close();
    this.#lockDirectory.close();
  }
}

/** Admit an existing profile directory without creating a missing component. */
export function openExistingAuthProfileDirectory(directory: string): AuthProfileAccess {
  const resolved = resolve(directory);
  const id = requireAuthProfileName(basename(resolved));
  const parentPath = dirname(resolved);
  const profile = ContainedDirectory.openExisting(parentPath, [id], { noFollowBase: true, privateDirectories: true });
  if (profile === undefined) throw new AuthProfileDirectoryNotFoundError(resolved);
  const parent = ContainedDirectory.openExisting(dirname(parentPath), [basename(parentPath)], { noFollowBase: true });
  if (parent === undefined) {
    profile.close();
    throw new AuthProfileDirectoryNotFoundError(resolved);
  }
  const locks = parent.openChild(PROFILE_LOCKS_DIRECTORY, { privateDirectories: true });
  parent.close();
  return new AuthProfileAccess(profile, locks, id, resolved);
}

export type AuthProfilePreRemove = (id: string) => Promise<() => void>;
/** Profile operations available only while the store owns its cross-process lock. */
export interface AuthProfileOperation {
  list(): readonly AuthProfileDescriptor[];
  retirements(): AuthProfileRetirements;
  /** Commit the transfer before cleanup. The destination must be stored; the source may be synthetic Default. */
  retire(id: string, successorId: string): void;
  /** Remove only an unpublished profile that still contains metadata alone. */
  discardUnpublished(id: string): Promise<void>;
  create(id: string, displayName?: string): AuthProfileAccess;
  open(id: string): AuthProfileAccess | undefined;
  rename(id: string, displayName: string): void;
  delete(id: string, preRemove?: AuthProfilePreRemove): Promise<void>;
  readStickyProfile(): string | undefined;
  writeStickyProfile(id: string): void;
}

/** Owns profile enumeration, metadata, and descriptor-backed access. */
export class AuthProfileStore {
  readonly #userDataRoot: string;
  readonly #migrationFault: ((stage: MigrationFaultStage) => void) | undefined;

  constructor(userDataRoot: string, options: AuthProfileStoreOptions = {}) {
    this.#userDataRoot = userDataRoot;
    this.#migrationFault = options.migrationFault;
  }

  /** Observe catalog metadata publications, including creation of a missing auth directory.
   * The watcher carries no catalog state and never creates storage. */
  watchCatalog(onChange: () => void, onError: (error: unknown) => void): ActiveProfileWatcher {
    const authPath = resolve(this.#userDataRoot, AUTH_DIRECTORY);
    let disposed = false;
    let watchedPath = "";
    let watcher: ReturnType<typeof watchDirectory> | undefined;
    const arm = (): void => {
      let directory = authPath;
      while (lstatSync(directory, { throwIfNoEntry: false }) === undefined) directory = dirname(directory);
      if (directory === watchedPath) return;
      watcher?.close();
      watchedPath = directory;
      watcher = watchDirectory(directory, { recursive: directory === authPath }, (_event, filename) => {
        if (disposed) return;
        try {
          if (watchedPath !== authPath) {
            const nextComponent = relative(watchedPath, authPath).replaceAll("\\", "/").split("/")[0];
            if (filename !== null && filename.toString() !== nextComponent) return;
            arm();
            onChange();
            return;
          }
          const name = filename?.toString().replaceAll("\\", "/");
          if (name === undefined || name === AUTH_PROFILE_RETIREMENTS_FILE || name === PROFILES_DIRECTORY
            || /^profiles\/[^/]+(?:\/profile\.json)?$/.test(name)) onChange();
        } catch (error) { onError(error); }
      });
      watcher.on("error", onError);
      watcher.unref();
    };
    arm();
    return { dispose: () => { disposed = true; watcher?.close(); } };
  }

  /** Observe active-profile marker publications. */
  watchActiveProfile(onChange: () => void, options: ActiveProfileWatcherOptions = {}): ActiveProfileWatcher {
    const stickyFile = resolve(this.#userDataRoot, AUTH_DIRECTORY, STICKY_FILE);
    const debounceMs = options.debounceMs ?? AUTHORITY_WATCH_DEBOUNCE_MS;
    const revalidateMs = options.revalidateMs ?? AUTHORITY_WATCH_REVALIDATE_MS;
    let observed = publishedIdentity(stickyFile);
    let pending: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;

    const revalidate = (): void => {
      if (disposed) return;
      const next = publishedIdentity(stickyFile);
      if (next === observed) return;
      observed = next;
      onChange();
    };
    const schedule = (): void => {
      if (disposed) return;
      if (pending !== undefined) clearTimeout(pending);
      pending = setTimeout(() => {
        pending = undefined;
        revalidate();
      }, debounceMs);
      pending.unref();
    };
    const closeWatchers: Array<() => void> = [];
    const watch = options.watchDirectory ?? ((directory: string, onChanged: () => void) => {
      const watcher = watchDirectory(directory, onChanged);
      watcher.on("error", () => {});
      watcher.unref();
      return { close: () => watcher.close() };
    });
    try {
      closeWatchers.push(watch(dirname(stickyFile), schedule).close);
    } catch {
      // Revalidation remains the freshness guarantee when a platform watch cannot arm.
    }
    const revalidation = setInterval(revalidate, revalidateMs);
    revalidation.unref();
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        clearInterval(revalidation);
        if (pending !== undefined) clearTimeout(pending);
        for (const close of closeWatchers) close();
      },
    };
  }

  /** Observe one admitted profile's exact auth bytes without following a replacement directory. */
  watchAuthFile(profileDirectory: string, onChange: () => void, options: ActiveProfileWatcherOptions = {}): ActiveProfileWatcher {
    const debounceMs = options.debounceMs ?? AUTHORITY_WATCH_DEBOUNCE_MS;
    const revalidateMs = options.revalidateMs ?? AUTHORITY_WATCH_REVALIDATE_MS;
    const access = openExistingAuthProfileDirectory(profileDirectory);
    const revision = (): string => {
      try {
        return lockedJsonRevision(access.readFile(AUTH_STORE_FILE, MAX_LEGACY_FILE_BYTES));
      } catch {
        return "unreadable";
      }
    };
    let observed = revision();
    let pending: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let closeWatcher: (() => void) | undefined;
    const watch = options.watchDirectory ?? ((directory: string, onChanged: () => void) => {
      const watcher = watchDirectory(directory, onChanged);
      watcher.on("error", () => {});
      watcher.unref();
      return { close: () => watcher.close() };
    });
    const revalidate = (): void => {
      if (disposed) return;
      pending = undefined;
      const next = revision();
      if (next === observed) return;
      observed = next;
      onChange();
    };
    const schedule = (): void => {
      if (disposed) return;
      if (pending !== undefined) clearTimeout(pending);
      pending = setTimeout(revalidate, debounceMs);
      pending.unref();
    };
    try {
      closeWatcher = watch(profileDirectory, schedule).close;
    } catch {
      // Periodic byte revalidation remains the freshness guarantee.
    }
    const revalidation = setInterval(revalidate, revalidateMs);
    revalidation.unref();
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        clearInterval(revalidation);
        if (pending !== undefined) clearTimeout(pending);
        closeWatcher?.();
        access.close();
      },
    };
  }

  /** Own one uninterrupted profile mutation window. */
  async withOperation<T>(use: (operation: AuthProfileOperation) => T | Promise<T>): Promise<T> {
    const auth = this.#openAuth(true);
    if (auth === undefined) throw new Error("created auth directory is absent");
    try {
      const hold = await acquireLockIn(auth, LOCK_FILE);
      try {
        readAuthProfileRetirements(auth);
        await this.#migrateLegacyFiles(auth);
        return await use(this.#operation(auth));
      } finally {
        releaseLockIn(auth, hold);
      }
    } finally {
      auth.close();
    }
  }

  async list(): Promise<readonly AuthProfileDescriptor[]> {
    const auth = this.#openAuth(false);
    if (auth === undefined) return [];
    try {
      return await this.#withLock(auth, async () => {
        await this.#migrateLegacyFiles(auth);
        return this.#list(auth);
      });
    } finally {
      auth.close();
    }
  }

  /** Read profile selection data without creating, locking, migrating, or changing permissions. */
  inspect(): AuthProfileInspection {
    const auth = ContainedDirectory.openExisting(this.#userDataRoot, [AUTH_DIRECTORY], { noFollowBase: true });
    if (auth === undefined) return { profiles: [], stickyProfile: undefined, retirements: Object.freeze(Object.create(null)) };
    try {
      const bytes = auth.readFile(STICKY_FILE, MAX_MARKER_BYTES);
      return {
        profiles: this.#list(auth),
        retirements: readAuthProfileRetirements(auth),
        stickyProfile: bytes === undefined ? undefined : requireAuthProfileName(bytes.toString("utf8")),
      };
    } finally {
      auth.close();
    }
  }

  async create(id: string, displayName?: string): Promise<AuthProfileAccess> {
    return this.withOperation((operation) => operation.create(id, displayName));
  }

  async open(id: string): Promise<AuthProfileAccess | undefined> {
    return this.withOperation((operation) => operation.open(id));
  }

  async rename(id: string, displayName: string): Promise<void> {
    await this.withOperation((operation) => operation.rename(id, displayName));
  }

  async delete(id: string, preRemove?: AuthProfilePreRemove): Promise<void> {
    await this.withOperation((operation) => operation.delete(id, preRemove));
  }

  async readStickyProfile(): Promise<string | undefined> {
    const auth = this.#openAuth(false);
    if (auth === undefined) return undefined;
    try {
      const bytes = auth.readFile(STICKY_FILE, MAX_MARKER_BYTES);
      return bytes === undefined ? undefined : requireAuthProfileName(bytes.toString("utf8"));
    } finally {
      auth.close();
    }
  }

  async writeStickyProfile(id: string): Promise<void> {
    requireAuthProfileName(id);
    const auth = this.#openAuth(true);
    if (auth === undefined) throw new Error("created auth directory is absent");
    try {
      await this.#withLock(auth, () => {
        const failure = auth.writeFile(STICKY_FILE, id);
        if (failure !== undefined) throw failure;
      });
    } finally {
      auth.close();
    }
  }

  #list(auth: ContainedDirectory): readonly AuthProfileDescriptor[] {
    const retired = readAuthProfileRetirements(auth);
    const profiles = auth.openExistingChild(PROFILES_DIRECTORY);
    if (profiles === undefined) return [];
    try {
      return profiles.directoryEntryNames()
        .filter((entry) => entry !== PROFILE_LOCKS_DIRECTORY && !Object.hasOwn(retired, entry))
        .map((entry) => {
          const id = requireAuthProfileName(entry);
          const profile = profiles.openExistingChild(id);
          if (profile === undefined) throw new Error(`auth profile does not exist: ${id}`);
          try {
            return readProfileDescriptor(profile, id);
          } finally {
            profile.close();
          }
        }).sort((left, right) => left.id.localeCompare(right.id));
    } finally {
      profiles.close();
    }
  }

  async #migrateLegacyFiles(auth: ContainedDirectory): Promise<void> {
    const manifestBytes = auth.readFile(MANIFEST_FILE, MAX_MANIFEST_BYTES);
    const recovering = manifestBytes === undefined ? false : decodeLegacyManifest(manifestBytes);
    const sources = LEGACY_PROFILE_FILES.filter((name) => auth.hasEntry(name));
    const retiredAtRoot = RETIRED_PROFILE_FILES.some((name) => auth.hasEntry(name));
    const profiles = auth.openChild(PROFILES_DIRECTORY, { privateDirectories: true });
    try {
      const existingDefault = profiles.openExistingChild(DEFAULT_PROFILE);
      const retiredInProfile = existingDefault === undefined ? false : RETIRED_PROFILE_FILES.some((name) => existingDefault.hasEntry(name));
      existingDefault?.close();
      if (sources.length === 0 && !recovering && !retiredAtRoot && !retiredInProfile) return;

      const defaultProfile = profiles.openChild(DEFAULT_PROFILE, { privateDirectories: true });
      const locks = this.#profileLocks(auth);
      const hold = await acquireLockIn(locks, profileLockName(DEFAULT_PROFILE));
      try {
        for (const name of RETIRED_PROFILE_FILES) {
          auth.removeFile(name);
          defaultProfile.removeFile(name);
        }
        if (!recovering && sources.some((name) => defaultProfile.hasEntry(name))) throw new Error("unrecognized legacy profile migration conflict");
        if (sources.length === 0) {
          auth.removeFile(MANIFEST_FILE);
          return;
        }
        if (!recovering) {
          const failure = auth.writeFile(MANIFEST_FILE, JSON.stringify(LEGACY_MIGRATION_MANIFEST));
          if (failure !== undefined) throw failure;
        }
        for (const name of LEGACY_PROFILE_FILES) {
          const source = auth.readFile(name, MAX_LEGACY_FILE_BYTES);
          if (source === undefined) continue;
          const destination = defaultProfile.readFile(name, MAX_LEGACY_FILE_BYTES);
          if (destination !== undefined) {
            if (!source.equals(destination)) throw new Error(`legacy profile migration conflict: ${name}`);
            auth.removeFile(name);
            continue;
          }
          this.#migrationFault?.(`before:${name}`);
          auth.renameInto(name, defaultProfile, name);
          this.#migrationFault?.(`after:${name}`);
        }
        auth.removeFile(MANIFEST_FILE);
      } finally {
        releaseLockIn(locks, hold);
        locks.close();
        defaultProfile.close();
      }
    } finally {
      profiles.close();
    }
  }

  #profileLocks(auth: ContainedDirectory): ContainedDirectory {
    const profiles = auth.openChild(PROFILES_DIRECTORY, { privateDirectories: true });
    const locks = profiles.openChild(PROFILE_LOCKS_DIRECTORY, { privateDirectories: true });
    profiles.close();
    return locks;
  }

  #operation(auth: ContainedDirectory): AuthProfileOperation {
    const profiles = () => auth.openChild(PROFILES_DIRECTORY, { privateDirectories: true });
    const authDirectory = (id: string): string => resolve(this.#userDataRoot, AUTH_DIRECTORY, PROFILES_DIRECTORY, id);
    return {
      list: () => this.#list(auth),
      retirements: () => readAuthProfileRetirements(auth),
      retire: (id, successorId) => {
        requireAuthProfileName(id);
        requireAuthProfileName(successorId);
        const live = this.#list(auth);
        const source = findLogicalAuthProfile(live, readAuthProfileRetirements(auth), id);
        if (id === successorId || source === undefined || !live.some((profile) => profile.id === successorId)) throw new Error("profile transfer requires distinct live source and destination");
        retireAuthProfile(auth, id, successorId);
      },
      discardUnpublished: async (id) => {
        requireAuthProfileName(id);
        const directory = profiles();
        const locks = this.#profileLocks(auth);
        const hold = await acquireLockIn(locks, profileLockName(id));
        try {
          const profile = directory.openExistingChild(id);
          if (profile === undefined) return;
          let safe: boolean;
          try {
            safe = profile.entryNames().every((name) => name === PROFILE_FILE);
          } finally {
            profile.close();
          }
          if (safe) directory.removeTree(id);
        } finally {
          releaseLockIn(locks, hold);
          locks.close();
          directory.close();
        }
      },
      open: (id) => {
        requireAuthProfileName(id);
        if (Object.hasOwn(readAuthProfileRetirements(auth), id)) return undefined;
        const directory = profiles();
        const profile = directory.openExistingChild(id);
        directory.close();
        return profile === undefined ? undefined : new AuthProfileAccess(profile, this.#profileLocks(auth), id, authDirectory(id));
      },
      create: (id, displayName) => {
        requireAuthProfileName(id);
        if (Object.hasOwn(readAuthProfileRetirements(auth), id)) throw new Error(`auth profile id is retired: ${id}`);
        if (displayName !== undefined) requireAuthProfileDisplayName(displayName);
        const directory = profiles();
        const existing = directory.openExistingChild(id);
        if (existing !== undefined) {
          existing.close();
          directory.close();
          throw new Error(`auth profile already exists: ${id}`);
        }
        const profile = directory.openChild(id, { privateDirectories: true });
        directory.close();
        try {
          if (displayName !== undefined) writeProfileMetadata(profile, displayName);
          return new AuthProfileAccess(profile, this.#profileLocks(auth), id, authDirectory(id));
        } catch (error) {
          profile.close();
          throw error;
        }
      },
      delete: async (id, preRemove) => {
        requireAuthProfileName(id);
        const directory = profiles();
        const profile = directory.openExistingChild(id);
        if (profile === undefined) {
          directory.close();
          if (Object.hasOwn(readAuthProfileRetirements(auth), id)) return;
          throw new Error(`auth profile does not exist: ${id}`);
        }
        profile.close();
        const locks = this.#profileLocks(auth);
        const hold = await acquireLockIn(locks, profileLockName(id));
        try {
          const removed = await preRemove?.(id);
          try {
            directory.removeTree(id);
          } finally {
            removed?.();
          }
        } finally {
          releaseLockIn(locks, hold);
          locks.close();
          directory.close();
        }
      },
      rename: (id, displayName) => {
        requireAuthProfileName(id);
        requireAuthProfileDisplayName(displayName);
        const directory = profiles();
        try {
          const profile = directory.openExistingChild(id);
          if (profile === undefined) throw new Error(`auth profile does not exist: ${id}`);
          try {
            writeProfileMetadata(profile, displayName);
          } finally {
            profile.close();
          }
        } finally {
          directory.close();
        }
      },
      readStickyProfile: () => {
        const bytes = auth.readFile(STICKY_FILE, MAX_MARKER_BYTES);
        return bytes === undefined ? undefined : requireAuthProfileName(bytes.toString("utf8"));
      },
      writeStickyProfile: (id) => {
        requireAuthProfileName(id);
        const failure = auth.writeFile(STICKY_FILE, id);
        if (failure !== undefined) throw failure;
      },
    };
  }

  #openAuth(create: boolean): ContainedDirectory | undefined {
    if (create) ensurePrivateRootDirectory(this.#userDataRoot);
    return create
      ? ContainedDirectory.open(this.#userDataRoot, [AUTH_DIRECTORY], { noFollowBase: true, privateDirectories: true })
      : ContainedDirectory.openExisting(this.#userDataRoot, [AUTH_DIRECTORY], { noFollowBase: true, privateDirectories: true });
  }

  async #withLock<T>(auth: ContainedDirectory, use: () => T | Promise<T>): Promise<T> {
    const hold = await acquireLockIn(auth, LOCK_FILE);
    try {
      return await use();
    } finally {
      releaseLockIn(auth, hold);
    }
  }
}

function profileLockName(id: string): string {
  return `.profile.${id}.lock`;
}

function publishedIdentity(file: string): string {
  try {
    const stats = lstatSync(file, { throwIfNoEntry: false });
    return stats === undefined ? "" : `${stats.ino}:${stats.size}:${stats.mtimeMs}`;
  } catch {
    return "";
  }
}

function readProfileDescriptor(profile: ContainedDirectory, id: string): AuthProfileDescriptor {
  const bytes = profile.readFile(PROFILE_FILE, MAX_PROFILE_BYTES);
  if (bytes === undefined) return { id, displayName: defaultDisplayName(id) };
  try {
    const metadata: unknown = JSON.parse(bytes.toString("utf8"));
    if (typeof metadata === "object" && metadata !== null && Object.keys(metadata).length === 1 && "displayName" in metadata && typeof metadata.displayName === "string" && isAuthProfileDisplayName(metadata.displayName)) {
      return { id, displayName: metadata.displayName };
    }
  } catch {
    // Invalid metadata must not put terminal control characters on a display surface.
  }
  return { id, displayName: defaultDisplayName(id) };
}

function writeProfileMetadata(profile: ContainedDirectory, displayName: string): void {
  const failure = profile.writeFile(PROFILE_FILE, JSON.stringify({ displayName }));
  if (failure !== undefined) throw failure;
}

function defaultDisplayName(id: string): string {
  return id === DEFAULT_PROFILE ? "Default" : id;
}

function decodeLegacyManifest(bytes: Buffer): true {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("auth profile operation manifest is malformed");
  }
  if (typeof value !== "object" || value === null || Object.keys(value).length !== 4 || !("kind" in value) || !("operationId" in value) || !("from" in value) || !("to" in value) || value.kind !== LEGACY_MIGRATION_MANIFEST.kind || value.operationId !== LEGACY_MIGRATION_MANIFEST.operationId || value.from !== LEGACY_MIGRATION_MANIFEST.from || value.to !== LEGACY_MIGRATION_MANIFEST.to) {
    throw new Error("auth profile operation manifest is malformed");
  }
  return true;
}