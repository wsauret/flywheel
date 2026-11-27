import { describe, expect, it } from "bun:test";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createBenchmarkCatalog } from "../../../src/orchestration/modules/development/benchmark/catalog.js";
import type { CampaignRecords, RecordJudge, ScoreLine } from "../../../src/orchestration/modules/development/benchmark/records/benchmark-records.js";
import { calibrateQualityJudge, calibrationStanding, evaluateQualityCalibration, loadQualityCalibration, spearman, type QualityCalibrationData } from "../../../src/orchestration/modules/development/benchmark/records/judge-calibration.js";
import { judgedScore, parseQualityJudgment, qualityScoringVersion } from "../../../src/orchestration/modules/development/benchmark/scoring/quality-judge.js";
import { unavailableJudgeAccounting } from "../../../src/orchestration/modules/development/benchmark/scoring/judge.js";
import type { QualityFinding } from "../../../src/orchestration/modules/development/benchmark/scoring/run-store.js";
import { MINIMAL_IMPLEMENTATION_PLAN } from "../../helpers/implementation-plan.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const directory = temporaryDirectories();
const JUDGE: RecordJudge = { model: "judge-a", effort: "xhigh" };
const IDENTITY = "quality-current";

const finding = (overrides: Partial<QualityFinding> = {}): QualityFinding => ({ kind: "needless-code", severity: "minor", file: "a.ts", line: 10, claim: "c", evidence: "e", ...overrides });

describe("judged quality findings", () => {
  it("scores 100 less 15 per major and 5 per minor finding, never below 0", () => {
    expect(judgedScore([])).toBe(100);
    expect(judgedScore([finding({ severity: "major" }), finding(), finding()])).toBe(75);
    expect(judgedScore(Array.from({ length: 7 }, () => finding({ severity: "major" })))).toBe(0);
  });

  it("parses typed findings, discards each finding that the diff does not support, and fails a malformed response so the call retries", () => {
    // a.ts lines 8 to 12 are one hunk, and b.ts has a deletion-only hunk after line 3.
    const diff = "--- a/a.ts\n+++ b/a.ts\n@@ -8,4 +8,5 @@\n x\n+y\n x\n x\n x\n--- a/b.ts\n+++ b/b.ts\n@@ -4,1 +3,0 @@\n-gone\n";
    const defect = { ...finding({ kind: "missed-defect", severity: "major" }), scenario: "An empty list" };
    const supported = [finding(), defect, finding({ file: "./a.ts", line: 12 }), finding({ file: "b.ts", line: 3 })];
    const unsupported = [
      { ...defect, scenario: " " }, { ...defect, scenario: undefined },
      finding({ line: 13 }), finding({ line: 7 }), finding({ file: "c.ts" }),
      finding({ claim: " " }), finding({ evidence: "" }),
    ];
    const response = `Here: ${JSON.stringify({ findings: [...supported, ...unsupported], scope_ok: false })}`;
    expect(parseQualityJudgment(response, diff)).toEqual({ value: { findings: supported, scopeOk: false, discarded: unsupported.length }, error: null });
    expect(parseQualityJudgment("no json", diff).error).toBe("Judge response did not contain JSON");
    expect(parseQualityJudgment(JSON.stringify({ findings: [] }), diff).error).toBe("Judge response did not match the quality finding schema");
    expect(parseQualityJudgment(JSON.stringify({ findings: [{ ...finding(), kind: "style" }], scope_ok: true }), diff).error).toBe("Judge response contained an invalid finding");
    expect(parseQualityJudgment(JSON.stringify({ findings: [{ ...finding(), line: 0 }], scope_ok: true }), diff).error).toBe("Judge response contained an invalid finding");
  });
});

/** Calibration data with `seeded` seeded controls at a.ts line 10 and `clean` clean references, and `labels`
 *  labeled cells whose reference score falls with their repeat. */
