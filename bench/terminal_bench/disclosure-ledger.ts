import { readdir, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { decodeTrialStoreAnalysis, TRIAL_STORE_ANALYSIS_NAME, type TrialStoreAnalysis } from "./trial-store-analysis.js";

type LedgerCategory = "provider_infra" | "cancelled" | "cost_truncated" | "genuine" | "other";
type RunOutcome = "completed" | "no_scored_trials" | "trials_unverified" | "harness_nonzero_exit";
type JsonMap = Record<string, unknown>;

interface LedgerRow { id: string; task: string; reward: number | null; category?: LedgerCategory; cost: number }
export interface DisclosureLedger {
  denominator: number;
  scoredTrials: number;
  rewardDistribution: Record<string, number>;
  exceptionHistogram: Record<string, number>;
  taskPassRates: Record<string, { passed: number; total: number; rate: number }>;
  totalCost: number;
  counts: Record<LedgerCategory, number>;
  outcome: RunOutcome;
  exitCode: number;
  reconciled: boolean;
  rows: LedgerRow[];
}

interface ReconcileOptions { trialsDirectory: string; taskNames?: string[]; attempts?: number; expectedTrials?: number; harborExitCode: number; infrastructureValid: boolean }
interface JsonEvidence { value?: JsonMap; present: boolean; valid: boolean }

function object(value: unknown): JsonMap | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : undefined;
}

