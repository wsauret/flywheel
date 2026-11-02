import { expect, spyOn, test } from "bun:test";
import { DebugLog } from "../../../../src/infra/debug-log.js";
import { Log } from "../../../../src/infra/log.js";
import {
  CatalogSemanticDigestAccumulator,
  recordCatalogDiscoveryDiagnostics,
  recordProviderCatalogFailure,
  type CatalogCollisionSample,
  type CatalogDiscoveryDiagnostics,
} from "../../../../src/infra/llm/model-catalog-diagnostics.js";

const ACCOUNT_COUNT = 128;
const ROW_COUNT = 10_000;

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

function digest(values: readonly string[]) {
  const accumulator = new CatalogSemanticDigestAccumulator();
  for (const value of values) accumulator.add(value);
  return accumulator.snapshot();
}

function diagnostics(
  unknownValues: readonly string[],
  unknownTotal = unknownValues.length,
  collisions: readonly CatalogCollisionSample[] = [],
): CatalogDiscoveryDiagnostics {
  return {
    baselineGeneration: "baseline",
    unknownWireModelIds: { total: unknownTotal, values: unknownValues, digest: digest(unknownValues) },
    collisions: {
      total: collisions.length,
      values: collisions,
      digest: digest(collisions.flatMap((collision) =>
        collision.wireModelIds.map((wireModelId) => `${collision.modelId}\0${collision.dataUse}\0${wireModelId}`))),
    },
  };
}

test("bounds cross-account diagnostics and retains only the latest digest per family", () => {
  const record = spyOn(DebugLog, "record").mockImplementation(() => {});
  const unknownWireModelIds = Object.freeze(Array.from({ length: 64 }, (_, index) => `${index.toString().padStart(2, "0")}-${"u".repeat(509)}`));
  const collision = Object.freeze({
    modelId: "shared",
    dataUse: "standard" as const,
    wireModelIds: Object.freeze(["route-a", "route-b"]),
    total: 2,
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
  const collision = (wireModelIds: readonly string[]): CatalogCollisionSample => ({
    modelId: "shared",
    dataUse: "standard",
    wireModelIds,
    total: wireModelIds.length,
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
    recordCatalogDiscoveryDiagnostics(latest, [{
      providerId: "provider",
      diagnostics: {
        baselineGeneration: "baseline",
        unknownWireModelIds: { total: 2, values: [], digest: digest(["x".repeat(10_000), "bad\u001B"]) },
        collisions: { total: 0, values: [], digest: digest([]) },
      },
    }]);
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
