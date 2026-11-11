import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main as compareRuns } from "../../../bench/ab-persona/compare.js";
import { createBenchmarkCatalog } from "../../../src/orchestration/modules/development/benchmark/catalog.js";
import { benchmarkTaskIdentity, structuredIdentity } from "../../../src/orchestration/modules/development/benchmark/content-identity.js";
import { admitBenchmark } from "../../../src/orchestration/modules/development/benchmark/admission.js";
import { dryRunBenchmarkAdmission, dryRunBenchmarkRuntime } from "../../helpers/benchmark-admission.js";
import { appendJsonLine } from "../../../src/orchestration/modules/development/benchmark/json-lines.js";
import {
  createRunStore,
  type ImplementRunRecord,
  type RunConfig,
} from "../../../src/orchestration/modules/development/benchmark/run-store.js";
import {
  createCrossComparisonV2Store,
  type CrossComparisonV2Config,
} from "../../../src/orchestration/modules/development/benchmark/comparison-v2-store.js";
import type { ImplementTask } from "../../../src/orchestration/modules/development/benchmark/catalog.js";
import { MINIMAL_IMPLEMENTATION_PLAN } from "../../helpers/implementation-plan.js";

type BenchmarkModelSeat = Parameters<typeof admitBenchmark>[1][number];

const ACCOUNTING = {
  estimatedUsd: { kind: "observed", value: 0.01 },
  billedUsd: { kind: "observed", value: 0 },
  tokens: { kind: "observed", value: 100 },
  providers: { kind: "observed", value: ["openai_subscription"] },
  pricedEntryCount: 1,
  unpricedEntryCount: 0,
} as const;

function admittedJudge(
  seats: readonly BenchmarkModelSeat[],
  complete: (prompt: string, signal: AbortSignal) => Promise<{ text: string; accounting: typeof ACCOUNTING }>,
) {
  return { ...dryRunBenchmarkAdmission(seats), createJudge: async () => ({ complete }) };
}

let fixtureRoot: string | undefined;

afterEach(async () => {
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
  fixtureRoot = undefined;
});

async function location() {
  fixtureRoot = await mkdtemp(join(tmpdir(), "cross-store-"));
  return { resultsRoot: fixtureRoot, directory: join(fixtureRoot, "comparison") };
}

async function comparisonTasks(): Promise<{ tasks: readonly ImplementTask[]; projectRoot: string }> {
  const root = await mkdtemp(join(tmpdir(), "cross-compare-"));
  fixtureRoot = root;
  const catalog = createBenchmarkCatalog(root);
  for (const id of ["first", "second"]) {
    const directory = join(catalog.implementTasksDir, id);
    await mkdir(join(directory, "project"), { recursive: true });
    await mkdir(join(directory, "acceptance"));
    await Bun.write(join(directory, "task.json"), JSON.stringify({ id, stratum: "small" }));
    await Bun.write(join(directory, "plan.json"), JSON.stringify(MINIMAL_IMPLEMENTATION_PLAN));
    await Bun.write(join(directory, "manifest.json"), JSON.stringify({
      traps: [{ id: "trap", title: "Trap", catchCriteria: "Catch it" }], judgment: [],
    }));
    await Bun.write(join(directory, "project", "value.ts"), "export const value = 1;\n");
  }
  return { tasks: await catalog.implementTasks(), projectRoot: root };
}

const SOURCE_VARIANT = { id: "model@low", model: "model", effort: "low" } as const;