async function json(path: string): Promise<JsonEvidence> {
  try {
    const value = object(JSON.parse(await readFile(path, "utf8")));
    return value === undefined ? { present: true, valid: false } : { value, present: true, valid: true };
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { present: false, valid: true };
    return { present: true, valid: false };
  }
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function reward(result: JsonMap | undefined): number | null | undefined {
  const rewards = object(object(result?.verifier_result)?.rewards);
  const value = rewards?.reward;
  if (value === null) return null;
  return numeric(value);
}

function exceptionType(result: JsonMap | undefined): string | undefined {
  const value = object(result?.exception_info)?.exception_type;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Whether Harbor ended a trial at its agent timeout. Harbor stops the agent
 *  at that deadline before the shim can write its run summary, so such a
 *  trial is cancelled evidence without a summary, not missing evidence. */
export function isAgentTimeout(result: JsonMap | undefined): boolean {
  return exceptionType(result) === "AgentTimeoutError";
}

/** The store analysis that the trial recorded, or undefined when it recorded
 *  none it can decode. The tool outcome analyzer refuses such a trial, so here
 *  it only lacks the evidence that the analysis would add. */
async function storeAnalysis(directory: string): Promise<TrialStoreAnalysis | undefined> {
  try {
    return decodeTrialStoreAnalysis(JSON.parse(await readFile(join(directory, "agent", TRIAL_STORE_ANALYSIS_NAME), "utf8")));
  } catch {
    return undefined;
  }
}

function failureCategory(result: JsonMap | undefined, summary: JsonMap | undefined, analysis: TrialStoreAnalysis | undefined, score: number | null): LedgerCategory | undefined {
  if (typeof score === "number" && score > 0) return undefined;
  const exception = exceptionType(result);
  const outcome = analysis?.finalRequestOutcome;
  if ((exception !== undefined && !exception.toLowerCase().includes("timeout")) || outcome === "stream_error" || outcome === "fatal_error") return "provider_infra";
  if (exception?.toLowerCase().includes("timeout") === true || summary?.captured_after_cancellation === true || outcome === "aborted") return "cancelled";
  if (outcome === "context_overflow" || outcome === "output_overflow") return "cost_truncated";
  return score === 0 ? "genuine" : "other";
}

async function resultPaths(root: string): Promise<string[]> {
  // Harbor writes a job-level result.json beside the trial directories; only
  // <root>/<trial>/result.json rows are trial evidence, so collect exactly that
  // depth instead of walking the whole tree (trial artifacts may nest their own
  // result.json files, and the job-level file has no trial identity).
  const found: string[] = [];
  // Enumeration failures propagate: an unreadable root is evidence the run
  // cannot be inspected, and the finalize caller downgrades a reconcile throw
  // to trials_unverified. Substituting [] here would report reconciled empty
  // evidence for a directory that was never read.
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
    const trialDirectory = join(root, entry.name);
    const candidates = await readdir(trialDirectory, { withFileTypes: true });
    for (const candidate of candidates) {
      if (!candidate.isSymbolicLink() && candidate.isFile() && candidate.name === "result.json") found.push(join(trialDirectory, candidate.name));
    }
  }
  return found.sort();
}

export async function reconcileDisclosureLedger(options: ReconcileOptions): Promise<DisclosureLedger> {
  const tasks = options.taskNames ?? [];
  const attempts = options.attempts ?? (tasks.length === 0 ? options.expectedTrials ?? 0 : 0);
  const denominator = tasks.length === 0 ? options.expectedTrials ?? 0 : tasks.length * attempts;
  if (!Number.isInteger(denominator) || denominator < 0 || !Number.isInteger(attempts) || attempts < 0) throw new Error("trial denominator must be a non-negative integer");
  const expectedTasks = new Set(tasks);
  const root = resolve(options.trialsDirectory);
  const rows: LedgerRow[] = [];
  const seenTrials = new Set<string>();
  const taskCounts = new Map<string, number>();
  const exceptionHistogram: Record<string, number> = {};
  let evidenceValid = true;
  for (const resultPath of await resultPaths(root)) {
    const canonical = resolve(resultPath);
    if (!canonical.startsWith(`${root}${sep}`)) throw new Error("trial evidence escaped the run-owned output root");
    const directory = resolve(canonical, "..");
    const resultEvidence = await json(canonical);
    const summaryEvidence = await json(join(directory, "agent", "flywheel-run-summary.json"));
    const result = resultEvidence.value;
    const task = result?.task_name;
    const trialName = result?.trial_name;
    const score = reward(result);
    const summaryAdmitted = summaryEvidence.present ? summaryEvidence.valid : isAgentTimeout(result);
    const valid = resultEvidence.present && resultEvidence.valid && summaryAdmitted && typeof task === "string" && task.length > 0 && typeof trialName === "string" && trialName.length > 0 && score !== undefined;
    evidenceValid &&= valid;
    if (!valid || typeof task !== "string" || typeof trialName !== "string" || score === undefined) continue;
    if (seenTrials.has(trialName) || (expectedTasks.size > 0 && !expectedTasks.has(task))) evidenceValid = false;
    seenTrials.add(trialName);
    taskCounts.set(task, (taskCounts.get(task) ?? 0) + 1);
    const exception = exceptionType(result);
    if (exception !== undefined) exceptionHistogram[exception] = (exceptionHistogram[exception] ?? 0) + 1;
    const analysis = await storeAnalysis(directory);
    const category = failureCategory(result, summaryEvidence.value, analysis, score);
    const cost = numeric(object(result?.agent_result)?.cost_usd) ?? analysis?.estimatedCostUsd ?? 0;
    rows.push({ id: trialName, task, reward: score, ...(category === undefined ? {} : { category }), cost });
  }
  if (expectedTasks.size > 0 && [...expectedTasks].some((task) => taskCounts.get(task) !== attempts)) evidenceValid = false;
  if (expectedTasks.size === 0 && rows.length !== denominator) evidenceValid = false;
  const counts: Record<LedgerCategory, number> = { provider_infra: 0, cancelled: 0, cost_truncated: 0, genuine: 0, other: 0 };
  const rewardDistribution: Record<string, number> = {};
  const taskPassRates: DisclosureLedger["taskPassRates"] = {};
  let totalCost = 0;
  for (const row of rows) {
    const rewardKey = row.reward === null ? "null" : String(row.reward);
    rewardDistribution[rewardKey] = (rewardDistribution[rewardKey] ?? 0) + 1;
    if (row.category !== undefined) counts[row.category] += 1;
    totalCost += row.cost;
    const rate = taskPassRates[row.task] ?? { passed: 0, total: 0, rate: 0 };
    rate.total += 1;
    if ((row.reward ?? 0) > 0) rate.passed += 1;
    rate.rate = rate.passed / rate.total;
    taskPassRates[row.task] = rate;
  }
  const reconciled = options.infrastructureValid && evidenceValid && rows.length === denominator;
  const scoredTrials = rows.filter((row) => typeof row.reward === "number").length;
  const outcome: RunOutcome = options.harborExitCode !== 0 ? "harness_nonzero_exit" : !reconciled ? "trials_unverified" : scoredTrials === 0 ? "no_scored_trials" : "completed";
  const exitCode = options.harborExitCode !== 0 ? options.harborExitCode : outcome === "completed" ? 0 : 1;
  return { denominator, scoredTrials, rewardDistribution, exceptionHistogram, taskPassRates, totalCost, counts, outcome, exitCode, reconciled, rows };
}