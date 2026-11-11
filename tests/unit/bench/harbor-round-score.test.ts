import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { confirmedTrials, readAnswerKey, recordVerdicts, writeAnswerKey } from "../../../bench/harbor/analysis/answer-key.js";
import { rerunCommands, rerunNeeds } from "../../../bench/harbor/analysis/reruns.js";
import { roundCost, scoreRound } from "../../../bench/harbor/analysis/round-score.js";
import { measuredSplits, roundTrialDirectories, roundTrials } from "../../../bench/harbor/analysis/round-trials.js";
import type { HarborBenchmark } from "../../../bench/harbor/benchmarks.js";
import { resolveHarborConfig } from "../../../bench/harbor/harbor-config.js";
import { ARM_CONFIG } from "../../fixtures/harbor-run.js";
import { appendRoundRun, readRound, requireRoundIdentity, roundPath } from "../../../bench/harbor/rounds.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const temporary = temporaryDirectories();

const BENCHMARK: HarborBenchmark = {
  id: "terminal-bench-2.1",
  display: "Fixture bench",
  dataset: { name: "fixture/bench", ref: "sha256:0" },
  taskNamespace: "fixture",
  splits: { subset: ["solid", "flaky", "lost", "broken"], holdout: ["other"] },
  excluded: [],
  hubBroken: [{ task: "broken", evidence: "fixture" }],
  answerKeyRule: false,
  answerKeySources: ["fixture-bench"],
  verifierDownloadsFromGithub: true,
  localVerifierWheelhouse: false,
};

const IDENTITY = { sourceCommit: "c".repeat(40), arm: { path: "bench/harbor/configs/arm.toml", sha256: "a".repeat(64) }, model: "model-1", effort: "high" };

/** `cost` is the estimated cost of the trial's store analysis, 0.1 when absent; null records no evidence. */
interface TrialFixture { id: string; task: string; reward: number | null; category?: string; cost?: number | null; stdout?: string; ledger?: boolean }

function storeAnalysis(estimatedUsd: number) {
  return { version: 5, store: { sha256: "a".repeat(64), size: 1 }, toolSettlement: { inputs: 0, results: 0, missing: 0, orphan: 0, duplicateInputs: 0, duplicateResults: 0, identityConflicts: 0 }, requestAuditComplete: true, interactionProfiles: [], executableToolInputs: {}, finalRequestOutcome: "ok", usage: { estimatedUsd, entries: 1, partial: 0, unmeasured: 0, unpriced: 0, undecoded: 0 } };
}

interface RunFixture { state?: string; outcome?: string; layout?: "hosted" | "local" }

/** A run: its manifest, its preparation plan, its ledger once finished, and
 *  each trial's result and store analysis in the Harbor job directory of its execution mode. */
function writeRun(directory: string, tasks: string[], attempts: number, trials: TrialFixture[], { state = "finalized", outcome, layout = "hosted" }: RunFixture = {}): void {
  mkdirSync(directory, { recursive: true });
  const trialsDirectory = join(directory, layout === "hosted" ? "hub" : "harbor-jobs", "job");
  writeFileSync(join(directory, "run_manifest.json"), JSON.stringify({ task_names: tasks.map((task) => `fixture/${task}`), attempts, state, outcome: outcome ?? null }));
  writeFileSync(join(directory, "preparation-plan.json"), JSON.stringify({ trials_directory: trialsDirectory }));
  if (state !== "finalized") return;
  const rows = trials.filter((trial) => trial.ledger !== false).map((trial) => ({ id: trial.id, task: `fixture/${trial.task}`, reward: trial.reward, ...(trial.category === undefined ? {} : { category: trial.category }) }));
  writeFileSync(join(directory, "disclosure-ledger.json"), JSON.stringify({ rows }));
  for (const trial of trials) {
    const trialDirectory = join(trialsDirectory, trial.id);
    mkdirSync(join(trialDirectory, "verifier"), { recursive: true });
    mkdirSync(join(trialDirectory, "agent"));
    writeFileSync(join(trialDirectory, "result.json"), JSON.stringify({ task_name: `fixture/${trial.task}`, trial_name: trial.id, verifier_result: { rewards: { reward: trial.reward } } }));
    if (trial.cost !== null) writeFileSync(join(trialDirectory, "agent", "flywheel-store-analysis.json"), JSON.stringify(storeAnalysis(trial.cost ?? 0.1)));
    if (trial.stdout !== undefined) writeFileSync(join(trialDirectory, "verifier", "test-stdout.txt"), trial.stdout);
  }
}

