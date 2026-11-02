/**
 * The durable record of one private project copy: everything the copy's
 * landing reads, written into the copy's home when the copy is taken.
 *
 * The build that launched a mutating command lands the copy from the copy it
 * holds in memory. A later build that adopted the command across a planned
 * replacement (ARCH-RUNTIME-033) holds no memory of it, so it lands the copy from this
 * record, through the same landing. The record is written and read on the
 * private copy Worker, because it holds one entry per copied project file.
 *
 * Version 4 binds the file-only policy and its finalized repository baseline.
 * Older records retain their Git identity without gaining the current policy.
 * A reader that meets a record of another version, or one it
 * cannot parse, answers why and leaves the record and the copy exactly as they
 * are.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { FileFingerprint } from "../../file-edits/file-state.js";
import type { MutationGuardKind } from "./bash-mutation-guard.js";
import type { CopiedFile, CopiedProject, RealFileState } from "./bash-private-copy-tree.js";
import type { RepositoryState, StateDigest } from "./bash-copy-repository-state.js";

/** The copy's record, in its home. Taking the copy writes it last. */
export const PRIVATE_COPY_RECORD = "copy.json";
/** The index filename, in the private Git directory or the home of a version 2 copy. */
export const PRIVATE_INDEX = "index";
/** Legacy Git identity is retained for recovery, not promoted to the current execution policy. */
type CopyGit =
  | { readonly kind: "none" }
  | { readonly kind: "repository"; readonly gitDir: string; readonly privateGitDir: string; readonly commonDir: string; readonly workTrees: readonly string[] }
  | { readonly kind: "shared-repository"; readonly gitDir: string }
  | { readonly kind: "unrecorded" };

/** A taken copy as its record holds it: the copy the change scan reads, the
 *  base a rebase merges against, the guard the command ran under, and the
 *  repository whose state the landing checks. */
export interface RecordedCopy extends CopiedProject {
  readonly guard: MutationGuardKind;
  readonly execution: {
    readonly kind: "file-only-v4";
    readonly treeRoot: string;
    readonly baseline: { readonly repository: RepositoryState | null; readonly topology: StateDigest };
  };
  readonly git:
    | { readonly kind: "none" }
    | { readonly kind: "repository"; readonly gitDir: string; readonly privateGitDir: string; readonly commonDir: string; readonly workTrees: readonly string[] };
}

type CopyObservations = Omit<RecordedCopy, "git" | "execution"> & { readonly git: CopyGit };
/** A copy as a landing reads it, with explicit current-policy or legacy eligibility. */
export type ReadCopy = CopyObservations & {
  readonly execution: RecordedCopy["execution"]
    | { readonly kind: "legacy-non-git"; readonly version: 2 | 3 }
    | { readonly kind: "legacy-unlandable"; readonly version: 1 | 2 | 3 };
};

/** What reading the record in a copy's home found. `unreadable` completes the
 *  sentence "the copy's record ...": a version this build does not know, or
 *  bytes it cannot read or parse. */
export type PrivateCopyRecordRead =
  | { readonly kind: "recorded"; readonly copy: ReadCopy }
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable"; readonly reason: string };

/** Every guard kind a record can name; the check fails the build when a kind is added without it here. */
const GUARDS = { seatbelt: true, "mount-namespace": true, none: true } satisfies { readonly [kind in MutationGuardKind]: true };

/** A fingerprint as version 1 stores it: its nanosecond times as decimal text, which JSON carries exactly. */
interface StoredFingerprint {
  readonly identity: string;
  readonly size: number;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
}

interface StoredCopyV2 {
  readonly version: 2;
  readonly realRoot: string;
  readonly copyRoot: string;
  readonly baseRoot: string;
  readonly guard: MutationGuardKind;
  readonly shared: readonly string[];
  readonly files: ReadonlyArray<{ readonly path: string; readonly real: StoredFingerprint & { readonly sha256?: string }; readonly copy: StoredFingerprint; readonly mode: number }>;
  readonly links: ReadonlyArray<{ readonly path: string; readonly target: string }>;
  /** The real Git directory; null outside Git. */
  readonly gitDir: string | null;
}

interface StoredCopyV3 extends Omit<StoredCopyV2, "version"> {
  readonly version: 3;
  readonly privateGitDir: string | null;
  readonly commonDir: string | null;
  readonly workTrees: readonly string[];
}

interface StoredCopyV4 extends Omit<StoredCopyV3, "version"> {
  readonly version: 4;
  readonly execution: RecordedCopy["execution"];
}

