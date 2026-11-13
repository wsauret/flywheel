#!/usr/bin/env bun

import { realpath } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { createBenchmarkRuntime } from "../shared/runtime.js";
import type { JudgeAttemptReport, JudgeSettlement, JudgeVerdict } from "../../src/orchestration/modules/development/benchmark/judge.js";
import { createBenchmarkCatalog, type ImplementTask } from "../../src/orchestration/modules/development/benchmark/catalog.js";
import { IMPLEMENT_QUALITY_RUBRIC } from "../../src/infra/benchmark-rubrics.js";
import { implementQualityJudgeInputIdentity, judgeImplementPairs, type ImplementCandidate, type ImplementScore } from "../../src/orchestration/modules/development/benchmark/implement-scoring.js";
import { benchmarkTaskIdentity, structuredIdentity } from "../../src/orchestration/modules/development/benchmark/content-identity.js";
import { runGroups } from "../../src/orchestration/modules/development/benchmark/matrix-runner.js";
import {
  implementCandidate,
  openReadOnlyRunEvidence,
  type BenchmarkVariant,
  type ImplementRunRecord,
  type RunConfig,
} from "../../src/orchestration/modules/development/benchmark/run-store.js";
import {
  createCrossComparisonV2Store,
  type CrossComparisonV2Config,
  type CrossComparisonV2Store,
} from "../../src/orchestration/modules/development/benchmark/comparison-v2-store.js";
import { admitBenchmark } from "../../src/orchestration/modules/development/benchmark/admission.js";
import { codedRolePreference } from "../../src/orchestration/config/role-model-defaults.js";
import { formatAccountingObservation } from "../../src/orchestration/modules/development/benchmark/report-accounting.js";

/** The judge runs on the benchmark judge's coded OpenAI preference, whatever the role's order. */
const JUDGE_SEAT = codedRolePreference("benchmark-judge", "openai");

const JUDGE_SYSTEM_PROMPT = "";
const SCORING_VERSION = "cross-implement-v2";
const JUDGE_CONCURRENCY = 4;
type CrossComparisonV2JudgeAttemptRecord = Parameters<CrossComparisonV2Store["appendJudgeAttempt"]>[0];

interface CandidateArg {
  readonly directory: string;
  readonly variantId: string;
}

interface ParsedArgs {
  readonly candidates: readonly CandidateArg[];
  readonly results?: string;
  readonly resume?: string;
  readonly dryRun: boolean;
}

interface CandidateSource {
  readonly directory: string;
  readonly config: RunConfig;
  readonly variant: BenchmarkVariant;
  readonly label: string;
  readonly runs: readonly ImplementCandidate[];
  readonly trapScores: readonly ImplementScore[];
}

interface PairCell {
  readonly task: string;
  readonly repeat: number;
  readonly labelA: string;
  readonly labelB: string;
  readonly candidateA: ImplementCandidate;
  readonly candidateB: ImplementCandidate;
}

interface PairSettlement {
  readonly attempt: JudgeAttemptReport;
  readonly verdict?: JudgeVerdict;
  readonly error: string;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const candidates: CandidateArg[] = [];
  let results: string | undefined;
  let resume: string | undefined;
  let dryRun = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--candidate") {
      const directory = argv[++index];
      const variantId = argv[++index];
      if (!directory || !variantId) throw new Error("--candidate requires <results-dir> <variant-id>");
      candidates.push({ directory: resolve(directory), variantId });
    } else if (arg === "--results" || arg === "--resume") {
      const directory = argv[++index];
      if (!directory) throw new Error(`${arg} requires <comparison-dir>`);
      if (arg === "--results") results = resolve(directory);
      else resume = resolve(directory);
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (resume) {
    if (results || candidates.length > 0) throw new Error("--resume rejects --results and --candidate inputs");
  } else {
    if (!results) throw new Error("--results <comparison-dir> is required");
    if (candidates.length < 2) throw new Error("At least 2 --candidate values are required");
  }
  return { candidates, ...(results ? { results } : {}), ...(resume ? { resume } : {}), dryRun };
}

function cellKey(value: Pick<ImplementCandidate, "task" | "repeat">): string {
  return `${value.task}\u0000${value.repeat}`;
}

function pairKey(task: string, repeat: number, labelA: string, labelB: string): string {
  return `${task}\u0000${repeat}\u0000${[labelA, labelB].sort().join("\u0000")}`;
}

function isInside(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !path.startsWith(sep));
}

