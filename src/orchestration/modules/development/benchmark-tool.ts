/**
 * Model A/B persona benchmark as a runtime tool.
 *
 * The tool owns exactly two things: the argument conversation with the model
 * and the launch acknowledgement. The benchmark service owns the run.
 *
 * An embedded run admits its matrix through the shared
 * benchmark admission for preflight; each provider request resolves again. The run
 * uses the source service's confined worker backend for native candidates and
 * rides the host's background execution owner, which admits this call, and it is
 * tracked in the host's one background registry, so listing, stopping, waiting
 * and the completion notification all use the existing paths.
 */

import { basename } from "node:path";
import { mergeAbortSignals } from "../../../infra/abort.js";
import { stripControlCharacters } from "../../../infra/control-characters.js";
import { errorMessage } from "../../../infra/error-message.js";
import { Log } from "../../../infra/log.js";
import { EFFORT_VALUES } from "../../../infra/workflow-types.js";
import { admitBenchmark, benchmarkModelSeats, benchmarkPreflightReport, personaCampaignJudge, type BenchmarkAdmission, type JudgeSelection, type BenchmarkAdmissionDeps, type ProviderPlanReport } from "./benchmark/admission.js";
import { createBenchmarkCatalog, type BenchmarkCatalog } from "./benchmark/catalog.js";
import { runningSourceIdentity } from "./benchmark/content-identity.js";
import {
  loadBenchmarkPersona,
  planPersonaBenchmark,
  runPersonaBenchmark,
  type BenchmarkEvent,
  type BenchmarkOptions,
  type BenchmarkOutcome,
  type BenchmarkPlan,
} from "./benchmark/persona-benchmark.js";
import { formatOverheadAccounting } from "./benchmark/report-accounting.js";
import { variantSeat, type VariantSpec } from "./benchmark/variant.js";
import type { BackgroundWorkResult } from "../../agent-runtime/background-work.js";
import { toolCallIdentity, type RuntimeTool, type ToolContext, type ToolResult } from "../../agent-runtime/tools/types.js";

interface BenchmarkInput {
  [key: string]: unknown;
}

const log = Log.create({ service: "benchmark-tool" });

/** A results directory name: one path segment, no parent segment. The catalog
 *  resolves it against the results directory and enforces containment. */
const RESULT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const RUN_FIELDS: ReadonlySet<string> = new Set(["action", "persona", "variants", "repeats", "dryRun", "tasks", "judge"]);
const RESUME_FIELDS: ReadonlySet<string> = new Set(["action", "resultId", "dryRun"]);
const VARIANT_FIELDS: ReadonlySet<string> = new Set(["model", "effort"]);

const BENCHMARK_INPUT_SCHEMA = {
  type: "object",
  properties: {
    action: {
      enum: ["run", "resume"],
      description: "run starts a new benchmark; resume continues the cells and scores an existing results directory still owes.",
    },
    persona: {
      type: "string",
      description: "run only: the name of the subagent persona under test.",
    },
    variants: {
      type: "array",
      items: {
        type: "object",
        properties: {
          model: { type: "string", description: "The model id this seat runs on." },
          effort: { enum: [...EFFORT_VALUES], description: "The reasoning effort this seat runs at." },
        },
        required: ["model", "effort"],
        additionalProperties: false,
      },
      description: "run only: authored model and effort settings to compare. When omitted, one seat follows the persona role in the current profile. Pairwise judging needs at least two seats. Unreachable settings follow role policy.",
    },
    repeats: {
      type: "integer",
      description: "run only: how many times each seat runs each task. Pass 1 for one pass.",
    },
    tasks: {
      type: "array",
      items: { type: "string" },
      description: "run only: the task or fixture IDs to run. When omitted, every task of the persona's suite runs.",
    },
    judge: {
      type: "object",
      properties: {
        model: { type: "string", description: "The model id that judges every cell." },
        effort: { enum: [...EFFORT_VALUES], description: "The reasoning effort the judge runs at." },
      },
      required: ["model", "effort"],
      additionalProperties: false,
      description: "run only: pins the judge instead of the profile's benchmark-judge role. It may share a candidate's model; the dry run and the report name the candidates that do.",
    },
    dryRun: {
      type: "boolean",
      description: "Report the planned matrix and stop. No provider request is made and no results directory is written.",
    },
    resultId: {
      type: "string",
      description: "resume only: the results directory name a previous launch reported, such as \"<persona>-2026-08-08T04-50-28-280Z\".",
    },
  },
  required: ["action", "dryRun"],
  additionalProperties: false,
} as const;

