import { readFile } from "node:fs/promises";
import { Schema } from "effect";
import { canonicalModelId } from "../../src/infra/llm/model-id.js";
import { RuntimeSessionModelPlanResultSchema } from "../../src/protocol/model-assignment-protocol-schemas.js";
import { structuredIdentity } from "../../src/orchestration/modules/development/benchmark/content-identity.js";
import { codingRedaction, type JudgeJob } from "./block-judge.js";
import { codingLedger } from "./coding-ab-store.js";
import { campaignIdentity, campaignCellKey, type CampaignTreatmentRecord } from "./campaign-store.js";
import { codingMessage, findCodingTask } from "./coding-task.js";
import { CHAT_AB_JUDGE } from "./judge-inputs.js";
import { readAvailableCampaignArtifact, readCampaignArtifact } from "./campaign-artifacts.js";
import { judgeCampaignPairs, type CampaignJudgeOptions, type CampaignJudgeDependencies } from "./campaign-pair-judge.js";
import { campaignBlinding, campaignRoleComparisons, compareCampaignRoles } from "./campaign-role-evidence.js";
const hash = (bytes: string | Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
/** The marks of a Claude Code treatment with the Flywheel plugin: the paths of the built skill and agent files, and
 *  the `flywheel:` prefix of the plugin's skill and agent names, which a Flywheel treatment writes bare. */
const PLUGIN_MARKS: readonly (readonly [RegExp, string])[] = [
  [/[\w./-]*\/plugin\/(?:skills|agents)\/[^\s)`'"]*/g, "<skill path>"],
  [/\bflywheel:(?=[a-z0-9-])/g, ""],
];

/** One validated campaign directory: its manifest, its events, and its completed cells. */
async function openCodingCampaign(directory: string) {
  const campaign = await codingLedger.open(directory);
  const events = await campaign.load();
  return { directory, manifest: campaign.manifest, events, completed: codingLedger.validate(campaign.manifest, events).completed };
}
type CodingSide = Awaited<ReturnType<typeof openCodingCampaign>>;
type RoleComparison = Awaited<ReturnType<typeof compareCampaignRoles>>;

const pins = (treatment: CampaignTreatmentRecord) => treatment.subject === "claude-code" ? {} : { pins: treatment.roles };

const claudeCodeBinary = (treatment: Extract<CampaignTreatmentRecord, { subject: "claude-code" }>) =>
  `${treatment.binaryVersion.replace(/ \(Claude Code\)$/, "")} (${treatment.binarySha256.slice(0, 12)})`;

/** The Chat models and efforts that one treatment's cells ran with. */
interface ChatSettings { readonly models: Set<string>; readonly efforts: Set<string> }
const describeSettings = ({ models, efforts }: ChatSettings) =>
  `${[...models].sort().join(", ")} at ${[...efforts].sort().join(", ") || "an unrecorded effort"}`;

/** The two treatments that a baseline judge pairs, from two version 2 campaigns. */
function baselinePairing(own: CodingSide, baseline: CodingSide, a: string, b: string) {
  if (own.manifest.version !== 2 || baseline.manifest.version !== 2) throw new Error("Baseline judging needs two version 2 campaigns");
  const left = own.manifest.treatments.find(({ id }) => id === a);
  const right = baseline.manifest.treatments.find(({ id }) => id === b);
  if (!left || !right) throw new Error(`Judge requires treatment ${a} in the campaign and treatment ${b} in the baseline campaign`);
  return { a: left, b: right };
}

/** Refuse a baseline pairing whose two treatments differ in more than the treatment under test: the task, the Chat
 *  model and effort, and for two Claude Code subjects the binary. The plugin is the difference under test. */
function requireComparableBaseline(own: CodingSide, baseline: CodingSide, a: CampaignTreatmentRecord, b: CampaignTreatmentRecord, settings: readonly ChatSettings[]) {
  const [left, right] = settings.map(describeSettings);
  if (left !== right) throw new Error(`Baseline mismatch: ${a.id} runs ${left} but baseline ${b.id} runs ${right}`);
  if (a.subject === "claude-code" && b.subject === "claude-code" && (a.binarySha256 !== b.binarySha256 || a.binaryVersion !== b.binaryVersion)) {
    throw new Error(`Baseline mismatch: Claude Code ${claudeCodeBinary(a)} vs ${claudeCodeBinary(b)}`);
  }
  for (const spec of own.manifest.tasks) {
    const pinned = baseline.manifest.tasks.find(({ id }) => id === spec.id);
    if (pinned && structuredIdentity(pinned) !== structuredIdentity(spec)) throw new Error(`Baseline mismatch: task ${spec.id} has another content or qualification identity in the baseline campaign`);
  }
}

/** Validate all candidate and judge evidence before admission. Dry runs neither admit nor write.
 * Completed execution remains eligible when acceptance fails. Failed judge calls retain their costs on retry.
 * With `baseline`, treatment a of `directory` meets treatment b of the baseline campaign by task and repeat. */
export async function judgeCodingCampaign(options: CampaignJudgeOptions, dependencies: CampaignJudgeDependencies = {}) {
  const { directory, a, b, authProfile } = options;
  const own = await openCodingCampaign(directory);
  const baseline = options.baseline === undefined ? undefined : await openCodingCampaign(options.baseline);
  const other = baseline ?? own;
  const pairing = baseline && baselinePairing(own, baseline, a, b);
  if (!baseline && (a === b || ![a, b].every((id) => own.manifest.treatments.some((treatment) => treatment.id === id)))) throw new Error("Judge requires two distinct campaign treatments");
  // Same-campaign judging keeps manifest order, which its retained redaction identity depends on.
  const judged = pairing ? [{ side: own, treatment: pairing.a }, { side: other, treatment: pairing.b }]
    : own.manifest.treatments.filter(({ id }) => id === a || id === b).map((treatment) => ({ side: own, treatment }));
  const models = new Set<string>();
  // Each judged treatment's Chat settings, which a baseline pairing must share. A run without its plan records
  // its models but not their effort.
  const settings: ChatSettings[] = judged.map(() => ({ models: new Set(), efforts: new Set() }));
  for (const [position, { side, treatment }] of judged.entries()) {
    const setting = (model: string, effort?: string) => {
      settings[position]!.models.add(canonicalModelId(model));
      if (effort !== undefined) settings[position]!.efforts.add(effort);
    };
    if ("subject" in treatment && treatment.subject === "claude-code") {
      models.add(treatment.model);
      setting(treatment.model, treatment.effort);
      continue;
    }
    for (const outcome of side.completed.values()) {
      if (outcome.cell.treatment !== treatment.id) continue;
      const invocations = "runs" in outcome ? outcome.runs.map((run) => run.artifacts) : [outcome.evidence];
      for (const [index, artifacts] of invocations.entries()) {
        const artifact = artifacts.find(({ path }) => path.endsWith("/plan.json"));
        const message = `Cannot blind treatment ${treatment.id}: missing, changed, or invalid ${artifact?.path ?? "plan.json"}`;
        const recordedModels = "runs" in outcome ? outcome.runs[index]?.models ?? [] : [];
        try {
          const text = artifact && await readAvailableCampaignArtifact(side.directory, artifact);
          if (text === undefined) {
            if (recordedModels.length === 0) throw new Error(message);
            for (const model of recordedModels) { models.add(model); setting(model); }
            continue;
          }
          const plan = Schema.decodeUnknownSync(RuntimeSessionModelPlanResultSchema, { onExcessProperty: "error" })(JSON.parse(text));
          const chat = plan.assignments.find(({ slot }) => slot.roleId === "chat");
          if (!chat?.model.trim()) throw new Error(message);
          models.add(chat.model);
          setting(chat.model, chat.effort);
        } catch {
          throw new Error(message);
        }
      }
    }
  }
  if (pairing) requireComparableBaseline(own, other, pairing.a, pairing.b, settings);
  const sides = baseline ? [own, baseline] : [own];
  const native = (side: CodingSide) => [...side.completed.values()].filter((outcome) => "runs" in outcome);
  const blindings = await Promise.all(sides.flatMap((side) => side.manifest.version === 2 ? [campaignBlinding(side.directory, side.manifest.treatments, native(side), [side.manifest.model])] : []));
  const base = codingRedaction([...models, ...sides.map(({ manifest }) => manifest.model)]);
  const blinding = blindings.length === 0 ? base.identity : baseline ? structuredIdentity(blindings.map(({ identity }) => identity)) : blindings[0]!.identity;
  const redaction = {
    identity: structuredIdentity({ blinding, plugin: PLUGIN_MARKS.map(([pattern, replacement]) => [pattern.source, pattern.flags, replacement]) }),
    redact: (text: string) => PLUGIN_MARKS.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement),
      base.redact(blindings.reduce((current, { redact }) => redact(current), text))),
  };
  const roleComparisons: RoleComparison[] = baseline || own.manifest.version !== 2 ? [] : await campaignRoleComparisons(directory, own.manifest.treatments.filter(({ id }) => id === a || id === b), native(own));
  const code = await Promise.all([
    "./coding-ab-judge.ts", "./campaign-pair-judge.ts", "./campaign-artifacts.ts", "./campaign-role-evidence.ts", "./block-judge.ts", "./judge-inputs.ts", "./pair-judge.ts", "./coding-task.ts",
    "../../src/orchestration/modules/development/benchmark/judge.ts",
  ].map(async (path) => hash(await readFile(new URL(path, import.meta.url)))));
  const jobs = new Map<string, { job: JudgeJob; identity: string }>();
  const skipped: { task: string; repeat: number; reason: string }[] = [];
  for (const spec of own.manifest.tasks) {
    const task = await findCodingTask(spec.id);
    if (!task || task.role !== spec.role || task.contentIdentity !== spec.contentIdentity || task.qualificationIdentity !== spec.qualificationIdentity) throw new Error(`Coding task identity changed: ${spec.id}`);
    const pinned = other.manifest.tasks.some(({ id }) => id === spec.id);
    for (let repeat = 0; repeat < own.manifest.repeats; repeat++) {
      if (!pinned || repeat >= other.manifest.repeats) {
        skipped.push({ task: spec.id, repeat, reason: pinned ? "the baseline campaign holds no such repeat" : "the baseline campaign has no such task" });
        continue;
      }
      const left = own.completed.get(campaignCellKey({ treatment: a, task: spec.id, repeat }));
      const right = other.completed.get(campaignCellKey({ treatment: b, task: spec.id, repeat }));
      if (baseline && left && !right) throw new Error(`Baseline treatment ${b} has no completed cell for ${spec.id} repeat ${repeat}; resume the baseline campaign first`);
      if (!left || !right) { skipped.push({ task: spec.id, repeat, reason: "both treatments need completed execution" }); continue; }
      const unreported = [left, right].flatMap((outcome) => "runs" in outcome ? [outcome.runs.at(-1)?.outcome] : []).find((outcome) => outcome === "input_required" || outcome === "incomplete");
      if (unreported) {
        skipped.push({ task: spec.id, repeat, reason: `${unreported} has no accepted handoff report` });
        continue;
      }
      if (!left.report || !right.report || !left.diff || !right.diff) throw new Error(`Completed pair lacks judge artifacts: ${spec.id}/${repeat}`);
      const [reportA, diffA, reportB, diffB] = await Promise.all([
        readCampaignArtifact(own.directory, left.report), readCampaignArtifact(own.directory, left.diff),
        readCampaignArtifact(other.directory, right.report), readCampaignArtifact(other.directory, right.diff),
      ]);
      if (pairing && "runs" in left && "runs" in right) roleComparisons.push(await compareCampaignRoles({ directory: other.directory, outcome: right, ...pins(pairing.b) }, { directory: own.directory, outcome: left, ...pins(pairing.a) }));
      const job: JudgeJob = { test: spec.id, task: spec.id, repeat, request: codingMessage(task), reference: task.referencePatch, reports: { "claude-code": reportA, flywheel: reportB }, changes: { "claude-code": diffA, flywheel: diffB } };
      const pair = `${a}/${b}/${spec.id}/${repeat}`;
      jobs.set(pair, { job, identity: structuredIdentity({
        campaign: campaignIdentity(own.manifest), ...(baseline ? { baseline: campaignIdentity(baseline.manifest) } : {}),
        a, b, spec, left, right, request: hash(job.request), reference: hash(task.referencePatch), judge: CHAT_AB_JUDGE, redaction: redaction.identity, authProfile, code,
      }) });
    }
  }
  return judgeCampaignPairs(options, {
    jobs, skipped, redaction, roleComparisons, arms: ["claude-code", "flywheel"],
    accounting: [...own.events, ...(baseline?.events.filter((event) => event.cell.treatment === b) ?? [])].flatMap((event) => event.kind === "outcome" ? [event.accounting] : []),
    ...(baseline ? { baselineIdentity: campaignIdentity(baseline.manifest) } : {}),
  }, dependencies);
}
