import { describe, expect, test } from "bun:test";
import { codingLedger, requireWritableCodingCampaign, type CodingCampaign, type CodingEvent, type CodingOutcomeRecord } from "../../../bench/chat-ab/coding-ab-store.js";
import { campaignIdentity, campaignSchedule } from "../../../bench/chat-ab/campaign-store.js";
import { unavailableBenchmarkAccounting } from "../../../src/orchestration/modules/development/benchmark/evidence.js";
import { temporaryDirectories } from "../../helpers/directories.js";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { renderCodingReport } from "../../../bench/chat-ab/coding-ab-report.js";
import { campaignHeadlessOutcome } from "../../../bench/chat-ab/campaign-execution.js";
import type { HeadlessBenchmarkExecution } from "../../../src/orchestration/modules/development/benchmark/headless-execution-contract.js";
import { benchmarkInfrastructureIdentity } from "../../../bench/chat-ab/benchmark-infrastructure.js";
import { REPO_ROOT } from "../../../bench/chat-ab/harness-paths.js";
import { parseCodingDesign } from "../../../bench/chat-ab/coding-ab-design.js";

const temporary = temporaryDirectories();

const hash = "a".repeat(64);
const campaign: CodingCampaign = {
  kind: "coding-ab", version: 1, name: "trial", model: "model", effort: "low",
  authProfile: "Personal", profileId: "personal-id", authorityIncarnation: "authority", configIdentity: hash,
  infrastructureIdentity: hash,
  treatments: ["control", "candidate"].map((id) => ({ id, revision: id, sourceIdentity: hash, dependencyIdentity: hash, harnessIdentity: hash, engineIdentity: hash })),
  tasks: [{ id: "task", role: "development", contentIdentity: hash, qualificationIdentity: hash }],
  repeats: 2, createdAt: "now",
};
const cell = { treatment: "control", task: "task", repeat: 0 };
const attempt: CodingEvent = { kind: "attempt", attemptId: "first", cell, at: "now", directory: "cells/first" };
const historicalOutcome: CodingOutcomeRecord = {
  kind: "outcome", attemptId: "first", cell, at: "later", status: "completed", reason: null,
  wallMs: 10, accounting: unavailableBenchmarkAccounting("No usage was observed"),
  acceptance: { passed: 0, total: 1, allPass: false },
  workflow: { stages: ["implement", "review", "fix", "verify"], launches: 1, refusedLaunches: 0 },
  report: null, diff: null, evidence: [],
};

