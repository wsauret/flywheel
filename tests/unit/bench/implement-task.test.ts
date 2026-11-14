import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OwnedCommandRunner } from "../../../src/infra/owned-command.js";
import { createBenchmarkCatalog, DEFAULT_IMPLEMENTER_TIMEOUT_MS } from "../../../src/orchestration/modules/development/benchmark/catalog.js";
import { implementQualityJudgeInputIdentity } from "../../../src/orchestration/modules/development/benchmark/implement-scoring.js";
import {
  captureImplementation,
  loadImplementTasks,
  PLAN_FILE,
  provisionTaskSandbox,
} from "../../../src/orchestration/modules/development/benchmark/implement-task.js";
import { runCheckedSandboxCommand } from "../../../src/orchestration/modules/development/benchmark/sandbox-command.js";
import { retainImplementStore } from "../../../src/orchestration/modules/development/benchmark/implement-evidence.js";
import { MINIMAL_IMPLEMENTATION_PLAN } from "../../helpers/implementation-plan.js";
import { temporaryDirectories } from "../../helpers/directories.js";
import { syntheticCommands, writeSyntheticTaskDir } from "./_implement-task-fixtures.js";

const catalog = createBenchmarkCatalog(process.cwd());
const temporaryDirectory = temporaryDirectories();
const PLAN = MINIMAL_IMPLEMENTATION_PLAN;
const IMPLEMENT_TASKS_DIR = join(process.cwd(), "bench/tasks/implement");
let captureAddCommand: readonly string[] | undefined;
let captureResetCommand: readonly string[] | undefined;
const commandEnvs: ({ [key: string]: string | undefined } | undefined)[] = [];
const fakeCommandRunner: OwnedCommandRunner = async (command, options) => {
  commandEnvs.push(options?.env);
  if (command[0] === "git" && command[1] === "add" && options?.cwd) {
    captureAddCommand = command;
  }
  if (command[0] === "git" && command[1] === "reset" && options?.cwd) {
    captureResetCommand = command;
  }
  return syntheticCommands(command, options);
};

