import { describe, expect, test } from "bun:test";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { CampaignDesign } from "../../../bench/chat-ab/campaign-runner.js";
import { familyCommandOptions } from "../../../bench/chat-ab/family-command.js";
import { planningFamily } from "../../../bench/chat-ab/planning-family.js";
import { judgePlanningCampaign } from "../../../bench/chat-ab/planning-judge.js";
import { parseRecallReply } from "../../../bench/chat-ab/planning-recall.js";
import { formatPlanningReport, renderPlanningReport } from "../../../bench/chat-ab/planning-report.js";
import { planningLedger, type PlanningCampaign } from "../../../bench/chat-ab/planning-store.js";
import { loadPlanningTasks, PLANNING_INSTRUCTION, PLANNING_TASKS_DIR, qualifyPlanningTask } from "../../../bench/chat-ab/planning-task.js";
import type { Sandbox } from "../../../bench/chat-ab/tasks.js";
import { bytesIdentity } from "../../../src/orchestration/modules/development/benchmark/content-identity.js";
import { unavailableBenchmarkAccounting } from "../../../src/orchestration/modules/development/benchmark/evidence.js";
import type { JudgeModel } from "../../../src/orchestration/modules/development/benchmark/judge.js";
import { temporaryDirectories } from "../../helpers/directories.js";
import { fakeOwnedCommandRunner, ownedCommandResult } from "../../helpers/owned-command-fake.js";

const temporary = temporaryDirectories();
const CORPUS = ["healthz-greenfield", "session-cost-budget"];

async function taskFolder(task: unknown, manifest?: unknown): Promise<string> {
  const root = temporary("planning-tasks-");
  await mkdir(join(root, "fixture"));
  await writeFile(join(root, "fixture", "task.json"), JSON.stringify(task));
  await writeFile(join(root, "fixture", "brief.md"), "Add a guard.\n");
  if (manifest !== undefined) await writeFile(join(root, "fixture", "manifest.json"), JSON.stringify(manifest));
  return root;
}

const repositoryTask = { id: "fixture", stratum: "small", timeoutMinutes: 1, sandbox: { commit: `${"a".repeat(40)}:sub`, paths: ["src"] } };
const point = (id: string, catchCriteria: string) => ({ id, title: `Point ${id}`, catchCriteria });

describe("planning tasks", () => {
  test("the corpus loads: repository tasks pin a tree without the answer key, and greenfield is the empty tree", async () => {
    const tasks = await loadPlanningTasks(PLANNING_TASKS_DIR, CORPUS);
    for (const task of tasks) {
      expect(task.message.split(PLANNING_INSTRUCTION)).toHaveLength(2);
      expect(task.message.startsWith(task.brief)).toBe(true);
      const ids = task.manifest?.mustAddress.map(({ id }) => id) ?? [];
      expect(task.manifest?.falsePremises.every((id) => ids.includes(id)) ?? true).toBe(true);
      if (!("commit" in task.sandbox)) throw new Error(`${task.id} must pin a commit`);
      expect(task.sandbox.commit).toMatch(/^[0-9a-f]{40}(:[^:]+)?$/);
      expect(task.sandbox.paths.some((path) => /^(bench|inspiration)(\/|$)/.test(path))).toBe(false);
    }
    const healthz = tasks.find(({ id }) => id === "healthz-greenfield")!;
    expect(healthz.sandbox).toEqual({ commit: "4b825dc642cb6eb9a060e54bf8d69288fbee4904", paths: [] });
    expect(healthz.manifest).toBeNull();
  });

  test("the loader refuses a snapshot sandbox, an unknown key, empty paths, a copied answer key, and an unknown false premise", async () => {
    const refused = [
      { ...repositoryTask, sandbox: "repo-snapshot" },
      { ...repositoryTask, patch: "fixture.patch" },
      { ...repositoryTask, sandbox: { ...repositoryTask.sandbox, paths: [] } },
      { ...repositoryTask, sandbox: { ...repositoryTask.sandbox, paths: ["src", "bench/tasks"] } },
    ];
    for (const task of refused) await expect(loadPlanningTasks(await taskFolder(task), ["fixture"])).rejects.toThrow();
    await expect(loadPlanningTasks(await taskFolder(repositoryTask, { mustAddress: [point("m1", "x")], falsePremises: ["m2"] }), ["fixture"])).rejects.toThrow("falsePremises");
  });

  test("qualify checks each backticked repository path at the pinned tree and names the missing one", async () => {
    const root = await taskFolder(repositoryTask, { mustAddress: [point("m1", "Reads `src/a.ts` and `src/b.ts`, not `createThing`."), point("m2", "Tests in `tests/c.test.ts`.")] });
    const [task] = await loadPlanningTasks(root, ["fixture"]);
    const { run, calls } = fakeOwnedCommandRunner(async (command) => ownedCommandResult("", command.at(-1)!.endsWith("src/b.ts") ? 1 : 0));
    await expect(qualifyPlanningTask(task!, run)).rejects.toThrow(`m1: src/b.ts`);
    expect(calls.map(({ command }) => command.at(-1))).toEqual([`${"a".repeat(40)}:sub/src/a.ts`, `${"a".repeat(40)}:sub/src/b.ts`, `${"a".repeat(40)}:sub/tests/c.test.ts`]);
    expect(calls[0]!.command.slice(-3, -1)).toEqual(["cat-file", "-e"]);
    const [healthz] = await loadPlanningTasks(PLANNING_TASKS_DIR, ["healthz-greenfield"]);
    const greenfield = fakeOwnedCommandRunner();
    await qualifyPlanningTask(healthz!, greenfield.run);
    expect(greenfield.calls).toEqual([]);
  });

  test("a vendored fixture folder qualifies against its own files and its content is in the identity", async () => {
    const root = await taskFolder({ ...repositoryTask, sandbox: { fixtureRepo: "project" } }, { mustAddress: [point("m1", "Reads `src/a.ts` and `src/b.ts`.")] });
    await mkdir(join(root, "fixture", "project", "src"), { recursive: true });
    await writeFile(join(root, "fixture", "project", "src", "a.ts"), "one\n");
    const [task] = await loadPlanningTasks(root, ["fixture"]);
    const { run, calls } = fakeOwnedCommandRunner();
    await expect(qualifyPlanningTask(task!, run)).rejects.toThrow("project does not hold:\nm1: src/b.ts");
    expect(calls).toEqual([]);
    await writeFile(join(root, "fixture", "project", "src", "a.ts"), "two\n");
    expect((await loadPlanningTasks(root, ["fixture"]))[0]?.contentIdentity).not.toBe(task?.contentIdentity);
  });
});

