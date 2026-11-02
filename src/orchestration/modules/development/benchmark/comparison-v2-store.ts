import { join } from "node:path";
import { Schema } from "effect";
import { structuredIdentity } from "./content-identity.js";
import { BenchmarkAccountingSchema, BenchmarkCampaignIdentitySchema } from "./evidence.js";
import { createJsonFile, createJsonLinesLedger, readJsonFile, writeArtifactFile } from "./json-lines.js";
import { ensuredDirectoryUnder, realDirectoryUnder } from "./paths.js";
import type { RunStoreLocation } from "./run-store.js";

const ContentIdentitySchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));
const RepeatSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const VariantSchema = Schema.Struct({ id: Schema.String, model: Schema.optionalKey(Schema.String), effort: Schema.optionalKey(Schema.String) });
const PairIdentitySchema = Schema.Struct({
  task: Schema.String,
  repeat: RepeatSchema,
  slotA: Schema.String,
  slotB: Schema.String,
});
const VerdictSchema = Schema.Struct({
  ...PairIdentitySchema.fields,
  winner: Schema.String,
  rationale: Schema.String,
});
const ConfigSchema = Schema.Struct({
  kind: Schema.Literal("cross-comparison-config-v2"),
  identity: ContentIdentitySchema,
  sources: Schema.Array(Schema.Struct({
    directory: Schema.String,
    configIdentity: ContentIdentitySchema,
    campaign: BenchmarkCampaignIdentitySchema,
    variant: VariantSchema,
    label: Schema.String,
  })),
  candidatePairs: Schema.Array(Schema.Struct({
    task: Schema.String,
    repeat: RepeatSchema,
    labelA: Schema.String,
    labelB: Schema.String,
    candidateAIdentity: ContentIdentitySchema,
    candidateBIdentity: ContentIdentitySchema,
  })),
  taskIdentity: ContentIdentitySchema,
  personaGuidanceIdentity: Schema.String,
  judgeModel: Schema.String,
  judgeRubricIdentity: ContentIdentitySchema,
  scoringVersion: Schema.String,
  judge: BenchmarkCampaignIdentitySchema,
});
const ScoreSchema = Schema.Struct({
  kind: Schema.Literal("cross-pair-score-v2"),
  comparisonIdentity: ContentIdentitySchema,
  attemptId: Schema.String,
  verdict: VerdictSchema,
});
const AttemptSchema = Schema.Struct({
  kind: Schema.Literal("cross-judge-attempt-v2"),
  comparisonIdentity: ContentIdentitySchema,
  attemptId: Schema.String,
  at: Schema.String,
  score: PairIdentitySchema,
  terminal: Schema.Literals(["completed", "failed", "timed-out", "cancelled"]),
  accounting: BenchmarkAccountingSchema,
});

export type CrossComparisonV2Config = typeof ConfigSchema.Type;
type CrossComparisonV2JudgeAttemptRecord = typeof AttemptSchema.Type;
type CrossComparisonV2ScoreRecord = typeof ScoreSchema.Type;

interface CrossComparisonV2Evidence {
  readonly scores: readonly CrossComparisonV2ScoreRecord[];
  readonly attempts: readonly CrossComparisonV2JudgeAttemptRecord[];
}

export interface CrossComparisonV2Store {
  readonly directory: string;
  loadConfig(): Promise<CrossComparisonV2Config>;
  loadEvidence(): Promise<CrossComparisonV2Evidence>;
  appendScore(record: CrossComparisonV2ScoreRecord): Promise<void>;
  appendJudgeAttempt(record: CrossComparisonV2JudgeAttemptRecord): Promise<void>;
  writeReport(text: string): Promise<void>;
}

const decodeConfig = Schema.decodeUnknownSync(ConfigSchema, { onExcessProperty: "error" });
const DIRECTORY_LABEL = "The benchmark results directory";

function pairKey(value: typeof PairIdentitySchema.Type): string {
  return `${value.task}\u0000${value.repeat}\u0000${[value.slotA, value.slotB].sort().join("\u0000")}`;
}

function hasOrderedIdentity(left: typeof PairIdentitySchema.Type, right: typeof PairIdentitySchema.Type): boolean {
  return left.task === right.task
    && left.repeat === right.repeat
    && left.slotA === right.slotA
    && left.slotB === right.slotB;
}

function assertConfiguredPair(config: CrossComparisonV2Config, pair: typeof PairIdentitySchema.Type): void {
  const key = pairKey(pair);
  if (pair.slotA === pair.slotB) throw new Error("Comparison pair must use distinct candidate slots");
  if (!config.candidatePairs.some((candidate) => pairKey({
    task: candidate.task,
    repeat: candidate.repeat,
    slotA: candidate.labelA,
    slotB: candidate.labelB,
  }) === key)) {
    throw new Error(`Comparison evidence does not match a configured candidate pair: ${key}`);
  }
}

