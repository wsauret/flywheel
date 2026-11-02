import { join } from "node:path";
import { Schema } from "effect";
import { writeFileAtomic } from "../atomic-write.js";
import type { JsonValue } from "../auth/bounded-json.js";
import { Log } from "../log.js";
import { readBoundedModelsResponse, type ReasoningEffort } from "./models.js";
import { benchmarkSlug, normalizeModelScores, parseScoreSnapshot, type ModelScoreSnapshot } from "./model-scores-document.js";

const log = Log.create({ service: "model-tiers" });
const DAY = 86_400_000;
const readers = new Map<string, () => Promise<ModelScoreSnapshot | undefined>>();

/** Shares lazy, daily refreshes across tools for one user data root. Construction performs no I/O. */
export function readModelScores(userDataRoot: string): Promise<ModelScoreSnapshot | undefined> {
  let read = readers.get(userDataRoot);
  if (!read) {
    read = createModelScoresReader(userDataRoot);
    readers.set(userDataRoot, read);
  }
  return read();
}

const Cache = Schema.Struct({ attemptedAt: Schema.Number, snapshot: Schema.Unknown });

/** Reads on demand; failed refreshes retain the last good snapshot and are attempted at most daily.
 * The fetch/clock seam permits hermetic tests. The cache is replaceable public data, not user state. */