async function fixtureRound() {
  const root = temporary("harbor-round-");
  const jobs = join(root, "jobs");
  const measure = join(root, "measure");
  const rerun = join(root, "rerun");
  writeRun(measure, ["solid", "flaky", "lost", "broken"], 2, [
    { id: "solid-1", task: "solid", reward: 1 },
    { id: "solid-2", task: "solid", reward: 1, cost: 0.25 },
    { id: "flaky-1", task: "flaky", reward: 0.5 },
    { id: "flaky-2", task: "flaky", reward: null, category: "provider_infra" },
    { id: "lost-1", task: "lost", reward: 0, stdout: "error: failed to download https://github.com/astral-sh/uv\n" },
    { id: "lost-2", task: "lost", reward: 0, category: "verifier_infra", cost: null },
    { id: "broken-1", task: "broken", reward: -1 },
    // The ledger refused this trial for missing evidence, but its verifier graded it.
    { id: "broken-2", task: "broken", reward: 1, ledger: false },
    // The ledger refused this trial and its verifier gave no reward, so it is not scored, but it ran and has a cost.
    { id: "refused-1", task: "solid", reward: null, ledger: false, cost: 0.05 },
  ]);
  writeRun(rerun, ["flaky"], 1, [
    { id: "flaky-3", task: "flaky", reward: 1, stdout: "failed to download https://github.com/x\n===== 3 passed in 1.0s =====\n" },
  ]);
  await appendRoundRun(jobs, "r1", BENCHMARK.id, { directory: measure, split: "subset" }, IDENTITY);
  await appendRoundRun(jobs, "r1", BENCHMARK.id, { directory: rerun }, IDENTITY);
  const path = roundPath(jobs, "r1");
  return { path, round: await readRound(path), jobs };
}

describe("round records", () => {
  it("keeps every run of appends that race on one round", async () => {
    const jobs = join(temporary("harbor-round-race-"), "jobs");
    const directories = Array.from({ length: 6 }, (_, index) => `/scratch/run-${index}`);
    await Promise.all(directories.map((directory) => appendRoundRun(jobs, "r1", BENCHMARK.id, { directory, split: "subset" }, IDENTITY)));
    const round = await readRound(roundPath(jobs, "r1"));
    expect(round.runs.map((run) => run.directory).sort()).toEqual(directories);
    expect(round.identity).toEqual(IDENTITY);
  });

  it("binds a round to the identity of its first run and refuses another, naming both values", async () => {
    const jobs = join(temporary("harbor-round-identity-"), "jobs");
    await appendRoundRun(jobs, "r1", BENCHMARK.id, { directory: "/scratch/first", split: "subset" }, IDENTITY);
    await expect(appendRoundRun(jobs, "r1", BENCHMARK.id, { directory: "/scratch/second" }, { ...IDENTITY, sourceCommit: "d".repeat(40) })).rejects.toThrow(`round r1 holds source commit ${"c".repeat(40)}, not ${"d".repeat(40)}`);
    await expect(requireRoundIdentity(jobs, "r1", BENCHMARK.id, { ...IDENTITY, arm: { path: "other.toml", sha256: "b".repeat(64) } })).rejects.toThrow(`round r1 holds arm sha256 ${"a".repeat(64)}, not ${"b".repeat(64)}`);
    await expect(requireRoundIdentity(jobs, "r1", BENCHMARK.id, { ...IDENTITY, model: "model-2" })).rejects.toThrow("round r1 holds model model-1, not model-2");
    await expect(requireRoundIdentity(jobs, "r1", "deep-swe-1.1", IDENTITY)).rejects.toThrow("round r1 holds terminal-bench-2.1, not deep-swe-1.1");
    await requireRoundIdentity(jobs, "r1", BENCHMARK.id, IDENTITY);
    await requireRoundIdentity(jobs, "new-round", BENCHMARK.id, IDENTITY);
  });

  it("reads a round recorded before rounds had an identity, and its next run sets the identity", async () => {
    const jobs = join(temporary("harbor-round-legacy-"), "jobs");
    const path = roundPath(jobs, "r1");
    mkdirSync(join(jobs, "rounds"), { recursive: true });
    writeFileSync(path, JSON.stringify({ name: "r1", benchmark: BENCHMARK.id, runs: [{ directory: "/scratch/old", purpose: "measure", split: "subset" }] }));
    expect((await readRound(path)).identity).toBeUndefined();
    await requireRoundIdentity(jobs, "r1", BENCHMARK.id, IDENTITY);
    const grown = await appendRoundRun(jobs, "r1", BENCHMARK.id, { directory: "/scratch/new", split: "holdout" }, IDENTITY);
    expect(grown).toEqual({ name: "r1", benchmark: BENCHMARK.id, identity: IDENTITY, runs: [{ directory: "/scratch/old", purpose: "measure", split: "subset" }, { directory: "/scratch/new", purpose: "measure", split: "holdout" }] });
    expect(await readRound(path)).toEqual(grown);
  });
});

