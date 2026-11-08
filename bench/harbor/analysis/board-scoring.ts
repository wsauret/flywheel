import type { BoardConfig, BoardFact, BoardInputs, BoardRun, InvalidRule } from "./board-data.js";
import { isJsonMap, type JsonMap } from "./json.js";
import { inclusiveQuantiles, PythonRandom, pythonRound, pythonSum } from "./python-random.js";

/** A port of the harness leaderboard's scoring (its Space's `hlb/scoring.py`
 *  and `hlb/config.py`), restricted to what a cell of one benchmark needs:
 *  each trial's outcome, the invalid-rule verdicts, which trials the public
 *  board scores, the attempt cap, the cells, and the paired bootstrap. Each
 *  rule cites the function it ports so that a change of the board's code can
 *  be followed. */

/** The board's outcome of one trial (`outcome`). */
export type Outcome = "pass" | "fail" | "infra" | "cancelled";
type Judged = Outcome | "left out";

const PROVIDER_FAILURE = new Set([429, 500, 502, 503, 504, 529, 599]);
/** Raised by Harbor's side of the sandbox, never by an agent (`SANDBOX_FAILURE`). */
const SANDBOX_FAILURE = new Set([
  "EnvironmentStartTimeoutError", "DockerfileReplayError", "MeterStartError", "OSPrepError", "NetworkPolicyError", "FeatureBenchIsolationError", "SandboxError",
  "ReadTimeout", "RemoteProtocolError", "ConnectError", "ConnectTimeout", "ReadError", "WriteError", "WriteTimeout", "PoolTimeout",
]);
/** Scored attempts per task and stage (`config.ATTEMPTS`). */
export const BOARD_ATTEMPTS: Readonly<Record<string, number>> = { smoke: 1, pilot: 1, full: 3 };
/** Provider failures of one task after which the open attempts count as fails (`config.PROVIDER_FAILURE_LIMIT`). */
const PROVIDER_FAILURE_LIMIT = 6;
const BOOTSTRAP_RESAMPLES = 2000;
const BOOTSTRAP_SEED = 20261020;
const RULE_ORDER: readonly Judged[] = ["left out", "fail", "infra"];

/** `outcome(fact)`: a received answer key fails the trial whatever else
 *  happened; a cancel is neither scored nor an error; a trial whose agent
 *  never worked, whose last model call failed at the provider, whose sandbox
 *  broke, or whose grader reported a negative reward is infrastructure;
 *  otherwise a reward of at least 1 passes. */
export function outcome(fact: BoardFact): Outcome {
  if (fact.answerKeyReceived) return "fail";
  if (fact.exception === "CancelledError") return "cancelled";
  if (fact.featurebenchVerifierException === "FeatureBenchIsolationError" || fact.bridgeRejection !== null) return "infra";
  if (!fact.agentStarted) return "infra";
  const calls = fact.meter?.nCalls ?? 0;
  const diedBeforeFirstCall = fact.exception !== null && fact.exception !== "AgentTimeoutError" && calls === 0;
  if (diedBeforeFirstCall || PROVIDER_FAILURE.has(fact.meter?.lastStatus ?? -1)) return "infra";
  if ((fact.exception !== null && SANDBOX_FAILURE.has(fact.exception)) || (fact.reward !== null && fact.reward < 0)) return "infra";
  return (fact.reward ?? 0) >= 1 ? "pass" : "fail";
}

function ruleVerdict(fact: BoardFact, rules: readonly InvalidRule[] | undefined): Judged | undefined {
  const found = new Set<Judged>();
  for (const rule of rules ?? []) {
    const matches = (list: readonly string[] | undefined, value: string): boolean => list === undefined || list.includes(value);
    if (!matches(rule.harnesses, fact.harness) || !matches(rule.benchmarks, fact.benchmark) || !matches(rule.tasks, fact.task) || !matches(rule.trials, fact.trial)) continue;
    if (rule.outcome !== undefined && rule.outcome !== "fail" && rule.outcome !== "infra") throw new Error(`invalid.json rule outcome ${rule.outcome}: expected fail, infra, or none`);
    found.add(rule.outcome ?? "left out");
  }
  return RULE_ORDER.find((verdict) => found.has(verdict));
}

