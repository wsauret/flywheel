import { basename, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { Schema } from "effect";
import { structuredIdentity } from "../../src/orchestration/modules/development/benchmark/content-identity.js";
import { createJsonFile, createJsonLinesLedger, readJsonFile, writeArtifactFile } from "../../src/orchestration/modules/development/benchmark/json-lines.js";
import { campaignIdentity, recordedCampaignIdentity } from "./campaign-store.js";
import { chatLedger } from "./chat-store.js";
import { compareCampaignRoles } from "./campaign-role-evidence.js";
import { renderCampaignRoleChanges } from "../../src/orchestration/modules/development/benchmark/campaign-role-changes.js";
import { chatJudgeInputs, chatRedaction, recordedChatRedactionIdentity, requireChatJudgeFamily } from "./chat-judge-inputs.js";
import { CHAT_AB_JUDGE } from "./judge-inputs.js";
import { admitChatAbJudge, eachJudgeJob, judgePair, PAIR_JUDGE_INSTRUCTIONS, VerdictSchema } from "./pair-judge.js";
import { baselineInSlotA, decide, pairOutcome, sideOf, type DecisionRule } from "./verdict.js";

const Call = Schema.Struct({
  task: Schema.String, repeat: Schema.Int, order: Schema.Literals([0, 1]), baselineFirst: Schema.Boolean,
  verdict: Schema.NullOr(VerdictSchema), error: Schema.NullOr(Schema.String), usd: Schema.NullOr(Schema.Number),
});
const Config = Schema.Struct({ baseline: Schema.String, candidate: Schema.String, judge: Schema.String, prompt: Schema.String, redaction: Schema.String });

/** Compare native single-treatment campaigns, or both treatments within one paired campaign, with blinded inputs. */
export async function compareChatCampaigns(options: { baseline: string; candidate: string; authProfile: string; rule: DecisionRule; differ: "arm" | "models"; reportOnly?: boolean }, admitJudge = admitChatAbJudge) {
  const baseline = await chatLedger.open(options.baseline);
  const candidate = await chatLedger.open(options.candidate);
  const within = options.baseline === options.candidate;
  if (within ? baseline.manifest.treatments.length !== 2 : baseline.manifest.treatments.length !== 1 || candidate.manifest.treatments.length !== 1) throw new Error("Compare single-treatment directories, or name the same paired directory on both sides");
  if (baseline.manifest.infrastructureIdentity !== candidate.manifest.infrastructureIdentity) throw new Error("Campaign infrastructure identities differ");
  const baseTreatment = baseline.manifest.treatments[0]!;
  const candidateTreatment = candidate.manifest.treatments[within ? 1 : 0]!;
  const sameSubject = baseTreatment.subject === "claude-code"
    ? candidateTreatment.subject === "claude-code" && baseTreatment.binarySha256 === candidateTreatment.binarySha256
    : candidateTreatment.subject !== "claude-code" && baseTreatment.sourceIdentity === candidateTreatment.sourceIdentity;
  if (options.differ === "models" && (!sameSubject || structuredIdentity(baseTreatment.arm) !== structuredIdentity(candidateTreatment.arm))) throw new Error("A model comparison requires the same source or binary and skill arm");
  const shared = baseline.manifest.tasks.filter((task) => candidate.manifest.tasks.some((other) => other.id === task.id && other.contentIdentity === task.contentIdentity)).map(({ id }) => id);
  const baseRuns = [...chatLedger.validate(baseline.manifest, await baseline.load()).completed.values()].filter(({ cell }) => cell.treatment === baseTreatment.id);
  const candidateRuns = [...chatLedger.validate(candidate.manifest, await candidate.load()).completed.values()].filter(({ cell }) => cell.treatment === candidateTreatment.id);
  const pairs = candidateRuns.flatMap((run) => {
    const other = baseRuns.find(({ cell }) => cell.task === run.cell.task && cell.repeat === run.cell.repeat);
    return other && shared.includes(run.cell.task) ? [{ baseline: other, candidate: run }] : [];
  });
  const roleComparisons = await Promise.all(pairs.map((pair) => compareCampaignRoles(
    { directory: options.baseline, outcome: pair.baseline, ...(baseTreatment.subject === "claude-code" ? {} : { pins: baseTreatment.roles }) },
    { directory: options.candidate, outcome: pair.candidate, ...(candidateTreatment.subject === "claude-code" ? {} : { pins: candidateTreatment.roles }) },
  )));
  const redaction = await chatRedaction([baseline.manifest, candidate.manifest], [
    ...baseRuns.map((outcome) => ({ directory: options.baseline, outcome })),
    ...candidateRuns.map((outcome) => ({ directory: options.candidate, outcome })),
  ]);
  const config = { baseline: campaignIdentity(baseline.manifest), candidate: campaignIdentity(candidate.manifest), judge: CHAT_AB_JUDGE.model, prompt: structuredIdentity(PAIR_JUDGE_INSTRUCTIONS), redaction: redaction.identity };
  const root = join(options.candidate, `compare-${basename(options.baseline)}-${CHAT_AB_JUDGE.model}`);
  const path = join(root, "run-config.json");
  const existing = await readJsonFile(path);
  const recorded = { ...config, baseline: recordedCampaignIdentity(baseline.manifest), candidate: recordedCampaignIdentity(candidate.manifest), redaction: recordedChatRedactionIdentity([baseline.manifest, candidate.manifest]) };
  if (existing !== undefined && ![config, recorded].some((value) => structuredIdentity(value) === structuredIdentity(Schema.decodeUnknownSync(Config, { onExcessProperty: "error" })(JSON.parse(existing))))) throw new Error("Comparison identity changed");
  const ledger = createJsonLinesLedger(async () => join(root, "judge-calls.jsonl"), Call, "reject");
  const calls = await ledger.load();
  const jobs = pairs.flatMap((pair) => ([0, 1] as const).map((order) => ({ pair, order }))).filter(({ pair, order }) => !calls.some((call) => call.task === pair.candidate.cell.task && call.repeat === pair.candidate.cell.repeat && call.order === order && call.verdict !== null));
  if (!options.reportOnly) {
    await mkdir(root, { recursive: true });
    if (existing === undefined) await createJsonFile(path, `${JSON.stringify(config, null, 2)}\n`);
  }
  if (!options.reportOnly && jobs.length > 0) {
    const inputs = await Promise.all(pairs.map(async (pair) => ({
      pair, baseline: await chatJudgeInputs(options.baseline, baseline.manifest, pair.baseline, redaction),
      candidate: await chatJudgeInputs(options.candidate, candidate.manifest, pair.candidate, redaction),
    })));
    await using judge = await admitJudge(options.authProfile, (model) => requireChatJudgeFamily([baseline.manifest, candidate.manifest], model), join(root, "judge-requests"));
    await eachJudgeJob(jobs, async ({ pair, order }) => {
      const input = inputs.find((row) => row.pair === pair)!;
      const { task, repeat } = pair.candidate.cell;
      const baselineFirst = baselineInSlotA(task, repeat, order);
      const result = await judgePair(judge, task, redaction, baselineFirst ? input.baseline : input.candidate, baselineFirst ? input.candidate : input.baseline);
      const call = { task, repeat, order, baselineFirst, ...result };
      await ledger.append(call);
      calls.push(call);
    });
  }
  const tally = { candidate: 0, baseline: 0, tie: 0, incomplete: 0 };
  for (const { candidate: run } of pairs) {
    const orders = ([0, 1] as const).map((order) => calls.findLast((call) => call.task === run.cell.task && call.repeat === run.cell.repeat && call.order === order && call.verdict !== null));
    const [first, second] = orders;
    if (!first?.verdict || !second?.verdict) tally.incomplete++;
    else tally[pairOutcome([sideOf(first.verdict.winner, first.baselineFirst), sideOf(second.verdict.winner, second.baselineFirst)])]++;
  }
  const priced = pairs.filter((pair) => pair.baseline.accounting.estimatedUsd.kind === "observed" && pair.candidate.accounting.estimatedUsd.kind === "observed");
  const total = (side: "baseline" | "candidate") => priced.reduce((sum, pair) => sum + (pair[side].accounting.estimatedUsd.kind === "observed" ? pair[side].accounting.estimatedUsd.value : 0), 0);
  const costIncrease = priced.length === pairs.length && total("baseline") > 0 ? total("candidate") / total("baseline") - 1 : null;
  const acceptance = pairs.flatMap((pair) => pair.baseline.grade && pair.candidate.grade ? [{ caseId: `${pair.candidate.cell.task}/${pair.candidate.cell.repeat}`, baseline: pair.baseline.grade.acceptance, candidate: pair.candidate.grade.acceptance }] : []);
  const decision = options.differ === "arm" && pairs.length > 0 && acceptance.length === pairs.length && tally.incomplete === 0 ? decide(tally, costIncrease, options.rule, acceptance) : null;
  const json = { config, sharedTasks: shared, tally, costIncrease, decision, calls, roleComparisons };
  const markdown = `# Chat comparison\n\nPaired cells: ${pairs.length}. Candidate wins: ${tally.candidate}. Baseline wins: ${tally.baseline}. Ties: ${tally.tie}. Incomplete: ${tally.incomplete}.\n\nAdoption: ${decision ? decision.adopt : "unavailable"}.\n${decision?.reasons.join("\n") ?? ""}\n\n${renderCampaignRoleChanges(roleComparisons)}`;
  if (!options.reportOnly) {
    await writeArtifactFile(join(root, "report.md"), markdown);
    await writeArtifactFile(join(root, "report.json"), `${JSON.stringify(json, null, 2)}\n`);
  }
  return { markdown, json };
}
