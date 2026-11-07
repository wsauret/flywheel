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
 *  first lock of the update activation order (ADR-014): activation takes config
 *  ownership, re-reads the update policy, and only then opens the update
 *  authority, so a policy change and an activation can never interleave.
 *
 *  The file carries provider credentials in plain text, so it is 0600 and its
 *  directory is 0700 whatever the process umask is. */

import * as path from "node:path";
import { lstatSync, watch } from "node:fs";
import { acquireLockIn, acquireLockSyncIn, releaseLockIn, type LockHold } from "../../infra/ownership-file-lock.js";
import { ContainedDirectory } from "../../infra/descriptor-directory.js";
import { errorMessage } from "../../infra/error-message.js";
import { Log } from "../../infra/log.js";
import { globalConfigFile } from "../../infra/paths.js";

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
   *  The rename is the point the change becomes visible. A failure before it
   *  throws and leaves every reader on the old text; a directory-sync failure
   *  after it is returned, because the new text is already the file and a caller
   *  told "it failed" would hold state the file disagrees with. */
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
 *  interleave with a change, runs inside this window. Capability admission is
 *  such a caller: its read of the current descriptor is ordered against every
 *  Flywheel settings write by this one lock.
 *
 *  Acquisition is the non-blocking ladder, so a runtime loop waiting for another
 *  owner still serves its other work. `use` itself is synchronous: the window
 *  must not yield while it holds a cross-process lock, and a blocking sibling
 *  window would have nothing to wait for if it did. */
export async function withConfigOwnership<T>(location: ConfigFileLocation, use: (config: ConfigOwnership) => T): Promise<T> {
  const held = openConfigDirectory(location);
  let hold: LockHold | undefined;
  try {
    hold = await acquireLockIn(held.directory, `${held.fileName}.lock`);
    return use(configOwnership(held));
  } finally {
    if (hold) releaseLockIn(held.directory, hold);
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
  readonly fileName: string;
}

function openConfigDirectory(location: ConfigFileLocation): HeldConfigFile {
  const configPath = path.resolve(configFilePath(location));
  const configDir = path.dirname(configPath);
  return {
    directory: ContainedDirectory.open(path.dirname(configDir), [path.basename(configDir)], { privateDirectories: true }),
    fileName: path.basename(configPath),
  };
}

function configOwnership(held: HeldConfigFile): ConfigOwnership {
  const read = () => readHeldFile(held.directory, held.fileName);
  return {
    read,
    readText: () => textOf(read()),
    write: (text) => held.directory.writeFile(held.fileName, text),
  };
}

export interface ConfigWatchOptions {
  readonly debounceMs?: number;
  readonly revalidateMs?: number;
  /** How the directory that holds the config file is watched. `onChanged`
   *  reports that some entry of the directory changed and carries no payload;
   *  `onFailed` reports that this watch stopped delivering. A caller substitutes
   *  this to state a setup failure or a mid-session failure without provoking
   *  the platform watch. */
  readonly watchDirectory?: (directory: string, onChanged: () => void, onFailed: (reason: string) => void) => { close: () => void };
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
  let observed = publishedIdentity(configPath);
  let pending: ReturnType<typeof setTimeout> | undefined;

  const revalidate = (): void => {
    const identity = publishedIdentity(configPath);
    if (identity === observed) return;
    observed = identity;
    onChange();
  };

  const schedule = (): void => {
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
      () => log.warn("config-watch-failed", { code: "config-watch-failed" }),
    );
  } catch {
    log.debug("config-watch-unavailable", { code: "config-watch-unavailable" });
  }

  // Unreferenced, so the revalidation of an idle runtime never holds the
  // process open, and cleared on dispose, so it never outlives its consumer.
  const revalidation = setInterval(revalidate, options.revalidateMs ?? WATCH_REVALIDATE_MS);
  revalidation.unref();

  return {
    dispose: () => {
      clearInterval(revalidation);
      if (pending) clearTimeout(pending);
      watcher?.close();
    },
  };
}

function watchDirectoryEntries(directory: string, onChanged: () => void, onFailed: (reason: string) => void) {
  const watcher = watch(directory, () => { onChanged(); });
  watcher.on("error", (err) => onFailed(errorMessage(err)));
  watcher.unref();
  return { close: () => { watcher.close(); } };
}

/** Which file a reader would read now: `""` when there is none. The identity is
 *  a change token and never settings, so this seam still states nothing about
 *  what the file says. An entry that cannot be examined is treated as absent,
 *  because an absent notification is degraded freshness and never an error. */
function publishedIdentity(configPath: string): string {
  try {
    const stats = lstatSync(configPath, { throwIfNoEntry: false });
    return stats === undefined ? "" : `${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
  } catch {
    return "";
  }
}
