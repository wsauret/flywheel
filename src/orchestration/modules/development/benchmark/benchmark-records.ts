import { mkdir, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Schema } from "effect";
import { BENCHMARK_MODES, type BenchmarkMode, type ImplementTask, type ResearchTask, type ReviewTask } from "./catalog.js";
import { structuredIdentity } from "./content-identity.js";
import { BenchmarkAccountingSchema } from "./evidence.js";
import { harnessLintFile, loadHarnessLint } from "./harness-names.js";
import { createJsonLinesLedger } from "./json-lines.js";
import { ResearchScoreSchema } from "./research-scoring.js";
import { ImplementScoreSchema, ReviewScoreSchema, type AgentRunRecord, type AttemptRecord, type AttemptTerminal, type ScoreRecord } from "./run-store.js";

// Benchmark records are the public ledger of scored cells (ARCH-DIRECTORIES-020).
// Each campaign publishes one append-only file, bench/ab-persona/records/<persona>/<stamp>.jsonl:
// a campaign header, one line per completed cell with its output (an implementer cell that
// hit its time limit included), one line per absolute score of a cell by one judge, and
// one line per other failed attempt, which a ranking lists to retry. A campaign's events.jsonl stays the working
// ledger of execution, attempts, and judge accounting on the machine that ran it; this
// file is what a ranking or a rejudge reads, so every clone reproduces them. Pair
// verdicts are relative to one campaign's set and stay in its report.

const RepeatSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const JudgeSchema = Schema.Struct({ model: Schema.String, effort: Schema.String });

const CampaignHeaderSchema = Schema.Struct({
  kind: Schema.Literal("campaign"),
  version: Schema.Literal(1),
  persona: Schema.String,
  mode: Schema.Literals(BENCHMARK_MODES),
  stamp: Schema.String,
  /** The campaign's own judge. Other judges' scores carry their judge on each score line. */
  judge: JudgeSchema,
  scoringVersion: Schema.String,
  personaGuidanceIdentity: Schema.String,
});

const CellOutputSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("review"), text: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("answer"), text: Schema.String }),
  Schema.Struct({
    kind: Schema.Literal("implementation"),
    /** The candidate identity of the task this change answered (ImplementTaskBase.candidateIdentity): a regrade
     *  under a changed grader keeps the cell only while it still matches. */
    candidateIdentity: Schema.String,
    summary: Schema.String,
    diff: Schema.String,
    linesAdded: Schema.Int,
    linesRemoved: Schema.Int,
    filesTouched: Schema.Int,
    acceptancePassed: Schema.Int,
    acceptanceFailed: Schema.Int,
    acceptanceTotal: Schema.Int,
  }),
  /** An implementer cell that hit its time limit: a failed attempt with no change to grade or judge. */
  Schema.Struct({ kind: Schema.Literal("timed-out"), candidateIdentity: Schema.String, timeoutMs: Schema.Int }),
]);

const CellLineSchema = Schema.Struct({
  kind: Schema.Literal("cell"),
  variant: Schema.String,
  model: Schema.optionalKey(Schema.String),
  effort: Schema.optionalKey(Schema.String),
  task: Schema.String,
  /** The task's catalog content identity when the cell ran: a ranking pools the cell only while it still matches. */
  taskIdentity: Schema.String,
  repeat: RepeatSchema,
  durationMs: Schema.Int,
  accounting: BenchmarkAccountingSchema,
  /** The Flywheel source that ran the cell (ARCH-DIRECTORIES-018); cells that ran before 2026-11-13 recorded none. */
  sourceIdentity: Schema.optionalKey(Schema.String),
  output: CellOutputSchema,
});

const scoreFields = { kind: Schema.Literal("score"), judge: JudgeSchema, scoringVersion: Schema.String };
const ScoreLineSchema = Schema.Union([
  Schema.Struct({ ...scoreFields, scorer: Schema.Literal("review"), score: ReviewScoreSchema }),
  Schema.Struct({ ...scoreFields, scorer: Schema.Literal("research"), score: ResearchScoreSchema }),
  Schema.Struct({ ...scoreFields, scorer: Schema.Literal("trap"), score: ImplementScoreSchema }),
]);

