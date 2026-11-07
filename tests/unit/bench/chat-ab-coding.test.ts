import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { codingRedaction, judgeBlocks } from "../../../bench/chat-ab/block-judge.js";
import { acceptanceTestPaths, captureCodingCell, codingMessage, findCodingTask, type CodingTask } from "../../../bench/chat-ab/coding-task.js";
import type { OwnedCommandRunner } from "../../../src/infra/owned-command.js";
import { temporaryDirectories } from "../../helpers/directories.js";
import { unavailableBenchmarkAccounting } from "../../../src/orchestration/modules/development/benchmark/evidence.js";

const temporary = temporaryDirectories();

describe("coding task", () => {
  test("states the bug, the constraints, and the workflow shape", () => {
    const message = codingMessage({ summary: "Repair the lock.", constraints: ["Keep the API."], workflow: "review" });
    expect(message).toStartWith("Repair the lock.\n\nConstraints:\n- Keep the API.");
    expect(message).toContain("two independent reviewers");
    expect(message).toContain("`confirmed` (true or false)");
    expect(codingMessage({ summary: "Repair the lock.", constraints: ["Do not change tests."], workflow: "review" })).toContain("test outside the repository");
  });

  test("asks a task of several independent problems for one lane for each problem", async () => {
    const task = await findCodingTask("multi-site-battery-01");
    expect(task?.workflow).toBe("fan-out");
    expect((await findCodingTask("config-lock-first-write"))?.workflow).toBe("review");
    const message = codingMessage(task!);
    expect(message).toContain("one lane for each independent problem");
    expect(message).not.toContain("two independent reviewers");
  });

  test("runs every file a declared test id names, once", () => {
    expect(acceptanceTestPaths(["a.test.ts > x", "acceptance/b.test.ts > y", "acceptance/b.test.ts > z"])).toEqual(["./a.test.ts", "./acceptance/b.test.ts"]);
  });

  test.each(["capture-refusal", "test-failure"] as const)("captures %s through the shared sandbox boundary", async (mode) => {
    const directory = temporary("coding-capture-");
    const acceptanceDir = temporary("coding-acceptance-");
    await writeFile(join(acceptanceDir, "test.ts"), "// synthetic\n");
    const task: CodingTask = {
      id: "synthetic", role: "development", tasksDir: directory, taskDir: directory, acceptanceDir,
      sandbox: { commit: "fixture", paths: ["."] }, timeoutMs: 1000, summary: "Synthetic", constraints: [], workflow: "review", testIds: ["acceptance/test.ts > fails"],
      contentIdentity: "", qualificationIdentity: "", referencePatch: "",
    };
    let acceptanceRan = false;
    const run: OwnedCommandRunner = async (command) => {
      let stdout = "";
      if (command.includes("diff") && !command.includes("--numstat")) stdout = mode === "capture-refusal" ? `+example = sk-${"a".repeat(40)}\n` : "+ordinary edit\n";
      if (command[0] === "bun") {
        acceptanceRan = true;
        const report = command.find((arg) => arg.startsWith("--reporter-outfile="))!.slice("--reporter-outfile=".length);
        await writeFile(report, '<testsuites><testsuite name="acceptance/test.ts" file="acceptance/test.ts"><testcase name="fails"><failure message="synthetic"/></testcase></testsuite></testsuites>');
      }
      return { exitCode: command[0] === "bun" ? 1 : 0, stdout, stdoutBytes: new TextEncoder().encode(stdout), stderr: "", timedOut: false };
    };
    const sandbox = { dir: directory, home: directory, baseline: "baseline", dispose: async () => {} };
    if (mode === "capture-refusal") {
      await expect(captureCodingCell(task, sandbox, run)).rejects.toThrow("captured diff contains recognized credential bytes");
      expect(acceptanceRan).toBe(false);
    } else {
      expect((await captureCodingCell(task, sandbox, run)).acceptance).toMatchObject({ allPass: false, passed: 0, total: 1 });
      expect(acceptanceRan).toBe(true);
    }
  });

  test("hides each subject's workflow mechanism without changing task code or losing the final report", async () => {
    const redaction = codingRedaction("claude-haiku-5-5");
    expect(redaction.redact("Claude Code ran scratch/workflows/fix.workflow.yaml and .flywheel/sessions/a on claude-haiku-5-5")).not.toMatch(/workflow\.yaml|\.flywheel|haiku|Claude Code/i);
    const code = 'export function fix(input) { return "debug"; }';
    const diff = `diff --git a/src/work.ts b/src/work.ts\n+${code}\ndiff --git a/scratch/workflows/helper.workflow.js b/scratch/workflows/helper.workflow.js\n+const mechanism = "js arm leak";\ndiff --git a/bench/chat-ab/workflow-authorship/handcrafted/brief.txt b/bench/chat-ab/workflow-authorship/handcrafted/brief.txt\n+frozen arm leak\ndiff --git a/new.workflow.yaml b/new.workflow.yaml\n+phase: invented-plan\n+brief: authored arm leak\n`;
    const prompts: string[] = [];
    const accounting = unavailableBenchmarkAccounting("fixture");
    await judgeBlocks({
      model: { async complete(prompt) {
        prompts.push(prompt);
        return { text: '{"correctA":"yes","correctB":"yes","winner":"tie","rationale":"Same fix"}', accounting };
      } },
      [Symbol.asyncDispose]: async () => {},
    }, codingRedaction("claude-sonnet-5-5"), [{
      test: "blind", task: "blind", repeat: 0, request: `Repair this code: ${code}`,
      reference: `Reference: ${code}`,
      reports: { a: `Create Spec finished. Review Spec passed. \`fix\` completed. Phase "debug" passed. Workflow ab12cd34 finished. Kept ${code}\n\`\`\`ts\n${code}\n\`\`\``, b: "Only task B finished. Create Spec is a task phrase in B, not a workflow." },
      changes: { a: diff, b: `diff --git a/src/work.ts b/src/work.ts\n+${code}\n` },
      workflowReferences: {
        a: { ids: ["ab12cd34"], labels: ["invented-plan", "Create Spec", "Review Spec", "fix", "debug"] },
        b: { ids: [], labels: ["Only task B"] },
      },
    }], ["a", "b"]);
    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) {
      expect(prompt).not.toMatch(/authored arm leak|js arm leak|frozen arm leak|Create Spec finished|Review Spec|invented-plan|`fix`|Only task B|ab12cd34|Phase "debug"/);
      expect(prompt.match(/export function fix\(input\) \{ return "debug"; \}/g)).toHaveLength(6);
      expect(prompt).toContain("Kept export function fix");
      expect(prompt).toContain("Create Spec is a task phrase in B, not a workflow.");
      expect(prompt).toContain("### Final report");
    }
  });
});
