import { describe, expect, it } from "bun:test";
import type { BoardConfig, BoardFact, BoardInputs, BoardRun } from "../../../bench/harbor/analysis/board-data.js";
import { outcome, pairedDiff, publicCells, verifyPublished } from "../../../bench/harbor/analysis/board-scoring.js";
import { PythonRandom } from "../../../bench/harbor/analysis/python-random.js";
import { compareWithBoard, type RoundScore } from "../../../bench/harbor/analysis/round-score.js";
import { harborBenchmark } from "../../../bench/harbor/benchmarks.js";

function fact(overrides: Partial<BoardFact> & { id: string; task: string }): BoardFact {
  return {
    trial: overrides.id, harness: "h1", runId: "run-1", benchmark: "bench-x", reusedFrom: null, reward: 1, exception: null,
    featurebenchVerifierException: null, bridgeRejection: null, sandboxStreamBroke: false, answerKeyReceived: false, agentStarted: true, agentSeconds: 60,
    meter: { nCalls: 4, lastStatus: 200, lastUnfinished: false, input: 1000, cached: 0, output: 100 },
    ...overrides,
  };
}

const RUN: BoardRun = {
  runId: "run-1", createdAt: "2026-10-01T00:00:00Z", model: "org/Model-1", provider: "ref", stage: "full", effort: "high",
  harnessVersions: { h1: "1.0", h2: "2.0" }, harnessAdapters: {}, harnessLocks: {}, benchmarkSetups: { "bench-x": { commit: "c1" } }, price: { input: 1, cached_input: 0, output: 10 },
};

const CONFIG: BoardConfig = {
  benchmarks: { "bench-x": { commit: "c1", strata: "difficulty", subsets: { pilot: ["a"], full: ["a", "b"] }, taskStrata: {}, excluded: [], unscored: false } },
  harnesses: { h1: { version: "1.0", released: true }, h2: { version: "2.0", released: true } },
  models: { "org/Model-1": { defaultProvider: "ref", released: true, admittedProviders: ["ref"] } },
  adapterIds: {},
  lockRecords: {},
  stagedReleases: { "release-out": "0.1.3", "release-pending": null, "release-later": "0.1.10" },
  boardVersion: "0.1.5",
};

function inputs(facts: BoardFact[], published: BoardInputs["published"] = {}, invalid: BoardInputs["invalid"] = {}): BoardInputs {
  return { benchmark: "bench-x", facts, runs: { "run-1": RUN }, invalid, config: CONFIG, published, fetchedAt: "" };
}

describe("board trial outcome", () => {
  it.each([
    ["a received answer key fails a passing trial", { answerKeyReceived: true }, "fail"],
    ["a cancel is neither scored nor an error", { exception: "CancelledError" }, "cancelled"],
    ["a provider failure on the last call is infrastructure", { meter: { nCalls: 3, lastStatus: 429, lastUnfinished: false, input: 1, cached: 0, output: 1 } }, "infra"],
    ["a last stream that the provider ended without its answer is infrastructure", { meter: { nCalls: 3, lastStatus: 200, lastUnfinished: true, input: 1, cached: 0, output: 1 } }, "infra"],
    ["a broken sandbox command stream is infrastructure", { sandboxStreamBroke: true }, "infra"],
    ["an agent that never started is infrastructure", { agentStarted: false }, "infra"],
    ["a negative reward is the grader's crash", { reward: -1 }, "infra"],
    ["a timeout with no metered call keeps its reward", { exception: "AgentTimeoutError", meter: null, reward: 1 }, "pass"],
    ["a reward below 1 fails", { reward: 0.99 }, "fail"],
  ] as const)("%s", (_name, overrides, expected) => {
    expect(outcome(fact({ id: "t", task: "a", ...overrides }))).toBe(expected);
  });
});

