import { join } from "node:path";
import { Schema } from "effect";
import { BENCHMARK_MODES } from "./catalog.js";
import type { ImplementCandidate } from "./implement-scoring.js";
import { createJsonLinesLedger, readJsonFile } from "./json-lines.js";
import { realDirectoryUnder } from "./paths.js";
import { BenchmarkAccountingSchema, BenchmarkCampaignIdentitySchema } from "./evidence.js";

// Stored records are decoded with onExcessProperty: "error" so a record from
// a superseded shape (e.g. the removed provider field) fails loudly instead
// of silently misattributing results.

const BenchmarkModeSchema = Schema.Literals(BENCHMARK_MODES);

/** Looser than the shared VariantSpec: the strategy harness stores composite
 *  seats (model "a+b", effort "high+medium") under a strategy-name id. */
const BenchmarkVariantSchema = Schema.Struct({
  id: Schema.String,
  model: Schema.optionalKey(Schema.String),
  effort: Schema.optionalKey(Schema.String),
});

const RunConfigSchema = Schema.Struct({
  kind: Schema.Literal("benchmark-config"),
  persona: Schema.String,
  mode: BenchmarkModeSchema,
  variants: Schema.Array(BenchmarkVariantSchema),
  repeats: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  stamp: Schema.String,
  identity: BenchmarkCampaignIdentitySchema,
  taskIdentity: Schema.String,
  personaGuidanceIdentity: Schema.String,
  judgeIdentity: Schema.String,
  // The judge model and effort the campaign scores with. Absent when the campaign
  // has no judge seat (a solo research run) or was created before 2026-11-10,
  // when the judge was not recorded; such a judgeIdentity hashes the rubric alone.
  judge: Schema.optionalKey(Schema.Struct({ model: Schema.String, effort: Schema.String })),
  scoringVersion: Schema.String,
  // The source the campaign started on. Campaigns created before 2026-10-26 recorded none; that is permanent
  // history, so the field stays optional. Each cell records the source that ran it.
  sourceIdentity: Schema.optionalKey(Schema.String),
});

/** A repeat is a zero-based index into the configured repeats, so a negative
 *  value names no cell of any run. */
const RepeatSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const seatFields = {
  persona: Schema.String,
  variant: Schema.String,
  model: Schema.optionalKey(Schema.String),
  effort: Schema.optionalKey(Schema.String),
  task: Schema.String,
  repeat: RepeatSchema,
  // The Flywheel source that ran the cell (ARCH-DIRECTORIES-018). Cells recorded before 2026-11-13 carry none;
  // that is permanent history, not a shape to convert.
  sourceIdentity: Schema.optionalKey(Schema.String),
};

const agentRunBaseFields = {
  ...seatFields,
  kind: Schema.Literal("agent-run"),
  accounting: BenchmarkAccountingSchema,
  durationMs: Schema.Int,
  summary: Schema.String,
};

const ResearchRunRecordSchema = Schema.Struct({ ...agentRunBaseFields, mode: Schema.Literal("research") });
const ReviewRunRecordSchema = Schema.Struct({
  ...agentRunBaseFields,
  mode: Schema.Literal("reviewer"),
  reviewText: Schema.String,
});
const ImplementRunRecordSchema = Schema.Struct({
  ...agentRunBaseFields,
  mode: Schema.Literal("implement"),
  diff: Schema.String,
  linesAdded: Schema.Int,
  linesRemoved: Schema.Int,
  filesTouched: Schema.Int,
  acceptancePassed: Schema.Int,
  acceptanceFailed: Schema.Int,
  acceptanceTotal: Schema.Int,
  nativeGrade: Schema.optionalKey(Schema.String),
});
const AgentRunRecordSchema = Schema.Union([ResearchRunRecordSchema, ReviewRunRecordSchema, ImplementRunRecordSchema]);

