import { Schema, SchemaTransformation } from "effect";

const ArtifactIdSchema = Schema.NonEmptyString;
export const ArtifactIdsSchema = Schema.Array(ArtifactIdSchema);

const TransientArtifactContractSchema = Schema.Struct({
  id: ArtifactIdSchema,
  lifetime: Schema.Literal("transient"),
  supersedes: Schema.optionalKey(Schema.Never),
});

const DurableArtifactContractSchema = Schema.Struct({
  id: ArtifactIdSchema,
  lifetime: Schema.Literal("durable"),
  supersedes: Schema.UniqueArray(ArtifactIdSchema),
}).pipe(Schema.refine(
  (contract): contract is typeof contract => !contract.supersedes.includes(contract.id),
  { message: "An artifact cannot supersede itself" },
));

const AuthoredTransientArtifactContractSchema = Schema.Struct({
  ...TransientArtifactContractSchema.fields,
  supersedes: Schema.optionalKey(Schema.Array(Schema.Never)),
});

/** Canonical Flywheel-owned artifact contract. */
export const ArtifactContractSchema = Schema.Union([
  TransientArtifactContractSchema,
  DurableArtifactContractSchema,
]);

/** One authored artifact contract: a bare id, or a contract object. */
export const ArtifactContractFrontmatterItemSchema = Schema.Union([
  ArtifactIdSchema,
  AuthoredTransientArtifactContractSchema,
  DurableArtifactContractSchema,
]).pipe(Schema.decodeTo(
  ArtifactContractSchema,
  SchemaTransformation.transform({
    decode: (contract) => typeof contract === "string"
      ? { id: contract, lifetime: "transient" as const }
      : contract.lifetime === "transient"
        ? { id: contract.id, lifetime: contract.lifetime }
        : contract,
    encode: (contract) => contract.lifetime === "transient" ? contract.id : contract,
  }),
));

/** External frontmatter codec. Bare ids and transient objects with empty
 *  supersession normalize to the same strict transient contract. */
export const ArtifactContractsFrontmatterSchema = Schema.Array(ArtifactContractFrontmatterItemSchema);