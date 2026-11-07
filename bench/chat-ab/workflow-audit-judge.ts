import { readFile } from "node:fs/promises";
import { Schema } from "effect";
import { structuredIdentity } from "../../src/orchestration/modules/development/benchmark/content-identity.js";
import { readCampaignArtifact } from "./campaign-artifacts.js";
import { campaignCellKey, campaignIdentity } from "./campaign-store.js";
import type { JudgeJob } from "./block-judge.js";
import { campaignBlinding, campaignRoleComparisons } from "./campaign-role-evidence.js";
import { COMPARISON_TASK } from "./workflow-audit-tests.js";
import { judgeCampaignPairs, type CampaignJudgeDependencies, type CampaignJudgeOptions } from "./campaign-pair-judge.js";
import { CHAT_AB_JUDGE } from "./judge-inputs.js";
import { referenceFix } from "./pair-judge.js";
import { loadWorkflowAuditTasks, workflowAuditAnswer, workflowAuditFamily } from "./workflow-audit-family.js";
import { workflowAuditLedger } from "./workflow-audit-store.js";

/** Judge hash-verified handoff answers in both orders, with refutation and a resumable shared judge ledger.
 *  A bug audit is judged against the fixture's reference fix; an answer test against its written reference answer. */
export async function judgeWorkflowAuditCampaign(options: CampaignJudgeOptions, dependencies: CampaignJudgeDependencies = {}) {
  const { directory, a, b, authProfile } = options;
  const campaign = await workflowAuditLedger.open(directory);
  const events = await campaign.load();
  const { completed } = workflowAuditLedger.validate(campaign.manifest, events);
  if (a === b || ![a, b].every((id) => campaign.manifest.treatments.some((treatment) => treatment.id === id))) throw new Error("Judge requires two distinct campaign treatments");
  const treatments = campaign.manifest.treatments.filter(({ id }) => id === a || id === b);
  const redaction = await campaignBlinding(directory, treatments, [...completed.values()], [campaign.manifest.model]);
  const roleComparisons = await campaignRoleComparisons(directory, treatments, [...completed.values()]);
  const code = await Promise.all([
    "./workflow-audit-judge.ts", "./workflow-audit-family.ts", "./workflow-audit-tests.ts", "./campaign-pair-judge.ts",
    "./campaign-artifacts.ts", "./campaign-role-evidence.ts", "./block-judge.ts", "./judge-inputs.ts", "./pair-judge.ts",
    "../../src/orchestration/modules/development/benchmark/judge.ts",
  ].map(async (path) => structuredIdentity(await readFile(new URL(path, import.meta.url), "utf8"))));
  const tasks = await loadWorkflowAuditTasks(campaign.manifest.tasks.map(({ id }) => id));
  // Only a bug audit reads the reference fix, once; an answer test carries its own reference answer.
  let fix: Promise<string> | undefined;
  const jobs = new Map<string, { job: JudgeJob<"a" | "b">; identity: string }>();
  const skipped: { task: string; repeat: number; reason: string }[] = [];
  for (const spec of campaign.manifest.tasks) {
    const task = tasks.find(({ id }) => id === spec.id)!;
    if (task.contentIdentity !== spec.contentIdentity) throw new Error(`Workflow audit task identity changed: ${spec.id}`);
    for (let repeat = 0; repeat < campaign.manifest.repeats; repeat++) {
      const left = completed.get(campaignCellKey({ treatment: a, task: spec.id, repeat }));
      const right = completed.get(campaignCellKey({ treatment: b, task: spec.id, repeat }));
      if (!left || !right) { skipped.push({ task: spec.id, repeat, reason: "both treatments need completed execution" }); continue; }
      const unreported = [left, right].map((outcome) => outcome.runs.at(-1)?.outcome).find((outcome) => outcome === "input_required" || outcome === "incomplete");
      if (unreported) { skipped.push({ task: spec.id, repeat, reason: `${unreported} has no accepted handoff report` }); continue; }
      if (!left.report || !right.report) throw new Error(`Completed pair lacks judge artifacts: ${spec.id}/${repeat}`);
      const answers = await Promise.all([left.report, right.report].map(async (artifact) => workflowAuditAnswer(Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(JSON.parse(await readCampaignArtifact(directory, artifact))))));
      const request = String(workflowAuditFamily.message(task, a, "flywheel"));
      const reports = { a: answers[0]!, b: answers[1]! };
      const job: JudgeJob<"a" | "b"> = task.reference === null
        ? { test: spec.id, task: COMPARISON_TASK, repeat, request, reference: await (fix ??= referenceFix(COMPARISON_TASK, redaction)), reports }
        : { test: spec.id, task: COMPARISON_TASK, repeat, request, referenceAnswer: task.reference, reports };
      jobs.set(`${a}/${b}/${spec.id}/${repeat}`, { job, identity: structuredIdentity({ campaign: campaignIdentity(campaign.manifest), a, b, spec, left, right, job, judge: CHAT_AB_JUDGE, redaction: redaction.identity, authProfile, code }) });
    }
  }
  return judgeCampaignPairs(options, { jobs, skipped, redaction, roleComparisons, arms: ["a", "b"], accounting: events.filter((event) => event.kind === "outcome").map((event) => event.accounting) }, dependencies);
}
