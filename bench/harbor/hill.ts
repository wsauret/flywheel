import { resolve } from "node:path";
import { harborBenchmark, type HarborBenchmark } from "./benchmarks.js";
import { readRound, type Round } from "./rounds.js";
import { confirmedTrials, readAnswerKey, recordVerdicts, scanAnswerKeys, writeAnswerKey, answerKeyPath, type AnswerKeyVerdict } from "./analysis/answer-key.js";
import { jsonMap, readJsonFile } from "./analysis/json.js";
import { BOARD_CACHE, fetchBoard, loadBoard } from "./analysis/board-data.js";
import { publicCells, verifyPublished } from "./analysis/board-scoring.js";
import { leaveOneOut, fitProjection } from "./analysis/projection.js";
import { rerunCommands, rerunNeeds } from "./analysis/reruns.js";
import { boardModel, calibrationUnits, compareWithBoard, PROJECTED_SPLIT, roundCost, scoreRound } from "./analysis/round-score.js";
import { measuredSplits, roundTrialDirectories, roundTrials } from "./analysis/round-trials.js";
import { proposeSubset } from "./analysis/subset.js";

const REPOSITORY_ROOT = resolve(import.meta.dir, "../..");
const USAGE = `usage: bun bench/harbor/hill.ts <command>   (<round.json> is the record path that the launcher prints for its --round <name>: <jobs dir>/rounds/<name>.json)
  board fetch  --benchmark <id> [--cache <dir>]   download the harness leaderboard's data
  board verify --benchmark <id> [--cache <dir>]   recompute the board's cells and compare them with public.json
  subset propose --benchmark <id> --size <n> [--holdouts <n>,<n>] [--cache <dir>]
  score  --round <round.json> [--board] [--model <name>] [--effort <effort>] [--cache <dir>]
  rerun  --round <round.json> [--launch] [-- <launcher flags other than the ones rerun sets>]
  scan   --round <round.json>                    write the answer-key candidates beside the round
  verdicts --round <round.json> --from <verdicts.json>   record answer-key review verdicts`;

function flags(args: readonly string[]): { values: Map<string, string>; switches: Set<string>; rest: string[] } {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") return { values, switches, rest: args.slice(index + 1) };
    if (!arg.startsWith("--")) throw new Error(`unexpected argument ${arg}\n${USAGE}`);
    const next = args[index + 1];
    if (next === undefined || next.startsWith("--")) switches.add(arg);
    else {
      values.set(arg, next);
      index += 1;
    }
  }
  return { values, switches, rest: [] };
}

function required(values: ReadonlyMap<string, string>, flag: string): string {
  const value = values.get(flag);
  if (value === undefined) throw new Error(`${flag} is required\n${USAGE}`);
  return value;
}

const fixed = (value: number | null | undefined, digits = 3): string => (value === null || value === undefined ? "n/a" : value.toFixed(digits));

async function roundOf(values: ReadonlyMap<string, string>): Promise<{ path: string; round: Round; benchmark: HarborBenchmark }> {
  const path = resolve(required(values, "--round"));
  const round = await readRound(path);
  return { path, round, benchmark: harborBenchmark(round.benchmark) };
}

/** The model and effort of the round's identity, which name its board setup. */
function roundSetup(round: Round): { model: string; effort: string } {
  if (round.identity === undefined) throw new Error(`round ${round.name} was recorded before rounds had an identity; pass --model and --effort`);
  return { model: round.identity.model, effort: round.identity.effort };
}

