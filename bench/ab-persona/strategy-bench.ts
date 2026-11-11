#!/usr/bin/env bun

// A/B benchmark of two research strategies on identical pre-implementation
// research topics, both on the explorer seat so the comparison isolates
// strategy shape, not model choice:
// - explorer-single: one explorer researches the whole topic.
// - explorer-facets: one explorer per fixed facet of the topic, dispatched
//   concurrently with the research protocol's facet brief, as production
//   dispatch does. The facets are task data, never model-chosen, so every run
//   of the arm splits the topic the same way.
// The judge scores each arm's combined brief for a planner: coverage of
// integration points, existing solutions, and conflicts. Quality is
// randomized blinded pairwise judging.

import { dirname, join, resolve } from "node:path";
import { ROLE_MODEL_DEFAULTS } from "../../src/orchestration/config/role-model-defaults.js";
import { createBenchmarkCatalog, RESEARCH_SNAPSHOT, RESEARCH_TASKS_CHANGED, type ResearchTask } from "../../src/orchestration/modules/development/benchmark/catalog.js";
import { admitBenchmark, benchmarkPreflightReport } from "../../src/orchestration/modules/development/benchmark/admission.js";
import { loadBenchmarkPersona, type BenchmarkPlan } from "../../src/orchestration/modules/development/benchmark/persona-benchmark.js";
import { validateAttempts, validateJudgeAttempts, validateRuns, validateScores } from "../../src/orchestration/modules/development/benchmark/persona-evidence-validation.js";
import { sameVariants } from "../../src/orchestration/modules/development/benchmark/variant.js";
import { createBenchmarkRuntime, type OwnedBenchmarkRuntime } from "../shared/runtime.js";
import { judgePairs, type JudgeCandidate } from "../../src/orchestration/modules/development/benchmark/judge.js";
import { judgeOverhead, renderReport, unsuccessfulOverhead } from "../../src/orchestration/modules/development/benchmark/reports.js";
import { combineBenchmarkAccounting } from "../../src/orchestration/modules/development/benchmark/report-accounting.js";
import { asPersonaTaskFailure, PersonaTaskFailure, renderPersonaTaskGuidance, runPersonaTask, type BenchmarkRuntime, type PersonaDefinition, type PersonaTaskRequest } from "../../src/orchestration/modules/development/benchmark/persona-run.js";
import { requireCampaignSource, runningSourceIdentity, structuredIdentity } from "../../src/orchestration/modules/development/benchmark/content-identity.js";
import { withSnapshotWorkspace } from "../../src/orchestration/modules/development/benchmark/snapshot-workspace.js";
import type { BenchmarkAccounting } from "../../src/orchestration/modules/development/benchmark/evidence.js";
import type { AgentDefinition } from "../../src/infra/agent-definition.js";
import {
  createRunStore,
  judgeScoreIdentityKey,
  runKey,
  scoreRecordIdentityKey,
  type AttemptRecord,
  type BenchmarkVariant,
  type ResearchRunRecord,
  type RunConfig,
} from "../../src/orchestration/modules/development/benchmark/run-store.js";
import { failedJudgeCallCount } from "../../src/orchestration/modules/development/benchmark/judge-attempt-reconciliation.js";
type PersonaSeat = PersonaTaskRequest["seat"];

const REPO_ROOT = resolve(import.meta.dir, "../..");
const CATALOG = createBenchmarkCatalog(REPO_ROOT);
/** The research protocol whose facet brief the facets arm dispatches. */
export const RESEARCH_PROTOCOL_PATH = join(REPO_ROOT, "src/agent-skills/references/research-protocol.md");

/** Where one results directory lives, for the run store. */
function storeLocation(directory: string): { resultsRoot: string; directory: string } {
  return { resultsRoot: dirname(resolve(directory)), directory: resolve(directory) };
}

/** Distinguishes strategy runs from single-persona runs in stored records. */
export const STRATEGY_PERSONA = "research-strategy";

const SINGLE_STRATEGY = "explorer-single";
const FACETS_STRATEGY = "explorer-facets";

export interface PlanFacet {
  id: string;
  /** One disjoint slice of the topic, phrased per the research protocol's facet line. */
  description: string;
  /** The kinds of locations the explorer enumerates for this facet. */
  find: string;
}

export interface PlanTask {
  id: string;
  /** The change to plan; the judged context for both arms' briefs. */
  topic: string;
  facets: readonly PlanFacet[];
}