const BENCHMARK_DESCRIPTION = `Run the model A/B benchmark for one subagent persona against this project's benchmark fixtures, or resume one that stopped. Every cell is a real persona run, so a benchmark costs real provider spend and takes many minutes; launch one only when the user asked for benchmark evidence.

Use { action: "run", persona, variants, repeats, dryRun } for a new matrix, with optional tasks and judge, and { action: "resume", resultId, dryRun } to finish a matrix that was stopped or that had failing cells. Pass dryRun: true first to report the planned matrix without spending anything.`;

const BENCHMARK_PROMPT_GUIDELINES = [
  "A benchmark is evidence gathering, not implementation. Do not launch one to test a code change; run the project's tests instead.",
  "Pairwise judging compares seats, so pass at least two variants for a research or implement persona.",
  "The launch returns immediately. The report arrives in a hidden benchmark_notification; if everything left depends on it, call process with { action: \"wait\" }.",
  "A stopped or partly failed matrix is resumable: resume it with its resultId rather than starting a second matrix.",
];

interface BenchmarkRequest {
  options: BenchmarkOptions;
  dryRun: boolean;
}

function rejectExtraFields(input: BenchmarkInput, action: string, allowed: ReadonlySet<string>): void {
  const extra = Object.keys(input).filter((key) => !allowed.has(key));
  if (extra.length === 0) return;
  throw new Error(`benchmark action '${action}' does not accept: ${extra.join(", ")}. The two actions take disjoint fields; pass only the ones this action documents.`);
}

function requireString(input: BenchmarkInput, field: string, action: string): string {
  const value = input[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`benchmark action '${action}' requires a non-empty ${field} string.`);
  }
  return value;
}

function requireSeat(entry: unknown): VariantSpec {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error("benchmark variants must each be an object with a model and an effort.");
  }
  const fields = new Map<string, unknown>(Object.entries(entry));
  const extra = [...fields.keys()].filter((key) => !VARIANT_FIELDS.has(key));
  if (extra.length > 0) {
    throw new Error(`benchmark variant does not accept: ${extra.join(", ")}. A seat names only model and effort; provider routing, credentials and paths are not the caller's to state.`);
  }
  const model = fields.get("model");
  const effort = fields.get("effort");
  if (typeof model !== "string" || model.trim().length === 0) throw new Error("benchmark variant requires a non-empty model string.");
  if (typeof effort !== "string") throw new Error(`benchmark variant "${model}" requires an effort string.`);
  return variantSeat(model, effort);
}

function requireVariants(value: unknown): readonly VariantSpec[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("benchmark action 'run' requires variants: a non-empty array of { model, effort } seats.");
  }
  return value.map(requireSeat);
}

function requireTasks(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((id) => typeof id === "string" && id.trim().length > 0)) {
    throw new Error("benchmark tasks must be a non-empty array of task ID strings.");
  }
  return value;
}

function requireJudge(value: unknown): JudgeSelection {
  const { model, effort } = requireSeat(value);
  return { model, effort };
}

function requireRepeats(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    throw new Error("benchmark repeats must be a positive integer.");
  }
  return value;
}

function requireDryRun(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("benchmark dryRun must be a boolean: true reports the planned matrix, false runs it.");
  return value;
}

function resultsDirFor(catalog: BenchmarkCatalog, resultId: string): string {
  if (!RESULT_ID.test(resultId) || resultId.includes("..")) {
    throw new Error(`benchmark resultId '${resultId}' must name one results directory: letters, digits, dot, dash or underscore, with no path separator.`);
  }
  return catalog.resultsDirById(resultId);
}

function parseRequest(input: BenchmarkInput, catalog: BenchmarkCatalog): BenchmarkRequest {
  const action = input.action;
  if (action === "run") {
    rejectExtraFields(input, "run", RUN_FIELDS);
    return {
      options: {
        persona: requireString(input, "persona", "run"),
        variants: requireVariants(input.variants),
        operation: "run",
        repeats: requireRepeats(input.repeats),
        ...(input.tasks === undefined ? {} : { taskIds: requireTasks(input.tasks) }),
        ...(input.judge === undefined ? {} : { judge: requireJudge(input.judge) }),
      },
      dryRun: requireDryRun(input.dryRun),
    };
  }
  if (action === "resume") {
    rejectExtraFields(input, "resume", RESUME_FIELDS);
    return {
      options: {
        // Every matrix field of a resume comes from the stored run config.
        variants: [],
        operation: "resume",
        resultsDir: resultsDirFor(catalog, requireString(input, "resultId", "resume")),
      },
      dryRun: requireDryRun(input.dryRun),
    };
  }
  throw new Error("benchmark requires action to be 'run' or 'resume'.");
}

function launchResult(input: {
  plan: BenchmarkPlan;
  taskId: string;
  resultId: string;
  dryRun: boolean;
  providerPlans: readonly ProviderPlanReport[];
}): string {
  return JSON.stringify({
    status: "started",
    taskId: input.taskId,
    operation: input.plan.operation,
    resultId: input.resultId,
    dryRun: input.dryRun,
    providerPlans: input.providerPlans,
  }, null, 2);
}

