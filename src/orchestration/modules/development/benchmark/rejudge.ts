import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { OwnedCommandRunner } from "../../../../infra/owned-command.js";
import type { JudgeSelection } from "./persona/benchmark-plan.js";
import { appendCampaignRecords, loadAllCampaignRecords, scoreLine, type CampaignRecords, type CellLine, type ScoreLine } from "./records/benchmark-records.js";
import { benchmarkMode, type BenchmarkCatalog, type ImplementTask, type ResearchTask, type ReviewTask } from "./catalog.js";
import { scoreImplementTraps } from "./scoring/implement-scoring.js";
import { qualityJudgeInput, qualityScoringVersion, scoreImplementQuality } from "./scoring/quality-judge.js";
import { createJsonLinesLedger } from "./campaign/json-lines.js";
import type { JudgeAttemptReport, JudgeModel } from "./scoring/judge.js";
import { planTasks, scoringVersion } from "./persona/persona-benchmark.js";
import { cellStanding, qualityScoreOf, rankingCorpus } from "./records/ranking-pool.js";
import { scoreResearch, snapshotLines } from "./scoring/research-scoring.js";
import { PersonaRecordSchemas, type JudgeAttemptRecord, type ScoreRecord } from "./scoring/run-store.js";
import { scoreReviews } from "./scoring/scoring.js";
import { withSnapshotWorkspace } from "./execution/snapshot-workspace.js";

// Rejudging scores recorded cells with another judge (ARCH-DIRECTORIES-020).
// It reads only record files, so it works on any clone: the cells whose task
// content is current and that the named judge has not scored under the current
// scoring contract go through the persona's own scorer, and each successful
// score is appended to its cell's record file as a new line beside every other
// judge's. An implementer cell also owes a judged-quality score under the
// current quality judge identity (ARCH-DIRECTORIES-026), which the same
// rejudge produces from the stored diff. Judge request evidence and judge
// accounting stay local, in a gitignored results folder, as for a campaign.

/** A recorded cell that the judge still owes a score: the persona's own score, or an implementer cell's judged quality. */
interface PendingRejudge {
  readonly campaign: CampaignRecords;
  readonly cell: CellLine;
  readonly scorer: "persona" | "quality";
}

/** The current cells of `persona`'s records that `judge` has not scored under the current scoring contract, and the
 *  current implementation cells that it has not given a judged-quality score under the current judge identity. */
async function pendingRejudge(catalog: BenchmarkCatalog, persona: string, judge: JudgeSelection): Promise<{ pending: readonly PendingRejudge[]; tasks: readonly (ResearchTask | ReviewTask | ImplementTask)[]; qualityVersion: string | undefined }> {
  const mode = benchmarkMode(persona);
  const tasks = await planTasks(persona, mode, catalog);
  const corpus = rankingCorpus(persona, mode, tasks);
  const version = scoringVersion(mode);
  const campaigns = (await loadAllCampaignRecords(catalog.recordsRoot)).filter(({ header }) => header.persona === persona);
  if (campaigns.length === 0) throw new Error(`No benchmark records for persona ${persona} in ${catalog.recordsRoot}`);
  const qualityVersion = mode === "implement" ? await qualityScoringVersion(await catalog.implementTasks()) : undefined;
  const pending = campaigns.flatMap((campaign) => campaign.cells.flatMap((cell): PendingRejudge[] => {
    const standing = cellStanding(cell, campaign, corpus, judge, version);
    const unscored = "reason" in standing && standing.unscored === true;
    const current = unscored || !("reason" in standing);
    return [
      ...unscored ? [{ campaign, cell, scorer: "persona" as const }] : [],
      ...qualityVersion !== undefined && current && cell.output.kind === "implementation" && qualityScoreOf(campaign, cell, judge, qualityVersion) === undefined ? [{ campaign, cell, scorer: "quality" as const }] : [],
    ];
  }));
  return { pending, tasks, qualityVersion };
}

export interface RejudgeDeps {
  readonly catalog: BenchmarkCatalog;
  readonly persona: string;
  readonly judge: JudgeSelection;
  /** Admits `judge`, called only when a cell is pending. The model's request evidence goes under
   *  `evidenceDirectory`; `runOwnedCommand` materializes a research task's pin for the citation check. */
  readonly openJudge: (evidenceDirectory: string) => Promise<{ model: JudgeModel; runOwnedCommand: OwnedCommandRunner }>;
  /** Count the pending cells and return before admission or any write. */
  readonly dryRun?: boolean;
  readonly signal?: AbortSignal;
}

/** Score every pending cell of `persona` with `judge`. Returns the local evidence folder, which is not created
 *  on a dry run or when no cell is pending, and the count of cells pending, scored, and failed; a failed call
 *  writes no score line, so the next rejudge retries it. */