/** Opens the dedicated N-candidate comparison evidence. V1 artifacts remain independent. */
export async function createCrossComparisonV2Store(location: RunStoreLocation, config?: CrossComparisonV2Config): Promise<CrossComparisonV2Store> {
  const directory = config
    ? await ensuredDirectoryUnder(location.resultsRoot, location.directory, DIRECTORY_LABEL)
    : await realDirectoryUnder(location.resultsRoot, location.directory, DIRECTORY_LABEL);
  const resolvedPath = async (name: string): Promise<string> => join(await realDirectoryUnder(location.resultsRoot, location.directory, DIRECTORY_LABEL), name);
  const configPath = await resolvedPath("run-config.json");
  if (config) {
    const decoded = decodeConfig(config);
    await createJsonFile(configPath, `${JSON.stringify(decoded, null, 2)}\n`).catch((error) => {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        throw new Error(`Results directory already has a comparison config: ${directory}`);
      }
      throw error;
    });
  }
  const scores = createJsonLinesLedger(resolvedPath.bind(undefined, "scores.jsonl"), ScoreSchema, "repair");
  const attempts = createJsonLinesLedger(resolvedPath.bind(undefined, "judge-attempts.jsonl"), AttemptSchema, "reject");
  const loadConfig = async (): Promise<CrossComparisonV2Config> => {
    const text = await readJsonFile(configPath);
    if (text === undefined) throw new Error(`Missing comparison config: ${configPath}`);
    const decoded = decodeConfig(JSON.parse(text));
    const { kind: _kind, identity, ...identityBody } = decoded;
    if (identity !== structuredIdentity(identityBody)) throw new Error("Comparison config identity does not match its content");
    if (decoded.sources.length < 2) throw new Error("Comparison config requires at least 2 candidates");
    const labels = decoded.sources.map((source) => source.label);
    if (new Set(labels).size !== labels.length) throw new Error("Duplicate candidate labels in comparison config");
    const sourceKeys = decoded.sources.map((source) => `${source.directory}\u0000${source.variant.id}`);
    if (new Set(sourceKeys).size !== sourceKeys.length) throw new Error("Duplicate candidates in comparison config");
    const pairKeys = decoded.candidatePairs.map((pair) => pairKey({ task: pair.task, repeat: pair.repeat, slotA: pair.labelA, slotB: pair.labelB }));
    if (new Set(pairKeys).size !== pairKeys.length) throw new Error("Duplicate candidate pairs in comparison config");
    return decoded;
  };
  return {
    directory,
    loadConfig,
    async loadEvidence() {
      const [persisted, scoreRows, attemptRows] = await Promise.all([loadConfig(), scores.load(), attempts.load()]);
      const attemptsById = new Map<string, CrossComparisonV2JudgeAttemptRecord>();
      for (const row of attemptRows) {
        if (row.comparisonIdentity !== persisted.identity) throw new Error("Comparison attempt identity does not match its config");
        assertConfiguredPair(persisted, row.score);
        if (attemptsById.has(row.attemptId)) throw new Error(`Duplicate comparison judge attempt: ${row.attemptId}`);
        attemptsById.set(row.attemptId, row);
      }
      const scoreKeys = new Set<string>();
      for (const row of scoreRows) {
        if (row.comparisonIdentity !== persisted.identity) throw new Error("Comparison score identity does not match its config");
        assertConfiguredPair(persisted, row.verdict);
        const attempt = attemptsById.get(row.attemptId);
        if (!attempt) throw new Error(`Comparison score references an orphan judge attempt: ${row.attemptId}`);
        if (attempt.terminal !== "completed") throw new Error(`Comparison score attempt is not completed: ${row.attemptId}`);
        if (!hasOrderedIdentity(attempt.score, row.verdict)) {
          throw new Error(`Comparison score does not match its attempt's ordered identity: ${row.attemptId}`);
        }
        if (row.verdict.winner !== "tie" && row.verdict.winner !== row.verdict.slotA && row.verdict.winner !== row.verdict.slotB) {
          throw new Error(`Comparison score winner is not one of its configured slots: ${row.verdict.winner}`);
        }
        const key = pairKey(row.verdict);
        if (scoreKeys.has(key)) throw new Error(`Duplicate successful comparison score: ${key}`);
        scoreKeys.add(key);
      }
      return { scores: scoreRows, attempts: attemptRows };
    },
    async appendScore(record) { await scores.append(record); },
    async appendJudgeAttempt(record) { await attempts.append(record); },
    async writeReport(text) { await writeArtifactFile(await resolvedPath("report.md"), text); },
  };
}
