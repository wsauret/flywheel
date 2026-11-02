import type { PreparedPackage, SkillSemanticAuditEvidence } from "../../agent-runtime/review-types.js";
/** Shared vocabulary of the managed skill write path: who writes, where, what
 *  one mutation asks for, and the exact package a planned mutation produces.
 *  The planner and the store both speak it, so neither owns a private copy. */

import type { LearningScope } from "../../../infra/learning-scope.js";
import type { MutationDiff } from "../../../infra/mutation-diff.js";
import type { SkillPackageIdentity, SkillRegistryRevision } from "../../../workflows/skill-schema.js";


export type SkillStoreRootName = "user" | "project";

export type SkillWriteAction = "created" | "updated" | "patched" | "support_file" | "file_removed" | "archived" | "restored" | "promoted";

export type SkillWriteOrigin =
  | { kind: "review"; reviewRunId: string; loadedSkillIds: ReadonlySet<string> }
  | { kind: "agent"; sessionId: string }
  | { kind: "user" }
  // The deterministic lifecycle pruner: autonomous like the review, so pinned
  // (managed: user) packages refuse it; it never creates or edits, only
  // archives, and its archives are plain inactivity prunes with no absorb
  // target.
  | { kind: "pruner" };

export interface SkillStoreConfig {
  /** Canonical project directory that owns the project skill store. Never the
   *  directory a tool call executes in. */
  projectRoot: string;
  /** Startup-selected account data root that owns the user skill store. */
  userDataRoot: string;
  registry: () => SkillRegistryRevision;
}

export type SkillStoreResult =
  | {
    kind: "written";
    action: SkillWriteAction;
    name: string;
    reach: LearningScope;
    /** Content-bound proposal identity of the applied mutation. */
    proposalId: string;
    contentHash: string;
    /** Exactly what the write changed, bounded by the mutation-diff contract. */
    diff: MutationDiff;
    packageIdentity: SkillPackageIdentity;
    description: string;
    message: string;
    /** The operation was already terminal: this call observed its retained
     *  evidence and applied nothing. Its audit fact belongs to the run that
     *  applied it, so a replay must not record a second one. */
    replayed?: true;
  }
  | { kind: "refused"; error: string };

interface SkillPackageFiles {
  readonly [path: string]: string;
}

/** One mutation as the caller asked for it, before normalization. Reach is the
 *  public vocabulary of every variant that chooses a store; the physical root
 *  names stay inside the planner. */
export type SkillMutation =
  | { kind: "save"; name: string; description: string; body: string; dependencies?: readonly string[]; reach?: LearningScope }
  | { kind: "support_file"; name: string; path: string; content: string }
  | { kind: "remove_file"; name: string; path: string }
  | { kind: "patch"; name: string; path?: string; oldString: string; newString: string }
  | { kind: "archive"; name: string; absorbedInto?: string }
  | { kind: "restore"; name: string; reach?: LearningScope }
  /** Move one project package into the global store, keeping its id. */
  | { kind: "promote"; name: string }
  /** Internal whole-package publication used by definition override resolution. */
  | { kind: "replace_package"; name: string; files: SkillPackageFiles }
  /** Internal whole-package removal used by definition override resolution. */
  | { kind: "remove_package"; name: string };

export interface PreparedLocation {
  readonly reach: LearningScope;
  readonly root: SkillStoreRootName;
  readonly dir: string;
}

/** What the mutation does at its destination, and where the bytes come from.
 *  Each variant names a different applier: write one file, remove one file,
 *  or move a whole package between two locations. A promotion is the only
 *  outcome whose two locations can be two filesystems, so it is published by
 *  `global-skill-mutation`'s staged protocol and never by a single rename. */
export type PreparedMutationOutcome =
  | { readonly kind: "package"; readonly destination: PreparedLocation; readonly package: PreparedPackage; readonly writePath: string }
  | { readonly kind: "absence"; readonly destination: PreparedLocation; readonly package: PreparedPackage; readonly removePath: string }
  | { readonly kind: "archive"; readonly source: PreparedLocation; readonly destination: PreparedLocation; readonly package: PreparedPackage }
  | { readonly kind: "restore"; readonly source: PreparedLocation; readonly destination: PreparedLocation; readonly package: PreparedPackage }
  | { readonly kind: "promotion"; readonly source: PreparedLocation; readonly destination: PreparedLocation; readonly package: PreparedPackage };

export interface SkillMutationPlan {
  /** Writer-prepared, content-bound identity of this exact proposed result. */
  readonly proposalId: string;
  readonly action: SkillWriteAction;
  readonly name: string;
  readonly reach: LearningScope;
  readonly root: SkillStoreRootName;
  readonly outcome: PreparedMutationOutcome;
  readonly description: string;
  readonly contentHash: string;
  /** Exactly what applying this plan changes, captured from the plan's own
   * before and after bytes rather than from a later reread. */
  readonly diff: MutationDiff;
  readonly message: string;
  /** User-readable statement of the mutation, shown with the question. */
  readonly summary: string;
  /** Whole-package digest the outgoing location held when the plan was made,
   *  absent when the mutation creates a package where none was installed. The
   *  publisher revalidates it, so one confirmation approves one transition. */
  readonly basePackageSha256?: string;
  /** Review-authored content must carry verified evidence bound to this exact
   * package and registry revision before the plan can publish. */
  readonly semanticAudit?:
    | { readonly kind: "required"; readonly registryRevision: number }
    | { readonly kind: "admitted"; readonly evidence: SkillSemanticAuditEvidence };
}

export type SkillMutationPlanResult =
  | { readonly kind: "planned"; readonly plan: SkillMutationPlan }
  | { readonly kind: "refused"; readonly error: string };
