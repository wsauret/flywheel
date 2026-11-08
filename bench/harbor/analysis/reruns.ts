import { dirname, join, resolve } from "node:path";
import type { HarborBenchmark } from "../benchmarks.js";
import { UNLAUNCHED_OUTCOMES, type Round, type RoundRun } from "../rounds.js";
import { BOARD_ATTEMPTS } from "./board-scoring.js";
import { jsonMap, readJsonFile, strings, text } from "./json.js";
import { bareTask, type RoundTrial } from "./round-trials.js";

/** Reruns that one lost attempt can have, the board's rule
 *  (`INFRA_RETRY_ROUNDS`): a slot that infrastructure or a lost grader left
 *  unscored runs again as a new trial at most twice. */
const MAX_RERUNS = 2;

/** Manifest states of a run that wrote its ledger, reconciled or not. */
const FINISHED_STATES = new Set(["finalized", "refused"]);

export interface RerunNeed {
  readonly task: string;
  /** Attempts that the round's measurements planned for the task. */
  readonly planned: number;
  readonly scored: number;
  /** Planned attempts that no scored attempt fills. */
  readonly missing: number;
  /** Attempts that the round's rerun runs already ran for the task. */
  readonly rerunAttempts: number;
  /** Attempts that the next rerun may run: the open slots that have had fewer than MAX_RERUNS reruns. */
  readonly allowed: number;
}

/** A run of the round that ended before Harbor ran any trial, with its manifest outcome. */
interface UnlaunchedRun { readonly run: RoundRun; readonly outcome: string }

/** What rerun planning finds in a round. */
export interface RerunPlan {
  readonly needs: readonly RerunNeed[];
  /** Runs that measured nothing and so add no planned attempt: a fresh measure run of the split is their remedy. */
  readonly unlaunched: readonly UnlaunchedRun[];
}

interface RunPlan { readonly run: RoundRun; readonly state: string; readonly outcome: unknown; readonly tasks: readonly string[]; readonly attempts: number }

const UNLAUNCHED: ReadonlySet<unknown> = new Set(UNLAUNCHED_OUTCOMES);

/** The state, outcome, tasks, and attempts that a run's manifest records. */
async function runPlan(benchmark: HarborBenchmark, run: RoundRun): Promise<RunPlan> {
  const where = `${run.directory}/run_manifest.json`;
  const manifest = jsonMap(await readJsonFile(where), where);
  if (typeof manifest.attempts !== "number") throw new Error(`${where} records no attempts`);
  return { run, state: text(manifest.state, `${where} state`), outcome: manifest.outcome, tasks: strings(manifest.task_names, `${where} task_names`).map((task) => bareTask(benchmark, task)), attempts: manifest.attempts };
}

/** How a run that has not finished is settled. A run is `launched` only on
 *  Harbor Hub, after the launch; its launcher may have ended since. */
function unfinishedRun(plan: RunPlan): string {
  return plan.state === "launched" ? `${plan.run.directory} (launched; settle it with: bun bench/harbor/run-harbor.ts resume-hosted ${plan.run.directory})` : `${plan.run.directory} (${plan.state})`;
}

/** Each task of the round's measurements whose planned attempts the scored
 *  attempts do not fill, with what the rerun cap still allows. Each slot
 *  that a measurement lost carries its own rerun count: a rerun run of a
 *  task reruns its open slots with the fewest reruns, and its scored trials
 *  close those slots, so a filled slot never lends its unused rerun to
 *  another. A run that has not finished counts toward nothing, so a round
 *  with one is refused rather than planned twice. A run that ended before
 *  Harbor ran any trial plans no attempt and is reported instead. */
