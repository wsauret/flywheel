import { Schema } from "effect"
import { defineFact } from "../../infra/event-registry.js"
import { inspirationProvenanceSchema } from "./inspiration-provenance.js"
import {
  DEFINITION_AUTHORITIES,
  DEFINITION_RISK_TIERS,
  DEFINITION_TARGET_KINDS,
  INSPIRATION_OUTCOMES,
} from "./improvement-types.js"

// Retained history: no lane writes these facts any more. The session schema
// registration decodes every stored version so that replay of recorded history
// stays strict. The deterministic consumer appended them, never an agent, so
// actor is always 'flywheel'; the attempt that proposed a change is recorded in
// the proposed payload (attemptId and agentName, or stepId and stepName in
// version 1).

const ImprovementCheckSchema = Schema.Struct({
  name: Schema.String,
  passed: Schema.Boolean,
  detail: Schema.String,
})

/** The fields of a proposal that every lane carries, with the attempt that
 *  proposed it under `author`: `attemptId` and `agentName`, or, in version
 *  1, the stored keys `stepId` and `stepName` (remove after 2027-04-30). */
function proposedPayload<const Author extends Schema.Struct.Fields>(author: Author) {
  const common = {
    proposalId: Schema.String,
    targetPath: Schema.String,
    contentHash: Schema.String,
    claimedCriteria: Schema.mutable(Schema.Array(Schema.String)),
    ...author,
  }
  // Discriminated on artifactKind: the memory lane's tier is a fixed literal; the
  // definition lane records what it targets and the authority-derived risk tier.
  return Schema.Union([
    Schema.Struct({
      artifactKind: Schema.Literal("memory"),
      riskTier: Schema.Literal("auto_undo"),
      ...common,
    }),
    Schema.Struct({
      artifactKind: Schema.Literal("definition"),
      riskTier: Schema.Literals(DEFINITION_RISK_TIERS),
      targetKind: Schema.Literals(DEFINITION_TARGET_KINDS),
      authority: Schema.Literals(DEFINITION_AUTHORITIES),
      definitionPath: Schema.String,
      ...common,
    }),
  ])
}

const RetiredAuthorFields = { stepId: Schema.String, stepName: Schema.String } // stored keys of version 1
const AuthorFields = { attemptId: Schema.String, agentName: Schema.String }

const ImprovementProposedV1FactSchema = defineFact({
  type: "improvement.proposed",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: proposedPayload(RetiredAuthorFields),
})

const ImprovementProposedFactSchema = defineFact({
  type: "improvement.proposed",
  version: 2,
  actor: Schema.Literal("flywheel"),
  payload: proposedPayload(AuthorFields),
})

const ImprovementVettedFactSchema = defineFact({
  type: "improvement.vetted",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    proposalId: Schema.String,
    verdict: Schema.Union([Schema.Literal("accepted"), Schema.Literal("rejected")]),
    checks: Schema.Array(ImprovementCheckSchema),
  }),
})

const ImprovementCommittedFactSchema = defineFact({
  type: "improvement.committed",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: Schema.Struct({
    proposalId: Schema.String,
    targetPath: Schema.String,
    sha256: Schema.String,
    // ARCH-SUBSTRATE-008: this filesystem write is a non_replayable/file_mutation boundary.
    // undoRef is the path to revert; the replay.boundary.recorded fact that makes
    // the boundary first-class is a tracked follow-up.
    undoRef: Schema.String,
  }),
})

// Inspiration completion: recorded once per consumed inspiration batch, with the
// identity of the handoff it consumed (attemptId plus handoffSha256) and the
// source the audit read, in the handoff's own provenance shape.
function inspirationPayload<const Author extends Schema.Struct.Fields>(author: Author) {
  return Schema.Struct({
    ...author,
    handoffSha256: Schema.String,
    provenance: inspirationProvenanceSchema,
    planArtifacts: Schema.Array(Schema.Struct({
      path: Schema.String,
      disposition: Schema.Literals(["created", "updated"]),
      summary: Schema.String,
    })),
    proposals: Schema.Array(Schema.Struct({
      proposalId: Schema.String,
      artifactKind: Schema.Literals(["memory", "definition"]),
      disposition: Schema.Literals(["committed", "rejected"]),
    })),
    outcome: Schema.Literals(INSPIRATION_OUTCOMES),
  })
}

const ImprovementInspirationRecordedV1FactSchema = defineFact({
  type: "improvement.inspiration.recorded",
  version: 1,
  actor: Schema.Literal("flywheel"),
  payload: inspirationPayload(RetiredAuthorFields),
})

const ImprovementInspirationRecordedFactSchema = defineFact({
  type: "improvement.inspiration.recorded",
  version: 2,
  actor: Schema.Literal("flywheel"),
  payload: inspirationPayload(AuthorFields),
})

export const ImprovementFactSchemas = [
  ImprovementProposedV1FactSchema,
  ImprovementProposedFactSchema,
  ImprovementVettedFactSchema,
  ImprovementCommittedFactSchema,
  ImprovementInspirationRecordedV1FactSchema,
  ImprovementInspirationRecordedFactSchema,
] as const