describe("coding campaign resume", () => {
  test("loads and reports the retained 78e10ad72 v2 ledger without rewriting its identity or evidence", async () => {
    const directory = temporary("coding-retained-v2-");
    const fixture = new URL("../../fixtures/coding-ab-v2/", import.meta.url);
    await cp(fixture, directory, { recursive: true });
    const originalManifest = await readFile(join(directory, "campaign.json"), "utf8");
    const originalEvents = await readFile(join(directory, "events.jsonl"), "utf8");
    const store = await codingLedger.open(directory);
    requireWritableCodingCampaign(store.manifest);
    const events = await store.load();
    expect(events).toEqual(JSON.parse(`[${originalEvents.trim().split("\n").join(",")}]`));
    expect(codingLedger.pending(store.manifest, events)).toEqual([]);
    const report = await renderCodingReport(directory);
    expect(report).toMatch(/\| control \| Flywheel [^|]+\| 1\/1 \| 0\/1 \|/);
    expect(report).toMatch(/\| candidate \| Flywheel [^|]+\| 1\/1 \| 0\/1 \|/);
    expect(report).toContain("| complete | 3/4 | 53/7 | 1 | 1 |");
    expect(report).toContain("| complete | 3/4 | 49/9 | 1 | 1 |");
    await codingLedger.open(directory, { ...store.manifest, createdAt: "later" });
    expect(await readFile(join(directory, "campaign.json"), "utf8")).toBe(originalManifest);
    expect(await readFile(join(directory, "events.jsonl"), "utf8")).toBe(originalEvents);
  });

  test("reopens durable evidence and refuses a changed campaign before append", async () => {
    const directory = temporary("coding-ab-");
    await writeFile(join(directory, "campaign.json"), JSON.stringify(campaign));
    const store = await codingLedger.open(directory, campaign);
    await writeFile(join(directory, "events.jsonl"), [attempt, historicalOutcome].map((event) => JSON.stringify(event)).join("\n") + "\n");
    const reopened = await codingLedger.open(directory);
    expect(await reopened.load()).toEqual([attempt, historicalOutcome]);
    await expect(codingLedger.open(directory, { ...campaign, model: "other" })).rejects.toThrow("identity changed");
    const report = await renderCodingReport(directory);
    expect(report).toContain("| control | Flywheel control | 1/2 | 0/1 |");
    expect(report).toContain("unavailable");
    expect(() => requireWritableCodingCampaign(store.manifest)).toThrow("read-only; start a new results directory");
    await expect(store.append(attempt)).rejects.toThrow("read-only");
  });

  test("reads version two execution evidence and refuses private manifest fields", async () => {
    const directory = temporary("coding-v2-");
    const manifest = {
      kind: "coding-ab" as const, version: 2 as const, name: "trial", model: "model", effort: "low",
      authProfile: "Personal", answers: "approve-root-workflow-launch" as const, infrastructureIdentity: hash,
      treatments: campaign.treatments.map(({ engineIdentity: _, ...treatment }) => ({ ...treatment, settingsIdentity: hash })),
      tasks: campaign.tasks, repeats: 2, createdAt: "now",
    };
    const store = await codingLedger.open(directory, manifest);
    await store.append(attempt);
    const accounting = unavailableBenchmarkAccounting("No usage");
    const result = {
      kind: "outcome" as const, version: 2 as const, attemptId: "first", cell, at: "later",
      status: "completed" as const, reason: null, runs: [{
        outcome: "input_required" as const, exitCode: 2, wallMs: 10, sessionId: "root", reason: null,
        evidence: { kind: "observed" as const, requestCount: 1, parentRequestCount: 1, childSessionCount: 0 }, artifacts: [],
      }, {
        outcome: "incomplete" as const, exitCode: 2, wallMs: 10, sessionId: "root", reason: null,
        evidence: { kind: "unavailable" as const, reason: "final reader failed" }, artifacts: [],
      }],
      accounting, parentAccounting: accounting, approvals: 0, acceptance: { tests: { task: "fail" as const }, passed: 0, total: 1, allPass: false }, report: null, diff: null,
    };
    await store.append(result);
    expect(await (await codingLedger.open(directory)).load()).toEqual([attempt, result]);
    expect(codingLedger.pending(manifest, [attempt, result])).not.toContainEqual(cell);
    const report = await renderCodingReport(directory);
    expect(report).toContain("| incomplete | 0/1 | unavailable | unavailable | 0 | unavailable / unavailable | unavailable / unavailable |");
    const privateManifest = { ...manifest, profileId: "private" };
    await expect(codingLedger.open(temporary("coding-private-"), privateManifest)).rejects.toThrow();
    await expect(store.append(historicalOutcome)).rejects.toThrow();
    await expect(store.append({ ...result, attemptId: "missing" })).rejects.toThrow("matching earlier attempt");
    await expect(store.append(result)).rejects.toThrow("Duplicate outcome");
    await expect(store.append({ ...attempt, attemptId: "second" })).rejects.toThrow("follows completed");
    const interrupted = { ...attempt, attemptId: "interrupted", cell: { ...cell, treatment: "candidate" } };
    await store.append(interrupted);
    await store.append(campaignHeadlessOutcome(directory, interrupted, [], 0, { acceptance: null, report: null, diff: null }));
    const resumed = await (await codingLedger.open(directory)).load();
    expect(codingLedger.pending(manifest, resumed)).toContainEqual(interrupted.cell);
    expect(resumed.at(-1)).toMatchObject({ status: "failed", reason: "attempt interrupted before outcome", runs: [], approvals: 0 });
  });

  test("decodes both subjects and retains external list accounting without canonical request evidence", async () => {
    const design = parseCodingDesign({ name: "trial", tasks: ["task"], repeats: 1, model: "claude-sonnet-5.5", effort: "medium", authProfile: "Personal",
      treatments: { control: "HEAD", candidate: { subject: "claude-code", model: "claude-sonnet-5-5", effort: "medium" } } });
    expect(design.treatments.candidate).toEqual({ subject: "claude-code", model: "claude-sonnet-5-5", effort: "medium" });
    expect(design.message).toBeUndefined();
    expect(parseCodingDesign({ ...design, message: "design" }).message).toBe("design");
    expect(() => parseCodingDesign({ ...design, message: "unknown" })).toThrow();
    expect(() => parseCodingDesign({ ...design, treatments: { control: { revision: "HEAD", message: "design" }, candidate: "HEAD" } })).toThrow();
    expect(parseCodingDesign({ ...design, treatments: { authored: "HEAD" } }).treatments).toEqual({ authored: "HEAD" });
    expect(() => parseCodingDesign({ ...design, treatments: {} })).toThrow("at least one treatment");
    const { authProfile: _authProfile, ...shared } = design;
    expect(parseCodingDesign(shared, "Flag").authProfile).toBe("Flag");
    expect(parseCodingDesign(design, "Flag").authProfile).toBe("Flag");
    expect(() => parseCodingDesign({ ...design, treatments: { ...design.treatments, candidate: { subject: "claude-code", revision: "HEAD" } } })).toThrow();
    const pinned = { "workflow-agent": { model: "claude-sonnet-5-5", effort: "medium" as const } };
    expect(parseCodingDesign({ ...design, treatments: { control: { revision: "HEAD", roles: pinned, disabledTools: ["subagent"] } } }).treatments.control).toEqual({ revision: "HEAD", roles: pinned, disabledTools: ["subagent"] });
    expect(() => parseCodingDesign({ ...design, treatments: { candidate: { subject: "claude-code", disabledTools: ["subagent"] } } })).toThrow();
    expect(() => parseCodingDesign({ ...design, treatments: { control: { revision: "HEAD", disabledTools: ["subagent", "subagent"] } } })).toThrow();
    expect(parseCodingDesign({ ...design, roles: pinned, treatments: { ...design.treatments, control: { revision: "HEAD", roles: { chat: { effort: "low" as const } } } } })).toMatchObject({ roles: pinned, treatments: { control: { roles: { chat: { effort: "low" } } } } });
    expect(() => parseCodingDesign({ ...design, treatments: { ...design.treatments, candidate: { subject: "claude-code", roles: pinned } } })).toThrow();
    expect(parseCodingDesign({ ...design, treatments: { ...design.treatments, candidate: { subject: "claude-code", plugin: "HEAD" } } }).treatments.candidate).toEqual({ subject: "claude-code", plugin: "HEAD" });
    expect(() => parseCodingDesign({ ...design, treatments: { ...design.treatments, candidate: { subject: "claude-code", plugin: "" } } })).toThrow();
    expect(() => parseCodingDesign({ ...design, treatments: { control: { revision: "HEAD", plugin: "HEAD" } } })).toThrow();
    expect(() => parseCodingDesign({ ...design, roles: { "workflow-agent": { model: "claude-sonnet-5-5", temperature: 1 } } })).toThrow();
    expect(parseCodingDesign({ ...design, treatments: { control: "HEAD", candidate: { revision: "HEAD", patches: ["bench/probe.patch"] } } }).treatments.candidate).toEqual({ revision: "HEAD", patches: ["bench/probe.patch"] });
    for (const path of ["/outside.patch", "src/change.patch", "bench/../outside.patch"]) {
      expect(() => parseCodingDesign({ ...design, treatments: { control: "HEAD", candidate: { revision: "HEAD", patches: [path] } } })).toThrow();
    }
    const directory = temporary("coding-subjects-");
    const external = { id: "candidate", subject: "claude-code" as const, binaryPath: "/scratch/claude", binarySha256: hash, binaryVersion: "2.1.296",
      model: "claude-sonnet-5-5", effort: "medium", settingsIdentity: hash };
    const manifest = { kind: "coding-ab" as const, version: 2 as const, name: "subjects", model: design.model, effort: design.effort,
      authProfile: "Personal", answers: "approve-root-workflow-launch" as const, infrastructureIdentity: hash, createdAt: "now", repeats: 1, tasks: campaign.tasks,
      treatments: [{ id: "control", revision: "revision", sourceIdentity: hash, dependencyIdentity: hash, harnessIdentity: hash, settingsIdentity: hash, roles: pinned, disabledTools: ["subagent"] }, external] };
    const store = await codingLedger.open(directory, manifest);
    expect((await codingLedger.open(directory)).manifest).toEqual(manifest);
    expect(campaignIdentity({ ...manifest, treatments: [{ ...manifest.treatments[0]!, disabledTools: ["web"] }, external] })).not.toBe(campaignIdentity(manifest));
    const plugged = temporary("coding-plugin-");
    const withPlugin = (identity: string) => ({ ...manifest, treatments: [manifest.treatments[0]!, { ...external, plugin: { revision: "revision", identity } }] });
    await codingLedger.open(plugged, withPlugin(hash));
    expect((await codingLedger.open(plugged)).manifest).toEqual(withPlugin(hash));
    await expect(codingLedger.open(plugged, withPlugin("b".repeat(64)))).rejects.toThrow("Campaign identity changed");
    const externalAttempt = { ...attempt, cell: { ...cell, treatment: "candidate" } };
    await store.append(externalAttempt);
    const accounting = { ...unavailableBenchmarkAccounting("not billed"), tokens: { kind: "observed" as const, value: 42 }, estimatedUsd: { kind: "observed" as const, value: 0.25 } };
    const outcome = campaignHeadlessOutcome(directory, externalAttempt, [{
      version: 1, outcome: "complete", exitCode: 0, wallMs: 1, sessionId: "root", models: ["claude-sonnet-5-5"],
      evidence: { kind: "unavailable", reason: "external" }, totalAccounting: accounting, parentAccounting: unavailableBenchmarkAccounting("no parent split"), artifacts: {},
    }], 0, { acceptance: null, report: null, diff: null });
    await store.append(outcome);
    expect(outcome.accounting).toEqual(accounting);
    expect(outcome.runs[0]?.models).toEqual(["claude-sonnet-5-5"]);
    const report = await renderCodingReport(directory);
    expect(report).toContain(`Claude Code 2.1.296 (${hash})`);
    expect(report).toContain("unavailable | unavailable | 0 | $0.2500 / unavailable | unavailable / unavailable");
  });

  test("settles an interrupted attempt without inventing accounting and takes only the final run's cumulative usage", () => {
    if (attempt.kind !== "attempt") throw new Error("Expected attempt");
    const artifacts = { acceptance: null, report: null, diff: null };
    const interrupted = campaignHeadlessOutcome("/scratch", attempt, [], 0, artifacts);
    expect(interrupted.status).toBe("failed");
    expect(interrupted.reason).toBe("attempt interrupted before outcome");
    expect(interrupted.accounting.estimatedUsd.kind).toBe("unavailable");
    const run = (value: number, executionOutcome: "input_required" | "complete"): HeadlessBenchmarkExecution => ({
      version: 1, outcome: executionOutcome, exitCode: 0, wallMs: 1, sessionId: "root",
      evidence: { kind: "observed", value: {
        version: 2, rootSessionId: "root", projectRoot: "/scratch", descendantDiscovery: "current-metadata", metadataGaps: [],
        sessions: [], accounting: { usage: "unavailable", price: "estimate", providerInvoicedCost: "unavailable" },
      }, requestCount: value, parentRequestCount: 1, childSessionCount: value - 1 },
      totalAccounting: { ...unavailableBenchmarkAccounting("not billed"), estimatedUsd: { kind: "observed", value } },
      parentAccounting: { ...unavailableBenchmarkAccounting("not billed"), estimatedUsd: { kind: "observed", value: value / 2 } },
      artifacts: {},
    });
    const first = run(1, "input_required");
    const second = run(3, "complete");
    const final = { ...second, evidence: { kind: "unavailable" as const, reason: "reader failed" }, totalAccounting: unavailableBenchmarkAccounting("reader failed"), parentAccounting: unavailableBenchmarkAccounting("reader failed") };
    const captured = campaignHeadlessOutcome("/scratch", attempt, [first, second, final], 2, artifacts);
    expect(captured.status).toBe("completed");
    expect(captured.runs.map(({ outcome }) => outcome)).toEqual(["input_required", "complete", "complete"]);
    expect(captured.accounting).toEqual(final.totalAccounting);
    expect(captured.parentAccounting).toEqual(final.parentAccounting);
    expect(captured.approvals).toBe(2);
    const questionArtifacts = new Map([[0, { questions: { path: "/scratch/cells/first/artifacts/run-0/questions.jsonl", sha256: hash, bytes: 12 } }]]);
    const failedCapture = campaignHeadlessOutcome("/scratch", attempt, [first, second], 2, artifacts, true, questionArtifacts);
    expect(failedCapture.status).toBe("failed");
    expect(failedCapture.reason).toBe("cell controller or capture failed");
    expect(failedCapture.runs.map(({ artifacts: _, ...execution }) => execution)).toEqual(
      captured.runs.slice(0, 2).map(({ artifacts: _, ...execution }) => execution),
    );
    expect(failedCapture.runs.map(({ artifacts: evidenceArtifacts }) => evidenceArtifacts)).toEqual([
      [{ path: "cells/first/artifacts/run-0/questions.jsonl", sha256: hash }], [],
    ]);
    expect(failedCapture.accounting).toEqual(second.totalAccounting);
    expect(failedCapture.parentAccounting).toEqual(second.parentAccounting);
    const manifest: CodingCampaign = {
      kind: "coding-ab", version: 2, name: "trial", model: "model", effort: "low",
      authProfile: "Personal", answers: "approve-root-workflow-launch", infrastructureIdentity: hash,
      treatments: campaign.treatments.map(({ engineIdentity: _, ...treatment }) => ({ ...treatment, settingsIdentity: hash })),
      tasks: campaign.tasks, repeats: 2, createdAt: "now",
    };
    expect(codingLedger.pending(manifest, [attempt, failedCapture])).toContainEqual(cell);
    expect(campaignHeadlessOutcome("/scratch", attempt, [{ ...final, outcome: "incomplete" }], 0, artifacts).status).toBe("completed");
    expect(campaignHeadlessOutcome("/scratch", attempt, [{ ...final, outcome: "failed" }], 0, artifacts).status).toBe("failed");
  });

  test("rotates treatment order and keeps poor-quality completed work out of pending work", () => {
    expect(campaignSchedule(campaign).map(({ treatment }) => treatment)).toEqual(["control", "candidate", "candidate", "control"]);
    expect(codingLedger.pending(campaign, [attempt, historicalOutcome])).toHaveLength(3);
    expect(codingLedger.pending(campaign, [attempt, historicalOutcome])).not.toContainEqual(cell);
  });

  test("retries execution failure without forgetting the failed attempt", () => {
    const events: CodingEvent[] = [attempt, { ...historicalOutcome, status: "failed", reason: "worker crashed" }];
    expect(codingLedger.pending(campaign, events)).toContainEqual(cell);
    expect(codingLedger.validate(campaign, events).settled.size).toBe(1);
    expect(codingLedger.pending(campaign, [attempt])).toContainEqual(cell);
  });

  test("refuses outcomes without an earlier matching attempt and duplicate completion", () => {
    expect(() => codingLedger.validate(campaign, [historicalOutcome])).toThrow("matching earlier attempt");
    expect(() => codingLedger.validate(campaign, [attempt, historicalOutcome, historicalOutcome])).toThrow("Duplicate outcome");
    expect(() => codingLedger.validate(campaign, [attempt, historicalOutcome, { ...attempt, attemptId: "again" }])).toThrow("follows completed");
    expect(() => codingLedger.validate(campaign, [{ ...attempt, cell: { ...cell, task: "foreign" } }])).toThrow("unscheduled");
  });

  test("pins source, task, model, profile, and authority independently of creation time", () => {
    expect(campaignIdentity({ ...campaign, createdAt: "tomorrow" })).toBe(campaignIdentity(campaign));
    for (const changed of [
      { ...campaign, model: "different" },
      { ...campaign, profileId: "different" },
      { ...campaign, authorityIncarnation: "different" },
      { ...campaign, infrastructureIdentity: "b".repeat(64) },
      { ...campaign, treatments: campaign.treatments.map((source) => ({ ...source, sourceIdentity: "b".repeat(64) })) },
      { ...campaign, tasks: campaign.tasks.map((task) => ({ ...task, contentIdentity: "b".repeat(64) })) },
    ]) expect(campaignIdentity(changed)).not.toBe(campaignIdentity(campaign));
  });
});