function data(seeded: number, clean: number, labels: number, results: Map<string, readonly QualityFinding[]>): QualityCalibrationData {
  const control = { task: "t", patch: "p", summary: "", description: "", diff: "", judgeInput: { instruction: "", reference: undefined } };
  return {
    identity: IDENTITY,
    coverage: [["t"]],
    controls: [
      ...Array.from({ length: seeded }, (_, index) => ({ ...control, id: `s${index}`, input: `input-s${index}`, seeded: { kind: "needless-code" as const, file: "a.ts", line: 10 } })),
      ...Array.from({ length: clean }, (_, index) => ({ ...control, id: `c${index}`, input: `input-c${index}` })),
    ],
    labels: Array.from({ length: labels }, (_, repeat) => ({ persona: "implementer", stamp: "s1", variant: "v", task: "t", repeat, findings: Array.from({ length: repeat % 7 }, () => finding()) })),
    results: [{ judge: JUDGE, identity: IDENTITY, controls: [...results].map(([id, findings]) => ({ id, input: `input-${id}`, findings, scopeOk: true, discarded: 0 })) }],
  };
}

/** Records in which the judge scored each labeled cell with `minors(repeat)` minor findings. */
function records(labels: number, minors: (repeat: number) => number): CampaignRecords[] {
  const scores: ScoreLine[] = Array.from({ length: labels }, (_, repeat) => ({
    kind: "score", judge: JUDGE, scoringVersion: IDENTITY, scorer: "quality",
    score: { variant: "v", task: "t", repeat, findings: Array.from({ length: minors(repeat) }, () => finding()), scopeOk: true, discarded: 0 },
  }));
  return [{ file: "f", header: { kind: "campaign", version: 1, persona: "implementer", mode: "implement", stamp: "s1", judge: JUDGE, scoringVersion: "v2", personaGuidanceIdentity: "g" }, cells: [], scores, grades: [], failures: [] }];
}