async function boardCommand(action: string | undefined, values: ReadonlyMap<string, string>): Promise<number> {
  const benchmark = harborBenchmark(required(values, "--benchmark"));
  const cache = values.get("--cache") ?? BOARD_CACHE;
  if (action === "fetch") {
    const fetched = await fetchBoard(benchmark, cache);
    console.log(`${benchmark.id}: ${fetched.runs} runs, ${fetched.shards} trial shards, ${fetched.downloaded} files downloaded to ${cache}`);
    return 0;
  }
  if (action !== "verify") throw new Error(USAGE);
  const board = await loadBoard(benchmark, cache);
  const result = verifyPublished(board);
  console.log(`${benchmark.id}: ${board.facts.length} trial facts, ${result.cells} published cells, ${result.mismatches.length} mismatches (data fetched ${board.fetchedAt})`);
  for (const mismatch of result.mismatches) console.log(`  ${mismatch.key} ${mismatch.field}: published ${String(mismatch.published)}, recomputed ${String(mismatch.recomputed)}`);
  // A run of every task leaves out the descriptor's exclusions, so they must be the board's.
  const boardExcluded = [...(board.config.benchmarks[board.benchmark]?.excluded ?? [])].sort();
  const excluded = benchmark.excluded.map(({ task }) => task).sort();
  const exclusionsAgree = JSON.stringify(boardExcluded) === JSON.stringify(excluded);
  console.log(exclusionsAgree ? `exclusions agree with the board: ${excluded.join(", ") || "none"}` : `exclusions differ: the board excludes ${boardExcluded.join(", ") || "none"}, ${benchmark.id} excludes ${excluded.join(", ") || "none"}`);
  const subset = benchmark.splits[PROJECTED_SPLIT];
  if (subset !== undefined) {
    const units = calibrationUnits(publicCells(board).values(), subset);
    const fit = fitProjection(units);
    const loo = leaveOneOut(units);
    console.log(`${PROJECTED_SPLIT} fit over ${fit.n} units: full = ${fit.a.toFixed(5)} + ${fit.b.toFixed(5)} * ${PROJECTED_SPLIT}; residual SD ${fit.s.toFixed(5)}; R2 ${fit.r2.toFixed(3)}; t90 ${fit.t90.toFixed(3)}; leave-one-out 90% coverage ${loo.covered}/${loo.n}, RMSE ${loo.rmse.toFixed(4)}`);
  }
  return result.mismatches.length === 0 && exclusionsAgree ? 0 : 1;
}

async function subsetCommand(values: ReadonlyMap<string, string>): Promise<number> {
  const benchmark = harborBenchmark(required(values, "--benchmark"));
  const board = await loadBoard(benchmark, values.get("--cache") ?? BOARD_CACHE);
  const size = Number(required(values, "--size"));
  const holdouts = (values.get("--holdouts") ?? "").split(",").filter(Boolean).map(Number);
  if (![size, ...holdouts].every((count) => Number.isInteger(count) && count > 0)) throw new Error("--size and --holdouts take positive integers");
  const proposal = proposeSubset(board, publicCells(board).values(), size, holdouts);
  console.log(`${benchmark.id}: pool of ${proposal.pool} informative tasks over ${proposal.units} board units`);
  console.log("in-sample: every figure below is computed on the board cells that chose the lists, so it is optimistic and not independent validation");
  for (const { name, report } of proposal.lists) {
    console.log(`${name}: ${report.tasks.length} tasks; MAE ${(report.mae * 100).toFixed(1)} pts, max ${(report.maxError * 100).toFixed(1)} pts, r ${report.pearson.toFixed(3)}; MAE no worse than ${(report.beatsRandom * 100).toFixed(1)}% of random subsets; fit full = ${report.fit.a.toFixed(4)} + ${report.fit.b.toFixed(4)} * x, residual SD ${report.fit.s.toFixed(4)}, leave-one-out 90% coverage ${report.looCovered}/${report.fit.n}`);
  }
  console.log(`\nsplits: {\n${proposal.lists.map(({ name, report }) => `  ${name}: [${report.tasks.map((task) => JSON.stringify(task)).join(", ")}],`).join("\n")}\n},`);
  return 0;
}