/** One implementer cell regraded from its stored diff by a task grader. `graderIdentity` is the grader identity of
 *  the task whose grader ran, so a ranking reads only the grade of the current grader (regrade.ts). */
const GradeLineSchema = Schema.Struct({
  kind: Schema.Literal("grade"),
  graderIdentity: Schema.String,
  variant: Schema.String,
  task: Schema.String,
  repeat: RepeatSchema,
  passed: Schema.Int,
  failed: Schema.Int,
  total: Schema.Int,
});

/** One attempt that settled with no result to rank: an infrastructure or grader failure, a stop, or a time limit
 *  outside the implementer. A later attempt of the same cell can still record its cell line. */
const FailureLineSchema = Schema.Struct({
  kind: Schema.Literal("failure"),
  attemptId: Schema.String,
  variant: Schema.String,
  task: Schema.String,
  repeat: RepeatSchema,
  reason: Schema.String,
});

const RecordLineSchema = Schema.Union([CampaignHeaderSchema, CellLineSchema, ScoreLineSchema, GradeLineSchema, FailureLineSchema]);

export type RecordJudge = typeof JudgeSchema.Type;
export type CampaignHeader = typeof CampaignHeaderSchema.Type;
export type CellLine = typeof CellLineSchema.Type;
export type ScoreLine = typeof ScoreLineSchema.Type;
export type GradeLine = typeof GradeLineSchema.Type;
export type FailureLine = typeof FailureLineSchema.Type;

/** The identities of a planned task that a record line keeps: an implementation task adds what its candidate answers. */
type RecordedTask = Pick<ResearchTask | ReviewTask, "id" | "contentIdentity"> | Pick<ImplementTask, "id" | "contentIdentity" | "candidateIdentity">;

/** One campaign's record file, loaded and validated. */
export interface CampaignRecords {
  readonly file: string;
  readonly header: CampaignHeader;
  readonly cells: readonly CellLine[];
  readonly scores: readonly ScoreLine[];
  readonly grades: readonly GradeLine[];
  readonly failures: readonly FailureLine[];
}

/** The lines one append offers; each kind defaults to none. */
export interface RecordLines {
  readonly cells?: readonly CellLine[];
  readonly scores?: readonly ScoreLine[];
  readonly grades?: readonly GradeLine[];
  readonly failures?: readonly FailureLine[];
}

/** The scorer whose scores a campaign of `mode` records. */
export function recordScorer(mode: BenchmarkMode): ScoreLine["scorer"] {
  return mode === "reviewer" ? "review" : mode === "research" ? "research" : "trap";
}

export function judgeLabel(judge: RecordJudge): string {
  return `${judge.model}:${judge.effort}`;
}

function cellKey(cell: { variant: string; task: string; repeat: number }): string {
  return `${cell.variant}\u0000${cell.task}\u0000${cell.repeat}`;
}

function scoreKey(line: ScoreLine): string {
  return `${judgeLabel(line.judge)}\u0000${line.scoringVersion}\u0000${line.scorer}\u0000${cellKey(line.score)}`;
}

function gradeKey(line: GradeLine): string {
  return `${line.graderIdentity}\u0000${cellKey(line)}`;
}

/** The grade of `cell` by the grader whose identity is `graderIdentity`, from a regrade. */
export function currentGrade(campaign: CampaignRecords, cell: CellLine, graderIdentity: string): GradeLine | undefined {
  return campaign.grades.find((grade) => grade.graderIdentity === graderIdentity && grade.variant === cell.variant && grade.task === cell.task && grade.repeat === cell.repeat);
}

function ledger(file: string) {
  return createJsonLinesLedger(async () => file, RecordLineSchema, "reject");
}

function sameHeader(a: CampaignHeader, b: CampaignHeader): boolean {
  return structuredIdentity(a) === structuredIdentity(b);
}

