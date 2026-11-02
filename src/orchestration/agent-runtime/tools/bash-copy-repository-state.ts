import { createHash } from "node:crypto";
import type { OwnedCommandResult, OwnedCommandRunner } from "../../../infra/owned-command.js";
import { readRepositoryRefs, readReftableStack } from "./bash-copy-refs.js";
import { runPrivateCopyJob } from "./bash-private-copy-jobs.js";

export interface StateDigest {
  readonly sha256: string;
  readonly count: number;
}

/** A bounded, complete repository observation. It does not include index stat caches or object-store bytes. */
export interface RepositoryState {
  readonly head:
    | { readonly kind: "symbolic"; readonly target: string; readonly object: string | null }
    | { readonly kind: "direct"; readonly object: string };
  readonly refs: StateDigest;
  readonly stash: StateDigest;
  readonly index: StateDigest;
}

/** Reads the final-state backstop through Git and no-follow metadata reads. Any incomplete enumeration throws, never equals an empty state. */
export async function readCopyRepositoryState(gitDir: string, runGit: OwnedCommandRunner): Promise<RepositoryState> {
  const execute = async (args: readonly string[]): Promise<OwnedCommandResult> => {
    const result = await runGit(["git", "--no-optional-locks", `--git-dir=${gitDir}`, "-c", "core.fsmonitor=false", ...args], { timeoutMs: 30_000, maxOutputBytes: 64 * 1024 * 1024 });
    if (result.timedOut || result.stdoutTruncated || result.exitCode === null) throw new Error("Git repository inspection did not finish completely");
    return result;
  };
  const layout = await execute(["rev-parse", "--show-object-format", "--show-ref-format"]);
  const [objectFormat, refFormat] = layout.stdout.trim().split("\n");
  if (layout.exitCode !== 0 || !["sha1", "sha256"].includes(objectFormat ?? "") || !["files", "reftable"].includes(refFormat ?? "")) throw new Error("Git could not read repository formats");
  const symbolic = await execute(["symbolic-ref", "-q", "--no-recurse", "HEAD"]);
  const resolved = await execute(["rev-parse", "--verify", "-q", "HEAD"]);
  const object = resolved.exitCode === 0 ? resolved.stdout.trim() : null;
  if ((resolved.exitCode !== 0 && resolved.exitCode !== 1) || (object !== null && !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(object))) throw new Error("Git could not resolve HEAD");
  let head: RepositoryState["head"];
  if (symbolic.exitCode === 0) {
    const target = symbolic.stdout.trim();
    if (!/^refs\/\S+$/.test(target) || target.includes("\0")) throw new Error("Git returned an invalid HEAD target");
    head = { kind: "symbolic", target, object };
  } else {
    if (symbolic.exitCode !== 1 || object === null) throw new Error("Git could not inspect HEAD");
    head = { kind: "direct", object };
  }
  const index = await execute(["ls-files", "--stage", "-z"]);
  if (index.exitCode !== 0) throw new Error("Git could not enumerate the complete index");
  const indexDigest = await runPrivateCopyJob({ kind: "index", bytes: index.stdoutBytes });
  if (refFormat === "reftable") {
    // Git's porcelain omits dangling symbolic refs. One immutable stack covers all refs and reflogs, even on Git 2.45.
    const stack = digestStateEntries((await readReftableStack(gitDir)).values());
    return { head, refs: stack, stash: stack, index: indexDigest };
  }
  const refs = await readRepositoryRefs({ gitDir, runGit });
  let stash: StateDigest;
  if (!refs.has("refs/stash")) stash = digestStateEntries([]);
  else {
    const stack = await execute(["reflog", "show", "--format=%H %gs", "refs/stash"]);
    if (stack.exitCode !== 0) throw new Error("Git could not enumerate the complete stash");
    const rows = stack.stdout.split("\n").filter(Boolean);
    if (rows.some(row => !/^(?:[0-9a-f]{40}|[0-9a-f]{64}) /.test(row))) throw new Error("Git returned an invalid stash entry");
    stash = digestStateEntries(rows.map(row => Buffer.from(row)));
  }
  return { head, refs: digestStateEntries([...refs].map(entry => Buffer.from(JSON.stringify(entry)))), stash, index: indexDigest };
}

/** Validates a complete NUL-terminated Git index listing and hashes its sorted raw entries.
 * Runs in the private-copy Worker. Invalid or incomplete entries throw. */
export function digestIndexEntries(bytes: Uint8Array): StateDigest {
  const entries: Buffer[] = [];
  const raw = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let start = 0;
  for (let end = 0; end < raw.length; end++) {
    if (raw[end] !== 0) continue;
    const entry = raw.subarray(start, end);
    const tab = entry.indexOf(9);
    if (tab < 0 || !/^[0-7]{6} (?:[0-9a-f]{40}|[0-9a-f]{64}) [0-3]$/.test(entry.subarray(0, tab).toString("ascii")) || tab + 1 === entry.length) throw new Error("Git returned an invalid index entry");
    entries.push(entry);
    start = end + 1;
  }
  if (start !== raw.length) throw new Error("Git returned an incomplete index entry");
  entries.sort(Buffer.compare);
  return digestStateEntries(entries);
}

/** Hashes length-framed values in their canonical order without retaining their bytes in the record. */
export function digestStateEntries(entries: Iterable<Uint8Array>): StateDigest {
  const hash = createHash("sha256");
  let count = 0;
  for (const entry of entries) {
    hash.update(`${entry.byteLength}:`).update(entry);
    count++;
  }
  return { sha256: hash.digest("hex"), count };
}
