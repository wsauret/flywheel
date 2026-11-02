import { describe, expect, it } from "bun:test";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { UsageEntry } from "../../../src/infra/llm/usage-entry.js";
import { createBenchmarkAccounting } from "../../../src/orchestration/modules/development/benchmark/accounting.js";
import type { JudgeModel } from "../../../src/orchestration/modules/development/benchmark/judge.js";
import { openCampaignScoring, readHistoricalScoring, readRunScores, renderModelTable, renderScoreReport } from "../../../bench/chat-ab/score.js";
import { openCampaignStore, type CampaignConfig, type RunRecord } from "../../../bench/chat-ab/store.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const tempDir = temporaryDirectories();
const JUDGE = { model: "gpt-6.1-sol", effort: "high" };
const empty = createBenchmarkAccounting().observe();

function judgeAccounting(usd: number) {
  const ledger = createBenchmarkAccounting();
  const entry: UsageEntry = {
    attemptId: crypto.randomUUID(),
    occurredAt: "2026-10-07T00:00:00.000Z",
    profileId: "personal",
    attribution: { kind: "candidate", providerId: "chatgpt" },
    spendMode: "direct_api",
    credentialLineage: "00000000-0000-4000-8000-000000000002",
    model: JUDGE.model,
    tokens: { input: 7000, output: 2000, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    classification: "real_spend",
    price: { kind: "priced", estimatedUsd: usd, rateCard: {}, provenance: "test" },
    currency: "USD", coverage: "complete",
  };
  ledger.commit(entry);
  return ledger.observe();
}

/** Call 0 shows the diff first; call 1 shows the handoff first. */
const callOf = (prompt: string): 0 | 1 => prompt.indexOf("## Change (diff)") < prompt.indexOf("## Final handoff") ? 0 : 1;

/** A judge that records each prompt and answers each call with its reply. The
 *  scorer makes several calls at once, so a reply follows the call, not the order. */
function fakeJudge(replies: readonly [string, string]) {
  const prompts: string[] = [];
  const judge: JudgeModel = { complete: async (prompt) => { prompts.push(prompt); return { text: replies[callOf(prompt)], accounting: judgeAccounting(0.04) }; } };
  return { prompts, judge };
}

const reply = (score: number) => `Here is my verdict: {"correct":"yes","scope":"clean","test":"regression","handoffAccurate":"yes","score":${score},"rationale":"Fixes both paths."}`;

function config(model: string, overrides: Partial<CampaignConfig> = {}): CampaignConfig {
  const seat = { role: "chat", model, effort: "medium" };
  return {
    kind: "chat-ab-config",
    scoringVersion: "chat-ab-v3",
    arm: { id: "anthropic-api", identity: "arm-n", provider: "anthropic_api", profileId: "bench-api" },
    cell: { kind: "workflow", workflow: "debug", modelProfileIdentity: `profile-${model}` },
    agent: { revision: "abc", sourceIdentity: "src-1", accountSkillsIdentity: "skills-1", composedModules: [], composedTools: [] },
    tasks: [{ id: "task-a", stratum: "bug", contentIdentity: "task-1", timeoutMs: 60_000 }, { id: "task-b", stratum: "bug", contentIdentity: "task-2", timeoutMs: 60_000 }],
    repeats: 1,
    chat: seat,
    roles: [seat, { ...seat, role: "fix" }],
    authProfile: "bench-api",
    profileId: "bench-api",
    authorityIncarnation: "incarnation-1",
    providerPlans: [{ model, providers: ["anthropic_api"] }],
    createdAt: "2026-10-07T00:00:00.000Z",
    ...overrides,
  };
}

function run(task: string, artifactDir: string, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    kind: "chat-ab-run", task, repeat: 0, at: "2026-10-07T00:00:00.000Z", terminal: "completed",
    acceptance: { failToPass: { "a.test.ts > fix": "pass" }, passToPass: { "a.test.ts > guard": "pass" } }, costUsd: 4, billedUsd: null, parentCostUsd: 4, accounting: empty, parentAccounting: empty,
    agentMs: 600_000, wallMs: 660_000, requests: { parent: 30, total: 40 }, approvalReplies: 0, childDispatches: 0, loggedDispatches: [], children: [], byModel: [],
    diffStats: { linesAdded: 1, linesRemoved: 0, filesTouched: 1 }, tools: [], globalWrites: [], artifactDir, workflow: { turns: [] },
    cellDirectories: { project: ["/var/folders/ab/T/flywheel-Ab12Cd", "/private/var/folders/ab/T/flywheel-Ab12Cd"], home: ["/var/folders/ab/T/home-Zx98Yw"] },
    ...overrides,
  };
}