describe("shared implementation task loading", () => {
  it("loads a commit-pinned implement task with timeout and setup commands", async () => {
    const taskDir = join(temporaryDirectory("implement-task-"), "commit-task");
    await mkdir(join(taskDir, "acceptance"), { recursive: true });
    await Bun.write(join(taskDir, "task.json"), JSON.stringify({
      id: "commit-task",
      stratum: "production-scale",
      timeoutMinutes: 45,
      sandbox: { commit: "abc123", paths: ["src", "package.json"], patch: "pre-fix.patch", setup: [["bun", "install"]] },
    }));
    await Bun.write(join(taskDir, "plan.json"), JSON.stringify(PLAN));
    await Bun.write(join(taskDir, "manifest.json"), JSON.stringify({ traps: [], judgment: [] }));
    await Bun.write(join(taskDir, "pre-fix.patch"), "diff --git a/src/value.ts b/src/value.ts\n");
    const [task] = await loadImplementTasks(join(taskDir, ".."));
    if (task?.kind === "native" || !task) throw new Error("expected plan task");
    expect(task.timeoutMs).toBe(45 * 60_000);
    expect(task.sandbox).toMatchObject({
      commit: "abc123",
      paths: ["src", "package.json"],
      patch: "pre-fix.patch",
      setup: [["bun", "install"]],
    });
  });

  it("rejects malformed sandboxes", async () => {
    const taskDir = join(temporaryDirectory("implement-task-"), "bad-task");
    await mkdir(join(taskDir, "acceptance"), { recursive: true });
    await Bun.write(join(taskDir, "plan.json"), JSON.stringify(PLAN));
    await Bun.write(join(taskDir, "manifest.json"), JSON.stringify({ traps: [], judgment: [] }));
    const rejects = async (sandbox: unknown, message: string) => {
      await Bun.write(join(taskDir, "task.json"), JSON.stringify({ id: "bad-task", stratum: "s", sandbox }));
      await expect(loadImplementTasks(join(taskDir, ".."))).rejects.toThrow(message);
    };
    await rejects({ commit: "abc123", paths: [] }, "paths must be a non-empty string array");
    await rejects({ commit: "abc123", paths: ["src"], setup: [[]] }, "setup must be an array of non-empty string arrays");
    await rejects({ commit: "HEAD", paths: ["src"] }, "commit must be a hexadecimal Git object ID");
    await rejects({ commit: "abc123", paths: ["src"], ptach: "pre-fix.patch" }, "sandbox.ptach is not a sandbox field");
    await rejects({ fixtureRepo: "project", paths: ["src"] }, "sandbox.paths is not a sandbox field");
  });

  it("gives the direct persona benchmark the shared plan and native implement tasks", async () => {
    expect(catalog.implementTasksDir).toBe(IMPLEMENT_TASKS_DIR);
    const tasks = await catalog.implementTasks();
    expect(tasks.map((task) => task.id)).toEqual(["astropy__astropy-14598", "ds1000-298", "getmoto__moto-7365", "hosted-thinking-row-wait", "httpx-streaming-json-iteration", "jquense__yup-2305", "metrics-resteer", "psf__requests-6028", "recall-punctuated-words", "redis__redis-10068", "regex-chess", "rust-react", "scheme-metacircular", "template-multiphase"]);
    for (const task of tasks) {
      if (task.kind === "native") {
        expect(task.prompt).toBe(task.instruction + (task.environment === undefined ? "" : `\n\n## Native environment context\n${task.environment}`));
      } else {
        expect(task.prompt).toContain(PLAN_FILE);
      }
      expect(task.prompt).not.toContain("phase-level verification");
      expect(task.timeoutMs).toBe(DEFAULT_IMPLEMENTER_TIMEOUT_MS);
    }
  });

  it("rejects absolute task-configured source paths", async () => {
    const tasksDir = await writeSyntheticTaskDir();
    const taskJson = join(tasksDir, "synthetic", "task.json");
    await Bun.write(taskJson, JSON.stringify({ id: "synthetic", stratum: "small", sandbox: { fixtureRepo: tasksDir } }));
    try {
      await expect(loadImplementTasks(tasksDir)).rejects.toThrow("fixtureRepo must be relative to its task directory");
    } finally {
      await rm(tasksDir, { recursive: true, force: true });
    }
  });

  it("identifies every consumed implementation task input", async () => {
    const tasksDir = await writeSyntheticTaskDir();
    const taskDir = join(tasksDir, "synthetic");
    const identity = async () => {
      const [task] = await loadImplementTasks(tasksDir);
      if (!task) throw new Error("expected one implementation task");
      return { content: task.contentIdentity, candidate: task.candidateIdentity, grader: task.graderIdentity };
    };
    const original = await identity();
    const cases = [
      ["project/value.ts", "export const value = 2;\n"],
      ["acceptance/value.test.ts", "test('changed acceptance', () => {});\n"],
      ["plan.json", JSON.stringify({ ...PLAN, success_criteria: ["changed"] })],
      ["plan.json", JSON.stringify(Object.fromEntries(Object.entries(PLAN).toReversed()))],
      ["manifest.json", JSON.stringify({ traps: [{ id: "trap", title: "Trap", catchCriteria: "Catch it" }], judgment: [] })],
      ["task.json", JSON.stringify({ id: "synthetic", stratum: "changed" })],
    ] as const;

    try {
      for (const [relativePath, changed] of cases) {
        const path = join(taskDir, relativePath);
        const before = await Bun.file(path).text();
        await Bun.write(path, changed);
        const current = await identity();
        expect(current.content).not.toBe(original.content);
        // Only the hidden acceptance tests grade; every other input is what the candidate answers.
        const grading = relativePath.startsWith("acceptance/");
        expect([current.candidate === original.candidate, current.grader === original.grader], relativePath).toEqual([grading, !grading]);
        await Bun.write(path, before);
      }
    } finally {
      await rm(tasksDir, { recursive: true, force: true });
    }
  });

  it("identifies the patch applied to a commit-backed implementation task", async () => {
    const tasksDir = await writeSyntheticTaskDir();
    const taskDir = join(tasksDir, "synthetic");
    const taskPath = join(taskDir, "task.json");
    await Bun.write(taskPath, JSON.stringify({
      id: "synthetic",
      stratum: "small",
      sandbox: {
        commit: "0123456789abcdef0123456789abcdef01234567",
        paths: ["src"],
        patch: "pre-fix.patch",
      },
    }));
    await Bun.write(join(taskDir, "pre-fix.patch"), "original patch\n");

    try {
      const [originalTask] = await loadImplementTasks(tasksDir);
      if (!originalTask) throw new Error("expected one implementation task");
      await Bun.write(join(taskDir, "pre-fix.patch"), "changed patch\n");
      const [changedTask] = await loadImplementTasks(tasksDir);
      expect(changedTask?.contentIdentity).not.toBe(originalTask.contentIdentity);
      const recorded: string[][] = [];
      const runner: OwnedCommandRunner = async (command) => {
        recorded.push([...command]);
        return { exitCode: 0, timedOut: false, stdoutBytes: new Uint8Array(), stdout: "", stderr: "" };
      };
      const sandbox = await provisionTaskSandbox(process.cwd(), originalTask, runner);
      try {
        const initialization = recorded.findIndex(command => command[0] === "git" && command[1] === "init");
        const patchApplication = recorded.findIndex(command => command[0] === "git" && command[1] === "apply");
        expect(initialization).toBeGreaterThanOrEqual(0);
        expect(patchApplication).toBeGreaterThan(initialization);
      } finally {
        await rm(sandbox, { recursive: true, force: true });
      }
    } finally {
      await rm(tasksDir, { recursive: true, force: true });
    }
  });

  it("identifies task-derived quality judge prompts", async () => {
    const tasksDir = await writeSyntheticTaskDir();
    try {
      const [task] = await loadImplementTasks(tasksDir);
      if (!task) throw new Error("expected one implementation task");
      if (task.kind === "native") throw new Error("expected a plan task");
      const benchmarkTask = {
        ...task,
        prompt: "Implement the plan.",
        timeoutMs: task.timeoutMs ?? DEFAULT_IMPLEMENTER_TIMEOUT_MS,
      };
      const original = implementQualityJudgeInputIdentity([benchmarkTask]);
      expect(original).toBe("68363c6081c8eaca4610c9cf4d47ddb368b1b2f643861f1decfbb40172d03182");
      expect(implementQualityJudgeInputIdentity([{ ...benchmarkTask, plan: { ...PLAN, success_criteria: ["changed"] } }]))
        .not.toBe(original);
      expect(implementQualityJudgeInputIdentity([{
        ...benchmarkTask,
        manifest: {
          ...benchmarkTask.manifest,
          traps: [{ id: "trap", title: "Trap", catchCriteria: "Reject the seeded defect" }],
        },
      }])).not.toBe(original);
    } finally {
      await rm(tasksDir, { recursive: true, force: true });
    }
  });

  it("refuses a plan that the implementation plan contract rejects, naming the file and the field", async () => {
    const tasksDir = await writeSyntheticTaskDir();
    try {
      await Bun.write(join(tasksDir, "synthetic", "plan.json"), JSON.stringify({ ...PLAN, open_questions: [] }));
      await expect(loadImplementTasks(tasksDir)).rejects.toThrow(/synthetic\/plan\.json does not match the implementation plan contract:\n.*open_questions/);
    } finally {
      await rm(tasksDir, { recursive: true, force: true });
    }
  });
});