/** What a dry run reports: the matrix a real run would execute. It builds no
 *  client, makes no provider request, and writes no results file. */
function plannedMatrixResult(plan: BenchmarkPlan, admission: BenchmarkAdmission): BackgroundWorkResult {
  return {
    status: "completed",
    content: JSON.stringify(benchmarkPreflightReport(plan, admission.providerPlans), null, 2),
  };
}

/** The terminal notification: where the report is, and what it owes. The report
 *  body itself stays on disk; a notification is a pointer, not a transcript. */
function completionResult(outcome: BenchmarkOutcome, resultId: string): BackgroundWorkResult {
  if (outcome.status === "cancelled") {
    return {
      status: "failed",
      content: `Benchmark ${resultId} was stopped before it produced a report. Its partial results are in ${outcome.resultsDir}; resume it with benchmark { action: "resume", resultId: "${resultId}", dryRun: false }.`,
    };
  }
  return {
    status: "completed",
    content: [
      `Benchmark ${resultId} completed. Report: ${outcome.reportPath}.`,
      `Failed judge calls: ${outcome.counts.failedJudgeCalls}. Unsuccessful cell attempts: ${outcome.counts.unsuccessfulAttempts}.`,
      `Judge overhead, separate from the candidate comparison: ${formatOverheadAccounting(outcome.counts.judgeAccounting)}, with ${outcome.counts.judgeAccountingUnavailable} judge call(s) whose accounting was unavailable.`,
    ].join(" "),
  };
}

function failureResult(error: unknown, plan: BenchmarkPlan, resultId: string): BackgroundWorkResult {
  return {
    status: "failed",
    content: `Benchmark ${resultId} failed: ${errorMessage(error)}. Whatever it completed stays in ${plan.resultsDir}; resume it with benchmark { action: "resume", resultId: "${resultId}", dryRun: false }.`,
  };
}

/** Bounds for the streamed tail: how many lines it retains and how long one
 *  line can be. Events are one line each, but a cell failure embeds an
 *  arbitrary error message, so each line is normalized and truncated before
 *  it can grow the durable output payload without bound. */
const PROGRESS_TAIL_LINES = 200;
const PROGRESS_LINE_CHARS = 400;

function cellLabel(cell: { variant: string; task: string; repeat: number }): string {
  // Stored repeat indices are zero-based; readers count runs from one.
  return `${cell.variant} / ${cell.task} #${cell.repeat + 1}`;
}

function boundedLine(text: string): string {
  const flat = stripControlCharacters(text.replace(/\s+/g, " ")).trim();
  return flat.length > PROGRESS_LINE_CHARS ? `${flat.slice(0, PROGRESS_LINE_CHARS)}...` : flat;
}

function progressLine(event: BenchmarkEvent): string {
  switch (event.kind) {
    case "benchmark.started": return `matrix started: ${event.pendingCells} pending cell(s), results in ${event.resultsDir}`;
    case "cell.started": return `cell started: ${cellLabel(event.cell)}`;
    case "cell.completed": {
      const acceptance = event.acceptance ? `, acceptance ${event.acceptance.passed}/${event.acceptance.total}` : "";
      const estimated = event.accounting.estimatedUsd.kind === "observed" ? `$${event.accounting.estimatedUsd.value.toFixed(4)}` : "estimated spend unavailable";
      const tokens = event.accounting.tokens.kind === "observed" ? `${event.accounting.tokens.value} tokens` : "tokens unavailable";
      return `cell completed: ${cellLabel(event.cell)} in ${Math.round(event.durationMs / 1000)}s, ${estimated}, ${tokens}${acceptance}`;
    }
    case "cell.failed": return `cell failed: ${cellLabel(event.cell)}: ${event.message}`;
    case "scoring.started": return `scoring started: ${event.phase}`;
    case "scoring.skipped": return `scoring skipped: ${event.phase} (${event.reason})`;
    case "benchmark.completed": return `benchmark completed: report at ${event.reportPath}`;
    case "benchmark.cancelled": return `benchmark cancelled: partial results in ${event.resultsDir}`;
  }
}

interface ProgressTail {
  record: (event: BenchmarkEvent) => void;
  /** Carries the accumulated tail on the settlement result so the durable
   *  transcript row keeps the same lines the live row streamed. */
  attach: (result: BackgroundWorkResult) => BackgroundWorkResult;
}

/** Accumulates one line per benchmark event and publishes the bounded tail on
 *  the registry's live execution-output channel, the same path a backgrounded
 *  command's log tail uses. */
