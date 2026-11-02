import { Schema } from "effect";
import { CampaignArtifactSchema, CampaignAttemptSchema, CampaignCount, CampaignManifestV2Fields, CampaignOutcomeV2Fields, CampaignText, CampaignTreatmentFields, createCampaignLedger } from "./campaign-store.js";
import { ChatTaskSchema } from "./chat-store.js";

const Manifest = Schema.Struct({
  ...CampaignManifestV2Fields, kind: Schema.Literal("planning"),
  treatments: Schema.Array(Schema.Struct({ ...CampaignTreatmentFields, model: Schema.String, effort: Schema.String, authProfile: Schema.String })),
  tasks: Schema.Array(ChatTaskSchema),
});
const Outcome = Schema.Struct({
  ...CampaignOutcomeV2Fields,
  /** The retained `PLAN.md`, or null with the reason in `planMissing`. */
  plan: Schema.NullOr(CampaignArtifactSchema),
  planMissing: Schema.NullOr(CampaignText),
  /** Every change besides `PLAN.md`: implementation that the instruction forbids. Null when nothing was captured. */
  otherChanges: Schema.NullOr(Schema.Struct({ linesAdded: CampaignCount, linesRemoved: CampaignCount, filesTouched: CampaignCount })),
});
export type PlanningCampaign = typeof Manifest.Type;
export type PlanningOutcome = typeof Outcome.Type;

/** Unanswered, incomplete, and non-compliant cells stay completed; their plans are still scored. */
export const planningLedger = createCampaignLedger<PlanningCampaign, PlanningOutcome>({
  manifest: Manifest, outcome: () => Outcome, events: Schema.Union([CampaignAttemptSchema, Outcome]), requireWritable: () => {},
});
