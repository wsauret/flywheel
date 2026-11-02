import type { LearningScope } from "../../infra/learning-scope.js";
import type { MutationEvidence } from "../../infra/mutation-evidence.js";
import type { SkillPackageIdentity, SkillRegistryRevision } from "../../workflows/skill-schema.js";

/** The typed callbacks carried by an admitted review runner. The runner
 *  forwards them; the contributing module owns their implementation. */
export interface PreparedFile {
  readonly path: string;
  readonly bytes: number;
  readonly content: string;
}

/** Every byte the package holds once the mutation lands, plus the identity of
 *  the whole. Files are in the deterministic path order the digest folds. */
export interface PreparedPackage {
  readonly files: readonly PreparedFile[];
  readonly identity: SkillPackageIdentity;
}

/** One global change a background actor proposes instead of applying. The
 *  identity is the store-prepared proposal identity, so the interactive turn
 *  that later asks and commits names this exact package. */
export interface SkillRecommendation {
  readonly recommendationId: string;
  readonly name: string;
  readonly action: "promote";
  /** Reach the recommendation would move the package to. */
  readonly reach: LearningScope;
  readonly packageIdentity: SkillPackageIdentity;
  /** The writer's own user-readable statement of the proposal. */
  readonly summary: string;
}

export interface SkillSemanticAuditEvidence {
  readonly candidateIdentity: SkillPackageIdentity;
  readonly registryRevision: number;
  readonly outcome: { readonly outcome: "independent" } | { readonly outcome: "specialization"; readonly canonicalSkillId: string };
  readonly canonicalPackageIdentity?: SkillPackageIdentity;
}

export type SkillSemanticAuditResult =
  | { readonly kind: "verified"; readonly evidence: SkillSemanticAuditEvidence }
  /** Not admitted. `reason` is the auditor's actual decision, or why none
   *  exists; the refusal carries it so the operator can act on it. */
  | { readonly kind: "uncertain"; readonly reason: string };


export interface LearningReviewRun {
  reviewRunId: string;
  onCandidate?: (
    candidate: PreparedPackage,
    revision: SkillRegistryRevision,
  ) => Promise<SkillSemanticAuditResult>;
  onWritten?: (action: { surface: "memory" | "skill"; name: string; action: string; reach: LearningScope; mutationEvidence?: MutationEvidence }) => void;
  onRecommended?: (recommendation: SkillRecommendation) => void;
}
