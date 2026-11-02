import { createBoundedWorkerSpawner } from "../../../infra/bounded-worker-spawner.js";
import { embeddedEntrySpecifier, runsThroughBun } from "../../../infra/cli-subprocess.js";
import { terminateWorker } from "../../../infra/worker-termination.js";
import type { StateDigest } from "./bash-copy-repository-state.js";
import type { PrivateCopyRecordRead, RecordedCopy } from "./bash-private-copy-record.js";
import type { CopiedTree, CopyChanges, PrivateCopyAnswer, PrivateCopyJob } from "./bash-private-copy-tree.js";
import type { SessionFolderObservation } from "./bash-session-observation.js";

/** Runs one private-copy job and joins its Worker before returning or throwing.
 * Index bytes transfer to the Worker; the caller must not reuse their buffer. */
export async function runPrivateCopyJob(job: Extract<PrivateCopyJob, { readonly kind: "copy" }>, onGitReady?: () => Promise<void>): Promise<CopiedTree>;
export async function runPrivateCopyJob(job: Extract<PrivateCopyJob, { readonly kind: "scan" }>): Promise<CopyChanges>;
export async function runPrivateCopyJob(job: Extract<PrivateCopyJob, { readonly kind: "session" }>): Promise<SessionFolderObservation>;
export async function runPrivateCopyJob(job: Extract<PrivateCopyJob, { readonly kind: "read" }>): Promise<PrivateCopyRecordRead>;
export async function runPrivateCopyJob(job: Extract<PrivateCopyJob, { readonly kind: "finalize" }>): Promise<RecordedCopy>;
export async function runPrivateCopyJob(job: Extract<PrivateCopyJob, { readonly kind: "topology" | "index" }>): Promise<StateDigest>;
export async function runPrivateCopyJob(job: PrivateCopyJob, onGitReady?: () => Promise<void>): Promise<CopiedTree | CopyChanges | PrivateCopyRecordRead | RecordedCopy | StateDigest | SessionFolderObservation> {
  // Each job has one generation and never starts a second Worker.
  const spawn = createBoundedWorkerSpawner("bash-private-copy");
  const worker = spawn(privateCopyWorkerSpecifier(), { name: "bash-private-copy", smol: true });
  const answered = Promise.withResolvers<Exclude<PrivateCopyAnswer, { readonly kind: "git-ready" }>>();
  let initialization: Promise<{ readonly kind: "ready" } | { readonly kind: "failed"; readonly message: string }> = Promise.resolve({ kind: "ready" });
  worker.addEventListener("message", (event: MessageEvent<PrivateCopyAnswer>) => {
    if (event.data.kind !== "git-ready") answered.resolve(event.data);
    else if (onGitReady) initialization = onGitReady().then(() => ({ kind: "ready" }), error => ({ kind: "failed", message: error instanceof Error ? error.message : String(error) }));
  });
  worker.addEventListener("error", (event) => answered.resolve({ kind: "failed", message: `the private copy Worker failed: ${event.message || "it reported no cause"}` }));
  worker.addEventListener("close", () => answered.resolve({ kind: "failed", message: "the private copy Worker ended before it answered" }), { once: true });
  try {
    worker.postMessage(job, job.kind === "index" ? [job.bytes.buffer] : []);
    const answer = await answered.promise;
    const initialized = await initialization;
    if (answer.kind === "failed") throw new Error(answer.message);
    if (initialized.kind === "failed") throw new Error(initialized.message);
    return answer.value;
  } finally {
    await initialization;
    await terminateWorker(worker);
  }
}

function privateCopyWorkerSpecifier(): string {
  return runsThroughBun(process.execPath)
    ? new URL("bash-private-copy-worker.ts", import.meta.url).href
    : embeddedEntrySpecifier(import.meta.dir, "bash-private-copy-worker.js");
}
