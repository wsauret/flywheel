import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OwnedCommandRunner } from "../../../src/infra/owned-command.js";
import { appendCampaignRecords, loadAllCampaignRecords, type CampaignHeader, type CellLine, type ScoreLine } from "../../../src/orchestration/modules/development/benchmark/records/benchmark-records.js";
import { createBenchmarkCatalog, type ImplementTask } from "../../../src/orchestration/modules/development/benchmark/catalog.js";
import { unavailableJudgeAccounting } from "../../../src/orchestration/modules/development/benchmark/scoring/judge.js";
import { regradeRecords } from "../../../src/orchestration/modules/development/benchmark/records/regrade.js";
import { MINIMAL_IMPLEMENTATION_PLAN } from "../../helpers/implementation-plan.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const directory = temporaryDirectories();
const JUDGE = { model: "judge-a", effort: "xhigh" };
const SOURCE_SECTION = "diff --git a/value.py b/value.py\n--- a/value.py\n+++ b/value.py\n@@ -1 +1 @@\n-value = 1\n+value = 2\n";
const CACHE_SECTION = "diff --git a/pkg/__pycache__/value.cpython-312.pyc b/pkg/__pycache__/value.cpython-312.pyc\nnew file mode 100644\nBinary files /dev/null and b/pkg/__pycache__/value.cpython-312.pyc differ\n";

/** A Bun JUnit report in which `fixes` passes and `keeps` fails. */
const JUNIT = `<testsuites><testsuite name="acceptance/value.test.ts" file="acceptance/value.test.ts"><testcase name="fixes" classname="" file="acceptance/value.test.ts" /><testcase name="keeps" classname="" file="acceptance/value.test.ts"><failure type="AssertionError" /></testcase></testsuite></testsuites>`;

/** A project with one native task and one plan task. */
function project(): string {
  const root = directory("benchmark-regrade-");
  const tasks = join(root, "bench", "tasks", "implement");
  const native = join(tasks, "native-task");
  mkdirSync(native, { recursive: true });
  writeFileSync(join(native, "instruction.txt"), "Fix the bug.");
  writeFileSync(join(native, "adapter.py"), "# task-owned adapter");
  writeFileSync(join(native, "checks.json"), JSON.stringify({ "test_fix": "core", "test_edge": "edge" }));
  writeFileSync(join(native, "task.json"), JSON.stringify({
    kind: "native", id: "native-task", stratum: "small", family: "python", split: "development",
    instruction: "instruction.txt", native: { command: ["python3", "adapter.py"], timeoutMs: 60_000 },
  }));
  const plan = join(tasks, "plan-task");
  mkdirSync(join(plan, "project"), { recursive: true });
  mkdirSync(join(plan, "acceptance"), { recursive: true });
  writeFileSync(join(plan, "task.json"), JSON.stringify({ id: "plan-task", stratum: "small" }));
  writeFileSync(join(plan, "manifest.json"), JSON.stringify({ traps: [], judgment: [] }));
  writeFileSync(join(plan, "plan.json"), JSON.stringify(MINIMAL_IMPLEMENTATION_PLAN));
  writeFileSync(join(plan, "project", "value.py"), "value = 1\n");
  writeFileSync(join(plan, "acceptance", "value.test.ts"), "// hidden acceptance test\n");
  writeFileSync(join(plan, "checks.json"), JSON.stringify({ "acceptance/value.test.ts > fixes": "core", "acceptance/value.test.ts > keeps": "serious" }));
  return root;
}

function cell(task: ImplementTask, taskIdentity: string, candidateIdentity = task.candidateIdentity): CellLine {
  return {
    kind: "cell", variant: "model-a@high", model: "model-a", effort: "high", task: task.id, taskIdentity, repeat: 0, durationMs: 1,
    accounting: unavailableJudgeAccounting("synthetic"),
    output: { kind: "implementation", candidateIdentity, summary: "done", diff: `${SOURCE_SECTION}${CACHE_SECTION}`, linesAdded: 1, linesRemoved: 1, filesTouched: 2, acceptancePassed: 0, acceptanceFailed: 1, acceptanceTotal: 1 },
  };
}

