/** The Windows launcher directory: the one place a Windows installation
 *  writes outside the account's versions tree.
 *
 *  A Windows build is installed exactly as a macOS or Linux build is: one
 *  immutable directory in the account's versions tree, activated by renaming
 *  one pointer over `current` (ARCH-DISTRIBUTION-015, ARCH-DISTRIBUTION-017). What differs is the program on PATH.
 *  Windows runs a program only through an executable file, so each Windows
 *  build carries two variants of the same small launcher. The console
 *  `flywheel.exe` is on PATH, and Task Scheduler runs the windowless
 *  `flywheel-service.exe`. Both run the build the pointer names.
 *
 *  An install record beside it, `.flywheel-install.json`, states that the
 *  launcher directory holds the versions layout, whose launchers are
 *  Flywheel's to replace. It is the Windows counterpart of the POSIX
 *  wrapper's ownership marker: in a directory without a record this
 *  installer recognizes, no entry is ever replaced or removed, and a record
 *  of a shape this build does not know refuses the installation with a
 *  warning instead of being read as permission.
 *
 *  A running executable cannot be replaced or deleted on Windows, and it can
 *  be renamed. So a launcher that differs from the build's is replaced by
 *  renaming the one in place to a retired name and renaming the new one into
 *  `flywheel.exe`. A retired launcher is deleted once nothing runs it, which
 *  is when Windows lets the deletion happen: a launcher runs as long as the
 *  service or terminal it started.
 *
 *  The same rename converts the flat installation that earlier Windows
 *  releases wrote: `flywheel.exe`, `native\`, `fonts\`, and in later ones
 *  `webview\` and `build.json`, all in the launcher directory. Its running
 *  `flywheel.exe` gives its name to the launcher, so PATH and the scheduled
 *  task reach the new build with no action by the person, and the flat
 *  directories stay until no retired executable in the directory still runs,
 *  because the flat build loads from them while it runs. The flat record
 *  stays until the swap is done, so an interrupted conversion is one the
 *  next installation, under the flat updater that started it, resumes. */

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { ContainedDirectory } from "../../infra/descriptor-directory.js";
import { errorMessage } from "../../infra/error-message.js";
import { Log } from "../../infra/log.js";
import { WINDOWS_LAUNCHER_EXECUTABLE, WINDOWS_SERVICE_LAUNCHER_EXECUTABLE } from "../../infra/native-assets.js";
import { isProcessAlive } from "../../infra/process-liveness.js";
import type { ProcessRow } from "../../infra/process-table.js";
import { activeBuildDir } from "../../infra/update/active-build.js";
import { NATIVE_DIR } from "../../infra/update/build-identity.js";
import { WINDOWS_LAUNCHER_NAME, WINDOWS_SERVICE_LAUNCHER_NAME } from "../../infra/update/wrapper-directory.js";

const log = Log.create({ service: "windows-install" });

export const WINDOWS_LAUNCHERS = [
  { kind: "console", installedName: WINDOWS_LAUNCHER_NAME, nativeName: WINDOWS_LAUNCHER_EXECUTABLE },
  { kind: "service", installedName: WINDOWS_SERVICE_LAUNCHER_NAME, nativeName: WINDOWS_SERVICE_LAUNCHER_EXECUTABLE },
] as const;
const LAUNCHER_NAMES = WINDOWS_LAUNCHERS.map(({ installedName }) => installedName);
const LAUNCHER = WINDOWS_LAUNCHER_NAME;
const RECORD = ".flywheel-install.json";
const RECORD_MAX_BYTES = 4096;
/** A launcher, or a flat build's executable, renamed out of the way while it
 *  may still run. Nothing else in the directory is named this way. */
const RETIRED = /^\.flywheel-retired-[0-9a-f]{16}\.exe$/;
/** The private name each file this installer writes has before its rename,
 *  `.<name>.<pid>.<hex>`. The pid names its writer, so the name an
 *  interrupted write left is removed once that writer is gone. */
const PENDING = /^\.(?:flywheel(?:-service)?\.exe|build\.json|flywheel-install\.json)\.([1-9][0-9]*)\.[0-9a-f]{16}$/;

/** What the flat installer of earlier releases owned beside its executable,
 *  its interrupted-transaction record, and the transaction directories it
 *  left while a retired build still ran. Remove after 2026-12-28, when every
 *  Windows installation has converted to the versions tree. */