/** Why a cell settled without a run record. */
const AttemptTerminalSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("failed"), message: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("timed-out"), timeoutMs: Schema.Int }),
  Schema.Struct({ kind: Schema.Literal("cancelled") }),
]);

/** One terminal cell that produced no run record, whether it failed, timed out,
 *  or was stopped. runs.jsonl stays the completion authority and never carries a
 *  failure; attempts.jsonl is the sole accounting authority for what did not
 *  settle, so a resumed run reports every cell whose work was spent without a
 *  result. An attempt creates no completion key, so --resume retries its cell, except an implementer attempt that hit
 *  its time limit: that is a scored cell (isScoredAttempt), which a resume keeps and never runs again. */
const AttemptRecordSchema = Schema.Struct({
  ...seatFields,
  kind: Schema.Literal("agent-run-attempt"),
  mode: BenchmarkModeSchema,
  attemptId: Schema.String,
  at: Schema.String,
  durationMs: Schema.Int,
  terminal: AttemptTerminalSchema,
  accounting: BenchmarkAccountingSchema,
});

/** How one judge call ended. Accounting only: the reason a call produced no
 *  score belongs to the score record it wrote, not to this ledger. */
const JudgeTerminalSchema = Schema.Literals(["completed", "failed", "timed-out", "cancelled"]);

/** Which score a judge call was making. A pair call compares two seats of one
 *  cell; a review or trap call scores one seat's run. */
const JudgeScoreIdentitySchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("pair-score"),
    task: Schema.String,
    repeat: RepeatSchema,
    slotA: Schema.String,
    slotB: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("review-score"), variant: Schema.String, task: Schema.String, repeat: RepeatSchema }),
  Schema.Struct({ kind: Schema.Literal("trap-score"), variant: Schema.String, task: Schema.String, repeat: RepeatSchema }),
  Schema.Struct({ kind: Schema.Literal("research-score"), variant: Schema.String, task: Schema.String, repeat: RepeatSchema }),
]);

/** One logical judge call. judge-attempts.jsonl is the sole accounting
 *  authority for what benchmark judging itself cost: every call settles here,
 *  whether or not it produced a score. scores.jsonl stays the authority for
 *  scoring completion, so a successful call writes to both. */
const JudgeAttemptRecordSchema = Schema.Struct({
  kind: Schema.Literal("judge-attempt"),
  attemptId: Schema.String,
  at: Schema.String,
  persona: Schema.String,
  mode: BenchmarkModeSchema,
  score: JudgeScoreIdentitySchema,
  terminal: JudgeTerminalSchema,
  accounting: BenchmarkAccountingSchema,
});

const JudgeVerdictSchema = Schema.Struct({
  task: Schema.String,
  repeat: RepeatSchema,
  slotA: Schema.String,
  slotB: Schema.String,
  winner: Schema.String,
  rationale: Schema.String,
});
export const ReviewScoreSchema = Schema.Struct({
  variant: Schema.String,
  task: Schema.String,
  repeat: RepeatSchema,
  caught: Schema.Array(Schema.String),
  uncertain: Schema.Array(Schema.String),
  unsupportedFindingCount: Schema.Int,
  // Remove after 2027-11-10: persona-v2 review scores did not ask the judge for
  // severity, so they carry no count; a report shows it as not measured.
  unsupportedSevereFindingCount: Schema.optionalKey(Schema.Int),
});
const TrapVerdictSchema = Schema.Struct({
  id: Schema.String,
  outcome: Schema.Literals(["self-corrected", "followed-blindly", "silently-lucky", "unclear"]),
  rationale: Schema.String,
});
export const ImplementScoreSchema = Schema.Struct({
  variant: Schema.String,
  task: Schema.String,
  repeat: RepeatSchema,
  traps: Schema.Array(TrapVerdictSchema),
});
/** One research answer scored against its task's answer key. `citations` is the
 *  mechanical check: how many distinct `path:line` citations the answer makes, and
 *  those that name no line of exactly one file at the pin. */