test("pins adapter bytes and decoded protocol contracts in controller infrastructure identity", async () => {
  const root = temporary("coding-infrastructure-");
  for (const path of ["src/infra", "src/cli", "scripts", "src/orchestration"]) await mkdir(join(root, path), { recursive: true });
  for (const path of ["package.json", "bun.lock", "scripts/source-cli.ts", "src/orchestration/module-catalog.ts"]) {
    await cp(join(REPO_ROOT, path), join(root, path));
  }
  const benchmark = "src/orchestration/modules/development/benchmark";
  await cp(join(REPO_ROOT, benchmark), join(root, benchmark), { recursive: true });
  await cp(join(REPO_ROOT, "src/protocol"), join(root, "src/protocol"), { recursive: true });
  for (const path of ["bench/chat-ab/results", "bench/shared", "bench/tasks"]) await mkdir(join(root, path), { recursive: true });
  await writeFile(join(root, "bench/chat-ab/campaign-runner.ts"), "controller harness");
  const before = await benchmarkInfrastructureIdentity(root);
  await writeFile(join(root, benchmark, "headless-execution.ts"), "changed adapter bytes");
  const adapterChanged = await benchmarkInfrastructureIdentity(root);
  expect(adapterChanged).not.toBe(before);
  await writeFile(join(root, benchmark, "claude-code-execution.ts"), "changed Claude Code adapter bytes");
  const claudeChanged = await benchmarkInfrastructureIdentity(root);
  expect(claudeChanged).not.toBe(adapterChanged);
  await writeFile(join(root, "bench/chat-ab/campaign-runner.ts"), "changed controller harness");
  const harnessChanged = await benchmarkInfrastructureIdentity(root);
  expect(harnessChanged).not.toBe(claudeChanged);
  await writeFile(join(root, "bench/chat-ab/results/result.json"), "new result");
  expect(await benchmarkInfrastructureIdentity(root)).toBe(harnessChanged);
  await writeFile(join(root, "src/protocol/headless-chat.ts"), "changed protocol bytes");
  expect(await benchmarkInfrastructureIdentity(root)).not.toBe(harnessChanged);
});
