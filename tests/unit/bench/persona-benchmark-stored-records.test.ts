import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBenchmarkCatalog, RESEARCH_TASKS_CHANGED } from "../../../src/orchestration/modules/development/benchmark/catalog.js";
import { unavailableJudgeAccounting } from "../../../src/orchestration/modules/development/benchmark/judge.js";
import { appendJsonLine } from "../../../src/orchestration/modules/development/benchmark/json-lines.js";
import {
  planPersonaBenchmark,
  runPersonaBenchmark,
  type BenchmarkPlan,
} from "../../../src/orchestration/modules/development/benchmark/persona-benchmark.js";
import { createPersonaStore as createRunStore } from "../../../src/orchestration/modules/development/benchmark/persona-store.js";
import { parseVariant } from "../../../src/orchestration/modules/development/benchmark/variant.js";
import { validateJudgeAttempts } from "../../../src/orchestration/modules/development/benchmark/persona-evidence-validation.js";
import {
  benchmarkDeps as deps,
  cancelledAttempt,
  EXPLORER_DEFINITION,
  fakeRuntime,
  pairScore,
  REVIEWER_DEFINITION,
} from "./_persona-benchmark-fixtures.js";

const VARIANTS = [parseVariant("model-a:medium"), parseVariant("model-b:high")];

const projectRoots: string[] = [];

afterEach(async () => {
  for (const root of projectRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function syntheticProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "flywheel-persona-benchmark-"));
  projectRoots.push(root);
  await mkdir(join(root, "src", "workflows", "agents", "personas"), { recursive: true });
  await Bun.write(join(root, "src", "workflows", "agents", "personas", "explorer.md"), EXPLORER_DEFINITION);
  return root;
}

/** A results directory holding a stored config and no records, plus the plan a
 *  later operation on it produces. Corrupt records are appended directly, which
 *  is what a torn or hand-edited results directory looks like. */
async function storedRun(root: string, operation: "resume" | "rescore" = "resume", persona?: string): Promise<{ plan: BenchmarkPlan; resultsDir: string }> {
  const catalog = createBenchmarkCatalog(root);
  const created = await planPersonaBenchmark({ ...(persona === undefined ? {} : { persona }), variants: VARIANTS, repeats: 1, operation: "run" }, catalog);
  const controller = new AbortController();
  controller.abort();
  await runPersonaBenchmark(created, deps(fakeRuntime(() => ({ terminal: { kind: "completed" } })), root, [], controller.signal));
  return { plan: await planPersonaBenchmark({ operation, resultsDir: created.resultsDir, variants: [] }, catalog), resultsDir: created.resultsDir };
}