async function writeSource(
  directory: string,
  tasks: readonly ImplementTask[],
  taskIdentity: string,
  personaGuidanceIdentity = "7".repeat(64),
  repeats = 1,
  trapIds: (task: ImplementTask) => readonly string[] = (task) => task.manifest.traps.map((trap) => trap.id),
): Promise<void> {
  if (!fixtureRoot) throw new Error("comparison root is missing");
  const config: RunConfig = {
    kind: "benchmark-config",
    persona: "implementer",
    mode: "implement",
    variants: [SOURCE_VARIANT],
    repeats,
    stamp: directory,
    identity: {
      profileId: `profile-${directory}`,
      authorityIncarnation: `incarnation-${directory}`,
      contentIdentity: "8".repeat(64),
    },
    taskIdentity,
    personaGuidanceIdentity,
    judgeIdentity: "9".repeat(64),
    scoringVersion: "persona-v2",
  };
  const store = await createRunStore({ resultsRoot: fixtureRoot, directory: join(fixtureRoot, directory) }, config);
  for (const task of tasks) {
    for (let repeat = 0; repeat < repeats; repeat++) {
      const run: ImplementRunRecord = {
        kind: "agent-run",
        persona: "implementer",
        mode: "implement",
        variant: SOURCE_VARIANT.id,
        model: SOURCE_VARIANT.model,
        effort: SOURCE_VARIANT.effort,
        task: task.id,
        repeat,
        accounting: ACCOUNTING,
        durationMs: 1,
        summary: "implemented",
        diff: "diff --git a/value.ts b/value.ts\n",
        linesAdded: 1,
        linesRemoved: 0,
        filesTouched: 1,
        acceptancePassed: 1,
        acceptanceFailed: 0,
        acceptanceTotal: 1,
      };
      await store.appendRun(run);
      await store.appendScore({
        kind: "trap-score",
        mode: "implement",
        persona: "implementer",
        error: null,
        score: {
          variant: SOURCE_VARIANT.id,
          task: task.id,
          repeat,
          traps: trapIds(task).map((id) => ({ id, outcome: "unclear" as const, rationale: "fixture" })),
        },
      });
    }
  }
}

async function assertTrapIdsRejected(mutate: (ids: readonly string[]) => readonly string[]): Promise<void> {
  const { tasks, projectRoot: root } = await comparisonTasks();
  const taskIdentity = benchmarkTaskIdentity(tasks);
  const target = tasks.find((task) => task.manifest.traps.length > 0);
  if (!target) throw new Error("The implement corpus needs a trap-bearing task");
  await writeSource("source-a", tasks, taskIdentity, undefined, 1, (task) => {
    const ids = task.manifest.traps.map((trap) => trap.id);
    return task.id === target.id ? mutate(ids) : ids;
  });
  await writeSource("source-b", tasks, taskIdentity);
  let admitted = false;
  await expect(compareRuns([
    "--candidate", join(root, "source-a"), SOURCE_VARIANT.id,
    "--candidate", join(root, "source-b"), SOURCE_VARIANT.id,
    "--results", join(root, "comparison"),
  ], root, {
    createRuntime: async () => dryRunBenchmarkRuntime(() => {}),
    admitModels: async (_deps, seats) => {
      admitted = true;
      return dryRunBenchmarkAdmission(seats);
    },
    createComparisonStore: createCrossComparisonV2Store,
  })).rejects.toThrow(/manifest/i);
  expect(admitted).toBe(false);
}

function comparisonV2Config(): CrossComparisonV2Config {
  const body = {
    sources: [
      { directory: "/results/a", configIdentity: "a".repeat(64), campaign: { profileId: "candidate-a", authorityIncarnation: "inc-a", contentIdentity: "1".repeat(64) }, variant: SOURCE_VARIANT, label: "a" },
      { directory: "/results/b", configIdentity: "b".repeat(64), campaign: { profileId: "candidate-b", authorityIncarnation: "inc-b", contentIdentity: "2".repeat(64) }, variant: SOURCE_VARIANT, label: "b" },
    ],
    candidatePairs: [{ task: "task", repeat: 0, labelA: "a", labelB: "b", candidateAIdentity: "3".repeat(64), candidateBIdentity: "4".repeat(64) }],
    taskIdentity: "5".repeat(64),
    personaGuidanceIdentity: "guidance",
    judgeModel: "judge",
    judgeRubricIdentity: "6".repeat(64),
    scoringVersion: "cross-implement-v2",
    judge: { profileId: "judge-profile", authorityIncarnation: "judge-inc", contentIdentity: "6".repeat(64) },
  };
  return { kind: "cross-comparison-config-v2", identity: structuredIdentity(body), ...body };
}

