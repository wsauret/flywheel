/** The private boundary of the global config file.
 *
 *  Every read, ownership claim, and replacement of `flywheel.toml` happens
 *  here, against one held descriptor for the directory that holds it. A
 *  path-based writer re-resolves the directory, the lock, and the file at each
 *  call, so a link planted at any of the three between two of those calls
 *  redirects an account's settings out of the account. Here the directory is
 *  admitted once as an owner-only directory that is not a link, and the config,
 *  the lock, and the publication are then entries of that one descriptor.
 *
 *  The ownership lock is the account-global claim on the file. It is also the
 *  first lock of the update activation order (ARCH-RUNTIME-066): activation takes config
 *  ownership, re-reads the update policy, and only then opens the update
 *  authority, so a policy change and an activation can never interleave.
 *
 *  The file carries provider credentials in plain text, so it is 0600 and its
 *  directory is 0700 whatever the process umask is. */

import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { lstatSync, watch } from "node:fs";
import { withLockIn, acquireLockSyncIn, releaseLockIn, type LockHold } from "../../infra/ownership-file-lock.js";
import { ContainedDirectory, type ContainedFileSnapshot } from "../../infra/descriptor-directory.js";
import { errorMessage } from "../../infra/error-message.js";
import { Log } from "../../infra/log.js";
import { globalConfigFile } from "../../infra/paths.js";
import { heldDirectoryDerivation, leaseDirectoryWatch, noteDirectoryChange } from "../../infra/watched-directory-values.js";

/** A config file is settings text. Anything larger is not one. */
const CONFIG_MAX_BYTES = 1024 * 1024;

/** One settings edit is a lock file, a temporary file, and a rename. One
 *  notification after the burst settles is enough. */
const WATCH_DEBOUNCE_MS = 100;

/** The floor under the platform watch. Delivery is best effort: a watch can
 *  fail to arm, stop delivering mid-session, or arrive arbitrarily late while
 *  the machine is loaded, and this process would then publish settings the file
 *  stopped stating. Revalidation is one `lstat` of one entry and notifies only
 *  when the published file really changed, so the watch stays the fast path and
 *  this is what makes freshness a guarantee. */
const WATCH_REVALIDATE_MS = 1000;

const log = Log.create({ service: "config-file" });

const CONFIG_FILE_NAME = path.basename(globalConfigFile(""));

/** The held `publishedIdentity` of the global config file. */
const HELD_IDENTITY = heldDirectoryDerivation<string>([CONFIG_FILE_NAME]);

/** Where the global config file lives. `configPath` names one file directly and
 *  is how a test points the whole boundary at its own directory. */
export interface ConfigFileLocation {
  /** Startup-selected account data root the global config lives under. */
  readonly userDataRoot?: string;
  /** Override the canonical global config path. */
  readonly configPath?: string;
}

export type ConfigReadResult =
  | { readonly kind: "missing" }
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "failure"; readonly code: "refused-or-unreadable" };

/** A publication that cannot be acknowledged as saved. Unknown does not imply unchanged bytes. */
export class ConfigPublicationError extends Error {
  constructor(readonly outcome: "not-applied" | "unknown") {
    super(outcome === "not-applied" ? "Configuration publication was not applied" : "Configuration publication outcome is unknown");
    this.name = "ConfigPublicationError";
  }
}

/** The config file, while its owner holds it. Valid only inside the window that
 *  produced it. */
export interface ConfigOwnership {
  /** The one observation of the held file: missing, its text, or a refusal. */
  read(): ConfigReadResult;
  /** The current text, or `""` when the file does not exist yet. Throws when
   *  the file is refused or unreadable, so a writer never replaces a file it
   *  could not read. */
  readText(): string;
  /** Replace the file with `text`, published by rename and 0600.
   *
   *  Publication compares against the snapshot admitted by the latest read,
   *  or admits one snapshot when no read preceded the write. A definite refusal
   *  throws ConfigPublicationError("not-applied"). An indeterminate attempt
   *  rereads through the held directory once: candidate bytes return the
   *  original warning, prior bytes throw not-applied, and any other observation
   *  throws unknown. A returned Error means saved but verification or durability
   *  degraded, not a refused write. */
  write(text: string): Error | undefined;
}

function configFilePath(location: ConfigFileLocation): string {
  if (location.configPath !== undefined) return location.configPath;
  if (location.userDataRoot === undefined) throw new Error("a config operation names either a config path or an account data root");
  return globalConfigFile(location.userDataRoot);
}

/** Read one config entry through its contained directory descriptor. Missing,
 * text, and refusal are outcomes of this single observation. */
export function readConfigAt(location: ConfigFileLocation): ConfigReadResult {
  const resolved = path.resolve(configFilePath(location));
  let directory: ContainedDirectory | undefined;
  try {
    directory = ContainedDirectory.openExisting(path.dirname(path.dirname(resolved)), [path.basename(path.dirname(resolved))]);
    return directory ? readHeldFile(directory, path.basename(resolved)) : { kind: "missing" };
  } catch {
    return REFUSED;
  } finally {
    directory?.close();
  }
}

