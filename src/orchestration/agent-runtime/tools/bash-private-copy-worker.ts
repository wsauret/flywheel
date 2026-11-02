/**
 * The private copy Worker. It runs one tree job, which visits every project
 * file, off the runtime event loop and answers once; its owner then ends it.
 */

import { readPrivateCopyRecord } from "./bash-private-copy-record.js";
import { digestIndexEntries } from "./bash-copy-repository-state.js";
import { copyProjectTree, finalizePrivateCopy, observeCopyTopology, scanCopyChanges, type PrivateCopyAnswer, type PrivateCopyJob } from "./bash-private-copy-tree.js";
import { scanSessionChanges, snapshotSessionFolder } from "./bash-session-observation.js";

globalThis.addEventListener("message", (event: MessageEvent<PrivateCopyJob>) => {
  const job = event.data;
  try {
    if (job.kind === "copy") {
      const copied = copyProjectTree(job.request, undefined, () => globalThis.postMessage({ kind: "git-ready" } satisfies PrivateCopyAnswer, []));
      const session = job.request.scratchDir ? snapshotSessionFolder(job.request.home, job.request.prior?.session, copied.tally) : undefined;
      const value = session ? { ...copied, observedSession: session.snapshot, state: { ...copied.state, session: session.state } } : copied;
      globalThis.postMessage({ kind: "done", value } satisfies PrivateCopyAnswer, []);
      return;
    }
    if (job.kind === "read") {
      globalThis.postMessage({ kind: "done", value: readPrivateCopyRecord(job.home) } satisfies PrivateCopyAnswer, []);
      return;
    }
    if (job.kind === "session") {
      const observed = scanSessionChanges(job.home, job.projectRoot, job.snapshot);
      const transfer = observed.kind === "observed"
        ? [...new Set(observed.changes.flatMap(change => [change.before, change.after].flatMap(bytes => bytes?.buffer instanceof ArrayBuffer ? [bytes.buffer] : [])))]
        : [];
      globalThis.postMessage({ kind: "done", value: observed } satisfies PrivateCopyAnswer, transfer);
      return;
    }
    if (job.kind === "finalize" || job.kind === "topology" || job.kind === "index") {
      const value = job.kind === "finalize" ? finalizePrivateCopy(job) : job.kind === "index" ? digestIndexEntries(job.bytes) : observeCopyTopology(job.request);
      globalThis.postMessage({ kind: "done", value } satisfies PrivateCopyAnswer, []);
      return;
    }
    const scanned = scanCopyChanges(job.copy);
    // Changed bytes move to the owner instead of being copied; this Worker ends with its answer.
    const transfer = [...new Set(scanned.changes.flatMap(change => change.after?.buffer instanceof ArrayBuffer ? [change.after.buffer] : []))];
    globalThis.postMessage({ kind: "done", value: scanned } satisfies PrivateCopyAnswer, transfer);
  } catch (error) {
    globalThis.postMessage({ kind: "failed", message: error instanceof Error ? error.message : String(error) } satisfies PrivateCopyAnswer, []);
  }
}, { once: true });