function createProgressTail(publish: (tail: string) => void): ProgressTail {
  const lines: string[] = [];
  return {
    record: (event) => {
      lines.push(boundedLine(progressLine(event)));
      if (lines.length > PROGRESS_TAIL_LINES) lines.splice(0, lines.length - PROGRESS_TAIL_LINES);
      publish(lines.join("\n"));
    },
    attach: (result) => (lines.length > 0 ? { ...result, executionOutputTail: lines.join("\n") } : result),
  };
}

async function launch(deps: BenchmarkAdmissionDeps, input: BenchmarkInput, context: ToolContext): Promise<ToolResult> {
  let request: BenchmarkRequest;
  let plan: BenchmarkPlan;
  let catalog: BenchmarkCatalog;
  let admission: BenchmarkAdmission;
  let judge: ReturnType<typeof personaCampaignJudge>;
  try {
    catalog = createBenchmarkCatalog(context.executionCwd);
    request = parseRequest(input, catalog);
    plan = await planPersonaBenchmark(request.options, catalog);
    const { persona } = await loadBenchmarkPersona(plan, catalog, deps);
    admission = await admitBenchmark(deps, benchmarkModelSeats(plan, persona.role));
    judge = personaCampaignJudge(admission);
  } catch (error) {
    return { content: errorMessage(error), outcome: "error" };
  }

  const tasks = context.backgroundTasks;
  if (!tasks) {
    return {
      content: "benchmark was not started: this runtime has no background task registry, so nothing would track, stop, or report the run.",
      outcome: "error",
    };
  }

  const resultId = basename(plan.resultsDir);
  const taskIdPrefix = `benchmark:${resultId}:`;
  if (tasks.processRecords().some(({ id, kind, status }) =>
    kind === "benchmark"
    && id.startsWith(taskIdPrefix)
    && (status === "running" || status === "stopping"))) {
    return { content: `benchmark was not started: benchmark-${resultId} is already active`, outcome: "error" };
  }
  const taskId = `${taskIdPrefix}${crypto.randomUUID()}`;
  // One cancellation path: a targeted stop, host teardown, and run disposal all
  // reach the service through this signal, and the service settles every cell,
  // judge call and command it owns before it returns.
  const controller = new AbortController();
  const signal = context.backgroundSignal
    ? mergeAbortSignals(context.backgroundSignal, controller.signal)
    : controller.signal;
  const settled = Promise.withResolvers<BackgroundWorkResult>();
  const toolUseId = context.toolUseId;
  const progress = createProgressTail((tail) => {
    if (toolUseId) tasks.streamExecutionOutput(toolUseId, tail, toolCallIdentity(context));
  });
  const seats = plan.variants.map((variant) => variant.id).join(" vs ");
  try {
    // One run identity is one tracked task. A second launch of the same matrix
    // is refused here, before it can displace the run already in flight.
    tasks.track({
      done: settled.promise,
      meta: {
        id: taskId,
        type: "benchmark",
        description: `${plan.operation} ${plan.persona} benchmark (${seats})${request.dryRun ? " dry run" : ""}`,
        ...(toolUseId ? { toolUseId } : {}),
        ...toolCallIdentity(context),
      },
      kill: { run: () => controller.abort() },
    });
  } catch (error) {
    return { content: `benchmark was not started: ${errorMessage(error)}`, outcome: "error" };
  }
  settled.resolve(request.dryRun
    ? plannedMatrixResult(plan, admission)
    : runningSourceIdentity().then((sourceIdentity) => runPersonaBenchmark(plan, {
        runtime: admission.runtime,
        catalog,
        ...judge,
        onEvent: (event: BenchmarkEvent) => {
          log.info("benchmark progress", { resultId, event: event.kind });
          progress.record(event);
        },
        signal,
        sourceIdentity,
      })).then(
        (outcome) => progress.attach(completionResult(outcome, resultId)),
        (error) => progress.attach(failureResult(error, plan, resultId)),
      ));

  return {
    content: launchResult({ plan, taskId, resultId, dryRun: request.dryRun, providerPlans: admission.providerPlans }),
    outcome: "ok",
  };
}

export function createBenchmarkTool(deps: BenchmarkAdmissionDeps): RuntimeTool {
  return {
    name: "benchmark",
    action: "benchmark_run",
    description: BENCHMARK_DESCRIPTION,
    promptGuidelines: BENCHMARK_PROMPT_GUIDELINES,
    inputSchema: BENCHMARK_INPUT_SCHEMA,
    execution: { mode: "background", traceKind: "tool" },
    // execute() only validates, admits and launches; the matrix itself runs as a
    // tracked background task, so the launch shares the concurrency gate freely.
    isConcurrencySafe: true,
    validatesOwnInput: true,
    execute: (input, context) => launch(deps, input, context),
  };
}