/** `rule_verdicts`: what the invalid rules of every run that holds a trial make of it. */
function ruleVerdicts(facts: readonly BoardFact[], invalid: BoardInputs["invalid"]): Map<string, Judged> {
  const verdicts = new Map<string, Judged>();
  for (const fact of facts) {
    const verdict = ruleVerdict(fact, invalid[fact.runId]);
    const held = verdicts.get(fact.id);
    if (verdict !== undefined && (held === undefined || RULE_ORDER.indexOf(verdict) < RULE_ORDER.indexOf(held))) verdicts.set(fact.id, verdict);
  }
  return verdicts;
}

function endedOnProvider(fact: BoardFact, verdicts: ReadonlyMap<string, Judged>): boolean {
  return !verdicts.has(fact.id) && outcome(fact) === "infra" && (fact.meter?.nCalls ?? 0) > 0 && PROVIDER_FAILURE.has(fact.meter?.lastStatus ?? -1);
}

function setupProvider(config: BoardConfig, model: string, provider: string): string {
  const spec = config.models[model];
  return spec !== undefined && spec.admittedProviders.includes(provider) ? spec.defaultProvider : provider;
}

/** `on_board(..., public=True)`: the public board shows one setup per model,
 *  each harness's released version and adapter, and each benchmark's current
 *  task commit and reference isolation; it leaves out a model until its
 *  release (`config.released`). */
function onPublicBoard(config: BoardConfig, run: BoardRun, harness: string, benchmark: string): boolean {
  const model = config.models[run.model];
  const spec = config.harnesses[harness];
  if (model === undefined || !model.released || spec === undefined || !spec.released) return false;
  const adapterName = spec.publicAdapter ?? spec.adapter;
  const adapter = adapterName === undefined ? null : config.adapterIds[adapterName] ?? null;
  const setup = run.benchmarkSetups[benchmark] ?? {};
  const pinned = config.benchmarks[benchmark]!;
  return setupProvider(config, run.model, run.provider) === model.defaultProvider
    && run.harnessVersions[harness] === (spec.publicVersion ?? spec.version)
    && (run.harnessAdapters[harness] ?? null) === adapter
    && setup.commit === pinned.commit && setup.reference_isolation === pinned.referenceIsolation;
}

/** One setup of the board: model, stage, effort, and harness. */
export interface BoardSetup { readonly model: string; readonly stage: string; readonly effort: string; readonly harness: string }

interface ScoredFact { readonly fact: BoardFact; readonly outcome: Outcome; readonly order: readonly [string, string] }

/** Per task: passed attempts and scored attempts (`Tally`). */
export type Tally = ReadonlyMap<string, readonly [number, number]>;

export interface BoardCell {
  readonly setup: BoardSetup;
  readonly nTrials: number;
  readonly nScored: number;
  readonly nPass: number;
  readonly nInfra: number;
  readonly costUsd: number;
  readonly nTasks: number;
  readonly nTasksExpected: number;
  readonly rate: number | null;
  readonly ci: readonly [number, number] | null;
  readonly tally: Tally;
  /** Median agent seconds and mean cost per scored trial, per task, for subset selection. */
  readonly taskCost: ReadonlyMap<string, { readonly agentSeconds: number | null; readonly costUsd: number }>;
}

function compareOrder(left: readonly [string, string], right: readonly [string, string]): number {
  return left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : left[1] < right[1] ? -1 : left[1] > right[1] ? 1 : 0;
}

function copyRank(runId: string, runs: BoardInputs["runs"]): string {
  const run = runs[runId];
  return `${run?.stage === "full" ? "0" : "1"}\u0000${run?.createdAt || "~"}\u0000${runId}`;
}

function costUsd(fact: BoardFact, price: BoardRun["price"]): number {
  const meter = fact.meter;
  if (meter === null) return 0;
  const cached = Math.min(meter.cached, meter.input);
  return ((meter.input - cached) * price.input + cached * price.cached_input + meter.output * price.output) / 1e6;
}

/** `_cap_attempts` with `exhausted`: the earliest `n` scored attempts of each
 *  task count, infra trials stay for the error rate, and when the provider
 *  failed a task at least PROVIDER_FAILURE_LIMIT times its earliest provider
 *  failures fill the open attempts as fails. */
