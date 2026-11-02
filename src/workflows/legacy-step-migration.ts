/** The retired canonical step record and the graph policy that applied to
 *  it. Migration-only: nothing outside the
 *  unified-catalog identity migration may import this module.
 *
 *  The unification cutover deleted the step definition model, but historical
 *  `definition.loaded` facts still hold the step snapshots a session was
 *  compiled from, so the retired record shape is defined here once. */

import { Effect, Schema } from "effect";
import { CanonicalToolScopingSchema, ToolScopingSchema } from "../infra/workflow-types.js";
import { ArtifactContractsFrontmatterSchema } from "./artifact-contracts.js";

/** The retired durable record: authored step frontmatter plus the resolved id
 *  and prompt body. `handoffFilename` is deliberately absent - the
 *  definition-loaded-handoff-filename fact migration strips it from every
 *  historical row before the identity chain reads one - so a snapshot that
 *  still carries it is malformed here rather than silently accepted.
 *
 *  `selfReview` decodes but never survives the decode: the self-review pass it
 *  switched no longer exists, so a recorded value states nothing a current
 *  binding can reconstruct, and comparing it would report drift that changes
 *  no behavior. Settings left empty are dropped too, so a record that named
 *  only `selfReview` equals one that named nothing.
 *
 *  `toolScoping.ask_user` is dropped the same way: no step asks the person
 *  now (PI-AGENT-024), so no current binding can reconstruct a grant of it.
 *  Remove the `ask_user` arm after 2027-04-03. */
const RetiredAskUserField = { ask_user: Schema.optionalKey(Schema.Boolean) };

const RetiredStepSettingsSchema = Schema.Struct({
  selfReview: Schema.optionalKey(Schema.Boolean),
  toolScoping: Schema.optionalKey(Schema.Struct({ ...ToolScopingSchema.fields, ...RetiredAskUserField })),
});

const RetiredStepOverridesSchema = Schema.Struct({
  selfReview: Schema.optionalKey(Schema.Boolean),
  toolScoping: Schema.optionalKey(Schema.Struct({ ...CanonicalToolScopingSchema.fields, ...RetiredAskUserField })),
});

/** Settings without the keys no current binding can state. */
function withoutRetiredSettings<T extends { readonly selfReview?: boolean; readonly toolScoping?: { readonly ask_user?: boolean } }>(settings: T) {
  const { selfReview: _selfReview, toolScoping, ...kept } = settings;
  if (toolScoping === undefined) return kept;
  const { ask_user: _askUser, ...scope } = toolScoping;
  return { ...kept, toolScoping: scope };
}

const RetiredStepRecordSchema = Schema.Struct({
  id: Schema.String,
  promptBody: Schema.String,
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  handoff: Schema.optionalKey(Schema.String),
  writes: ArtifactContractsFrontmatterSchema.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed([]))),
  settings: Schema.optionalKey(RetiredStepSettingsSchema),
  agents: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  requiredSkills: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  "inline-output": Schema.optionalKey(Schema.String),
  "user-invocable": Schema.Boolean.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(true))),
  "disable-model-invocation": Schema.Boolean.pipe(Schema.withDecodingDefaultTypeKey(Effect.succeed(false))),
});

export type LegacyStepRecord = typeof RetiredStepRecordSchema.Type;

/** Decode one recorded step snapshot into the retired record shape. Strict: a
 *  payload with an excess or malformed field is a fact this build cannot read,
 *  which fails the migration instead of comparing as a difference. */
export function parseLegacyStepRecord(value: unknown): LegacyStepRecord {
  const { settings: decoded, ...record } = Schema.decodeUnknownSync(RetiredStepRecordSchema, { onExcessProperty: "error" })(value);
  const settings = withoutRetiredSettings(decoded ?? {});
  return Object.keys(settings).length === 0 ? record : { ...record, settings };
}

/** Apply one retired graph position's policy to its recorded base step. A null
 * value means the workflow used the base settings. The graph carried canonical
 * tool scoping, so malformed internal state fails this migration. */
export function applyLegacyStepOverrides(record: LegacyStepRecord, value: unknown): LegacyStepRecord {
  if (value === null || value === undefined) return record;
  const overrides = withoutRetiredSettings(Schema.decodeUnknownSync(RetiredStepOverridesSchema, { onExcessProperty: "error" })(value));
  return parseLegacyStepRecord({
    ...record,
    settings: { ...record.settings, ...overrides },
  });
}

