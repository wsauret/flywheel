import { join } from "node:path";
import { Schema } from "effect";
import { readJsonFile } from "../../src/orchestration/modules/development/benchmark/json-lines.js";
import { AcceptanceRecordSchema } from "./acceptance.js";
import { EffortSchema } from "../../src/infra/workflow-types.js";
import { CampaignAttemptSchema, CampaignCount, CampaignHash, CampaignId, CampaignManifestV2Fields, CampaignOutcomeV2Fields, CampaignText, CampaignTreatmentFields, ClaudeCodeTreatmentFields, createCampaignLedger } from "./campaign-store.js";

export const ChatTaskSchema = Schema.Struct({ id: CampaignId, stratum: CampaignText, contentIdentity: CampaignHash, timeoutMs: CampaignCount });
export const ChatGradeSchema = Schema.NullOr(Schema.Struct({
  acceptance: AcceptanceRecordSchema,
  diffStats: Schema.Struct({ linesAdded: CampaignCount, linesRemoved: CampaignCount, filesTouched: CampaignCount }),
}));
const Manifest = Schema.Struct({
  ...CampaignManifestV2Fields, kind: Schema.Literal("chat-ab"), effort: EffortSchema,
  treatments: Schema.Array(Schema.Union([Schema.Struct({
    ...CampaignTreatmentFields,
    arm: Schema.Struct({ id: CampaignId, identity: Schema.NullOr(CampaignHash), invokeSkill: Schema.NullOr(CampaignText) }),
    model: CampaignText, effort: EffortSchema, authProfile: CampaignText,
  }), Schema.Struct({
    ...ClaudeCodeTreatmentFields,
    arm: Schema.Struct({ id: CampaignId, identity: Schema.NullOr(CampaignHash), invokeSkill: Schema.NullOr(CampaignText) }),
    effort: EffortSchema, authProfile: CampaignText,
  })])),
  tasks: Schema.Array(ChatTaskSchema),
});
const Outcome = Schema.Struct({
  ...CampaignOutcomeV2Fields,
  grade: ChatGradeSchema,
});
export type ChatCampaign = typeof Manifest.Type;
export type ChatOutcome = typeof Outcome.Type;

/** The shared ledger is the only execution authority for new Chat campaigns. */
export const chatLedger = createCampaignLedger<ChatCampaign, ChatOutcome>({
  manifest: Manifest, outcome: () => Outcome, events: Schema.Union([CampaignAttemptSchema, Outcome]),
  requireWritable: () => {},
});

/** Historical private campaigns can be read, but must never resume under headless semantics. */
export async function requireNewChatCampaign(directory: string): Promise<void> {
  if (await readJsonFile(join(directory, "run-config.json")) !== undefined || await readJsonFile(join(directory, "paired-config.json")) !== undefined) {
    throw new Error("Historical chat-ab campaigns are read-only; start a new results directory");
  }
}

export async function isChatCampaign(directory: string): Promise<boolean> {
  const text = await readJsonFile(join(directory, "campaign.json"));
  if (text === undefined) return false;
  const value: unknown = JSON.parse(text);
  return typeof value === "object" && value !== null && "kind" in value && value.kind === "chat-ab";
}