const [greenfieldTask] = await loadPlanningTasks(PLANNING_TASKS_DIR, ["healthz-greenfield"]);

describe("planning capture", () => {
  const design: CampaignDesign = { name: "plans", tasks: ["healthz-greenfield"], repeats: 1, model: "m", effort: "medium", authProfile: "Personal", treatments: { a: "HEAD" } };
  const family = planningFamily(design);
  const diffRunner = () => fakeOwnedCommandRunner(async (command) => ownedCommandResult(command.includes("--numstat") ? "4\t1\tsrc/server.ts\n" : command[1] === "diff" ? "diff --git a/src/server.ts" : ""));

  async function cell() {
    const directory = temporary("planning-capture-");
    const sandbox: Sandbox = { dir: join(directory, "sandbox"), home: join(directory, "home"), baseline: "base", dispose: async () => {} };
    const artifactRoot = join(directory, "cell");
    await mkdir(sandbox.dir, { recursive: true });
    await mkdir(artifactRoot, { recursive: true });
    const context = { executions: [], cell: { treatment: "a", task: "t", repeat: 0 }, artifactRoot, directory };
    return { directory, sandbox, artifactRoot, context };
  }

  test("PLAN.md becomes a hashed artifact, other changes become otherChanges, and recovery reads the finished artifact", async () => {
    const { directory, sandbox, artifactRoot, context } = await cell();
    await writeFile(join(sandbox.dir, "PLAN.md"), "# Plan\n\n1. Add the route.\n");
    const { run, calls } = diffRunner();
    const { grade, diff } = await family.capture(greenfieldTask!, sandbox, run, undefined, context);
    expect(grade).toEqual({ plan: { path: "cell/plan.md", sha256: bytesIdentity("# Plan\n\n1. Add the route.\n") }, planMissing: null, otherChanges: { linesAdded: 4, linesRemoved: 1, filesTouched: 1 } });
    expect(diff).toBe("diff --git a/src/server.ts");
    expect(calls.find(({ command }) => command.includes("--numstat"))!.command).toContain(":(exclude,glob)PLAN.md");
    expect(await readFile(join(artifactRoot, "plan.md"), "utf8")).toBe("# Plan\n\n1. Add the route.\n");
    expect(await family.recoverCapture!(directory, artifactRoot)).toEqual({ ...grade, otherChanges: null });
  });

  test("a missing or linked PLAN.md is no plan with its reason, and credential bytes are refused", async () => {
    const missing = await cell();
    expect((await family.capture(greenfieldTask!, missing.sandbox, diffRunner().run, undefined, missing.context)).grade).toMatchObject({ plan: null, planMissing: "The run wrote no PLAN.md" });
    expect(await family.recoverCapture!(missing.directory, missing.artifactRoot)).toEqual({ plan: null, planMissing: "No plan was captured", otherChanges: null });
    const linked = await cell();
    await writeFile(join(linked.directory, "outside.md"), "# Plan");
    await symlink(join(linked.directory, "outside.md"), join(linked.sandbox.dir, "PLAN.md"));
    expect((await family.capture(greenfieldTask!, linked.sandbox, diffRunner().run, undefined, linked.context)).grade).toMatchObject({ plan: null, planMissing: "PLAN.md is not a regular file" });
    const secret = await cell();
    await writeFile(join(secret.sandbox.dir, "PLAN.md"), `Use ghp_${"A1b2C3d4E5".repeat(4)} to push.`);
    await expect(family.capture(greenfieldTask!, secret.sandbox, diffRunner().run, undefined, secret.context)).rejects.toThrow("credential");
  });
});

