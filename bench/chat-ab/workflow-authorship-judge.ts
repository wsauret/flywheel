import { readFile } from "node:fs/promises";
import { structuredIdentity } from "../../src/orchestration/modules/development/benchmark/content-identity.js";
import { codingRedaction, type JudgeJob } from "./block-judge.js";
import { campaignBlinding, campaignRoleComparisons } from "./campaign-role-evidence.js";
import { readCampaignArtifact } from "./campaign-artifacts.js";
import { campaignCellKey, campaignIdentity } from "./campaign-store.js";
import { judgeCampaignPairs, type CampaignJudgeOptions, type CampaignJudgeDependencies } from "./campaign-pair-judge.js";
import { referenceFix } from "./pair-judge.js";
import { loadBenchTasks } from "./tasks.js";
import { TASKS_DIR } from "./harness-paths.js";
import { CHAT_AB_JUDGE } from "./judge-inputs.js";
import { workflowAuthorshipLedger } from "./workflow-authorship-store.js";

/** Judge the task's fix, not its workflow shape. All recorded workflow and phase labels are blinded in both slots. */
export async function judgeWorkflowAuthorshipCampaign(options: CampaignJudgeOptions, dependencies: CampaignJudgeDependencies = {}) {
  const { directory, a, b, authProfile } = options;
  const campaign = await workflowAuthorshipLedger.open(directory);
  const events = await campaign.load();
  const { completed } = workflowAuthorshipLedger.validate(campaign.manifest, events);
  if (a === b || ![a, b].every((id) => campaign.manifest.treatments.some((treatment) => treatment.id === id))) throw new Error("Judge requires two distinct campaign treatments");
  const outcomes = [...completed.values()];
  const models = campaign.manifest.treatments.flatMap((treatment) => [treatment.model, ...Object.values(treatment.roles ?? {}).flatMap(({ model }) => model ? [model] : [])]);
  const base = codingRedaction(models);
  const inherited = await campaignBlinding(directory, campaign.manifest.treatments, outcomes, models);
  const redaction = { identity: structuredIdentity({ workflow: base.identity, roles: inherited.identity }), redact: (text: string) => base.redact(inherited.redact(text)) };
  const roleComparisons = await campaignRoleComparisons(directory, campaign.manifest.treatments, outcomes);
  const code = await Promise.all([
    "./workflow-authorship-judge.ts", "./campaign-pair-judge.ts", "./campaign-artifacts.ts", "./campaign-role-evidence.ts",
    "./block-judge.ts", "./judge-inputs.ts", "./pair-judge.ts",
    "../../src/orchestration/modules/development/benchmark/judge.ts",
  ].map(async (path) => structuredIdentity(await readFile(new URL(path, import.meta.url), "utf8"))));
  const jobs = new Map<string, { job: JudgeJob<"a" | "b">; identity: string }>();
  const skipped: { task: string; repeat: number; reason: string }[] = [];
  const tasks = await loadBenchTasks(TASKS_DIR, campaign.manifest.tasks.map(({ id }) => id), campaign.manifest.message);
  for (const spec of campaign.manifest.tasks) {
    const task = tasks.find(({ id }) => id === spec.id)!;
    if (task.contentIdentity !== spec.contentIdentity) throw new Error(`Workflow authorship task changed: ${spec.id}`);
    let reference: string | undefined;
    for (let repeat = 0; repeat < campaign.manifest.repeats; repeat++) {
      const left = completed.get(campaignCellKey({ treatment: a, task: spec.id, repeat }));
      const right = completed.get(campaignCellKey({ treatment: b, task: spec.id, repeat }));
      if (!left || !right || !left.report || !right.report || !left.diff || !right.diff) {
        skipped.push({ task: spec.id, repeat, reason: "Both treatments need completed reports and diffs" });
        continue;
      }
      reference ??= await referenceFix(spec.id, redaction);
      const [reportA, reportB, diffA, diffB] = await Promise.all([left.report, right.report, left.diff, right.diff].map((artifact) => readCampaignArtifact(directory, artifact)));
      const references = ({ workflow }: typeof left) => ({
        ids: workflow.kind === "observed" ? workflow.workflows.map((run) => run.workflowId) : [],
        labels: workflow.kind === "observed" ? workflow.workflows.flatMap((run) => [run.definitionId, run.name, ...run.labels]) : [],
      });
      const job: JudgeJob<"a" | "b"> = { test: spec.id, task: spec.id, repeat, request: task.judgeContext, reference,
        reports: { a: reportA!, b: reportB! }, changes: { a: diffA!, b: diffB! },
        workflowReferences: { a: references(left), b: references(right) } };
      jobs.set(`${a}/${b}/${spec.id}/${repeat}`, { job, identity: structuredIdentity({ campaign: campaignIdentity(campaign.manifest), left, right, job, judge: CHAT_AB_JUDGE, redaction: redaction.identity, authProfile, code }) });
    }
  }
  return judgeCampaignPairs(options, { jobs, skipped, redaction, roleComparisons, arms: ["a", "b"],
    accounting: events.filter((event) => event.kind === "outcome").map((event) => event.accounting) }, dependencies);
}
