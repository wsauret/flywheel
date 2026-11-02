import { Schema, SchemaTransformation } from "effect";
import { Sha256Schema } from "../definition-hash.js";

// Frozen definition identity codecs, which the frozen control roots of
// `historical-codecs.ts` hold. Nothing here derives from the current
// definition identity schema, so a change to it cannot change how a stored
// root decodes.

const Id = Schema.NonEmptyString;

// Definition identity version 1: the identity union that every root through
// initialized v4 and recovered v4 holds. Version 2 adds the phase hashes of a
// tree-shaped flow, which a flat identity never carries, so each value of
// version 1 and version 2 is also a current identity.
//
// Each version goes with the last frozen root that holds it. Remove version 1
// after 2027-04-09, with initialized v4 and recovered v4. Remove version 2
// after 2027-04-14, with initialized v9 and recovered v9.

const BindingIdentityV1Schema = Schema.Struct({ bindingId: Id, sha256: Sha256Schema });

const StoredContractRevisionV1Schema = Schema.Union([Schema.Literal(0), Schema.Null, Schema.Int.check(Schema.isGreaterThan(0))]);

const HandoffRegistryIdentityV1Schema = Schema.Struct({
  name: Id,
  contractRevision: Schema.optional(StoredContractRevisionV1Schema),
  fieldsSha256: Schema.NullOr(Sha256Schema),
  rulesSha256: Schema.optional(Schema.NullOr(Sha256Schema)),
  artifactPathFieldsSha256: Schema.optional(Schema.NullOr(Sha256Schema)),
}).pipe(Schema.decodeTo(
  Schema.Struct({
    name: Id,
    contractRevision: StoredContractRevisionV1Schema,
    fieldsSha256: Schema.NullOr(Sha256Schema),
    rulesSha256: Schema.NullOr(Sha256Schema),
    artifactPathFieldsSha256: Schema.NullOr(Sha256Schema),
  }),
  SchemaTransformation.transform({
    decode: (identity) => ({
      ...identity,
      contractRevision: identity.contractRevision === undefined ? 0 : identity.contractRevision,
      rulesSha256: identity.rulesSha256 ?? null,
      artifactPathFieldsSha256: identity.artifactPathFieldsSha256 ?? null,
    }),
    encode: (identity) => ({
      ...identity,
      contractRevision: identity.contractRevision === 0 ? undefined : identity.contractRevision,
    }),
  }),
));

const ComposedIdentityV1Fields = {
  workflowDefinitionId: Id,
  vmVersion: Id,
  skills: Schema.Array(Schema.Struct({ skillId: Id, sha256: Schema.NullOr(Sha256Schema) })),
  personas: Schema.Array(Schema.Struct({ personaName: Id, sha256: Schema.NullOr(Sha256Schema) })),
} as const;

const LegacyIdentityV1Fields = {
  ...ComposedIdentityV1Fields,
  bindings: Schema.Array(BindingIdentityV1Schema),
  handoffRegistry: Schema.Array(HandoffRegistryIdentityV1Schema),
} as const;

export const DefinitionIdentityV1Schema = Schema.Union([
  Schema.Struct({
    ...ComposedIdentityV1Fields,
    graphSha256: Sha256Schema,
    steps: Schema.Array(Schema.Struct({ stepId: Id, policySha256: Sha256Schema, contentSha256: Sha256Schema, outputSha256: Sha256Schema })),
  }),
  Schema.Struct({ ...LegacyIdentityV1Fields, workflowSha256: Sha256Schema }),
  Schema.Struct({ ...LegacyIdentityV1Fields, graphSha256: Sha256Schema }),
]);

// Definition identity version 2: the union that initialized v5 and recovered
// v5 hold. Its step identity adds the optional phase hashes of a tree-shaped
// flow.
export const DefinitionIdentityV2Schema = Schema.Union([
  Schema.Struct({
    ...ComposedIdentityV1Fields,
    graphSha256: Sha256Schema,
    phases: Schema.optionalKey(Schema.NonEmptyArray(Schema.Struct({ phaseId: Id, sha256: Sha256Schema }))),
    steps: Schema.Array(Schema.Struct({ stepId: Id, policySha256: Sha256Schema, contentSha256: Sha256Schema, outputSha256: Sha256Schema })),
  }),
  Schema.Struct({ ...LegacyIdentityV1Fields, workflowSha256: Sha256Schema }),
  Schema.Struct({ ...LegacyIdentityV1Fields, graphSha256: Sha256Schema }),
]);
