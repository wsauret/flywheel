import { Schema } from "effect";
import { CampaignArtifactSchema, CampaignAttemptSchema, CampaignManifestV2Fields, CampaignOutcomeV2Fields, CampaignTreatmentFields, createCampaignLedger } from "./campaign-store.js";
import { ChatGradeSchema, ChatTaskSchema } from "./chat-store.js";
import { WorkflowAuthorshipMetricsSchema } from "./workflow-authorship-metrics.js";

const Manifest = Schema.Struct({
  ...CampaignManifestV2Fields, kind: Schema.Literal("workflow-authorship"),
  treatments: Schema.Array(Schema.Struct({ ...CampaignTreatmentFields, workflowsMode: Schema.Literal("on"),
    model: Schema.String, effort: Schema.String, authProfile: Schema.String,
    expectedWorkflowSource: Schema.Literals(["authored", "frozen"]), workflowLaunch: Schema.Literals(["chosen", "required"]) })),
  tasks: Schema.Array(ChatTaskSchema),
});
const Outcome = Schema.Struct({
  ...CampaignOutcomeV2Fields, grade: ChatGradeSchema, workflow: WorkflowAuthorshipMetricsSchema,
  workflowArtifact: Schema.NullOr(CampaignArtifactSchema),
});
export type WorkflowAuthorshipCampaign = typeof Manifest.Type;
export type WorkflowAuthorshipOutcome = typeof Outcome.Type;

/** This family retains non-compliant and incomplete outcomes under the shared campaign settlement rules. */
export const workflowAuthorshipLedger = createCampaignLedger<WorkflowAuthorshipCampaign, WorkflowAuthorshipOutcome>({
  manifest: Manifest, outcome: () => Outcome, events: Schema.Union([CampaignAttemptSchema, Outcome]), requireWritable: () => {},
});