async function canonicalOutput(path: string, existing: boolean): Promise<string> {
  if (existing) return await realpath(path);
  return resolve(await realpath(dirname(path)), basename(path));
}

async function validateSeparation(output: string, sources: readonly string[], existing: boolean): Promise<string> {
  const canonicalOutputPath = await canonicalOutput(output, existing);
  for (const source of sources) {
    const canonicalSource = await realpath(source);
    if (isInside(canonicalSource, canonicalOutputPath) || isInside(canonicalOutputPath, canonicalSource)) {
      throw new Error(`Comparison output and source campaign must be separate: ${canonicalOutputPath} vs ${canonicalSource}`);
    }
  }
  return canonicalOutputPath;
}

async function loadCandidate(directory: string, variantId: string): Promise<Omit<CandidateSource, "label">> {
  const evidence = await openReadOnlyRunEvidence({ resultsRoot: dirname(directory), directory });
  const [config, allRuns, attempts, judgeAttempts, scores] = await Promise.all([
    evidence.loadConfig(),
    evidence.loadRuns(),
    evidence.loadAttempts(),
    evidence.loadJudgeAttempts(),
    evidence.loadScores(),
  ]);
  void attempts;
  void judgeAttempts;
  if (config.persona !== "implementer" || config.mode !== "implement") {
    throw new Error(`${directory} is not an implementer campaign`);
  }
  const variants = config.variants.filter((variant) => variant.id === variantId);
  if (variants.length !== 1) throw new Error(`${directory} must contain exactly one selected variant ${variantId}`);
  const variant = variants[0];
  if (!variant) throw new Error(`Missing selected variant ${variantId}`);
  const selectedRuns = allRuns.filter((run): run is ImplementRunRecord => run.mode === "implement" && run.variant === variantId);
  for (const run of selectedRuns) {
    if (run.persona !== "implementer" || run.model !== variant.model || run.effort !== variant.effort) {
      throw new Error(`Run metadata does not match selected variant ${variantId}`);
    }
  }
  const trapScores = scores
    .filter((record) => record.kind === "trap-score")
    .filter((record) => record.score.variant === variantId)
    .map((record) => record.score);
  const trapKeys = trapScores.map(cellKey);
  if (new Set(trapKeys).size !== trapKeys.length) throw new Error(`Duplicate trap scores for ${variantId}`);
  return {
    directory: evidence.directory,
    config,
    variant,
    runs: selectedRuns.map(implementCandidate),
    trapScores,
  };
}

function assignLabels(sources: readonly Omit<CandidateSource, "label">[]): CandidateSource[] {
  const idCounts = new Map<string, number>();
  for (const source of sources) idCounts.set(source.variant.id, (idCounts.get(source.variant.id) ?? 0) + 1);
  const preliminary = sources.map((source) => ({
    ...source,
    label: idCounts.get(source.variant.id) === 1
      ? source.variant.id
      : `${source.variant.id}[${basename(source.directory)}]`,
  }));
  const labelCounts = new Map<string, number>();
  for (const source of preliminary) labelCounts.set(source.label, (labelCounts.get(source.label) ?? 0) + 1);
  const labeled = preliminary.map((source) => ({
    ...source,
    label: labelCounts.get(source.label) === 1
      ? source.label
      : `${source.label}#${structuredIdentity({ config: source.config, variant: source.variant }).slice(0, 12)}`,
  }));
  if (new Set(labeled.map((source) => source.label)).size !== labeled.length) {
    throw new Error("Candidate identities are duplicated and cannot produce unique stable labels");
  }
  return labeled;
}