/** Pre-implementation research topics with broad,
 *  multi-facet surfaces with a planted trap (partially existing machinery the
 *  brief must surface as EXISTING_SOLUTION territory). */
export const PLAN_TASKS: readonly PlanTask[] = [
  {
    id: "session-cost-budget",
    topic: "Add enforceable per-session cost budgets: a configurable USD limit per session that, when exceeded, stops further model calls gracefully and surfaces the exceeded state to the user.",
    facets: [
      {
        id: "usage-accounting",
        description: "Where per-session model usage and cost are computed, accumulated, and persisted",
        find: "implementation files and the specific accounting call sites at file:line",
      },
      {
        id: "budget-substrate",
        description: "Any existing budget, spend-limit, or cost-projection machinery (typed facts, projections, trackers, caches)",
        find: "implementation files, fact type definitions, projections, and docs or ADRs",
      },
      {
        id: "enforcement-points",
        description: "Where an in-flight agent run could be stopped or prevented from making its next model call (runner loop, turn limits, abort paths)",
        find: "implementation files and pattern instances at file:line",
      },
      {
        id: "config-and-ui",
        description: "Where user config options are defined and validated, and where session cost or tokens are currently displayed in the TUI",
        find: "config schema files and TUI components",
      },
    ],
  },
  {
    id: "subagent-cancellation",
    topic: "Let a user cancel a single in-flight subagent from the parent session without aborting the parent: a cancel action that stops the subagent's runner, records a terminal state, and delivers a cancellation notification to the parent.",
    facets: [
      {
        id: "dispatch-lifecycle",
        description: "How subagents are dispatched and tracked while running, and how completion results currently reach the parent",
        find: "implementation files at file:line",
      },
      {
        id: "abort-mechanics",
        description: "Existing abort and cancellation mechanics in the agent runtime (runner abort, fibers, abort controllers, structured cancellation)",
        find: "implementation files and pattern instances at file:line",
      },
      {
        id: "durable-records",
        description: "Which typed facts record subagent runs and terminal states, and which projections or notifications read them",
        find: "fact type definitions, projections, and notification builders",
      },
      {
        id: "ui-surface",
        description: "Where running subagents are visible in the TUI and where user actions on them would be wired",
        find: "TUI components and action dispatch sites",
      },
    ],
  },
];

export interface CliArgs {
  repeats: number;
  dryRun: boolean;
  operation: "run" | "resume" | "rescore";
  resultsDir?: string;
  storedConfig?: RunConfig;
}

export async function parseArgs(argv: readonly string[]): Promise<CliArgs> {
  let repeats: number | undefined;
  let dryRun = false;
  let resumeDir: string | undefined;
  let rescoreDir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--repeats") {
      const value = argv[++i];
      if (!value) throw new Error("--repeats requires a value");
      repeats = Number(value);
    } else if (arg === "--resume" || arg === "--rescore") {
      const value = argv[++i];
      if (!value) throw new Error(`${arg} requires a results directory`);
      if (arg === "--resume") resumeDir = resolve(value);
      else rescoreDir = resolve(value);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  if (resumeDir && rescoreDir) throw new Error("--resume and --rescore cannot be used together");
  if (repeats !== undefined && (!Number.isInteger(repeats) || repeats < 1)) throw new Error("--repeats must be a positive integer");

  const resultsDir = resumeDir ?? rescoreDir;
  const operation = resumeDir ? "resume" : rescoreDir ? "rescore" : "run";
  let storedConfig: RunConfig | undefined;
  // An operator names the directory to resume, so its own parent is the root it
  // must stay inside: the directory itself still has to be real, not a link.
  if (resultsDir) storedConfig = await (await createRunStore(storeLocation(resultsDir))).loadConfig();
  if (storedConfig && storedConfig.persona !== STRATEGY_PERSONA) {
    throw new Error(`Results persona ${storedConfig.persona} is not a strategy benchmark`);
  }
  if (storedConfig && repeats !== undefined && repeats !== storedConfig.repeats) {
    throw new Error(`Results repeats ${storedConfig.repeats} conflict with --repeats ${repeats}`);
  }
  return { repeats: repeats ?? storedConfig?.repeats ?? 1, dryRun, operation, resultsDir, storedConfig };
}

/** Pin a role to its coded OpenAI preference so seats stay stable across
 *  runs regardless of user config. */
