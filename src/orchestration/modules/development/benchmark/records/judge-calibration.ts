import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { PersonaRecordSchemas, QualityFindingSchema, type JudgeAttemptRecord, type QualityFinding } from "../scoring/run-store.js";
import { diffPath, hasReferencePatch, judgedScore, qualityJudgeInput, qualityPromptIdentity, qualityScoringVersion, scoreImplementQuality, type QualityJudgeInput } from "../scoring/quality-judge.js";
import type { JudgeAttemptReport, JudgeModel } from "../scoring/judge.js";
import { judgeLabel, type CampaignRecords, type RecordJudge } from "./benchmark-records.js";
import { byCodeUnit, qualityScoreOf, staleTask, type QualityCalibrationStanding, type RankingInput } from "./ranking-pool.js";
import type { BenchmarkCatalog } from "../catalog.js";
import { createJsonLinesLedger } from "../campaign/json-lines.js";
import { realFileUnder } from "../campaign/paths.js";

// The committed calibration of the judged-quality judge (ARCH-DIRECTORIES-026). A judge's judged quality enters an
// implementer ranking only when both checks pass under its current judge identity:
//   1. Seeded controls: it finds the one known defect of each seeded control, and reports no major finding on each
//      clean reference.
//   2. Reviewer agreement: its recorded scores of a stratified sample of stored cells rank them as the reviewer
//      agents' merged labels do.
// The data are committed: `controls.json` with each control's diff, `reviewer-labels.json` with the sampled cells and
// their labels, and one results file per judge with its raw findings on each control. Pass or fail derives from these
// files and the records at read time, so the thresholds have one home.

const SEEDED_RECALL = 0.8;
const CLEAN_SHARE = 0.8;
const MIN_AGREEMENT = 0.6;
/** The reviewer-labeled sample size. */
const LABELED_CELLS = 20;
/** How far a reported line may lie from the seeded line and still name the seeded defect. */
const LINE_TOLERANCE = 5;

const FindingKindSchema = Schema.Literals(["needless-code", "wrong-abstraction", "convention-break", "missed-defect"]);
const ControlSchema = Schema.Struct({
  id: Schema.String,
  task: Schema.String,
  /** The control's diff, relative to the calibration folder. */
  patch: Schema.String,
  /** The handoff text the judge reads beside the diff. */
  summary: Schema.String,
  /** What the control is, for a reader. */
  description: Schema.String,
  /** The one defect a seeded control adds: its kind and its line in the new file. A clean reference has none. */
  seeded: Schema.optionalKey(Schema.Struct({ kind: FindingKindSchema, file: Schema.String, line: Schema.Int })),
});
const ControlsFileSchema = Schema.Struct({ controls: Schema.Array(ControlSchema) });
const LabelSchema = Schema.Struct({
  persona: Schema.String,
  stamp: Schema.String,
  variant: Schema.String,
  task: Schema.String,
  repeat: Schema.Int,
  /** The reviewer agents' merged findings in the diff; absent until the cell is labeled. */
  findings: Schema.optionalKey(Schema.Array(QualityFindingSchema)),
});
const LabelsFileSchema = Schema.Struct({ cells: Schema.Array(LabelSchema) });
const ControlResultSchema = Schema.Struct({
  id: Schema.String,
  /** The identity of the exact judge input the result answers (`qualityPromptIdentity`): an edited patch, summary,
   *  request, or reference makes the result stale. */
  input: Schema.String,
  findings: Schema.Array(QualityFindingSchema),
  scopeOk: Schema.Boolean,
  discarded: Schema.Int,
});
const ResultsFileSchema = Schema.Struct({
  judge: Schema.Struct({ model: Schema.String, effort: Schema.String }),
  /** The judge identity the findings were reported under. */
  identity: Schema.String,
  controls: Schema.Array(ControlResultSchema),
});

type Control = typeof ControlSchema.Type;
type ReviewerLabel = typeof LabelSchema.Type;
type CalibrationResults = typeof ResultsFileSchema.Type;

/** A committed control with its diff and the judge input it renders, as a calibration judges it. */
interface LoadedControl extends Control {
  readonly diff: string;
  readonly judgeInput: QualityJudgeInput;
  /** The identity of the control's exact judge input (`qualityPromptIdentity`). */
  readonly input: string;
}