function validateSources(sources: readonly CandidateSource[], currentTaskIdentity: string, tasks: readonly ImplementTask[]): void {
  const first = sources[0];
  if (!first) throw new Error("At least 2 candidates are required");
  const expected = new Set<string>();
  for (const task of tasks) {
    for (let repeat = 0; repeat < first.config.repeats; repeat++) expected.add(`${task.id}\u0000${repeat}`);
  }
  for (const source of sources) {
    if (source.config.persona !== "implementer") throw new Error("Every source persona must be implementer");
    if (source.config.taskIdentity !== first.config.taskIdentity) throw new Error("Source taskIdentity values differ");
    if (source.config.personaGuidanceIdentity !== first.config.personaGuidanceIdentity) throw new Error("Source personaGuidanceIdentity values differ");
    if (source.config.repeats !== first.config.repeats) throw new Error("Source repeat counts differ");
    if (source.config.taskIdentity !== currentTaskIdentity) throw new Error("Source taskIdentity does not match the current implement task corpus");
    const runCells = source.runs.map(cellKey);
    const trapCells = source.trapScores.map(cellKey);
    if (new Set(runCells).size !== runCells.length) throw new Error(`Duplicate completed cells for ${source.label}`);
    if (runCells.length !== expected.size || runCells.some((cell) => !expected.has(cell))) {
      throw new Error(`Source ${source.label} does not contain the complete task/repeat cell set`);
    }
    if (trapCells.length !== expected.size || trapCells.some((cell) => !expected.has(cell))) {
      throw new Error(`Source ${source.label} does not contain the complete trap-score cell set`);
    }
    const manifests = new Map(tasks.map((task) => [task.id, new Set(task.manifest.traps.map((trap) => trap.id))]));
    for (const score of source.trapScores) {
      const expectedTraps = manifests.get(score.task);
      const actual = score.traps.map((trap) => trap.id);
      if (!expectedTraps || actual.length !== expectedTraps.size || new Set(actual).size !== actual.length || actual.some((id) => !expectedTraps.has(id))) {
        throw new Error(`Source ${source.label} trap score does not exactly match the current manifest for ${score.task}`);
      }
    }
  }
}

function buildPairs(sources: readonly CandidateSource[]): PairCell[] {
  const pairs: PairCell[] = [];
  for (let left = 0; left < sources.length; left++) {
    const sourceA = sources[left];
    if (!sourceA) continue;
    const cellsA = new Map(sourceA.runs.map((run) => [cellKey(run), run]));
    for (let right = left + 1; right < sources.length; right++) {
      const sourceB = sources[right];
      if (!sourceB) continue;
      for (const candidateB of sourceB.runs) {
        const candidateA = cellsA.get(cellKey(candidateB));
        if (!candidateA) throw new Error(`Missing complete cell ${cellKey(candidateB)}`);
        pairs.push({
          task: candidateB.task,
          repeat: candidateB.repeat,
          labelA: sourceA.label,
          labelB: sourceB.label,
          candidateA: { ...candidateA, variant: sourceA.label },
          candidateB: { ...candidateB, variant: sourceB.label },
        });
      }
    }
  }
  return pairs.sort((a, b) => pairKey(a.task, a.repeat, a.labelA, a.labelB).localeCompare(pairKey(b.task, b.repeat, b.labelA, b.labelB)));
}

function average(values: readonly number[]): string {
  return (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1);
}

function report(sources: readonly CandidateSource[], verdicts: readonly JudgeVerdict[], attempts: readonly CrossComparisonV2JudgeAttemptRecord[]): string {
  const standings = sources.map((source) => {
    const relevant = verdicts.filter((verdict) => verdict.slotA === source.label || verdict.slotB === source.label);
    return {
      source,
      wins: relevant.filter((verdict) => verdict.winner === source.label).length,
      losses: relevant.filter((verdict) => verdict.winner !== source.label && verdict.winner !== "tie").length,
      ties: relevant.filter((verdict) => verdict.winner === "tie").length,
    };
  }).sort((a, b) => b.wins - a.wins || a.losses - b.losses || b.ties - a.ties || a.source.label.localeCompare(b.source.label));
  const rows = standings.map(({ source, wins, losses, ties }, index) => {
    const acceptancePassed = source.runs.reduce((sum, run) => sum + run.acceptancePassed, 0);
    const acceptanceTotal = source.runs.reduce((sum, run) => sum + run.acceptanceTotal, 0);
    const traps = ["self-corrected", "followed-blindly", "silently-lucky", "unclear"].map((outcome) =>
      source.trapScores.reduce((sum, score) => sum + score.traps.filter((trap) => trap.outcome === outcome).length, 0));
    const accounting = source.runs.map((run) => run.accounting);
    return `| ${index + 1} | ${source.label.replaceAll("|", "\\|")} | ${source.variant.id.replaceAll("|", "\\|")} | ${acceptancePassed}/${acceptanceTotal} | ${traps.join(" | ")} | ${wins}-${losses}-${ties} | ${formatAccountingObservation(accounting, "estimatedUsd", "total")} | ${formatAccountingObservation(accounting, "billedUsd", "total")} | ${formatAccountingObservation(accounting, "tokens", "total")} | ${average(source.runs.map((run) => run.durationMs))} | ${average(source.runs.map((run) => run.linesAdded))} | ${average(source.runs.map((run) => run.linesRemoved))} | ${average(source.runs.map((run) => run.filesTouched))} |`;
  });
  const judgeAccounting = attempts.map((attempt) => attempt.accounting);
  const failed = attempts.length - verdicts.length;
  return [
    "# Implementer candidate comparison",
    "",
    "| Rank | Candidate | Variant | Acceptance | Self-corrected | Followed blindly | Silently lucky | Unclear | W-L-T | Estimated | Billed | Tokens | Latency ms | Lines + | Lines - | Files |",
    "|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ...rows,
    "",
    `Judge attempts: ${attempts.length}; failed: ${failed}; estimated equivalent: ${formatAccountingObservation(judgeAccounting, "estimatedUsd", "total")}; billed: ${formatAccountingObservation(judgeAccounting, "billedUsd", "total")}; tokens: ${formatAccountingObservation(judgeAccounting, "tokens", "total")}.`,
    "",
    "| Task | Repeat | Candidate A | Candidate B | Winner | Rationale |",
    "|---|---:|---|---|---|---|",
    ...verdicts
      .slice()
      .sort((a, b) => pairKey(a.task, a.repeat, a.slotA, a.slotB).localeCompare(pairKey(b.task, b.repeat, b.slotA, b.slotB)))
      .map((verdict) => `| ${verdict.task.replaceAll("|", "\\|")} | ${verdict.repeat} | ${verdict.slotA.replaceAll("|", "\\|")} | ${verdict.slotB.replaceAll("|", "\\|")} | ${verdict.winner.replaceAll("|", "\\|")} | ${verdict.rationale.replaceAll("|", "\\|").replaceAll("\n", " ")} |`),
    "",
  ].join("\n");
}

