/**
 * Rebases one change a mutating command made onto the file the project holds
 * now, for a file that another writer changed while the command ran.
 *
 * `git merge-file` merges three versions of the file: the base (the copy's
 * file before the command started), the project's current file, and the
 * command's result. Changes to different lines merge cleanly. Where both sides
 * changed the same lines, conflict markers enclose only those lines and the
 * rest still merges. The merge runs on scratch files in the copy's home and
 * never writes the real project. The project's file is read with the
 * containment publication uses, so a link another writer puts below the
 * project root never brings a file from outside the project into the merge.
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ContainedPathError } from "../../../infra/descriptor-directory.js";
import { Log } from "../../../infra/log.js";
import type { OwnedCommandRunner } from "../../../infra/owned-command.js";
import { observeFileState, type ExpectedFileState } from "../../file-edits/file-state.js";
import { RetainedFileEditAuthority } from "../../file-edits/retained-file-edit-host.js";
import type { CopyChange } from "./bash-private-copy-tree.js";

const log = Log.create({ service: "agent-bash" });

const MERGE_TIMEOUT_MS = 30_000;
/** Git treats a file as binary, and refuses to merge it, when its first 8000 bytes hold a NUL byte. */
const BINARY_PROBE_BYTES = 8000;
const EMPTY = new Uint8Array();

/** What rebasing one change produced. `merged` carries the change to publish:
 *  the merged bytes, expected over the project file they were merged with.
 *  `marked` is true when conflict markers enclose lines both sides changed.
 *  `present` means the project already holds the command's result. `changed`
 *  means the project file stopped being a regular file after the merge read
 *  it, so the change must meet the project file again. */
export type Rebase =
  | { readonly kind: "merged"; readonly change: CopyChange; readonly marked: boolean }
  | { readonly kind: "present" }
  | { readonly kind: "changed" }
  | { readonly kind: "not_applied"; readonly reason: string };

export interface RebaseContext {
  readonly realRoot: string;
  readonly baseRoot: string;
  /** A private directory for the merge's input files. */
  readonly scratch: string;
  readonly runGit: OwnedCommandRunner;
  readonly signal?: AbortSignal;
}

/** Rebases `change`, as the scan found it, onto the project's current file.
 *  A file the command created merges against an empty base. A deletion, a
 *  binary file, or a path that a link or a non-regular file now holds never
 *  merges: the project file stays and the reason is returned. Throws when the
 *  base cannot be read or the scratch cannot be written. */
export async function rebaseChange(change: CopyChange, context: RebaseContext): Promise<Rebase> {
  const real = join(context.realRoot, change.path);
  let theirs: Buffer | undefined;
  try {
    theirs = readContainedFile(real, context.realRoot);
  } catch (error) {
    if (error instanceof ContainedPathError) return notApplied("it is no longer a regular file");
    throw error;
  }
  if (change.after === undefined) return theirs === undefined ? { kind: "present" } : notApplied("the command deleted it");
  if (theirs === undefined && change.expected.kind === "file") return notApplied("the project deleted it");
  const project = theirs ?? EMPTY;
  const basePath = change.expected.kind === "file" ? join(context.baseRoot, change.path) : join(context.scratch, "empty");
  const base = change.expected.kind === "file" ? readFileSync(basePath) : EMPTY;
  if ([base, project, change.after].some(bytes => bytes.subarray(0, BINARY_PROBE_BYTES).includes(0))) return notApplied("binary files are not merged");

  mkdirSync(context.scratch, { recursive: true });
  const projectPath = join(context.scratch, "project");
  const commandPath = join(context.scratch, "command");
  writeFileSync(projectPath, project);
  writeFileSync(commandPath, change.after);
  if (change.expected.kind === "absent") writeFileSync(basePath, EMPTY);
  // The merge result replaces `project`, so its side leads each conflict, as the upstream side does in a rebase.
  const merge = await context.runGit(["git", "merge-file", "-L", "project", "-L", "base", "-L", "command", projectPath, basePath, commandPath], { cwd: context.scratch, timeoutMs: MERGE_TIMEOUT_MS, ...(context.signal ? { signal: context.signal } : {}) });
  // Exit 0 is a clean merge, and 1 to 127 counts the conflicts marked; anything else is a failure.
  if (merge.exitCode === null || merge.exitCode < 0 || merge.exitCode > 127) {
    // Git names only the scratch files and their labels, never a project path or its content.
    log.debug("git merge-file failed", { exitCode: merge.exitCode, stderr: merge.stderr.trim() });
    return notApplied("the merge tool failed");
  }
  const merged = readFileSync(projectPath);
  if (theirs !== undefined && merged.equals(theirs)) return { kind: "present" };
  const expected = theirs === undefined ? { kind: "absent" as const } : expectedOver(real, theirs);
  if (!expected) return { kind: "changed" };
  return { kind: "merged", change: { ...change, after: merged, expected }, marked: merge.exitCode > 0 };
}

/** The project file's bytes, read through the same no-follow walk below the
 *  project root that publication admits through, or undefined when no file is
 *  there. Throws `ContainedPathError` when a link or a non-directory holds part
 *  of the path, or a non-regular file holds the path itself. */
function readContainedFile(path: string, realRoot: string): Buffer | undefined {
  const authority = RetainedFileEditAuthority.admitWritable(path, realRoot, Number.POSITIVE_INFINITY);
  try {
    return authority.snapshot?.content;
  } finally {
    authority.close();
  }
}

/** The state the merged bytes are expected over: the file's fingerprint,
 *  observed after the merge, pinned to the bytes the merge read. A write after
 *  the read leaves bytes that differ from the pin, and a write after this
 *  observation leaves a newer fingerprint, so either way the publisher refuses
 *  the merged bytes and the file is merged again. Undefined when the path no
 *  longer holds a regular file. */
function expectedOver(path: string, read: Buffer): ExpectedFileState | undefined {
  const state = observeFileState(path);
  return state.kind === "file" ? { ...state, sha256: createHash("sha256").update(read).digest("hex") } : undefined;
}

function notApplied(reason: string): Rebase {
  return { kind: "not_applied", reason };
}