describe("public board cells", () => {
  it("scores the earliest three scored attempts per task and leaves out what an invalid rule covers", () => {
    const facts = [
      fact({ id: "a1", task: "a" }), fact({ id: "a2", task: "a", reward: 0 }), fact({ id: "a3", task: "a" }), fact({ id: "a4", task: "a", reward: 0 }),
      fact({ id: "b1", task: "b" }), fact({ id: "b2", task: "b", meter: { nCalls: 2, lastStatus: 503, lastUnfinished: false, input: 1, cached: 0, output: 1 } }),
      fact({ id: "b3", task: "b", trial: "b3-trial" }),
    ];
    const cell = publicCells(inputs(facts, {}, { "run-1": [{ trials: ["b3-trial"] }] })).get("org/Model-1|full|high|h1")!;
    expect([...cell.tally]).toEqual([["a", [2, 3]], ["b", [1, 1]]]);
    expect(cell.nInfra).toBe(1);
    expect(cell.rate).toBeCloseTo((2 / 3 + 1) / 2, 12);
  });

  it("shows a harness's trials only through the adapter build that its public adapter id pins", () => {
    const config: BoardConfig = { ...CONFIG, harnesses: { h1: { version: "1.0", adapter: "bridge", publicAdapter: "bridge@000000000001", released: true } }, adapterIds: { bridge: "bridge@000000000002" } };
    const cells = (adapter: string) => publicCells({ ...inputs([fact({ id: "a1", task: "a" })]), config, runs: { "run-1": { ...RUN, harnessAdapters: { h1: adapter } } } });
    expect(cells("bridge@000000000001").has("org/Model-1|full|high|h1")).toBe(true);
    expect(cells("bridge@000000000002").has("org/Model-1|full|high|h1")).toBe(false);
  });

  it("shows a harness's trials only from the lock that its public identity names", () => {
    const record = { sha256: "000000000001", packages: { lib: "1.3.0" } };
    const shown = (spec: BoardConfig["harnesses"][string], recorded: BoardRun["harnessLocks"][string]) => publicCells({
      ...inputs([fact({ id: "a1", task: "a" })]),
      config: { ...CONFIG, harnesses: { h1: spec }, lockRecords: { lock1: record } },
      runs: { "run-1": { ...RUN, harnessLocks: { h1: recorded } } },
    }).has("org/Model-1|full|high|h1");
    expect(shown({ version: "1.0", lock: "lock1", released: true }, { packages: { lib: "1.3.0" }, sha256: "000000000001" })).toBe(true);
    expect(shown({ version: "1.0", lock: "lock1", released: true }, null)).toBe(false);
    expect(shown({ version: "1.0", lock: "lock1", publicLock: null, released: true }, null)).toBe(true);
    expect(shown({ version: "1.0", lock: "lock1", publicLock: null, released: true }, record)).toBe(false);
  });

  it("applies a staged invalid rule and shows a held run's trials only once their release is out", () => {
    const facts = [
      fact({ id: "a1", task: "a", trial: "a1-trial" }), fact({ id: "a2", task: "a", trial: "a2-trial" }), fact({ id: "a3", task: "a", trial: "a3-trial" }),
      fact({ id: "b1", task: "b", runId: "run-held" }), fact({ id: "b2", task: "b", reusedFrom: "run-held" }), fact({ id: "b3", task: "b", runId: "run-later" }),
    ];
    const invalid = { "run-1": [{ trials: ["a1-trial"], fromRelease: "release-pending" }, { trials: ["a2-trial"], fromRelease: "release-out" }, { trials: ["a3-trial"], fromRelease: "release-later" }] };
    const runs = { "run-1": RUN, "run-held": { ...RUN, runId: "run-held", fromRelease: "release-pending" }, "run-later": { ...RUN, runId: "run-later", fromRelease: "release-later" } };
    const cell = publicCells({ ...inputs(facts, {}, invalid), runs }).get("org/Model-1|full|high|h1")!;
    expect([...cell.tally]).toEqual([["a", [2, 2]]]);
  });

  it("fills a task's open attempts with provider failures when the evidence of every stage reaches the limit", () => {
    const stalled = { nCalls: 2, lastStatus: 200, lastUnfinished: true, input: 1, cached: 0, output: 1 };
    const facts = [
      ...["p1", "p2", "p3"].map((id) => fact({ id, task: "a", runId: "run-pilot", meter: stalled })),
      ...["f1", "f2", "f3"].map((id) => fact({ id, task: "a", meter: stalled })),
    ];
    const runs = { "run-1": RUN, "run-pilot": { ...RUN, runId: "run-pilot", stage: "pilot", createdAt: "2026-09-01T00:00:00Z" } };
    const cells = publicCells({ ...inputs(facts), runs });
    expect([...cells.get("org/Model-1|full|high|h1")!.tally]).toEqual([["a", [0, 3]]]);
    expect([...cells.get("org/Model-1|pilot|high|h1")!.tally]).toEqual([["a", [0, 1]]]);
  });

  it("reports a published cell that the recomputation contradicts", () => {
    const cellOf = (rate: number) => ({ leaderboard: { "org/Model-1": { stages: { full: { efforts: { high: { harnesses: { h1: { benchmarks: { "bench-x": {
      n_trials: 2, n_scored: 2, n_pass: 1, n_infra: 0, n_tasks: 2, n_tasks_expected: 2, rate, ci: [0.09453, 0.9055], cost_usd: 0.004,
    } } } } } } } } } } });
    const facts = [fact({ id: "a1", task: "a" }), fact({ id: "b1", task: "b", reward: 0 })];
    expect(verifyPublished(inputs(facts, cellOf(0.5))).mismatches).toEqual([]);
    expect(verifyPublished(inputs(facts, cellOf(0.6))).mismatches).toEqual([{ key: "org/Model-1|full|high|h1", field: "rate", published: 0.6, recomputed: 0.5 }]);
  });
});