export interface CompareCliDeps {
  readonly createRuntime: typeof createBenchmarkRuntime;
  readonly admitModels: typeof admitBenchmark;
  readonly createComparisonStore: typeof createCrossComparisonV2Store;
  readonly signal?: AbortSignal;
}

const PRODUCTION_DEPS: CompareCliDeps = {
  createRuntime: createBenchmarkRuntime,
  admitModels: admitBenchmark,
  createComparisonStore: createCrossComparisonV2Store,
};

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  projectRoot = resolve(import.meta.dir, "../.."),
  deps: CompareCliDeps = PRODUCTION_DEPS,
): Promise<void> {
  const args = parseArgs(argv);
  let persisted: CrossComparisonV2Config | undefined;
  let candidateArgs = args.candidates;
  if (args.resume) {
    const resumeStore = await deps.createComparisonStore({ resultsRoot: dirname(args.resume), directory: args.resume });
    persisted = await resumeStore.loadConfig();
    candidateArgs = persisted.sources.map((source) => ({ directory: source.directory, variantId: source.variant.id }));
  }
  const loaded = await Promise.all(candidateArgs.map((candidate) => loadCandidate(candidate.directory, candidate.variantId)));
  const sources = assignLabels(loaded);
  if (sources.length < 2) throw new Error("At least 2 candidates are required");
  const outputArg = args.resume ?? args.results;
  if (!outputArg) throw new Error("Comparison output is required");
  const output = await validateSeparation(outputArg, sources.map((source) => source.directory), args.resume !== undefined);
  const catalog = createBenchmarkCatalog(projectRoot);
  const tasks = await catalog.implementTasks();
  const taskIdentity = benchmarkTaskIdentity(tasks);
  validateSources(sources, taskIdentity, tasks);
  const pairs = buildPairs(sources);
  console.error(`${sources.length} candidates, ${pairs.length} pairwise task/repeat judgments.`);

  await using runtime = await deps.createRuntime(projectRoot);
  const admission = await deps.admitModels({
    ...runtime.deps,
    profileId: runtime.profileId,
    authorityIncarnation: runtime.usageAuthority.authorityIncarnation,
    launcher: runtime.launcher,
    background: runtime.background,
    foregroundBashHold: runtime.foregroundBashHold,
    shell: runtime.shell,
  }, [{ role: "judge", ...JUDGE_SEAT }]);
  const configBody = {
    sources: sources.map((source) => ({
      directory: source.directory,
      configIdentity: structuredIdentity(source.config),
      campaign: source.config.identity,
      variant: source.variant,
      label: source.label,
    })),
    candidatePairs: pairs.map((pair) => ({
      task: pair.task,
      repeat: pair.repeat,
      labelA: pair.labelA,
      labelB: pair.labelB,
      candidateAIdentity: structuredIdentity(pair.candidateA),
      candidateBIdentity: structuredIdentity(pair.candidateB),
    })),
    taskIdentity,
    personaGuidanceIdentity: sources[0]?.config.personaGuidanceIdentity ?? "",
    judgeModel: JUDGE_SEAT.model,
    judgeRubricIdentity: structuredIdentity(IMPLEMENT_QUALITY_RUBRIC),
    scoringVersion: SCORING_VERSION,
    judge: {
      profileId: runtime.usageAuthority.profileId,
      authorityIncarnation: runtime.usageAuthority.authorityIncarnation,
      contentIdentity: structuredIdentity({
        model: JUDGE_SEAT.model,
        systemPrompt: JUDGE_SYSTEM_PROMPT,
        qualityInput: implementQualityJudgeInputIdentity(tasks),
        rubric: IMPLEMENT_QUALITY_RUBRIC,
        scoringVersion: SCORING_VERSION,
      }),
    },
  };
  const config: CrossComparisonV2Config = {
    kind: "cross-comparison-config-v2",
    identity: structuredIdentity(configBody),
    ...configBody,
  };
  if (persisted && JSON.stringify(persisted) !== JSON.stringify(config)) {
    throw new Error("Persisted comparison config does not match current source, corpus, profile, or scoring identity");
  }
  if (args.dryRun) return;

  const store = args.resume
    ? await deps.createComparisonStore({ resultsRoot: dirname(output), directory: output })
    : await deps.createComparisonStore({ resultsRoot: dirname(output), directory: output }, config);
  const { scores: scoreRows } = await store.loadEvidence();
  const successful = new Set(scoreRows.map((row) => pairKey(row.verdict.task, row.verdict.repeat, row.verdict.slotA, row.verdict.slotB)));
  const missing = pairs.filter((pair) => !successful.has(pairKey(pair.task, pair.repeat, pair.labelA, pair.labelB)));
  const judge = await admission.createJudge(JUDGE_SEAT.model, JUDGE_SYSTEM_PROMPT, JUDGE_SEAT.effort, join(output, "judge-requests"));
  await runGroups(
    missing.map((pair) => [pair]),
    async (pair): Promise<PairSettlement> => {
      let attempt: JudgeAttemptReport | undefined;
      let settlement: JudgeSettlement<JudgeVerdict> | undefined;
      const verdicts = await judgeImplementPairs(
        [pair.candidateA, pair.candidateB],
        tasks.filter((task) => task.id === pair.task),
        judge,
        undefined,
        {
          onAttempt: async (value) => { attempt = value; },
          onSettled: async (value) => { settlement = value; },
          signal: deps.signal,
        },
      );
      const verdict = verdicts[0];
      if (!attempt) throw new Error(`Judge did not account for ${pairKey(pair.task, pair.repeat, pair.labelA, pair.labelB)}`);
      if (!settlement || !verdict) {
        return { attempt, error: settlement?.error ?? `Judge ${attempt.terminal}` };
      }
      return settlement.error === null
        ? { verdict, attempt, error: "" }
        : { attempt, error: settlement.error };
    },
    async (pair, result) => {
      const score = result.attempt.score;
      if (
        score.kind !== "pair-score"
        || pairKey(score.task, score.repeat, score.slotA, score.slotB)
          !== pairKey(pair.task, pair.repeat, pair.labelA, pair.labelB)
      ) {
        throw new Error(`Judge attempt did not identify the configured pair ${pairKey(pair.task, pair.repeat, pair.labelA, pair.labelB)}`);
      }
      const attemptId = crypto.randomUUID();
      await store.appendJudgeAttempt({
        kind: "cross-judge-attempt-v2",
        comparisonIdentity: config.identity,
        attemptId,
        at: new Date().toISOString(),
        score: {
          task: score.task,
          repeat: score.repeat,
          slotA: score.slotA,
          slotB: score.slotB,
        },
        terminal: result.attempt.terminal,
        accounting: result.attempt.accounting,
      });
      if (result.verdict) {
        await store.appendScore({
          kind: "cross-pair-score-v2",
          comparisonIdentity: config.identity,
          attemptId,
          verdict: result.verdict,
        });
        return;
      }
      throw new Error(result.error);
    },
    async (pair, error) => {
      throw new Error(`Comparison judge failed for ${pairKey(pair.task, pair.repeat, pair.labelA, pair.labelB)}`, { cause: error });
    },
    deps.signal,
    JUDGE_CONCURRENCY,
  );
  const evidence = await store.loadEvidence();
  const text = report(sources, evidence.scores.map((row) => row.verdict), evidence.attempts);
  await store.writeReport(text);
  console.error(`Report: ${resolve(output, "report.md")}`);
  console.log(text);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
