import { expect, spyOn, test } from "bun:test";
import { DebugLog } from "../../../../../src/infra/debug-log.js";
import { Log } from "../../../../../src/infra/log.js";
import {
  CatalogDiscoveryDiagnosticAccumulator,
  recordCatalogDiscoveryDiagnostics,
  recordProviderCatalogFailure,
  type CatalogDiscoveryDiagnostics,
} from "../../../../../src/infra/llm/catalog/model-catalog-diagnostics.js";
import type { CatalogDataUse } from "../../../../../src/infra/model-id.js";

const ACCOUNT_COUNT = 128;
const ROW_COUNT = 10_000;
const MODEL_ID_LENGTH = 512;

test("provider HTTP diagnostics contain only the provider, status, and serving fallback", () => {
  const warning = spyOn(Log.create({ service: "model-listing" }), "warn").mockImplementation(() => {});
  try {
    recordProviderCatalogFailure(
      "github_copilot",
      { kind: "failed", reason: "http", status: 503 },
      { kind: "catalog", provenance: "first-party-cached", liveOutcome: "discovery-failed", rows: [] },
    );
    expect(warning).toHaveBeenCalledTimes(1);
    expect(warning.mock.calls[0]).toEqual([
      "provider model catalog request failed",
      { providerId: "github_copilot", status: 503, outcome: "catalog", provenance: "first-party-cached" },
    ]);
    recordProviderCatalogFailure("github_copilot", { kind: "failed", reason: "transport" }, { kind: "unavailable", reason: "discovery-failed" });
    expect(warning).toHaveBeenCalledTimes(1);
  } finally {
    warning.mockRestore();
  }
});

interface Collision {
  readonly modelId: string;
  readonly dataUse: CatalogDataUse;
  readonly wireModelIds: readonly string[];
}

/** One account's discovery diagnostics, built by the production accumulator. Unknown ids past the
 *  named ones sort after them, so the named ids stay the retained sample. */
function diagnostics(
  unknownValues: readonly string[],
  unknownTotal = unknownValues.length,
  collisions: readonly Collision[] = [],
): CatalogDiscoveryDiagnostics {
  const accumulator = new CatalogDiscoveryDiagnosticAccumulator(MODEL_ID_LENGTH);
  for (const wireModelId of unknownValues) accumulator.addUnknown(wireModelId);
  for (let index = unknownValues.length; index < unknownTotal; index += 1) accumulator.addUnknown(`~unretained-${index}`);
  for (const { modelId, dataUse, wireModelIds } of collisions) {
    for (const wireModelId of wireModelIds) accumulator.addResolved({ modelId, dataUse, wireModelId, metadata: null });
  }
  return { baselineGeneration: "baseline", ...accumulator.snapshot() };
}

test("bounds cross-account diagnostics and retains only the latest digest per family", () => {
  const record = spyOn(DebugLog, "record").mockImplementation(() => {});
  const unknownWireModelIds = Object.freeze(Array.from({ length: 64 }, (_, index) => `${index.toString().padStart(2, "0")}-${"u".repeat(509)}`));
  const collision = Object.freeze({
    modelId: "shared",
    dataUse: "standard" as const,
    wireModelIds: Object.freeze(["route-a", "route-b"]),
  });
  const observation = diagnostics(unknownWireModelIds, ROW_COUNT, [collision]);
  const observations = Array.from({ length: ACCOUNT_COUNT }, () => ({ providerId: "aggregator", diagnostics: observation }));
  const latest = new Map<string, string>();

  try {
    recordCatalogDiscoveryDiagnostics(latest, observations);
    recordCatalogDiscoveryDiagnostics(latest, observations.toReversed());

    const unresolved = record.mock.calls.filter(([entry]) => entry.type === "model.catalog.relationship_unresolved");
    const collisions = record.mock.calls.filter(([entry]) => entry.type === "model.catalog.canonical_collision");
    expect(unresolved).toHaveLength(1);
    expect(collisions).toHaveLength(1);
    expect(latest.size).toBe(2);
    expect(unresolved[0]?.[0].payload).toMatchObject({ providerId: "aggregator", total: ACCOUNT_COUNT * ROW_COUNT });
    expect(collisions[0]?.[0].payload).toMatchObject({ providerId: "aggregator", total: ACCOUNT_COUNT, omitted: ACCOUNT_COUNT - 1 });
    expect(new TextEncoder().encode(JSON.stringify(unresolved[0]?.[0])).byteLength).toBeLessThan(1_200);
    expect(new TextEncoder().encode(JSON.stringify(collisions[0]?.[0])).byteLength).toBeLessThan(1_200);

    for (let index = 0; index < 100; index += 1) {
      recordCatalogDiscoveryDiagnostics(latest, [{ providerId: "aggregator", diagnostics: diagnostics([`changed-${index}`]) }]);
    }
    expect(latest.size).toBe(2);
  } finally {
    record.mockRestore();
  }
});

test("a clean observation resets latest-state deduplication", () => {
  const record = spyOn(DebugLog, "record").mockImplementation(() => {});
  const latest = new Map<string, string>();
  try {
    recordCatalogDiscoveryDiagnostics(latest, [{ providerId: "provider", diagnostics: diagnostics(["unknown"]) }]);
    recordCatalogDiscoveryDiagnostics(latest, [{ providerId: "provider", diagnostics: diagnostics([]) }]);
    recordCatalogDiscoveryDiagnostics(latest, [{ providerId: "provider", diagnostics: diagnostics(["unknown"]) }]);
    expect(record.mock.calls.filter(([entry]) => entry.type === "model.catalog.relationship_unresolved")).toHaveLength(2);
    expect(latest.size).toBe(2);
  } finally {
    record.mockRestore();
  }
});

test("collision deduplication includes per-account group totals", () => {
  const record = spyOn(DebugLog, "record").mockImplementation(() => {});
  const latest = new Map<string, string>();
  const collision = (wireModelIds: readonly string[]): Collision => ({
    modelId: "shared",
    dataUse: "standard",
    wireModelIds,
  });
  try {
    recordCatalogDiscoveryDiagnostics(latest, [
      { providerId: "provider", diagnostics: diagnostics([], 0, [collision(["a", "b", "c", "d"])]) },
      { providerId: "provider", diagnostics: diagnostics([]) },
    ]);
    recordCatalogDiscoveryDiagnostics(latest, [
      { providerId: "provider", diagnostics: diagnostics([], 0, [collision(["a", "b"])]) },
      { providerId: "provider", diagnostics: diagnostics([], 0, [collision(["c", "d"])]) },
    ]);
    expect(record.mock.calls.filter(([entry]) => entry.type === "model.catalog.canonical_collision")).toHaveLength(2);
  } finally {
    record.mockRestore();
  }
});

test("omits oversized and terminal-control IDs from bounded payloads", () => {
  const record = spyOn(DebugLog, "record").mockImplementation(() => {});
  const latest = new Map<string, string>();
  try {
    recordCatalogDiscoveryDiagnostics(latest, [{ providerId: "provider", diagnostics: diagnostics(["x".repeat(10_000), "bad\u001B"]) }]);
    const diagnostic = record.mock.calls[0]?.[0];
    expect(diagnostic).toMatchObject({
      type: "model.catalog.relationship_unresolved",
      payload: { total: 2, wireModelIds: [], omitted: 2 },
    });
    expect(new TextEncoder().encode(JSON.stringify(diagnostic)).byteLength).toBeLessThan(1_200);
  } finally {
    record.mockRestore();
  }
});