const FLAT_NAMES: readonly string[] = ["build.json", LAUNCHER, "fonts", "native", "webview"];
const INSTALL_NAMES: readonly string[] = [...FLAT_NAMES, WINDOWS_SERVICE_LAUNCHER_NAME];
const FLAT_TRANSACTION = ".flywheel-install-txn.json";
const FLAT_REMAINDER = /^\.flywheel-txn-[0-9a-f]{32}$/;
/** How far up the process tree the flat updater is looked for: the install
 *  role, the archive's and the bootstrap's PowerShell, and the updater's
 *  command supervisor and service sit a handful of levels apart. */
const MAX_ANCESTRY = 16;

/** What the launcher directory holds, proved before anything is placed.
 *
 *  `absent` holds no launcher and no flat entry. `launcher` holds this
 *  installer's launcher, and `retiring` names the flat entries a conversion
 *  left for collection. `flat` is the installation an earlier release wrote,
 *  which the next publication converts, and `swap` is how far an earlier
 *  conversion of it got: the flat executable still at `flywheel.exe`, renamed
 *  away with nothing at the name yet, or the build's launcher already there. */
export type WindowsLauncherOwnership =
  | { readonly kind: "absent" }
  | {
    readonly kind: "launcher";
    readonly retiring: readonly string[];
    readonly missing: readonly ("console" | "service")[];
  }
  | { readonly kind: "flat"; readonly owned: readonly string[]; readonly swap: "pending" | "retired" | "placed" };

export interface WindowsLaunchers {
  readonly console: Uint8Array;
  readonly service: Uint8Array;
}

/** The launcher directory refuses this installation. */
class WindowsLauncherError extends Error {}

function refuse(message: string): never {
  throw new WindowsLauncherError(message);
}

/** The record this installer writes, as exact text: the versions layout, and
 *  the flat entries still waiting for collection. The layout owns every
 *  launcher in `WINDOWS_LAUNCHERS`, although `owns` names only the console
 *  launcher. The text is frozen: a rollback returns the account to an earlier
 *  build, whose installer accepts only the exact text it wrote, so a record
 *  that named the service launcher would refuse every later installation
 *  that build attempts. */
function launcherRecord(retiring: readonly string[]): string {
  return JSON.stringify(retiring.length === 0
    ? { installedBy: "flywheel", layout: "versions", owns: [LAUNCHER] }
    : { installedBy: "flywheel", layout: "versions", owns: [LAUNCHER], retiring: [...retiring].sort() });
}

/** The manifest the flat installer wrote, as exact text. Remove after
 *  2026-12-28 with the conversion. */
function flatRecord(owned: readonly string[]): string {
  return JSON.stringify({ installedBy: "flywheel", owns: [...owned].sort() });
}

type InstallRecord =
  | { readonly kind: "launcher"; readonly retiring: readonly string[] }
  | { readonly kind: "flat"; readonly owned: readonly string[] };

/** The install record, read only when its text is exactly one this build
 *  writes or converts. Anything else is a layout this build does not know,
 *  written by something else or by a newer Flywheel, and is reported and
 *  refused rather than guessed at or overwritten. */
function readRecord(directory: ContainedDirectory, wrapperDir: string): InstallRecord | undefined {
  let raw: Buffer | undefined;
  try {
    raw = directory.readFile(RECORD, RECORD_MAX_BYTES);
  } catch (error) {
    refuse(`${JSON.stringify(path.join(wrapperDir, RECORD))} is not an install record this installer can read: ${errorMessage(error)}`);
  }
  if (raw === undefined) return undefined;
  const text = raw.toString("utf8");
  const record = recognizedRecord(text);
  if (record) return record;
  log.warn("the Windows install record states a layout this build does not know", { wrapperDir, bytes: raw.byteLength });
  refuse(`${JSON.stringify(path.join(wrapperDir, RECORD))} states an installation this version of Flywheel does not know, so nothing was changed. Install the newest Flywheel, or remove that directory's Flywheel files and install again.`);
}

function recognizedRecord(text: string): InstallRecord | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const retiring = "retiring" in parsed ? parsed.retiring : [];
  const owns = "owns" in parsed ? parsed.owns : undefined;
  const names = (value: unknown, allowed: readonly string[]): readonly string[] | undefined => Array.isArray(value) && value.every((name) => typeof name === "string" && allowed.includes(name)) ? value : undefined;
  const retiringNames = names(retiring, FLAT_NAMES);
  if ("layout" in parsed && retiringNames && !retiringNames.includes(LAUNCHER) && text === launcherRecord(retiringNames)) return { kind: "launcher", retiring: retiringNames };
  const owned = names(owns, FLAT_NAMES);
  if (owned?.includes(LAUNCHER) && text === flatRecord(owned) && new Set(owned).size === owned.length) return { kind: "flat", owned };
  return undefined;
}