export function seatFor(role: keyof typeof ROLE_MODEL_DEFAULTS): PersonaSeat {
  return { ...ROLE_MODEL_DEFAULTS[role].openai };
}

/** Both arms run on the one explorer seat; only the strategy differs. */
export function strategyVariants(seat: PersonaSeat): readonly BenchmarkVariant[] {
  return [SINGLE_STRATEGY, FACETS_STRATEGY].map((id) => ({ id, model: seat.model, effort: seat.effort }));
}

export function singleExplorerPrompt(task: PlanTask): string {
  return [
    `Topic under research (a change someone else will plan): ${task.topic}`,
    "",
    "Document what exists with file:line citations, including any code that already covers part of the topic, conventions the change would touch, and consumers a change would impact. Documentarian mode: do not suggest changes.",
  ].join("\n");
}

/** The research protocol's per-facet explorer brief: the one fenced block of
 *  the protocol, read at run time so the arm always dispatches the shipped brief. */
export async function loadFacetBrief(): Promise<string> {
  const blocks = [...(await Bun.file(RESEARCH_PROTOCOL_PATH).text()).matchAll(/^```\n([\s\S]*?)\n```$/gm)];
  const brief = blocks[0]?.[1];
  if (blocks.length !== 1 || brief === undefined) throw new Error(`${RESEARCH_PROTOCOL_PATH} must hold exactly one fenced facet brief, found ${blocks.length}`);
  return brief;
}

/** Fill the facet brief's placeholders, refusing a brief whose placeholders
 *  changed: a silently unfilled brief would benchmark a malformed dispatch. */
export function facetPrompt(brief: string, task: PlanTask, facet: PlanFacet): string {
  const fills: readonly (readonly [RegExp, string])[] = [
    [/<topic>/, task.topic],
    [/<one slice of the topic>/, facet.description],
    [/<implementation files \|[^>]*>/, facet.find],
  ];
  return fills.reduce((prompt, [placeholder, value]) => {
    if (!placeholder.test(prompt)) throw new Error(`The research protocol's facet brief no longer has the placeholder ${placeholder.source}`);
    return prompt.replace(placeholder, () => value);
  }, brief);
}

/** Plan-research judging rewards planner-relevant coverage over concision,
 *  unlike the default Q&A judge prompt. */
export function buildPlanJudgePrompt(topic: string, briefA: string, briefB: string): string {
  return [
    "You are a meticulous staff engineer comparing two research briefs prepared for an engineer who is about to plan the change described below. The plan will be written by someone else; the brief's job is to surface everything the planner must know before designing the change.",
    "Judge coverage first: integration points, existing code that already covers part of the topic, conventions the change would conflict with, and consumers or tests a change would impact. A missed integration point or an unnoticed existing solution is the most costly failure. Judge factual grounding: claims need accurate file:line citations. Penalize only material that could not inform the plan (padding, duplication, off-topic detail); on-topic thoroughness is a strength, not a weakness. Do not infer model identity from writing style. Allow a tie only when quality is genuinely equal.",
    "",
    "## Change to plan",
    topic,
    "",
    "## BRIEF A",
    briefA,
    "",
    "## BRIEF B",
    briefB,
    "",
    "Respond with only one JSON object on one line:",
    `{"winner":"A"|"B"|"tie","rationale":"At most two concise sentences naming the deciding difference."}`,
  ].join("\n");
}

interface CellOutcome {
  accounting: BenchmarkAccounting;
  durationMs: number;
  summary: string;
}

interface CellContext {
  deps: BenchmarkRuntime;
  seat: PersonaSeat;
  registry: ReadonlyMap<string, AgentDefinition>;
  explorer: PersonaDefinition;
  facetBrief: string;
}

/** Every persona call reads its own fresh snapshot of the pinned research corpus, never the live checkout.
 *  A snapshot that cannot be made fails the call like a failed run, so the cell records an attempt. */
async function runInSnapshot(ctx: CellContext, prompt: string, label: string): ReturnType<typeof runPersonaTask> {
  const startedAt = performance.now();
  try {
    return await withSnapshotWorkspace(REPO_ROOT, RESEARCH_SNAPSHOT, ctx.deps.runOwnedCommand, (workspace) => runPersonaTask(ctx.deps, { persona: ctx.explorer, seat: ctx.seat, prompt, label, agentRegistry: ctx.registry, workspace }));
  } catch (error) {
    throw asPersonaTaskFailure(error, startedAt, undefined);
  }
}

