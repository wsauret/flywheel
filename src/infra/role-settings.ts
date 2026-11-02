import { Schema } from "effect"
import { ProviderRequestOptionsSchema } from "./llm/provider-options.js"

/** Authored role fields. Missing fields inherit the owner's current profile policy. */
export const RoleSettingEntrySchema = Schema.Struct({
  model: Schema.optionalKey(Schema.NonEmptyString),
  effort: Schema.optionalKey(Schema.NonEmptyString),
  providerOptions: Schema.optionalKey(ProviderRequestOptionsSchema),
})
export const RoleSettingsSchema = Schema.Record(Schema.NonEmptyString, RoleSettingEntrySchema)
export const RoleAssignmentSnapshotSchema = Schema.Struct({
  defaults: RoleSettingsSchema,
  overrides: RoleSettingsSchema,
})
