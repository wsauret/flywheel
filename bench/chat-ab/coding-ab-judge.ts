import { readFile } from "node:fs/promises";
import { Schema } from "effect";
import { RuntimeSessionModelPlanResultSchema } from "../../src/protocol/model-assignment-protocol-schemas.js";
import { structuredIdentity } from "../../src/orchestration/modules/development/benchmark/content-identity.js";
import { codingRedaction, type JudgeJob } from "./block-judge.js";
import { codingLedger } from "./coding-ab-store.js";
import { campaignIdentity, campaignCellKey } from "./campaign-store.js";
import { codingMessage, findCodingTask } from "./coding-task.js";
import { CHAT_AB_JUDGE } from "./judge-inputs.js";
import { readAvailableCampaignArtifact, readCampaignArtifact } from "./campaign-artifacts.js";
import { judgeCampaignPairs, type CampaignJudgeOptions, type CampaignJudgeDependencies } from "./campaign-pair-judge.js";
import { campaignBlinding, campaignRoleComparisons } from "./campaign-role-evidence.js";
const hash = (bytes: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
/** The marks of a Claude Code treatment with the Flywheel plugin: the paths of the built skill and agent files, and
 *  the `flywheel:` prefix of the plugin's skill and agent names, which a Flywheel treatment writes bare. */
const PLUGIN_MARKS: readonly (readonly [RegExp, string])[] = [
  [/[\w./-]*\/plugin\/(?:skills|agents)\/[^\s)`'"]*/g, "<skill path>"],
  [/\bflywheel:(?=[a-z0-9-])/g, ""],
];

/** Validate all candidate and judge evidence before admission. Dry runs neither admit nor write.
 * Completed execution remains eligible when acceptance fails. Failed judge calls retain their costs on retry. */
export async function judgeCodingCampaign(options: CampaignJudgeOptions, dependencies: CampaignJudgeDependencies = {}) {
  const { directory, a, b, authProfile } = options;
  const campaign = await codingLedger.open(directory);
  const events = await campaign.load();
  const { completed } = codingLedger.validate(campaign.manifest, events);
  if (a === b || ![a, b].every((id) => campaign.manifest.treatments.some((treatment) => treatment.id === id))) throw new Error("Judge requires two distinct campaign treatments");
  const models = new Set<string>();
  for (const treatment of campaign.manifest.treatments.filter(({ id }) => id === a || id === b)) {
    if ("subject" in treatment && treatment.subject === "claude-code") {
      models.add(treatment.model);
      continue;
    }
    for (const outcome of completed.values()) {
      if (outcome.cell.treatment !== treatment.id) continue;
      const invocations = "runs" in outcome ? outcome.runs.map((run) => run.artifacts) : [outcome.evidence];
      for (const [index, artifacts] of invocations.entries()) {
        const artifact = artifacts.find(({ path }) => path.endsWith("/plan.json"));
        const message = `Cannot blind treatment ${treatment.id}: missing, changed, or invalid ${artifact?.path ?? "plan.json"}`;
        if (!artifact) {
          if ("runs" in outcome && outcome.runs[index]?.models?.length) {
            for (const model of outcome.runs[index]!.models!) models.add(model);
            continue;
          }
          throw new Error(message);
        }
        try {
          const text = await readAvailableCampaignArtifact(directory, artifact);
          if (text === undefined && "runs" in outcome && outcome.runs[index]?.models?.length) {
            for (const model of outcome.runs[index]!.models!) models.add(model);
            continue;
          }
          if (text === undefined) throw new Error(message);
          const plan = Schema.decodeUnknownSync(RuntimeSessionModelPlanResultSchema, { onExcessProperty: "error" })(JSON.parse(text));
          const model = plan.assignments.find(({ slot }) => slot.roleId === "chat")?.model;
          if (!model?.trim()) throw new Error(message);
          models.add(model);
        } catch {
          throw new Error(message);
        }
      }
    }
  }
  const native = [...completed.values()].filter((outcome) => "runs" in outcome);
  const inherited = campaign.manifest.version === 2 ? await campaignBlinding(directory, campaign.manifest.treatments, native, [campaign.manifest.model]) : null;
  const base = codingRedaction([...models, campaign.manifest.model]);
  const redaction = {
    identity: structuredIdentity({ blinding: inherited?.identity ?? base.identity, plugin: PLUGIN_MARKS.map(([pattern, replacement]) => [pattern.source, pattern.flags, replacement]) }),
    redact: (text: string) => PLUGIN_MARKS.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), base.redact(inherited ? inherited.redact(text) : text)),
  };
  const roleComparisons = campaign.manifest.version === 2 ? await campaignRoleComparisons(directory, campaign.manifest.treatments.filter(({ id }) => id === a || id === b), native) : [];
  const code = await Promise.all([
    "./coding-ab-judge.ts", "./campaign-pair-judge.ts", "./campaign-artifacts.ts", "./campaign-role-evidence.ts", "./block-judge.ts", "./judge-inputs.ts", "./pair-judge.ts", "./coding-task.ts",
    "../../src/orchestration/modules/development/benchmark/judge.ts",
  ].map(async (path) => hash(await readFile(new URL(path, import.meta.url)))));
  const jobs = new Map<string, { job: JudgeJob; identity: string }>();
  const skipped: { task: string; repeat: number; reason: string }[] = [];
  for (const spec of campaign.manifest.tasks) {
    const task = await findCodingTask(spec.id);
    if (!task || task.role !== spec.role || task.contentIdentity !== spec.contentIdentity || task.qualificationIdentity !== spec.qualificationIdentity) throw new Error(`Coding task identity changed: ${spec.id}`);
    for (let repeat = 0; repeat < campaign.manifest.repeats; repeat++) {
      const left = completed.get(campaignCellKey({ treatment: a, task: spec.id, repeat }));
      const right = completed.get(campaignCellKey({ treatment: b, task: spec.id, repeat }));
      if (!left || !right) { skipped.push({ task: spec.id, repeat, reason: "both treatments need completed execution" }); continue; }
      const unreported = [left, right].flatMap((outcome) => "runs" in outcome ? [outcome.runs.at(-1)?.outcome] : []).find((outcome) => outcome === "input_required" || outcome === "incomplete");
      if (unreported) {
        skipped.push({ task: spec.id, repeat, reason: `${unreported} has no accepted handoff report` });
        continue;
      }
      if (!left.report || !right.report || !left.diff || !right.diff) throw new Error(`Completed pair lacks judge artifacts: ${spec.id}/${repeat}`);
      const [reportA, reportB, diffA, diffB] = await Promise.all([left.report, right.report, left.diff, right.diff].map((value) => readCampaignArtifact(directory, value)));
      const job: JudgeJob = { test: spec.id, task: spec.id, repeat, request: codingMessage(task), reference: task.referencePatch, reports: { "claude-code": reportA!, flywheel: reportB! }, changes: { "claude-code": diffA!, flywheel: diffB! } };
      const pair = `${a}/${b}/${spec.id}/${repeat}`;
      jobs.set(pair, { job, identity: structuredIdentity({ campaign: campaignIdentity(campaign.manifest), a, b, spec, left, right, request: hash(job.request), reference: hash(task.referencePatch), judge: CHAT_AB_JUDGE, redaction: redaction.identity, authProfile, code }) });
    }
  }
  return judgeCampaignPairs(options, {
    jobs, skipped, redaction, roleComparisons, arms: ["claude-code", "flywheel"],
    accounting: events.filter((event) => event.kind === "outcome").map((event) => event.accounting),
  }, dependencies);
}