describe("round scoring", () => {
  it("pools every run's scored attempts with the board's rules", async () => {
    const { round } = await fixtureRound();
    expect(round.runs.map((run) => run.purpose)).toEqual(["measure", "rerun"]);
    const trials = await roundTrials(BENCHMARK, round);
    const score = scoreRound(BENCHMARK, trials, new Set(), await measuredSplits(BENCHMARK, round));
    // flaky: a 0.5 reward fails, infra is not scored, and the rerun's graded pass counts.
    expect([...score.tasks].sort()).toEqual([["broken", [1, 1]], ["flaky", [1, 2]], ["solid", [2, 2]]]);
    expect(score.infra).toBe(1);
    // A GitHub download failure without a test summary, the ledger's category, and a negative reward.
    expect(score.graderLost).toBe(3);
    expect(trials.some((trial) => trial.id === "refused-1")).toBeFalse();
    // Every trial is priced from its directory, also the refused ones that scoring leaves out; the trial without evidence makes the total a lower bound.
    const cost = await roundCost(await roundTrialDirectories(round));
    expect({ ...cost, estimatedUsd: Number(cost.estimatedUsd.toFixed(12)) }).toEqual({ estimatedUsd: 1, lowerBound: true, settled: 9, snapshots: 0, unavailable: 1, incompleteUsage: 0 });
    const subset = score.splits.find((split) => split.split === "subset")!;
    expect(subset).toEqual({ split: "subset", tasks: 4, score: (1 + 0.5 + 0 + 1) / 4, scoredScore: (1 + 0.5 + 1) / 3, scoredTasks: 3, withoutHubBroken: (1 + 0.5 + 0) / 3, hubBrokenTasks: 1 });
    // The round measured only the subset, so it reports no score for the holdout.
    expect(score.splits.map((split) => split.split)).toEqual(["subset"]);
  });

  it("finds the trials of a local run in the Harbor job directory inside its artifact directory", async () => {
    const root = temporary("harbor-round-local-");
    const run = { directory: join(root, "local"), purpose: "measure", split: "subset" } as const;
    writeRun(run.directory, ["solid"], 1, [{ id: "solid-1", task: "solid", reward: 1 }], { layout: "local" });
    const trials = await roundTrials(BENCHMARK, { name: "r1", benchmark: BENCHMARK.id, runs: [run] });
    expect(trials.map((trial) => [trial.id, trial.standing, trial.directory])).toEqual([["solid-1", "scored", join(run.directory, "harbor-jobs", "job", "solid-1")]]);
  });

  it("scores a GitHub download failure as graded when the grader does not download from GitHub", async () => {
    const { round } = await fixtureRound();
    const trials = await roundTrials({ ...BENCHMARK, verifierDownloadsFromGithub: false }, round);
    expect(trials.find((trial) => trial.id === "lost-1")?.standing).toBe("scored");
  });

  it("fails a passing trial whose answer-key verdict is confirmed", async () => {
    const { path, round } = await fixtureRound();
    const trials = await roundTrials(BENCHMARK, round);
    await writeAnswerKey(path, { round: "r1", benchmark: BENCHMARK.id, candidates: [{ trial: "solid-2", task: "solid", directory: "/scratch/solid-2", high: true, hosts: ["github.com"], urls: ["https://github.com/fixture-bench/x"] }], verdicts: {} });
    await expect(recordVerdicts(path, { "flaky-1": { verdict: "confirmed", evidence: "step 4" } })).rejects.toThrow("not candidates");
    await recordVerdicts(path, { "solid-2": { verdict: "confirmed", evidence: "step 4 fetched the reference solution" } });
    const score = scoreRound(BENCHMARK, trials, confirmedTrials(await readAnswerKey(path)), await measuredSplits(BENCHMARK, round));
    expect(score.tasks.get("solid")).toEqual([1, 2]);
    expect(score.answerKeyFails).toBe(1);
  });
});

