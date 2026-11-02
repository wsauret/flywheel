import { Schema } from "effect";
import { CampaignAttemptSchema, CampaignHash, CampaignManifestV2Fields, CampaignOutcomeV2Fields, createCampaignLedger } from "./campaign-store.js";

const ManifestSchema = Schema.Struct({
  ...CampaignManifestV2Fields, kind: Schema.Literal("workflow-audit"),
  tasks: Schema.Array(Schema.Struct({ id: Schema.Literals(["test1", "test2", "test3", "test4", "test5", "test6", "test7", "test8", "test9", "test10", "test11"]), contentIdentity: CampaignHash })),
});
const OutcomeSchema = Schema.Struct({
  ...CampaignOutcomeV2Fields,
  sites: Schema.NullOr(Schema.Record(Schema.NonEmptyString, Schema.Boolean)),
});
export type WorkflowAuditCampaign = typeof ManifestSchema.Type;
export type WorkflowAuditOutcome = typeof OutcomeSchema.Type;

/** Audit outcomes use the shared execution ledger with a site-naming grade. */
export const workflowAuditLedger = createCampaignLedger<WorkflowAuditCampaign, WorkflowAuditOutcome>({
  manifest: ManifestSchema, outcome: () => OutcomeSchema,
  events: Schema.Union([CampaignAttemptSchema, OutcomeSchema]), requireWritable: () => {},
});