export async function rejudgeRecords(deps: RejudgeDeps): Promise<{ evidenceDirectory: string; pending: number; scored: number; failed: number }> {
  const { catalog, persona, judge, signal } = deps;
  const { pending, tasks, qualityVersion } = await pendingRejudge(catalog, persona, judge);
  const mode = benchmarkMode(persona);
  const version = scoringVersion(mode);
  const evidenceDirectory = catalog.resultsDir(`rejudge-${persona}`, new Date().toISOString().replace(/[:.]/g, "-"));
  const counts = { pending: pending.length, scored: 0, failed: 0 };
  if (deps.dryRun || pending.length === 0) return { evidenceDirectory, ...counts };
  await mkdir(evidenceDirectory, { recursive: true });
  const attempts = createJsonLinesLedger(async () => join(evidenceDirectory, "judge-attempts.jsonl"), PersonaRecordSchemas.judgeAttempt, "reject");
  const qualityTasks = new Set(pending.flatMap(({ scorer, cell }) => scorer === "quality" ? [cell.task] : []));
  const qualityInputs = new Map(await Promise.all(tasks.flatMap((task) => qualityTasks.has(task.id) && "candidateIdentity" in task ? [qualityJudgeInput(task).then((input) => [task.id, input] as const)] : [])));
  const { model, runOwnedCommand } = await deps.openJudge(join(evidenceDirectory, "judge-requests"));
  const recordJudge = { model: judge.model, effort: judge.effort };
  for (const campaign of new Set(pending.map((entry) => entry.campaign))) {
    const own = pending.filter((entry) => entry.campaign === campaign);
    const cells = own.flatMap(({ scorer, cell }) => scorer === "persona" ? [cell] : []);
    const onAttempt = (report: JudgeAttemptReport): Promise<void> => attempts.append({
      kind: "judge-attempt", attemptId: crypto.randomUUID(), at: new Date().toISOString(), persona, mode,
      score: report.score, terminal: report.terminal, accounting: report.accounting,
    } satisfies JudgeAttemptRecord);
    const publishLine = async (error: string | null, line: () => ScoreLine): Promise<void> => {
      if (error !== null) {
        counts.failed++;
        return;
      }
      counts.scored++;
      await appendCampaignRecords(campaign.file, campaign.header, { scores: [line()] });
    };
    // SAFETY: `publish` receives only review, research, and trap score records, which scoreLine always converts.
    const publish = (error: string | null, record: ScoreRecord) => publishLine(error, () => scoreLine(record, judge, version)!);
    const options = { onAttempt, ...(signal ? { signal } : {}) };
    if (mode === "reviewer") {
      const manifests = new Map(tasks.flatMap((task) => "fixtureDir" in task ? [[task.id, task.manifest] as const] : []));
      await scoreReviews(cells.map((cell) => ({ variant: cell.variant, task: cell.task, repeat: cell.repeat, summary: text(cell) })), manifests, model, {
        ...options, onSettled: ({ value, error }) => publish(error, { kind: "review-score", mode: "reviewer", persona, error: null, score: value }),
      });
    } else if (mode === "research") {
      const researchTasks = tasks.filter((task): task is ResearchTask => "snapshot" in task);
      await scoreResearch(cells.map((cell) => ({ variant: cell.variant, task: cell.task, repeat: cell.repeat, summary: text(cell) })), researchTasks,
        (snapshot) => withSnapshotWorkspace(catalog.projectRoot, snapshot, runOwnedCommand, snapshotLines), model, {
          ...options, onSettled: ({ value, error }) => publish(error, { kind: "research-score", mode: "research", persona, error: null, score: value }),
        });
    } else {
      const manifests = new Map(tasks.flatMap((task) => "snapshot" in task || "fixtureDir" in task ? [] : [[task.id, task.manifest] as const]));
      await scoreImplementTraps(cells.map(implementCandidate), manifests, model, {
        ...options, onSettled: ({ value, error }) => publish(error, { kind: "trap-score", mode: "implement", persona, error: null, score: value }),
      });
      const judged = own.flatMap(({ scorer, cell }) => scorer === "quality" ? [implementCandidate(cell)] : []);
      // An implement persona always has a quality version; the guard narrows it.
      if (judged.length > 0 && qualityVersion !== undefined) {
        await scoreImplementQuality(judged, qualityInputs, model, {
          ...options, onSettled: ({ value, error }) => publishLine(error, () => ({ kind: "score", judge: recordJudge, scoringVersion: qualityVersion, scorer: "quality", score: value })),
        });
      }
    }
    if (signal?.aborted) break;
  }
  return { evidenceDirectory, ...counts };
}

function text(cell: CellLine): string {
  if (cell.output.kind !== "review" && cell.output.kind !== "answer") throw new Error(`Cell ${cell.variant} ${cell.task} #${cell.repeat} holds an implementation attempt, not text`);
  return cell.output.text;
}

function implementCandidate(cell: CellLine) {
  if (cell.output.kind !== "implementation") throw new Error(`Cell ${cell.variant} ${cell.task} #${cell.repeat} holds no implementation`);
  const { kind: _kind, ...output } = cell.output;
  return { variant: cell.variant, task: cell.task, repeat: cell.repeat, accounting: cell.accounting, durationMs: cell.durationMs, ...output };
}
