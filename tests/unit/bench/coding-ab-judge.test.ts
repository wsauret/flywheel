import { expect, test } from "bun:test";
import { mkdir, readFile, readdir, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { judgeCodingCampaign } from "../../../bench/chat-ab/coding-ab-judge.js";
import { codingLedger, type CodingCampaign, type CodingOutcomeRecord } from "../../../bench/chat-ab/coding-ab-store.js";
import { renderCodingReport } from "../../../bench/chat-ab/coding-ab-report.js";
import { findCodingTask } from "../../../bench/chat-ab/coding-task.js";
import type { ChatAbJudge } from "../../../bench/chat-ab/pair-judge.js";
import { unavailableBenchmarkAccounting } from "../../../src/orchestration/modules/development/benchmark/evidence.js";
import { JudgeCallFailure, type JudgeModel } from "../../../src/orchestration/modules/development/benchmark/judge.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const temporary = temporaryDirectories();
const hash = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
const accounting = { ...unavailableBenchmarkAccounting("not billed"), estimatedUsd: { kind: "observed", value: 0.2 } as const };
const taskId = "config-lock-first-write";

async function fixture(treatments: readonly string[] = ["before", "after"], version: 1 | 2 = 1, executionOutcome: "complete" | "input_required" | "incomplete" = "complete", overrideModel?: string) {
  const directory = temporary("coding-judge-");
  const task = (await findCodingTask(taskId))!;
  const identity = "a".repeat(64);
  const historical: CodingCampaign = {
    kind: "coding-ab", version: 1, name: "judge-test", model: "claude-opus-5-5", effort: "high",
    authProfile: "Personal", profileId: "candidate-profile", authorityIncarnation: "candidate-authority", configIdentity: identity,
    infrastructureIdentity: identity,
    treatments: treatments.map((id) => ({ id, revision: id, sourceIdentity: identity, dependencyIdentity: identity, harnessIdentity: identity, engineIdentity: identity })),
    tasks: [{ id: task.id, role: task.role, contentIdentity: task.contentIdentity, qualificationIdentity: task.qualificationIdentity }],
    repeats: 2, createdAt: "now",
  };
  const manifest: CodingCampaign = version === 1 ? historical : {
    kind: "coding-ab", version: 2, name: historical.name, model: historical.model, effort: historical.effort,
    authProfile: historical.authProfile, answers: "approve-root-workflow-launch", infrastructureIdentity: identity,
    treatments: historical.treatments.map(({ engineIdentity: _, ...source }) => overrideModel && source.id === "after"
      ? { id: source.id, subject: "claude-code" as const, binaryPath: "/scratch/claude", binarySha256: identity, binaryVersion: "2.1.296", model: overrideModel, effort: "high", settingsIdentity: identity }
      : { ...source, settingsIdentity: identity }),
    tasks: historical.tasks, repeats: historical.repeats, createdAt: historical.createdAt,
  };
  if (version === 1) await writeFile(join(directory, "campaign.json"), JSON.stringify(manifest));
  const store = await codingLedger.open(directory, manifest);
  const events = [];
  for (const treatment of treatments) {
    const cell = { treatment, task: task.id, repeat: 0 };
    const attempt = { kind: "attempt" as const, attemptId: treatment, cell, at: "now", directory: treatment };
    if (version === 2) await store.append(attempt);
    else events.push(attempt);
    const report = `${treatment}-report.txt`;
    const diff = `${treatment}-diff.txt`;
    const selectedModel = overrideModel ? treatment === "after" ? overrideModel : "claude-sonnet-5-5" : manifest.model;
    const summary = `Claude Code used ${selectedModel} .flywheel/sessions/private ${treatment}-role-model later-role-model lost-role-model`;
    const planPath = `${treatment}/plan.json`;
    await mkdir(join(directory, treatment));
    const plan = JSON.stringify({
      sessionId: treatment, profile: { persistedId: "Personal", effectiveId: "Personal" },
      assignments: [{ slot: { kind: "role", roleId: "chat" }, label: "Chat", model: selectedModel, effort: "high", modelSource: "explicit", matchesInheritedPair: false }],
      plans: [{ kind: "available", model: selectedModel, candidates: [{ kind: "singleton", providerId: "second", spendMode: "direct_api", wireModelId: selectedModel }] }],
    });
    await writeFile(join(directory, planPath), plan);
    const planArtifact = { path: planPath, sha256: hash(plan) };
    const roles = JSON.stringify({ "workflow-agent": { model: `${treatment}-role-model`, effort: "high" } });
    const laterRoles = JSON.stringify({ "workflow-agent": { model: "later-role-model", effort: "low" } });
    await mkdir(join(directory, treatment, "later"));
    await writeFile(join(directory, treatment, "roles.json"), roles);
    await writeFile(join(directory, treatment, "later", "roles.json"), laterRoles);
    await writeFile(join(directory, report), version === 1 ? summary : JSON.stringify({ summary }));
    await writeFile(join(directory, diff), `diff --git a/file.ts b/file.ts\n+const value = ${treatment === "before" ? 1 : 2};`);
    const historicalOutcome: CodingOutcomeRecord = {
      kind: "outcome", attemptId: treatment, cell, at: "later", status: "completed", reason: null, wallMs: 10,
      accounting, acceptance: { passed: 0, total: 1, allPass: false },
      workflow: { stages: ["implement"], launches: 1, refusedLaunches: 0 }, evidence: [planArtifact],
      report: { path: report, sha256: hash(await readFile(join(directory, report), "utf8")) },
      diff: { path: diff, sha256: hash(await readFile(join(directory, diff), "utf8")) },
    };
    const outcome: CodingOutcomeRecord = version === 1 ? historicalOutcome : {
      kind: "outcome", version: 2, attemptId: treatment, cell, at: "later", status: "completed", reason: null,
      runs: [
        { outcome: executionOutcome, exitCode: 0, wallMs: 10, sessionId: treatment, reason: null, models: ["lost-role-model"], evidence: { kind: "unavailable", reason: "No evidence" }, artifacts: [planArtifact, { path: `${treatment}/roles.json`, sha256: hash(roles) }, { path: `${treatment}/workflow-roles.json`, sha256: hash("lost") }] },
        { outcome: executionOutcome, exitCode: 0, wallMs: 10, sessionId: treatment, reason: null, models: [selectedModel], evidence: { kind: "unavailable", reason: "No evidence" }, artifacts: [{ path: `${treatment}/later/roles.json`, sha256: hash(laterRoles) }] },
      ],
      accounting, parentAccounting: accounting, approvals: 1, acceptance: { tests: { [taskId]: "fail" as const }, passed: 0, total: 1, allPass: false },
      report: executionOutcome === "complete" ? historicalOutcome.report : null, diff: historicalOutcome.diff,
    };
    if (version === 2) await store.append(outcome);
    else events.push(outcome);
  }
  if (version === 1) await writeFile(join(directory, "events.jsonl"), events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  return { directory, options: { directory, a: "before", b: "after", authProfile: "Personal" }, manifest };
}

function admitted(model: JudgeModel, authorityIncarnation = "judge-authority"): ChatAbJudge {
  return { model, profileId: "judge-profile", authorityIncarnation, run: async () => { throw new Error("No commands"); }, [Symbol.asyncDispose]: async () => {} };
}
const tie: JudgeModel = { async complete() { return { text: '{"correctA":"partial","correctB":"no","winner":"tie","rationale":"Both incomplete"}', accounting }; } };
const judgeLedger = async (directory: string) => join(directory, (await readdir(directory)).find((name) => name.startsWith("judge-") && name.endsWith(".jsonl"))!);

test("judges version two handoff and diff artifacts without requiring private runner evidence", async () => {
  const { options, directory } = await fixture(["before", "after"], 2);
  const prompts: string[] = [];
  const model: JudgeModel = { async complete(prompt, signal) { prompts.push(prompt); return tie.complete(prompt, signal); } };
  const result = await judgeCodingCampaign(options, { admit: async () => admitted(model) });
  expect(result.judged).toBe(1);
  expect(prompts[0]).toContain('"summary"');
  expect(prompts[0]).toContain("const value");
  expect(prompts.join("\n")).not.toMatch(/before-role-model|after-role-model|later-role-model|lost-role-model/);
  expect(result.roleComparisons[0]?.changes).toContainEqual({ kind: "normal", role: "workflow-agent", before: { model: "before-role-model", effort: "high" }, after: { model: "after-role-model", effort: "high" } });
  expect(await renderCodingReport(directory)).toContain("before-role-model / high");
});

test("keeps execution without a handoff completed but does not invent a handoff report for judging", async () => {
  for (const outcome of ["input_required", "incomplete"] as const) {
    const { options } = await fixture(["before", "after"], 2, outcome);
    const result = await judgeCodingCampaign({ ...options, dryRun: true }, { admit: async () => { throw new Error("No admission"); } });
    expect(result.pairs).toBe(0);
    expect(result.skipped[0]?.reason).toBe(`${outcome} has no accepted handoff report`);
  }
});

test("dry-run includes poor acceptance pairs and exact missing-completion reasons without admission or writes", async () => {
  const { directory, options } = await fixture();
  const before = await readdir(directory);
  const summary = await judgeCodingCampaign({ ...options, dryRun: true }, { admit: async () => { throw new Error("Dry run admitted"); } });
  expect(summary.pairs).toBe(1);
  expect(summary.pending).toBe(1);
  expect(summary.authorityVerified).toBe(false);
  expect(summary.skipped).toEqual([{ task: taskId, repeat: 1, reason: "both treatments need completed execution" }]);
  expect(await readdir(directory)).toEqual(before);
});

test("judges blinded changes in both orders with refutation and reuses only the same usage authority", async () => {
  const { directory, options } = await fixture(undefined, 2, "complete", "gpt-6.1-sol");
  let calls = 0;
  const prompts: string[] = [];
  const model: JudgeModel = { async complete(prompt) {
    prompts.push(prompt);
    calls++;
    const text = calls % 2 === 0 ? '{"refuted":false,"reason":"No counterexample"}' : JSON.stringify({ correctA: "yes", correctB: "partial", winner: calls % 4 === 1 ? "A" : "B", rationale: "One fixes the path" });
    return { text, accounting };
  } };
  const deps = { admit: async () => admitted(model) };
  const first = await judgeCodingCampaign(options, deps);
  expect(prompts.join("\n")).not.toMatch(/Claude Code|claude-(?:opus|sonnet)-5-5|gpt-6[.-]1-sol|\.flywheel\/sessions/i);
  expect(first.wins.before).toBe(1);
  expect(first.accounting.judge).toHaveLength(4);
  const resumed = await judgeCodingCampaign(options, deps);
  expect(resumed.judged).toBe(1);
  expect(calls).toBe(4);
  await expect(judgeCodingCampaign(options, { admit: async () => admitted(model, "replacement-authority") })).rejects.toThrow("authority changed");
  await expect(judgeCodingCampaign(options, { admit: async () => ({ ...admitted(model), profileId: "replacement-profile" }) })).rejects.toThrow("authority changed");
  expect(calls).toBe(4);
  const rows = (await readFile(await judgeLedger(directory), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  expect(rows.filter((row) => row.kind === "pair").map((row) => row.authorityIncarnation)).toEqual(["judge-authority"]);
});

test.each(["changed", "no-model"] as const)("refuses %s treatment model evidence before judge admission", async (problem) => {
  const { directory, options } = await fixture(undefined, 2);
  const path = join(directory, "before", "plan.json");
  const ledgerPath = join(directory, "events.jsonl");
  const rows = (await readFile(ledgerPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  {
    const plan = JSON.parse(await readFile(path, "utf8"));
    if (problem === "no-model") plan.assignments = [];
    else plan.sessionId = "changed";
    const text = JSON.stringify(plan);
    await writeFile(path, text);
    if (problem === "no-model") rows[1].runs[0].artifacts[0].sha256 = hash(text);
  }
  await writeFile(ledgerPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  await expect(judgeCodingCampaign(options, { admit: async () => { throw new Error("Must not admit"); } })).rejects.toThrow(/before.*plan\.json/);
});

test("blinds durable invocation models when an optional plan artifact is missing", async () => {
  const { directory, options } = await fixture(undefined, 2);
  await unlink(join(directory, "before", "plan.json"));
  const prompts: string[] = [];
  const result = await judgeCodingCampaign(options, { admit: async () => admitted({ async complete(prompt, signal) {
    prompts.push(prompt);
    return tie.complete(prompt, signal);
  } }) });
  expect(result.judged).toBe(1);
  expect(prompts.join("\n")).not.toContain("lost-role-model");
});

test("keeps ordered comparisons distinct when treatment names contain hyphens", async () => {
  const { directory, options } = await fixture(["a-b", "c", "a", "b-c"]);
  const deps = { admit: async () => admitted(tie) };
  expect((await judgeCodingCampaign({ ...options, a: "a-b", b: "c" }, deps)).ties).toBe(1);
  expect((await judgeCodingCampaign({ ...options, a: "a", b: "b-c" }, deps)).ties).toBe(1);
  expect((await readdir(directory)).filter((name) => name.startsWith("judge-"))).toHaveLength(2);
});

test("keeps a judgement from changed judge inputs as history and judges the pair again", async () => {
  const { directory, options } = await fixture();
  const campaignBefore = await readFile(join(directory, "campaign.json"));
  const eventsBefore = await readFile(join(directory, "events.jsonl"));
  await judgeCodingCampaign(options, { admit: async () => admitted(tie) });
  const path = await judgeLedger(directory);
  const rows = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const recordedIdentity = "b".repeat(64);
  rows.find((row) => row.kind === "pair").identity = recordedIdentity;
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const before = await readFile(path);
  const report = await judgeCodingCampaign({ ...options, dryRun: true }, { admit: async () => { throw new Error("Must not admit"); } });
  expect(report.judged).toBe(0);
  expect(report.pending).toBe(1);
  expect(report.recordedJudgements).toMatchObject([{ identity: recordedIdentity, pair: `before/after/${taskId}/0`, result: { winner: "tie" } }]);
  expect(await readFile(path)).toEqual(before);

  const rejudged = await judgeCodingCampaign(options, { admit: async () => admitted(tie) });
  expect(rejudged.judged).toBe(1);
  expect(rejudged.pending).toBe(0);
  expect(rejudged.recordedJudgements.map(({ identity }) => identity)).toEqual([recordedIdentity, expect.not.stringMatching(recordedIdentity)]);
  expect((await readFile(path, "utf8")).startsWith(before.toString())).toBe(true);
  expect(await readFile(join(directory, "campaign.json"))).toEqual(campaignBefore);
  expect(await readFile(join(directory, "events.jsonl"))).toEqual(eventsBefore);
});

test("failed and unparsable calls retain observed and unavailable spend across retries", async () => {
  const { options } = await fixture();
  let calls = 0;
  const first = await judgeCodingCampaign(options, { admit: async () => admitted({ async complete() {
    if (calls++ === 0) throw new JudgeCallFailure(accounting, "Provider stopped");
    return { text: "not JSON", accounting: unavailableBenchmarkAccounting("No usage observed") };
  } }) });
  expect(first.pending).toBe(1);
  expect(first.unsettled).toBe(1);
  expect(first.accounting.judge).toHaveLength(2);
  expect(first.accounting.judge[0]!.estimatedUsd).toEqual({ kind: "observed", value: 0.2 });
  expect(first.accounting.judge[1]!.estimatedUsd.kind).toBe("unavailable");
  const retried = await judgeCodingCampaign(options, { admit: async () => admitted(tie) });
  expect(retried.ties).toBe(1);
  expect(retried.accounting.judge).toHaveLength(4);
});

test("refuses changed bytes, task identity, and symlink escapes before provider admission", async () => {
  const { directory, options, manifest } = await fixture();
  const deps = { admit: async () => { throw new Error("Must not admit"); } };
  const report = join(directory, "before-report.txt");
  const original = await readFile(report, "utf8");
  await writeFile(report, "changed");
  await expect(judgeCodingCampaign(options, deps)).rejects.toThrow("hash changed");
  await writeFile(report, original);
  await writeFile(join(directory, "campaign.json"), JSON.stringify({ ...manifest, tasks: manifest.tasks.map((task) => ({ ...task, contentIdentity: "b".repeat(64) })) }));
  await expect(judgeCodingCampaign(options, deps)).rejects.toThrow("task identity changed");
  await writeFile(join(directory, "campaign.json"), JSON.stringify(manifest));
  const outside = temporary("coding-judge-outside-");
  await writeFile(join(outside, "diff.txt"), "outside");
  await symlink(join(outside, "diff.txt"), join(directory, "escape.txt"));
  const ledgerPath = join(directory, "events.jsonl");
  const rows = (await readFile(ledgerPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  rows[1].diff = { path: "escape.txt", sha256: hash("outside") };
  await writeFile(ledgerPath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  await expect(judgeCodingCampaign(options, deps)).rejects.toThrow("escapes campaign");
});

test("validates the complete stored paid-call graph before admission and refuses fabricated verdicts", async () => {
  const { directory, options } = await fixture();
  await judgeCodingCampaign(options, { admit: async () => admitted(tie) });
  const path = await judgeLedger(directory);
  const original = await readFile(path, "utf8");
  const rows = original.trim().split("\n").map((line) => JSON.parse(line));
  rows.at(-1).result.winner = "claude-code";
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const deps = { admit: async () => { throw new Error("Must not admit"); } };
  await expect(judgeCodingCampaign(options, deps)).rejects.toThrow("disagrees with paid call");
  await writeFile(path, original + '{"kind":"settlement","id":"orphan","at":"now","text":"","error":null,"accounting":' + JSON.stringify(accounting) + '}\n');
  await expect(judgeCodingCampaign(options, deps)).rejects.toThrow("no open call");
});

test("does not make another paid call when durable settlement storage fails", async () => {
  const { directory, options } = await fixture();
  let calls = 0;
  let path = "";
  await expect(judgeCodingCampaign(options, { admit: async () => admitted({ async complete() {
    calls++;
    path = await judgeLedger(directory);
    await rename(path, `${path}.saved`);
    await mkdir(path);
    return { text: '{"correctA":"yes","correctB":"no","winner":"A","rationale":"One fixes it"}', accounting };
  } }) })).rejects.toThrow();
  expect(calls).toBe(1);
  const rows = (await readFile(`${path}.saved`, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  expect(rows.map((row) => row.kind)).toEqual(["pair", "call"]);
});
