import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sum } from "../shared/sum.js";
import { scoreAcceptance } from "./acceptance.js";
import { historicalCampaignStore, type AttemptRecord, type CampaignConfig, type RunRecord } from "./store.js";
import { chatLedger, isChatCampaign } from "./chat-store.js";
import { renderChatReport } from "./chat-report.js";

function mean(values: readonly number[]): number | null {
  return values.length === 0 ? null : sum(values) / values.length;
}

function usd(value: number | null): string {
  return value === null ? "n/a" : `$${value.toFixed(2)}`;
}

/** Words that show the agent framing its own work as a test. Flywheel itself
 *  has benchmark code, so a bare "benchmark" is not a leak. */
const FRAME_LEAK = /\b(this (benchmark|eval(uation)?|test task)|being (evaluated|graded)|test harness|graded|acceptance tests? (will|that the grader))/i;

/** Conditions that make a cell's result suspect. Each one sends a person to
 *  the cell's transcript before the campaign is trusted. */
async function auditFlags(directory: string, config: CampaignConfig, run: RunRecord): Promise<string[]> {
  const flags: string[] = [];
  const artifact = join(directory, run.artifactDir);
  if (run.diffStats.filesTouched === 0) flags.push("no diff");
  const { brokenGuards } = scoreAcceptance(run.acceptance);
  if (brokenGuards.length > 0) flags.push(`broke ${brokenGuards.length} guard tests: ${brokenGuards.join("; ")}`);
  if (run.approvalReplies > 0) flags.push(`stopped for approval x${run.approvalReplies}`);
  if (run.terminal !== "completed") flags.push(`ended ${run.terminal}`);
  // The account stores are shared by concurrent cells and by the operator's
  // own Flywheel, so a change during the cell names a suspect, not a writer.
  if (run.globalWrites.length > 0) flags.push(`account state changed during the cell (this cell, a concurrent cell, or another Flywheel process): ${run.globalWrites.join(", ")}`);
  if (run.loggedDispatches.length !== run.childDispatches) flags.push(`dispatch counts disagree (facts ${run.childDispatches}, log ${run.loggedDispatches.length})`);
  const result: unknown = JSON.parse(await readFile(join(artifact, "result.json"), "utf8").catch(() => "{}"));
  const chat = typeof result === "object" && result !== null && "chat" in result ? result.chat : undefined;
  const chatModel = typeof chat === "object" && chat !== null && "model" in chat ? chat.model : undefined;
  if (chatModel !== config.chat.model) flags.push(`chat seat ${String(chatModel)}, planned ${config.chat.model}`);
  if (FRAME_LEAK.test(await readFile(join(artifact, "transcript.md"), "utf8").catch(() => ""))) flags.push("transcript may name the benchmark");
  return flags;
}

export interface CampaignReport {
  readonly markdown: string;
  readonly json: unknown;
}

