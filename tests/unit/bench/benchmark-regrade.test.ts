import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OwnedCommandRunner } from "../../../src/infra/owned-command.js";
import { appendCampaignRecords, loadCampaignRecords, type CampaignHeader, type CellLine, type ScoreLine } from "../../../src/orchestration/modules/development/benchmark/benchmark-records.js";
import { createBenchmarkCatalog, type ImplementTask } from "../../../src/orchestration/modules/development/benchmark/catalog.js";
import { unavailableJudgeAccounting } from "../../../src/orchestration/modules/development/benchmark/judge.js";
import { regradeRecords } from "../../../src/orchestration/modules/development/benchmark/regrade.js";
import { MINIMAL_IMPLEMENTATION_PLAN } from "../../helpers/implementation-plan.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const directory = temporaryDirectories();
const JUDGE = { model: "judge-a", effort: "xhigh" };
const SOURCE_SECTION = "diff --git a/value.py b/value.py\n--- a/value.py\n+++ b/value.py\n@@ -1 +1 @@\n-value = 1\n+value = 2\n";
const CACHE_SECTION = "diff --git a/pkg/__pycache__/value.cpython-312.pyc b/pkg/__pycache__/value.cpython-312.pyc\nnew file mode 100644\nBinary files /dev/null and b/pkg/__pycache__/value.cpython-312.pyc differ\n";

/** A project with one native task and one plan task. */
function project(): string {
  const root = directory("benchmark-regrade-");
  const tasks = join(root, "bench", "tasks", "implement");
  const native = join(tasks, "native-task");
  mkdirSync(native, { recursive: true });
  writeFileSync(join(native, "instruction.txt"), "Fix the bug.");
  writeFileSync(join(native, "adapter.py"), "# task-owned adapter");
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
    // Cells under an earlier grader of each task, a cell whose prompt changed since, and a cell of the current task.
    await appendCampaignRecords(file, header, [
      cell(native!, "grader-before-the-fix"),
      cell(plan!, "grader-before-the-fix"),
      { ...cell(plan!, "grader-before-the-fix", "another-prompt"), repeat: 1 },
      { ...cell(native!, native!.contentIdentity), repeat: 1 },
    ], [trap]);
    const graded: string[] = [];
    const applied: string[] = [];
    const run: OwnedCommandRunner = async (command, options) => {
      if (command[0] === "python3") {
        expect(command[2]).toBe("grade");
        graded.push(await Bun.file(command[5]!).text());
        await Bun.write(command[6]!, '{"passed":3,"failed":0,"total":3,"evidence":{}}');
      }
      if (command.includes("apply")) applied.push(options?.stdin ?? "");
      const output = command.find((argument) => argument.startsWith("--output="));
      if (output) await Bun.write(output.slice("--output=".length), SOURCE_SECTION);
      const stdout = command[0] === "bun" ? "2 pass\n1 fail\n" : "";
      return { exitCode: command[0] === "bun" ? 1 : 0, timedOut: false, stdout, stderr: "", stdoutBytes: new Uint8Array() };
    };

    expect(await regradeRecords(catalog, run)).toEqual({ graded: 2, current: 1, skipped: 1 });
    expect(graded).toEqual([SOURCE_SECTION]);
    expect(applied).toEqual([SOURCE_SECTION]);
    const records = await loadCampaignRecords(file);
    expect(records?.scores).toEqual([trap]);
    expect(records?.grades).toEqual([
      { kind: "grade", graderIdentity: native!.graderIdentity, variant: "model-a@high", task: "native-task", repeat: 0, passed: 3, failed: 0, total: 3 },
      { kind: "grade", graderIdentity: plan!.graderIdentity, variant: "model-a@high", task: "plan-task", repeat: 0, passed: 2, failed: 1, total: 3 },
    ]);

    expect(await regradeRecords(catalog, run)).toEqual({ graded: 0, current: 3, skipped: 1 });
    expect(graded).toHaveLength(1);
  });
});