function comparisonV2ConfigWithSecondPair(): CrossComparisonV2Config {
  const first = comparisonV2Config();
  const body = {
    ...first,
    sources: [
      ...first.sources,
      { directory: "/results/c", configIdentity: "c".repeat(64), campaign: first.sources[1]!.campaign, variant: SOURCE_VARIANT, label: "c" },
    ],
    candidatePairs: [
      ...first.candidatePairs,
      { task: "task", repeat: 0, labelA: "a", labelB: "c", candidateAIdentity: "3".repeat(64), candidateBIdentity: "8".repeat(64) },
    ],
  };
  const { kind: _kind, identity: _identity, ...identityBody } = body;
  return { kind: "cross-comparison-config-v2", identity: structuredIdentity(identityBody), ...identityBody };
}

describe("cross-run comparison store", () => {
  it("rejects v2 scores and attempts outside their configured candidate pair", async () => {
    const config = comparisonV2Config();
    const store = await createCrossComparisonV2Store(await location(), config);
    const verdict = { task: "task", repeat: 0, slotA: "a", slotB: "b", winner: "a", rationale: "better" };
    await store.appendJudgeAttempt({
      kind: "cross-judge-attempt-v2",
      comparisonIdentity: config.identity,
      attemptId: "winner-attempt",
      at: "2026-09-10T00:00:00.000Z",
      score: { task: verdict.task, repeat: verdict.repeat, slotA: verdict.slotA, slotB: verdict.slotB },
      terminal: "completed",
      accounting: ACCOUNTING,
    });
    await store.appendScore({ kind: "cross-pair-score-v2", comparisonIdentity: config.identity, attemptId: "winner-attempt", verdict: { ...verdict, winner: "foreign" } });
    await expect(store.loadEvidence()).rejects.toThrow(/winner/i);

    const second = await createCrossComparisonV2Store(
      { resultsRoot: fixtureRoot!, directory: join(fixtureRoot!, "comparison-2") },
      config,
    );
    await second.appendJudgeAttempt({
      kind: "cross-judge-attempt-v2",
      comparisonIdentity: config.identity,
      attemptId: "attempt",
      at: "2026-09-10T00:00:00.000Z",
      score: { task: "foreign", repeat: 0, slotA: "a", slotB: "b" },
      terminal: "failed",
      accounting: ACCOUNTING,
    });
    await expect(second.loadEvidence()).rejects.toThrow(/configured candidate pair/i);
  });

  it("rejects an orphan v2 score and accepts a completed attempt after a prior failure", async () => {
    const config = comparisonV2Config();
    const verdict = { task: "task", repeat: 0, slotA: "a", slotB: "b", winner: "a", rationale: "better" };
    const store = await createCrossComparisonV2Store(await location(), config);
    await store.appendScore({ kind: "cross-pair-score-v2", comparisonIdentity: config.identity, attemptId: "missing", verdict });
    await expect(store.loadEvidence()).rejects.toThrow(/attempt/i);

    const second = await createCrossComparisonV2Store(
      { resultsRoot: fixtureRoot!, directory: join(fixtureRoot!, "comparison-2") },
      config,
    );
    const attempt = {
      kind: "cross-judge-attempt-v2" as const,
      comparisonIdentity: config.identity,
      at: "2026-09-10T00:00:00.000Z",
      score: { task: "task", repeat: 0, slotA: "a", slotB: "b" },
      accounting: ACCOUNTING,
    };
    await second.appendJudgeAttempt({ ...attempt, attemptId: "failed", terminal: "failed" });
    await second.appendJudgeAttempt({ ...attempt, attemptId: "completed", terminal: "completed" });
    await second.appendScore({ kind: "cross-pair-score-v2", comparisonIdentity: config.identity, attemptId: "completed", verdict });
    expect((await second.loadEvidence()).scores).toHaveLength(1);
  });

  it("requires a v2 verdict to preserve its attempt's ordered slot identity", async () => {
    const config = comparisonV2Config();
    const store = await createCrossComparisonV2Store(await location(), config);
    await store.appendJudgeAttempt({
      kind: "cross-judge-attempt-v2",
      comparisonIdentity: config.identity,
      attemptId: "reversed",
      at: "2026-09-10T00:00:00.000Z",
      score: { task: "task", repeat: 0, slotA: "b", slotB: "a" },
      terminal: "completed",
      accounting: ACCOUNTING,
    });
    await store.appendScore({
      kind: "cross-pair-score-v2",
      comparisonIdentity: config.identity,
      attemptId: "reversed",
      verdict: { task: "task", repeat: 0, slotA: "a", slotB: "b", winner: "a", rationale: "better" },
    });

    await expect(store.loadEvidence()).rejects.toThrow(/ordered identity/i);
  });

  for (const terminal of ["failed", "timed-out", "cancelled"] as const) {
    it(`rejects a score tied to a ${terminal} attempt when the pair also has a completed attempt`, async () => {
      const config = comparisonV2Config();
      const store = await createCrossComparisonV2Store(await location(), config);
      const attempt = {
        kind: "cross-judge-attempt-v2" as const,
        comparisonIdentity: config.identity,
        at: "2026-09-10T00:00:00.000Z",
        score: { task: "task", repeat: 0, slotA: "a", slotB: "b" },
        accounting: ACCOUNTING,
      };
      await store.appendJudgeAttempt({ ...attempt, attemptId: terminal, terminal });
      await store.appendJudgeAttempt({ ...attempt, attemptId: "completed", terminal: "completed" });
      await store.appendScore({
        kind: "cross-pair-score-v2",
        comparisonIdentity: config.identity,
        attemptId: terminal,
        verdict: { ...attempt.score, winner: "a", rationale: "better" },
      });

      await expect(store.loadEvidence()).rejects.toThrow(`Comparison score attempt is not completed: ${terminal}`);
    });
  }

  it("rejects a score whose completed attempt belongs to another configured pair", async () => {
    const config = comparisonV2ConfigWithSecondPair();
    const store = await createCrossComparisonV2Store(await location(), config);
    await store.appendJudgeAttempt({
      kind: "cross-judge-attempt-v2",
      comparisonIdentity: config.identity,
      attemptId: "other-pair",
      at: "2026-09-10T00:00:00.000Z",
      score: { task: "task", repeat: 0, slotA: "a", slotB: "c" },
      terminal: "completed",
      accounting: ACCOUNTING,
    });
    await store.appendScore({
      kind: "cross-pair-score-v2",
      comparisonIdentity: config.identity,
      attemptId: "other-pair",
      verdict: { task: "task", repeat: 0, slotA: "a", slotB: "b", winner: "a", rationale: "better" },
    });

    await expect(store.loadEvidence()).rejects.toThrow(/ordered identity/i);
  });

  it("rejects source campaigns whose task fixtures differ", async () => {
    const { tasks, projectRoot: root } = await comparisonTasks();
    const currentTaskIdentity = benchmarkTaskIdentity(tasks);
    await writeSource("source-a", tasks, currentTaskIdentity);
    await writeSource("source-b", tasks, "a".repeat(64));

    await expect(compareRuns([
      "--candidate", join(root, "source-a"), SOURCE_VARIANT.id,
      "--candidate", join(root, "source-b"), SOURCE_VARIANT.id,
      "--results", join(root, "comparison"),
      "--dry-run",
    ], root)).rejects.toThrow("taskIdentity");
  });

  it("rejects missing trap IDs before judge admission", async () => {
    await assertTrapIdsRejected((ids) => ids.slice(1));
  });

  it("rejects duplicate trap IDs before judge admission", async () => {
    await assertTrapIdsRejected((ids) => [...ids, ids[0]!]);
  });

  it("rejects a source repeat-count mismatch before judge admission", async () => {
    const { tasks, projectRoot: root } = await comparisonTasks();
    const currentTaskIdentity = benchmarkTaskIdentity(tasks);
    await writeSource("source-a", tasks, currentTaskIdentity);
    await writeSource("source-b", tasks, currentTaskIdentity, "7".repeat(64), 2);
    let admitted = false;

    await expect(compareRuns([
      "--candidate", join(root, "source-a"), SOURCE_VARIANT.id,
      "--candidate", join(root, "source-b"), SOURCE_VARIANT.id,
      "--results", join(root, "comparison"),
    ], root, {
      createRuntime: async () => dryRunBenchmarkRuntime(() => {}),
      admitModels: async (_deps, seats) => {
        admitted = true;
        return dryRunBenchmarkAdmission(seats);
      },
      createComparisonStore: createCrossComparisonV2Store,
    })).rejects.toThrow(/repeat/i);
    expect(admitted).toBe(false);
  });

  it("admits the judge against the captured profile before dry-run completes", async () => {
    const { tasks, projectRoot: root } = await comparisonTasks();
    const currentTaskIdentity = benchmarkTaskIdentity(tasks);
    await writeSource("source-a", tasks, currentTaskIdentity);
    await writeSource("source-b", tasks, currentTaskIdentity);
    let disposed = 0;
    let admitted: readonly BenchmarkModelSeat[] = [];

    await compareRuns([
      "--candidate", join(root, "source-a"), SOURCE_VARIANT.id,
      "--candidate", join(root, "source-b"), SOURCE_VARIANT.id,
      "--results", join(root, "comparison"),
      "--dry-run",
    ], root, {
      createRuntime: async () => dryRunBenchmarkRuntime(() => { disposed++; }),
      admitModels: async (_deps, seats) => {
        admitted = seats;
        return dryRunBenchmarkAdmission(seats);
      },
      createComparisonStore: async () => { throw new Error("comparison store constructed"); },
    });

    expect(admitted).toEqual([{ role: "judge", model: "gpt-6.1-sol", effort: "high" }]);
    expect(disposed).toBe(1);
  });

  it("compares every unordered pair across three complete candidates and writes standings", async () => {
    const { tasks, projectRoot: root } = await comparisonTasks();
    const currentTaskIdentity = benchmarkTaskIdentity(tasks);
    await writeSource("source-a", tasks, currentTaskIdentity, undefined, 2);
    await writeSource("source-b", tasks, currentTaskIdentity, undefined, 2);
    await writeSource("source-c", tasks, currentTaskIdentity, undefined, 2);
    const comparison = join(root, "comparison");
    let judgeCalls = 0;

    await compareRuns([
      "--candidate", join(root, "source-a"), SOURCE_VARIANT.id,
      "--candidate", join(root, "source-b"), SOURCE_VARIANT.id,
      "--candidate", join(root, "source-c"), SOURCE_VARIANT.id,
      "--results", comparison,
    ], root, {
      createRuntime: async () => dryRunBenchmarkRuntime(() => {}),
      admitModels: async (_deps, seats) => admittedJudge(seats, async () => {
        judgeCalls++;
        return { text: '{"winner":"A","rationale":"better"}', accounting: ACCOUNTING };
      }),
      createComparisonStore: createCrossComparisonV2Store,
    });

    const store = await createCrossComparisonV2Store({ resultsRoot: root, directory: comparison });
    const config = await store.loadConfig();
    const evidence = await store.loadEvidence();
    const expectedPairCount = tasks.length * 2 * 3;
    expect(config.candidatePairs).toHaveLength(expectedPairCount);
    expect(new Set(config.candidatePairs.map((pair) =>
      `${pair.task}\u0000${pair.repeat}\u0000${[pair.labelA, pair.labelB].sort().join("\u0000")}`,
    )).size).toBe(expectedPairCount);
    expect(judgeCalls).toBe(expectedPairCount);
    expect(evidence.attempts).toHaveLength(expectedPairCount);
    expect(evidence.scores).toHaveLength(expectedPairCount);
    const report = await Bun.file(join(comparison, "report.md")).text();
    expect(report).toContain("| Rank | Candidate | Variant |");
    for (const source of config.sources) expect(report).toContain(`| ${source.label} | ${source.variant.id} |`);
    expect(report).toContain(`Judge attempts: ${expectedPairCount}; failed: 0;`);
  });

  it("resumes an incomplete three-candidate ledger without rejudging successful evidence", async () => {
    const { tasks, projectRoot: root } = await comparisonTasks();
    const currentTaskIdentity = benchmarkTaskIdentity(tasks);
    await writeSource("source-a", tasks, currentTaskIdentity, undefined, 2);
    await writeSource("source-b", tasks, currentTaskIdentity, undefined, 2);
    await writeSource("source-c", tasks, currentTaskIdentity, undefined, 2);
    const comparison = join(root, "comparison");
    const candidates = [
      "--candidate", join(root, "source-a"), SOURCE_VARIANT.id,
      "--candidate", join(root, "source-b"), SOURCE_VARIANT.id,
      "--candidate", join(root, "source-c"), SOURCE_VARIANT.id,
    ];
    const deps = {
      createRuntime: async () => dryRunBenchmarkRuntime(() => {}),
      admitModels: async (_deps: Parameters<typeof admitBenchmark>[0], seats: readonly BenchmarkModelSeat[]) =>
        admittedJudge(seats, async () => ({ text: '{"winner":"A","rationale":"better"}', accounting: ACCOUNTING })),
      createComparisonStore: createCrossComparisonV2Store,
    };
    await compareRuns([...candidates, "--results", comparison], root, deps);
    const initialStore = await createCrossComparisonV2Store({ resultsRoot: root, directory: comparison });
    const initial = await initialStore.loadEvidence();
    const retainedScore = initial.scores[0];
    if (!retainedScore) throw new Error("Expected initial successful comparison evidence");
    const retainedAttempt = initial.attempts.find((attempt) => attempt.attemptId === retainedScore.attemptId);
    if (!retainedAttempt) throw new Error("Expected the score's successful judge attempt");
    const failedAttempt = {
      ...retainedAttempt,
      attemptId: "failed-before-resume",
      terminal: "failed" as const,
      accounting: { ...ACCOUNTING, estimatedUsd: { kind: "unavailable" as const, reason: "stream ended before usage", atLeast: 0.02 } },
    };
    await Bun.write(join(comparison, "scores.jsonl"), `${JSON.stringify(retainedScore)}\n`);
    await Bun.write(join(comparison, "judge-attempts.jsonl"), `${JSON.stringify(retainedAttempt)}\n${JSON.stringify(failedAttempt)}\n`);

    let resumedJudgeCalls = 0;
    await compareRuns(["--resume", comparison], root, {
      ...deps,
      admitModels: async (_deps, seats) => admittedJudge(seats, async () => {
        resumedJudgeCalls++;
        return { text: '{"winner":"A","rationale":"better"}', accounting: ACCOUNTING };
      }),
    });

    const completed = await initialStore.loadEvidence();
    const expectedPairCount = tasks.length * 2 * 3;
    expect(resumedJudgeCalls).toBe(expectedPairCount - 1);
    expect(completed.scores).toHaveLength(expectedPairCount);
    expect(completed.scores.filter((score) => score.attemptId === retainedScore.attemptId)).toEqual([retainedScore]);
    expect(completed.attempts).toHaveLength(expectedPairCount + 1);
    expect(completed.attempts.filter((attempt) => attempt.terminal !== "completed")).toEqual([failedAttempt]);
    const report = await Bun.file(join(comparison, "report.md")).text();
    expect(report).toContain(`Judge attempts: ${expectedPairCount + 1}; failed: 1; estimated equivalent: at least $${(expectedPairCount * 0.01 + 0.02).toFixed(4)};`);
    expect(report.match(/^\| \d+ \| model@low\[source-[abc]\] \|/gm)).toHaveLength(3);
  });

  it("rejects malformed cross-attempt evidence before judge work", async () => {
    const { tasks, projectRoot: root } = await comparisonTasks();
    const currentTaskIdentity = benchmarkTaskIdentity(tasks);
    await writeSource("source-a", tasks, currentTaskIdentity);
    await writeSource("source-b", tasks, currentTaskIdentity);
    await appendJsonLine(join(root, "source-a", "judge-attempts.jsonl"), { malformed: true });
    let judgeCalls = 0;

    await expect(compareRuns([
      "--candidate", join(root, "source-a"), SOURCE_VARIANT.id,
      "--candidate", join(root, "source-b"), SOURCE_VARIANT.id,
      "--results", join(root, "comparison"),
    ], root, {
      createRuntime: async () => dryRunBenchmarkRuntime(() => {}),
      admitModels: async (_deps, seats) => admittedJudge(seats, async () => {
        judgeCalls++;
        return { text: '{"winner":"A","rationale":"better"}', accounting: ACCOUNTING };
      }),
      createComparisonStore: async () => { throw new Error("comparison store constructed"); },
    })).rejects.toThrow(/judge-attempts\.jsonl/);
    expect(judgeCalls).toBe(0);
  });

  async function assertFailedJudgeAttemptPersists(terminal: "completed" | "cancelled"): Promise<void> {
    const { tasks, projectRoot: root } = await comparisonTasks();
    const currentTaskIdentity = benchmarkTaskIdentity(tasks);
    await writeSource("source-a", tasks, currentTaskIdentity);
    await writeSource("source-b", tasks, currentTaskIdentity);
    const comparison = join(root, "comparison");
    const controller = new AbortController();

    await expect(compareRuns([
      "--candidate", join(root, "source-a"), SOURCE_VARIANT.id,
      "--candidate", join(root, "source-b"), SOURCE_VARIANT.id,
      "--results", comparison,
    ], root, {
      createRuntime: async () => dryRunBenchmarkRuntime(() => {}),
      admitModels: async (_deps, seats) => ({
        ...dryRunBenchmarkAdmission(seats),
        createJudge: async () => ({
          complete: terminal === "completed"
            ? async () => ({ text: "not json", accounting: ACCOUNTING })
            : async (_prompt: string, signal: AbortSignal) => {
              controller.abort();
              await Promise.resolve();
              signal.throwIfAborted();
              return { text: "", accounting: ACCOUNTING };
            },
        }),
      }),
      createComparisonStore: createCrossComparisonV2Store,
      signal: controller.signal,
    })).rejects.toThrow();

    const store = await createCrossComparisonV2Store({ resultsRoot: root, directory: comparison });
    const evidence = await store.loadEvidence();
    expect(evidence.scores).toEqual([]);
    expect(evidence.attempts.map((attempt) => attempt.terminal)).toContain(terminal);
  }

  it("persists an invalid judge attempt without a reusable score", async () => {
    await assertFailedJudgeAttemptPersists("completed");
  });

  it("persists a cancelled judge attempt without a reusable score", async () => {
    await assertFailedJudgeAttemptPersists("cancelled");
  });

  it("persists the randomized ordered pair identity from the judge attempt", async () => {
    const { tasks, projectRoot: root } = await comparisonTasks();
    const currentTaskIdentity = benchmarkTaskIdentity(tasks);
    await writeSource("source-a", tasks, currentTaskIdentity);
    await writeSource("source-b", tasks, currentTaskIdentity);
    const comparison = join(root, "comparison");
    const random = Math.random;
    Math.random = () => 1;
    try {
      await compareRuns([
        "--candidate", join(root, "source-a"), SOURCE_VARIANT.id,
        "--candidate", join(root, "source-b"), SOURCE_VARIANT.id,
        "--results", comparison,
      ], root, {
        createRuntime: async () => dryRunBenchmarkRuntime(() => {}),
        admitModels: async (_deps, seats) =>
          admittedJudge(seats, async () => ({ text: '{"winner":"A","rationale":"better"}', accounting: ACCOUNTING })),
        createComparisonStore: createCrossComparisonV2Store,
      });
    } finally {
      Math.random = random;
    }

    const evidence = await (await createCrossComparisonV2Store({ resultsRoot: root, directory: comparison })).loadEvidence();
    const attempt = evidence.attempts[0];
    const verdict = evidence.scores[0]?.verdict;
    if (!attempt || !verdict) throw new Error("Expected persisted comparison evidence");
    expect(attempt.score).toEqual({
      task: verdict.task,
      repeat: verdict.repeat,
      slotA: verdict.slotA,
      slotB: verdict.slotB,
    });
  });
});
