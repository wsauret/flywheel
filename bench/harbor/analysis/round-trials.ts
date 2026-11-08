import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { HarborBenchmark } from "../benchmarks.js";
import { UNLAUNCHED_OUTCOMES, type Round, type RoundRun } from "../rounds.js";
import { isJsonMap, isMissingFile, jsonMap, readJsonFile, readOptionalJson, text, type JsonMap } from "./json.js";

/** How a round's trial counts toward its score. */
type TrialStanding =
  /** Scored: its reward decides pass or fail. */
  | "scored"
  /** Infrastructure ended it before its work could be graded: not scored, rerun. */
  | "infra"
  /** Its grader never graded it: not scored, rerun. */
  | "grader_lost";

/** One trial of one run of a round. */
export interface RoundTrial {
  readonly id: string;
  /** The bare task name, without the benchmark's task namespace. */
  readonly task: string;
  readonly reward: number | null;
  readonly cost: number;
  readonly standing: TrialStanding;
  /** The trial's artifact directory, when the run downloaded it. */
  readonly directory?: string;
  readonly run: RoundRun;
}

/** Ledger categories whose trials infrastructure ended before any grade. */
const INFRA_CATEGORIES = new Set(["provider_infra", "other"]);
/** The ledger category of a trial whose grader never graded it. */
const GRADER_LOST_CATEGORY = "verifier_infra";

function object(value: unknown): JsonMap | undefined {
  return isJsonMap(value) ? value : undefined;
}

async function entries(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    if (isMissingFile(error)) return [];
    throw error;
  }
}

/** Every trial directory of a run by trial id: the entries of the Harbor job
 *  directory that the run's preparation plan names as `trials_directory`,
 *  which a local run writes and a hosted run downloads. */
async function trialDirectories(runDirectory: string): Promise<Map<string, string>> {
  const where = join(runDirectory, "preparation-plan.json");
  const trials = text(jsonMap(await readJsonFile(where), where).trials_directory, `${where} trials_directory`);
  return new Map((await entries(trials)).map((trial) => [trial, join(trials, trial)]));
}

/** The bare task name of a qualified one, such as `kv-store-grpc` of `terminal-bench/kv-store-grpc`. */
export function bareTask(benchmark: HarborBenchmark, task: string): string {
  return task.startsWith(`${benchmark.taskNamespace}/`) ? task.slice(benchmark.taskNamespace.length + 1) : task;
}

const DOWNLOAD_FAILURE = /uvx: command not found|failed to download https:\/\/github\.com\//i;
const TEST_SUMMARY = /^=+ .*\b(passed|failed|error)/m;

/** The GitHub-download rule of a grader that installs its tools from GitHub:
 *  a failed download and no test summary mean that no test ran. A round
 *  finalized before the ledger had the grader-lost category needs it. */
async function githubDownloadLost(directory: string | undefined): Promise<boolean> {
  if (directory === undefined) return false;
  let output: string;
  try {
    output = await readFile(join(directory, "verifier", "test-stdout.txt"), "utf8");
  } catch (error) {
    if (isMissingFile(error)) return false;
    throw error;
  }
  return DOWNLOAD_FAILURE.test(output) && !TEST_SUMMARY.test(output);
}

function reward(result: JsonMap | undefined): number | null {
  const value = object(object(result?.verifier_result)?.rewards)?.reward;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Every trial of one run: the rows of its disclosure ledger, then each
 *  downloaded trial that the ledger refused for missing evidence but whose
 *  verifier gave a reward, which the board scores by that reward. A run
 *  without a ledger has not finished and adds nothing. */
async function runTrials(benchmark: HarborBenchmark, run: RoundRun): Promise<RoundTrial[]> {
  const stored = await readOptionalJson(join(run.directory, "disclosure-ledger.json"));
  if (stored === undefined) return [];
  const rows = object(stored)?.rows;
  if (!Array.isArray(rows)) throw new Error(`${run.directory}/disclosure-ledger.json has no rows`);
  const directories = await trialDirectories(run.directory);
  const trials: RoundTrial[] = [];
  const seen = new Set<string>();
  for (const raw of rows) {
    const row = object(raw);
    if (typeof row?.id !== "string" || typeof row.task !== "string") throw new Error(`${run.directory}/disclosure-ledger.json holds a row without id or task`);
    const score = typeof row.reward === "number" ? row.reward : null;
    const directory = directories.get(row.id);
    const category = typeof row.category === "string" ? row.category : undefined;
    // A negative reward is the grader's own report that it crashed, on every benchmark.
    const lost = category === GRADER_LOST_CATEGORY || (score !== null && score < 0) || (benchmark.verifierDownloadsFromGithub && await githubDownloadLost(directory));
    const standing: TrialStanding = category !== undefined && INFRA_CATEGORIES.has(category) ? "infra" : lost ? "grader_lost" : "scored";
    trials.push({ id: row.id, task: bareTask(benchmark, row.task), reward: score, cost: typeof row.cost === "number" ? row.cost : 0, standing, ...(directory === undefined ? {} : { directory }), run });
    seen.add(row.id);
  }
  for (const [id, directory] of directories) {
    if (seen.has(id)) continue;
    const result = object(await readOptionalJson(join(directory, "result.json")));
    const score = reward(result);
    if (score === null || typeof result?.task_name !== "string") continue;
    const lost = score < 0 || (benchmark.verifierDownloadsFromGithub && await githubDownloadLost(directory));
    trials.push({ id, task: bareTask(benchmark, result.task_name), reward: score, cost: 0, standing: lost ? "grader_lost" : "scored", directory, run });
  }
  return trials;
}

/** The tasks that the round measured, by split: the bare task names of each
 *  measure run's manifest. The manifests are the record of what ran, so a
 *  split that the round did not measure, or whose run ended before Harbor ran
 *  any trial, has no entry. */
export async function measuredSplits(benchmark: HarborBenchmark, round: Round): Promise<Map<string, string[]>> {
  const unlaunched: ReadonlySet<unknown> = new Set(UNLAUNCHED_OUTCOMES);
  const splits = new Map<string, string[]>();
  for (const run of round.runs) {
    if (run.purpose !== "measure" || run.split === undefined) continue;
    const manifest = jsonMap(await readJsonFile(join(run.directory, "run_manifest.json")), `${run.directory}/run_manifest.json`);
    if (manifest.state === "refused" && unlaunched.has(manifest.outcome)) continue;
    const names = manifest.task_names;
    if (!Array.isArray(names) || !names.every((name) => typeof name === "string")) throw new Error(`${run.directory}/run_manifest.json has no task_names`);
    const tasks = splits.get(run.split) ?? [];
    for (const name of names) if (!tasks.includes(bareTask(benchmark, name))) tasks.push(bareTask(benchmark, name));
    splits.set(run.split, tasks);
  }
  return splits;
}

/** Every trial of every run of the round, in the round's run order. */
export async function roundTrials(benchmark: HarborBenchmark, round: Round): Promise<RoundTrial[]> {
  return (await Promise.all(round.runs.map((run) => runTrials(benchmark, run)))).flat();
}