describe("round reruns", () => {
  it("reruns each lost slot at most twice", async () => {
    const { path, round, jobs } = await fixtureRound();
    // The measurement lost both slots of "lost"; two reruns of both slots lose them again.
    let grown = round;
    for (const name of ["rerun-2", "rerun-3"]) {
      const directory = join(jobs, "..", name);
      writeRun(directory, ["lost"], 2, [1, 2].map((slot) => ({ id: `${name}-lost-${slot}`, task: "lost", reward: null, category: "provider_infra" })));
      grown = await appendRoundRun(jobs, "r1", BENCHMARK.id, { directory }, IDENTITY);
    }
    expect((await rerunNeeds(BENCHMARK, round, await roundTrials(BENCHMARK, round))).needs).toEqual([
      { task: "broken", planned: 2, scored: 1, missing: 1, rerunAttempts: 0, allowed: 1 },
      { task: "lost", planned: 2, scored: 0, missing: 2, rerunAttempts: 0, allowed: 2 },
    ]);
    const { needs } = await rerunNeeds(BENCHMARK, grown, await roundTrials(BENCHMARK, grown));
    expect(needs.find((need) => need.task === "lost")).toEqual({ task: "lost", planned: 2, scored: 0, missing: 2, rerunAttempts: 4, allowed: 0 });
    // A hub-broken task is never rerun, and the capped task has no attempt left.
    expect(rerunCommands(BENCHMARK, path, grown, needs, [], "/repo")).toEqual([]);
    // The arm is the round's own.
    expect(rerunCommands(BENCHMARK, path, round, (await rerunNeeds(BENCHMARK, round, await roundTrials(BENCHMARK, round))).needs, ["--auth-profile", "Fixture"], "/repo")).toEqual([
      ["bash", join("/repo", "bench/harbor/run-harbor.sh"), "--benchmark", BENCHMARK.id, "--task-names", "lost", "--attempts", "2", "--allow-low-k", "--round", "r1", "--jobs-dir", jobs, "--arm", IDENTITY.arm.path, "--auth-profile", "Fixture"],
    ]);
  });

  it("gives a slot that a rerun filled no retry for another slot", async () => {
    const { jobs } = await fixtureRound();
    // Both slots of "lost" were lost. The first rerun fills one and loses the other; the second loses it again.
    const first = join(jobs, "..", "rerun-a");
    writeRun(first, ["lost"], 2, [{ id: "a-1", task: "lost", reward: 1 }, { id: "a-2", task: "lost", reward: null, category: "provider_infra" }]);
    await appendRoundRun(jobs, "r1", BENCHMARK.id, { directory: first }, IDENTITY);
    const second = join(jobs, "..", "rerun-b");
    writeRun(second, ["lost"], 1, [{ id: "b-1", task: "lost", reward: null, category: "provider_infra" }]);
    const grown = await appendRoundRun(jobs, "r1", BENCHMARK.id, { directory: second }, IDENTITY);
    expect((await rerunNeeds(BENCHMARK, grown, await roundTrials(BENCHMARK, grown))).needs.find((need) => need.task === "lost")).toEqual({ task: "lost", planned: 2, scored: 1, missing: 1, rerunAttempts: 3, allowed: 0 });
  });

  it("refuses to plan reruns while a run of the round is in flight", async () => {
    const { jobs } = await fixtureRound();
    const measure = join(jobs, "..", "measure-2");
    writeRun(measure, ["other"], 3, [], { state: "prepared" });
    const pending = join(jobs, "..", "rerun-pending");
    writeRun(pending, ["lost"], 2, [], { state: "launched" });
    await appendRoundRun(jobs, "r1", BENCHMARK.id, { directory: measure, split: "holdout" }, IDENTITY);
    const grown = await appendRoundRun(jobs, "r1", BENCHMARK.id, { directory: pending }, IDENTITY);
    await expect(rerunNeeds(BENCHMARK, grown, await roundTrials(BENCHMARK, grown))).rejects.toThrow(`runs of r1 have not finished: ${measure} (prepared), ${pending} (launched; settle it with: bun bench/harbor/run-harbor.ts resume-hosted ${pending})`);
  });

  it("plans no attempt for a run that ended before Harbor ran any trial, and reports it", async () => {
    const { round, jobs } = await fixtureRound();
    const before = (await rerunNeeds(BENCHMARK, round, await roundTrials(BENCHMARK, round))).needs;
    const unlaunched = join(jobs, "..", "measure-refused");
    writeRun(unlaunched, ["other", "lost"], 3, [], { state: "refused", outcome: "hub_dry_run_refused" });
    const grown = await appendRoundRun(jobs, "r1", BENCHMARK.id, { directory: unlaunched, split: "holdout" }, IDENTITY);
    const planned = await rerunNeeds(BENCHMARK, grown, await roundTrials(BENCHMARK, grown));
    expect(planned.needs).toEqual(before);
    expect(planned.unlaunched).toEqual([{ run: { directory: unlaunched, purpose: "measure", split: "holdout" }, outcome: "hub_dry_run_refused" }]);
    // It measured nothing, so its split gets no score.
    expect([...(await measuredSplits(BENCHMARK, grown)).keys()]).toEqual(["subset"]);
  });

  it("measures a round whose first run that ran trials is a task list, and plans its lost trials", async () => {
    const root = temporary("harbor-round-listed-");
    const jobs = join(root, "jobs");
    const refused = join(root, "refused");
    const listed = join(root, "listed");
    const rerun = join(root, "rerun");
    writeRun(refused, ["solid", "lost"], 2, [], { state: "refused", outcome: "snapshot_failed" });
    // Hub lost "lost-2" with no reward, and the ledger has no row for it.
    writeRun(listed, ["solid", "lost"], 2, [
      { id: "solid-1", task: "solid", reward: 1 },
      { id: "solid-2", task: "solid", reward: 0 },
      { id: "lost-1", task: "lost", reward: 1 },
      { id: "lost-2", task: "lost", reward: null, ledger: false },
    ]);
    writeRun(rerun, ["lost"], 1, [{ id: "lost-3", task: "lost", reward: 0 }]);
    await appendRoundRun(jobs, "r1", BENCHMARK.id, { directory: refused }, IDENTITY);
    // The refused list measured nothing, so the next list is still the measurement.
    const round = await appendRoundRun(jobs, "r1", BENCHMARK.id, { directory: listed }, IDENTITY);
    expect(round.runs.map(({ purpose, split }) => [purpose, split])).toEqual([["measure", "task-list"], ["measure", "task-list"]]);
    expect((await rerunNeeds(BENCHMARK, round, await roundTrials(BENCHMARK, round))).needs).toEqual([{ task: "lost", planned: 2, scored: 1, missing: 1, rerunAttempts: 0, allowed: 1 }]);
    expect([...await measuredSplits(BENCHMARK, round)]).toEqual([["task-list", ["solid", "lost"]]]);
    // A list into a round that measured something is a rerun, and its scored trial fills the lost slot.
    const grown = await appendRoundRun(jobs, "r1", BENCHMARK.id, { directory: rerun }, IDENTITY);
    expect(grown.runs.at(-1)).toEqual({ directory: rerun, purpose: "rerun" });
    expect((await rerunNeeds(BENCHMARK, grown, await roundTrials(BENCHMARK, grown))).needs).toEqual([]);
  });

  it("refuses launcher flags that the rerun sets itself, naming the flag", async () => {
    const { path, round } = await fixtureRound();
    const { needs } = await rerunNeeds(BENCHMARK, round, await roundTrials(BENCHMARK, round));
    for (const flag of ["--benchmark", "--split", "--task-names", "--attempts", "--round", "--jobs-dir", "--arm"]) {
      expect(() => rerunCommands(BENCHMARK, path, round, needs, ["--auth-profile", "Fixture", flag, "x"], "/repo")).toThrow(`rerun sets ${flag} itself from the round`);
    }
    // A round recorded before rounds had an identity takes the arm from the launcher flags.
    const { identity: _identity, ...legacy } = round;
    expect(rerunCommands(BENCHMARK, path, legacy, needs, ["--arm", "arm.toml"], "/repo")[0]!.slice(-2)).toEqual(["--arm", "arm.toml"]);
  });

  it("generates commands that the launcher accepts as a dry-run rerun", async () => {
    const { path, round } = await fixtureRound();
    const [command] = rerunCommands(BENCHMARK, path, { ...round, identity: { ...IDENTITY, arm: { path: ARM_CONFIG, sha256: IDENTITY.arm.sha256 } } }, (await rerunNeeds(BENCHMARK, round, await roundTrials(BENCHMARK, round))).needs, ["--auth-profile", "Fixture", "--agent-repo", "owner/agent"], "/repo");
    const config = await resolveHarborConfig(command!.slice(2), { cwd: process.cwd(), env: {} });
    expect(config).toMatchObject({ taskNames: ["terminal-bench/lost"], attempts: 2, grade: "local_low_k", dryRun: true, round: "r1" });
  });
});