describe("benchmark regrade", () => {
  it("grades stored diffs without their bytecode caches under each changed grader, once, beside the recorded scores", async () => {
    const catalog = createBenchmarkCatalog(project());
    const tasks = await catalog.implementTasks();
    const [native, plan] = ["native-task", "plan-task"].map((id) => tasks.find((task) => task.id === id)!);
    const header: CampaignHeader = { kind: "campaign", version: 1, persona: "implementer", mode: "implement", stamp: "s1", judge: JUDGE, scoringVersion: "persona-v2", personaGuidanceIdentity: "g" };
    const trap: ScoreLine = { kind: "score", judge: JUDGE, scoringVersion: "persona-v2", scorer: "trap", score: { variant: "model-a@high", task: "native-task", repeat: 0, traps: [] } };
    const file = catalog.recordsFile("implementer", "s1");
    // Cells graded before the check tags under an earlier grader of each task, a cell whose prompt changed since, a cell of the current task, and a timed-out cell.
    await appendCampaignRecords(file, header, { cells: [
      cell(native!, "grader-before-the-fix"),
      cell(plan!, "grader-before-the-fix"),
      { ...cell(plan!, "grader-before-the-fix", "another-prompt"), repeat: 1 },
      { ...cell(native!, native!.contentIdentity), repeat: 1 },
      // A candidate that changed nothing stored an empty diff, which grades the rebuilt base tree.
      { ...cell(plan!, "grader-before-the-fix"), repeat: 3, output: { kind: "implementation", candidateIdentity: plan!.candidateIdentity, summary: "done", diff: "", linesAdded: 0, linesRemoved: 0, filesTouched: 0, acceptancePassed: 0, acceptanceFailed: 1, acceptanceTotal: 1 } },
      // A timed-out cell under an earlier grader has no change to grade, and is neither graded nor skipped.
      { ...cell(native!, "grader-before-the-fix"), repeat: 2, output: { kind: "timed-out", candidateIdentity: native!.candidateIdentity, timeoutMs: 1 } },
    ], scores: [trap] });
    const graded: string[] = [];
    const applied: string[] = [];
    const run: OwnedCommandRunner = async (command, options) => {
      if (command[0] === "python3") {
        expect(command[2]).toBe("grade");
        graded.push(await Bun.file(command[5]!).text());
        // The fix passes, its edge check fails, and an existing test still passes.
        await Bun.write(command[6]!, '{"checks":{"test_fix":true,"test_edge":false,"test_existing":true},"evidence":{}}');
      }
      if (command.includes("apply")) applied.push(options?.stdin ?? "");
      const output = command.find((argument) => argument.startsWith("--output="));
      if (output) await Bun.write(output.slice("--output=".length), SOURCE_SECTION);
      const report = command.find((argument) => argument.startsWith("--reporter-outfile="));
      if (report) await Bun.write(report.slice("--reporter-outfile=".length), JUNIT);
      return { exitCode: report ? 1 : 0, timedOut: false, stdout: "", stderr: "", stdoutBytes: new Uint8Array() };
    };

    expect(await regradeRecords(catalog, run)).toEqual({ graded: 3, current: 1, skipped: 1 });
    expect(graded).toEqual([SOURCE_SECTION]);
    expect(applied).toEqual([SOURCE_SECTION]);
    const records = (await loadAllCampaignRecords(catalog.recordsRoot)).find((campaign) => campaign.file === file);
    expect(records?.scores).toEqual([trap]);
    expect(records?.grades).toEqual([
      { kind: "grade", graderIdentity: native!.graderIdentity, variant: "model-a@high", task: "native-task", repeat: 0, grade: { essential: { passed: 1, total: 1 }, broken: 0, edge: { passed: 0, total: 1 } } },
      { kind: "grade", graderIdentity: plan!.graderIdentity, variant: "model-a@high", task: "plan-task", repeat: 0, grade: { essential: { passed: 1, total: 2 }, broken: 0, edge: { passed: 0, total: 0 } } },
      { kind: "grade", graderIdentity: plan!.graderIdentity, variant: "model-a@high", task: "plan-task", repeat: 3, grade: { essential: { passed: 1, total: 2 }, broken: 0, edge: { passed: 0, total: 0 } } },
    ]);

    expect(await regradeRecords(catalog, run)).toEqual({ graded: 0, current: 4, skipped: 1 });
    expect(graded).toHaveLength(1);
  });
});