function capAttempts(facts: readonly ScoredFact[], n: number, providerFailures: ReadonlyMap<string, ReadonlySet<string>>, verdicts: ReadonlyMap<string, Judged>): ScoredFact[] {
  const byTask = new Map<string, ScoredFact[]>();
  for (const scored of [...facts].sort((left, right) => compareOrder(left.order, right.order))) {
    const list = byTask.get(scored.fact.task) ?? [];
    list.push(scored);
    byTask.set(scored.fact.task, list);
  }
  const kept: ScoredFact[] = [];
  for (const [task, attempts] of byTask) {
    const scoredCount = attempts.filter((attempt) => attempt.outcome === "pass" || attempt.outcome === "fail").length;
    const failed = attempts.filter((attempt) => endedOnProvider(attempt.fact, verdicts));
    const filled = scoredCount < n && (providerFailures.get(task)?.size ?? 0) >= PROVIDER_FAILURE_LIMIT ? new Set(failed.slice(0, n - scoredCount).map((attempt) => attempt.fact.id)) : new Set<string>();
    let counted = 0;
    for (const attempt of attempts) {
      const effective: ScoredFact = filled.has(attempt.fact.id) ? { ...attempt, outcome: "fail" } : attempt;
      if (effective.outcome === "pass" || effective.outcome === "fail") {
        counted += 1;
        if (counted > n) continue;
      }
      kept.push(effective);
    }
  }
  return kept.sort((left, right) => compareOrder(left.order, right.order));
}

/** `board_facts(public=True)` for one benchmark: the trials the public board
 *  scores per setup, deduplicated by trial id, with each trial's outcome, and
 *  the run price of the setup. */
function publicBoardFacts(inputs: BoardInputs): Map<string, { setup: BoardSetup; facts: ScoredFact[]; price: BoardRun["price"] }> {
  const { config, runs, invalid, benchmark } = inputs;
  const pinned = config.benchmarks[benchmark];
  if (pinned === undefined || pinned.unscored) throw new Error(`the board does not score ${benchmark}`);
  const verdicts = ruleVerdicts(inputs.facts, invalid);
  const groups = new Map<string, { setup: BoardSetup; byId: Map<string, ScoredFact & { runId: string }>; price: BoardRun["price"]; failures: Map<string, Set<string>> }>();
  for (const fact of inputs.facts) {
    const run = runs[fact.runId];
    if (fact.benchmark !== benchmark || run === undefined || !(pinned.subsets[run.stage] ?? []).includes(fact.task) || !onPublicBoard(config, run, fact.harness, benchmark)) continue;
    if (setupProvider(config, run.model, fact.provider ?? run.provider) !== config.models[run.model]!.defaultProvider) continue;
    const judged = verdicts.get(fact.id) ?? outcome(fact);
    if (judged === "left out" || judged === "cancelled") continue;
    const setup: BoardSetup = { model: run.model, stage: run.stage, effort: run.effort, harness: fact.harness };
    const key = setupKey(setup);
    const group = groups.get(key) ?? { setup, byId: new Map(), price: run.price, failures: new Map() };
    groups.set(key, group);
    if (endedOnProvider(fact, verdicts)) group.failures.set(fact.task, (group.failures.get(fact.task) ?? new Set()).add(fact.id));
    const source = runs[fact.reusedFrom ?? ""] ?? run;
    const order: [string, string] = [source.createdAt, fact.id];
    const held = group.byId.get(fact.id);
    const better = held === undefined || compareOrder(order, held.order) < 0 || (compareOrder(order, held.order) === 0 && copyRank(fact.runId, runs) < copyRank(held.runId, runs));
    if (better) group.byId.set(fact.id, { fact, outcome: judged, order, runId: fact.runId });
    group.price = run.price;
  }
  const result = new Map<string, { setup: BoardSetup; facts: ScoredFact[]; price: BoardRun["price"] }>();
  for (const [key, group] of groups) {
    const attempts = BOARD_ATTEMPTS[group.setup.stage];
    if (attempts === undefined) throw new Error(`the board has no attempt count for stage ${group.setup.stage}`);
    result.set(key, { setup: group.setup, facts: capAttempts([...group.byId.values()], attempts, group.failures, verdicts), price: group.price });
  }
  return result;
}