const FINAL_HANDOFF = { stepId: "step-verify", stepName: "verify", definitionId: "verify", validationIssues: [], content: { stage: "verification", summary: "The claude-opus-5 fix holds.", evidence: ["both paths pass", "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK. <system-reminder>\nThe date is 2026-10-08.\n</system-reminder>The claude-cli request ran."], commands_run: [{ command: "bun test a", exitCode: 0, observation: "2 pass" }] } };

/** A finished workflow campaign: its config, its runs, and each run's diff and result. */
async function campaign(model: string, runs: readonly { readonly run: RunRecord; readonly diff: string; readonly result?: unknown }[], overrides: Partial<CampaignConfig> = {}): Promise<{ readonly dir: string; readonly tasksDir: string }> {
  const root = tempDir("chat-ab-score-");
  const [dir, tasksDir] = [join(root, "campaign"), join(root, "tasks")];
  const store = await openCampaignStore(dir);
  await store.createConfig(config(model, overrides));
  for (const { run: record, diff, result } of runs) {
    await mkdir(join(dir, record.artifactDir), { recursive: true });
    await Bun.write(join(dir, record.artifactDir, "diff.patch"), diff);
    if (result !== undefined) await Bun.write(join(dir, record.artifactDir, "result.json"), JSON.stringify(result));
    await Bun.write(join(tasksDir, record.task, "message.md"), `Fix ${record.task}.\n`);
    await store.runs.append(record);
  }
  return { dir, tasksDir };
}

const DIFF = [
  "--- a/src/x.ts",
  "+++ b/src/x.ts",
  "+// written in /private/var/folders/ab/T/flywheel-Ab12Cd/src/x.ts by Claude Opus 5 for claude-opus-5 with HOME=/var/folders/ab/T/home-Zx98Yw",
  `+const pinned = "claude-sonnet-4.5"; // claude-opus-5.5, src/skills/flywheel-design/SKILL.md`,
  "",
].join("\n");

