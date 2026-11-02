import { readFile } from "node:fs/promises";
import { structuredIdentity } from "../../src/orchestration/modules/development/benchmark/content-identity.js";
import type { JudgeJob } from "./block-judge.js";
import { readCampaignArtifact } from "./campaign-artifacts.js";
import { judgeCampaignPairs, type CampaignJudgeDependencies } from "./campaign-pair-judge.js";
import { campaignRoleComparisons } from "./campaign-role-evidence.js";
import { campaignCellKey, campaignIdentity } from "./campaign-store.js";
import { requireChatJudgeFamily } from "./chat-judge-inputs.js";
import { CHAT_AB_JUDGE } from "./judge-inputs.js";
import { openPlanningCampaign, planningRedaction, scorePlanningRecall } from "./planning-recall.js";
import { renderRequirements } from "./planning-task.js";

export interface PlanningJudgeOptions {
  readonly directory: string;
  /** The two treatments of the pairwise comparison; the campaign's first two treatments when omitted. */
  readonly a?: string;
  readonly b?: string;
  readonly authProfile: string;
  readonly dryRun?: boolean;
}

/** Blinded pairwise plan comparison: both slot orders, an adversarial pass, and one paid-call ledger. A pair whose
 *  cells lack a plan is skipped. The judge reads the known requirements, never a fix. The caller resolves a and b to
 *  two distinct campaign treatments. A verdict's identity names the inputs and the judge, never the profile label it
 *  was admitted under: the ledger's profile and authority check guards paid writes. */
export async function judgePlanningPairs(options: PlanningJudgeOptions & { readonly a: string; readonly b: string }, dependencies: CampaignJudgeDependencies = {}) {
  const { directory, a, b } = options;
  const { manifest, events, outcomes, tasks } = await openPlanningCampaign(directory);
  requireChatJudgeFamily([manifest]);
  const completed = new Map(outcomes.map((outcome) => [campaignCellKey(outcome.cell), outcome]));
  const redaction = await planningRedaction(directory, manifest, outcomes);
  const code = await Promise.all([
    "./planning-judge.ts", "./planning-recall.ts", "./planning-task.ts", "./campaign-pair-judge.ts", "./campaign-artifacts.ts",
    "./campaign-role-evidence.ts", "./block-judge.ts", "./judge-inputs.ts", "./pair-judge.ts",
    "../../src/orchestration/modules/development/benchmark/judge.ts",
  ].map(async (path) => structuredIdentity(await readFile(new URL(path, import.meta.url), "utf8"))));
  const jobs = new Map<string, { job: JudgeJob<"a" | "b">; identity: string }>();
  const skipped: { task: string; repeat: number; reason: string }[] = [];
  for (const task of tasks) {
    for (let repeat = 0; repeat < manifest.repeats; repeat++) {
      const left = completed.get(campaignCellKey({ treatment: a, task: task.id, repeat }));
      const right = completed.get(campaignCellKey({ treatment: b, task: task.id, repeat }));
      if (!left?.plan || !right?.plan) {
        skipped.push({ task: task.id, repeat, reason: "Both treatments need completed cells with a plan" });
        continue;
      }
      const [planA, planB] = await Promise.all([left.plan, right.plan].map((plan) => readCampaignArtifact(directory, plan)));
      const job: JudgeJob<"a" | "b"> = { test: task.id, task: task.id, repeat, request: task.brief, requirements: renderRequirements(task.manifest), reports: { a: planA!, b: planB! } };
      jobs.set(`${a}/${b}/${task.id}/${repeat}`, { job, identity: structuredIdentity({ campaign: campaignIdentity(manifest), left, right, job, judge: CHAT_AB_JUDGE, redaction: redaction.identity, code }) });
    }
  }
  return judgeCampaignPairs({ ...options, a, b }, {
    jobs, skipped, redaction, arms: ["a", "b"], roleComparisons: await campaignRoleComparisons(directory, manifest.treatments, outcomes),
    accounting: events.filter((event) => event.kind === "outcome").map((event) => event.accounting),
  }, dependencies);
}

/** Recall for every cell, then the pairwise comparison when the campaign has two treatments. Candidate and judge
 *  accounting stay separate. Refuses an unknown or repeated treatment before any judge call. */
export async function judgePlanningCampaign(options: PlanningJudgeOptions, dependencies: CampaignJudgeDependencies = {}) {
  const { manifest } = await openPlanningCampaign(options.directory);
  const [first, second] = manifest.treatments;
  const a = options.a ?? first!.id;
  const b = options.b ?? second?.id;
  const chosen = b === undefined ? [a] : [a, b];
  if (a === b || !chosen.every((id) => manifest.treatments.some((treatment) => treatment.id === id))) throw new Error("Judge requires distinct campaign treatments");
  const { replies: _, ...recallSummary } = await scorePlanningRecall(options.directory, options);
  return { recall: recallSummary, pairwise: b === undefined ? null : await judgePlanningPairs({ ...options, a, b }, dependencies) };
}