async function scoreCommand(values: ReadonlyMap<string, string>, switches: ReadonlySet<string>): Promise<number> {
  const { path, round, benchmark } = await roundOf(values);
  const trials = await roundTrials(benchmark, round);
  const score = scoreRound(benchmark, trials, confirmedTrials(await readAnswerKey(path)), await measuredSplits(benchmark, round));
  console.log(`${round.name} on ${benchmark.id}: ${round.runs.length} runs, ${trials.length} trials`);
  for (const [task, [passed, total]] of [...score.tasks].sort(([left], [right]) => left.localeCompare(right))) console.log(`  ${task.padEnd(40)} ${passed}/${total}`);
  for (const split of score.splits) {
    console.log(`${split.split}: ${fixed(split.score)} over ${split.tasks} (${fixed(split.scoredScore)} over ${split.scoredTasks} scored${split.hubBrokenTasks === 0 ? "" : `; ${fixed(split.withoutHubBroken)} without ${split.hubBrokenTasks} hub-broken`})`);
  }
  const cost = await roundCost(await roundTrialDirectories(round));
  console.log(`grader-lost ${score.graderLost}, infra ${score.infra}, answer-key fails ${score.answerKeyFails}`);
  console.log(`estimated cost ${cost.lowerBound ? "at least " : ""}$${cost.estimatedUsd.toFixed(2)} (${cost.settled} settled, ${cost.snapshots} timeout snapshots, ${cost.incompleteUsage} trials with unmeasured or unpriced usage, ${cost.unavailable} without a store)`);
  if (!switches.has("--board")) return 0;
  const board = await loadBoard(benchmark, values.get("--cache") ?? BOARD_CACHE);
  const given = values.get("--model");
  const givenEffort = values.get("--effort");
  const recorded = given !== undefined && givenEffort !== undefined ? { model: given, effort: givenEffort } : roundSetup(round);
  const modelName = given ?? recorded.model;
  const model = boardModel(board, modelName);
  // The projection does not depend on the model, so a model the board does not rank still gets one.
  const comparison = compareWithBoard(benchmark, score, board, { model: model ?? modelName, effort: givenEffort ?? recorded.effort });
  if (comparison.projection !== undefined) {
    const { fit, looCovered, projected } = comparison.projection;
    console.log(`projected full ${fixed(projected.full)} [${fixed(projected.low)}, ${fixed(projected.high)}] (90%; fit over ${fit.n} board units: full = ${fit.a.toFixed(5)} + ${fit.b.toFixed(5)} * ${PROJECTED_SPLIT}, residual SD ${fit.s.toFixed(5)}, leave-one-out coverage ${looCovered}/${fit.n})`);
  }
  if (model === undefined) console.log(`the board ranks no setup for ${modelName}`);
  else if (comparison.field.length === 0) console.log(`the board ranks no ${model} at effort ${comparison.setup.effort}`);
  else {
    console.log(`board at ${comparison.setup.model} ${comparison.setup.effort} (full stage), with this round's paired difference on the tasks both scored (95% paired bootstrap):`);
    for (const { harness, rate, ci, diff } of comparison.field) {
      const paired = diff === null ? "no task scored by both" : `${diff.diff >= 0 ? "+" : ""}${diff.diff.toFixed(3)} [${diff.ci[0].toFixed(3)}, ${diff.ci[1].toFixed(3)}] on ${diff.nTasks}${diff.tied ? ", tied" : ""}`;
      console.log(`  ${harness.padEnd(20)} ${fixed(rate)}${ci === null ? "" : ` [${fixed(ci[0])}, ${fixed(ci[1])}]`}   ${paired}${harness === comparison.leader ? "   (published leader)" : ""}`);
    }
    if (comparison.leader !== undefined) console.log("the published leader is the board's rank over every benchmark, complete harnesses first");
  }
  return 0;
}

