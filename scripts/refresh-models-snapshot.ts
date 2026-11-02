// Refresh the bundled models.dev snapshot committed at
// src/infra/llm/models-bundled.txt (JSON content; .txt so tsc treats the
// import as an opaque string instead of materializing a 5 MB literal type).
// The snapshot is the guaranteed-present
// fallback the models client serves when both the fresh fetch and the disk
// archive are unavailable (fresh installs, offline machines).
//
// Usage: bun run models:snapshot

import { join } from "node:path";
import { readBoundedModelsResponse } from "../src/infra/llm/models.js";
import { admitCurrentModelsDocument } from "../src/infra/llm/models-document.js";
import { assertModelCatalog } from "./check-model-catalog.js";
import { canonicalCatalogModelId, parseCanonicalModelGeneration } from "../src/infra/llm/model-id.js";
import { isRecord } from "../src/infra/record.js";

const SNAPSHOT_PATH = join(import.meta.dir, "..", "src", "infra", "llm", "models-bundled.txt");
const API_URL = "https://models.dev/catalog.json";

function isRetiredGeneration(identity: string): boolean {
  const model = canonicalCatalogModelId(identity.slice(identity.lastIndexOf("/") + 1)).modelId;
  const generation = parseCanonicalModelGeneration(model, "gpt");
  return generation?.major === 5 && generation.minor === 6;
}

function filterModelMap(models: { [key: string]: unknown }): { [key: string]: unknown } {
  return Object.fromEntries(Object.entries(models).filter(([key, model]) =>
    ![key, ...(isRecord(model) ? [model.id, model.canonical_model_id] : [])]
      .some((id) => typeof id === "string" && isRetiredGeneration(id)),
  ).map(([key, model]) => {
    if (isRecord(model) && typeof model.description === "string" && [...model.description.matchAll(/\bgpt[\s._-]+\d+(?:[\s._-]\d+)?\b/gi)]
      .some(([identity]) => isRetiredGeneration(identity.replace(/[\s_]+/g, "-")))) {
      delete model.description;
    }
    return [key, model];
  }));
}

/** Removes retired membership and description references, then validates the combined catalog before publication.
 * Keeps all other metadata, including versionless aliases and their routes. Throws before any write on invalid content. */
export function prepareBundledModelsSnapshot(bytes: Uint8Array): string {
  const document: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!isRecord(document) || !isRecord(document.models) || !isRecord(document.providers)) {
    throw new Error("models.dev current document is not a combined catalog");
  }
  document.models = filterModelMap(document.models);
  for (const provider of Object.values(document.providers)) {
    if (isRecord(provider) && isRecord(provider.models)) provider.models = filterModelMap(provider.models);
  }
  const text = JSON.stringify(document);
  const admitted = admitCurrentModelsDocument(text);
  assertModelCatalog(admitted);
  return text;
}

if (import.meta.main) {
  const res = await fetch(API_URL, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    console.error(`Fetch failed: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const bytes = await readBoundedModelsResponse(res);
  let snapshot;
  try {
    snapshot = prepareBundledModelsSnapshot(bytes);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }

  await Bun.write(SNAPSHOT_PATH, snapshot);
  console.log(`Wrote ${(Buffer.byteLength(snapshot) / 1024 / 1024).toFixed(1)} MB to ${SNAPSHOT_PATH}`);
}