describe("benchmark stored-record validation", () => {
  it("rejects judge attempt score kinds that do not belong to the campaign mode", () => {
    const task = { id: "task", prompt: "prompt", contentIdentity: "task-identity" };
    const variants = [{ id: "model-a@medium", model: "model-a", effort: "medium" }];
    const accounting = cancelledAttempt(task.id, "attempt").accounting;
    const attempt = {
      kind: "judge-attempt" as const,
      attemptId: "judge-attempt",
      at: "2026-07-31T00:00:00.000Z",
      persona: "explorer",
      mode: "research" as const,
      score: { kind: "review-score" as const, variant: variants[0]!.id, task: task.id, repeat: 0 },
      terminal: "completed" as const,
      accounting,
    };

    expect(() => validateJudgeAttempts(
      { persona: "explorer", mode: "research", repeats: 1, tasks: [task], variants },
      new Set([task.id]),
      [attempt],
    )).toThrow("review-score, which is not valid for research mode");
    expect(() => validateJudgeAttempts(
      { persona: "reviewer-code-quality", mode: "reviewer", repeats: 1, tasks: [task], variants },
      new Set([task.id]),
      [{ ...attempt, persona: "reviewer-code-quality", mode: "reviewer", score: { kind: "pair-score", task: task.id, repeat: 0, slotA: variants[0]!.id, slotB: "other" } }],
    )).toThrow("pair-score, which is not valid for reviewer mode");
    expect(() => validateJudgeAttempts(
      { persona: "implementer", mode: "implement", repeats: 1, tasks: [task], variants },
      new Set([task.id]),
      [{ ...attempt, persona: "implementer", mode: "implement", score: { kind: "review-score", variant: variants[0]!.id, task: task.id, repeat: 0 } }],
    )).toThrow("review-score, which is not valid for implement mode");
  });
  it("keeps a research campaign created before the corpus pin as read-only evidence", async () => {
    const root = await syntheticProject();
    const { plan, resultsDir } = await storedRun(root, "rescore");
    const manifestPath = join(resultsDir, "campaign.json");
    const manifest = await Bun.file(manifestPath).json();
    // The explorer suite's task identity as campaigns stored it before the pin, read from a real results directory.
    manifest.config.taskIdentity = "cd926375c3c10bc264815b89c25f5cbf29982a88fe791036a42680a6d9c577f7";
    await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const judges: string[] = [];
    const dependencies = { ...deps(fakeRuntime(() => ({ terminal: { kind: "completed" } })), root, []), createJudge: async () => { judges.push("judge"); throw new Error("no judge"); } };

    for (const operation of ["rescore", "resume"] as const) {
      const stored = operation === "rescore" ? plan : await planPersonaBenchmark({ operation, resultsDir, variants: [] }, createBenchmarkCatalog(root));
      await expect(runPersonaBenchmark(stored, dependencies)).rejects.toThrow(RESEARCH_TASKS_CHANGED);
    }
    expect(judges).toEqual([]);
  });

  it("rejects a repeated attempt ID, which would double-count spend paid once", async () => {
    const root = await syntheticProject();
    const { plan, resultsDir } = await storedRun(root);
    const attempt = cancelledAttempt(plan.tasks[0]!.id, "1f0f9c2e-0000-4000-8000-000000000001");
    await appendJsonLine(join(resultsDir, "events.jsonl"), attempt);
    await appendJsonLine(join(resultsDir, "events.jsonl"), attempt);

    await expect(runPersonaBenchmark(plan, deps(fakeRuntime(() => ({ terminal: { kind: "completed" } })), root, [])))
      .rejects.toThrow(`Duplicate attempt record ${attempt.attemptId}`);
  });

  it("counts unmatched judge attempts while reusing the one successful score", async () => {
    const root = await syntheticProject();
    const { plan, resultsDir } = await storedRun(root, "rescore");
    const task = plan.tasks[0]!.id;
    const verdict = { repeat: 0, slotA: "model-a@medium", slotB: "model-b@high", winner: "tie" };
    const accounting = cancelledAttempt(task, "unused").accounting;
    for (const [index, terminal] of ["failed", "completed", "completed"].entries()) {
      await appendJsonLine(join(resultsDir, "events.jsonl"), {
        kind: "judge-attempt",
        attemptId: `1f0f9c2e-0000-4000-8000-00000000000${index}`,
        at: `2026-09-10T00:00:0${index}.000Z`,
        persona: "explorer",
        mode: "research",
        score: { kind: "pair-score", task, repeat: 0, slotA: verdict.slotA, slotB: verdict.slotB },
        terminal,
        accounting,
      });
    }
    await appendJsonLine(join(resultsDir, "events.jsonl"), pairScore(task, verdict));

    const outcome = await runPersonaBenchmark(plan, deps(fakeRuntime(() => ({ terminal: { kind: "completed" } })), root, []));

    if (outcome.status !== "completed") throw new Error(`expected completion, got ${outcome.status}`);
    expect(outcome.counts.failedJudgeCalls).toBe(2);
    expect(await createRunStore({ resultsRoot: createBenchmarkCatalog(root).resultsRoot, directory: resultsDir }).then((store) => store.loadScores())).toHaveLength(1);
  });

  it("rejects a second successful verdict for one judged pair", async () => {
    const root = await syntheticProject();
    const { plan, resultsDir } = await storedRun(root, "rescore");
    const verdict = { repeat: 0, slotA: "model-a@medium", slotB: "model-b@high", winner: "tie" };
    for (let row = 0; row < 2; row++) {
      await appendJsonLine(join(resultsDir, "events.jsonl"), pairScore(plan.tasks[0]!.id, verdict));
    }

    await expect(runPersonaBenchmark(plan, deps(fakeRuntime(() => ({ terminal: { kind: "completed" } })), root, [])))
      .rejects.toThrow(/Duplicate score record for pair-score/);
  });

  it("rejects a second verdict for one judged pair", async () => {
    const root = await syntheticProject();
    const { plan, resultsDir } = await storedRun(root);
    const task = plan.tasks[0]!.id;
    for (const slots of [{ slotA: "model-a@medium", slotB: "model-b@high" }, { slotA: "model-b@high", slotB: "model-a@medium" }]) {
      await appendJsonLine(join(resultsDir, "events.jsonl"), pairScore(task, { repeat: 0, ...slots, winner: "tie" }));
    }

    await expect(runPersonaBenchmark(plan, deps(fakeRuntime(() => ({ terminal: { kind: "completed" } })), root, [])))
      .rejects.toThrow(/Duplicate score record for pair-score/);
  });

  it("rejects a verdict whose winner is neither participant", async () => {
    const root = await syntheticProject();
    const { plan, resultsDir } = await storedRun(root);
    await appendJsonLine(join(resultsDir, "events.jsonl"), pairScore(plan.tasks[0]!.id, {
      repeat: 0,
      slotA: "model-a@medium",
      slotB: "model-b@high",
      winner: "model-c@low",
    }));

    await expect(runPersonaBenchmark(plan, deps(fakeRuntime(() => ({ terminal: { kind: "completed" } })), root, [])))
      .rejects.toThrow(/names winner model-c@low, which is neither participant nor a tie/);
  });

  it("rejects a verdict naming an unconfigured seat, an unknown task, or a repeat outside the run", async () => {
    for (const [corruption, message] of [
      [{ slotB: "model-c@low" }, /names seat model-c@low/],
      [{ task: "no-such-task" }, /has an unknown task no-such-task/],
      [{ repeat: 4 }, /repeat 4 is outside the configured repeats 1/],
    ] as const) {
      const root = await syntheticProject();
      const { plan, resultsDir } = await storedRun(root);
      const base = { task: plan.tasks[0]!.id, repeat: 0, slotA: "model-a@medium", slotB: "model-b@high", winner: "tie" };
      const { task, ...verdict } = { ...base, ...corruption };
      await appendJsonLine(join(resultsDir, "events.jsonl"), pairScore(task, verdict));

      await expect(runPersonaBenchmark(plan, deps(fakeRuntime(() => ({ terminal: { kind: "completed" } })), root, [])))
        .rejects.toThrow(message);
    }
  });

  it("rejects a stored repeat that is not a zero-based index", async () => {
    const root = await syntheticProject();
    const { plan, resultsDir } = await storedRun(root);
    await appendJsonLine(join(resultsDir, "events.jsonl"), { ...cancelledAttempt(plan.tasks[0]!.id, "1f0f9c2e-0000-4000-8000-000000000002"), repeat: -1 });

    await expect(runPersonaBenchmark(plan, deps(fakeRuntime(() => ({ terminal: { kind: "completed" } })), root, [])))
      .rejects.toThrow(/events.jsonl:1 does not match its schema/);
  });

  it("reuses seeded review scores on resume and rejects defects its fixture does not seed", async () => {
    const root = await syntheticProject();
    await Bun.write(join(root, "src", "workflows", "agents", "personas", "reviewer-code-quality.md"), REVIEWER_DEFINITION);
    const fixture = join(root, "bench", "ab-persona", "fixtures", "reviews", "billing-ledger");
    await mkdir(join(fixture, "project"), { recursive: true });
    await Bun.write(join(fixture, "project", "ledger.ts"), "export const total = 1;\n");
    await Bun.write(join(fixture, "diff.patch"), "diff --git a/ledger.ts b/ledger.ts\n");
    await Bun.write(join(fixture, "manifest.json"), JSON.stringify({
      title: "Billing ledger",
      review_prompt_hint: "Read the ledger rounding path",
      defects: [{ id: "rounding-drift", title: "Rounding drift", category: "correctness", files: ["ledger.ts"], catch_criteria: "Names the drift" }],
    }));
    const catalog = createBenchmarkCatalog(root);
    const plan = await planPersonaBenchmark({ operation: "run", persona: "reviewer-code-quality", variants: [VARIANTS[0]!], repeats: 1 }, catalog);
    const resultsDir = plan.resultsDir;
    let calls = 0;
    const roots: { projectRoot: string; executionCwd: string; reviewed: boolean }[] = [];
    const dependencies = {
      ...deps(fakeRuntime(async ({ projectRoot, executionCwd }) => {
        roots.push({ projectRoot, executionCwd, reviewed: await Bun.file(join(projectRoot, "ledger.ts")).exists() && await Bun.file(join(projectRoot, "diff.patch")).exists() });
        return { terminal: { kind: "completed" } };
      }), root, []),
      createJudge: async () => ({
        complete: async () => {
          calls++;
          return { text: '{"caught":["rounding-drift"],"uncertain":[],"unsupported_finding_count":0}', accounting: unavailableJudgeAccounting("test") };
        },
      }),
    };
    await runPersonaBenchmark(plan, dependencies);
    // The review sandbox, holding the fixture project and its artifact, is the trial's whole project.
    expect(roots).toHaveLength(1);
    expect(roots[0]?.projectRoot).toBe(roots[0]?.executionCwd);
    expect(roots[0]?.reviewed).toBe(true);
    const resume = await planPersonaBenchmark({ operation: "resume", resultsDir, variants: [] }, catalog);
    await runPersonaBenchmark(resume, dependencies);
    expect(calls).toBe(1);
    expect(await (await createRunStore({ resultsRoot: catalog.resultsRoot, directory: resultsDir })).loadScores())
      .toMatchObject([{ kind: "review-score", score: { caught: ["rounding-drift"] } }]);
    const ledgerPath = join(resultsDir, "events.jsonl");
    const records = (await Bun.file(ledgerPath).text()).trim().split("\n").map(line => JSON.parse(line));
    await Bun.write(ledgerPath, records.map(record => JSON.stringify(record.kind === "review-score"
      ? { ...record, score: { ...record.score, caught: ["ghost-defect"] } }
      : record)).join("\n") + "\n");

    expect(plan.tasks.map((task) => task.id)).toEqual(["billing-ledger"]);
    await expect(runPersonaBenchmark(resume, dependencies))
      .rejects.toThrow(/names defect ghost-defect, which billing-ledger does not seed/);
  });
});