/** Projects the ledgers into report.md and report.json. Nothing reads these back. */
export async function renderReport(directory: string, config?: CampaignConfig, runs: readonly RunRecord[] = [], attempts: readonly AttemptRecord[] = [], stopNote?: string): Promise<CampaignReport> {
  if (!config) {
    if (await isChatCampaign(directory)) {
      const store = await chatLedger.open(directory);
      return { markdown: await renderChatReport(directory), json: { manifest: store.manifest, events: await store.load() } };
    }
    const store = historicalCampaignStore(directory);
    const historical = await store.loadConfig();
    if (!historical) throw new Error(`No campaign at ${directory}`);
    return renderReport(directory, historical, await store.runs.load(), await store.attempts.load(), stopNote);
  }
  const expected = config.tasks.length * config.repeats;
  const priced = runs.flatMap((run) => run.costUsd === null ? [] : [run.costUsd]);
  const scores = runs.map((run) => scoreAcceptance(run.acceptance));
  const resolved = scores.filter((score) => score.resolved).length;
  const cells = await Promise.all(runs.map(async (run) => ({ run, flags: await auditFlags(directory, config, run) })));
  const flagged = cells.filter((cell) => cell.flags.length > 0);
  const summary = {
    arm: config.arm.id,
    completed: runs.length,
    expected,
    resolved,
    meanAcceptanceScore: mean(scores.map((score) => score.score)),
    cellsWithBrokenGuards: scores.filter((score) => score.brokenGuards.length > 0).length,
    meanCostUsd: mean(priced),
    totalUsd: sum(priced),
    unpricedCells: runs.length - priced.length,
    billedUsd: sum(runs.flatMap((run) => run.billedUsd === null ? [] : [run.billedUsd])),
    failedAttempts: attempts.length,
    failedAttemptUsd: sum(attempts.map((attempt) => attempt.costUsd ?? 0)),
    meanAgentSeconds: mean(runs.map((run) => run.agentMs / 1000)),
    meanChildDispatches: mean(runs.map((run) => run.childDispatches)),
    meanFilesTouched: mean(runs.map((run) => run.diffStats.filesTouched)),
    flaggedCells: flagged.length,
  };
  const lines = [
    `# Chat A/B campaign: ${config.arm.id}`,
    "",
    `Chat seat: ${config.chat.model} ${config.chat.effort ?? ""}. Auth profile: ${config.authProfile}. Repeats: ${config.repeats}.`,
    `Completed cells: ${runs.length}/${expected}. Unsuccessful attempts: ${attempts.length} (${usd(summary.failedAttemptUsd)}).`,
    `Spend (estimated-equivalent USD): ${usd(summary.totalUsd)}, mean ${usd(summary.meanCostUsd)} per cell, ${summary.unpricedCells} unpriced. Billed real spend: ${usd(summary.billedUsd)}.`,
    `Acceptance: mean score ${summary.meanAcceptanceScore?.toFixed(2) ?? "n/a"}, the fail-to-pass tests fixed less the guard tests broken, over the fail-to-pass tests. ${resolved}/${runs.length} cells resolved their task (every test passes); ${summary.cellsWithBrokenGuards} broke a guard.`,
    ...(stopNote ? ["", `**Stopped early:** ${stopNote}`] : []),
    "",
    "## Audit",
    "",
    flagged.length === 0 ? "No cell is flagged." : `${flagged.length} cells are flagged. Read each flagged transcript before you trust the campaign.`,
    ...flagged.map(({ run, flags }) => `- ${run.task} r${run.repeat}: ${flags.join("; ")} (${run.artifactDir})`),
    "",
    "## Cells",
    "",
    "| Task | Repeat | Terminal | Fixed | Guards broken | Score | Cost | Agent s | Children | Files | Diff +/- |",
    "|---|---:|---|---:|---:|---:|---:|---:|---|---:|---:|",
    ...runs.map((run) => [run, scoreAcceptance(run.acceptance)] as const).map(([run, score]) => `| ${run.task} | ${run.repeat} | ${run.terminal} | ${score.fixed}/${score.fixable} | ${score.brokenGuards.length} | ${score.score.toFixed(2)} | ${usd(run.costUsd)} | ${Math.round(run.agentMs / 1000)} | ${run.loggedDispatches.map((child) => `${child.agentType}:${child.model}`).join(", ") || "none"} | ${run.diffStats.filesTouched} | +${run.diffStats.linesAdded}/-${run.diffStats.linesRemoved} |`),
    "",
    ...(attempts.length === 0 ? [] : ["## Unsuccessful attempts", "", ...attempts.map((attempt) => `- ${attempt.task} r${attempt.repeat}: ${attempt.reason}${attempt.terminal ? ` (${attempt.terminal})` : ""}${attempt.mismatches ? `, invalid: ${attempt.mismatches.length} requests named another model or provider (${attempt.mismatches[0]})` : ""}, cost ${usd(attempt.costUsd)}, ${attempt.artifactDir}`), ""]),
  ];
  return { markdown: `${lines.join("\n")}\n`, json: { summary, cells: cells.map(({ run, flags }) => ({ task: run.task, repeat: run.repeat, flags })), stopNote: stopNote ?? null } };
}

/** Prints the report of one Chat campaign, new or historical, without writes or model requests:
 *    bun --conditions=browser bench/chat-ab/report.ts <campaign directory> */
if (import.meta.main) {
  const [directory] = process.argv.slice(2);
  if (directory === undefined) {
    console.error("usage: bun --conditions=browser bench/chat-ab/report.ts <campaign directory>");
    process.exitCode = 1;
  } else {
    renderReport(resolve(directory)).then((report) => console.log(report.markdown), (error: unknown) => {
      console.error(`chat-ab report failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
  }
}