export interface QualityCalibrationData {
  /** The current judge identity over the catalog's implementer tasks. */
  readonly identity: string;
  /** The tasks that controls must cover: each group needs one task with a clean reference and a seeded control. Each
   *  task whose reference is a patch is its own group, and the plan tasks form one group. */
  readonly coverage: readonly (readonly string[])[];
  readonly controls: readonly LoadedControl[];
  readonly labels: readonly ReviewerLabel[];
  readonly results: readonly CalibrationResults[];
}

const strict = { onExcessProperty: "error" } as const;
const decodeControls = Schema.decodeUnknownSync(ControlsFileSchema, strict);
const decodeLabels = Schema.decodeUnknownSync(LabelsFileSchema, strict);
const decodeResults = Schema.decodeUnknownSync(ResultsFileSchema, strict);

function resultsDir(directory: string): string {
  return join(directory, "results");
}

/** One portable file name component for `judge`: a model id may hold a slash. Readers match on the judge inside. */
function judgeFileName(judge: RecordJudge): string {
  return encodeURIComponent(`${judge.model}@${judge.effort}`);
}

function resultsFile(directory: string, judge: RecordJudge): string {
  return join(resultsDir(directory), `${judgeFileName(judge)}.json`);
}

const labelKey = (cell: Pick<ReviewerLabel, "persona" | "stamp" | "variant" | "task" | "repeat">) => `${cell.persona}\u0000${cell.stamp}\u0000${cell.variant}\u0000${cell.task}\u0000${cell.repeat}`;

/** The values of `keys` that occur more than once. */
function repeated(keys: readonly string[]): string[] {
  return [...new Set(keys.filter((key, index) => keys.indexOf(key) !== index))];
}

