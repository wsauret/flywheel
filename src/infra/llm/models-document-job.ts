import { awaitWithAbortSignal } from "../abort.js";
import { createBoundedWorkerSpawner } from "../bounded-worker-spawner.js";
import { embeddedEntrySpecifier, runsThroughBun } from "../cli-subprocess.js";
import { DebugLog } from "../debug-log.js";
import { terminateWorker } from "../worker-termination.js";
import type { AdmittedModelsDocument } from "./models-document.js";

export type ModelsDocumentAnswer =
  | { readonly kind: "done"; readonly value: AdmittedModelsDocument }
  | { readonly kind: "failed"; readonly message: string };

/** Admits current catalog bytes on one job-owned Worker. Retains the caller's
 * bytes, rejects on admission failure or abort, and joins the Worker before settling. */
export async function runModelsDocumentJob(bytes: Uint8Array, signal: AbortSignal): Promise<AdmittedModelsDocument> {
  signal.throwIfAborted();
  // The budget applies per refresh job, not per ModelsClient lifetime.
  const spawn = createBoundedWorkerSpawner("models-document");
  const specifier = runsThroughBun(process.execPath)
    ? new URL("models-document-worker.ts", import.meta.url).href
    : embeddedEntrySpecifier(import.meta.dir, "models-document-worker.js");
  const worker = spawn(specifier, { name: "flywheel-models-document", smol: true });
  DebugLog.record({ type: "runtime.worker.allocated", payload: { kind: "models-document" } });
  const answered = Promise.withResolvers<ModelsDocumentAnswer>();
  worker.addEventListener("message", (event: MessageEvent<ModelsDocumentAnswer>) => answered.resolve(event.data));
  worker.addEventListener("error", (event) => answered.resolve({ kind: "failed", message: `the models document Worker failed: ${event.message || "it reported no cause"}` }));
  worker.addEventListener("close", () => answered.resolve({ kind: "failed", message: "the models document Worker ended before it answered" }), { once: true });
  try {
    worker.postMessage(bytes, []);
    const answer = await awaitWithAbortSignal(answered.promise, signal);
    if (answer.kind === "failed") throw new Error(answer.message);
    return answer.value;
  } finally {
    await terminateWorker(worker);
  }
}