/** What the launcher directory holds, read before anything is placed so an
 *  entry this installer did not write refuses the whole installation instead
 *  of half of it. `launchers` are the launchers the build being installed
 *  carries, which is how a flat conversion that already placed them is told
 *  from one that did not.
 *
 *  A build that carries no launcher under the names this build knows, as a
 *  later release may, is installed when both launchers are already in place:
 *  they read `current`, so they run its build. A directory that needs a
 *  launcher placed refuses it here, before anything moves. */
export function proveWindowsLauncher(directory: ContainedDirectory, wrapperDir: string, launchers: WindowsLaunchers | undefined): WindowsLauncherOwnership {
  const ownership = launcherOwnership(directory, wrapperDir, launchers);
  if (launchers === undefined && (ownership.kind !== "launcher" || ownership.missing.length > 0)) {
    refuse("the build carries no Windows launcher, and this directory needs one placed");
  }
  return ownership;
}

function launcherOwnership(directory: ContainedDirectory, wrapperDir: string, launchers: WindowsLaunchers | undefined): WindowsLauncherOwnership {
  const record = readRecord(directory, wrapperDir);
  const unclaimed = (claimed: readonly string[]): void => {
    for (const name of INSTALL_NAMES) {
      if (!claimed.includes(name) && directory.hasEntry(name)) refuse(`${JSON.stringify(path.join(wrapperDir, name))} is not a Flywheel entry this installer may replace`);
    }
  };
  if (record === undefined) {
    unclaimed([]);
    return { kind: "absent" };
  }
  if (record.kind === "launcher") {
    unclaimed([...LAUNCHER_NAMES, ...record.retiring]);
    return {
      ...record,
      missing: WINDOWS_LAUNCHERS.filter(({ installedName }) => !directory.hasEntry(installedName)).map(({ kind }) => kind),
    };
  }
  if (directory.hasEntry(FLAT_TRANSACTION)) {
    refuse(`an interrupted install of an earlier Flywheel left ${JSON.stringify(path.join(wrapperDir, FLAT_TRANSACTION))}. Run the installer of that release again to finish it, then install this one.`);
  }
  const swap = !directory.hasEntry(LAUNCHER) ? "retired" : sameLauncher(directory, LAUNCHER, launchers?.console) ? "placed" : "pending";
  if (swap === "retired" && !directory.entryNames().some((entry) => RETIRED.test(entry))) {
    refuse(`${JSON.stringify(path.join(wrapperDir, RECORD))} states that Flywheel installed ${LAUNCHER}, which is not there`);
  }
  for (const name of record.owned) {
    if (name !== LAUNCHER && !directory.hasEntry(name)) refuse(`${JSON.stringify(path.join(wrapperDir, RECORD))} states that Flywheel installed ${name}, which is not there`);
  }
  unclaimed(record.owned);
  return { kind: "flat", owned: record.owned, swap };
}

export interface WindowsLauncherPublication {
  /** The launchers the activated build carries, or nothing when it carries
   *  none under the names this build knows. */
  readonly launchers: WindowsLaunchers | undefined;
  /** The activated build's `build.json`, which a running flat build reads
   *  beside its executable to learn that it was superseded. */
  readonly metadata: string;
}

/** Place the activated build's launchers over the entries the same ownership
 *  proof still admits. The build is already active, so a launcher being
 *  replaced reaches a runnable build right up to the rename that replaces it.
 *
 *  An empty directory states its record first, because a launcher that no
 *  record claims is one no later installation may replace.
 *
 *  A flat installation converts in four steps: the console launcher takes the
 *  flat executable's name, a flat `build.json` names the activated build, the
 *  record claims the versions layout and the flat entries left for
 *  collection, then the service launcher is placed. A retry after the record
 *  changes still identifies the missing service launcher as the unfinished
 *  flat conversion, so the flat updater keeps its lease through every step. */
