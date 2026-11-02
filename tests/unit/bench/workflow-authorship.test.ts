import { expect, test } from "bun:test";
import { mkdir, readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { captureWorkflowAuthorship, extractWorkflowAuthorship } from "../../../bench/chat-ab/workflow-authorship-metrics.js";
import { taskBootstrap95, tQuantile95, wilson95 } from "../../../bench/chat-ab/statistics.js";
import { workflowAuthorshipLedger, type WorkflowAuthorshipCampaign } from "../../../bench/chat-ab/workflow-authorship-store.js";
import { renderWorkflowAuthorshipReport, workflowCompliance } from "../../../bench/chat-ab/workflow-authorship-report.js";
import { workflowAuthorshipFamily } from "../../../bench/chat-ab/workflow-authorship-family.js";
import { parseCodingDesign } from "../../../bench/chat-ab/coding-ab-design.js";
import { unavailableBenchmarkAccounting } from "../../../src/orchestration/modules/development/benchmark/evidence.js";
import { bytesIdentity } from "../../../src/orchestration/modules/development/benchmark/content-identity.js";
import type { HeadlessBenchmarkExecution } from "../../../src/orchestration/modules/development/benchmark/headless-execution-contract.js";
import { temporaryDirectories } from "../../helpers/directories.js";
import { recoverCampaignAttempts } from "../../../bench/chat-ab/campaign-runner.js";
import { readCampaignArtifact } from "../../../bench/chat-ab/campaign-artifacts.js";
import { loadBenchTasks } from "../../../bench/chat-ab/tasks.js";
import { referenceFix } from "../../../bench/chat-ab/pair-judge.js";
import { codingRedaction } from "../../../bench/chat-ab/block-judge.js";
import { fakeOwnedCommandRunner, ownedCommandResult } from "../../helpers/owned-command-fake.js";

const temporary = temporaryDirectories();
const identity = "a".repeat(64);

test("counts agents and repeat rounds from recorded VM evidence and classifies exact frozen bytes", async () => {
  // Recorded from the current compiler and XState START/start/success commit path, with two real repeat expansions.
  const facts = await readFile(new URL("../../fixtures/workflow-authorship-evidence.jsonl", import.meta.url), "utf8");
  const source = await readFile(new URL("../../fixtures/workflow-authorship-source.workflow.yaml", import.meta.url), "utf8");
  const frozen = new Map([[bytesIdentity(source), "frozen.workflow.yaml"]]);
  const metrics = extractWorkflowAuthorship("probe-run", facts, source, frozen);
  expect(metrics.phases).toEqual(["verify"]);
  expect(metrics.agents.map(({ sessionId, state }) => [sessionId, state])).toEqual([["agent-1", "completed"], ["agent-2", "completed"]]);
  expect(metrics.repeatRounds).toEqual([{ repeatNodeId: "evidence-probe:node:1", rounds: 2 }]);
  expect(metrics.sourceKind).toBe("frozen");
  expect(metrics.frozenFile).toBe("frozen.workflow.yaml");
  expect(extractWorkflowAuthorship("probe-run", facts, `${source}# authored copy\n`, frozen).sourceKind).toBe("authored");
  expect(extractWorkflowAuthorship("probe-run", facts, null, frozen).sourceKind).toBe("unavailable");
  expect(extractWorkflowAuthorship("probe-run", facts, source.replace("Check the result.", "Different work."), frozen).sourceKind).toBe("unavailable");
  const renamed = facts.trim().split("\n").map((line) => JSON.parse(line));
  const definition = renamed.find((row) => row.type === "definition.loaded" && row.payload.kind === "workflow").payload.definition;
  definition.phases[0].phases[0].name = "Create Spec";
  definition.phases[0].phases[0].agents = [{ agent: "first-reviewer", name: "Review Spec" }, "second-reviewer"];
  expect(extractWorkflowAuthorship("probe-run", renamed.map((row) => JSON.stringify(row)).join("\n"), null, frozen).labels)
    .toEqual(["verify", "Create Spec", "first-reviewer", "Review Spec", "second-reviewer"]);
  const outcome = { workflow: { kind: "observed" as const, workflows: [metrics] } };
  expect(workflowCompliance(outcome, "frozen", "chosen")).toBe("yes");
  expect(workflowCompliance(outcome, "authored", "chosen")).toBe("no");
  const unlaunched = { ...outcome, workflow: { kind: "observed" as const, workflows: [] } };
  expect(workflowCompliance(unlaunched, "frozen", "chosen")).toBe("none");
  expect(workflowCompliance(unlaunched, "frozen", "required")).toBe("no");
});

test("family captures immutable launch evidence and recovers completed metrics once after interruption", async () => {
  const directory = temporary("workflow-source-");
  const sourcePath = join(directory, "source.workflow.yaml");
  const source = await readFile(new URL("../../fixtures/workflow-authorship-source.workflow.yaml", import.meta.url), "utf8");
  const rows = (await readFile(new URL("../../fixtures/workflow-authorship-evidence.jsonl", import.meta.url), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  rows.at(-1).payload.provenance = { layer: "session", filePath: sourcePath, id: "evidence-probe" };
  await writeFile(sourcePath, source);
  await utimes(sourcePath, 0, 0);
  const accounting = unavailableBenchmarkAccounting("fixture");
  const result: HeadlessBenchmarkExecution = {
    version: 1, outcome: "complete", exitCode: 0, wallMs: 1, artifacts: {}, totalAccounting: accounting, parentAccounting: accounting,
    evidence: { kind: "observed", requestCount: 0, parentRequestCount: 0, childSessionCount: 0, value: {
      version: 2, projectRoot: directory, rootSessionId: "root", descendantDiscovery: "current-metadata", metadataGaps: [],
      sessions: [{ sessionId: "root", kind: "chat", requests: [], usageEntries: [] }],
      accounting: { usage: "available", price: "estimate", providerInvoicedCost: "unavailable" },
    } },
  };
  const search = async (sessionId: string | undefined, _type: string, path: string) => {
    const text = sessionId ? rows.map((row) => JSON.stringify(row)).join("\n")
      : JSON.stringify({ source: "store", timestamp: 1, sessionId: "probe-run", type: "workflow.run.registered", payload: { launchedFrom: { parentSessionId: "root" } } });
    await writeFile(path, text);
    return { stdout: { path, bytes: Buffer.byteLength(text), sha256: bytesIdentity(text) }, stderr: { path: `${path}.stderr`, bytes: 0, sha256: bytesIdentity("") } };
  };
  const initial = await captureWorkflowAuthorship(result, directory, search);
  expect(initial.kind === "observed" && initial.workflows[0]?.sourceKind).toBe("authored");
  await writeFile(sourcePath, `${source}# changed formatting\n`);
  const edited = await captureWorkflowAuthorship(result, directory, search);
  expect(edited.kind === "observed" && edited.workflows[0]?.sourceKind).toBe("unavailable");
  const family = workflowAuthorshipFamily(parseCodingDesign({
    name: "capture", tasks: ["task"], repeats: 1, model: "model", effort: "medium", authProfile: "Personal",
    roles: { "workflow-agent": { model: "model", effort: "medium" } }, treatments: { authored: "HEAD", handcrafted: "HEAD" },
  }));
  const manifest: WorkflowAuthorshipCampaign = {
    version: 2, kind: "workflow-authorship", name: "capture", model: "model", effort: "medium", authProfile: "Personal",
    answers: "approve-root-workflow-launch", infrastructureIdentity: identity, repeats: 1, createdAt: "now",
    treatments: ["authored", "handcrafted"].map((id) => ({
      id, revision: "revision", sourceIdentity: identity, dependencyIdentity: identity, harnessIdentity: identity, settingsIdentity: identity,
      workflowsMode: "on", model: "model", effort: "medium", authProfile: "Personal", expectedWorkflowSource: id === "authored" ? "authored" : "frozen", workflowLaunch: "chosen",
    })),
    tasks: [{ id: "task", stratum: "fixture", contentIdentity: identity, timeoutMs: 1 }],
  };
  const ledger = await workflowAuthorshipLedger.open(directory, manifest);
  await expect(workflowAuthorshipLedger.open(directory, { ...manifest, message: "design" })).rejects.toThrow("identity changed");
  const designedDirectory = temporary("workflow-authorship-design-");
  await workflowAuthorshipLedger.open(designedDirectory, { ...manifest, message: "design" });
  expect((await workflowAuthorshipLedger.open(designedDirectory)).manifest.message).toBe("design");
  await expect(workflowAuthorshipLedger.open(designedDirectory, manifest)).rejects.toThrow("identity changed");
  const attempt = { kind: "attempt" as const, attemptId: "captured", cell: { treatment: "authored", task: "task", repeat: 0 }, at: "now", directory: "cells/captured" };
  const artifactRoot = join(directory, attempt.directory, "artifacts");
  await mkdir(artifactRoot, { recursive: true });
  await ledger.append(attempt);
  const failed = { ...result, outcome: "failed" as const };
  const [task] = await loadBenchTasks(join(process.cwd(), "bench/chat-ab/tasks"), ["debug-mutable-default"]);
  const captured = await family.capture(task!,
    { dir: directory, home: directory, baseline: "", dispose: async () => {} },
    async () => { throw new Error("Failed origin needs no hidden grading"); }, undefined,
    { executions: [failed], cell: attempt.cell, artifactRoot, directory, searchEvents: search });
  expect(captured.grade.workflow).toEqual(edited);
  expect(captured.grade.workflowArtifact).not.toBeNull();
  await recoverCampaignAttempts(directory, manifest, family);
  await recoverCampaignAttempts(directory, manifest, family);
  const events = await ledger.load();
  const outcomes = events.filter((event) => event.kind === "outcome");
  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]).toMatchObject({ status: "failed", grade: null, workflow: edited, workflowArtifact: captured.grade.workflowArtifact, runs: [] });
  expect(outcomes[0]?.accounting.estimatedUsd.kind).toBe("unavailable");
  expect(await readCampaignArtifact(directory, outcomes[0]!.workflowArtifact!)).toBe(JSON.stringify(edited));
  expect(workflowAuthorshipLedger.pending(manifest, events)).toContainEqual(attempt.cell);
  const unfinished = { ...attempt, attemptId: "unfinished", cell: { ...attempt.cell, treatment: "handcrafted" }, directory: "cells/unfinished" };
  await ledger.append(unfinished);
  await mkdir(join(directory, unfinished.directory, "artifacts"), { recursive: true });
  await writeFile(join(directory, unfinished.directory, "artifacts", "workflow-metrics.json"), '{"kind":"observed","workflows":[');
  await recoverCampaignAttempts(directory, manifest, family);
  const unfinishedOutcome = (await ledger.load()).find((event) => event.kind === "outcome" && event.attemptId === unfinished.attemptId);
  expect(unfinishedOutcome).toMatchObject({ status: "failed", grade: null, workflow: { kind: "unavailable" }, workflowArtifact: null, runs: [] });
});

test("Wilson intervals include uncertainty at zero and all successes, and bootstrap resamples tasks", () => {
  expect(wilson95(0, 0)).toBeNull();
  expect(wilson95(0, 3)![0]).toBeCloseTo(0, 10);
  expect(wilson95(0, 3)![1]).toBeCloseTo(0.561497, 5);
  expect(wilson95(3, 3)![0]).toBeCloseTo(0.438503, 5);
  expect(wilson95(3, 3)![1]).toBeCloseTo(1, 10);
  expect(taskBootstrap95([])).toBeNull();
  expect(taskBootstrap95([0.5])).toEqual({ mean: 0.5, interval: [0.5, 0.5], tasks: 1 });
  expect(taskBootstrap95([-1, 1])).toEqual({ mean: 0, interval: [-1, 1], tasks: 2 });
  expect(taskBootstrap95([0, 0.5, 1])?.mean).toBe(0.5);
  expect(tQuantile95(7)).toBe(1.895);
  expect(tQuantile95(30)).toBe(1.697);
  expect(tQuantile95(60)).toBeCloseTo(1.671, 3);
  expect(tQuantile95(120)).toBeCloseTo(1.658, 3);
});

test("reports task-cluster effects without pooling unequal trial counts or dropping non-compliance and retries", async () => {
  const directory = temporary("workflow-authorship-");
  const manifest: WorkflowAuthorshipCampaign = {
    version: 2, kind: "workflow-authorship", name: "report", model: "model", effort: "medium", authProfile: "Personal",
    answers: "approve-root-workflow-launch", infrastructureIdentity: identity, repeats: 3, createdAt: "now",
    treatments: ["authored", "handcrafted"].map((id) => ({
      id, revision: "revision", sourceIdentity: identity, dependencyIdentity: identity, harnessIdentity: identity, settingsIdentity: identity,
      workflowsMode: "on", model: "model", effort: "medium", authProfile: "Personal", expectedWorkflowSource: id === "authored" ? "authored" : "frozen", workflowLaunch: id === "authored" ? "chosen" : "required",
    })),
    tasks: ["many", "few"].map((id) => ({ id, stratum: "fixture", contentIdentity: identity, timeoutMs: 1000 })),
  };
  const ledger = await workflowAuthorshipLedger.open(directory, manifest);
  for (const task of manifest.tasks) {
    for (let repeat = 0; repeat < (task.id === "many" ? 3 : 1); repeat++) {
      for (const treatment of manifest.treatments) {
        const cell = { treatment: treatment.id, task: task.id, repeat };
        const success = task.id === "many" ? treatment.id === "handcrafted" : treatment.id === "authored";
        const retries = task.id === "many" && repeat === 0 && treatment.id === "handcrafted" ? 2 : 1;
        for (let attempt = 0; attempt < retries; attempt++) {
          const attemptId = `${treatment.id}-${task.id}-${repeat}-${attempt}`;
          await ledger.append({ kind: "attempt", attemptId, cell, at: "now", directory: attemptId });
          const accounting = { ...unavailableBenchmarkAccounting("not measured"), estimatedUsd: { kind: "observed" as const, value: treatment.id === "authored" ? 1 : 2 } };
          await ledger.append({
            kind: "outcome", version: 2, attemptId, cell, at: "later", status: attempt < retries - 1 ? "failed" : "completed", reason: null,
            runs: [{ outcome: "incomplete", exitCode: 2, wallMs: 1000, sessionId: "root", reason: null, workflowsMode: "on", evidence: { kind: "unavailable", reason: "fixture" }, artifacts: [] }],
            accounting, parentAccounting: accounting, approvals: 0, report: null, diff: null,
            grade: { acceptance: { failToPass: { behavior: success ? "pass" : "fail" }, passToPass: { guard: "pass" } }, diffStats: { linesAdded: 1, linesRemoved: 1, filesTouched: 1 } },
            workflow: { kind: "observed", workflows: [] }, workflowArtifact: null,
          });
        }
      }
    }
  }
  const report = await renderWorkflowAuthorshipReport(directory);
  expect(report).toContain("| many | handcrafted | 3/3");
  expect(report).toContain("| few | authored | 1/1");
  expect(report).toContain("| success | 2/2 | 0.000 | [-1.000, 1.000] |");
  expect(report).toContain("| handcrafted | 10.000 | unavailable |");
  expect(report).toContain("| many | authored | 0/3 [0.000, 0.561] | 1.000 | 1.0 | unavailable | 0/0/0 (3/3 attempts observed) | 0/0/3/0 |");
  expect(report).toContain("| 0/3/0/0 |");
  expect(report).toContain("Non-compliant cells stay in every estimate.");
  const calibrationDirectory = temporary("workflow-authorship-calibration-");
  const calibration = await workflowAuthorshipLedger.open(calibrationDirectory, { ...manifest, treatments: manifest.treatments.slice(0, 1) });
  for (const event of await ledger.load()) {
    if (event.cell.treatment === "authored") await calibration.append(event);
  }
  const calibrationReport = await renderWorkflowAuthorshipReport(calibrationDirectory);
  expect(calibrationReport).toContain("| few | authored | 1/1");
  expect(calibrationReport).not.toContain("Paired task effects");
});

test("requires explicit workflow-agent assignments and pins Workflows On without changing task messages", () => {
  const base = { name: "pilot", tasks: ["task"], repeats: 3, model: "model", effort: "medium", authProfile: "Personal", treatments: { authored: "HEAD", handcrafted: "HEAD" } };
  expect(() => workflowAuthorshipFamily(parseCodingDesign(base))).toThrow("Pin workflow-agent");
  const family = workflowAuthorshipFamily(parseCodingDesign({ ...base, roles: { "workflow-agent": { model: "model", effort: "medium" } } }));
  expect(family.workflowsMode).toBe("on");
  const calibration = workflowAuthorshipFamily(parseCodingDesign({ ...base, treatments: { authored: "HEAD" }, roles: { "workflow-agent": { model: "model", effort: "medium" } } }));
  expect(calibration.workflowsMode).toBe("on");
});

test("reads and redacts a patch-built judge reference before considering a shipped fix", async () => {
  const tasksDir = temporary("workflow-reference-");
  await mkdir(join(tasksDir, "patch-task"), { recursive: true });
  await writeFile(join(tasksDir, "patch-task", "WHY.md"), "This fixture has no shipped fix.\n");
  await writeFile(join(tasksDir, "patch-task", "reference.patch"), "+claude-sonnet-5-5\n");
  const redaction = codingRedaction(["claude-sonnet-5-5"]);
  const runner = fakeOwnedCommandRunner(async () => ownedCommandResult("shipped claude-sonnet-5-5"));
  expect(await referenceFix("patch-task", runner.run, redaction, tasksDir)).toBe("+<model>\n");
  expect(runner.calls).toHaveLength(0);
  await writeFile(join(tasksDir, "patch-task", "WHY.md"), "Fix commit: `1234567`\n");
  expect(await referenceFix("patch-task", runner.run, redaction, tasksDir)).toBe("+<model>\n");
  expect(runner.calls).toHaveLength(0);
  await mkdir(join(tasksDir, "shipped-task"), { recursive: true });
  await writeFile(join(tasksDir, "shipped-task", "WHY.md"), "Fix commit: `abcdef0`\n");
  expect(await referenceFix("shipped-task", runner.run, redaction, tasksDir)).toBe("shipped <model>");
  expect(runner.calls).toHaveLength(1);
  expect(runner.calls[0]?.command).toContain("abcdef0");
});

test("plan and run task loading refuse an unjudgeable task before any cell starts", async () => {
  const tasksDir = temporary("workflow-preflight-");
  const id = "missing-reference";
  const taskDir = join(tasksDir, id);
  await mkdir(join(taskDir, "acceptance"), { recursive: true });
  await writeFile(join(taskDir, "task.json"), JSON.stringify({
    id, stratum: "medium", sandbox: { commit: "abcdef0", paths: ["src"] },
    acceptanceBaseline: { failToPass: ["test > fix"], passToPass: [] },
  }));
  await writeFile(join(taskDir, "message.md"), "Fix the problem.\n");
  await writeFile(join(taskDir, "WHY.md"), "No shipped fix exists.\n");
  await writeFile(join(taskDir, "acceptance", "test.test.ts"), "");
  const design = parseCodingDesign({
    name: "preflight", tasks: [id], repeats: 1, model: "model", effort: "medium", authProfile: "Personal",
    treatments: { authored: "HEAD" }, roles: { "workflow-agent": { model: "model", effort: "medium" } },
  });
  const family = workflowAuthorshipFamily(design, tasksDir);
  for (const action of ["plan", "run"] as const) {
    await expect(family.loadTasks([id], { action, results: tasksDir, reservedEvaluation: false, keepSandboxes: false, dryRun: false }))
      .rejects.toThrow("missing-reference has neither reference.patch nor a fix commit in WHY.md");
  }
  await writeFile(join(taskDir, "reference.patch"), "reference");
  expect(await family.loadTasks([id], { action: "plan", results: tasksDir, reservedEvaluation: false, keepSandboxes: false, dryRun: false })).toHaveLength(1);
});