/** Await every concurrent branch and preserve every typed accounting outcome. */
export async function settleConcurrent(promises: readonly Promise<CellOutcome>[]): Promise<CellOutcome[]> {
  const settled = await Promise.allSettled(promises);
  const fulfilled: CellOutcome[] = [];
  const failures: PersonaTaskFailure[] = [];
  let untypedFailure: unknown;
  for (const result of settled) {
    if (result.status === "fulfilled") fulfilled.push(result.value);
    else if (result.reason instanceof PersonaTaskFailure) failures.push(result.reason);
    else untypedFailure ??= result.reason;
  }
  if (untypedFailure !== undefined) throw untypedFailure;
  const first = failures[0];
  if (!first) return fulfilled;
  throw new PersonaTaskFailure(first.terminal, {
    durationMs: fulfilled.reduce((total, value) => total + value.durationMs, 0) + failures.reduce((total, failure) => total + failure.accounting.durationMs, 0),
    accounting: combineBenchmarkAccounting([
      ...fulfilled.map((value) => value.accounting),
      ...failures.map((failure) => failure.accounting.accounting),
    ]),
  }, failures.map((failure) => failure.message).join("; "));
}

/** The facets arm fans out one explorer per facet concurrently, as the
 *  production runtime executes same-turn dispatches. Latency is the arm's
 *  wall clock; cost and tokens sum across every facet run. */
async function runCell(ctx: CellContext, task: PlanTask, strategyId: string, label: string): Promise<CellOutcome> {
  if (strategyId === SINGLE_STRATEGY) return runInSnapshot(ctx, singleExplorerPrompt(task), label);
  const startedAt = performance.now();
  const facetOutcomes = await settleConcurrent(task.facets.map(async (facet) => {
    const outcome = await runInSnapshot(ctx, facetPrompt(ctx.facetBrief, task, facet), `${label}/${facet.id}`);
    return { ...outcome, summary: `## Facet: ${facet.id}\n\n${outcome.summary}` };
  }));
  return {
    accounting: combineBenchmarkAccounting(facetOutcomes.map((outcome) => outcome.accounting)),
    durationMs: Math.round(performance.now() - startedAt),
    summary: facetOutcomes.map((outcome) => outcome.summary).join("\n\n"),
  };
}

/** Resumed results must be produced by the exact seats this harness derives
 *  now; a benchmarked-default change mid-run would silently mix seats. */
export function assertSameVariants(current: readonly BenchmarkVariant[], stored: readonly BenchmarkVariant[]): void {
  if (!sameVariants(current, stored)) {
    throw new Error(`Stored strategy seats (${stored.map((variant) => `${variant.id}=${variant.model}@${variant.effort}`).join(", ")}) do not match the current benchmarked defaults (${current.map((variant) => `${variant.id}=${variant.model}@${variant.effort}`).join(", ")}); benchmark seats changed since the run started`);
  }
}

type CreateRuntime = (projectRoot: string, stored?: RunConfig["identity"]) => Promise<OwnedBenchmarkRuntime>;

const createRuntimeDefault: CreateRuntime = (projectRoot, stored) =>
  createBenchmarkRuntime(projectRoot, stored ? { stored } : {});