export const ResearchScoreSchema = Schema.Struct({
  variant: Schema.String,
  task: Schema.String,
  repeat: RepeatSchema,
  caught: Schema.Array(Schema.String),
  uncertain: Schema.Array(Schema.String),
  trapsAsserted: Schema.Array(Schema.String),
  citations: Schema.Struct({ total: Schema.Int, invalid: Schema.Array(Schema.String) }),
});
const ScoreRecordSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("pair-score"),
    mode: Schema.Literals(["research", "implement"]),
    persona: Schema.String,
    error: Schema.Null,
    verdict: JudgeVerdictSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("review-score"),
    mode: Schema.Literal("reviewer"),
    persona: Schema.String,
    error: Schema.Null,
    score: ReviewScoreSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("trap-score"),
    mode: Schema.Literal("implement"),
    persona: Schema.String,
    error: Schema.Null,
    score: ImplementScoreSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal("research-score"),
    mode: Schema.Literal("research"),
    persona: Schema.String,
    error: Schema.Null,
    score: ResearchScoreSchema,
  }),
]);

export type BenchmarkVariant = typeof BenchmarkVariantSchema.Type;
export type RunConfig = typeof RunConfigSchema.Type;
export type ResearchRunRecord = typeof ResearchRunRecordSchema.Type;
export type ImplementRunRecord = typeof ImplementRunRecordSchema.Type;
export type AgentRunRecord = typeof AgentRunRecordSchema.Type;
export type AttemptRecord = typeof AttemptRecordSchema.Type;
export type AttemptTerminal = typeof AttemptTerminalSchema.Type;
export type JudgeAttemptRecord = typeof JudgeAttemptRecordSchema.Type;
export type JudgeScoreIdentity = typeof JudgeScoreIdentitySchema.Type;
export type JudgeTerminal = typeof JudgeTerminalSchema.Type;
export type ScoreRecord = typeof ScoreRecordSchema.Type;
export type ResearchScore = typeof ResearchScoreSchema.Type;

const decodeConfig = Schema.decodeUnknownSync(RunConfigSchema, { onExcessProperty: "error" });

/** Shared record contracts for the historical split ledgers and the persona campaign ledger. */
export const PersonaRecordSchemas = {
  config: RunConfigSchema,
  run: AgentRunRecordSchema,
  attempt: AttemptRecordSchema,
  judgeAttempt: JudgeAttemptRecordSchema,
  score: ScoreRecordSchema,
};

function pairScoreKey(task: string, repeat: number, slotA: string, slotB: string): string {
  return `pair-score\u0000${task}\u0000${repeat}\u0000${[slotA, slotB].sort().join("\u0000")}`;
}

/** Returns the logical score identity recorded by one judge attempt. */
export function judgeScoreIdentityKey(score: JudgeScoreIdentity): string {
  if (score.kind === "pair-score") return pairScoreKey(score.task, score.repeat, score.slotA, score.slotB);
  return `${score.kind}\u0000${score.variant}\u0000${score.task}\u0000${score.repeat}`;
}

/** Returns the logical identity of one reusable successful score. */
export function scoreRecordIdentityKey(record: ScoreRecord): string {
  if (record.kind === "pair-score") {
    return pairScoreKey(record.verdict.task, record.verdict.repeat, record.verdict.slotA, record.verdict.slotB);
  }
  return `${record.kind}\u0000${record.score.variant}\u0000${record.score.task}\u0000${record.score.repeat}`;
}

export function runKey(run: Pick<AgentRunRecord, "variant" | "task" | "repeat">): string {
  return `${run.variant}\u0000${run.task}\u0000${run.repeat}`;
}

export function implementCandidate(run: ImplementRunRecord): ImplementCandidate {
  const { kind: _kind, mode: _mode, persona: _persona, model: _model, effort: _effort, sourceIdentity: _source, ...candidate } = run;
  return candidate;
}

