import { Schema } from "effect";
import { ToolActionSchema } from "../../infra/workflow-types.js";

// Personas are config: Flywheel-authored bundles are producer-gated (parse throws
// at module init), and user/project persona files get the limited-tolerance config
// contract - unknown keys are rejected, not silently carried.
function toolNameSchema(installedToolNames?: readonly string[]) {
  return installedToolNames ? Schema.Literals(installedToolNames) : Schema.NonEmptyString;
}

const PersonaDefinitionFields = {
  name: Schema.String,
  description: Schema.String,
  role: Schema.NonEmptyString,
  maxTurns: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1))),
  subagentRoles: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.NonEmptyString))),
  /** Skill package ids whose canonical context is composed into this
   *  persona's system prompt, in declaration order, before its role
   *  instructions. This deterministic composition does not require the
   *  conditional skill tool. */
  requiredSkills: Schema.optionalKey(Schema.mutable(Schema.Array(Schema.NonEmptyString))),
  allowFork: Schema.optionalKey(Schema.Boolean),
};

export function createPersonaDefinitionSchema(installedToolNames?: readonly string[]) {
  return Schema.Union([
    Schema.Struct({
      ...PersonaDefinitionFields,
      tools: Schema.mutable(Schema.Array(toolNameSchema(installedToolNames))).check(Schema.isNonEmpty()),
      excludeActions: Schema.optionalKey(Schema.Never),
    }),
    Schema.Struct({
      ...PersonaDefinitionFields,
      tools: Schema.optionalKey(Schema.Never),
      excludeActions: Schema.mutable(Schema.Array(ToolActionSchema)),
    }),
  ]);
}

// Persona metadata index: cached name->role lookup for validation and compilation

const PersonaMetadataEntrySchema = Schema.Struct({
  name: Schema.String,
  role: Schema.NonEmptyString,
});

export interface PersonaMetadataIndex {
  [name: string]: typeof PersonaMetadataEntrySchema.Type;
}
