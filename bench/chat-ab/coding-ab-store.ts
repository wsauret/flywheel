import { Schema } from "effect";
import { BenchmarkAccountingSchema } from "../../src/orchestration/modules/development/benchmark/evidence.js";
import {
  CampaignId as Id, CampaignHash as Hash, CampaignCount as Count, CampaignText as Text,
  CampaignAttemptSchema as AttemptSchema, CampaignCellSchema as CellSchema, CampaignArtifactSchema as ArtifactSchema,
  CampaignManifestV2Fields, CampaignOutcomeV2Fields, createCampaignLedger,
} from "./campaign-store.js";

const SourceSchema = Schema.Struct({
  id: Id,
  revision: Text,
  sourceIdentity: Hash,
  dependencyIdentity: Hash,
  harnessIdentity: Hash,
  engineIdentity: Hash,
});
const TaskSchema = Schema.Struct({
  id: Id,
  role: Schema.Literals(["development", "reserved-evaluation"]),
  contentIdentity: Hash,
  qualificationIdentity: Hash,
});
const ManifestV1Schema = Schema.Struct({
  kind: Schema.Literal("coding-ab"),
  version: Schema.Literal(1),
  name: Id,
  model: Text,
  effort: Text,
  authProfile: Text,
  profileId: Text,
  authorityIncarnation: Text,
  configIdentity: Hash,
  infrastructureIdentity: Hash,
  treatments: Schema.Array(SourceSchema),
  tasks: Schema.Array(TaskSchema),
  repeats: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  createdAt: Text,
});
const ManifestV2Schema = Schema.Struct({
  ...CampaignManifestV2Fields, kind: Schema.Literal("coding-ab"),
  tasks: Schema.Array(TaskSchema),
});
const ManifestSchema = Schema.Union([ManifestV1Schema, ManifestV2Schema]);
export type CodingCampaign = typeof ManifestSchema.Type;
const OutcomeV1Schema = Schema.Struct({
  kind: Schema.Literal("outcome"),
  attemptId: Text,
  cell: CellSchema,
  at: Text,
  status: Schema.Literals(["completed", "failed"]),
  reason: Schema.NullOr(Text),
  wallMs: Schema.NullOr(Count),
  accounting: BenchmarkAccountingSchema,
  acceptance: Schema.NullOr(Schema.Struct({ passed: Count, total: Count, allPass: Schema.Boolean })),
  workflow: Schema.Struct({ stages: Schema.Array(Schema.String), launches: Count, refusedLaunches: Count }),
  report: Schema.NullOr(ArtifactSchema),
  diff: Schema.NullOr(ArtifactSchema),
  evidence: Schema.Array(ArtifactSchema),
});
const OutcomeV2Schema = Schema.Struct({
  ...CampaignOutcomeV2Fields,
  acceptance: Schema.NullOr(Schema.Struct({
    tests: Schema.Record(Schema.String, Schema.Literals(["pass", "fail", "missing"])),
    passed: Count, total: Count, allPass: Schema.Boolean,
  })),
});
const OutcomeSchema = Schema.Union([OutcomeV1Schema, OutcomeV2Schema]);
const EventSchema = Schema.Union([AttemptSchema, OutcomeSchema]);
export type CodingOutcomeRecord = typeof OutcomeSchema.Type;
export type CodingEvent = typeof EventSchema.Type;

/** Historical private-runner campaigns are inspectable, never executable. */
export function requireWritableCodingCampaign(manifest: CodingCampaign): asserts manifest is typeof ManifestV2Schema.Type {
  if (manifest.version === 1) throw new Error("Version 1 coding campaigns are read-only; start a new results directory");
}

/** The coding family owns its strict historical and current grade shapes. */
export const codingLedger = createCampaignLedger<CodingCampaign, CodingOutcomeRecord>({
  manifest: ManifestSchema,
  outcome: (manifest) => manifest.version === 1 ? OutcomeV1Schema : OutcomeV2Schema,
  events: EventSchema,
  requireWritable: requireWritableCodingCampaign,
});