describe("planning recall", () => {
  test("the decoder classifies every id exactly once", () => {
    const ids = ["m1", "m2", "m3"];
    expect(parseRecallReply('Verdict: {"addressed":["m1"],"uncertain":["m3"],"missed":["m2"]}', ids)).toEqual({ addressed: ["m1"], uncertain: ["m3"], missed: ["m2"] });
    expect(() => parseRecallReply('{"addressed":["m1"],"uncertain":[],"missed":["m2"]}', ids)).toThrow();
    expect(() => parseRecallReply('{"addressed":["m1","m1"],"uncertain":["m3"],"missed":["m2"]}', ids)).toThrow();
    expect(() => parseRecallReply('{"addressed":["m1","m9"],"uncertain":["m3"],"missed":["m2"]}', ids)).toThrow();
  });

  test("the report counts recall, false premises, compliance, and pairwise verdicts per stratum", () => {
    const manifest = { mustAddress: ["m1", "m2", "m3"].map((id) => point(id, "x")), falsePremises: ["m1", "m2"] };
    const outcome = (treatment: string, task: string, plan: boolean, filesTouched: number, last: "complete" | "input_required") => ({
      attemptId: `${treatment}-${task}`, cell: { treatment, task, repeat: 0 },
      plan: plan ? { path: "p", sha256: "s" } : null, otherChanges: { linesAdded: 0, linesRemoved: 0, filesTouched }, runs: [{ outcome: last }],
    });
    const report = formatPlanningReport({
      manifest: { name: "plans", repeats: 1, treatments: [{ id: "a" }, { id: "b" }] },
      tasks: [{ id: "small", stratum: "small", manifest: null }, { id: "broad", stratum: "broad", manifest }],
      outcomes: [outcome("a", "small", true, 0, "complete"), outcome("a", "broad", true, 2, "complete"), outcome("b", "small", false, 0, "input_required"), outcome("b", "broad", true, 0, "complete")],
      recall: new Map([["a-broad", { addressed: ["m1", "m3"], uncertain: ["m2"], missed: [] }], ["b-broad", { addressed: ["m3"], uncertain: [], missed: ["m1", "m2"] }]]),
      pairwise: [{ a: "a", b: "b", verdicts: [{ task: "small", winner: "a" }, { task: "broad", winner: "tie" }] }],
    });
    expect(report).toContain("| small | a | 1/1 | n/a | 0 | n/a | 0 | 0/0 | vs b 1/0/0 |");
    expect(report).toContain("| small | b | 0/1 | n/a | 0 | n/a | 0 | 1/0 | vs a 0/1/0 |");
    expect(report).toContain("| broad | a | 1/1 | 2/3 (66.7%) | 1 | 1/2 (50.0%) | 1 | 0/0 | vs b 0/0/1 |");
    expect(report).toContain("| broad | b | 1/1 | 1/3 (33.3%) | 0 | 0/2 (0.0%) | 0 | 0/0 | vs a 0/0/1 |");
    expect(report).toContain("| all | a | 2/2 | 2/3 (66.7%) | 1 | 1/2 (50.0%) | 1 | 0/0 | vs b 1/0/1 |");
  });
});

