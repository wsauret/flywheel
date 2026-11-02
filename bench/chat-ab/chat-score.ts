import { join } from "node:path";
import { Schema } from "effect";
import { structuredIdentity } from "../../src/orchestration/modules/development/benchmark/content-identity.js";
import { campaignIdentity, recordedCampaignIdentity } from "./campaign-store.js";
import { chatLedger } from "./chat-store.js";
import { chatJudgeInputs, chatRedaction, recordedChatRedactionIdentity, requireChatJudgeFamily } from "./chat-judge-inputs.js";
import { CHAT_AB_JUDGE } from "./judge-inputs.js";
import { parseScoreReply, scorePrompt, ScoreCallSchema, type ScoreCall } from "./score.js";
import { openScoreRun, pendingScoreJobs, runScoreJobs } from "./score-run.js";

const Config = Schema.Struct({ kind: Schema.Literal("chat-headless-scoring"), campaign: Schema.String, judge: Schema.String, effort: Schema.String, prompt: Schema.String, redaction: Schema.String });

/** Score each completed native Chat cell twice. Report-only reads evidence without admission or writes. */
export async function scoreChatCampaign(directory: string, authProfile: string, reportOnly: boolean) {
  const store = await chatLedger.open(directory);
  const { completed } = chatLedger.validate(store.manifest, await store.load());
  const redaction = await chatRedaction([store.manifest], [...completed.values()].map((outcome) => ({ directory, outcome })));
  const config = { kind: "chat-headless-scoring" as const, campaign: campaignIdentity(store.manifest), judge: CHAT_AB_JUDGE.model, effort: CHAT_AB_JUDGE.effort, prompt: structuredIdentity(scorePrompt({ request: "", diff: "" }, 0)), redaction: redaction.identity };
  const root = join(directory, `score-${CHAT_AB_JUDGE.model}`);
  const recorded = { ...config, campaign: recordedCampaignIdentity(store.manifest), redaction: recordedChatRedactionIdentity([store.manifest]) };
  const run = await openScoreRun(root, Config, [config, recorded], ScoreCallSchema, "score-calls.jsonl", reportOnly);
  const { calls } = run;
  const jobs = pendingScoreJobs(
    [...completed.values()].flatMap(outcome => ([0, 1] as const).map(call => ({ outcome, call }))), calls,
    ({ outcome, call }) => `${outcome.attemptId}/${call}`, call => `${call.artifactDir}/${call.call}`,
  );
  if (!reportOnly && jobs.length > 0) {
    const inputs = new Map(await Promise.all([...completed.values()].map(async (outcome) => [outcome.attemptId, await chatJudgeInputs(directory, store.manifest, outcome, redaction)] as const)));
    await runScoreJobs(run, jobs, {
      authProfile, validateModel: model => requireChatJudgeFamily([store.manifest], model),
      prompt: ({ outcome, call }) => scorePrompt(inputs.get(outcome.attemptId)!, call),
      parseReply: parseScoreReply, parseError: "unparsable score reply",
      record: ({ outcome, call }, result): ScoreCall => ({
        kind: "chat-ab-score-call", task: outcome.cell.task, repeat: outcome.cell.repeat, artifactDir: outcome.attemptId, call,
        ...result, usd: result.accounting.estimatedUsd.kind === "observed" ? result.accounting.estimatedUsd.value : null,
      }),
    });
  }
  const rows = [...completed.values()].map((outcome) => {
    const scores = ([0, 1] as const).map((call) => calls.findLast((record) => record.artifactDir === outcome.attemptId && record.call === call && record.reply !== null)?.reply?.score ?? null);
    return { cell: outcome.cell, scores, score: scores.every((value) => value !== null) ? (scores[0]! + scores[1]!) / 2 : null };
  });
  const pending = [...completed.values()].reduce((count, outcome) => count + ([0, 1] as const).filter((call) => !calls.some((record) => record.artifactDir === outcome.attemptId && record.call === call && record.reply !== null)).length, 0);
  const markdown = ["# Absolute Chat scores", "", `Judge: ${CHAT_AB_JUDGE.model}; effort: ${CHAT_AB_JUDGE.effort}. Pending calls: ${pending}.`, "", "| Treatment | Task | Repeat | Quality score |", "|---|---|---|---|", ...rows.map(({ cell, score }) => `| ${cell.treatment} | ${cell.task} | ${cell.repeat} | ${score ?? "unavailable"} |`), ""].join("\n");
  const report = { markdown, json: { config, rows, calls } };
  await run.writeReport(report);
  return report;
}