/** The writable record contract of a persona campaign, which the persona
 *  campaign ledger implements. */
export interface RunStore {
  /** The canonical results directory: every component real, and below the
   *  results root. */
  readonly directory: string;
  loadConfig(): Promise<RunConfig>;
  loadRuns(): Promise<AgentRunRecord[]>;
  loadAttempts(): Promise<AttemptRecord[]>;
  /** Every judge call this results directory has settled. A directory written
   *  before the ledger existed reports none. */
  loadJudgeAttempts(): Promise<JudgeAttemptRecord[]>;
  loadScores(): Promise<ScoreRecord[]>;
  appendRun(record: AgentRunRecord): Promise<void>;
  appendAttempt(record: AttemptRecord): Promise<void>;
  appendJudgeAttempt(record: JudgeAttemptRecord): Promise<void>;
  appendScore(record: ScoreRecord): Promise<void>;
  /** Write one whole artifact of this run, such as its report or its raw
   *  results. */
  writeArtifact(name: string, text: string): Promise<void>;
}

export interface ReadOnlyRunEvidence {
  readonly directory: string;
  loadConfig(): Promise<RunConfig>;
  loadRuns(): Promise<AgentRunRecord[]>;
  loadAttempts(): Promise<AttemptRecord[]>;
  loadJudgeAttempts(): Promise<JudgeAttemptRecord[]>;
  loadScores(): Promise<ScoreRecord[]>;
}

/** Which results directory a store reads and writes, and the root it must stay
 *  inside. The benchmark catalog owns that root; nothing else derives one. */
export interface RunStoreLocation {
  readonly resultsRoot: string;
  readonly directory: string;
}

const DIRECTORY_LABEL = "The benchmark results directory";

/** Strictly reads a historical split-ledger campaign (run-config.json beside one
 *  JSON Lines file per record kind) without creating, repairing, or writing any
 *  artifact. Nothing writes this format any more; new evidence goes to the
 *  persona campaign ledger. */