export async function publishWindowsLauncher(directory: ContainedDirectory, wrapperDir: string, ownership: WindowsLauncherOwnership, publication: WindowsLauncherPublication): Promise<void> {
  const found = proveWindowsLauncher(directory, wrapperDir, publication.launchers);
  if (found.kind !== ownership.kind
    || (found.kind === "launcher" && ownership.kind === "launcher" && found.missing.join(",") !== ownership.missing.join(","))
    || (found.kind === "flat" && ownership.kind === "flat" && found.swap !== ownership.swap)) {
    refuse("the launcher installation changed while the build was being prepared");
  }
  // The proof above admits no launchers only where both are in place.
  const launchers = publication.launchers;
  if (launchers === undefined) return;
  if (ownership.kind === "absent") {
    writeRecord(directory, launcherRecord([]));
    await placeLaunchers(directory, launchers);
    return;
  }
  if (ownership.kind === "launcher") {
    await placeLaunchers(directory, launchers);
    return;
  }
  if (ownership.swap !== "placed") await placeLauncher(directory, LAUNCHER, launchers.console);
  if (ownership.owned.includes("build.json")) directory.publishFileThrough(pendingName("build.json"), "build.json", publication.metadata);
  writeRecord(directory, launcherRecord(ownership.owned.filter((name) => name !== LAUNCHER)));
  await placeLauncher(directory, WINDOWS_SERVICE_LAUNCHER_NAME, launchers.service);
  log.info("flat Windows installation converted to the versions tree", { wrapperDir, retiring: ownership.owned.length - 1, resumed: ownership.swap !== "pending" });
}

async function placeLaunchers(directory: ContainedDirectory, launchers: WindowsLaunchers): Promise<void> {
  for (const { kind, installedName } of WINDOWS_LAUNCHERS) {
    const launcher = launchers[kind];
    if (!sameLauncher(directory, installedName, launcher)) await placeLauncher(directory, installedName, launcher);
  }
}

function sameLauncher(directory: ContainedDirectory, name: string, launcher: Uint8Array | undefined): boolean {
  if (launcher === undefined) return false;
  try {
    // A file larger than the launcher cannot be it, so the read stops there.
    return directory.readFile(name, launcher.byteLength)?.equals(launcher) === true;
  } catch {
    return false;
  }
}

/** The new launcher under a private name, then the one in place renamed to a
 *  retired name, because Windows refuses to replace an executable that runs,
 *  then the new one renamed into its place. Each rename retries a sharing
 *  refusal for a bounded time (`renameInto`). A failed swap puts the previous
 *  launcher back, always removes the private copy, and answers the failure
 *  that stopped it. */
async function placeLauncher(directory: ContainedDirectory, name: string, launcher: Uint8Array): Promise<void> {
  if (sameLauncher(directory, name, launcher)) return;
  const pending = pendingName(name);
  await directory.writeStreamExclusive(pending, [launcher], { maxBytes: launcher.byteLength });
  let retired: string | undefined;
  try {
    if (directory.hasEntry(name)) {
      retired = `.flywheel-retired-${randomBytes(8).toString("hex")}.exe`;
      directory.renameInto(name, directory, retired);
    }
    directory.renameInto(pending, directory, name);
  } catch (error) {
    if (retired !== undefined) restoreLauncher(directory, name, retired);
    try {
      directory.removeFile(pending);
    } catch (cleanup) {
      log.warn("the private copy of the Windows launcher could not be removed; a later collection removes it", { error: errorMessage(cleanup) });
    }
    throw error;
  }
  log.info("Windows launcher placed", { replaced: retired !== undefined });
}

function restoreLauncher(directory: ContainedDirectory, name: string, retired: string): void {
  try {
    if (!directory.hasEntry(name)) directory.renameInto(retired, directory, name);
  } catch (error) {
    log.warn("the previous Windows launcher could not be put back; the next installation resumes the swap", { error: errorMessage(error) });
  }
}

function writeRecord(directory: ContainedDirectory, text: string): void {
  directory.publishFileThrough(pendingName(RECORD), RECORD, text);
}

function pendingName(name: string): string {
  return `.${name.replace(/^\./, "")}.${process.pid}.${randomBytes(8).toString("hex")}`;
}

/** Whether the process that runs this installation descends from the flat
 *  build at `wrapperDir`, which is the flat updater running the bootstrap
 *  installer: true when the process table shows it, false when the table
 *  shows otherwise, and nothing when there is no table to read. A flat
 *  updater names no requester, so this is the proof that a lease another
 *  process holds is that updater's. Remove after 2026-12-28 with the flat
 *  conversion. */
