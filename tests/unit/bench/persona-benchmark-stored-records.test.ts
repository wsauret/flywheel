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
  verdictJudge,
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
          return { text: '{"caught":["rounding-drift"],"uncertain":[],"unsupported_finding_count":0,"unsupported_severe_finding_count":0}', accounting: unavailableJudgeAccounting("test") };
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

  it("reports control alarms and unsupported P1/P2 findings by diff stratum, the fixture origins, and marks a candidate on the judge's model", async () => {
    const root = await reviewerProject();
    const control = join(root, "bench", "ab-persona", "fixtures", "reviews", "clean-change");
    await mkdir(control, { recursive: true });
    await Bun.write(join(control, "source.json"), JSON.stringify({ commit: "a".repeat(40), variant: "restore" }));
    await Bun.write(join(control, "diff.patch"), `diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1,60 @@\n${Array.from({ length: 60 }, (_, line) => `+${line}`).join("\n")}\n`);
    await Bun.write(join(control, "manifest.json"), JSON.stringify({ title: "Clean change", review_prompt_hint: "", defects: [] }));
    const catalog = createBenchmarkCatalog(root);
    const plan = await planPersonaBenchmark({ operation: "run", persona: "reviewer-code-quality", variants: [VARIANTS[0]!], repeats: 1 }, catalog);
    const outcome = await runPersonaBenchmark(plan, {
      ...deps(fakeRuntime(() => ({ terminal: { kind: "completed" } })), root, []),
      judge: { model: "model-a", effort: "high" },
      createJudge: async () => ({
        complete: async (prompt) => ({
          text: prompt.includes("rounding-drift")
            ? '{"caught":["rounding-drift"],"uncertain":[],"unsupported_finding_count":3,"unsupported_severe_finding_count":1}'
            : '{"caught":[],"uncertain":[],"unsupported_finding_count":2,"unsupported_severe_finding_count":2}',
          accounting: unavailableJudgeAccounting("test"),
        }),
      }),
    });
    if (outcome.status !== "completed") throw new Error(`expected completion, got ${outcome.status}`);
    const rows = outcome.report.split("\n");
    expect(rows).toContain("Judge: model-a:high. Candidates that share its model, marked [judge model], may be scored in their favor: model-a@medium.");
    expect(rows.find((row) => row.startsWith("Fixtures: "))).toStartWith("Fixtures: 0 recorded, 1 restored, 1 hand-authored.");
    expect(rows.find((row) => row.startsWith("| S1 |"))).toStartWith("| S1 | 1 | 0 | model-a@medium [judge model] | 1 | 1/1 (100.0%) | 3 (1) | n/a |");
    expect(rows.find((row) => row.startsWith("| S2 |"))).toStartWith("| S2 | 0 | 1 | model-a@medium [judge model] | 1 | n/a | 0 (0) | 1/1 (100.0%), mean 2.00 |");
    expect(rows.find((row) => row.startsWith("| model-a@medium [judge model] | 2 |"))).toStartWith("| model-a@medium [judge model] | 2 | 1/1 (100.0%) | 0 | 3 (1) | 1/1 (100.0%), mean 2.00 |");
  });

  it("refuses to resume or rescore a reviewer campaign scored before severity was counted, and still reads it", async () => {
    const root = await reviewerProject();
    const catalog = createBenchmarkCatalog(root);
    const plan = await planPersonaBenchmark({ operation: "run", persona: "reviewer-code-quality", variants: [VARIANTS[0]!], repeats: 1 }, catalog);
    const judge = { complete: async () => ({ text: '{"caught":[],"uncertain":[],"unsupported_finding_count":0,"unsupported_severe_finding_count":0}', accounting: unavailableJudgeAccounting("test") }) };
    await runPersonaBenchmark(plan, { ...deps(fakeRuntime(() => ({ terminal: { kind: "completed" } })), root, []), createJudge: async () => judge });
    // The persona-v2 shape: its config names that version and its review scores carry no severity count.
    const manifestPath = join(plan.resultsDir, "campaign.json");
    const manifest = await Bun.file(manifestPath).json();
    manifest.config.scoringVersion = "persona-v2";
    await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const ledgerPath = join(plan.resultsDir, "events.jsonl");
    const records = (await Bun.file(ledgerPath).text()).trim().split("\n").map(line => JSON.parse(line));
    await Bun.write(ledgerPath, records.map((record) => {
      if (record.kind !== "review-score") return JSON.stringify(record);
      const { unsupportedSevereFindingCount: _severe, ...score } = record.score;
      return JSON.stringify({ ...record, score });
    }).join("\n") + "\n");

    expect(await (await createRunStore({ resultsRoot: catalog.resultsRoot, directory: plan.resultsDir })).loadScores())
      .toMatchObject([{ kind: "review-score", score: { unsupportedFindingCount: 0 } }]);
    for (const operation of ["resume", "rescore"] as const) {
      const stored = await planPersonaBenchmark({ operation, resultsDir: plan.resultsDir, variants: [] }, catalog);
      await expect(runPersonaBenchmark(stored, { ...deps(fakeRuntime(() => ({ terminal: { kind: "completed" } })), root, []), createJudge: async () => judge }))
        .rejects.toThrow("scored under persona-v2 and this harness scores under persona-v3");
    }
  });

  it("records the resolved judge, resumes under it, and refuses another judge", async () => {
    const root = await syntheticProject();
    const catalog = createBenchmarkCatalog(root);
    const judge = { model: "judge-model", effort: "high" };
    const plan = await planPersonaBenchmark({ variants: VARIANTS, repeats: 1, operation: "run", judge }, catalog);
    const controller = new AbortController();
    controller.abort();
    await runPersonaBenchmark(plan, { ...deps(fakeRuntime(() => ({ terminal: { kind: "completed" } })), root, [], controller.signal), judge });
    const config = await (await createRunStore({ resultsRoot: catalog.resultsRoot, directory: plan.resultsDir })).loadConfig();
    expect(config.judge).toEqual(judge);

    const resume = await planPersonaBenchmark({ operation: "resume", resultsDir: plan.resultsDir, variants: [] }, catalog);
    expect(resume.judge).toEqual(judge);
    const outcome = await runPersonaBenchmark(resume, { ...deps(fakeRuntime(() => ({ terminal: { kind: "completed" } })), root, []), judge });
    expect(outcome.status).toBe("completed");
    await expect(runPersonaBenchmark(resume, { ...deps(fakeRuntime(() => ({ terminal: { kind: "completed" } })), root, []), judge: { ...judge, effort: "low" } }))
      .rejects.toThrow("judged by judge-model:high, but this run's judge resolved to judge-model:low");
    await expect(planPersonaBenchmark({ operation: "resume", resultsDir: plan.resultsDir, variants: [], judge: { ...judge, model: "other" } }, catalog))
      .rejects.toThrow("Results judge judge-model:high conflicts with --judge other:high");
  });

  it("refuses to resume or rescore a campaign created before the judge was recorded, and still reads it", async () => {
    const root = await syntheticProject();
    const { resultsDir } = await storedRun(root);
    // Every campaign before 2026-11-10 has this shape: no judge, and a judge identity of the rubric alone.
    const manifestPath = join(resultsDir, "campaign.json");
    const manifest = await Bun.file(manifestPath).json();
    delete manifest.config.judge;
    await Bun.write(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const catalog = createBenchmarkCatalog(root);
    expect((await (await createRunStore({ resultsRoot: catalog.resultsRoot, directory: resultsDir })).loadConfig()).judge).toBeUndefined();
    const judgeCalls: string[] = [];
    const createJudge = async () => { judgeCalls.push("judge"); return verdictJudge; };
    for (const operation of ["resume", "rescore"] as const) {
      const plan = await planPersonaBenchmark({ operation, resultsDir, variants: [] }, catalog);
      await expect(runPersonaBenchmark(plan, { ...deps(fakeRuntime(() => ({ terminal: { kind: "completed" } })), root, []), createJudge }))
        .rejects.toThrow("These results predate the recorded benchmark judge");
    }
    expect(judgeCalls).toEqual([]);
  });

  it("refuses to run a campaign that needs a judge when no judge model resolved", async () => {
    const root = await syntheticProject();
    const plan = await planPersonaBenchmark({ variants: VARIANTS, repeats: 1, operation: "run" }, createBenchmarkCatalog(root));
    let candidateCalls = 0;
    const { judge: _judge, ...unjudged } = deps(fakeRuntime(() => { candidateCalls++; return { terminal: { kind: "completed" } }; }), root, []);
    await expect(runPersonaBenchmark(plan, unjudged)).rejects.toThrow("no judge model resolved");
    expect(candidateCalls).toBe(0);
  });
});

/** A project with the reviewer persona and one defect fixture of 20 changed lines. */
async function reviewerProject(): Promise<string> {
  const root = await syntheticProject();
  await Bun.write(join(root, "src", "workflows", "agents", "personas", "reviewer-code-quality.md"), REVIEWER_DEFINITION);
  const fixture = join(root, "bench", "ab-persona", "fixtures", "reviews", "billing-ledger");
  await mkdir(join(fixture, "project"), { recursive: true });
  await Bun.write(join(fixture, "project", "ledger.ts"), "export const total = 1;\n");
  await Bun.write(join(fixture, "diff.patch"), `diff --git a/ledger.ts b/ledger.ts\n--- a/ledger.ts\n+++ b/ledger.ts\n@@ -1 +1,20 @@\n${Array.from({ length: 20 }, (_, line) => `+${line}`).join("\n")}\n`);
  await Bun.write(join(fixture, "manifest.json"), JSON.stringify({
    title: "Billing ledger",
    review_prompt_hint: "Read the ledger rounding path",
    defects: [{ id: "rounding-drift", title: "Rounding drift", category: "correctness", files: ["ledger.ts"], catch_criteria: "Names the drift" }],
  }));
  return root;
}
