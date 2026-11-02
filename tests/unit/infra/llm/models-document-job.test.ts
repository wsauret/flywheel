import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import { DebugLog } from "../../../../src/infra/debug-log.js";
import { admitCurrentModelsDocument } from "../../../../src/infra/llm/models-document.js";
import { runModelsDocumentJob, type ModelsDocumentAnswer } from "../../../../src/infra/llm/models-document-job.js";
import { combinedModelsDevJson } from "../../../helpers/model-catalog-fixtures.js";

const originalWorker = globalThis.Worker;
const workers: ControlledWorker[] = [];
const bytes = new TextEncoder().encode(combinedModelsDevJson());
const admitted = admitCurrentModelsDocument(bytes);
const allocated = spyOn(DebugLog, "record");

afterAll(() => allocated.mockRestore());

class ControlledWorker extends EventTarget {
  readonly terminating = Promise.withResolvers<void>();
  received: Uint8Array | undefined;
  transfer: readonly Transferable[] | undefined;
  terminations = 0;

  constructor() {
    super();
    workers.push(this);
  }

  postMessage(value: Uint8Array, transfer: readonly Transferable[]): void {
    this.received = value;
    this.transfer = transfer;
  }

  terminate(): void {
    this.terminations += 1;
    this.terminating.resolve();
  }

  answer(answer: ModelsDocumentAnswer): void {
    this.dispatchEvent(new MessageEvent("message", { data: answer }));
  }
}

afterEach(() => {
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: originalWorker });
  workers.length = 0;
  allocated.mockClear();
});

for (const outcome of ["success", "admission-failure", "worker-error", "abort"] as const) {
  test(`joins the admission Worker before settling after ${outcome}`, async () => {
    Object.defineProperty(globalThis, "Worker", { configurable: true, value: ControlledWorker });
    const controller = new AbortController();
    let settled = false;
    const job = runModelsDocumentJob(bytes, controller.signal).then(
      (value) => { settled = true; return { value }; },
      (error: unknown) => { settled = true; return { error }; },
    );
    const worker = workers[0]!;
    expect(workers).toHaveLength(1);
    expect(worker.received).toBe(bytes);
    expect(worker.transfer).toEqual([]);
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(allocated).toHaveBeenCalledTimes(1);
    expect(allocated).toHaveBeenCalledWith({ type: "runtime.worker.allocated", payload: { kind: "models-document" } });

    if (outcome === "success") worker.answer({ kind: "done", value: admitted });
    if (outcome === "admission-failure") worker.answer({ kind: "failed", message: "invalid catalog" });
    if (outcome === "worker-error") worker.dispatchEvent(Object.assign(new Event("error"), { message: "worker failed" }));
    if (outcome === "abort") controller.abort(new DOMException("owner closed", "AbortError"));
    await worker.terminating.promise;
    expect(settled).toBe(false);
    expect(worker.terminations).toBe(1);
    worker.dispatchEvent(new Event("close"));
    const result = await job;
    if (outcome === "success") expect(result).toEqual({ value: admitted });
    if (outcome === "admission-failure") expect(result).toMatchObject({ error: { message: "invalid catalog" } });
    if (outcome === "worker-error") expect(result).toMatchObject({ error: { message: "the models document Worker failed: worker failed" } });
    if (outcome === "abort") expect(result).toMatchObject({ error: { name: "AbortError" } });
  });
}

test("rejects a Worker that closes without answering and does not terminate its closed handle", async () => {
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: ControlledWorker });
  const job = runModelsDocumentJob(bytes, new AbortController().signal);
  const rejected = job.catch((error: unknown) => error);
  const worker = workers[0]!;
  worker.dispatchEvent(new Event("close"));
  expect(await rejected).toMatchObject({ message: "the models document Worker ended before it answered" });
  expect(worker.terminations).toBe(0);
});

test("does not allocate a Worker for an already withdrawn job", async () => {
  Object.defineProperty(globalThis, "Worker", { configurable: true, value: ControlledWorker });
  const controller = new AbortController();
  controller.abort(new DOMException("owner closed", "AbortError"));
  await expect(runModelsDocumentJob(bytes, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(workers).toHaveLength(0);
  expect(allocated).not.toHaveBeenCalled();
});