export function descendsFromFlatBuild(wrapperDir: string, rows: readonly ProcessRow[] | undefined, pid: number = process.pid): boolean | undefined {
  if (rows === undefined) return undefined;
  const flat = path.win32.resolve(wrapperDir, LAUNCHER).toLowerCase();
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  let current = byPid.get(pid);
  for (let hop = 0; current !== undefined && hop < MAX_ANCESTRY; hop += 1) {
    const program = current.argv[0];
    if (program !== undefined && path.win32.resolve(program).toLowerCase() === flat) return true;
    current = current.ppid === current.pid ? undefined : byPid.get(current.ppid);
  }
  return false;
}

/** The launchers the account's active build carries, which are the launchers a
 *  finished installation placed. */
export function activeLaunchers(userDataRoot: string, platformArch: string): WindowsLaunchers | undefined {
  const build = activeBuildDir(userDataRoot);
  if (build === undefined) return undefined;
  try {
    return {
      console: new Uint8Array(readFileSync(path.join(build, NATIVE_DIR, platformArch, WINDOWS_LAUNCHER_EXECUTABLE))),
      service: new Uint8Array(readFileSync(path.join(build, NATIVE_DIR, platformArch, WINDOWS_SERVICE_LAUNCHER_EXECUTABLE))),
    };
  } catch {
    return undefined;
  }
}

/** Remove what the launcher directory no longer needs, once nothing runs it:
 *  each private copy whose writer is gone, each retired executable Windows
 *  now lets be deleted, and then, when no retired executable is left and
 *  both installed launchers match the active build, the flat entries a
 *  conversion left and the flat installer's transaction remainders. A
 *  deletion Windows refuses is an executable that still runs, which the next
 *  collection tries again. */
export function collectWindowsLauncherDirectory(wrapperDir: string, launchers: WindowsLaunchers | undefined): void {
  withLauncherDirectory(wrapperDir, (directory) => {
    for (const name of directory.entryNames()) {
      const [, writer] = PENDING.exec(name) ?? [];
      if (writer !== undefined && !isProcessAlive(Number(writer))) directory.removeFile(name);
    }
    let running = 0;
    for (const name of directory.entryNames().filter((entry) => RETIRED.test(entry))) {
      try {
        directory.removeFile(name);
      } catch (error) {
        running += 1;
        log.debug("a retired Windows executable still runs", { name, error: errorMessage(error) });
      }
    }
    if (running > 0 || launchers === undefined || WINDOWS_LAUNCHERS.some(({ kind, installedName }) => !sameLauncher(directory, installedName, launchers[kind]))) return;
    const record = readRecord(directory, wrapperDir);
    const remainders = directory.directoryEntryNames().filter((entry) => FLAT_REMAINDER.test(entry));
    const retiring = record?.kind === "launcher" ? record.retiring : [];
    if (retiring.length === 0 && remainders.length === 0) return;
    for (const name of [...retiring, ...remainders]) directory.removeTree(name);
    if (retiring.length > 0) writeRecord(directory, launcherRecord([]));
    log.info("flat Windows installation collected", { wrapperDir, entries: retiring.length, remainders: remainders.length });
  });
}

/** Whether a collection of the launcher directory would find anything to
 *  try: one read of the directory, which removes nothing. A retired
 *  executable that still runs answers true until it ends, because only a
 *  deletion can tell a running executable from a free one. */
export function windowsLauncherCollectionPending(wrapperDir: string): boolean {
  try {
    return withLauncherDirectory(wrapperDir, (directory) => {
      const entries = directory.entryNames();
      if (entries.some((entry) => RETIRED.test(entry) || FLAT_REMAINDER.test(entry) || PENDING.test(entry))) return true;
      const record = readRecord(directory, wrapperDir);
      return record?.kind === "launcher" && record.retiring.length > 0;
    }) ?? false;
  } catch (error) {
    log.debug("the Windows launcher directory could not be surveyed", { error: errorMessage(error) });
    return false;
  }
}

function withLauncherDirectory<T>(wrapperDir: string, use: (directory: ContainedDirectory) => T): T | undefined {
  const directory = ContainedDirectory.openExisting(path.dirname(wrapperDir), [path.basename(wrapperDir)], { noFollowBase: true });
  if (directory === undefined) return undefined;
  try {
    return use(directory);
  } finally {
    directory.close();
  }
}