/** Load one record file. A missing file is undefined. Every structural
 *  violation is an error naming the file and line, never a skipped line: a
 *  header that is not the first line or appears twice, a second line for one
 *  cell, score key, or failed attempt, a score of no recorded cell, or a scorer
 *  that is not the header mode's. */
export async function loadCampaignRecords(file: string): Promise<CampaignRecords | undefined> {
  const lines = await ledger(file).load();
  if (lines.length === 0) return undefined;
  const [header, ...rest] = lines;
  if (header?.kind !== "campaign") throw new Error(`${file}:1 is not the campaign header`);
  if (header.persona !== basename(dirname(file)) || `${header.stamp}.jsonl` !== basename(file)) {
    throw new Error(`${file}:1 names campaign ${header.persona}/${header.stamp}, which is not its file`);
  }
  const cells: CellLine[] = [];
  const scores: ScoreLine[] = [];
  const cellKeys = new Set<string>();
  const scoreKeys = new Set<string>();
  const grades: GradeLine[] = [];
  const gradeKeys = new Set<string>();
  const failures: FailureLine[] = [];
  const attemptIds = new Set<string>();
  for (const [index, line] of rest.entries()) {
    const at = `${file}:${index + 2}`;
    if (line.kind === "campaign") throw new Error(`${at} repeats the campaign header`);
    if (line.kind === "cell") {
      if (cellKeys.has(cellKey(line))) throw new Error(`${at} repeats cell ${line.variant} ${line.task} #${line.repeat}`);
      cellKeys.add(cellKey(line));
      cells.push(line);
      continue;
    }
    if (line.kind === "grade") {
      if (!cellKeys.has(cellKey(line))) throw new Error(`${at} grades ${line.variant} ${line.task} #${line.repeat}, which has no cell line before it`);
      if (gradeKeys.has(gradeKey(line))) throw new Error(`${at} repeats a grade of ${line.variant} ${line.task} #${line.repeat}`);
      gradeKeys.add(gradeKey(line));
      grades.push(line);
      continue;
    }
    if (line.kind === "failure") {
      if (attemptIds.has(line.attemptId)) throw new Error(`${at} repeats failed attempt ${line.attemptId}`);
      attemptIds.add(line.attemptId);
      failures.push(line);
      continue;
    }
    if (line.scorer !== recordScorer(header.mode)) throw new Error(`${at} is a ${line.scorer} score in a ${header.mode} campaign`);
    if (!cellKeys.has(cellKey(line.score))) throw new Error(`${at} scores ${line.score.variant} ${line.score.task} #${line.score.repeat}, which has no cell line before it`);
    if (scoreKeys.has(scoreKey(line))) throw new Error(`${at} repeats the ${judgeLabel(line.judge)} score of ${line.score.variant} ${line.score.task} #${line.score.repeat}`);
    scoreKeys.add(scoreKey(line));
    scores.push(line);
  }
  return { file, header, cells, scores, grades, failures };
}

/** Every record file under `recordsRoot`, one folder per persona. */
export async function loadAllCampaignRecords(recordsRoot: string): Promise<CampaignRecords[]> {
  const personas = await readdir(recordsRoot, { withFileTypes: true }).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
  const campaigns: CampaignRecords[] = [];
  for (const persona of personas.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const files = (await readdir(join(recordsRoot, persona.name))).filter((name) => name.endsWith(".jsonl")).sort();
    for (const name of files) {
      const records = await loadCampaignRecords(join(recordsRoot, persona.name, name));
      if (records) campaigns.push(records);
    }
  }
  return campaigns;
}

/** Append the header, cells, scores, grades, and failed attempts that `file`
 *  does not yet hold, in that order, and never rewrite a line, so a run, a
 *  resume, a rescore, a rejudge, and a regrade can each call it with everything
 *  they know. A file whose header differs from `header` is another campaign's
 *  and refuses. Returns the count of appended lines of each kind. */