const REFUSED: ConfigReadResult = { kind: "failure", code: "refused-or-unreadable" };

function readHeldFile(directory: ContainedDirectory, fileName: string): ConfigReadResult {
  try {
    const bytes = directory.readFile(fileName, CONFIG_MAX_BYTES);
    if (bytes === undefined) return { kind: "missing" };
    return { kind: "text", text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return REFUSED;
  }
}

function textOf(result: ConfigReadResult): string {
  if (result.kind === "failure") throw new Error("config file was refused or unreadable");
  return result.kind === "text" ? result.text : "";
}

/** Compatibility read for one-shot callers. Runtime ownership uses
 * `readConfigAt` so refusal cannot collapse into absence. */
export function readConfigFile(configPath: string): string | undefined {
  const result = readConfigAt({ configPath });
  return result.kind === "missing" ? undefined : textOf(result);
}

/** Hold the config file for the length of `use`: the directory is admitted,
 *  the ownership lock is taken, and the read and the replacement inside are two
 *  operations on that one directory.
 *
 *  Every caller that changes the file, and every caller whose decision must not
 *  interleave with a change, runs inside this window. A read under this window
 *  is ordered against every Flywheel settings write by this one lock, so it
 *  never observes a replacement in progress, such as the moment on Windows
 *  when the old file is set aside and the new one is not yet in place.
 *
 *  Acquisition is the non-blocking ladder, so a runtime loop waiting for another
 *  owner still serves its other work. `use` itself is synchronous: the window
 *  must not yield while it holds a cross-process lock, and a blocking sibling
 *  window would have nothing to wait for if it did. */
export async function withConfigOwnership<T>(location: ConfigFileLocation, use: (config: ConfigOwnership) => T): Promise<T> {
  const held = openConfigDirectory(location);
  try {
    return await withLockIn(held.directory, `${held.fileName}.lock`, () => use(configOwnership(held)));
  } finally {
    held.directory.close();
  }
}

/** The same window for a caller whose whole window is synchronous, such as a
 *  settings writer reached from a reactive handler. It is the same lock entry as
 *  the awaited window, so writers and admission stay linearized against each
 *  other. */
export function withConfigOwnershipBlocking<T>(location: ConfigFileLocation, use: (config: ConfigOwnership) => T): T {
  const held = openConfigDirectory(location);
  let hold: LockHold | undefined;
  try {
    hold = acquireLockSyncIn(held.directory, `${held.fileName}.lock`);
    return use(configOwnership(held));
  } finally {
    if (hold) releaseLockIn(held.directory, hold);
    held.directory.close();
  }
}

interface HeldConfigFile {
  readonly directory: ContainedDirectory;
  readonly directoryPath: string;
  readonly fileName: string;
}

function openConfigDirectory(location: ConfigFileLocation): HeldConfigFile {
  const configPath = path.resolve(configFilePath(location));
  const configDir = path.dirname(configPath);
  return {
    directory: ContainedDirectory.open(path.dirname(configDir), [path.basename(configDir)], { privateDirectories: true }),
    directoryPath: configDir,
    fileName: path.basename(configPath),
  };
}

function configOwnership(held: HeldConfigFile): ConfigOwnership {
  let admitted: ContainedFileSnapshot | undefined;
  let observed = false;
  let readable = false;
  const read = (): ConfigReadResult => {
    observed = true;
    readable = false;
    try {
      admitted = held.directory.readFileSnapshot(held.fileName, CONFIG_MAX_BYTES);
      const result: ConfigReadResult = admitted === undefined
        ? { kind: "missing" }
        : { kind: "text", text: new TextDecoder("utf-8", { fatal: true }).decode(admitted.content) };
      readable = true;
      return result;
    } catch {
      return REFUSED;
    }
  };
  return {
    read,
    readText: () => textOf(read()),
    write: (text) => {
      if (!observed) read();
      if (!readable) throw new ConfigPublicationError("not-applied");
      const candidate = Buffer.from(text, "utf8");
      const attempt = held.directory.publishFileBytesThrough(`.flywheel-write.${process.pid}.${randomUUID()}`, held.fileName, candidate, admitted, held.directory.defaultFileMetadata());
      noteDirectoryChange(held.directoryPath, held.fileName);
      if (attempt.status === "published") return undefined;
      if (attempt.status === "not_applied") throw new ConfigPublicationError("not-applied");
      let current: ContainedFileSnapshot | undefined;
      try {
        current = held.directory.readFileSnapshot(held.fileName, CONFIG_MAX_BYTES);
      } catch {
        throw new ConfigPublicationError("unknown");
      }
      if (current?.content.equals(candidate)) return attempt.error;
      if (current === undefined ? admitted === undefined : admitted !== undefined && current.content.equals(admitted.content)) {
        throw new ConfigPublicationError("not-applied");
      }
      throw new ConfigPublicationError("unknown");
    },
  };
}

export interface ConfigWatchOptions {
  readonly debounceMs?: number;
  readonly revalidateMs?: number;
  /** How the directory that holds the config file is watched. `onChanged`
   *  reports that some entry of the directory changed, named when the platform names it;
   *  `onFailed` reports that this watch stopped delivering. A caller substitutes
   *  this to state a setup failure or a mid-session failure without provoking
   *  the platform watch. */
  readonly watchDirectory?: (directory: string, onChanged: (name?: string) => void, onFailed: (reason: string) => void) => { close: () => void };
}

/** Observe every replacement of the config file, whichever process made it.
 *
 *  The watch is on the directory rather than on the file, because a
 *  publication is a rename over the name: a watch bound to the replaced file
 *  observes nothing after the first write. Notifications carry no payload - a
 *  consumer re-reads what it needs through the ordinary read path, so this seam
 *  holds no second copy of the settings.
 *
 *  The platform watch is the fast path, never the authority on freshness. A
 *  directory that cannot be watched, and a watch that dies mid-session, both
 *  leave the revalidation timer, which reports the same replacements a little
 *  later. Both paths notify through one identity of the published file, so a
 *  replacement is reported once however it was observed and an unchanged file
 *  is never reported at all. */
export function watchConfigFile(location: ConfigFileLocation, onChange: () => void, options: ConfigWatchOptions = {}) {
  const configPath = path.resolve(configFilePath(location));
  const debounceMs = options.debounceMs ?? WATCH_DEBOUNCE_MS;
  const lease = leaseDirectoryWatch(path.dirname(configPath));
  // Taken before the watch arms, so a replacement the watch misses while it
  // arms still differs at the first revalidation.
  let observed = publishedIdentity(configPath);
  let pending: ReturnType<typeof setTimeout> | undefined;

  const revalidate = (): void => {
    const identity = publishedIdentity(configPath);
    if (identity !== observed) {
      observed = identity;
      lease.changed();
      onChange();
    }
  };

  const schedule = (name?: string): void => {
    lease.changed(name);
    if (pending) clearTimeout(pending);
    pending = setTimeout(() => { pending = undefined; revalidate(); }, debounceMs);
    pending.unref();
  };

  let watcher: { close: () => void } | undefined;
  try {
    watcher = (options.watchDirectory ?? watchDirectoryEntries)(
      path.dirname(configPath),
      schedule,
      // A watch that dies mid-session must not reach the process error handler,
      // and it costs freshness latency rather than freshness.
      () => {
        lease.release();
        log.warn("config-watch-failed", { code: "config-watch-failed" });
      },
    );
  } catch {
    log.debug("config-watch-unavailable", { code: "config-watch-unavailable" });
  }

  // Unreferenced, so the revalidation of an idle runtime never holds the
  // process open, and cleared on dispose, so it never outlives its consumer.
  const revalidation = setInterval(() => {
    lease.revalidate(watcher !== undefined);
    revalidate();
  }, options.revalidateMs ?? WATCH_REVALIDATE_MS);
  revalidation.unref();

  return {
    dispose: () => {
      clearInterval(revalidation);
      if (pending) clearTimeout(pending);
      watcher?.close();
      lease.release();
    },
  };
}

function watchDirectoryEntries(directory: string, onChanged: (name?: string) => void, onFailed: (reason: string) => void) {
  const watcher = watch(directory, (_event, name) => { onChanged(name ?? undefined); });
  watcher.on("error", (err) => onFailed(errorMessage(err)));
  watcher.unref();
  return { close: () => { watcher.close(); } };
}

/** Which published file a reader of `location` would read now: `""` when
 *  there is none. Every Flywheel write publishes a new file by rename, so a
 *  changed file always has a new identity. A caller that read the file under
 *  ownership can compare this identity with the one it took before that read,
 *  and reuse the read while the two are equal. */
export function publishedConfigIdentity(location: ConfigFileLocation): string {
  return publishedIdentity(path.resolve(configFilePath(location)));
}

/** `publishedConfigIdentity`, held while a confirmed `watchConfigFile` watches the file's directory.
 *  A file at an overridden path with another name is not the file the hold watches, so it is examined each time. */
export function heldConfigIdentity(location: ConfigFileLocation): string {
  const configPath = path.resolve(configFilePath(location));
  if (path.basename(configPath) !== CONFIG_FILE_NAME) return publishedIdentity(configPath);
  return HELD_IDENTITY.read(path.dirname(configPath), () => publishedIdentity(configPath));
}

/** The identity is a change token and never settings, so this seam still
 *  states nothing about what the file says. An entry that cannot be examined
 *  is treated as absent, because an absent notification is degraded freshness
 *  and never an error. */
function publishedIdentity(configPath: string): string {
  try {
    const stats = lstatSync(configPath, { throwIfNoEntry: false });
    return stats === undefined ? "" : `${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
  } catch {
    return "";
  }
}
