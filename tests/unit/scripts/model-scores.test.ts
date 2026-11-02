import { expect, test } from "bun:test";
import { join } from "node:path";
import { benchmarkSlug, normalizeModelScores, recentScoreModel } from "../../../src/infra/llm/model-scores-document.js";
import { createModelScoresReader, scoresForModel } from "../../../src/infra/llm/model-scores.js";
import { temporaryDirectories } from "../../helpers/directories.js";
import { createModelsClient } from "../../../src/infra/llm/models.js";
import { modelsDevDocument } from "../../helpers/model-catalog-fixtures.js";
import { scoreCatalogModels } from "../../../src/orchestration/config/model-score-scope.js";

const directories = temporaryDirectories();
const now = new Date("2026-10-19T00:00:00Z");
const scope = ["example-a", "example-b", "example-c"];

function feeds() {
  return {
    models: { items: [
      ...scope.map((slug, index) => ({
        slug, benchmarks: { agentic: { a: index * 50, b: index * 50 }, coding: { a: index * 50, b: index * 50, c: index * 50, missing: null } },
      })),
      { slug: "router-only", benchmarks: { agentic: { a: 9000, b: 9000 }, coding: { a: 9000, b: 9000, c: 9000 } } },
      { slug: "too-few", benchmarks: { coding: { a: 1, b: 2 } } },
      { bad: "row" },
    ] },
    speed: { items: [
      { slug: "example-b", tokensPerSecond: 50, ttft: 2 },
      { slug: "example-c", tokensPerSecond: 100, ttft: 1 },
      { slug: "router-only", tokensPerSecond: 9999, ttft: 0.01 },
    ] },
    terminal: { rows: [
      terminalRow("example-c", "high", 100, 10),
      terminalRow("example-c", "low", 50, 20),
      terminalRow("example-a", "none", 25, 40),
      { metadata: {} },
    ] },
  };
}

function terminalRow(slug: string, effort: string, accuracy: number, cost: number) {
  return {
    metadata: { reasoning_effort: effort, model_display: { url: `https://example.test/${slug}` } },
    metrics: { accuracy, n_trials: 10, total_cost_usd: cost },
  };
}

test("computes percentile quality, per-effort spread, inverse-cost and speed tiers within scope", () => {
  const { models, speed, terminal } = feeds();
  const snapshot = normalizeModelScores(models, speed, terminal, now);
  expect(scoresForModel("example-c", snapshot, scope, ["low", "high"]).scores).toEqual([
    { effort: "low", qualityTier: 6, speedTier: 10, costTier: 6 },
    { effort: "high", qualityTier: 10, speedTier: 10, costTier: 10 },
  ]);
  expect(scoresForModel("example-b", snapshot, scope, ["low", "high"])).toEqual({
    scores: [
      { effort: "low", qualityTier: 6, speedTier: 1, costTier: null },
      { effort: "high", qualityTier: 6, speedTier: 1, costTier: null },
    ],
    qualityEffortNote: "No per-effort Terminal-Bench rows; quality is the same at every effort.",
  });
  expect(scoresForModel("example-a", snapshot, scope, ["off"]).scores).toEqual([
    { effort: "off", qualityTier: 1, speedTier: null, costTier: 1 },
  ]);
  expect(scoresForModel("too-few", snapshot, [...scope, "too-few"]).scoresUnavailableReason).toContain("fewer than 5");
  expect(scoresForModel("unknown", snapshot, [...scope, "unknown"]).scoresUnavailableReason).toStartWith("Unmatched:");
  expect(scoresForModel("router-only", snapshot, scope).scoresUnavailableReason).toStartWith("Out of scope:");
  expect(scoresForModel("example-c", undefined).scoresUnavailableReason).toBe("Tiers unavailable: no cached benchmark data.");
});

test("handles tied benchmarks and a singleton, and joins exact normalized slugs and observed overrides", () => {
  const { models, speed } = feeds();
  const tied = normalizeModelScores({ items: models.items.slice(0, 1).map((row) => ({ ...row, slug: "claude-opus-5-5" })) }, speed, undefined, now);
  expect(scoresForModel("Claude-Opus-5.5", tied, ["Claude-Opus-5.5"], ["low"]).scores?.[0]?.qualityTier).toBe(10);
  const allEqual = normalizeModelScores({ items: [
    { slug: "a", benchmarks: { coding: { a: 5, b: 5, c: 5, d: 5, e: 5 } } },
    { slug: "b", benchmarks: { coding: { a: 5, b: 5, c: 5, d: 5, e: 5 } } },
  ] }, { items: [] }, undefined, now);
  expect(scoresForModel("a", allEqual, ["a", "b"]).scores?.[0]?.qualityTier)
    .toBe(scoresForModel("b", allEqual, ["a", "b"]).scores?.[0]?.qualityTier);
  expect(benchmarkSlug("claude-fable-5")).toBe("claude-fable");
  expect(benchmarkSlug("claude-opus-5.5-preview")).toBe("claude-opus-5-5-preview");
  const terminal = normalizeModelScores(models, speed, { rows: [
    terminalRow("all-models", "max", 1, 2),
    terminalRow("model_studio_update_notice_for_qwen38max_models_863", "max", 2, 3),
    terminalRow("claude-fable-5-mythos-5", "max", 3, 4),
  ] }, now);
  expect(terminal.terminal.map((row) => row.slug)).toEqual(["claude-fable-5-1", "qwen3-8-max", "claude-fable"]);
});