export async function main(
  argv: readonly string[] = process.argv.slice(2),
  createRuntime: CreateRuntime = createRuntimeDefault,
  sourceIdentity: () => Promise<string> = () => runningSourceIdentity([join(REPO_ROOT, "bench", "shared")]),
): Promise<void> {
  const args = await parseArgs(argv);
  const persona = STRATEGY_PERSONA;
  const facetBrief = await loadFacetBrief();
  const tasks: readonly ResearchTask[] = PLAN_TASKS.map((task) => {
    const source = { id: task.id, prompt: task.topic, snapshot: RESEARCH_SNAPSHOT };
    return { ...source, contentIdentity: structuredIdentity(source) };
  });
  const seat = seatFor("explorer");
  const variants = strategyVariants(seat);
  if (args.storedConfig) assertSameVariants(variants, args.storedConfig.variants);

  const stamp = args.storedConfig?.stamp ?? new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = args.resultsDir ?? CATALOG.resultsDir("strategy", stamp);
  const location = storeLocation(outDir);
  await using runtime = await createRuntime(REPO_ROOT, args.storedConfig?.identity);
  if (args.storedConfig) runtime.assertUsageAuthority(args.storedConfig.identity);
  const admissionPlan: BenchmarkPlan = {
    persona,
    mode: "research",
    variants: [{ id: "explorer-seat", ...seat }],
    repeats: args.repeats,
    stamp,
    resultsDir: outDir,
    operation: args.operation,
    tasks,
  };
  const admission = await admitBenchmark({
    ...runtime.deps,
    profileId: runtime.profileId,
    authorityIncarnation: runtime.usageAuthority.authorityIncarnation,
    launcher: runtime.launcher,
    background: runtime.background,
    foregroundBashHold: runtime.foregroundBashHold,
    shell: runtime.shell,
  }, [
    ...admissionPlan.variants.map((variant) => ({ role: "candidate" as const, model: variant.model })),
    { role: "judge", ...ROLE_MODEL_DEFAULTS["benchmark-judge"].openai },
  ]);
  if (args.dryRun) {
    const matrix = [];
    for (let repeat = 0; repeat < args.repeats; repeat++) {
      for (const task of tasks) {
        for (const variant of variants) matrix.push({ strategy: variant.id, task: task.id, repeat });
      }
    }
    console.log(JSON.stringify({
      // Admission previews the one shared seat; the summary counts the strategy cells.
      ...benchmarkPreflightReport({ ...admissionPlan, variants: variants.map(({ id }) => ({ id })) }, admission.providerPlans),
      strategies: variants,
      tasks: PLAN_TASKS,
      matrix,
    }, null, 2));
    return;
  }

  const deps = admission.runtime;
  const { persona: explorer, registry } = await loadBenchmarkPersona({ ...admissionPlan, persona: "explorer" }, CATALOG, deps);
  // The facet brief is part of the task identity, so a protocol edit refuses resume.
  const taskIdentity = structuredIdentity({ snapshot: RESEARCH_SNAPSHOT, tasks: PLAN_TASKS, facetBrief });
  const personaGuidanceIdentity = structuredIdentity([renderPersonaTaskGuidance(explorer, registry, deps)]);
  const judgeIdentity = structuredIdentity({ model: ROLE_MODEL_DEFAULTS["benchmark-judge"].openai.model, template: buildPlanJudgePrompt("__TASK__", "__A__", "__B__") });
  const scoringVersion = "strategy-v1";
  const runningSource = await sourceIdentity();
  // The recorded source stays out of the identity comparison below, so a rescore never depends on it.
  const recordedSource = args.operation === "run" ? runningSource : args.storedConfig?.sourceIdentity;
  const config: RunConfig = {
    kind: "benchmark-config",
    persona,
    mode: "research",
    variants,
    repeats: args.repeats,
    stamp,
    identity: {
      profileId: runtime.profileId,
      authorityIncarnation: runtime.usageAuthority.authorityIncarnation,
      contentIdentity: structuredIdentity({ persona, variants, repeats: args.repeats, taskIdentity, personaGuidanceIdentity, judgeIdentity, scoringVersion }),
    },
    taskIdentity,
    personaGuidanceIdentity,
    judgeIdentity,
    scoringVersion,
    ...(recordedSource === undefined ? {} : { sourceIdentity: recordedSource }),
  };
  const store = args.operation === "run" ? await createRunStore(location, config) : await createRunStore(location);
  if (args.operation !== "run") {
    const stored = await store.loadConfig();
    if (stored.taskIdentity !== config.taskIdentity) throw new Error(RESEARCH_TASKS_CHANGED);
    if (JSON.stringify(stored) !== JSON.stringify(config)) {
      throw new Error("Benchmark campaign identity changed; start a new campaign");
    }
  }
  console.error(`Results: ${outDir}`);

  const evidencePlan = { ...admissionPlan, variants };
  const taskIds = new Set(tasks.map((task) => task.id));
  const runRecords = await store.loadRuns();
  validateRuns(evidencePlan, taskIds, runRecords);
  validateAttempts(evidencePlan, taskIds, await store.loadAttempts());
  validateJudgeAttempts(evidencePlan, taskIds, await store.loadJudgeAttempts());
  const scoreRecords = await store.loadScores();
  validateScores(evidencePlan, taskIds, scoreRecords);
  const results: JudgeCandidate[] = runRecords.map((run) => ({ variant: run.variant, task: run.task, repeat: run.repeat, summary: run.summary }));
  const completed = new Set(runRecords.map(runKey));
  const pending = args.operation !== "rescore" && Array.from({ length: args.repeats }, (_, repeat) => repeat)
    .some((repeat) => tasks.some((task) => variants.some((variant) => !completed.has(runKey({ variant: variant.id, task: task.id, repeat })))));
  if (pending) requireCampaignSource(recordedSource, runningSource);

  if (args.operation !== "rescore") {
    const ctx: CellContext = { deps, seat, registry, explorer, facetBrief };
    for (let repeat = 0; repeat < args.repeats; repeat++) {
      for (const task of PLAN_TASKS) {
        for (const variant of variants) {
          const key = runKey({ variant: variant.id, task: task.id, repeat });
          if (completed.has(key)) continue;
          const label = `${variant.id}/${task.id}/${repeat}`;
          console.error(`Running ${label}...`);
          let outcome: CellOutcome;
          try {
            outcome = await runCell(ctx, task, variant.id, label);
          } catch (error) {
            if (!(error instanceof PersonaTaskFailure)) throw error;
            const attempt: AttemptRecord = {
              kind: "agent-run-attempt",
              attemptId: crypto.randomUUID(),
              persona,
              mode: "research",
              variant: variant.id,
              model: variant.model,
              effort: variant.effort,
              task: task.id,
              repeat,
              at: new Date().toISOString(),
              durationMs: error.accounting.durationMs,
              terminal: error.terminal,
              accounting: error.accounting.accounting,
            };
            await store.appendAttempt(attempt);
            throw error;
          }
          const record: ResearchRunRecord = {
            kind: "agent-run", mode: "research", persona,
            variant: variant.id, model: variant.model, effort: variant.effort,
            task: task.id, repeat, ...outcome,
          };
          await store.appendRun(record);
          results.push({ variant: variant.id, task: task.id, repeat, summary: outcome.summary });
          completed.add(key);
          const estimated = outcome.accounting.estimatedUsd.kind === "observed" ? `$${outcome.accounting.estimatedUsd.value.toFixed(4)}` : "estimated spend unavailable";
          const tokens = outcome.accounting.tokens.kind === "observed" ? `${outcome.accounting.tokens.value} tokens` : "tokens unavailable";
          console.error(`  ${estimated}, ${tokens}, ${outcome.durationMs} ms`);
        }
      }
    }
  }

  console.error("Judging blinded summary pairs...");
  const existingVerdicts = scoreRecords.filter((record) => record.kind === "pair-score").map((record) => record.verdict);
  const verdicts = await judgePairs(results, new Map(tasks.map((task) => [task.id, task.prompt])), await admission.createJudge(ROLE_MODEL_DEFAULTS["benchmark-judge"].openai.model, undefined, ROLE_MODEL_DEFAULTS["benchmark-judge"].openai.effort, join(outDir, "judge-requests")), undefined, buildPlanJudgePrompt, {
    existing: existingVerdicts,
    onSettled: ({ value, error }) => error === null
      ? store.appendScore({ kind: "pair-score", mode: "research", persona, verdict: value, error })
      : Promise.resolve(),
    onAttempt: (report) => store.appendJudgeAttempt({
      kind: "judge-attempt",
      attemptId: crypto.randomUUID(),
      at: new Date().toISOString(),
      persona,
      mode: "research",
      score: report.score,
      terminal: report.terminal,
      accounting: report.accounting,
    }),
  });
  const [settledScores, judgeAttempts] = await Promise.all([store.loadScores(), store.loadJudgeAttempts()]);
  const failures = failedJudgeCallCount(
    judgeAttempts.map((attempt) => judgeScoreIdentityKey(attempt.score)),
    settledScores.map(scoreRecordIdentityKey),
  );

  const runResults = (await store.loadRuns()).map((run) => ({ variant: run.variant, task: run.task, repeat: run.repeat, accounting: run.accounting, durationMs: run.durationMs, summary: run.summary }));
  const attempts = await store.loadAttempts();
  await store.writeArtifact("raw.json", `${JSON.stringify(runResults, null, 2)}\n`);
  const report = renderReport({ persona, variants }, tasks, runResults, verdicts, stamp, {
    failedJudgeCalls: failures,
    unsuccessfulAttempts: attempts.length,
    ...unsuccessfulOverhead(attempts),
    ...judgeOverhead(judgeAttempts),
  });
  await store.writeArtifact("report.md", report);
  console.error(`Report: ${join(outDir, "report.md")}`);
  console.log(report);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