export function setupKey(setup: BoardSetup): string {
  return [setup.model, setup.stage, setup.effort, setup.harness].join("|");
}

/** `tally`: pass counts per task over the scored attempts. */
function tally(facts: readonly { readonly task: string; readonly outcome: Outcome }[]): Map<string, [number, number]> {
  const counts = new Map<string, [number, number]>();
  for (const { task, outcome: result } of facts) {
    if (result !== "pass" && result !== "fail") continue;
    const [passed, total] = counts.get(task) ?? [0, 0];
    counts.set(task, [passed + (result === "pass" ? 1 : 0), total + 1]);
  }
  return counts;
}

/** `wilson`: the Wilson score interval of k passes in n. */
function wilson(k: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 1];
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const h = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [Math.max(0, (c - h) / d), Math.min(1, (c + h) / d)];
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** `cell`: each task scores the mean over its scored attempts, and the cell
 *  rate is the mean over its scored tasks. */
function boardCell(setup: BoardSetup, facts: readonly ScoredFact[], expectedTasks: number, price: BoardRun["price"]): BoardCell {
  const counts = tally(facts.map((scored) => ({ task: scored.fact.task, outcome: scored.outcome })));
  const passed = pythonSum([...counts.values()].map(([k, n]) => k / n));
  const scored = facts.filter((item) => item.outcome === "pass" || item.outcome === "fail");
  const perTask = new Map<string, { seconds: number[]; cost: number[] }>();
  for (const item of scored) {
    const entry = perTask.get(item.fact.task) ?? { seconds: [], cost: [] };
    if (item.fact.agentSeconds !== null) entry.seconds.push(item.fact.agentSeconds);
    entry.cost.push(costUsd(item.fact, price));
    perTask.set(item.fact.task, entry);
  }
  return {
    setup,
    nTrials: facts.length,
    nScored: scored.length,
    nPass: scored.filter((item) => item.outcome === "pass").length,
    nInfra: facts.filter((item) => item.outcome === "infra").length,
    costUsd: pythonSum(facts.map((item) => costUsd(item.fact, price))),
    nTasks: counts.size,
    nTasksExpected: expectedTasks,
    rate: counts.size === 0 ? null : passed / counts.size,
    ci: counts.size === 0 ? null : wilson(passed, counts.size),
    tally: counts,
    taskCost: new Map([...perTask].map(([task, entry]) => [task, { agentSeconds: median(entry.seconds), costUsd: pythonSum(entry.cost) / entry.cost.length }])),
  };
}

/** Every public cell of the benchmark, keyed by `setupKey`. */
export function publicCells(inputs: BoardInputs): Map<string, BoardCell> {
  const pinned = inputs.config.benchmarks[inputs.benchmark]!;
  return new Map([...publicBoardFacts(inputs)].map(([key, group]) => [key, boardCell(group.setup, group.facts, pinned.subsets[group.setup.stage]!.length, group.price)]));
}

/** `paired_diff` for one benchmark and one setup pair: A's rate minus B's on
 *  the tasks both scored, with the 95% paired bootstrap interval, which
 *  resamples tasks with replacement (BOOTSTRAP_RESAMPLES draws seeded by the
 *  benchmark and the task count, as the board seeds them). */
export function pairedDiff(benchmark: string, a: Tally, b: Tally): { diff: number; ci: [number, number]; tied: boolean; nTasks: number; tasks: string[] } | null {
  const tasks = [...a.keys()].filter((task) => b.has(task)).sort();
  if (tasks.length === 0) return null;
  const diffs = tasks.map((task) => {
    const [ka, na] = a.get(task)!;
    const [kb, nb] = b.get(task)!;
    return ka / na - kb / nb;
  });
  const random = new PythonRandom(`${BOOTSTRAP_SEED}:${benchmark}:${diffs.length}`);
  const boot = Array.from({ length: BOOTSTRAP_RESAMPLES }, () => pythonRound(pythonSum(random.choices(diffs.length, diffs.length).map((index) => diffs[index]!)) / diffs.length, 12));
  const cuts = inclusiveQuantiles(boot, 40);
  const ci: [number, number] = [cuts[0]!, cuts.at(-1)!];
  return { diff: pythonRound(pythonSum(diffs) / diffs.length, 12), ci, tied: ci[0] <= 0 && 0 <= ci[1], nTasks: diffs.length, tasks };
}

