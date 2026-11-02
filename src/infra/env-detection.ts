/**
 * Environment detection.
 *
 * One snapshot of what the host looks like to an agent: the working directory,
 * the shell, the OS, and the git state of the directory work happens in. The
 * repository file probe runs as an owned command.
 */

import { dlopen, FFIType, ptr } from "bun:ffi";
import { existsSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import * as os from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { OwnedCommandRunner } from "./owned-command.js";

const REPO_SNAPSHOT_FILE_LIMIT = 20;

const REPO_SNAPSHOT_UNAVAILABLE = "git ls-files failed";

/** What one directory pair looks like to an agent at one read. */
interface EnvSnapshot {
  /** The `<env>` block the system prompt renders. */
  readonly envBlock: string;
}

/** The two directory authorities a snapshot describes (ARCH-DIRECTORIES-001). A snapshot is
 *  keyed by both: the same execution directory under a different project is a
 *  different environment, and reusing one for the other would be wrong. */
export interface EnvScope {
  readonly projectRoot: string;
  readonly executionCwd: string;
}

export type EnvCaptureResolver = (scope: EnvScope) => Promise<EnvSnapshot>;

export function detectShell(): string {
  return process.env.SHELL ?? process.env.ComSpec ?? process.env.COMSPEC ?? "unknown";
}

/**
 * The local calendar date of `now` as `YYYY-MM-DD`: the person's own clock in their time zone, which is also the date
 * that the Claude engine states. Every date that a model sees comes from here.
 *
 * On macOS and Linux the zone is the zone of this process, which `TZ` sets, and Flywheel gives the engine the same zone
 * (`localDateZone`). On Windows the zone is the Windows system zone, whatever `TZ` names: the bundled engine on Windows
 * dates in the system zone and ignores `TZ`, so a date in any other zone would disagree with the engine's own.
 */
export function localDate(now: Date = new Date()): string {
  const { year, month, day } = process.platform === "win32" ? windowsSystemDate(now) : { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The IANA zone that a child process needs in `TZ` to state the date that `localDate` states. On Windows there is
 *  none: `localDate` follows the system zone, and so does every process there that gets no `TZ`. */
export function localDateZone(): string | undefined {
  return process.platform === "win32" ? undefined : Intl.DateTimeFormat().resolvedOptions().timeZone;
}

let kernel32: ReturnType<typeof openTimeApi> | undefined;

function openTimeApi() {
  return dlopen("kernel32.dll", {
    SystemTimeToTzSpecificLocalTime: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  });
}

/** The calendar date of `now` in the active Windows system zone. Windows reads that zone itself and never reads `TZ`,
 *  so a change of the system zone applies to the next date. The call takes microseconds and starts no process. */
function windowsSystemDate(now: Date) {
  kernel32 ??= openTimeApi();
  // SYSTEMTIME: year, month, day of the week (which the call ignores), day, hour, minute, second, millisecond.
  const utc = Uint16Array.of(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, now.getUTCDate(), now.getUTCHours(), now.getUTCMinutes(), now.getUTCSeconds(), now.getUTCMilliseconds());
  const local = new Uint16Array(8);
  // With no zone given, the call converts in the active system zone, with its daylight saving rules.
  if (!kernel32.symbols.SystemTimeToTzSpecificLocalTime(null, ptr(utc), ptr(local))) throw new Error("SystemTimeToTzSpecificLocalTime could not convert the current time");
  const [year = 0, month = 0, , day = 0] = local;
  return { year, month, day };
}

/** True when cwd is anywhere inside a Git working tree. */
export function isGitRepo(cwd: string): boolean {
  return findGitDirectory(cwd) !== undefined;
}

/** True when cwd belongs to a linked Git worktree, including its subdirectories. */
export function isGitWorktree(cwd: string): boolean {
  const directory = findGitDirectory(cwd);
  return directory !== undefined && existsSync(join(directory.gitDirectory, "commondir"));
}

/** Reads the branch named by Git's canonical HEAD. Detached and unavailable
 *  repositories have no branch. */
function readGitBranch(gitDirectory: string): string | undefined {
  try {
    const head = readFileSync(join(gitDirectory, "HEAD"), "utf8").trim();
    const prefix = "ref: refs/heads/";
    return head.startsWith(prefix) ? head.slice(prefix.length) || undefined : undefined;
  } catch {
    return undefined;
  }
}

/** Publishes a directory's current branch, linked worktree root, and subsequent HEAD changes. The returned
 *  disposer stops the poll and releases the directory watcher.
 *
 *  Two observers, because neither alone is both correct and prompt. Git
 *  publishes a branch change by renaming `HEAD.lock` over `HEAD`, which
 *  replaces the file a watch was bound to, so only a poll survives it on any
 *  platform. But a poll's interval is a floor on how long the change takes to
 *  surface, and under load it is far more than that: a busy machine starves
 *  the poller for seconds. Watching the directory the replacement lands in
 *  reports it as it happens where the platform supports that, and the poll
 *  remains the guarantee where it does not.
 *
 *  The poll reads HEAD and compares it with the branch last published, which
 *  this function read before it returned. Neither filesystem watch can be that
 *  guarantee: each arms after the call returns, and a replacement that lands
 *  first is lost to it. A directory watch misses it outright, and `watchFile`
 *  takes the replaced file as its baseline and reports no change.
 *
 *  Publication is deduplicated, so two observers seeing one replacement
 *  publish it once and rewriting HEAD with the branch it already named
 *  publishes nothing. */
export function observeGitDirectory(cwd: string, publish: (view: { readonly branch?: string; readonly worktreeRoot?: string }) => void): () => void {
  const gitDirectory = findGitDirectory(cwd);
  const worktreeRoot = gitDirectory && existsSync(join(gitDirectory.gitDirectory, "commondir")) ? gitDirectory.root : undefined;
  const report = (branch: string | undefined) => publish({ ...(branch === undefined ? {} : { branch }), ...(worktreeRoot === undefined ? {} : { worktreeRoot }) });
  if (!gitDirectory) {
    report(undefined);
    return () => {};
  }
  let published = readGitBranch(gitDirectory.gitDirectory);
  report(published);

  const refresh = () => {
    const branch = readGitBranch(gitDirectory.gitDirectory);
    if (branch === published) return;
    published = branch;
    report(branch);
  };
  const poll = setInterval(refresh, 100);
  poll.unref();

  let directoryWatcher: FSWatcher | undefined;
  try {
    directoryWatcher = watch(gitDirectory.gitDirectory, { persistent: false }, (_event, name) => {
      // A platform that reports no filename reports every change here, and
      // reading HEAD again is cheap enough to answer either way.
      if (name === null || name === undefined || name.toString() === "HEAD") refresh();
    });
    // A watch that fails later is a lost optimisation, not a lost guarantee.
    directoryWatcher.on("error", () => {});
  } catch {
    // Some filesystems support no directory watch at all. The poll covers it.
  }

  return () => {
    clearInterval(poll);
    directoryWatcher?.close();
  };
}

function findGitDirectory(cwd: string): { readonly gitDirectory: string; readonly root: string } | undefined {
  let current = resolve(cwd);
  while (true) {
    const marker = join(current, ".git");
    try {
      const markerStats = statSync(marker);
      if (markerStats.isDirectory()) return { gitDirectory: marker, root: current };
      if (markerStats.isFile()) {
        const pointer = readFileSync(marker, "utf8").trim();
        const target = pointer.startsWith("gitdir:") ? pointer.slice("gitdir:".length).trim() : "";
        if (target) return { gitDirectory: isAbsolute(target) ? target : resolve(current, target), root: current };
      }
    } catch {
      // A directory without Git metadata is a normal search step.
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/**
 * Resolves the environment of a directory pair. The directory facts are probed once for the life of the resolver. The
 * date is read at each call, so a caller that reads once for each turn states the date on which that turn started,
 * and the first turn after local midnight states the new date.
 */
export function createEnvCaptureResolver(run: OwnedCommandRunner): EnvCaptureResolver {
  // One probe per directory pair, held as the operation that produces it:
  // every reader of one environment joins the probe already running instead of
  // starting a second, and readers that arrive later get the settled answer.
  // The map belongs to this resolver, so a scope with different launch
  // authority never reads another scope's environment.
  const probes = new Map<string, Promise<readonly string[]>>();

  return async (scope) => {
    const date = localDate();
    const key = `${scope.projectRoot}\u0000${scope.executionCwd}`;
    let probe = probes.get(key);
    if (probe === undefined) {
      // A probe that could not run at all (a closed scope, a missing git) is
      // dropped rather than remembered, so the next read retries instead of
      // inheriting one refusal for the life of the resolver.
      probe = probeDirectory(run, scope.executionCwd);
      probe.catch(() => { probes.delete(key); });
      probes.set(key, probe);
    }
    const lines = [...await probe, `Date: ${date}`];
    return { envBlock: `<env>\n${lines.join("\n")}\n</env>` };
  };
}

/** The `<env>` lines that hold for the life of a directory pair. */
async function probeDirectory(run: OwnedCommandRunner, cwd: string): Promise<readonly string[]> {
  const gitRepo = isGitRepo(cwd);
  const snapshot = gitRepo ? await repoSnapshot(run, cwd) : "N/A";
  return [
    `Working directory: ${cwd}`,
    `Is directory a git repo: ${gitRepo ? "Yes" : "No"}`,
    `Repo snapshot: ${snapshot}`,
    `Platform: ${process.platform}`,
    `Shell: ${detectShell()}`,
    `OS Version: ${os.type()} ${os.release()} (${process.platform} ${process.arch})`,
  ];
}

async function repoSnapshot(run: OwnedCommandRunner, cwd: string): Promise<string> {
  const result = await run(["git", "ls-files"], { cwd });
  if (result.exitCode !== 0) return REPO_SNAPSHOT_UNAVAILABLE;
  const files = result.stdout.trim().split("\n").filter(Boolean);
  const count = files.length;
  const sample = files.slice(0, REPO_SNAPSHOT_FILE_LIMIT);

  if (count === 0) return "Greenfield repo (0 tracked files)";
  if (count < 5) return `Greenfield repo (${count} tracked files): ${sample.join(", ")}`;
  return `${count} tracked files (first ${REPO_SNAPSHOT_FILE_LIMIT}): ${sample.join(", ")}`;
}