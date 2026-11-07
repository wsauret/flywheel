import { expect, test } from "bun:test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { judgeBlocks } from "../../../bench/chat-ab/block-judge.js";
import { judgeWorkflowAuditCampaign } from "../../../bench/chat-ab/workflow-audit-judge.js";
import { loadWorkflowAuditTasks, workflowAuditGrade, workflowAuditSites } from "../../../bench/chat-ab/workflow-audit-family.js";
import { workflowAuditLedger } from "../../../bench/chat-ab/workflow-audit-store.js";
import { answerReference, SHIPPED_SITES } from "../../../bench/chat-ab/workflow-audit-tests.js";
import { renderWorkflowAuditReport } from "../../../bench/chat-ab/workflow-audit-report.js";
import { unavailableBenchmarkAccounting } from "../../../src/orchestration/modules/development/benchmark/evidence.js";
import type { JudgeModel } from "../../../src/orchestration/modules/development/benchmark/judge.js";
import type { ExecutionEvidence } from "../../../src/protocol/execution-evidence.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const temporary = temporaryDirectories();
// A report names a shipped site by the first line of each site, wherever the fixture puts it.
const parserSite = `json-parse.ts:${SHIPPED_SITES[0]!.lines[0]}`;
const completionsSite = `openai-completions.ts:${SHIPPED_SITES[1]!.lines[0]}`;
const hash = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");
const accounting = { ...unavailableBenchmarkAccounting("no billed evidence"), estimatedUsd: { kind: "observed", value: 0.2 } as const };

async function fixture(ids: readonly string[] = ["test1", "test2"], repeats = 1, flywheelIds = ["control"]) {
  const directory = temporary("audit-judge-");
  const tasks = await loadWorkflowAuditTasks(ids);
  const identity = "a".repeat(64);
  const store = await workflowAuditLedger.open(directory, {
    kind: "workflow-audit", version: 2, name: "audit", model: "claude-sonnet-5-5", effort: "medium",
    authProfile: "Personal", answers: "approve-root-workflow-launch", infrastructureIdentity: identity,
    repeats, createdAt: "now", tasks: tasks.map(({ id, contentIdentity }) => ({ id, contentIdentity })),
    treatments: [
      ...flywheelIds.map(id => ({ id, revision: "source", sourceIdentity: identity, dependencyIdentity: identity, harnessIdentity: identity, settingsIdentity: identity })),
      { id: "candidate", subject: "claude-code", binaryPath: "/claude", binarySha256: identity, binaryVersion: "test", model: "claude-sonnet-5-5", effort: "medium", settingsIdentity: identity },
    ],
  });
  for (const treatment of [...flywheelIds, "candidate"]) {
    const cell = { treatment, task: tasks[0]!.id, repeat: 0 };
    const report = `${treatment}.json`;
    const handoff = { summary: `${treatment === "control" ? `${parserSite} completes a cut prefix` : "No findings"} ${treatment}-role-model later-role-model lost-role-model`, other: `${completionsSite} is wrong` };
    await mkdir(join(directory, treatment, "later"), { recursive: true });
    const roles = JSON.stringify({ "workflow-agent": { model: `${treatment}-role-model`, effort: "high" } });
    const laterRoles = JSON.stringify({ "workflow-agent": { model: "later-role-model", effort: "low" } });
    await writeFile(join(directory, treatment, "roles.json"), roles);
    await writeFile(join(directory, treatment, "later", "roles.json"), laterRoles);
    await writeFile(join(directory, report), JSON.stringify(handoff));
    await store.append({ kind: "attempt", attemptId: treatment, cell, at: "now", directory: treatment });
    await store.append({
      kind: "outcome", version: 2, attemptId: treatment, cell, at: "later", status: "completed", reason: null,
      runs: [
        { outcome: "complete", exitCode: 0, wallMs: 1000, sessionId: treatment, reason: null, models: ["lost-role-model"], evidence: { kind: "unavailable", reason: "Not recorded" }, artifacts: [{ path: `${treatment}/roles.json`, sha256: hash(roles) }, { path: `${treatment}/workflow-roles.json`, sha256: hash("lost") }] },
        { outcome: "complete", exitCode: 0, wallMs: 1000, sessionId: treatment, reason: null, evidence: { kind: "unavailable", reason: "Not recorded" }, artifacts: [{ path: `${treatment}/later/roles.json`, sha256: hash(laterRoles) }] },
      ],
      accounting, parentAccounting: accounting, approvals: 0, sites: workflowAuditSites(tasks[0]!, handoff), diff: null,
      report: { path: report, sha256: hash(JSON.stringify(handoff)) },
    });
  }
  return { directory, options: { directory, a: "control", b: "candidate", authProfile: "Personal" } };
}