/** The public board's ranking of one model, stage, and effort, as the board
 *  ranks it (`_rank` over the macro): complete harnesses first, then by rate.
 *  One benchmark's cell stands in for the macro, since the board shows its
 *  cells per benchmark and a hill-climb compares one benchmark. */
export function publishedLeader(inputs: BoardInputs, model: string, effort: string, stage = "full"): string | undefined {
  const leader = child(child(child(child(child(child(inputs.published, "leaderboard"), model), "stages"), stage), "efforts"), effort)?.leader;
  return typeof leader === "string" ? leader : undefined;
}

/** The object under `key` of a published node, or undefined. */
function child(node: JsonMap | undefined, key: string): JsonMap | undefined {
  const value = node?.[key];
  return isJsonMap(value) ? value : undefined;
}

/** The objects directly under a published node, by key. */
function children(node: JsonMap | undefined): [string, JsonMap][] {
  return Object.entries(node ?? {}).flatMap(([key, value]): [string, JsonMap][] => (isJsonMap(value) ? [[key, value]] : []));
}

/** One difference between a recomputed cell and the published one. */
export interface CellMismatch { readonly key: string; readonly field: string; readonly published: unknown; readonly recomputed: unknown }

/** The board publishes its floats to 4 significant digits. */
function published4(value: number): number {
  return Number(value.toPrecision(4));
}

/** Compares every recomputed public cell with `public.json` at the precision
 *  that the board publishes: counts exactly, rates, intervals, and cost to 4
 *  significant digits. A cell on one side only is a mismatch. */
export function verifyPublished(inputs: BoardInputs): { cells: number; mismatches: CellMismatch[] } {
  const recomputed = publicCells(inputs);
  const published = new Map<string, JsonMap>();
  const publishedStages = new Set<string>();
  // Keys that start with "_" hold the board's averaged views, not setups.
  for (const [model, modelNode] of children(child(inputs.published, "leaderboard"))) {
    if (model.startsWith("_")) continue;
    for (const [stage, stageNode] of children(child(modelNode, "stages"))) {
      publishedStages.add(`${model}|${stage}`);
      for (const [effort, effortNode] of children(child(stageNode, "efforts"))) {
        if (effort.startsWith("_")) continue;
        for (const [harness, harnessNode] of children(child(effortNode, "harnesses"))) {
          const cell = child(child(harnessNode, "benchmarks"), inputs.benchmark);
          if (cell !== undefined) published.set(setupKey({ model, stage, effort, harness }), cell);
        }
      }
    }
  }
  const mismatches: CellMismatch[] = [];
  for (const [key, cell] of published) {
    const mine = recomputed.get(key);
    if (mine === undefined) {
      mismatches.push({ key, field: "cell", published: "present", recomputed: "absent" });
      continue;
    }
    const fields: [string, unknown, unknown][] = [
      ["n_trials", cell.n_trials, mine.nTrials], ["n_scored", cell.n_scored, mine.nScored], ["n_pass", cell.n_pass, mine.nPass], ["n_infra", cell.n_infra, mine.nInfra],
      ["n_tasks", cell.n_tasks, mine.nTasks], ["n_tasks_expected", cell.n_tasks_expected, mine.nTasksExpected],
      ["rate", cell.rate, mine.rate === null ? null : published4(mine.rate)],
      ["ci", JSON.stringify(cell.ci), JSON.stringify(mine.ci === null ? null : mine.ci.map(published4))],
      ["cost_usd", cell.cost_usd, published4(mine.costUsd)],
    ];
    for (const [field, expected, actual] of fields) if (expected !== actual) mismatches.push({ key, field, published: expected, recomputed: actual });
  }
  for (const [key, cell] of recomputed) {
    // The public board shows only some stages, so only a cell of a published stage must appear.
    if (!published.has(key) && publishedStages.has(`${cell.setup.model}|${cell.setup.stage}`)) mismatches.push({ key, field: "cell", published: "absent", recomputed: "present" });
  }
  return { cells: published.size, mismatches };
}
