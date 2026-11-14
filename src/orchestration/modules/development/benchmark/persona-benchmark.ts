import { cp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { AgentDefinition } from "../../../../infra/agent-definition.js";
import type { OwnedCommandRunner } from "../../../../infra/owned-command.js";
import { loadStandalonePersonaRegistry } from "../../../../workflows/agents/registry.js";
import { benchmarkMode, RESEARCH_TASKS_CHANGED, type BenchmarkCatalog, type BenchmarkMode, type ImplementTask, type ResearchTask, type ReviewTask } from "./catalog.js";
import { captureImplementation, provisionTaskSandbox } from "./implement-task.js";
import { withSnapshotWorkspace, withTrialWorkspace } from "./snapshot-workspace.js";
import { materializeReviewSandbox } from "./review-sandbox.js";
import { buildImplementRawResults, judgeImplementPairs, renderImplementReport, scoreImplementTraps, type ImplementCandidate } from "./implement-scoring.js";
import type { JudgeAttemptReport, JudgeModel, JudgeVerdict } from "./judge.js";
import { judgeOverhead, renderReport, renderReviewReport, sourceReport, unsuccessfulOverhead, type ReportCounts } from "./reports.js";
import { scoreReviews } from "./scoring.js";
import { judgeResearchCampaign, snapshotLines } from "./research-scoring.js";
import { asPersonaTaskFailure, PersonaTaskFailure, renderPersonaTaskGuidance, runPersonaTask, type BenchmarkRuntime, type PersonaDefinition, type PersonaRunOutcome, type PersonaTaskRequest } from "./persona-run.js";
import {
  implementCandidate,
  judgeScoreIdentityKey,
  runKey,
  scoreRecordIdentityKey,
  type AgentRunRecord,
  type AttemptRecord,
  type JudgeAttemptRecord,
  type BenchmarkVariant,
  type ImplementRunRecord,
  type RunConfig,
  type RunStore,
} from "./run-store.js";
import { failedJudgeCallCount } from "./judge-attempt-reconciliation.js";
import { parseVariant, sameVariants, type VariantSpec } from "./variant.js";
import { personaToolEntries, toolRegistryFromComposition } from "../../../agent-runtime/tools/tool-registry.js";
import { DEFAULT_BENCHMARK_CONCURRENCY, runGroups } from "./matrix-runner.js";
import { benchmarkTaskIdentity, structuredIdentity } from "./content-identity.js";
import type { BenchmarkAccounting } from "./evidence.js";
import { validateAttempts, validateJudgeAttempts, validateRuns, validateScores } from "./persona-evidence-validation.js";
import { createNativePersonaInvocation } from "./native-persona-invocation.js";
import { IMPLEMENT_TRANSCRIPT_FILE, retainImplementStore } from "./implement-evidence.js";
import { createPersonaStore } from "./persona-store.js";
import { exportCampaignRecords, isScoredAttempt } from "./benchmark-records.js";
import type { JudgeSelection } from "./admission.js";

/** The scoring contract a campaign was judged under. Reviewer campaigns moved
 *  to persona-v3 when the judge began counting unsupported P1/P2 findings; a
 *  persona-v2 reviewer campaign stays readable through its report but cannot
 *  be resumed or rescored into the new contract. A ranking and a rejudge pool only scores of this contract. */
export function scoringVersion(mode: BenchmarkMode): string {
  return mode === "reviewer" ? "persona-v3" : "persona-v2";
}
const JUDGE_IDENTITY_INPUT = {
  role: "benchmark-judge",
  qualityRubric: "factual grounding with file:line citations, completeness, and concision",
  implementationQualityRubric: "smallest correct change with functional correctness judged separately",
};

type BenchmarkOperation = "run" | "resume" | "rescore";

/** What a caller asks for. Every field a stored results directory already
 *  answers is optional here, so a resume names only the directory. */
export interface BenchmarkOptions {
  persona?: string;
  variants: readonly VariantSpec[];
  repeats?: number;
  operation: BenchmarkOperation;
  resultsDir?: string;
  taskIds?: readonly string[];
  /** Pins the judge instead of the profile's judge role. */
  judge?: JudgeSelection;
}

/** A settled request: every seat, task and path the run will use. */
export interface BenchmarkPlan {
  persona: string;
  mode: BenchmarkMode;
  variants: readonly (Pick<VariantSpec, "id"> & Partial<Pick<VariantSpec, "model" | "effort">>)[];
  repeats: number;
  stamp: string;
  resultsDir: string;
  operation: BenchmarkOperation;
  tasks: readonly PlannedTask[];
  taskIds?: readonly string[];
  /** The pinned judge: the request's pin, or the judge a resumed campaign recorded. */
  judge?: JudgeSelection;
}

type PlannedTask = ResearchTask | ReviewTask | ImplementTask;

interface BenchmarkCellId {
  variant: string;
  task: string;
  repeat: number;
}

/** Everything an observer can learn while a benchmark runs. The service never
 *  writes to a terminal: a CLI renders these, and an embedded caller records
 *  them. A run emits exactly one terminal event, `benchmark.completed` or
 *  `benchmark.cancelled`, after every cell, judge call and command it owns has
 *  settled. */
export type BenchmarkEvent =
  | { kind: "benchmark.started"; resultsDir: string; pendingCells: number }
  | { kind: "cell.started"; cell: BenchmarkCellId }
  | { kind: "cell.completed"; cell: BenchmarkCellId; accounting: BenchmarkAccounting; durationMs: number; acceptance?: { passed: number; total: number } }
  | { kind: "cell.failed"; cell: BenchmarkCellId; message: string }
  | { kind: "scoring.started"; phase: "traps" | "pairs" | "reviews" | "answer-keys" }
  | { kind: "scoring.skipped"; phase: "pairs"; reason: string }
  | { kind: "benchmark.completed"; resultsDir: string; reportPath: string; report: string; counts: ReportCounts }
  | { kind: "benchmark.cancelled"; resultsDir: string };

export type BenchmarkOutcome =
  | { status: "completed"; resultsDir: string; reportPath: string; report: string; counts: ReportCounts }
  | { status: "cancelled"; resultsDir: string };

/** What the service is given rather than what it builds: it creates no runtime,
 *  resolves no credentials, and reads no argv. */
export interface PersonaBenchmarkDeps {
  readonly runtime: BenchmarkRuntime;
  readonly catalog: BenchmarkCatalog;
  readonly createJudge: (evidenceDirectory?: string) => Promise<JudgeModel>;
  /** The resolved model and effort every judge call uses, from `personaCampaignJudge`.
   *  It is part of the campaign identity, so a resume or rescore under another judge refuses. */
  readonly judge?: JudgeSelection;
  readonly onEvent: (event: BenchmarkEvent) => void;
  readonly signal?: AbortSignal;
  /** The identity of the Flywheel source that runs this process's candidates, from `runningSourceIdentity`.
   *  Each cell records it, and the report names every source that ran cells. It is not part of the campaign
   *  identity, so a resume after an unrelated source change continues the campaign. ARCH-DIRECTORIES-018. */
  readonly sourceIdentity: string;
  /** Native candidates must execute behind actor confinement. The parent still provisions and grades their work. */
  readonly nativeInvocation?: {
    readonly sourceIdentity: string;
    /** `path` lists the task's toolchain directories, relative to the workspace, that lead the candidate's PATH. */
    run(request: PersonaTaskRequest, path: readonly string[]): Promise<PersonaRunOutcome>;
  };
}

interface CellRunResult extends BenchmarkCellId {
  accounting: BenchmarkAccounting;
  durationMs: number;
  summary: string;
}

interface BenchmarkCell {
  variant: BenchmarkPlan["variants"][number];
  task: PlannedTask;
  repeat: number;
}

interface CommandScope {
  readonly run: OwnedCommandRunner;
  /** Resolves when every command this scope started has settled. */
  settle(): Promise<void>;
}

/** Every auxiliary command a run launches, tracked so cancellation settles:
 *  after the signal fires no new command starts, and the terminal event waits
 *  for the commands already in flight. */
function createCommandScope(run: OwnedCommandRunner, signal?: AbortSignal): CommandScope {
  const active = new Set<Promise<unknown>>();
  return {
    run(command, options) {
      if (signal?.aborted) return Promise.reject(new Error(`${command.join(" ")} was not started: the benchmark was cancelled`));
      // Every command carries the run's signal, so a stop ends the container
      // instead of leaving it to its own timeout.
      const pending = run(command, signal ? { ...options, signal } : options);
      const tracked = pending.catch(() => undefined);
      active.add(tracked);
      void tracked.finally(() => active.delete(tracked));
      return pending;
    },
    async settle() {
      while (active.size > 0) await Promise.all(active);
    },
  };
}

function parseStoredVariant(variant: BenchmarkVariant): BenchmarkPlan["variants"][number] {
  if (variant.model === undefined && variant.effort === undefined && variant.id === "profile") return { id: "profile" };
  // Remove after 2027-10-16: previous campaigns retain their concrete seats as authored run settings.
  const parsed = parseVariant(`${variant.model}:${variant.effort}`);
  if (parsed.id !== variant.id) throw new Error(`Run config variant ID ${variant.id} does not match ${parsed.id}`);
  return parsed;
}

/** Every current catalog task of a persona. */
export async function planTasks(persona: string, mode: BenchmarkMode, catalog: BenchmarkCatalog): Promise<readonly PlannedTask[]> {
  if (mode === "reviewer") {
    const tasks = await catalog.reviewTasks(persona);
    if (tasks.length === 0) throw new Error(`No review fixtures for ${persona} found in ${catalog.reviewFixturesDir}`);
    return tasks;
  }
  if (mode === "implement") return await catalog.implementTasks();
  return await catalog.researchTasks(persona);
}

function selectTasks(tasks: readonly PlannedTask[], taskIds?: readonly string[]): readonly PlannedTask[] {
  if (!taskIds?.length) return tasks;
  for (const id of taskIds) {
    if (!tasks.some(task => task.id === id)) throw new Error(`Unknown task ID: ${id}`);
  }
  return tasks.filter(task => taskIds.includes(task.id));
}

/** Settle a request against the results directory it names, so a resume can
 *  never silently mix a different persona, seat list or repeat count into
 *  existing results. */
export async function planPersonaBenchmark(options: BenchmarkOptions, catalog: BenchmarkCatalog): Promise<BenchmarkPlan> {
  const existing = options.resultsDir ? await createPersonaStore({ resultsRoot: catalog.resultsRoot, directory: options.resultsDir }) : undefined;
  const stored = await existing?.loadConfig();
  if (stored && options.persona !== undefined && options.persona !== stored.persona) {
    throw new Error(`Results persona ${stored.persona} conflicts with --persona ${options.persona}`);
  }
  const persona = options.persona ?? stored?.persona ?? "explorer";
  const variants = options.variants.length > 0
    ? options.variants
    : stored
      ? stored.variants.map(parseStoredVariant)
      : [{ id: "profile" }];
  if (stored && options.variants.length > 0 && !sameVariants(variants, stored.variants)) {
    throw new Error(`Results variants ${stored.variants.map((variant) => variant.id).join(", ")} conflict with --variant arguments ${variants.map((variant) => variant.id).join(", ")}`);
  }
  if (stored && options.repeats !== undefined && options.repeats !== stored.repeats) {
    throw new Error(`Results repeats ${stored.repeats} conflict with --repeats ${options.repeats}`);
  }
  if (stored?.judge && options.judge && (options.judge.model !== stored.judge.model || options.judge.effort !== stored.judge.effort)) {
    throw new Error(`Results judge ${stored.judge.model}:${stored.judge.effort} conflicts with --judge ${options.judge.model}:${options.judge.effort}; to score this campaign's cells with another judge, run --rejudge ${stored.persona} --judge ${options.judge.model}:${options.judge.effort}`);
  }
  const judge = options.judge ?? stored?.judge;
  const repeats = options.repeats ?? stored?.repeats ?? 1;
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error(`Repeats must be a positive integer, got ${repeats}`);
  const mode = benchmarkMode(persona);
  if (new Set(variants.map((variant) => variant.id)).size !== variants.length) throw new Error("Variants must differ");
  const stamp = stored?.stamp ?? new Date().toISOString().replace(/[:.]/g, "-");
  return {
    persona,
    mode,
    variants,
    repeats,
    stamp,
    resultsDir: options.resultsDir ?? catalog.resultsDir(persona, stamp),
    operation: options.operation,
    tasks: selectTasks(await planTasks(persona, mode, catalog), options.taskIds ?? existing?.taskIds),
    ...(options.taskIds?.length || existing ? { taskIds: options.taskIds ?? existing?.taskIds } : {}),
    ...(judge ? { judge: { model: judge.model, effort: judge.effort } } : {}),
  };
}


/** Whether a campaign calls a judge: every one except a solo research seat
 *  whose tasks have no answer key, which has nothing to compare or score. */
export function campaignJudges(plan: Pick<BenchmarkPlan, "mode" | "variants" | "tasks">): boolean {
  return plan.mode !== "research" || plan.variants.length >= 2 || plan.tasks.some((task) => "answerKey" in task && task.answerKey !== undefined);
}

function isResearchTask(task: PlannedTask): task is ResearchTask {
  return "snapshot" in task;
}

function isReviewTask(task: PlannedTask): task is ReviewTask {
  return "fixtureDir" in task;
}

function isImplementTask(task: PlannedTask): task is ImplementTask {
  return "acceptanceDir" in task || ("kind" in task && task.kind === "native");
}

function isImplementCandidate(result: CellRunResult | ImplementCandidate): result is ImplementCandidate {
  return "diff" in result;
}

function toRunResult(run: AgentRunRecord): CellRunResult {
  return {
    variant: run.variant,
    task: run.task,
    repeat: run.repeat,
    accounting: run.accounting,
    durationMs: run.durationMs,
    summary: run.summary,
  };
}

function pendingGroups(plan: BenchmarkPlan, completed: ReadonlySet<string>): readonly (readonly BenchmarkCell[])[] {
  const groups: BenchmarkCell[][] = [];
  for (const variant of plan.variants) {
    const lane: BenchmarkCell[] = [];
    for (let repeat = 0; repeat < plan.repeats; repeat++) {
      for (const task of plan.tasks) {
        if (!completed.has(runKey({ variant: variant.id, task: task.id, repeat }))) lane.push({ variant, task, repeat });
      }
    }
    if (lane.length > 0) groups.push(lane);
  }
  return groups;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One row of the judge accounting ledger. Every logical judge call gets one,
 *  whether or not it produced a score. */
function judgeAttemptRecord(plan: BenchmarkPlan, report: JudgeAttemptReport): JudgeAttemptRecord {
  return {
    kind: "judge-attempt",
    attemptId: crypto.randomUUID(),
    at: new Date().toISOString(),
    persona: plan.persona,
    mode: plan.mode,
    score: report.score,
    terminal: report.terminal,
    accounting: report.accounting,
  };
}

/** Reads the same persona definition and role for preflight and candidate execution. */
export async function loadBenchmarkPersona(plan: BenchmarkPlan, catalog: BenchmarkCatalog, deps: Pick<BenchmarkRuntime, "definitions" | "moduleSelection">): Promise<{ persona: PersonaDefinition; registry: ReadonlyMap<string, AgentDefinition> }> {
  const registry = loadStandalonePersonaRegistry(catalog.personaDefinitionsDir, deps.definitions.skills(), personaToolEntries(toolRegistryFromComposition(deps.moduleSelection())), undefined, catalog.personaOverlayDir);
  const persona = registry.get(plan.persona);
  if (!persona || persona.kind !== "persona") throw new Error(`The ${plan.persona} persona did not load`);
  return { persona, registry };
}

export async function runPersonaBenchmark(plan: BenchmarkPlan, deps: PersonaBenchmarkDeps): Promise<BenchmarkOutcome> {
  const { catalog, onEvent, signal } = deps;
  const taskIdentity = benchmarkTaskIdentity(plan.tasks);
  if (benchmarkTaskIdentity(selectTasks(await planTasks(plan.persona, plan.mode, catalog), plan.taskIds)) !== taskIdentity) {
    throw new Error("Benchmark task content changed after planning");
  }
  const location = { resultsRoot: catalog.resultsRoot, directory: plan.resultsDir };
  const existingStore = plan.operation === "run" ? undefined : await createPersonaStore(location);
  const stored = await existingStore?.loadConfig();
  const runRecords = await existingStore?.loadRuns() ?? [];
  // A scored attempt (an implementer cell at its time limit) is complete, as its record is.
  const groups = plan.operation === "rescore" ? [] : pendingGroups(plan, new Set([...runRecords, ...(await existingStore?.loadAttempts() ?? []).filter(isScoredAttempt)].map(runKey)));
  const nativeTasks = plan.tasks.some(task => "kind" in task && task.kind === "native");
  const pendingNative = groups.some(group => group.some(cell => "kind" in cell.task && cell.task.kind === "native"));
  const nativeInvocation = deps.nativeInvocation ?? (pendingNative ? await createNativePersonaInvocation(deps.runtime, catalog) : undefined);
  const resolvedDeps = { ...deps, ...(nativeInvocation ? { nativeInvocation } : {}) };
  const { persona, registry } = await loadBenchmarkPersona(plan, catalog, deps.runtime);
  const profileId = deps.runtime.profileId;
  const authorityIncarnation = deps.runtime.authorityIncarnation;
  if (!profileId || !authorityIncarnation) throw new Error("Persona benchmark requires an exact profile ID and Usage-authority incarnation");
  const personaGuidanceIdentity = structuredIdentity(renderPersonaTaskGuidance(persona, registry, deps.runtime));
  const campaignScoringVersion = scoringVersion(plan.mode);
  if (stored && stored.scoringVersion !== campaignScoringVersion) {
    throw new Error(`These results were scored under ${stored.scoringVersion} and this harness scores under ${campaignScoringVersion}; start a new campaign (the old report stays readable with --report)`);
  }
  const { judge } = deps;
  if (campaignJudges(plan)) {
    if (!judge) throw new Error("This benchmark needs a judge, but no judge model resolved; pin one with --judge model:effort");
    // A campaign created before 2026-11-10 recorded no judge, so its scores cannot be shown to come from this one.
    if (stored && !stored.judge) throw new Error("These results predate the recorded benchmark judge, so new scores could mix judges; start a new campaign (the old report stays readable with --report)");
  }
  if (stored?.judge && (stored.judge.model !== judge?.model || stored.judge.effort !== judge.effort)) {
    throw new Error(`These results were judged by ${stored.judge.model}:${stored.judge.effort}, but this run's judge resolved to ${judge ? `${judge.model}:${judge.effort}` : "none"}; start a new campaign`);
  }
  const campaignInputs = {
    persona: plan.persona, mode: plan.mode, variants: plan.variants, repeats: plan.repeats,
    taskIdentity, personaGuidanceIdentity,
    judgeIdentity: structuredIdentity(judge ? { ...JUDGE_IDENTITY_INPUT, judge } : JUDGE_IDENTITY_INPUT),
    scoringVersion: campaignScoringVersion,
    ...(judge ? { judge } : {}),
  };
  const contentIdentity = structuredIdentity({
    ...campaignInputs,
    ...(nativeTasks && resolvedDeps.nativeInvocation ? { nativeBackend: resolvedDeps.nativeInvocation.sourceIdentity } : {}),
  });
  if (stored && plan.mode === "research" && stored.taskIdentity !== taskIdentity) throw new Error(RESEARCH_TASKS_CHANGED);
  if (stored && (
    stored.persona !== plan.persona || stored.mode !== plan.mode ||
    !sameVariants(stored.variants, plan.variants) || stored.repeats !== plan.repeats ||
    stored.taskIdentity !== taskIdentity || stored.personaGuidanceIdentity !== personaGuidanceIdentity ||
    stored.judgeIdentity !== campaignInputs.judgeIdentity
  )) throw new Error("Benchmark campaign identity changed; start a new campaign");
  const config: RunConfig = {
    kind: "benchmark-config", ...campaignInputs, stamp: plan.stamp, sourceIdentity: deps.sourceIdentity,
    identity: {
      profileId, authorityIncarnation,
      contentIdentity: stored && nativeTasks && (plan.operation === "rescore" || !resolvedDeps.nativeInvocation) ? stored.identity.contentIdentity : contentIdentity,
    },
  };
  const store = existingStore ?? await createPersonaStore(location, config, plan.tasks.map(({ id }) => id));
  if (plan.operation !== "run" && stored?.identity.contentIdentity !== config.identity.contentIdentity) {
    throw new Error("Benchmark campaign identity changed; start a new campaign");
  }
  const taskIds = new Set(plan.tasks.map((task) => task.id));
  validateRuns(plan, taskIds, runRecords);
  validateAttempts(plan, taskIds, await store.loadAttempts());
  validateJudgeAttempts(plan, taskIds, await store.loadJudgeAttempts());
  validateScores(plan, taskIds, await store.loadScores());

  const results: CellRunResult[] = runRecords.map(toRunResult);
  const implementResults: ImplementCandidate[] = runRecords
    .filter((run): run is ImplementRunRecord => run.mode === "implement")
    .map(implementCandidate);
  const scope = createCommandScope(deps.runtime.runOwnedCommand, signal);

  onEvent({ kind: "benchmark.started", resultsDir: plan.resultsDir, pendingCells: groups.reduce((total, group) => total + group.length, 0) });

  let retryCells = 0;
  if (groups.length > 0) {
    const attempts = groups.map(group => group.map(cell => ({
      ...cell, directory: join(plan.resultsDir, "cells", cell.variant.id, cell.task.id, String(cell.repeat), crypto.randomUUID()),
    })));
    const persistRoles = async (cell: BenchmarkCell & { directory: string }): Promise<void> => {
      const rolesFile = Bun.file(join(cell.directory, "roles.json"));
      await store.appendRoles({ kind: "cell-roles", ...cellId(cell), directory: cell.directory, profileId, authorityIncarnation, roles: await rolesFile.exists() ? await rolesFile.json() : null });
    };
    await runGroups(
      attempts,
      async (cell) => {
        onEvent({ kind: "cell.started", cell: cellId(cell) });
        await mkdir(cell.directory, { recursive: true });
        return await runCell(cell, { deps: resolvedDeps, persona, registry, scope, resultsDir: plan.resultsDir, cellDirectory: cell.directory });
      },
      async (cell, result) => {
        await store.appendRun(runRecord(plan, cell, result, deps.sourceIdentity));
        await persistRoles(cell);
        results.push(result);
        if (isImplementCandidate(result)) implementResults.push(result);
        onEvent({
          kind: "cell.completed",
          cell: cellId(cell),
          accounting: result.accounting,
          durationMs: result.durationMs,
          ...(isImplementCandidate(result) ? { acceptance: { passed: result.acceptancePassed, total: result.acceptanceTotal } } : {}),
        });
      },
      async (cell, error) => {
        if (!(error instanceof PersonaTaskFailure)) throw error;
        // Persist the accounting before the observer hears about it: events.jsonl
        // is the authority, and `cell.failed` is its projection.
        await store.appendAttempt(attemptRecord(plan, cell, error, deps.sourceIdentity));
        if (!isScoredAttempt({ mode: plan.mode, terminal: error.terminal })) retryCells++;
        await persistRoles(cell);
        onEvent({ kind: "cell.failed", cell: cellId(cell), message: error.message });
      },
      signal,
      DEFAULT_BENCHMARK_CONCURRENCY,
    );
  }

  if (signal?.aborted) return await cancel(plan, scope, onEvent);
  if (retryCells > 0) throw new Error(`${retryCells} benchmark cell${retryCells === 1 ? "" : "s"} failed; resume the run to retry them`);
  const report = await scoreAndRender(plan, resolvedDeps, store, results, implementResults, scope.run);
  if (signal?.aborted) return await cancel(plan, scope, onEvent);
  if (judge) await exportCampaignRecords(catalog.recordsFile(plan.persona, plan.stamp), { kind: "campaign", version: 1, persona: plan.persona, mode: plan.mode, stamp: plan.stamp, judge: { model: judge.model, effort: judge.effort }, scoringVersion: campaignScoringVersion, personaGuidanceIdentity }, await store.loadRuns(), await store.loadAttempts(), await store.loadScores(), plan.tasks, catalog.projectRoot);
  const reportPath = join(store.directory, "report.md");
  report.text += `\n${sourceReport(await store.loadRuns())}\n${await store.roleReport()}\nCandidate role selections are in each cell's roles.json. Judge role selections and profile IDs are in judge-requests/<profile>/<call>/roles.json.\n`;
  await store.writeArtifact("report.md", report.text);
  await scope.settle();
  onEvent({ kind: "benchmark.completed", resultsDir: plan.resultsDir, reportPath, report: report.text, counts: report.counts });
  return { status: "completed", resultsDir: plan.resultsDir, reportPath, report: report.text, counts: report.counts };
}

async function cancel(plan: BenchmarkPlan, scope: CommandScope, onEvent: (event: BenchmarkEvent) => void): Promise<BenchmarkOutcome> {
  await scope.settle();
  onEvent({ kind: "benchmark.cancelled", resultsDir: plan.resultsDir });
  return { status: "cancelled", resultsDir: plan.resultsDir };
}

function cellId(cell: BenchmarkCell): BenchmarkCellId {
  return { variant: cell.variant.id, task: cell.task.id, repeat: cell.repeat };
}

function runRecord(plan: BenchmarkPlan, cell: BenchmarkCell, result: CellRunResult | ImplementCandidate, sourceIdentity: string): AgentRunRecord {
  const seat = {
    persona: plan.persona, sourceIdentity,
    ...(cell.variant.model === undefined ? {} : { model: cell.variant.model }),
    ...(cell.variant.effort === undefined ? {} : { effort: cell.variant.effort }),
  };
  if (isImplementCandidate(result)) return { kind: "agent-run", mode: "implement", ...seat, ...result };
  if (plan.mode === "reviewer") return { kind: "agent-run", mode: "reviewer", ...seat, ...result, reviewText: result.summary };
  return { kind: "agent-run", mode: "research", ...seat, ...result };
}

function attemptRecord(plan: BenchmarkPlan, cell: BenchmarkCell, failure: PersonaTaskFailure, sourceIdentity: string): AttemptRecord {
  return {
    kind: "agent-run-attempt",
    attemptId: crypto.randomUUID(),
    persona: plan.persona,
    mode: plan.mode,
    variant: cell.variant.id,
    ...(cell.variant.model === undefined ? {} : { model: cell.variant.model }),
    ...(cell.variant.effort === undefined ? {} : { effort: cell.variant.effort }),
    sourceIdentity, task: cell.task.id,
    repeat: cell.repeat,
    at: new Date().toISOString(),
    durationMs: failure.accounting.durationMs,
    terminal: failure.terminal,
    accounting: failure.accounting.accounting,
  };
}

interface CellContext {
  resultsDir: string;
  cellDirectory: string;
  deps: PersonaBenchmarkDeps;
  persona: PersonaDefinition;
  registry: ReadonlyMap<string, AgentDefinition>;
  scope: CommandScope;
}

async function runCell(cell: BenchmarkCell, context: CellContext): Promise<CellRunResult | ImplementCandidate> {
  const startedAt = performance.now();
  try {
    if (isImplementTask(cell.task)) return await runImplementCell(cell, cell.task, context);
    if (isReviewTask(cell.task)) return await runReviewCell(cell, cell.task, context);
    await Bun.write(join(context.cellDirectory, "diff.patch"), "");
    return await withSnapshotWorkspace(context.deps.catalog.projectRoot, cell.task.snapshot, context.scope.run, (workspace) => runOne(cell, context, workspace, undefined, join(context.cellDirectory, "transcript.jsonl")));
  } catch (error) {
    throw asPersonaTaskFailure(error, startedAt, context.deps.signal);
  }
}

/** Runs one persona trial in `workspace`, the only project the trial sees. */
async function runOne(cell: BenchmarkCell, context: CellContext, workspace: string, timeoutMs?: number, transcriptPath?: string): Promise<CellRunResult> {
  const native = isImplementTask(cell.task) && cell.task.kind === "native" ? cell.task.native : undefined;
  const request: PersonaTaskRequest = {
    persona: context.persona,
    seat: cell.variant,
    prompt: cell.task.prompt,
    label: `${cell.variant.id}/${cell.task.id}/${cell.repeat}`,
    workspace,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(transcriptPath === undefined ? {} : { transcriptPath }),
    ...(context.deps.signal ? { signal: context.deps.signal } : {}),
    agentRegistry: context.registry,
  };
  let outcome: PersonaRunOutcome;
  if (native) {
    const invocation = context.deps.nativeInvocation;
    if (!invocation) throw new Error("Native cells require native isolation");
    outcome = await invocation.run(request, native.path ?? []);
  } else {
    outcome = await runPersonaTask(context.deps.runtime, request);
  }
  return {
    variant: cell.variant.id,
    task: cell.task.id,
    repeat: cell.repeat,
    accounting: outcome.accounting,
    durationMs: outcome.durationMs,
    summary: outcome.summary,
  };
}

/** The persona implements the plan directly in a sandbox: no implement workflow
 *  and no parent verification gates. The hidden acceptance tests arrive only
 *  after the diff is captured. */
async function runImplementCell(cell: BenchmarkCell, task: ImplementTask, context: CellContext): Promise<ImplementCandidate> {
  const evidence = {
    directory: join(context.cellDirectory, "evidence"),
    resultsDir: context.resultsDir,
  };
  const projectRoot = context.deps.catalog.projectRoot;
  const sandbox = await provisionTaskSandbox(projectRoot, task, context.scope.run, { evidence });
  try {
    // The sandbox's .flywheel is excluded from the captured diff and copied into evidence below.
    const result = await runOne(cell, context, sandbox, task.timeoutMs, join(sandbox, ".flywheel", IMPLEMENT_TRANSCRIPT_FILE));
    let capture;
    try {
      capture = await captureImplementation(task, sandbox, context.scope.run, evidence);
    } catch (error) {
      const message = errorMessage(error);
      throw new PersonaTaskFailure(
        { kind: "failed", message },
        { durationMs: result.durationMs, accounting: result.accounting },
        message,
      );
    }
    const { diff, diffStats, acceptance } = capture;
    await Bun.write(join(context.cellDirectory, "diff.patch"), diff);
    return {
      ...result,
      diff,
      ...diffStats,
      acceptancePassed: acceptance.passed,
      acceptanceFailed: acceptance.failed,
      acceptanceTotal: acceptance.total,
      ...(capture.nativeGrade === undefined ? {} : { nativeGrade: capture.nativeGrade }),
    };
  } finally {
    await retainImplementStore(sandbox, evidence.directory);
    const transcript = join(sandbox, ".flywheel", IMPLEMENT_TRANSCRIPT_FILE);
    if (await Bun.file(transcript).exists()) await cp(transcript, join(context.cellDirectory, "transcript.jsonl"));
    const roles = join(sandbox, ".flywheel", "roles.json");
    if (await Bun.file(roles).exists()) await cp(roles, join(context.cellDirectory, "roles.json"));
    await rm(sandbox, { recursive: true, force: true });
  }
}

async function runReviewCell(cell: BenchmarkCell, task: ReviewTask, context: CellContext): Promise<CellRunResult> {
  await Bun.write(join(context.cellDirectory, "diff.patch"), "");
  return await withTrialWorkspace(
    (sandbox) => materializeReviewSandbox(context.deps.catalog, task, sandbox, context.scope.run),
    (sandbox) => runOne(cell, context, sandbox, undefined, join(context.cellDirectory, "transcript.jsonl")),
  );
}

interface ScoredReport {
  text: string;
  counts: ReportCounts;
}

async function scoreAndRender(
  plan: BenchmarkPlan,
  deps: PersonaBenchmarkDeps,
  store: RunStore,
  results: readonly CellRunResult[],
  implementResults: readonly ImplementCandidate[],
  commands: OwnedCommandRunner,
): Promise<ScoredReport> {
  const { onEvent, signal } = deps;
  const reportArgs = { persona: plan.persona, variants: plan.variants, ...(deps.judge ? { judge: deps.judge } : {}) };
  const scoreRecords = await store.loadScores();
  const persistJudgeAttempt = (report: JudgeAttemptReport): Promise<void> => store.appendJudgeAttempt(judgeAttemptRecord(plan, report));
  const counts = async (): Promise<ReportCounts> => {
    const [attempts, judgeAttempts, scores] = await Promise.all([
      store.loadAttempts(),
      store.loadJudgeAttempts(),
      store.loadScores(),
    ]);
    return {
      failedJudgeCalls: failedJudgeCallCount(
        judgeAttempts.map((attempt) => judgeScoreIdentityKey(attempt.score)),
        scores.map(scoreRecordIdentityKey),
      ),
      unsuccessfulAttempts: attempts.length,
      ...unsuccessfulOverhead(attempts),
      ...judgeOverhead(judgeAttempts),
    };
  };

  if (plan.mode === "implement") {
    const judge = await deps.createJudge(join(store.directory, "judge-requests"));
    const tasks = plan.tasks.filter(isImplementTask);
    onEvent({ kind: "scoring.started", phase: "traps" });
    const scores = await scoreImplementTraps(implementResults, new Map(tasks.map((task) => [task.id, task.manifest])), judge, {
      existing: scoreRecords.filter((record) => record.kind === "trap-score").map((record) => record.score),
      onSettled: ({ value, error }) => error === null
        ? store.appendScore({ kind: "trap-score", mode: "implement", persona: plan.persona, score: value, error })
        : Promise.resolve(),
      onAttempt: persistJudgeAttempt,
      ...(signal ? { signal } : {}),
    });
    let verdicts: readonly JudgeVerdict[] = [];
    if (plan.variants.length >= 2) {
      onEvent({ kind: "scoring.started", phase: "pairs" });
      verdicts = await judgeImplementPairs(implementResults, tasks, judge, undefined, {
        existing: scoreRecords.filter((record) => record.kind === "pair-score").map((record) => record.verdict),
        onSettled: ({ value, error }) => error === null
          ? store.appendScore({ kind: "pair-score", mode: "implement", persona: plan.persona, verdict: value, error })
          : Promise.resolve(),
        onAttempt: persistJudgeAttempt,
        ...(signal ? { signal } : {}),
      });
    } else {
      onEvent({ kind: "scoring.skipped", phase: "pairs", reason: "a solo variant has nothing to compare against" });
    }
    await store.writeArtifact("raw.json", `${JSON.stringify(buildImplementRawResults(implementResults, scores, verdicts), null, 2)}\n`);
    const settledCounts = await counts();
    return { text: renderImplementReport(reportArgs, tasks, implementResults, scores, verdicts, plan.stamp, settledCounts), counts: settledCounts };
  }

  if (plan.mode === "reviewer") {
    const tasks = plan.tasks.filter(isReviewTask);
    onEvent({ kind: "scoring.started", phase: "reviews" });
    const scores = await scoreReviews(results, new Map(tasks.map((task) => [task.id, task.manifest])), await deps.createJudge(join(store.directory, "judge-requests")), {
      existing: scoreRecords.filter((record) => record.kind === "review-score").map((record) => record.score),
      onSettled: ({ value, error }) => error === null
        ? store.appendScore({ kind: "review-score", mode: "reviewer", persona: plan.persona, score: value, error })
        : Promise.resolve(),
      onAttempt: persistJudgeAttempt,
      ...(signal ? { signal } : {}),
    });
    const scoredResults = results.map((result) => {
      const score = scores.find((candidate) => candidate.variant === result.variant && candidate.task === result.task && candidate.repeat === result.repeat);
      const { summary: reviewText, ...run } = result;
      // A run whose judge call failed carries scoring: null; --rescore fills it in.
      return { ...run, reviewText, scoring: score ? { caught: score.caught, uncertain: score.uncertain, unsupportedFindingCount: score.unsupportedFindingCount, unsupportedSevereFindingCount: score.unsupportedSevereFindingCount } : null };
    });
    await store.writeArtifact("raw.json", `${JSON.stringify(scoredResults, null, 2)}\n`);
    const settledCounts = await counts();
    return { text: renderReviewReport(reportArgs, tasks, results, scores, plan.stamp, settledCounts), counts: settledCounts };
  }

  const { scores: researchScores, verdicts } = await judgeResearchCampaign({
    persona: plan.persona, variantCount: plan.variants.length, tasks: plan.tasks.filter(isResearchTask), results, records: scoreRecords, store,
    createJudge: () => deps.createJudge(join(store.directory, "judge-requests")),
    materialize: (snapshot) => withSnapshotWorkspace(deps.catalog.projectRoot, snapshot, commands, snapshotLines),
    onAttempt: persistJudgeAttempt, onPhase: (phase) => onEvent({ kind: "scoring.started", phase }), signal,
  });
  if (plan.variants.length < 2) onEvent({ kind: "scoring.skipped", phase: "pairs", reason: "a solo variant has nothing to compare against" });
  await store.writeArtifact("raw.json", `${JSON.stringify(results, null, 2)}\n`);
  const settledCounts = await counts();
  return { text: renderReport(reportArgs, plan.tasks, results, verdicts, plan.stamp, settledCounts, researchScores), counts: settledCounts };
}