async function readJson<T>(file: string, decode: (value: unknown) => T): Promise<T> {
  try {
    return decode(await Bun.file(file).json());
  } catch (cause) {
    throw new Error(`${file} is not valid judged-quality calibration data: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

/** Load the committed calibration data of `catalog`, with each control's diff and judge input and the current judge
 *  identity. Every file is decoded strictly, and a repeated control id or labeled cell fails, so each counts once; a
 *  missing results folder holds no judge's results. */
export async function loadQualityCalibration(catalog: BenchmarkCatalog): Promise<QualityCalibrationData> {
  const directory = catalog.qualityCalibrationDir;
  const { controls: committed } = await readJson(join(directory, "controls.json"), decodeControls);
  const { cells: labels } = await readJson(join(directory, "reviewer-labels.json"), decodeLabels);
  const repeatedControls = repeated(committed.map(({ id }) => id));
  if (repeatedControls.length > 0) throw new Error(`${join(directory, "controls.json")} repeats the control ids ${repeatedControls.join(", ")}`);
  const repeatedLabels = repeated(labels.map(labelKey));
  if (repeatedLabels.length > 0) throw new Error(`${join(directory, "reviewer-labels.json")} repeats the cells ${repeatedLabels.map((key) => key.split("\u0000").join(" ")).join(", ")}`);
  const implementTasks = await catalog.implementTasks();
  const tasks = new Map(implementTasks.map((task) => [task.id, task]));
  const inputs = new Map<string, Promise<QualityJudgeInput>>();
  const controls = await Promise.all(committed.map(async (control): Promise<LoadedControl> => {
    const task = tasks.get(control.task);
    if (!task) throw new Error(`Calibration control ${control.id} names ${control.task}, which is not an implementer task`);
    if (!inputs.has(task.id)) inputs.set(task.id, qualityJudgeInput(task));
    // SAFETY: the line above sets the task's input.
    const judgeInput = await inputs.get(task.id)!;
    const diff = await Bun.file(await realFileUnder(directory, join(directory, control.patch), `control ${control.id}`)).text();
    return { ...control, diff, judgeInput, input: qualityPromptIdentity(judgeInput, diff, control.summary) };
  }));
  const names = await readdir(resultsDir(directory)).catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return [];
    throw error;
  });
  const results = await Promise.all(names.filter((name) => name.endsWith(".json")).sort().map((name) => readJson(join(resultsDir(directory), name), decodeResults)));
  const planTasks = implementTasks.filter(({ kind }) => kind !== "native").map(({ id }) => id);
  const coverage = [...implementTasks.filter(({ id }) => hasReferencePatch(id)).map(({ id }) => [id]), ...planTasks.length > 0 ? [planTasks] : []];
  return { identity: await qualityScoringVersion(implementTasks), coverage, controls, labels, results };
}

/** Spearman's rank correlation of two equal-length lists, with tied values at their mean rank; undefined when either
 *  list has fewer than two items or no spread. */
export function spearman(xs: readonly number[], ys: readonly number[]): number | undefined {
  if (xs.length !== ys.length) throw new Error("Spearman's correlation needs two lists of one length");
  if (xs.length < 2) return undefined;
  const ranks = (values: readonly number[]) => values.map((value) => {
    const below = values.filter((other) => other < value).length;
    const equal = values.filter((other) => other === value).length;
    return below + (equal + 1) / 2;
  });
  const [a, b] = [ranks(xs), ranks(ys)];
  const mean = (values: readonly number[]) => values.reduce((total, value) => total + value, 0) / values.length;
  const [ma, mb] = [mean(a), mean(b)];
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (const [index, value] of a.entries()) {
    // SAFETY: `b` has the length of `a`.
    const other = b[index]!;
    covariance += (value - ma) * (other - mb);
    varianceA += (value - ma) ** 2;
    varianceB += (other - mb) ** 2;
  }
  return varianceA === 0 || varianceB === 0 ? undefined : covariance / Math.sqrt(varianceA * varianceB);
}

/** Whether `findings` report the seeded defect of a control: same kind and file, and a line within LINE_TOLERANCE. */
function findsSeeded(findings: readonly QualityFinding[], seeded: NonNullable<Control["seeded"]>): boolean {
  return findings.some((finding) => finding.kind === seeded.kind && diffPath(finding.file) === diffPath(seeded.file) && Math.abs(finding.line - seeded.line) <= LINE_TOLERANCE);
}

/** One judge's calibration against the committed data. */
export interface QualityCalibrationReport {
  readonly judge: RecordJudge;
  readonly identity: string;
  /** Controls with no result under the current judge identity, or whose result answers an earlier judge input. */
  readonly unjudged: number;
  readonly seeded: { readonly found: number; readonly total: number };
  readonly clean: { readonly passed: number; readonly total: number };
  /** Each coverage group, joined with "or", that no task of covers with a clean reference and a seeded control. */
  readonly uncovered: readonly string[];
  readonly controlsPass: boolean;
  readonly agreement: { readonly labeled: number; readonly scored: number; readonly rho: number | undefined };
  readonly agreementPass: boolean;
  readonly passed: boolean;
}

/** The results of `judge` under the current judge identity that still answer each control's current judge input. */
function currentResults(data: QualityCalibrationData, judge: RecordJudge): Map<string, typeof ControlResultSchema.Type> {
  const results = data.results.find((entry) => entry.judge.model === judge.model && entry.judge.effort === judge.effort && entry.identity === data.identity);
  const inputs = new Map(data.controls.map(({ id, input }) => [id, input]));
  return new Map(results?.controls.filter(({ id, input }) => inputs.get(id) === input).map((control) => [control.id, control]));
}

/** Evaluate `judge`'s calibration under the current judge identity. The agreement check reads the judge's recorded
 *  judged-quality scores of the labeled cells from `campaigns`. */
export function evaluateQualityCalibration(data: QualityCalibrationData, judge: RecordJudge, campaigns: readonly CampaignRecords[]): QualityCalibrationReport {
  const byId = currentResults(data, judge);
  const seeded = { found: 0, total: 0 };
  const clean = { passed: 0, total: 0 };
  let unjudged = 0;
  for (const control of data.controls) {
    const result = byId.get(control.id);
    if (control.seeded) seeded.total++;
    else clean.total++;
    if (!result) {
      unjudged++;
      continue;
    }
    if (control.seeded) seeded.found += Number(findsSeeded(result.findings, control.seeded));
    else clean.passed += Number(result.findings.every(({ severity }) => severity !== "major"));
  }
  const pairs = data.labels.flatMap((label) => {
    if (!label.findings) return [];
    const campaign = campaigns.find(({ header }) => header.persona === label.persona && header.stamp === label.stamp);
    const score = campaign ? qualityScoreOf(campaign, label, judge, data.identity) : undefined;
    return score ? [[judgedScore(score.score.findings), judgedScore(label.findings)] as const] : [];
  });
  const labeled = data.labels.filter(({ findings }) => findings !== undefined).length;
  const rho = spearman(pairs.map(([judged]) => judged), pairs.map(([, reference]) => reference));
  const covers = (task: string) => data.controls.some((control) => control.task === task && control.seeded === undefined)
    && data.controls.some((control) => control.task === task && control.seeded !== undefined);
  const uncovered = data.coverage.filter((group) => !group.some(covers)).map((group) => group.join(" or "));
  const controlsPass = uncovered.length === 0 && unjudged === 0 && seeded.total > 0 && clean.total > 0 && seeded.found >= SEEDED_RECALL * seeded.total && clean.passed >= CLEAN_SHARE * clean.total;
  const agreementPass = labeled >= LABELED_CELLS && pairs.length === labeled && rho !== undefined && rho >= MIN_AGREEMENT;
  return { judge, identity: data.identity, unjudged, seeded, clean, uncovered, controlsPass, agreement: { labeled, scored: pairs.length, rho }, agreementPass, passed: controlsPass && agreementPass };
}

/** The standing a ranking reads, with a one-line summary of the evidence. */
export function calibrationStanding(report: QualityCalibrationReport): QualityCalibrationStanding {
  const percent = (part: number, total: number) => `${part} of ${total}`;
  const controls = report.unjudged === report.seeded.total + report.clean.total
    ? `no control results under judge identity ${report.identity} (\`bun bench/ab-persona/bench.ts --calibrate --judge ${judgeLabel(report.judge)}\`)`
    : `seeded controls ${percent(report.seeded.found, report.seeded.total)} found, clean references ${percent(report.clean.passed, report.clean.total)} without a major finding${report.unjudged > 0 ? `, ${report.unjudged} controls not judged` : ""} (each needs 80%)`;
  const { labeled, scored, rho } = report.agreement;
  const agreement = rho === undefined || labeled < LABELED_CELLS || scored < labeled
    ? `reviewer agreement unavailable: ${labeled} of ${LABELED_CELLS} sampled cells labeled, ${scored} of them scored by the judge`
    : `reviewer agreement Spearman ${rho.toFixed(2)} over ${scored} cells (needs ${MIN_AGREEMENT.toFixed(2)})`;
  const coverage = report.uncovered.length > 0 ? `; no clean and seeded control of ${report.uncovered.join(", ")}` : "";
  return { passed: report.passed, summary: `${controls}${coverage}; ${agreement}` };
}

export interface CalibrateDeps {
  readonly catalog: BenchmarkCatalog;
  readonly judge: RecordJudge;
  /** Admits the judge, called only when a control is pending; its request evidence goes under `evidenceDirectory`. */
  readonly openJudge: (evidenceDirectory: string) => Promise<JudgeModel>;
  readonly signal?: AbortSignal;
}

/** Judge every control that `judge` has no current result of (under the current judge identity, for the control's
 *  current judge input), and write its results file after each success, so a stop keeps what it judged. A results file
 *  of an earlier identity is replaced, and a stale result of a control is dropped. Returns
 *  the results file, the local evidence folder, and the count of controls pending, judged, and failed. */
export async function calibrateQualityJudge(deps: CalibrateDeps): Promise<{ file: string; evidenceDirectory: string; pending: number; judged: number; failed: number }> {
  const { catalog, judge, signal } = deps;
  const directory = catalog.qualityCalibrationDir;
  const data = await loadQualityCalibration(catalog);
  const file = resultsFile(directory, judge);
  const results = currentResults(data, judge);
  const pending = data.controls.filter(({ id }) => !results.has(id));
  const evidenceDirectory = catalog.resultsDir("calibrate-quality", `${judgeFileName(judge)}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  const counts = { pending: pending.length, judged: 0, failed: 0 };
  if (pending.length === 0) return { file, evidenceDirectory, ...counts };
  const inputs = new Map(pending.map(({ task, judgeInput }) => [task, judgeInput]));
  const controls = new Map(pending.map((control) => [control.id, control]));
  const candidates = pending.map((control) => ({ variant: control.id, task: control.task, repeat: 0, summary: control.summary, diff: control.diff }));
  await mkdir(evidenceDirectory, { recursive: true });
  await mkdir(resultsDir(directory), { recursive: true });
  const attempts = createJsonLinesLedger(async () => join(evidenceDirectory, "judge-attempts.jsonl"), PersonaRecordSchemas.judgeAttempt, "reject");
  const model = await deps.openJudge(join(evidenceDirectory, "judge-requests"));
  await scoreImplementQuality(candidates, inputs, model, {
    ...(signal ? { signal } : {}),
    onAttempt: (report: JudgeAttemptReport) => attempts.append({
      kind: "judge-attempt", attemptId: crypto.randomUUID(), at: new Date().toISOString(), persona: "implementer", mode: "implement",
      score: report.score, terminal: report.terminal, accounting: report.accounting,
    } satisfies JudgeAttemptRecord),
    onSettled: async ({ value, error }) => {
      if (error !== null) {
        counts.failed++;
        return;
      }
      counts.judged++;
      // SAFETY: each candidate's variant is the id of one pending control.
      results.set(value.variant, { id: value.variant, input: controls.get(value.variant)!.input, findings: value.findings, scopeOk: value.scopeOk, discarded: value.discarded });
      const written: CalibrationResults = { judge: { model: judge.model, effort: judge.effort }, identity: data.identity, controls: [...results.values()].sort((a, b) => byCodeUnit(a.id, b.id)) };
      await writeFile(file, `${JSON.stringify(written, null, 2)}\n`);
    },
  });
  return { file, evidenceDirectory, ...counts };
}

/** A stratified sample of `count` current implementation cells of `persona` for reviewer labels: tasks take turns in
 *  id order, and each turn takes the task's cell whose setting the sample holds least, then by setting, campaign, and
 *  repeat. Each sampled cell keeps the labels that `existing` holds for it. */
export function sampleReviewerCells(input: RankingInput, persona: string, existing: readonly ReviewerLabel[], count = LABELED_CELLS): ReviewerLabel[] {
  const corpus = input.corpora.get(persona);
  const byTask = new Map<string, ReviewerLabel[]>();
  for (const campaign of input.campaigns.filter(({ header }) => header.persona === persona)) {
    for (const cell of campaign.cells) {
      if (cell.output.kind !== "implementation" || staleTask(cell, campaign, corpus) !== undefined) continue;
      byTask.set(cell.task, [...byTask.get(cell.task) ?? [], { persona, stamp: campaign.header.stamp, variant: cell.variant, task: cell.task, repeat: cell.repeat }]);
    }
  }
  const labels = new Map(existing.map((label) => [labelKey(label), label]));
  const settings = new Map<string, number>();
  const sample: ReviewerLabel[] = [];
  const tasks = [...byTask.keys()].sort(byCodeUnit);
  while (sample.length < count && [...byTask.values()].some((cells) => cells.length > 0)) {
    for (const task of tasks) {
      // SAFETY: `byTask` holds every id of `tasks`.
      const cells = byTask.get(task)!;
      if (sample.length >= count || cells.length === 0) continue;
      cells.sort((a, b) => (settings.get(a.variant) ?? 0) - (settings.get(b.variant) ?? 0) || byCodeUnit(a.variant, b.variant) || byCodeUnit(a.stamp, b.stamp) || a.repeat - b.repeat);
      // SAFETY: `cells` is not empty.
      const picked = cells.shift()!;
      settings.set(picked.variant, (settings.get(picked.variant) ?? 0) + 1);
      sample.push(labels.get(labelKey(picked)) ?? picked);
    }
  }
  return sample;
}

/** Write the reviewer-label file with `cells`. */
export async function writeReviewerLabels(directory: string, cells: readonly ReviewerLabel[]): Promise<string> {
  const file = join(directory, "reviewer-labels.json");
  await writeFile(file, `${JSON.stringify({ cells }, null, 2)}\n`);
  return file;
}