test("audit dry-run validates retained answers and missing pairs without admission or writes", async () => {
  const { directory, options } = await fixture();
  const before = await readdir(directory);
  const result = await judgeWorkflowAuditCampaign({ ...options, dryRun: true }, { admit: async () => { throw new Error("No admission"); } });
  expect(result.pending).toBe(1);
  expect(result.skipped).toEqual([{ task: "test2", repeat: 0, reason: "both treatments need completed execution" }]);
  expect(await readdir(directory)).toEqual(before);
  const report = await renderWorkflowAuditReport(directory);
  expect(report).toContain("Claude Code test");
  expect(report).toContain("1/2");
  expect(report).toContain("unavailable");
  expect(report).toContain("| test1 | control | 1/1 | 2.0 | $0.2000 | 2/2 | unavailable | unavailable | unavailable |");
  expect(report).toContain("| test2 | candidate | 0/1 | unavailable | unavailable | unavailable | unavailable | unavailable | unavailable |");
  expect(report).toContain("Flywheel time / Claude Code time: unavailable.");
  expect(result.roleComparisons[0]?.changes).toHaveLength(1);
  expect(report).toContain("control-role-model / high");
  expect(report).toContain("candidate-role-model / high");
  await writeFile(join(directory, "control.json"), '{"summary":"changed"}');
  await expect(judgeWorkflowAuditCampaign({ ...options, dryRun: true })).rejects.toThrow("Artifact hash changed");
});

test("audit judges each whole handoff answer in both slot orders with refutation and resumes a/b verdicts", async () => {
  const { directory, options } = await fixture();
  let calls = 0;
  const model: JudgeModel = { async complete(prompt) {
    expect(prompt).toContain(completionsSite);
    expect(prompt).not.toMatch(/control-role-model|candidate-role-model|later-role-model|lost-role-model/);
    calls++;
    return { text: calls % 2 === 0 ? '{"refuted":false,"reason":"Evidence holds"}' : JSON.stringify({ correctA: "yes", correctB: "no", winner: calls === 1 ? "A" : "B", rationale: "The parser site is real" }), accounting };
  } };
  const dependencies = { admit: async () => ({ model, profileId: "judge", authorityIncarnation: "authority", [Symbol.asyncDispose]: async () => {} }) };
  const result = await judgeWorkflowAuditCampaign(options, dependencies);
  expect(result.wins.control).toBe(1);
  expect(result.recordedJudgements[0]?.result.orders.map(({ slotA }) => slotA)).toEqual(["a", "b"]);
  expect(result.recordedJudgements[0]?.result.sites.a).toEqual(workflowAuditGrade({ summary: parserSite, other: completionsSite }));
  expect(result.accounting.judge).toHaveLength(4);
  expect((await judgeWorkflowAuditCampaign(options, dependencies)).judged).toBe(1);
  expect(calls).toBe(4);
  const ledger = (await readdir(directory)).find((entry) => entry.startsWith("judge-"))!;
  expect(await readFile(join(directory, ledger), "utf8")).toContain('"winner":"a"');
});