export function createModelScoresReader(
  userDataRoot: string,
  deps: { readonly fetch?: typeof fetch; readonly now?: () => Date } = {},
): () => Promise<ModelScoreSnapshot | undefined> {
  const fetcher = deps.fetch ?? fetch;
  const now = deps.now ?? (() => new Date());
  const path = join(userDataRoot, "models", "benchmark-tiers.json");
  let loaded = false;
  let attemptedAt = -Infinity;
  let snapshot: ModelScoreSnapshot | undefined;
  let pending: Promise<ModelScoreSnapshot | undefined> | undefined;

  async function request(url: string, init?: RequestInit): Promise<JsonValue> {
    const response = await fetcher(url, { ...init, signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Benchmark source returned HTTP ${response.status}`);
    return JSON.parse(new TextDecoder().decode(await readBoundedModelsResponse(response)));
  }

  async function refresh(): Promise<ModelScoreSnapshot | undefined> {
    if (!loaded) {
      loaded = true;
      const file = Bun.file(path);
      if (await file.exists()) {
        try {
          const cache = Schema.decodeUnknownSync(Cache)(await file.json());
          snapshot = cache.snapshot === null ? undefined : parseScoreSnapshot(cache.snapshot);
          attemptedAt = cache.attemptedAt;
        } catch {
          log.warn("Benchmark cache cannot be read; fetching a replacement");
        }
      }
    }
    const time = now();
    if (time.getTime() - attemptedAt < DAY) return snapshot;
    attemptedAt = time.getTime();
    try {
      const [models, speed, terminal] = await Promise.all([
        request("https://benchlm.ai/data/models.json"),
        request("https://benchlm.ai/data/speed.json"),
        request("https://ofhuhcpkvzjlejydnvyd.supabase.co/functions/v1/leaderboard-read", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ package: "terminal-bench/terminal-bench", name: "4-0-0" }),
        }).catch(() => undefined),
      ]);
      try { snapshot = normalizeModelScores(models, speed, terminal, time); }
      catch (error) {
        if (terminal === undefined) throw error;
        snapshot = normalizeModelScores(models, speed, undefined, time);
      }
      log.debug("Benchmark tiers refreshed", { models: snapshot.models.length, terminalRows: snapshot.terminal.length });
    } catch {
      log.debug("Benchmark refresh failed; retaining last good cache", { cached: snapshot !== undefined });
    }
    try { writeFileAtomic(path, JSON.stringify({ attemptedAt, snapshot: snapshot ?? null })); }
    catch { log.warn("Benchmark cache could not be saved"); }
    return snapshot;
  }

  return () => {
    pending ??= refresh().finally(() => { pending = undefined; });
    return pending;
  };
}

interface EffortTier {
  readonly effort: ReasoningEffort;
  readonly qualityTier: number | null;
  readonly speedTier: number | null;
  readonly costTier: number | null;
}

interface ModelTiers {
  readonly scores?: readonly EffortTier[];
  readonly scoresUnavailableReason?: string;
  readonly qualityEffortNote?: string;
}

function percentile(value: number, population: readonly number[]): number {
  const below = population.filter((entry) => entry < value).length;
  const equal = population.filter((entry) => entry === value).length;
  return population.length <= 1 ? 1 : (below + (equal - 1) / 2) / (population.length - 1);
}

function tier(level: number): number {
  return Math.max(1, Math.min(10, Math.round(1 + 9 * level)));
}

/** Computes relative tiers over the supplied recent first-party scope. Only tiers leave this boundary.
 * Quality uses mean tied-rank percentiles, then scales each observed effort by its model's best TB accuracy.
 * Speed averages throughput and inverse latency percentiles. Cost 10 means the lowest observed cost per trial. */
export function scoresForModel(
  modelId: string,
  snapshot: ModelScoreSnapshot | undefined,
  scope: readonly string[] = [],
  efforts: readonly ReasoningEffort[] = ["low", "medium", "high"],
): ModelTiers {
  if (snapshot === undefined) return { scoresUnavailableReason: "Tiers unavailable: no cached benchmark data." };
  if (!scope.includes(modelId)) return { scoresUnavailableReason: "Out of scope: tiers cover recent first-party provider models only." };
  const slug = benchmarkSlug(modelId);
  const model = snapshot.models.find((entry) => entry.slug === slug);
  if (!model) return { scoresUnavailableReason: "Unmatched: no exact BenchLM slug for this model." };
  const scopeSlugs = new Set(scope.map(benchmarkSlug));
  const population = snapshot.models.filter((entry) => scopeSlugs.has(entry.slug));
  const qualityLevels = population.map((entry) => {
    const levels = Object.entries(entry.benchmarks).map(([key, value]) =>
      percentile(value, population.flatMap((peer) => peer.benchmarks[key] === undefined ? [] : [peer.benchmarks[key]])));
    return { slug: entry.slug, level: levels.length < 5 ? null : levels.reduce((sum, value) => sum + value, 0) / levels.length };
  });
  const bestQuality = Math.max(...qualityLevels.flatMap((entry) => entry.level === null ? [] : [entry.level]));
  const level = qualityLevels.find((entry) => entry.slug === model.slug)?.level;
  const quality = level == null ? null : bestQuality === 0 ? 1 : level / bestQuality;
  const speedPopulation = snapshot.speed.filter((entry) => scopeSlugs.has(entry.slug));
  const speedLevels = speedPopulation.map((speed) => {
    const levels = [
      ...(speed.tokensPerSecond === null ? [] : [percentile(speed.tokensPerSecond, speedPopulation.flatMap((row) => row.tokensPerSecond === null ? [] : [row.tokensPerSecond]))]),
      ...(speed.firstAnswerSeconds === null ? [] : [percentile(-speed.firstAnswerSeconds, speedPopulation.flatMap((row) => row.firstAnswerSeconds === null ? [] : [-row.firstAnswerSeconds]))]),
    ];
    return { slug: speed.slug, level: levels.length === 0 ? null : levels.reduce((sum, value) => sum + value, 0) / levels.length };
  });
  const bestSpeed = Math.max(...speedLevels.flatMap((entry) => entry.level === null ? [] : [entry.level]));
  const speedLevel = speedLevels.find((entry) => entry.slug === slug)?.level;
  const speedTier = speedLevel == null ? null : tier(bestSpeed === 0 ? 1 : speedLevel / bestSpeed);
  const terminal = snapshot.terminal.filter((row) => row.slug === slug);
  const bestAccuracy = Math.max(...terminal.map((row) => row.accuracy));
  const costs = snapshot.terminal.filter((row) => scopeSlugs.has(row.slug)).flatMap((row) => row.costPerTrial === null ? [] : [-row.costPerTrial]);
  return {
    scores: efforts.map((effort) => {
      const row = terminal.find((entry) => entry.effort === effort);
      return {
        effort,
        qualityTier: quality === null ? null : tier(quality * (row && bestAccuracy > 0 ? row.accuracy / bestAccuracy : 1)),
        speedTier,
        costTier: row?.costPerTrial == null ? null : tier(percentile(-row.costPerTrial, costs) / percentile(Math.max(...costs), costs)),
      };
    }),
    ...(quality === null ? { scoresUnavailableReason: "Quality unavailable: fewer than 5 agentic and coding benchmarks." } : {}),
    qualityEffortNote: terminal.length === 0
      ? "No per-effort Terminal-Bench rows; quality is the same at every effort."
      : "Observed efforts scale quality by Terminal-Bench accuracy relative to this model's best effort; other efforts use its BenchLM level.",
  };
}
