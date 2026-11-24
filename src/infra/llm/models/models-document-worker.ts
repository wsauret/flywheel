import { admitCurrentModelsDocument } from "./models-document.js";
import type { ModelsDocumentAnswer } from "./models-document-job.js";

globalThis.addEventListener("message", (event: MessageEvent<Uint8Array>) => {
  try {
    globalThis.postMessage({ kind: "done", value: admitCurrentModelsDocument(event.data) } satisfies ModelsDocumentAnswer, []);
  } catch (error) {
    globalThis.postMessage({ kind: "failed", message: error instanceof Error ? error.message : String(error) } satisfies ModelsDocumentAnswer, []);
  }
}, { once: true });