describe("implementation sandbox", () => {
  it("prepares native source before baseline and grades the captured patch separately with authoritative evidence", async () => {
    const tasksDir = await writeSyntheticTaskDir();
    const taskDir = join(tasksDir, "synthetic");
    await Bun.write(join(taskDir, "instruction.txt"), "Fix the bug.");
    await Bun.write(join(taskDir, "adapter.py"), "# task-owned adapter");
    await Bun.write(join(taskDir, "task.json"), JSON.stringify({
      kind: "native", id: "synthetic", stratum: "small", family: "python", split: "development",
      instruction: "instruction.txt", native: { command: ["python3", "adapter.py"], timeoutMs: 3_600_000 },
    }));
    const [task] = await loadImplementTasks(tasksDir);
    if (task?.kind !== "native") throw new Error("expected native task");
    let candidateWorkspace = "";
    let report = '{"passed":0,"failed":1,"total":1,"evidence":{"original.test_bug":"FAIL","grade":false}}\n';
    let exitCode = 0;
    let timedOut = false;
    let prepareFails = false;
    const patch = `diff --git a/value.ts b/value.ts\n+${"candidate".repeat(150_000)}\n`;
    let capturedPatchPath = "";
    const recorded: string[][] = [];
    const runner: OwnedCommandRunner = async (command, options) => {
      recorded.push([...command]);
      if (command[1] === "diff" && !command.includes("--numstat")) {
        const output = command.find(argument => argument.startsWith("--output="));
        if (output) {
          capturedPatchPath = output.slice("--output=".length);
          expect(capturedPatchPath.startsWith(`${candidateWorkspace}/`)).toBe(false);
          await Bun.write(capturedPatchPath, patch);
          return { exitCode: 0, timedOut: false, stdout: "", stderr: "", stdoutBytes: new Uint8Array() };
        }
        return { exitCode: 0, timedOut: false, stdout: patch.slice(0, 1_000_000), stderr: "", stdoutBytes: new Uint8Array(), stdoutTruncated: true };
      }
      if (command[0] === "python3") {
        expect(options?.timeoutMs).toBe(3_600_000);
        expect(options?.env?.HOME).toBe(join(command[4]!, ".bench-home"));
        expect(options?.env).not.toHaveProperty("OPENAI_API_KEY");
        expect(command[3]).toBe(task.taskDir);
        if (command[2] === "prepare") {
          candidateWorkspace = command[4]!;
          await Bun.write(join(candidateWorkspace, "source.py"), "value = 1\n");
          if (prepareFails) {
            await Bun.write(join(candidateWorkspace, ".flywheel", "flywheel.sqlite"), "failed preparation state");
            return { exitCode: 1, timedOut: false, stdout: "", stderr: "", stdoutBytes: new Uint8Array() };
          }
        } else {
          expect(command[2]).toBe("grade");
          expect(command[4]).not.toBe(candidateWorkspace);
          expect(await Bun.file(command[5]!).text()).toBe(patch);
          if (report !== "") await Bun.write(command[6]!, report);
          return { exitCode, timedOut, stdout: "999 pass", stderr: "adapter diagnostic", stdoutBytes: new Uint8Array(), stdoutTruncated: true };
        }
      }
      return fakeCommandRunner(command, options);
    };
    let sandbox: string | undefined;
    try {
      sandbox = await provisionTaskSandbox(process.cwd(), task, runner);
      expect(recorded.findIndex(command => command[2] === "prepare")).toBeLessThan(recorded.findIndex(command => command.includes("commit")));
      expect(await Bun.file(join(sandbox, PLAN_FILE)).exists()).toBe(false);
      const grade = await captureImplementation(task, sandbox, runner);
      expect(grade.diff).toBe(patch);
      expect(grade.diffStats).toEqual({ linesAdded: 1, linesRemoved: 1, filesTouched: 1 });
      expect(await Bun.file(capturedPatchPath).exists()).toBe(false);
      expect(grade.acceptance).toEqual({ passed: 0, failed: 1, total: 1 });
      expect(grade.nativeGrade).toBe(report);
      expect(recorded.find(command => command[1] === "diff")?.includes(":(exclude,glob)acceptance")).toBe(false);
      for (const invalid of [
        "", "not JSON", '{"passed":1,"failed":0,"total":2,"evidence":false}',
        '{"passed":0,"failed":0,"total":0,"evidence":null}',
        '{"passed":1,"failed":0,"total":1}',
        '{"passed":1,"failed":0,"total":1,"evidence":true,"extra":1}',
      ]) {
        report = invalid;
        await expect(captureImplementation(task, sandbox, runner)).rejects.toThrow();
      }
      report = '{"passed":1,"failed":0,"total":1,"evidence":true}';
      const evidence = { directory: join(tasksDir, "results", "evidence", "model", "synthetic", "0", "stamp"), resultsDir: join(tasksDir, "results") };
      exitCode = 1;
      const evidenceLocation = join("evidence", "model", "synthetic", "0", "stamp");
      await expect(captureImplementation(task, sandbox, runner, evidence)).rejects.toThrow(`exit code 1; evidence: ${evidenceLocation}`);
      expect(await Bun.file(join(evidence.directory, "grade-stdout.txt")).text()).toBe("999 pass");
      expect(await Bun.file(join(evidence.directory, "grade-stderr.txt")).text()).toBe("adapter diagnostic");
      expect(await Bun.file(join(evidence.directory, "captured.patch")).text()).toBe(patch);
      expect(await Bun.file(join(evidence.directory, "grade-output-truncated.txt")).text()).toBe("Retained grade output is truncated: stdout.\n");
      exitCode = 0;
      timedOut = true;
      await expect(captureImplementation(task, sandbox, runner, evidence)).rejects.toThrow(`timed out; evidence: ${evidenceLocation}`);
      prepareFails = true;
      await expect(provisionTaskSandbox(process.cwd(), task, runner, { evidence })).rejects.toThrow("Native prepare failed");
      expect(await Bun.file(join(evidence.directory, ".flywheel", "flywheel.sqlite")).text()).toBe("failed preparation state");
      expect(await Bun.file(join(candidateWorkspace, ".flywheel", "flywheel.sqlite")).exists()).toBe(false);
    } finally {
      if (sandbox) await rm(sandbox, { recursive: true, force: true });
      await rm(tasksDir, { recursive: true, force: true });
    }
  });
  it("reports evidence copy failure without rejecting or changing the source store", async () => {
    const tasksDir = await writeSyntheticTaskDir();
    try {
      const sandbox = join(tasksDir, "sandbox");
      const directory = join(tasksDir, "evidence");
      await Bun.write(join(sandbox, ".flywheel", "flywheel.sqlite"), "candidate state");
      await Bun.write(join(directory, ".flywheel"), "blocked copy destination");
      await expect(retainImplementStore(sandbox, directory)).resolves.toBeUndefined();
      expect(await Bun.file(join(directory, "evidence-error.txt")).text()).toBe("Could not retain all implementation evidence.\n");
      expect(await Bun.file(join(sandbox, ".flywheel", "flywheel.sqlite")).text()).toBe("candidate state");
    } finally {
      await rm(tasksDir, { recursive: true, force: true });
    }
  });
  it("rejects a captured diff containing a recognized credential", async () => {
    const tasksDir = await writeSyntheticTaskDir();
    const [task] = await loadImplementTasks(tasksDir);
    if (!task) throw new Error("expected one synthetic task");
    const sandbox = await provisionTaskSandbox(process.cwd(), task, fakeCommandRunner);
    const credential = `sk-${"a".repeat(40)}`;
    const commands: string[][] = [];
    let capturedPatchPath = "";
    const runner: OwnedCommandRunner = async (command) => {
      commands.push([...command]);
      const output = command.find(argument => argument.startsWith("--output="));
      if (output) {
        capturedPatchPath = output.slice("--output=".length);
        await Bun.write(capturedPatchPath, `+const token = "${credential}";\n`);
      }
      return {
        exitCode: 0,
        timedOut: false,
        stdoutBytes: new Uint8Array(),
        stdout: command.includes("diff") ? `+const token = "${credential}";\n` : "",
        stderr: "",
      };
    };
    try {
      await expect(captureImplementation(task, sandbox, runner)).rejects.toThrow("recognized credential");
      expect(commands.some((command) => command[0] === "bun")).toBe(false);
      expect(await Bun.file(capturedPatchPath).exists()).toBe(false);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
      await rm(tasksDir, { recursive: true, force: true });
    }
  });

  it("rejects truncated acceptance output instead of recording partial counts", async () => {
    const tasksDir = await writeSyntheticTaskDir();
    const [task] = await loadImplementTasks(tasksDir);
    if (!task) throw new Error("expected one synthetic task");
    const sandbox = await provisionTaskSandbox(process.cwd(), task, fakeCommandRunner);
    const runner: OwnedCommandRunner = async (command, options) => {
      const isAcceptance = command[0] === "bun";
      if (!isAcceptance) return fakeCommandRunner(command, options);
      return {
        exitCode: 0,
        timedOut: false,
        stdoutBytes: new Uint8Array(),
        stdout: "1 pass\n",
        stderrTruncated: true,
        stderr: "",
      };
    };
    try {
      await expect(captureImplementation(task, sandbox, runner)).rejects.toThrow("sandbox test output was truncated");
    } finally {
      await rm(sandbox, { recursive: true, force: true });
      await rm(tasksDir, { recursive: true, force: true });
    }
  });

  it("materializes the plan for direct reading and keeps it out of the captured diff", async () => {
    const tasksDir = await writeSyntheticTaskDir();
    const [task] = await loadImplementTasks(tasksDir);
    if (!task) throw new Error("expected one synthetic task");
    const commands: string[][] = [];
    const runner: OwnedCommandRunner = (command, options) => {
      commands.push([...command]);
      return fakeCommandRunner(command, options);
    };
    const sandbox = await provisionTaskSandbox(process.cwd(), task, runner);
    try {
      const plan: unknown = JSON.parse(await Bun.file(join(sandbox, PLAN_FILE)).text());
      expect(plan).toEqual(PLAN);
      expect(await Bun.file(join(sandbox, "value.ts")).text()).toBe("export const value = 1;\n");
      expect(await Bun.file(join(sandbox, "acceptance", "value.test.ts")).exists()).toBe(false);

      await Bun.write(join(sandbox, "value.ts"), "export const value = 2;\n");
      await rm(join(sandbox, ".gitignore"));
      await mkdir(join(sandbox, "acceptance"));
      await Bun.write(join(sandbox, "acceptance", "candidate.test.ts"), "test('inflated pass', () => {});\n");
      await mkdir(join(sandbox, ".flywheel"));
      await Bun.write(join(sandbox, ".flywheel", "events.jsonl"), "runtime state\n");
      await mkdir(join(sandbox, ".bench-home"), { recursive: true });
      await Bun.write(join(sandbox, ".bench-home", "credentials"), "sandbox home\n");
      captureAddCommand = undefined;
      captureResetCommand = undefined;
      const captured = await captureImplementation(task, sandbox, runner);
      expect(commands).toContainEqual(["git", "update-ref", "refs/flywheel/benchmark-baseline", "HEAD"]);
      expect(commands).toContainEqual([
        "git", "diff", "--cached", "refs/flywheel/benchmark-baseline",
        expect.stringMatching(/^--output=/),
        "--", ".", ":(exclude,glob).flywheel", ":(exclude,glob).bench-plan.json", ":(exclude,glob).bench-home", ":(exclude,glob)acceptance",
        ":(exclude,glob)**/__pycache__/**",
      ]);
      expect(captured.diff).toBe("diff --git a/value.ts b/value.ts\n");
      expect<readonly string[] | undefined>(captureAddCommand).toEqual(["git", "add", "-A"]);
      expect<readonly string[] | undefined>(captureResetCommand).toEqual([
        "git", "reset", "--quiet", "HEAD", "--",
        ":(glob).flywheel", ":(glob).bench-plan.json", ":(glob).bench-home", ":(glob)acceptance", ":(glob)**/__pycache__/**",
      ]);
      expect(captured.diff).not.toContain(PLAN_FILE);
      expect(captured.diffStats).toEqual({ linesAdded: 1, linesRemoved: 1, filesTouched: 1 });
      expect(captured.acceptance).toEqual({ passed: 1, failed: 0, total: 1 });
      expect(await Bun.file(join(sandbox, "acceptance", "candidate.test.ts")).exists()).toBe(false);
      expect(await Bun.file(join(sandbox, "acceptance", "value.test.ts")).exists()).toBe(true);
      expect(await stat(join(sandbox, ".flywheel")).then(() => true, () => false)).toBe(true);
      expect(await stat(join(sandbox, PLAN_FILE)).then(() => true, () => false)).toBe(true);
      expect(await stat(join(sandbox, ".bench-home")).then(() => true, () => false)).toBe(true);
    } finally {
      await rm(sandbox, { recursive: true, force: true });
      await rm(tasksDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("implementation sandbox command environment", () => {
  it("rejects successful checked commands with truncated stdout", async () => {
    const runner: OwnedCommandRunner = async () => ({
      exitCode: 0,
      timedOut: false,
      stdoutBytes: new Uint8Array(),
      stdout: "partial",
      stdoutTruncated: true,
      stderr: "",
    })

    // The command creates its home directory inside the sandbox directory.
    const sandbox = await mkdtemp(join(tmpdir(), "bench-implement-sandbox-"));
    try {
      await expect(runCheckedSandboxCommand(runner, ["git", "diff"], {
        cwd: sandbox,
        sandboxDir: sandbox,
      })).rejects.toThrow("output was truncated")
    } finally {
      await rm(sandbox, { recursive: true, force: true });
    }
  })

  it("gives every sandbox command an explicit credential-free environment with a sandbox-local home", async () => {
    const tasksDir = await writeSyntheticTaskDir();
    commandEnvs.length = 0;
    const [task] = await loadImplementTasks(tasksDir);
    if (!task) throw new Error("expected one synthetic task");
    const sandbox = await provisionTaskSandbox(process.cwd(), task, fakeCommandRunner);
    try {
      await captureImplementation(task, sandbox, fakeCommandRunner);
      expect(commandEnvs.length).toBeGreaterThan(0);
      for (const env of commandEnvs) {
        if (!env) throw new Error("a sandbox command inherited the process environment");
        expect(Object.keys(env).sort()).toEqual([
          "GIT_CONFIG_GLOBAL",
          "GIT_CONFIG_SYSTEM",
          "GIT_TERMINAL_PROMPT",
          "HOME",
          "LANG",
          "LC_ALL",
          "PATH",
          "PYTHONDONTWRITEBYTECODE",
          "TMPDIR",
        ]);
        expect(env.HOME).toBe(join(sandbox, ".bench-home"));
        expect(env.PYTHONDONTWRITEBYTECODE).toBe("1");
        expect(env.HOME).not.toBe(process.env.HOME);
        for (const [name, value] of Object.entries(env)) {
          expect(name).not.toMatch(/KEY|TOKEN|SECRET|CREDENTIAL/i);
          expect(value).not.toBe(process.env.HOME);
        }
      }
    } finally {
      await rm(sandbox, { recursive: true, force: true });
      await rm(tasksDir, { recursive: true, force: true });
    }
  }, 30_000);

  it("reports a failed sandbox command by its exit metadata and never stores its output", async () => {
    const tasksDir = await writeSyntheticTaskDir();
    const secret = "sk-live-must-not-be-persisted";
    const failingRunner: OwnedCommandRunner = async (command) => command[1] === "init"
      ? { exitCode: 1, timedOut: false, stdoutBytes: new Uint8Array(), stdout: secret, stderr: `fatal: ${secret}` }
      : { exitCode: 0, timedOut: false, stdoutBytes: new Uint8Array(), stdout: "", stderr: "" };
    const [task] = await loadImplementTasks(tasksDir);
    if (!task) throw new Error("expected one synthetic task");
    try {
      const failure = await provisionTaskSandbox(process.cwd(), task, failingRunner).then(
        () => undefined,
        (error) => error,
      );
      expect(failure).toBeInstanceOf(Error);
      const message = failure instanceof Error ? failure.message : "";
      expect(message).toContain("exit code 1");
      expect(message).not.toContain(secret);
    } finally {
      await rm(tasksDir, { recursive: true, force: true });
    }
  });
});