describe("judged quality calibration", () => {
  it("passes a judge that finds 80% of seeded defects, keeps 80% of clean references free of major findings, and agrees with the labels", () => {
    // 4 of 5 seeded defects found (one at the wrong file), and 4 of 5 clean references with no major finding.
    const results = new Map<string, readonly QualityFinding[]>([
      ["s0", [finding({ line: 15 })]], ["s1", [finding({ file: "b/a.ts", line: 5 })]], ["s2", [finding()]], ["s3", [finding()]], ["s4", [finding({ file: "b.ts" })]],
      ["c0", []], ["c1", [finding()]], ["c2", []], ["c3", []], ["c4", [finding({ severity: "major" })]],
    ]);
    const passing = evaluateQualityCalibration(data(5, 5, 20, results), JUDGE, records(20, (repeat) => repeat % 7));
    expect(passing).toMatchObject({ seeded: { found: 4, total: 5 }, clean: { passed: 4, total: 5 }, controlsPass: true, agreement: { labeled: 20, scored: 20, rho: 1 }, agreementPass: true, passed: true });
    expect(calibrationStanding(passing)).toEqual({ passed: true, summary: "seeded controls 4 of 5 found, clean references 4 of 5 without a major finding (each needs 80%); reviewer agreement Spearman 1.00 over 20 cells (needs 0.60)" });

    // A line 6 lines away misses, so 3 of 5 seeded defects is below 80%.
    const missed = new Map(results).set("s0", [finding({ line: 16 })]);
    expect(evaluateQualityCalibration(data(5, 5, 20, missed), JUDGE, records(20, (repeat) => repeat % 7))).toMatchObject({ seeded: { found: 3 }, controlsPass: false, passed: false });
    // Scores that rank against the labels fail agreement.
    expect(evaluateQualityCalibration(data(5, 5, 20, results), JUDGE, records(20, (repeat) => 6 - (repeat % 7)))).toMatchObject({ agreementPass: false, passed: false });
    // Fewer than 20 labeled cells, or a labeled cell that the judge has not scored, cannot pass agreement.
    expect(evaluateQualityCalibration(data(5, 5, 19, results), JUDGE, records(19, (repeat) => repeat % 7))).toMatchObject({ agreementPass: false });
    expect(evaluateQualityCalibration(data(5, 5, 20, results), JUDGE, records(19, (repeat) => repeat % 7))).toMatchObject({ agreement: { scored: 19 }, agreementPass: false });
    // Results of another judge identity, and an unjudged control, do not count.
    const stale = { ...data(5, 5, 20, results), results: [{ ...data(5, 5, 20, results).results[0]!, identity: "quality-old" }] };
    const unjudged = evaluateQualityCalibration(stale, JUDGE, records(20, (repeat) => repeat % 7));
    expect(unjudged).toMatchObject({ unjudged: 10, controlsPass: false, passed: false });
    expect(calibrationStanding(unjudged).summary).toStartWith(`no control results under judge identity ${IDENTITY} (\`bun bench/ab-persona/bench.ts --calibrate --judge judge-a:xhigh\`)`);
    // A result that answers an earlier judge input of its control (an edited patch, summary, or reference) is stale.
    const edited = { ...data(5, 5, 20, results), controls: data(5, 5, 20, results).controls.map((control) => control.id === "s2" ? { ...control, input: "input-edited" } : control) };
    expect(evaluateQualityCalibration(edited, JUDGE, records(20, (repeat) => repeat % 7))).toMatchObject({ unjudged: 1, seeded: { found: 3 }, controlsPass: false });
    // A task of a coverage group with no clean and seeded control fails the control check whatever the recall.
    const uncovered = evaluateQualityCalibration({ ...data(5, 5, 20, results), coverage: [["t"], ["u", "w"]] }, JUDGE, records(20, (repeat) => repeat % 7));
    expect(uncovered).toMatchObject({ uncovered: ["u or w"], controlsPass: false, passed: false });
    expect(calibrationStanding(uncovered).summary).toContain("no clean and seeded control of u or w");
  });

  it("ranks with ties at their mean rank", () => {
    expect(spearman([1, 2, 3], [10, 20, 30])).toBe(1);
    expect(spearman([1, 2, 3], [3, 2, 1])).toBe(-1);
    expect(spearman([1, 1, 2, 2], [1, 2, 3, 4])).toBeCloseTo(0.894427, 5);
    expect(spearman([1, 1], [1, 2])).toBeUndefined();
    expect(spearman([1], [1])).toBeUndefined();
  });

  it("judges only the controls without a result under the current identity and writes the results file after each", async () => {
    const root = directory("judged-quality-calibrate-");
    const plan = join(root, "bench", "tasks", "implement", "plan-task");
    mkdirSync(join(plan, "project"), { recursive: true });
    mkdirSync(join(plan, "acceptance"), { recursive: true });
    writeFileSync(join(plan, "task.json"), JSON.stringify({ id: "plan-task", stratum: "small" }));
    writeFileSync(join(plan, "manifest.json"), JSON.stringify({ traps: [], judgment: [] }));
    writeFileSync(join(plan, "plan.json"), JSON.stringify(MINIMAL_IMPLEMENTATION_PLAN));
    writeFileSync(join(plan, "project", "value.py"), "value = 1\n");
    writeFileSync(join(plan, "acceptance", "value.test.ts"), "// hidden acceptance test\n");
    writeFileSync(join(plan, "checks.json"), JSON.stringify({ "acceptance/value.test.ts > fixes": "core" }));
    const catalog = createBenchmarkCatalog(root);
    const calibration = catalog.qualityCalibrationDir;
    mkdirSync(join(calibration, "controls"), { recursive: true });
    writeFileSync(join(calibration, "controls", "clean.patch"), "--- a/value.py\n+++ b/value.py\n@@ -1 +1 @@\n-value = 1\n+value = 2\n");
    writeFileSync(join(calibration, "controls", "seeded.patch"), "--- a/value.py\n+++ b/value.py\n@@ -1 +1,2 @@\n-value = 1\n+value = 2\n+if value is None: pass\n");
    writeFileSync(join(calibration, "controls.json"), JSON.stringify({ controls: [
      { id: "clean", task: "plan-task", patch: "controls/clean.patch", summary: "s", description: "d" },
      { id: "seeded", task: "plan-task", patch: "controls/seeded.patch", summary: "s", description: "d", seeded: { kind: "needless-code", file: "value.py", line: 2 } },
    ] }));
    writeFileSync(join(calibration, "reviewer-labels.json"), JSON.stringify({ cells: [] }));
    const prompts: string[] = [];
    const deps = {
      catalog, judge: JUDGE,
      openJudge: async () => ({
        complete: async (prompt: string) => {
          prompts.push(prompt);
          const seeded = prompt.includes("if value is None");
          return { text: JSON.stringify({ findings: seeded ? [finding({ file: "value.py", line: 2 })] : [], scope_ok: true }), accounting: unavailableJudgeAccounting("synthetic") };
        },
      }),
    };

    expect(await calibrateQualityJudge(deps)).toMatchObject({ pending: 2, judged: 2, failed: 0 });
    expect(prompts).toHaveLength(2);
    const written = await loadQualityCalibration(catalog);
    const identity = await qualityScoringVersion(await catalog.implementTasks());
    const [clean, seeded] = written.controls;
    expect(written.results).toEqual([{ judge: JUDGE, identity, controls: [
      { id: "clean", input: clean!.input, findings: [], scopeOk: true, discarded: 0 },
      { id: "seeded", input: seeded!.input, findings: [finding({ file: "value.py", line: 2 })], scopeOk: true, discarded: 0 },
    ] }]);
    expect(evaluateQualityCalibration(written, JUDGE, [])).toMatchObject({ controlsPass: true, agreementPass: false });
    // A second calibration under the same identity has nothing to judge and admits no judge.
    expect(await calibrateQualityJudge({ ...deps, openJudge: async () => { throw new Error("no judge needed"); } })).toMatchObject({ pending: 0, judged: 0 });
    // Editing a control's patch in place makes its result stale, so only that control is judged again.
    writeFileSync(join(calibration, "controls", "clean.patch"), "--- a/value.py\n+++ b/value.py\n@@ -1 +1 @@\n-value = 1\n+value = 3\n");
    expect(await calibrateQualityJudge(deps)).toMatchObject({ pending: 1, judged: 1 });
    expect(prompts.at(-1)).toContain("+value = 3");
    // A model id with a slash names one results file directly under results/, which the loader reads back.
    const slashed = { model: "vendor/judge-b", effort: "high" };
    expect(await calibrateQualityJudge({ ...deps, judge: slashed })).toMatchObject({ pending: 2, judged: 2 });
    expect(readdirSync(join(calibration, "results")).sort()).toEqual(["judge-a%40xhigh.json", "vendor%2Fjudge-b%40high.json"]);
    expect(evaluateQualityCalibration(await loadQualityCalibration(catalog), slashed, [])).toMatchObject({ unjudged: 0, controlsPass: true });
    // A repeated control id or labeled cell fails to load, so no row counts twice.
    const label = { persona: "implementer", stamp: "s1", variant: "v", task: "plan-task", repeat: 0 };
    writeFileSync(join(calibration, "reviewer-labels.json"), JSON.stringify({ cells: [label, label] }));
    await expect(loadQualityCalibration(catalog)).rejects.toThrow("repeats the cells implementer s1 v plan-task 0");
  });

  it("commits at least 12 seeded controls over 4 tasks and every finding kind, each at an added line of its diff, beside clean references, covering every task with a reference patch and a plan task", async () => {
    const committed = await loadQualityCalibration(createBenchmarkCatalog(process.cwd()));
    const seededControls = committed.controls.filter(({ seeded }) => seeded !== undefined);
    expect(seededControls.length).toBeGreaterThanOrEqual(12);
    expect(new Set(seededControls.map(({ task }) => task)).size).toBeGreaterThanOrEqual(4);
    expect(new Set(seededControls.map(({ seeded }) => seeded?.kind))).toEqual(new Set(["needless-code", "wrong-abstraction", "convention-break", "missed-defect"]));
    expect(committed.controls.some(({ seeded }) => seeded === undefined)).toBe(true);
    expect(committed.labels).toHaveLength(20);
    // Each task with a reference patch, and one plan task, has a clean reference and a seeded control.
    expect(evaluateQualityCalibration(committed, JUDGE, []).uncovered).toEqual([]);
    for (const control of seededControls) {
      const target = control.seeded;
      // Walk the diff to the new-file line that the control names, and require it to be an added line.
      const text = await Bun.file(join(createBenchmarkCatalog(process.cwd()).qualityCalibrationDir, control.patch)).text();
      let file: string | undefined;
      let line = 0;
      let added: string | undefined;
      for (const row of text.split("\n")) {
        if (row.startsWith("+++ ")) file = row.slice(4).replace(/^b\//, "");
        else if (row.startsWith("@@")) line = Number(/\+(\d+)/.exec(row)?.[1]);
        else if (row.startsWith("+") || row.startsWith(" ")) {
          if (file === target?.file && line === target?.line && row.startsWith("+")) added = row;
          line++;
        }
      }
      expect({ id: control.id, added: added !== undefined }).toEqual({ id: control.id, added: true });
    }
  });
});
