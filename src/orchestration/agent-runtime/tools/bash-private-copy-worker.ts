/**
 * The private copy Worker of one owner (`createPrivateCopyJobs`). It runs the
 * tree jobs, which visit every project file, off the runtime event loop, one
 * at a time in the order they arrive, and answers each by its id. It lives
 * until its owner ends it.
 *
 * It also holds, by home, the mirror state and the entries (one per copied
 * file and link) of the copies it took, so that a take, its record, and its
 * landing's scan exchange only a home and the changed files with the owner,
 * never the state of every project file.
 */

import { readPrivateCopyRecord } from "./bash-private-copy-record.js";
import { digestIndexEntries } from "./bash-copy-repository-state.js";
import { copyProjectTree, finalizePrivateCopy, observeCopyTopology, scanCopyChanges, scannedTopology, type CopiedEntries, type CopyTreeState, type PrivateCopyAnswer, type PrivateCopyReply, type PrivateCopyRequest } from "./bash-private-copy-tree.js";
import { scanSessionChanges, snapshotSessionFolder } from "./bash-session-observation.js";

/** How many recorded copies the Worker holds. A pool holds one idle copy per
 *  real root and a session runs few mutating commands at once. A reuse of a
 *  dropped copy takes a new copy, and the landing's scan of a dropped copy
 *  reads the entries of its record. */
const HELD_COPY_LIMIT = 4;

interface HeldCopy {
  readonly state: CopyTreeState;
  readonly entries: CopiedEntries;
  /** Whether the take wrote the copy's record. Until then the entries exist
   *  only here, so the copy is never dropped; a take that fails forgets it. */
  readonly recorded: boolean;
}

/** Held copies by home, the least recently taken first. */
const held = new Map<string, HeldCopy>();

function hold(home: string, copy: HeldCopy): void {
  held.delete(home);
  held.set(home, copy);
  let recorded = [...held.values()].filter(entry => entry.recorded).length;
  for (const [oldest, entry] of held) {
    if (recorded <= HELD_COPY_LIMIT) break;
    if (!entry.recorded) continue;
    held.delete(oldest);
    recorded -= 1;
  }
}

/** The entries of the copy in `home`: the held ones, or else its record's. */
function entriesOf(home: string, copy: HeldCopy | undefined): CopiedEntries {
  if (copy) return copy.entries;
  const read = readPrivateCopyRecord(home);
  if (read.kind === "recorded") return read.copy;
  throw new Error(read.kind === "missing" ? "the copy's record is missing" : `the copy's record ${read.reason}`);
}

globalThis.addEventListener("message", (event: MessageEvent<PrivateCopyRequest>) => {
  const { id, job } = event.data;
  const answer = (value: PrivateCopyAnswer, transfer: ArrayBuffer[] = []): void => globalThis.postMessage({ id, answer: value } satisfies PrivateCopyReply, transfer);
  try {
    if (job.kind === "copy") {
      const { home } = job.request;
      const prior = job.reuse ? held.get(home)?.state : undefined;
      if (job.reuse && !prior) {
        answer({ kind: "dropped" });
        return;
      }
      // A take that fails leaves its home's entries unknown, so no later take may start from the state it replaces.
      held.delete(home);
      const { state, files, links, ...copied } = copyProjectTree({ ...job.request, ...(prior ? { prior } : {}) }, undefined, () => answer({ kind: "git-ready" }));
      const session = job.request.scratchDir ? snapshotSessionFolder(home, prior?.session, copied.tally) : undefined;
      hold(home, { state: session ? { ...state, session: session.state } : state, entries: { files, links }, recorded: false });
      answer({ kind: "done", value: session ? { ...copied, observedSession: session.snapshot } : copied });
      return;
    }
    if (job.kind === "finalize") {
      const copy = held.get(job.home);
      if (!copy) throw new Error("the private copy Worker holds no entries of the copy it took");
      const finalized = finalizePrivateCopy(job, copy.entries, copy.state.tree);
      hold(job.home, { ...copy, recorded: true });
      answer({ kind: "done", value: finalized });
      return;
    }
    if (job.kind === "forget") {
      held.delete(job.home);
      answer({ kind: "done", value: undefined });
      return;
    }
    if (job.kind === "read") {
      const read = readPrivateCopyRecord(job.home);
      if (read.kind !== "recorded") {
        answer({ kind: "done", value: read });
        return;
      }
      const { files: _files, links: _links, ...copy } = read.copy;
      answer({ kind: "done", value: { kind: "recorded", copy } });
      return;
    }
    // Changed bytes move to the owner instead of being copied; this Worker keeps no reference to them.
    if (job.kind === "session") {
      const observed = scanSessionChanges(job.home, job.projectRoot, job.snapshot);
      const transfer = observed.kind === "observed"
        ? [...new Set(observed.changes.flatMap(change => [change.before, change.after].flatMap(bytes => bytes?.buffer instanceof ArrayBuffer ? [bytes.buffer] : [])))]
        : [];
      answer({ kind: "done", value: observed }, transfer);
      return;
    }
    if (job.kind === "topology" || job.kind === "index") {
      answer({ kind: "done", value: job.kind === "index" ? digestIndexEntries(job.bytes) : observeCopyTopology(job.request) });
      return;
    }
    const copy = held.get(job.home);
    const { listings, ...scanned } = scanCopyChanges({ ...job.copy, ...entriesOf(job.home, copy) }, copy?.state.base.listings);
    // The scan's listings are the next take's prior of the copy's tree: that
    // take still compares each file and link with its record, so a listing of
    // an entry the command changed only causes a fresh clone.
    if (copy) hold(job.home, { ...copy, state: { ...copy.state, tree: { ...copy.state.tree, listings } } });
    const request = job.topology && { ...job.topology, copyRoot: job.copy.copyRoot, shared: job.copy.shared };
    const topology = request && observedOrNone(() => scannedTopology(request, listings));
    answer({ kind: "done", value: topology ? { ...scanned, topology } : scanned }, [...new Set(scanned.changes.flatMap(change => change.after?.buffer instanceof ArrayBuffer ? [change.after.buffer] : []))]);
  } catch (error) {
    answer({ kind: "failed", message: error instanceof Error ? error.message : String(error) });
  }
});

/** A topology that cannot be observed completely, such as one past the inspection bound, is none. */
function observedOrNone<T>(observe: () => T): T | undefined {
  try {
    return observe();
  } catch {
    return undefined;
  }
}
