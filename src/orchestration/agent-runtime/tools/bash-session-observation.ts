import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import type { MutationFileEvidence } from "../../../infra/mutation-evidence.js";
import { SCRATCH_MUTATIONS_DIR, SESSIONS_DIR } from "../../../infra/paths.js";
import { fileFingerprint, sameObservedState, type FileFingerprint } from "../../file-edits/file-state.js";
import { cloneEntry, mirrorTree, RACY_WINDOW_NS, type MirrorPlan, type MirrorState, type MirrorTally } from "./bash-private-copy-mirror.js";
import { removedDirectories, type RemovedDirectory } from "./bash-private-copy-tree.js";
import { BACKGROUND_COMMAND_FILE_PREFIX, FOREGROUND_COMMAND_FILE_PREFIX } from "./bash-script.js";

/** The home directory that holds the session folder as the command starts. */
export const BEFORE_IMAGE = "session-before";

export interface SessionFolderSnapshot {
  readonly startedNs: bigint;
  readonly files: ReadonlyMap<string, FileFingerprint>;
  readonly imageFiles: ReadonlyMap<string, FileFingerprint>;
}

/** Regular session-folder contents that already landed, not publication requests. */
interface ObservedSessionChange {
  readonly path: string;
  readonly before: Uint8Array | undefined;
  readonly after: Uint8Array | undefined;
  readonly binary?: { readonly before: MutationFileEvidence["before"]; readonly after: MutationFileEvidence["after"] };
}

export type SessionFolderObservation = { readonly kind: "observed"; readonly changes: readonly ObservedSessionChange[]; readonly removedDirectories: readonly RemovedDirectory[] } | { readonly kind: "damaged" };

/** Mirrors the session folder into the home's before image without changing
 * its shared execution paths, and returns the snapshot with the mirror's state.
 * With `prior`, the state of the previous image in this home, only drifted
 * entries are written again. Runtime-owned files are excluded only where their
 * producers create them. Adds what it writes to `tally`. Answers undefined
 * outside a session folder. */
export function snapshotSessionFolder(home: string, prior?: MirrorState, tally?: MirrorTally): { readonly snapshot: SessionFolderSnapshot; readonly state: MirrorState } | undefined {
  const sessionDir = sessionFolder(home);
  if (!sessionDir || !lstatSync(sessionDir, { throwIfNoEntry: false })?.isDirectory()) return undefined;
  const startedNs = BigInt(Date.now()) * 1_000_000n;
  const state = mirrorTree({ source: sessionDir, target: join(home, BEFORE_IMAGE), plan: sessionPlan, prior, startedNs, pin: true, clone: cloneEntry, ...(tally ? { tally } : {}) });
  const files = new Map([...state.files].map(([path, file]) => [path, file.source]));
  const imageFiles = new Map([...state.files].map(([path, file]) => [path, file.target]));
  return { snapshot: { startedNs, files, imageFiles }, state };
}

/** Compares the real session folder with the copy-local before image. Old copy homes
 * without an image observe nothing. Links are not followed; only regular file
 * contents participate. Concurrent session-folder writers are attributed to this command. */
export function scanSessionChanges(home: string, projectRoot: string | undefined, snapshot?: SessionFolderSnapshot): SessionFolderObservation {
  const sessionDir = sessionFolder(home);
  if (!sessionDir) return { kind: "observed", changes: [], removedDirectories: [] };
  const evidencePath = (path: string): string => projectRoot === undefined ? join(sessionDir, path) : relative(projectRoot, join(sessionDir, path));
  const beforeRoot = join(home, BEFORE_IMAGE);
  if (!lstatSync(beforeRoot, { throwIfNoEntry: false })?.isDirectory()) return snapshot ? { kind: "damaged" } : { kind: "observed", changes: [], removedDirectories: [] };
  const imageFiles = sessionFiles(beforeRoot);
  if (snapshot && (imageFiles.size !== snapshot.imageFiles.size || [...snapshot.imageFiles].some(([path, expected]) => {
    const current = imageFiles.get(path);
    return !current || !sameObservedState(current, expected);
  }))) return { kind: "damaged" };
  const beforeFiles = snapshot?.files ?? imageFiles;
  const afterFiles = sessionFiles(sessionDir);
  const changes: ObservedSessionChange[] = [];
  for (const path of new Set([...beforeFiles.keys(), ...afterFiles.keys()])) {
    const original = snapshot?.files.get(path);
    const current = afterFiles.get(path);
    // Recent same-tick writes require byte comparison. Adopted copies have no
    // in-memory observations and trust regular files in the retained image.
    if (original && current && snapshot && original.mtimeNs < snapshot.startedNs - RACY_WINDOW_NS && original.ctimeNs < snapshot.startedNs - RACY_WINDOW_NS && sameObservedState(current, original)) continue;
    if (beforeFiles.has(path) && !imageFiles.has(path)) return { kind: "damaged" };
    const before = imageFiles.has(path) ? readFileSync(join(beforeRoot, path)) : undefined;
    const after = afterFiles.has(path) ? readFileSync(join(sessionDir, path)) : undefined;
    if (before && after && before.equals(after)) continue;
    let binary: ObservedSessionChange["binary"];
    try {
      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
      if (before) decoder.decode(before);
      if (after) decoder.decode(after);
    } catch {
      const identity = (bytes: Uint8Array | undefined) => bytes === undefined ? null : { bytes: bytes.byteLength, sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex") };
      binary = { before: identity(before), after: identity(after) };
    }
    changes.push({ path: evidencePath(path), before, after, ...(binary ? { binary } : {}) });
  }
  const removed = removedDirectories(beforeRoot, sessionDir, [...beforeFiles].map(([path, file]) => [path, file.size] as const), excludedSessionEntry);
  return {
    kind: "observed",
    changes: changes.sort((a, b) => a.path.localeCompare(b.path)),
    removedDirectories: removed.map(directory => ({ ...directory, path: evidencePath(directory.path) })),
  };
}

function sessionFolder(home: string): string | undefined {
  const mutations = dirname(home);
  const scratch = dirname(mutations);
  const session = dirname(scratch);
  // Only a real session folder qualifies: anything else would observe runtime stores such as flywheel.sqlite.
  return basename(mutations) === SCRATCH_MUTATIONS_DIR && basename(scratch) === "scratch" && dirname(session).endsWith(`${sep}${join(SESSIONS_DIR)}`) ? session : undefined;
}

function sessionPlan(directory: string, name: string): MirrorPlan {
  if (excludedSessionEntry(directory, name)) return "omit";
  return directory === "" && name === "scratch" ? "descend" : "mirror";
}

function excludedSessionEntry(directory: string, name: string): boolean {
  return (directory === "" && name === "owner.pid") || (directory === "scratch" && (name === SCRATCH_MUTATIONS_DIR || name.startsWith(BACKGROUND_COMMAND_FILE_PREFIX) || name.startsWith(FOREGROUND_COMMAND_FILE_PREFIX)));
}

function sessionFiles(root: string): ReadonlyMap<string, FileFingerprint> {
  const files = new Map<string, FileFingerprint>();
  const walk = (directory: string): void => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      if (excludedSessionEntry(directory, entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) files.set(path, fileFingerprint(lstatSync(join(root, path), { bigint: true })));
    }
  };
  if (lstatSync(root, { throwIfNoEntry: false })?.isDirectory()) walk("");
  return files;
}