export async function rerunNeeds(benchmark: HarborBenchmark, round: Round, trials: readonly RoundTrial[]): Promise<RerunPlan> {
  const allPlans = await Promise.all(round.runs.map((run) => runPlan(benchmark, run)));
  const unfinished = allPlans.filter((plan) => !FINISHED_STATES.has(plan.state));
  if (unfinished.length > 0) throw new Error(`runs of ${round.name} have not finished: ${unfinished.map(unfinishedRun).join(", ")}`);
  const unlaunched = allPlans.filter((plan) => plan.state === "refused" && UNLAUNCHED.has(plan.outcome));
  const plans = allPlans.filter((plan) => !unlaunched.includes(plan));
  const scoredIn = new Map<string, number>();
  const scored = new Map<string, number>();
  for (const trial of trials) {
    if (trial.standing !== "scored") continue;
    scored.set(trial.task, (scored.get(trial.task) ?? 0) + 1);
    const key = `${trial.run.directory}\n${trial.task}`;
    scoredIn.set(key, (scoredIn.get(key) ?? 0) + 1);
  }
  const planned = new Map<string, number>();
  const measuredScored = new Map<string, number>();
  for (const plan of plans) {
    if (plan.run.purpose !== "measure") continue;
    for (const task of plan.tasks) {
      planned.set(task, (planned.get(task) ?? 0) + plan.attempts);
      measuredScored.set(task, (measuredScored.get(task) ?? 0) + (scoredIn.get(`${plan.run.directory}\n${task}`) ?? 0));
    }
  }
  // The rerun count of each open slot, by task.
  const open = new Map([...planned].map(([task, slots]) => [task, Array.from({ length: Math.max(0, slots - (measuredScored.get(task) ?? 0)) }, () => 0)]));
  const rerunAttempts = new Map<string, number>();
  for (const plan of plans) {
    if (plan.run.purpose !== "rerun") continue;
    for (const task of plan.tasks) {
      rerunAttempts.set(task, (rerunAttempts.get(task) ?? 0) + plan.attempts);
      const slots = (open.get(task) ?? []).sort((left, right) => left - right);
      const rerun = Math.min(plan.attempts, slots.length);
      for (let index = 0; index < rerun; index++) slots[index]! += 1;
      // Which rerun slot a scored trial fills is unknown; closing the least-rerun ones allows the fewest further reruns.
      slots.splice(0, Math.min(scoredIn.get(`${plan.run.directory}\n${task}`) ?? 0, rerun));
    }
  }
  const needs = [...planned].sort(([left], [right]) => left.localeCompare(right)).flatMap(([task, slots]) => {
    const done = scored.get(task) ?? 0;
    if (done >= slots) return [];
    const eligible = (open.get(task) ?? []).filter((reruns) => reruns < MAX_RERUNS).length;
    return [{ task, planned: slots, scored: done, missing: slots - done, rerunAttempts: rerunAttempts.get(task) ?? 0, allowed: Math.min(slots - done, eligible) }];
  });
  return { needs, unlaunched: unlaunched.map((plan) => ({ run: plan.run, outcome: String(plan.outcome) })) };
}

/** The launcher flags that a rerun command sets itself: they select the
 *  benchmark, the tasks, the attempts, and the round, and a round with an
 *  identity also fixes the arm. */
const RERUN_OWNED_FLAGS = ["--benchmark", "--split", "--task-names", "--attempts", "--round", "--jobs-dir"];

/** The launcher commands that rerun the allowed attempts: one run for each
 *  attempt count, joining the round as a rerun. A hub-broken task is left
 *  out: no agent can pass it on Harbor Hub, so a rerun only spends. A rerun
 *  below the board's attempt count adds trials to the round's slots rather
 *  than measuring at board k, so its command admits low k. The arm is the
 *  round's recorded arm. `launcherArgs` are the launcher's other flags, such
 *  as the auth profile; a round recorded before rounds had an identity also
 *  needs `--arm` there. The launcher stays a dry run unless they include
 *  `--execute`. Throws, naming the flag, when they set a flag that the
 *  rerun owns. */
export function rerunCommands(benchmark: HarborBenchmark, roundPath: string, round: Round, needs: readonly RerunNeed[], launcherArgs: readonly string[], repositoryRoot: string): string[][] {
  const owned = round.identity === undefined ? RERUN_OWNED_FLAGS : [...RERUN_OWNED_FLAGS, "--arm"];
  const forwarded = launcherArgs.find((arg) => owned.includes(arg));
  if (forwarded !== undefined) throw new Error(`rerun sets ${forwarded} itself from the round; remove it from the launcher flags`);
  const arm = round.identity === undefined ? [] : ["--arm", round.identity.arm.path];
  const byAttempts = new Map<number, string[]>();
  const broken = new Set(benchmark.hubBroken.map((entry) => entry.task));
  for (const need of needs) {
    if (need.allowed > 0 && !broken.has(need.task)) byAttempts.set(need.allowed, [...(byAttempts.get(need.allowed) ?? []), need.task]);
  }
  // A round record lives at <jobs>/rounds/<name>.json, and the launcher finds it from the jobs directory.
  const jobsDirectory = dirname(dirname(resolve(roundPath)));
  return [...byAttempts].sort(([left], [right]) => left - right).map(([attempts, tasks]) => [
    "bash", join(repositoryRoot, "bench/harbor/run-harbor.sh"),
    "--benchmark", benchmark.id, "--task-names", tasks.join(","), "--attempts", String(attempts),
    ...(attempts < BOARD_ATTEMPTS.full! ? ["--allow-low-k"] : []),
    "--round", round.name, "--jobs-dir", jobsDirectory, ...arm, ...launcherArgs,
  ]);
}