export async function appendCampaignRecords(
  file: string,
  header: CampaignHeader,
  { cells = [], scores = [], grades = [], failures = [] }: RecordLines,
): Promise<{ cells: number; scores: number; grades: number; failures: number }> {
  const existing = await loadCampaignRecords(file);
  if (existing && !sameHeader(existing.header, header)) throw new Error(`${file} holds another campaign header; refusing to append`);
  const records = ledger(file);
  if (!existing) {
    await mkdir(dirname(file), { recursive: true });
    await records.append(header);
  }
  const cellKeys = new Set(existing?.cells.map(cellKey));
  const newCells = cells.filter((cell) => !cellKeys.has(cellKey(cell)));
  for (const cell of newCells) {
    await records.append(cell);
    cellKeys.add(cellKey(cell));
  }
  const scoreKeys = new Set(existing?.scores.map(scoreKey));
  const newScores = scores.filter((score) => !scoreKeys.has(scoreKey(score)));
  for (const score of newScores) {
    if (!cellKeys.has(cellKey(score.score))) throw new Error(`${file}: a ${judgeLabel(score.judge)} score of ${score.score.variant} ${score.score.task} #${score.score.repeat} has no cell`);
    await records.append(score);
    scoreKeys.add(scoreKey(score));
  }
  const gradeKeys = new Set(existing?.grades.map(gradeKey));
  const newGrades = grades.filter((grade) => !gradeKeys.has(gradeKey(grade)));
  for (const grade of newGrades) {
    if (!cellKeys.has(cellKey(grade))) throw new Error(`${file}: a grade of ${grade.variant} ${grade.task} #${grade.repeat} has no cell`);
    await records.append(grade);
    gradeKeys.add(gradeKey(grade));
  }
  const attemptIds = new Set(existing?.failures.map(({ attemptId }) => attemptId));
  const newFailures = failures.filter(({ attemptId }) => !attemptIds.has(attemptId));
  for (const failure of newFailures) {
    await records.append(failure);
    attemptIds.add(failure.attemptId);
  }
  return { cells: newCells.length, scores: newScores.length, grades: newGrades.length, failures: newFailures.length };
}

/** Publish every successful run, timed-out implementer attempt, other failed attempt, and absolute score of one
 *  campaign that its record file does not yet hold. Run, resume, and rescore all call it, and it only appends, so a
 *  later call adds what an earlier one could not. `tasks` are the campaign's planned tasks, whose identities each
 *  cell records. */
export async function exportCampaignRecords(
  file: string,
  header: CampaignHeader,
  runs: readonly AgentRunRecord[],
  attempts: readonly AttemptRecord[],
  scores: readonly ScoreRecord[],
  tasks: readonly RecordedTask[],
  projectRoot: string,
): Promise<void> {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const taskOf = (id: string) => {
    const task = byId.get(id);
    if (task === undefined) throw new Error(`Cell of ${id} names no planned task`);
    return task;
  };
  const redact = await recordRedactor(projectRoot);
  const cells = runs.map((run) => cellLine(run, taskOf(run.task), redact));
  const failures: FailureLine[] = [];
  for (const attempt of attempts) {
    const task = taskOf(attempt.task);
    if (isScoredAttempt(attempt)) {
      if (!("candidateIdentity" in task)) throw new Error(`Implementation attempt of ${attempt.task} names a task that is not an implementation task`);
      cells.push(timedOutCellLine(attempt, attempt.terminal.timeoutMs, task));
    } else failures.push({ kind: "failure", attemptId: attempt.attemptId, variant: attempt.variant, task: attempt.task, repeat: attempt.repeat, reason: redact(failureReason(attempt.terminal)) });
  }
  await appendCampaignRecords(file, header, { cells, scores: scores.flatMap((record) => scoreLine(record, header.judge, header.scoringVersion) ?? []), failures });
}

/** Whether an attempt is a scored cell rather than a failure: an implementer attempt that hit its time limit ranks as
 *  a failed attempt at the limit, so a record publishes it as a cell and a resume never runs it again. */