/** Writes the record of `copy` into `home`. Throws when it cannot be written. */
export function writePrivateCopyRecord(home: string, copy: RecordedCopy): void {
  const stored: StoredCopyV4 = {
    version: 4,
    execution: copy.execution,
    realRoot: copy.realRoot,
    copyRoot: copy.copyRoot,
    baseRoot: copy.baseRoot,
    guard: copy.guard,
    shared: copy.shared,
    files: [...copy.files].map(([path, file]) => ({
      path,
      real: { ...storedFingerprint(file.real), ...(file.real.sha256 === undefined ? {} : { sha256: file.real.sha256 }) },
      copy: storedFingerprint(file.copy),
      mode: file.mode,
    })),
    links: [...copy.links].map(([path, target]) => ({ path, target })),
    gitDir: copy.git.kind === "repository" ? copy.git.gitDir : null,
    privateGitDir: copy.git.kind === "repository" ? copy.git.privateGitDir : null,
    commonDir: copy.git.kind === "repository" ? copy.git.commonDir : null,
    workTrees: copy.git.kind === "repository" ? copy.git.workTrees : [],
  };
  writeFileSync(join(home, PRIVATE_COPY_RECORD), JSON.stringify(stored));
}

/** Reads the record in `home` strictly as version 4, 3, 2, or 1. Never
 *  throws, and never changes the record or the copy. */
export function readPrivateCopyRecord(home: string): PrivateCopyRecordRead {
  let text: string;
  try {
    text = readFileSync(join(home, PRIVATE_COPY_RECORD), "utf8");
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "an unknown error";
    return code === "ENOENT" ? { kind: "missing" } : { kind: "unreadable", reason: `could not be read (${code})` };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: "unreadable", reason: "is not valid JSON" };
  }
  if (!isObject(value)) return { kind: "unreadable", reason: "is not a JSON object" };
  if (value.version === 4) return recorded(decodeV4(value), 4);
  // Copies written before 2026-10-16 have no file-only execution policy. Remove this conversion after 2027-04-16.
  if (value.version === 3) return recorded(legacy(decodeV3(value), 3), 3);
  if (value.version === 2) return recorded(legacy(decodeV2(value), 2), 2);
  if (value.version === 1) return recorded(legacy(decodeV1(value), 1), 1);
  return { kind: "unreadable", reason: `has version ${String(value.version)}, which this build cannot read` };
}

function recorded(copy: ReadCopy | undefined, version: 1 | 2 | 3 | 4): PrivateCopyRecordRead {
  return copy === undefined ? { kind: "unreadable", reason: `does not have the shape of version ${version}` } : { kind: "recorded", copy };
}

function legacy(copy: CopyObservations | undefined, version: 1 | 2 | 3): ReadCopy | undefined {
  if (!copy) return undefined;
  return { ...copy, execution: version !== 1 && copy.git.kind === "none" ? { kind: "legacy-non-git", version } : { kind: "legacy-unlandable", version } };
}

function decodeV4(value: { readonly [key: string]: unknown }): ReadCopy | undefined {
  const { execution, ...v3 } = value;
  const copy = decodeV3(v3);
  if (!copy || !isObject(execution) || !hasExactly(execution, ["kind", "treeRoot", "baseline"]) || execution.kind !== "file-only-v4" || !isAbsolutePath(execution.treeRoot)) return undefined;
  const baseline = execution.baseline;
  if (!isObject(baseline) || !hasExactly(baseline, ["repository", "topology"]) || !isDigest(baseline.topology)) return undefined;
  if (copy.git.kind !== "none" && copy.git.kind !== "repository") return undefined;
  const repository = baseline.repository;
  if (repository !== null && !isRepositoryState(repository)) return undefined;
  if ((copy.git.kind === "none") !== (repository === null)) return undefined;
  return { ...copy, execution: { kind: "file-only-v4", treeRoot: execution.treeRoot, baseline: { topology: baseline.topology, repository } } };
}

function isDigest(value: unknown): value is StateDigest {
  return isObject(value) && hasExactly(value, ["sha256", "count"]) && typeof value.sha256 === "string" && /^[0-9a-f]{64}$/.test(value.sha256) && isCount(value.count);
}

function isRepositoryState(value: unknown): value is RepositoryState {
  if (!isObject(value) || !hasExactly(value, ["head", "refs", "stash", "index"]) || !isDigest(value.refs) || !isDigest(value.stash) || !isDigest(value.index) || !isObject(value.head)) return false;
  const head = value.head;
  const object = head.object === null || (typeof head.object === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(head.object));
  return object && (head.kind === "direct"
    ? hasExactly(head, ["kind", "object"]) && head.object !== null
    : head.kind === "symbolic" && hasExactly(head, ["kind", "object", "target"]) && typeof head.target === "string" && /^refs\/\S+$/.test(head.target) && !head.target.includes("\0"));
}