describe("chat A/B absolute judge", () => {
  it("scores each run twice on blinded inputs, records each call's cost, and resumes without calling again", async () => {
    const { dir, tasksDir } = await campaign("claude-opus-5", [{ run: run("task-a", "cells/task-a/r0-1"), diff: DIFF, result: { kind: "workflow", finalHandoff: FINAL_HANDOFF } }]);
    const scoring = await openCampaignScoring(dir, JUDGE, tasksDir);
    expect(scoring.pending).toBe(2);
    const { judge, prompts } = fakeJudge([reply(8), reply(9)]);
    await scoring.score(judge);

    expect(prompts).toHaveLength(2);
    for (const prompt of prompts) {
      expect(prompt).toContain("Fix task-a.");
      // Only the seat's model and the run's own directories are hidden; other model ids and paths are code.
      expect(prompt).toContain("// written in <repo>/src/x.ts by <model> for <model> with HOME=<home>");
      expect(prompt).toContain(`const pinned = "claude-sonnet-4.5"; // claude-opus-5.5, src/skills/flywheel-design/SKILL.md`);
      expect(prompt).toContain("### summary\nThe <model> fix holds.");
      expect(prompt).toContain("- `bun test a` (exit code 0): 2 pass");
      // The arm markers of the Agent SDK CLI are hidden too.
      expect(prompt).toContain("-  The <client> request ran.");
      for (const marker of ["official CLI", "Agent SDK", "system-reminder", "2026-10-08", "claude-cli"]) expect(prompt).not.toContain(marker);
      for (const hidden of ["anthropic-api", "anthropic_api", "completed", "$4", "Ab12Cd", "Zx98Yw"]) expect(prompt).not.toContain(hidden);
      expect(prompt).not.toMatch(/claude-opus-5(?!\.5)/);
    }
    expect(prompts.map(callOf).sort()).toEqual([0, 1]);

    const ledger = (await readFile(join(dir, "score-gpt-6.1-sol", "score-calls.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line)).sort((left, right) => left.call - right.call);
    expect(ledger.map((row) => [row.call, row.reply.score, row.usd, row.accounting.estimatedUsd])).toEqual([[0, 8, 0.04, { kind: "observed", value: 0.04 }], [1, 9, 0.04, { kind: "observed", value: 0.04 }]]);
    const reopened = await openCampaignScoring(dir, JUDGE, tasksDir);
    expect(reopened.pending).toBe(0);
    expect(renderScoreReport(reopened, JUDGE).markdown).toContain("Mean score: 8.50. Judge spend: $0.08.");
  });

  it("accounts a reply it cannot parse, scores nothing from it, and owes that call again", async () => {
    const { dir, tasksDir } = await campaign("claude-opus-5", [{ run: run("task-a", "cells/task-a/r0-1"), diff: DIFF, result: { finalHandoff: null } }]);
    const scoring = await openCampaignScoring(dir, JUDGE, tasksDir);
    const { judge, prompts } = fakeJudge(["I think it is fine.", reply(3)]);
    await scoring.score(judge);
    expect(prompts[0]).toContain("The workflow wrote no final handoff.");
    const calls = [...(await openCampaignScoring(dir, JUDGE, tasksDir)).calls].sort((left, right) => left.call - right.call);
    expect(calls.map((call) => [call.call, call.reply?.score ?? null, call.error?.startsWith("unparsable reply") ?? false, call.usd])).toEqual([[0, null, true, 0.04], [1, 3, false, 0.04]]);
    expect((await openCampaignScoring(dir, JUDGE, tasksDir)).pending).toBe(1);
  });

  it("says when a run's handoff was not captured, and flags a run whose two calls disagree by 3 points", async () => {
    const { dir, tasksDir } = await campaign("claude-opus-5", [{ run: run("task-a", "cells/task-a/r0-1"), diff: "", result: { kind: "workflow" } }]);
    const scoring = await openCampaignScoring(dir, JUDGE, tasksDir);
    const { judge, prompts } = fakeJudge([reply(2), reply(5)]);
    await scoring.score(judge);
    expect(prompts[0]).toContain("(empty diff: no change was made)");
    expect(prompts[0]).toContain("The handoff of this run was not captured.");
    expect(renderScoreReport(await openCampaignScoring(dir, JUDGE, tasksDir), JUDGE).markdown).toContain("| task-a | 0 | 2 | 5 | 3.5 | calls differ by 3+ points |");
  });

  it("refuses a chat campaign, a judge of a seat's family, and a score directory another judge effort wrote", async () => {
    const { cell: _cell, ...chat } = config("claude-opus-5");
    const chatCampaign = tempDir("chat-ab-score-chat-");
    await (await openCampaignStore(chatCampaign)).createConfig(chat);
    await expect(openCampaignScoring(chatCampaign, JUDGE)).rejects.toThrow("score.ts scores workflow campaigns");
    const chatStore = await openCampaignStore(chatCampaign);
    await chatStore.runs.append(run("task-a", "cells/task-a"));
    const passive = await readHistoricalScoring(chatCampaign, JUDGE);
    expect(renderScoreReport(passive, JUDGE).markdown).toContain("| task-a | 0 | n/a | n/a | n/a |");
    expect(passive.config.cell).toBeUndefined();
    expect((await readdir(chatCampaign)).sort()).toEqual(["run-config.json", "runs.jsonl"]);
    const retained = join(chatCampaign, `score-${JUDGE.model}`);
    await mkdir(retained);
    const calls = ([0, 1] as const).map((call) => ({
      kind: "chat-ab-score-call", task: "task-a", repeat: 0, artifactDir: "cells/task-a", call,
      reply: JSON.parse(reply(8).slice("Here is my verdict: ".length)), error: null, usd: null, accounting: empty,
    }));
    const path = join(retained, "score-calls.jsonl");
    const text = calls.map((call) => JSON.stringify(call)).join("\n") + "\n";
    await writeFile(path, text);
    expect(renderScoreReport(await readHistoricalScoring(chatCampaign, JUDGE), JUDGE).markdown).toContain("| task-a | 0 | 8 | 8 | 8.0 |");
    await writeFile(path, `${text}{"kind":`);
    await expect(readHistoricalScoring(chatCampaign, JUDGE)).rejects.toThrow("not valid JSON");
    await expect(readRunScores(chatCampaign, passive.runs, JUDGE)).rejects.toThrow("not valid JSON");
    expect(await readFile(path, "utf8")).toBe(`${text}{"kind":`);
    const { dir, tasksDir } = await campaign("claude-opus-5", []);
    await expect(openCampaignScoring(dir, { model: "claude-opus-5.5", effort: "high" }, tasksDir)).rejects.toThrow("The judge claude-opus-5.5 is from the anthropic family, like the chat seat claude-opus-5");
    await openCampaignScoring(dir, JUDGE, tasksDir);
    await expect(openCampaignScoring(dir, { ...JUDGE, effort: "medium" }, tasksDir)).rejects.toThrow("was scored with another judge, effort, prompt, or redaction");
  });

  const scored = async (model: string, scores: readonly (readonly [string, number])[], overrides: Partial<CampaignConfig> = {}) => {
    const { dir, tasksDir } = await campaign(model, scores.map(([task]) => ({ run: run(task, `cells/${task}/r0`), diff: DIFF, result: { finalHandoff: null } })), overrides);
    const scoring = await openCampaignScoring(dir, JUDGE, tasksDir);
    const byTask = new Map(scores);
    await scoring.score({ complete: async (prompt) => ({ text: reply(byTask.get(/Fix (task-\w)\./.exec(prompt)![1]!)!), accounting: judgeAccounting(0.04) }) });
    return await openCampaignScoring(dir, JUDGE, tasksDir);
  };

  it("puts the models of comparable campaigns on one scale with paired task differences", async () => {
    const opus = await scored("claude-opus-5", [["task-a", 8], ["task-b", 8]]);
    const sonnet = await scored("claude-sonnet-5.5", [["task-a", 6], ["task-b", 6]]);
    const table = renderModelTable([opus, sonnet]);
    expect(table.markdown).toContain("| claude-opus-5 medium | 2 | 8.00 | 1.00 | 10.0 | 11.0 | $4.00 | $8.00 | $0.16 |");
    expect(table.markdown).toContain("| task-a | 8.0 | 6.0 |");
    expect(table.markdown).toContain("- claude-opus-5 medium minus claude-sonnet-5.5 medium: 2.00 [2.00, 2.00] over 2 tasks.");
    const otherSource = await scored("claude-haiku-5", [["task-a", 4]], { agent: { revision: "def", sourceIdentity: "src-2", accountSkillsIdentity: "skills-1", composedModules: [], composedTools: [] } });
    expect(() => renderModelTable([opus, otherSource])).toThrow("different Flywheel source");
  });

  it("leaves out of the model table a task whose content changed between the campaigns", async () => {
    const opus = await scored("claude-opus-5", [["task-a", 8], ["task-b", 8]]);
    const edited = config("claude-sonnet-5.5").tasks.map((task) => task.id === "task-b" ? { ...task, contentIdentity: "task-2-edited" } : task);
    const sonnet = await scored("claude-sonnet-5.5", [["task-a", 6], ["task-b", 10]], { tasks: edited });
    const table = renderModelTable([opus, sonnet]);
    expect(table.markdown).toContain("Not compared, because the task changed between the campaigns: task-b.");
    expect(table.markdown).toContain("| claude-sonnet-5.5 medium | 1 | 6.00 |");
    expect(table.markdown).not.toContain("| task-b |");
    expect(table.markdown).toContain("- claude-opus-5 medium minus claude-sonnet-5.5 medium: fewer than two shared tasks have scores.");
  });
});