export function isScoredAttempt<Attempt extends Pick<AttemptRecord, "mode" | "terminal">>(attempt: Attempt): attempt is Attempt & { terminal: Extract<AttemptTerminal, { kind: "timed-out" }> } {
  return attempt.mode === "implement" && attempt.terminal.kind === "timed-out";
}

function failureReason(terminal: AttemptTerminal): string {
  if (terminal.kind === "failed") return terminal.message;
  return terminal.kind === "timed-out" ? `timed out after ${terminal.timeoutMs}ms` : "cancelled";
}

/** The cell line of an implementer attempt that hit its time limit: it ranks as a failed attempt whose latency is
 *  the limit and whose cost is what it spent. */
function timedOutCellLine(attempt: AttemptRecord, timeoutMs: number, task: Extract<RecordedTask, { candidateIdentity: string }>): CellLine {
  return {
    ...seatOf(attempt, task),
    durationMs: timeoutMs,
    accounting: attempt.accounting,
    output: { kind: "timed-out", candidateIdentity: task.candidateIdentity, timeoutMs },
  };
}

function seatOf(seat: AgentRunRecord | AttemptRecord, task: RecordedTask) {
  return {
    kind: "cell" as const,
    variant: seat.variant,
    ...(seat.model === undefined ? {} : { model: seat.model }),
    ...(seat.effort === undefined ? {} : { effort: seat.effort }),
    task: seat.task,
    taskIdentity: task.contentIdentity,
    repeat: seat.repeat,
    ...(seat.sourceIdentity === undefined ? {} : { sourceIdentity: seat.sourceIdentity }),
  };
}

/** Rewrites each name of another coding agent in candidate output to these
 *  words before a record publishes it, because the public tree names no such
 *  agent. The names come from the maintainer's private lint (harness-names.ts);
 *  a checkout without it publishes the text unchanged, and has no lint that
 *  would fail on it either. */
async function recordRedactor(projectRoot: string): Promise<(text: string) => string> {
  const lint = await loadHarnessLint(projectRoot, harnessLintFile(projectRoot));
  return lint ? (text) => lint.scrub(text, () => "another coding agent").text : (text) => text;
}

/** The record line of one successful run. `redact` rewrites candidate text
 *  before publication (the names of other coding agents); scores are unaffected. */
function cellLine(run: AgentRunRecord, task: RecordedTask, redact: (text: string) => string): CellLine {
  const seat = { ...seatOf(run, task), durationMs: run.durationMs, accounting: run.accounting };
  if (run.mode === "reviewer") return { ...seat, output: { kind: "review", text: redact(run.reviewText) } };
  if (run.mode === "research") return { ...seat, output: { kind: "answer", text: redact(run.summary) } };
  if (!("candidateIdentity" in task)) throw new Error(`Implementation run of ${run.task} names a task that is not an implementation task`);
  // The full grader report stays in the local run store: records keep only the counts a ranking reads.
  return {
    ...seat,
    output: {
      kind: "implementation",
      candidateIdentity: task.candidateIdentity,
      summary: redact(run.summary),
      diff: redact(run.diff),
      linesAdded: run.linesAdded,
      linesRemoved: run.linesRemoved,
      filesTouched: run.filesTouched,
      acceptancePassed: run.acceptancePassed,
      acceptanceFailed: run.acceptanceFailed,
      acceptanceTotal: run.acceptanceTotal,
    },
  };
}

/** The record line of one successful absolute score, or undefined for a pair verdict, which records omit. */
export function scoreLine(record: ScoreRecord, judge: RecordJudge, scoringVersion: string): ScoreLine | undefined {
  const fields = { kind: "score" as const, judge: { model: judge.model, effort: judge.effort }, scoringVersion };
  if (record.kind === "review-score") return { ...fields, scorer: "review", score: record.score };
  if (record.kind === "research-score") return { ...fields, scorer: "research", score: record.score };
  if (record.kind === "trap-score") return { ...fields, scorer: "trap", score: record.score };
  return undefined;
}