test("answer tests are judged against their own reference answer, with no shipped fix and no site grade", async () => {
  const { directory, options } = await fixture(["test4"]);
  const report = await renderWorkflowAuditReport(directory);
  expect(report).toContain("| control | test4 | 0 | complete | not graded | 0 |");
  expect(report).toMatch(/\| 1\/1 \| not graded \|/);
  const prompts: string[] = [];
  const model: JudgeModel = { async complete(prompt) {
    prompts.push(prompt);
    return { text: prompts.length % 2 === 0 ? '{"refuted":false,"reason":"Claims hold"}' : JSON.stringify({ correctA: "yes", correctB: "partial", winner: "A", rationale: "A traces every wire" }), accounting };
  } };
  const result = await judgeWorkflowAuditCampaign(options, { admit: async () => ({ model, profileId: "judge", authorityIncarnation: "authority", [Symbol.asyncDispose]: async () => {} }) });
  expect(result.judged).toBe(1);
  expect(result.recordedJudgements[0]?.result.sites).toEqual({ a: {}, b: {} });
  expect(prompts).toHaveLength(4);
  const [understand] = await loadWorkflowAuditTasks(["test4"]);
  for (const prompt of prompts) {
    expect(prompt).toContain("## Reference answer (known good, for checking claims only)");
    expect(prompt).toContain(await answerReference("test4"));
    expect(prompt).toContain("## ANSWER A");
    expect(prompt).not.toContain("Reference fix");
  }
  expect(prompts[0]).toContain(understand!.message);
  expect(prompts[0]).toContain("judging two answers");
  expect(prompts[1]).toContain("against the reference answer and the two answers");
  const judgedReport = await renderWorkflowAuditReport(directory);
  expect(judgedReport).toContain("| test4 | control | 1/1 | 2.0 | $0.2000 | not graded | unavailable | unavailable | 0/0/1 |");
  expect(judgedReport).toContain("Judge control wins / candidate wins / ties: 0/0/1.");
  expect(judgedReport).toContain("Pending judge pairs: 0. Skipped pairs: 0. Unsettled judge attempts: 0.");
  const ledger = (await readdir(directory)).find((entry) => entry.startsWith("judge-"))!;
  const rows = (await readFile(join(directory, ledger), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  for (const row of rows) if (row.kind === "pair") row.identity = "b".repeat(64);
  await writeFile(join(directory, ledger), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const staleReport = await renderWorkflowAuditReport(directory);
  expect(staleReport).toContain("Judge control wins / candidate wins / ties: 0/0/0.");
  expect(staleReport).toContain("Pending judge pairs: 1.");
  let calls = 0;
  const winner: JudgeModel = { async complete() {
    calls++;
    return { text: calls % 2 === 0 ? '{"refuted":false,"reason":"Claims hold"}' : JSON.stringify({ correctA: "yes", correctB: "partial", winner: calls === 1 ? "B" : "A", rationale: "The second treatment is better" }), accounting };
  } };
  await judgeWorkflowAuditCampaign(options, { admit: async () => ({ model: winner, profileId: "judge", authorityIncarnation: "authority", [Symbol.asyncDispose]: async () => {} }) });
  const winningReport = await renderWorkflowAuditReport(directory);
  expect(winningReport).toContain("| test4 | candidate | 1/1 | 2.0 | $0.2000 | not graded | unavailable | unavailable | 0/1/0 |");
  expect(winningReport).toContain("Judge control wins / candidate wins / ties: 0/1/0.");
  const currentRows = (await readFile(join(directory, ledger), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const start = currentRows.findLast((row) => row.kind === "pair");
  await writeFile(join(directory, ledger), [...currentRows, { ...start, id: "interrupted" }].map((row) => JSON.stringify(row)).join("\n") + "\n");
  expect(await renderWorkflowAuditReport(directory)).toContain("Unsettled judge attempts: 1.");
});

test("audit report shows every Flywheel arm against Claude Code with independent judge tallies and equal-test-weight ratios without writes", async () => {
  const { directory } = await fixture(["test4", "test9"], 2, ["control", "fw-default", "fw-sonnet"]);
  const store = await workflowAuditLedger.open(directory);
  const { completed } = workflowAuditLedger.validate(store.manifest, await store.load());
  for (const original of completed.values()) {
    const flywheel = original.cell.treatment !== "candidate";
    const cell = { ...original.cell, task: "test9" as const };
    const attemptId = `${cell.treatment}-test9`;
    await store.append({ kind: "attempt", attemptId, cell, directory: attemptId, at: "now" });
    await store.append({
      ...original, attemptId, cell,
      runs: [{ ...original.runs[0]!, wallMs: flywheel ? 6000 : 3000, artifacts: [] }],
      accounting: { ...accounting, estimatedUsd: { kind: "observed", value: flywheel ? 0.6 : 0.3 } },
    });
  }
  const original = completed.get("control/test4/0")!;
  const cell = { ...original.cell, repeat: 1 };
  await store.append({ kind: "attempt", attemptId: "control-extra", cell, directory: "control-extra", at: "now" });
  await store.append({
    ...original, attemptId: "control-extra", cell,
    runs: [{ ...original.runs[0]!, wallMs: 4000, artifacts: [] }],
    accounting: { ...accounting, estimatedUsd: { kind: "observed", value: 0.4 } },
  });
  const evidence: ExecutionEvidence = {
    version: 2, projectRoot: "/scratch", rootSessionId: "s0", descendantDiscovery: "current-metadata", metadataGaps: [],
    accounting: { usage: "available", price: "estimate", providerInvoicedCost: "unavailable" },
    sessions: (["chat", "workflow-agent", "subagent"] as const).map((kind, index) => ({
      sessionId: `s${index}`, kind, usageEntries: [],
      ...(index > 0 ? { parentSessionId: `s${index - 1}` } : {}),
      requests: [{
        requestId: `r${index}`, identity: { providerSessionKey: `s${index}`, conversationId: `s${index}` }, turn: 1,
        preparedAt: index * 1000, respondedAt: index * 1000 + 500,
        dispatchState: "dispatched", completionState: "terminal", purpose: "normal", measurement: "available",
        ...(kind === "workflow-agent" ? { workflowAttemptId: `agent-${index}` } : {}),
      }],
    })),
  };
  const flywheelRun = join(directory, "control", "artifacts", "run-0");
  await mkdir(flywheelRun, { recursive: true });
  await writeFile(join(flywheelRun, "evidence.json"), JSON.stringify(evidence));
  for (const [attempt, contents] of [
    ["control-test9", { ...evidence, sessions: evidence.sessions.filter(({ kind }) => kind !== "workflow-agent").map((session) => session.kind === "subagent" ? { ...session, parentSessionId: "s0" } : session) }],
    ["control-extra", { ...evidence, descendantDiscovery: "incomplete", metadataGaps: [{ sessionId: "missing", kind: "missing", scope: "descendant" }] }],
    ["fw-default", { ...evidence, descendantDiscovery: "incomplete", metadataGaps: [{ sessionId: "missing", kind: "missing", scope: "descendant" }], sessions: evidence.sessions.slice(0, 1) }],
  ] as const) {
    const runDirectory = join(directory, attempt, "artifacts", "run-0");
    await mkdir(runDirectory, { recursive: true });
    await writeFile(join(runDirectory, "evidence.json"), JSON.stringify(contents));
  }
  const transcript = JSON.stringify({ type: "assistant", timestamp: "2026-10-23T00:00:00Z", message: { id: "m1", usage: { input_tokens: 1, output_tokens: 1 } } });
  for (const attempt of ["candidate", "candidate-test9"]) {
    const transcripts = join(directory, attempt, "artifacts", "run-0", "transcripts");
    await mkdir(transcripts, { recursive: true });
    await writeFile(join(transcripts, "chat.jsonl"), transcript);
    const agents = attempt === "candidate"
      ? join(transcripts, "chat", "subagents", "workflows", "wf_one")
      : join(transcripts, "chat", "subagents");
    await mkdir(agents, { recursive: true });
    await writeFile(join(agents, "agent-one.jsonl"), transcript);
  }
  for (const a of ["control", "fw-default", "fw-sonnet"]) {
    let calls = 0;
    const model: JudgeModel = { async complete() {
      calls++;
      return { text: calls % 2 === 0 && a !== "fw-sonnet" ? '{"refuted":false,"reason":"Evidence holds"}'
        : JSON.stringify({ correctA: "yes", correctB: "yes", winner: a === "fw-sonnet" ? "tie" : (calls === 1 || calls === 5) === (a === "control") ? "A" : "B", rationale: "The reference supports the verdict" }), accounting };
    } };
    await judgeWorkflowAuditCampaign({ directory, a, b: "candidate", authProfile: "Personal" }, {
      admit: async () => ({ model, profileId: "judge", authorityIncarnation: "authority", [Symbol.asyncDispose]: async () => {} }),
    });
  }
  const before = await readdir(directory, { recursive: true });
  const report = await renderWorkflowAuditReport(directory);
  expect(report).toContain("| test4 | control | 2/2 | 3.0 | $0.3000 | not graded | 1/1 (1/2 cells observed) | 1.0 (1/2 cells observed) | 1/0/0 |");
  expect(report).toContain("| test4 | candidate | 1/2 | 2.0 | $0.2000 | not graded | 1/1 | 1.0 | not applicable |");
  expect(report).toContain("| test9 | control | 1/2 | 6.0 | $0.6000 | not graded | 0/1 | 0.0 | 1/0/0 |");
  expect(report).toContain("| test9 | candidate | 1/2 | 3.0 | $0.3000 | not graded | 0/1 | 0.0 | not applicable |");
  expect(report).toContain("| test4 | fw-default | 1/2 | 2.0 | $0.2000 | not graded | unavailable | unavailable | 0/1/0 |");
  expect(report).toContain("| test4 | fw-sonnet | 1/2 | 2.0 | $0.2000 | not graded | unavailable | unavailable | 0/0/1 |");
  expect(report).toContain("### control vs candidate");
  expect(report).toContain("### fw-default vs candidate");
  expect(report).toContain("### fw-sonnet vs candidate");
  expect(report).toContain("Flywheel time / Claude Code time: 1.800.");
  expect(report).toContain("Flywheel estimated cost / Claude Code estimated cost: 1.800.");
  expect(report).toContain("Judge control wins / candidate wins / ties: 2/0/0.");
  expect(report).toContain("Judge fw-default wins / candidate wins / ties: 0/2/0.");
  expect(report).toContain("Judge fw-sonnet wins / candidate wins / ties: 0/0/2.");
  expect(report).toContain("Flywheel time / Claude Code time: 1.600.");
  expect((await readdir(directory, { recursive: true })).sort()).toEqual(before.sort());
  const unpriced = { treatment: "candidate", task: "test9" as const, repeat: 1 };
  await store.append({ kind: "attempt", attemptId: "unpriced", cell: unpriced, directory: "unpriced", at: "now" });
  await store.append({
    ...original, attemptId: "unpriced", cell: unpriced,
    runs: [{ ...original.runs[0]!, wallMs: 3000, artifacts: [] }], accounting: unavailableBenchmarkAccounting("missing price"),
  });
  const partialReport = await renderWorkflowAuditReport(directory);
  expect(partialReport).toContain("| test9 | candidate | 2/2 | 3.0 | unavailable (1/2 cells priced) |");
  expect(partialReport).toContain("Flywheel time / Claude Code time: 1.800.");
  expect(partialReport).toContain("Flywheel estimated cost / Claude Code estimated cost: unavailable.");
});

test("a requirements job is judged as two plans against the known requirements and never reads a fix", async () => {
  const prompts: string[] = [];
  const model: JudgeModel = { async complete(prompt) {
    prompts.push(prompt);
    return { text: prompts.length % 2 === 0 ? '{"refuted":false,"reason":"Claims hold"}' : JSON.stringify({ correctA: "yes", correctB: "no", winner: prompt.includes("## PLAN A\nPlan one") ? "A" : "B", rationale: "The other plan repeats the false premise" }), accounting };
  } };
  const judged = await judgeBlocks({ model, [Symbol.asyncDispose]: async () => {} }, { identity: "none", redact: (text) => text },
    [{ test: "plan", task: "plan", repeat: 0, request: "Add a guard.", requirements: "- m1: Guard. Reads `src/a.ts`.", reports: { a: "Plan one", b: "Plan two" } }], ["a", "b"]);
  expect(judged[0]?.winner).toBe("a");
  expect(judged[0]?.sites).toEqual({ a: {}, b: {} });
  expect(prompts).toHaveLength(4);
  for (const prompt of prompts) {
    expect(prompt).toContain("## Known requirements (verified against the repository, for checking grounding only)\n- m1: Guard. Reads `src/a.ts`.");
    expect(prompt).toContain("## PLAN A");
    expect(prompt).not.toContain("Reference fix");
  }
  expect(prompts[0]).toContain("judging two implementation plans");
  expect(prompts[1]).toContain("against the known requirements and the two plans");
});
