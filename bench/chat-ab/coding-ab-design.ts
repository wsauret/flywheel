import { Schema } from "effect";
import { EffortSchema } from "../../src/infra/workflow-types.js";
import { requireAuthProfile } from "./campaign-args.js";
import { CampaignDisabledToolsSchema, CampaignMessageSchema, CampaignRolesSchema } from "./campaign-store.js";
import { BenchmarkPatchPath } from "./source-treatment.js";

const Id = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/));
const DesignSchema = Schema.Struct({
  name: Id,
  tasks: Schema.Array(Id),
  message: Schema.optionalKey(CampaignMessageSchema),
  repeats: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  model: Schema.NonEmptyString,
  effort: EffortSchema,
  authProfile: Schema.optionalKey(Schema.NonEmptyString),
  roles: Schema.optionalKey(CampaignRolesSchema),
  treatments: Schema.Record(Id, Schema.Union([
    Schema.NonEmptyString,
    Schema.Struct({
      subject: Schema.Literal("claude-code"),
      model: Schema.optionalKey(Schema.NonEmptyString),
      effort: Schema.optionalKey(EffortSchema),
      ultracode: Schema.optionalKey(Schema.Literal(true)),
      plugin: Schema.optionalKey(Schema.NonEmptyString),
    }),
    Schema.Struct({
      subject: Schema.optionalKey(Schema.Literal("flywheel")),
      revision: Schema.NonEmptyString,
      patches: Schema.optionalKey(Schema.Array(BenchmarkPatchPath)),
      model: Schema.optionalKey(Schema.NonEmptyString),
      effort: Schema.optionalKey(EffortSchema),
      authProfile: Schema.optionalKey(Schema.NonEmptyString),
      roles: Schema.optionalKey(CampaignRolesSchema),
      disabledTools: Schema.optionalKey(CampaignDisabledToolsSchema),
    }),
  ])),
});
export type CodingDesign = typeof DesignSchema.Type & { readonly authProfile: string };

/**
 * Decode source revisions, reviewed source deltas pinned by content hash, or an external Claude Code subject,
 * optionally with the Flywheel plugin that a named Flywheel revision builds.
 * The operator profile comes from `authProfile` (the `--auth-profile` flag), then the design file, then
 * FLYWHEEL_AUTH_PROFILE, so a shared design file need not name anyone's profile.
 */
export function parseCodingDesign(value: unknown, authProfile?: string): CodingDesign {
  const decoded = Schema.decodeUnknownSync(DesignSchema, { onExcessProperty: "error" })(value);
  const design = { ...decoded, authProfile: requireAuthProfile(authProfile, decoded.authProfile) };
  if (Object.keys(design.treatments).length === 0) throw new Error("Name at least one treatment");
  if (design.tasks.length === 0 || new Set(design.tasks).size !== design.tasks.length) throw new Error("Name at least one task, with no duplicates");
  return design;
}