export async function openReadOnlyRunEvidence(location: RunStoreLocation): Promise<ReadOnlyRunEvidence> {
  const directory = await realDirectoryUnder(location.resultsRoot, location.directory, DIRECTORY_LABEL);
  const resolvedPath = async (name: string): Promise<string> => join(await realDirectoryUnder(location.resultsRoot, location.directory, DIRECTORY_LABEL), name);
  const runs = createJsonLinesLedger(resolvedPath.bind(undefined, "runs.jsonl"), AgentRunRecordSchema, "reject");
  const attempts = createJsonLinesLedger(resolvedPath.bind(undefined, "attempts.jsonl"), AttemptRecordSchema, "reject");
  const judgeAttempts = createJsonLinesLedger(resolvedPath.bind(undefined, "judge-attempts.jsonl"), JudgeAttemptRecordSchema, "reject");
  const scores = createJsonLinesLedger(resolvedPath.bind(undefined, "scores.jsonl"), ScoreRecordSchema, "reject");
  const loadConfig = async (): Promise<RunConfig> => {
    const path = await resolvedPath("run-config.json");
    const text = await readJsonFile(path);
    if (text === undefined) throw new Error(`Missing run config: ${path}`);
    return decodeConfig(JSON.parse(text));
  };
  const validated = Promise.all([
    loadConfig(),
    runs.load(),
    attempts.load(),
    judgeAttempts.load(),
    scores.load(),
  ]).then(([config, runRows, attemptRows, judgeAttemptRows, scoreRows]) => {
    const variants = new Map(config.variants.map((variant) => [variant.id, variant]));
    if (variants.size !== config.variants.length) throw new Error("Duplicate benchmark variant IDs in persisted config");
    const assertCell = (row: { persona: string; mode: string; variant: string; model?: string; effort?: string; task: string; repeat: number }): void => {
      const variant = variants.get(row.variant);
      if (row.persona !== config.persona || row.mode !== config.mode) throw new Error("Benchmark ledger persona or mode does not match its campaign config");
      if (!variant || row.model !== variant.model || row.effort !== variant.effort) throw new Error(`Benchmark ledger variant identity does not match config: ${row.variant}`);
      if (row.repeat >= config.repeats) throw new Error(`Benchmark ledger repeat is outside configured range: ${row.repeat}`);
    };
    const runKeys = new Set<string>();
    for (const row of runRows) {
      assertCell(row);
      const key = runKey(row);
      if (runKeys.has(key)) throw new Error(`Duplicate completed benchmark cell: ${key}`);
      runKeys.add(key);
    }
    const attemptIds = new Set<string>();
    for (const row of attemptRows) {
      assertCell(row);
      if (attemptIds.has(row.attemptId)) throw new Error(`Duplicate benchmark attempt: ${row.attemptId}`);
      attemptIds.add(row.attemptId);
    }
    const assertScoreIdentity = (score: JudgeScoreIdentity): void => {
      const allowed = config.mode === "research"
        ? score.kind === "pair-score" || score.kind === "research-score"
        : config.mode === "reviewer"
          ? score.kind === "review-score"
          : score.kind === "pair-score" || score.kind === "trap-score";
      if (!allowed) throw new Error(`Judge score kind ${score.kind} is not valid for campaign mode ${config.mode}`);
      if (score.kind === "pair-score") {
        if (score.slotA === score.slotB) throw new Error("Judge pair must reference two distinct completed run cells");
        if (!runKeys.has(runKey({ variant: score.slotA, task: score.task, repeat: score.repeat }))
          || !runKeys.has(runKey({ variant: score.slotB, task: score.task, repeat: score.repeat }))) {
          throw new Error("Judge pair must reference two distinct completed run cells");
        }
      } else if (!runKeys.has(runKey(score))) {
        throw new Error(`Judge score must reference an exact completed run cell: ${runKey(score)}`);
      }
    };
    const judgeAttemptIds = new Set<string>();
    for (const row of judgeAttemptRows) {
      if (row.persona !== config.persona || row.mode !== config.mode) throw new Error("Judge attempt persona or mode does not match its campaign config");
      assertScoreIdentity(row.score);
      if (judgeAttemptIds.has(row.attemptId)) throw new Error(`Duplicate judge attempt: ${row.attemptId}`);
      judgeAttemptIds.add(row.attemptId);
    }
    const scoreKeys = new Set<string>();
    for (const row of scoreRows) {
      if (row.persona !== config.persona || row.mode !== config.mode) throw new Error("Score persona or mode does not match its campaign config");
      const identity: JudgeScoreIdentity = row.kind === "pair-score"
        ? { kind: "pair-score", task: row.verdict.task, repeat: row.verdict.repeat, slotA: row.verdict.slotA, slotB: row.verdict.slotB }
        : { kind: row.kind, variant: row.score.variant, task: row.score.task, repeat: row.score.repeat };
      assertScoreIdentity(identity);
      if (row.kind === "pair-score" && row.verdict.winner !== "tie" && row.verdict.winner !== row.verdict.slotA && row.verdict.winner !== row.verdict.slotB) {
        throw new Error(`Pair score winner is not one of its slots: ${row.verdict.winner}`);
      }
      const key = scoreRecordIdentityKey(row);
      if (scoreKeys.has(key)) throw new Error(`Duplicate successful benchmark score: ${key}`);
      scoreKeys.add(key);
    }
    return { config, runRows, attemptRows, judgeAttemptRows, scoreRows };
  });
  return {
    directory,
    async loadConfig() { return (await validated).config; },
    async loadRuns() { return (await validated).runRows; },
    async loadAttempts() { return (await validated).attemptRows; },
    async loadJudgeAttempts() { return (await validated).judgeAttemptRows; },
    async loadScores() { return (await validated).scoreRows; },
  };
}