test("normalizes external null and malformed rows without inventing measurements", () => {
  const { models, speed } = feeds();
  const snapshot = normalizeModelScores(models, { items: [...speed.items, { slug: "missing", tokensPerSecond: null }] }, { rows: [
    { ...terminalRow("example-a", "none", 0, 0), metrics: { accuracy: 0, n_trials: 0, total_cost_usd: null } },
    terminalRow("example-a", "unknown-effort", 2, 3),
  ] }, now);
  expect(snapshot.models[0]?.benchmarks).not.toHaveProperty("coding.missing");
  expect(snapshot.speed.at(-1)).toEqual({ slug: "missing", tokensPerSecond: null, firstAnswerSeconds: null });
  expect(snapshot.terminal).toEqual([{ slug: "example-a", effort: "off", accuracy: 0, costPerTrial: null }]);
  expect(() => normalizeModelScores({}, speed, undefined, now)).toThrow();
});

test("fetches lazily once a day, shares concurrent reads, persists freshness and retains last good data after failure", async () => {
  let clock = now;
  let fail = false;
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const input = feeds();
  const fetcher: typeof fetch = Object.assign(async (request: string | URL | Request, init?: RequestInit) => {
    const url = String(request);
    calls.push({ url, init });
    if (fail) throw new Error("offline");
    return Response.json(url.includes("supabase") ? input.terminal : url.endsWith("speed.json") ? input.speed : input.models);
  }, { preconnect: () => {} });
  const root = directories("benchmark-cache-");
  const deps = { fetch: fetcher, now: () => clock };
  const read = createModelScoresReader(root, deps);
  expect(calls).toHaveLength(0);
  const [first, simultaneous] = await Promise.all([read(), read()]);
  expect(first).toEqual(simultaneous);
  expect(calls).toHaveLength(3);
  expect(calls.find((call) => call.url.includes("supabase"))?.init).toMatchObject({
    method: "POST", body: '{"package":"terminal-bench/terminal-bench","name":"4-0-0"}',
  });
  expect(await createModelScoresReader(root, deps)()).toEqual(first);
  expect(calls).toHaveLength(3);
  clock = new Date(now.getTime() + 86_400_000);
  fail = true;
  expect(await read()).toEqual(first);
  expect(calls).toHaveLength(6);
  expect(await createModelScoresReader(root, deps)()).toEqual(first);
  expect(calls).toHaveLength(6);
});

test("states unavailable without a cache and falls back to BenchLM when Terminal-Bench changes", async () => {
  const root = directories("benchmark-unavailable-");
  const unavailable: typeof fetch = Object.assign(async () => { throw new Error("offline"); }, { preconnect: () => {} });
  expect(await createModelScoresReader(root, { fetch: unavailable, now: () => now })()).toBeUndefined();
  const { models, speed } = feeds();
  const changedTerminal: typeof fetch = Object.assign(async (request: string | URL | Request) =>
    Response.json(String(request).includes("supabase") ? { changed: true } : String(request).endsWith("speed.json") ? speed : models),
  { preconnect: () => {} });
  const snapshot = await createModelScoresReader(directories("benchmark-fallback-"), { fetch: changedTerminal, now: () => now })();
  expect(snapshot?.terminalAvailable).toBe(false);
  expect(scoresForModel("example-c", snapshot, scope, ["low", "high"]).scores?.map((row) => row.qualityTier)).toEqual([10, 10]);
});

test("scope includes recent direct catalogs and excludes old, future, unknown-date and OpenRouter-only models", async () => {
  expect(recentScoreModel("2026-04-19", now)).toBe(true);
  expect(recentScoreModel("2026-04-18", now)).toBe(false);
  expect(recentScoreModel("2026-10-20", now)).toBe(false);
  expect(recentScoreModel(undefined, now)).toBe(false);
  const document = modelsDevDocument();
  document.anthropic = { name: "Anthropic", models: {
    recent: { id: "recent", release_date: "2026-09-01" },
    old: { id: "old", release_date: "2025-01-01" },
  } };
  document.openrouter = { name: "OpenRouter", models: {
    "router-only": { id: "router-only", release_date: "2026-09-01" },
  } };
  const path = join(directories("model-score-catalog-"), "models.json");
  await Bun.write(path, JSON.stringify(document));
  expect(scoreCatalogModels(now, createModelsClient(path))).toEqual(["recent"]);
});