async function rerunCommand(values: ReadonlyMap<string, string>, switches: ReadonlySet<string>, rest: readonly string[]): Promise<number> {
  const { path, round, benchmark } = await roundOf(values);
  const { needs, unlaunched } = await rerunNeeds(benchmark, round, await roundTrials(benchmark, round));
  for (const { run, outcome } of unlaunched) console.log(`  ${run.directory} ended before any trial ran (${outcome}); it plans no rerun${run.purpose === "measure" ? `: start a fresh measure run of split ${run.split ?? ""}` : ""}`);
  if (needs.length === 0) console.log(`${round.name}: every planned attempt is scored`);
  const broken = new Set(benchmark.hubBroken.map((entry) => entry.task));
  for (const need of needs) console.log(`  ${need.task.padEnd(40)} missing ${need.missing} of ${need.planned}, ${need.rerunAttempts} rerun attempts so far, ${broken.has(need.task) ? "hub-broken, not rerun" : need.allowed === 0 ? "rerun cap reached" : `rerun ${need.allowed}`}`);
  const commands = rerunCommands(benchmark, path, round, needs, rest, REPOSITORY_ROOT);
  for (const command of commands) console.log(`${switches.has("--launch") ? "launching" : "would run"}: ${command.join(" ")}`);
  if (!switches.has("--launch")) return 0;
  for (const command of commands) {
    const child = Bun.spawn(command, { cwd: REPOSITORY_ROOT, stdin: "inherit", stdout: "inherit", stderr: "inherit", windowsHide: true });
    const exitCode = await child.exited;
    if (exitCode !== 0) return exitCode;
  }
  return 0;
}

async function scanCommand(values: ReadonlyMap<string, string>): Promise<number> {
  const { path, round, benchmark } = await roundOf(values);
  const candidates = await scanAnswerKeys(benchmark, await roundTrials(benchmark, round));
  const existing = await readAnswerKey(path);
  await writeAnswerKey(path, { round: round.name, benchmark: benchmark.id, candidates, verdicts: existing?.verdicts ?? {} });
  const hosts = new Map<string, number>();
  for (const candidate of candidates) for (const host of candidate.hosts) hosts.set(host, (hosts.get(host) ?? 0) + 1);
  console.log(`${candidates.length} passing trials reached a code host, dataset hub, or search engine; ${candidates.filter((candidate) => candidate.high).length} name a copy of ${benchmark.display}`);
  for (const [host, count] of [...hosts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))) console.log(`  ${String(count).padStart(4)} ${host}`);
  console.log(`candidates: ${answerKeyPath(path)}`);
  return 0;
}

async function verdictsCommand(values: ReadonlyMap<string, string>): Promise<number> {
  const path = resolve(required(values, "--round"));
  const raw = await readJsonFile(required(values, "--from"));
  if (!Array.isArray(raw)) throw new Error("--from takes a JSON list of { trial, verdict, evidence }, the review's handoffs");
  const verdicts: { [trial: string]: AnswerKeyVerdict } = {};
  for (const item of raw) {
    const entry = jsonMap(item, "a verdict");
    if (typeof entry.trial !== "string" || (entry.verdict !== "confirmed" && entry.verdict !== "cleared") || typeof entry.evidence !== "string") throw new Error("each verdict needs trial, verdict (confirmed or cleared), and evidence");
    verdicts[entry.trial] = { verdict: entry.verdict, evidence: entry.evidence };
  }
  const record = await recordVerdicts(path, verdicts);
  console.log(`${Object.keys(verdicts).length} verdicts recorded; ${confirmedTrials(record).size} confirmed in ${answerKeyPath(path)}`);
  return 0;
}

async function main(args: readonly string[]): Promise<number> {
  const [command, ...rest] = args;
  switch (command) {
    case "board": {
      const { values } = flags(rest.slice(1));
      return boardCommand(rest[0], values);
    }
    case "subset": {
      if (rest[0] !== "propose") throw new Error(USAGE);
      return subsetCommand(flags(rest.slice(1)).values);
    }
    case "score": {
      const parsed = flags(rest);
      return scoreCommand(parsed.values, parsed.switches);
    }
    case "rerun": {
      const parsed = flags(rest);
      return rerunCommand(parsed.values, parsed.switches, parsed.rest);
    }
    case "scan": return scanCommand(flags(rest).values);
    case "verdicts": return verdictsCommand(flags(rest).values);
    default:
      console.error(USAGE);
      return 2;
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