function decodeV3(value: { readonly [key: string]: unknown }): CopyObservations | undefined {
  const { privateGitDir, commonDir, workTrees, ...v2 } = value;
  if (!Array.isArray(workTrees) || !workTrees.every(isAbsolutePath)) return undefined;
  const copy = decodeV2(v2);
  if (!copy) return undefined;
  if (copy.git.kind === "none") return privateGitDir === null && commonDir === null && workTrees.length === 0 ? copy : undefined;
  if (copy.git.kind !== "shared-repository" || !isAbsolutePath(privateGitDir) || !isAbsolutePath(commonDir)) return undefined;
  return { ...copy, git: { kind: "repository", gitDir: copy.git.gitDir, privateGitDir, commonDir, workTrees } };
}

/** Exactly the keys of version 2, each of its type. */
function decodeV2(value: { readonly [key: string]: unknown }): CopyObservations | undefined {
  const { gitDir, ...v1 } = value;
  if (gitDir !== null && !isAbsolutePath(gitDir)) return undefined;
  const copy = decodeV1(v1);
  return copy && { ...copy, git: gitDir === null ? { kind: "none" } : { kind: "shared-repository", gitDir } };
}

/** Exactly the keys of version 1, each of its type. Version 1 did not record the Git directory. */
function decodeV1(value: { readonly [key: string]: unknown }): CopyObservations | undefined {
  if (!hasExactly(value, ["version", "realRoot", "copyRoot", "baseRoot", "guard", "shared", "files", "links"])) return undefined;
  const { realRoot, copyRoot, baseRoot, guard, shared, files, links } = value;
  if (!isAbsolutePath(realRoot) || !isAbsolutePath(copyRoot) || !isAbsolutePath(baseRoot)) return undefined;
  if (!isGuard(guard) || !Array.isArray(shared) || !Array.isArray(files) || !Array.isArray(links)) return undefined;
  if (!shared.every(isRelativePath)) return undefined;
  const copiedFiles = new Map<string, CopiedFile>();
  for (const entry of files) {
    const file = decodeFile(entry);
    if (file === undefined || copiedFiles.has(file.path)) return undefined;
    copiedFiles.set(file.path, file.file);
  }
  const copiedLinks = new Map<string, string>();
  for (const entry of links) {
    if (!isObject(entry) || !hasExactly(entry, ["path", "target"]) || !isRelativePath(entry.path) || typeof entry.target !== "string" || copiedLinks.has(entry.path)) return undefined;
    copiedLinks.set(entry.path, entry.target);
  }
  return { realRoot, copyRoot, baseRoot, guard, shared, files: copiedFiles, links: copiedLinks, git: { kind: "unrecorded" } };
}

function decodeFile(entry: unknown): { readonly path: string; readonly file: CopiedFile } | undefined {
  if (!isObject(entry) || !hasExactly(entry, ["path", "real", "copy", "mode"]) || !isRelativePath(entry.path)) return undefined;
  const { real, copy, mode } = entry;
  if (!isObject(real) || !isObject(copy) || !isCount(mode)) return undefined;
  const { sha256, ...fingerprint } = real;
  const realState = decodeFingerprint(fingerprint);
  const copyState = decodeFingerprint(copy);
  if (realState === undefined || copyState === undefined || (sha256 !== undefined && (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)))) return undefined;
  const pinned: RealFileState = sha256 === undefined ? realState : { ...realState, sha256 };
  return { path: entry.path, file: { real: pinned, copy: copyState, mode } };
}

function decodeFingerprint(value: { readonly [key: string]: unknown }): FileFingerprint | undefined {
  if (!hasExactly(value, ["identity", "size", "mtimeNs", "ctimeNs"])) return undefined;
  const { identity, size, mtimeNs, ctimeNs } = value;
  if (typeof identity !== "string" || identity.length === 0 || !isCount(size) || !isNanoseconds(mtimeNs) || !isNanoseconds(ctimeNs)) return undefined;
  return { kind: "file", identity, size, mtimeNs: BigInt(mtimeNs), ctimeNs: BigInt(ctimeNs) };
}

function storedFingerprint(fingerprint: FileFingerprint): StoredFingerprint {
  return { identity: fingerprint.identity, size: fingerprint.size, mtimeNs: fingerprint.mtimeNs.toString(), ctimeNs: fingerprint.ctimeNs.toString() };
}

function isObject(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactly(value: { readonly [key: string]: unknown }, keys: readonly string[]): boolean {
  const present = Object.keys(value);
  return present.length === keys.length && present.every((key) => keys.includes(key));
}

function isGuard(value: unknown): value is MutationGuardKind {
  return typeof value === "string" && Object.hasOwn(GUARDS, value);
}

function isAbsolutePath(value: unknown): value is string {
  return typeof value === "string" && isAbsolute(value);
}

function isRelativePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !isAbsolute(value);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNanoseconds(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/.test(value);
}