describe("planning judge", () => {
  const accounting = unavailableBenchmarkAccounting("not billed");

  async function campaign() {
    const directory = temporary("planning-judge-");
    const [task] = await loadPlanningTasks(PLANNING_TASKS_DIR, ["healthz-greenfield"]);
    const identity = "a".repeat(64);
    const manifest: PlanningCampaign = {
      kind: "planning", version: 2, name: "plans", model: "claude-sonnet-5-5", effort: "medium", authProfile: "Personal",
      answers: "approve-root-workflow-launch", infrastructureIdentity: identity, repeats: 1, createdAt: "now",
      treatments: ["a", "b", "c"].map((id) => ({ id, revision: id, sourceIdentity: identity, dependencyIdentity: identity, harnessIdentity: identity, settingsIdentity: identity, model: "claude-sonnet-5-5", effort: "medium", authProfile: "Personal" })),
      tasks: [{ id: task!.id, stratum: task!.stratum, contentIdentity: task!.contentIdentity, timeoutMs: task!.timeoutMs }],
    };
    const store = await planningLedger.open(directory, manifest);
    for (const treatment of ["a", "b", "c"]) {
      const cell = { treatment, task: task!.id, repeat: 0 };
      const plan = `Plan ${treatment}`;
      await mkdir(join(directory, treatment));
      await writeFile(join(directory, treatment, "plan.md"), plan);
      await store.append({ kind: "attempt", attemptId: treatment, cell, at: "now", directory: treatment });
      await store.append({
        kind: "outcome", version: 2, attemptId: treatment, cell, at: "later", status: "completed", reason: null,
        runs: [{ outcome: "complete", exitCode: 0, wallMs: 10, sessionId: treatment, reason: null, evidence: { kind: "unavailable", reason: "No evidence" }, artifacts: [] }],
        accounting, parentAccounting: accounting, approvals: 0, report: null, diff: null,
        plan: { path: `${treatment}/plan.md`, sha256: bytesIdentity(plan) }, planMissing: null, otherChanges: { linesAdded: 0, linesRemoved: 0, filesTouched: 0 },
      });
    }
    return directory;
  }

  const prefersA: JudgeModel = { async complete(prompt) {
    const text = prompt.includes("against the known requirements and the two plans")
      ? '{"refuted":false,"reason":"Claims hold"}'
      : JSON.stringify({ correctA: "yes", correctB: "no", winner: prompt.includes("## PLAN A\nPlan a") ? "A" : "B", rationale: "Plan a is grounded" });
    return { text, accounting };
  } };

  test("an unknown or repeated treatment is refused before recall or any judge admission", async () => {
    const directory = await campaign();
    const refuse = { admit: async () => { throw new Error("Must not admit"); } };
    for (const choice of [{ a: "missing" }, { a: "a", b: "a" }, { a: "a", b: "missing" }]) {
      await expect(judgePlanningCampaign({ directory, authProfile: "Personal", ...choice }, refuse)).rejects.toThrow("distinct campaign treatments");
    }
    expect((await readdir(directory)).filter((name) => name.startsWith("recall-") || name.startsWith("judge-"))).toEqual([]);
  });

  test("the report shows a comparison of any two treatments judged under another profile", async () => {
    const directory = await campaign();
    const judged = await judgePlanningCampaign({ directory, a: "a", b: "c", authProfile: "Other" }, {
      admit: async () => ({ model: prefersA, profileId: "judge", authorityIncarnation: "authority", [Symbol.asyncDispose]: async () => {} }),
    });
    expect(judged.pairwise?.judged).toBe(1);
    const report = await renderPlanningReport(directory);
    expect(report).toContain("| small | a | 1/1 | n/a | 0 | n/a | 0 | 0/0 | vs c 1/0/0 |");
    expect(report).toContain("| small | b | 1/1 | n/a | 0 | n/a | 0 | 0/0 | not compared |");
    expect(report).toContain("| small | c | 1/1 | n/a | 0 | n/a | 0 | 0/0 | vs a 0/1/0 |");
    expect(report).toContain("Pairwise a vs c: 1 judged, 0 pending, 0 skipped.");
  });
});

test("the family command line requires a dedicated results directory for campaign writes and refuses unknown flags", () => {
  for (const action of ["setup", "run", "resume"]) expect(() => familyCommandOptions([action, "design.json"], "planning.ts")).toThrow("--results");
  expect(familyCommandOptions(["plan", "design.json"], "planning.ts").action).toBe("plan");
  expect(() => familyCommandOptions(["run", "design.json", "--results", "out", "--fast"], "planning.ts")).toThrow("Unknown option: --fast");
  expect(() => familyCommandOptions(["run", "design.json", "--results", "out", "--reserved-evaluation"], "planning.ts")).toThrow("Unknown option");
  expect(familyCommandOptions(["run", "design.json", "--results", "out", "--reserved-evaluation"], "coding-ab.ts", { reservedEvaluation: true }).reservedEvaluation).toBe(true);
  expect(() => familyCommandOptions(["judge", "results", "--baseline", "other"], "planning.ts")).toThrow("Unknown option: --baseline");
  expect(familyCommandOptions(["judge", "results", "--baseline", "other"], "coding-ab.ts", { baseline: true }).baseline).toBe(resolve("other"));
  expect(familyCommandOptions(["resume", "design.json", "--results", "out"], "coding-ab.ts").concurrency).toBeUndefined();
  expect(familyCommandOptions(["resume", "design.json", "--results", "out", "--concurrency", "4"], "coding-ab.ts").concurrency).toBe(4);
  for (const value of ["0", "1.5", "two"]) expect(() => familyCommandOptions(["run", "design.json", "--results", "out", "--concurrency", value], "coding-ab.ts")).toThrow("--concurrency must be a positive integer");
});