describe("paired bootstrap", () => {
  it("reproduces the board's seeded interval", () => {
    // Expected values from the board's paired_diff in CPython 3.15 on the same tallies.
    const a = new Map([3, 2, 1, 0, 3, 2, 2, 1, 3, 0].map((k, index) => [`t${index}`, [k, 3] as const]));
    const b = new Map([1, 1, 1, 1, 2, 2, 0, 0, 3, 1].map((k, index) => [`t${index}`, [k, 3] as const]));
    expect(pairedDiff("bench-x", a, b)).toEqual({ diff: 0.166666666667, ci: [-0.033333333332999995, 0.366666666667], tied: true, nTasks: 10, tasks: [...a.keys()] });
  });

  it("draws the same doubles as CPython's generator", () => {
    expect(new PythonRandom(7).random()).toBe(0.32383276483316237);
    expect(new PythonRandom("a").random()).toBe(0.2720295377534757);
  });
});

describe("board comparison", () => {
  it("places a round that measured only the full split in the board's field, each harness with its paired difference, with no projection", () => {
    const facts = [
      fact({ id: "a1", task: "a" }), fact({ id: "b1", task: "b", reward: 0 }),
      fact({ id: "a2", task: "a", harness: "h2" }), fact({ id: "b2", task: "b", harness: "h2" }),
    ];
    const full = { split: "full", tasks: 2, score: 0.5, scoredScore: 0.5, scoredTasks: 2, withoutHubBroken: 0.5, hubBrokenTasks: 0 };
    const score: RoundScore = { tasks: new Map([["a", [1, 1]], ["b", [0, 1]]]), splits: [full], infra: 0, graderLost: 0, answerKeyFails: 0 };
    const comparison = compareWithBoard(harborBenchmark("terminal-bench-2.1"), score, inputs(facts), { model: "org/Model-1", effort: "high" });
    expect(comparison.projection).toBeUndefined();
    expect(comparison.field.map(({ harness, rate, diff }) => [harness, rate, diff?.diff, diff?.nTasks])).toEqual([["h2", 1, -0.5, 2], ["h1", 0.5, 0, 2]]);
  });
});
