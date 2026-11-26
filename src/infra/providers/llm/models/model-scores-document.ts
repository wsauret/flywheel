import { Schema } from "effect";
import { REASONING_EFFORTS } from "./models.js";

const BenchmarkModel = Schema.Struct({
  slug: Schema.String,
  benchmarks: Schema.Record(Schema.String, Schema.Number),
});
const Speed = Schema.Struct({
  slug: Schema.String,
  tokensPerSecond: Schema.NullOr(Schema.Number),
  firstAnswerSeconds: Schema.NullOr(Schema.Number),
});
const TerminalRow = Schema.Struct({
  slug: Schema.String,
  effort: Schema.Literals(REASONING_EFFORTS),
  accuracy: Schema.Number,
  costPerTrial: Schema.NullOr(Schema.Number),
});
const Snapshot = Schema.Struct({
  fetchedAt: Schema.String,
  models: Schema.Array(BenchmarkModel),
  speed: Schema.Array(Speed),
  terminal: Schema.Array(TerminalRow),
  terminalAvailable: Schema.Boolean,
});
export type ModelScoreSnapshot = typeof Snapshot.Type;
export const parseScoreSnapshot = Schema.decodeUnknownSync(Snapshot);

const ModelFeed = Schema.Struct({ items: Schema.Array(Schema.Unknown) });
const ExternalModel = Schema.Struct({
  slug: Schema.String,
  benchmarks: Schema.Struct({
    agentic: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    coding: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
});
const ExternalSpeed = Schema.Struct({
  slug: Schema.String,
  tokensPerSecond: Schema.optional(Schema.NullOr(Schema.Number)),
  ttft: Schema.optional(Schema.NullOr(Schema.Number)),
});
const TerminalFeed = Schema.Struct({ rows: Schema.Array(Schema.Unknown) });
const ExternalTerminal = Schema.Struct({
  metadata: Schema.Struct({
    reasoning_effort: Schema.String,
    model_display: Schema.Struct({ url: Schema.String }),
  }),
  metrics: Schema.Struct({
    accuracy: Schema.Number,
    n_trials: Schema.optional(Schema.Number),
    total_cost_usd: Schema.optional(Schema.NullOr(Schema.Number)),
  }),
});

// Observed 2026-10-19: these model pages use names that differ from the BenchLM slug.
const SLUG_OVERRIDES: ReadonlyMap<string, string> = new Map([
  ["claude-fable-5", "claude-fable"],
  ["claude-fable-5-mythos-5", "claude-fable"],
  ["all-models", "claude-fable-5-1"],
  ["model_studio_update_notice_for_qwen38max_models_863", "qwen3-8-max"],
]);

/** Exact boundary join only. No family, prefix, or display-label matching. */
export function benchmarkSlug(modelId: string): string {
  const normalized = modelId.toLowerCase().replaceAll(".", "-");
  return SLUG_OVERRIDES.get(normalized) ?? normalized;
}

/** Normalizes recoverable public-feed variation. Invalid rows and nonnumeric measurements are not evidence. */
export function normalizeModelScores(models: unknown, speed: unknown, terminal: unknown | undefined, now: Date): ModelScoreSnapshot {
  const normalizedModels = Schema.decodeUnknownSync(ModelFeed)(models).items.flatMap((value) => {
    const row = Schema.decodeUnknownOption(ExternalModel)(value);
    if (row._tag === "None") return [];
    const benchmarks = Object.fromEntries(Object.entries(row.value.benchmarks).flatMap(([category, values]) =>
      Object.entries(values ?? {}).flatMap(([key, score]) =>
        typeof score === "number" && Number.isFinite(score) ? [[`${category}.${key}`, score] as const] : [])));
    return [{ slug: row.value.slug, benchmarks }];
  });
  if (normalizedModels.length === 0) throw new Error("BenchLM contains no usable model rows");
  const normalizedSpeed = Schema.decodeUnknownSync(ModelFeed)(speed).items.flatMap((value) => {
    const row = Schema.decodeUnknownOption(ExternalSpeed)(value);
    if (row._tag === "None") return [];
    return [{
      slug: row.value.slug,
      tokensPerSecond: finiteNonnegative(row.value.tokensPerSecond),
      firstAnswerSeconds: finiteNonnegative(row.value.ttft),
    }];
  });
  const normalizedTerminal = terminal === undefined ? [] : Schema.decodeUnknownSync(TerminalFeed)(terminal).rows.flatMap((value) => {
    const row = Schema.decodeUnknownOption(ExternalTerminal)(value);
    if (row._tag === "None" || !Number.isFinite(row.value.metrics.accuracy)) return [];
    const effortValue = row.value.metadata.reasoning_effort.toLowerCase();
    const effort = REASONING_EFFORTS.find((candidate) => candidate === (effortValue === "none" ? "off" : effortValue));
    if (effort === undefined) return [];
    let slug: string;
    try { slug = benchmarkSlug(new URL(row.value.metadata.model_display.url).pathname.split("/").filter(Boolean).at(-1) ?? ""); }
    catch { return []; }
    if (!slug) return [];
    const trials = finiteNonnegative(row.value.metrics.n_trials);
    const cost = finiteNonnegative(row.value.metrics.total_cost_usd);
    return [{
      slug, effort, accuracy: row.value.metrics.accuracy,
      costPerTrial: trials !== null && trials > 0 && cost !== null ? cost / trials : null,
    }];
  });
  return parseScoreSnapshot({
    fetchedAt: now.toISOString(), models: normalizedModels, speed: normalizedSpeed,
    terminal: normalizedTerminal, terminalAvailable: terminal !== undefined,
  });
}

function finiteNonnegative(value: number | null | undefined): number | null {
  return value !== undefined && value !== null && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Six calendar months, inclusive, with future or absent release dates excluded. */
export function recentScoreModel(releaseDate: string | undefined, now: Date): boolean {
  if (releaseDate === undefined) return false;
  const release = Date.parse(releaseDate);
  const cutoff = new Date(now);
  const day = cutoff.getUTCDate();
  cutoff.setUTCHours(0, 0, 0, 0);
  cutoff.setUTCDate(1);
  cutoff.setUTCMonth(cutoff.getUTCMonth() - 6);
  const lastDay = new Date(Date.UTC(cutoff.getUTCFullYear(), cutoff.getUTCMonth() + 1, 0)).getUTCDate();
  cutoff.setUTCDate(Math.min(day, lastDay));
  return Number.isFinite(release) && release >= cutoff.getTime() && release <= now.getTime();
}
