import { structuredIdentity } from "../../src/orchestration/modules/development/benchmark/content-identity.js";
import { codingRedaction } from "./block-judge.js";
import { readCampaignArtifact } from "./campaign-artifacts.js";
import type { ChatCampaign, ChatOutcome } from "./chat-store.js";
import { CHAT_AB_JUDGE, type Redaction, type RunInputs } from "./judge-inputs.js";
import { loadBenchTasks } from "./tasks.js";
import { TASKS_DIR } from "./harness-paths.js";
import { detectModelFamily } from "../../src/infra/llm/model-family.js";
import { campaignBlinding } from "./campaign-role-evidence.js";
import type { CampaignExecutionOutcome } from "./campaign-store.js";

/** Hide model and skill-arm labels from retained native artifacts without projecting private-runner fields. */
export async function chatRedaction(manifests: readonly ChatCampaign[], cells: readonly { directory: string; outcome: CampaignExecutionOutcome }[]): Promise<Redaction> {
  const treatmentModels = [...new Set(manifests.flatMap((manifest) => manifest.treatments.flatMap((treatment) => [
    treatment.model, ...(treatment.subject === "claude-code" ? [] : Object.values(treatment.roles ?? {}).flatMap(({ model }) => model ? [model] : [])),
  ])))];
  const redactions = await Promise.all(cells.map(({ directory, outcome }) => campaignBlinding(directory, manifests.flatMap(({ treatments }) => treatments), [outcome])));
  const labels = [...new Set(manifests.flatMap((manifest) => manifest.treatments.flatMap(({ arm }) => [arm.id, ...(arm.invokeSkill ? [arm.invokeSkill] : [])])))];
  const patterns = labels.map((label) => new RegExp(`\\b${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"));
  return {
    // Inherited role edits change blinding labels, not the comparison or scoring identity.
    identity: structuredIdentity({ models: treatmentModels, labels, redactions: treatmentModels.map((model) => codingRedaction(model).identity) }),
    redact: (text) => patterns.reduce((value, pattern) => value.replace(pattern, "<arm>"), redactions.reduce((value, redaction) => redaction.redact(value), text)).replace(/[^\s"'`]*\/workspace\/[^\s"'`]*/g, "<sandbox path>"),
  };
}

/** Reconstruct the pre-2026-10-14 fingerprint only to read retained successful receipts.
 * Remove this conversion after 2027-10-14. */
export function recordedChatRedactionIdentity(manifests: readonly ChatCampaign[]): string {
  const models = [...new Set(manifests.flatMap(({ treatments }) => treatments.flatMap((treatment) => [
    treatment.model, ...(treatment.subject === "claude-code" ? [] : Object.values(treatment.resolvedRoles ?? {}).map(({ model }) => model)),
  ])))];
  const labels = [...new Set(manifests.flatMap(({ treatments }) => treatments.flatMap(({ arm }) => [arm.id, ...(arm.invokeSkill ? [arm.invokeSkill] : [])])))];
  return structuredIdentity({ models, labels, redactions: models.map((model) => codingRedaction(model).identity) });
}

/** The judge must come from a model family that no treatment's requested model uses; read-only reports need no eligible judge.
 *  Roles may differ between sides. Reports disclose those differences; role models remain hidden from the judge. */
export function requireChatJudgeFamily(manifests: readonly { readonly treatments: readonly { readonly model: string }[] }[], judgeModel = CHAT_AB_JUDGE.model): void {
  const family = detectModelFamily(judgeModel);
  if (!family || manifests.some((manifest) => manifest.treatments.some(({ model }) => detectModelFamily(model) === family))) throw new Error("The judge must belong to a different model family");
}

/** Require matching task bytes and hash-verified diff/handoff artifacts before a judge sees the result. */
export async function chatJudgeInputs(directory: string, manifest: ChatCampaign, outcome: ChatOutcome, redaction: Redaction): Promise<RunInputs> {
  const [task] = await loadBenchTasks(TASKS_DIR, [outcome.cell.task], manifest.message, manifest.challenge);
  if (task!.contentIdentity !== manifest.tasks.find(({ id }) => id === outcome.cell.task)?.contentIdentity) throw new Error(`Task identity changed: ${outcome.cell.task}`);
  if (!outcome.diff) throw new Error("Completed Chat cell has no retained diff");
  return {
    request: redaction.redact(task!.message), diff: redaction.redact(await readCampaignArtifact(directory, outcome.diff)),
    ...(outcome.report ? { handoff: redaction.redact(await readCampaignArtifact(directory, outcome.report)) } : {}),
  };
}
