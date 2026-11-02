/** Write surface of the managed skill library. The registry's external
 *  filesystem roots are the store; this module creates, rewrites, patches,
 *  archives, and restores managed packages in the two Flywheel-owned roots
 *  (project and user). Every mutation is planned first, so what a write
 *  produces is decided once, in `skill-mutation-plan`, and applied here.
 *
 *  Write eligibility is origin-aware: `managed: flywheel` accepts every origin,
 *  `managed: user` refuses the review, and bundled or unmarked packages
 *  refuse everyone. The review additionally may not mutate a package it has
 *  not loaded in the same run, and may not archive without naming the
 *  umbrella that absorbed the content.
 *
 *  Reach is the second gate. A project write is autonomous. A global write
 *  changes what the user carries into every other project, so this boundary
 *  refuses it outright: it reaches the filesystem only through
 *  `global-skill-mutation`, which requires a typed, content-bound, single-use
 *  confirmation. A background origin can never obtain one. */

import { existsSync, mkdirSync, renameSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { LearningScope } from "../../../infra/learning-scope.js";
import { ContainedPathError } from "../../../infra/descriptor-directory.js";
import { removeFileUnder, requireContainedDirectory, writeFileUnder } from "../../../infra/write-file-under.js";
import { planLockPaths, planSkillMutation, planStaleness } from "./skill-mutation-plan.js";
import { skillSemanticAuditEvidenceIsCurrent } from "./skill-semantic-audit.js";
import { withPackageLocks } from "../../../infra/package-directory-lock.js";
import type { PendingAudit } from "./learning-journal.js";
import type {
  SkillMutation,
  SkillMutationPlan,
  SkillStoreConfig,
  SkillStoreResult,
  SkillWriteOrigin,
} from "./skill-store-types.js";

export interface SaveSkillInput {
  name: string;
  description: string;
  body: string;
  /** Reach of a create; an existing package stays where it lives. */
  reach?: LearningScope;
}

export interface SupportFileInput {
  name: string;
  path: string;
  content: string;
}

export interface PatchSkillInput {
  name: string;
  /** Package-relative file; defaults to SKILL.md. */
  path?: string;
  oldString: string;
  newString: string;
}

/** Create a managed skill, or fully rewrite an existing one's SKILL.md. */
export function saveSkill(config: SkillStoreConfig, origin: SkillWriteOrigin, input: SaveSkillInput): Promise<SkillStoreResult> {
  return runMutation(config, origin, { kind: "save", ...input });
}

/** Write one declared support file under an existing managed skill. */
export function saveSkillSupportFile(config: SkillStoreConfig, origin: SkillWriteOrigin, input: SupportFileInput): Promise<SkillStoreResult> {
  return runMutation(config, origin, { kind: "support_file", ...input });
}

/** Delete one declared support file, so a stale reference can retire without
 *  archiving the whole skill. */
export function removeSkillFile(config: SkillStoreConfig, origin: SkillWriteOrigin, input: { name: string; path: string }): Promise<SkillStoreResult> {
  return runMutation(config, origin, { kind: "remove_file", ...input });
}

/** Targeted replacement inside SKILL.md or a declared support file: the
 *  preferred shape for fixes (a full rewrite is for major overhauls only).
 *  The old string must match exactly once; a patched SKILL.md must still
 *  parse and fit admission. */
export function patchSkill(config: SkillStoreConfig, origin: SkillWriteOrigin, input: PatchSkillInput): Promise<SkillStoreResult> {
  return runMutation(config, origin, { kind: "patch", ...input });
}

/** Archive replaces delete: the whole package moves to `<root>/.archive/<name>`,
 *  which admission ignores, and restore is lossless. A review-origin archive
 *  must name the umbrella that absorbed the content. An optional guard runs
 *  under the same package lock as successful loads and every mutation. */
export function archiveSkill(
  config: SkillStoreConfig,
  origin: SkillWriteOrigin,
  input: { name: string; absorbedInto?: string },
  guard?: () => boolean | Promise<boolean>,
): Promise<SkillStoreResult> {
  return runMutation(config, origin, { kind: "archive", ...input }, guard);
}

/** Reverse an archive. Searches the project store first, then the user store. */
export function restoreSkill(config: SkillStoreConfig, origin: SkillWriteOrigin, input: { name: string }): Promise<SkillStoreResult> {
  return runMutation(config, origin, { kind: "restore", ...input });
}

async function runMutation(config: SkillStoreConfig, origin: SkillWriteOrigin, mutation: SkillMutation, guard?: () => boolean | Promise<boolean>): Promise<SkillStoreResult> {
  const store = refuseUncontainedSkillStores(config);
  if (store) return { kind: "refused", error: store };
  const planned = planSkillMutation(config, origin, mutation);
  if (planned.kind === "refused") return { kind: "refused", error: planned.error };
  const gate = refuseGlobalReach(origin, planned.plan);
  if (gate) return { kind: "refused", error: gate };
  return applyPlannedMutation(planned.plan, guard);
}

/** Why this boundary refuses to plan or publish while either owned skill store
 * is not held below its project or account root. The planner reads both stores
 * to resolve precedence, so both must be admitted before any read or write. An
 * absent store is safe because nothing is installed there yet. */
export function refuseUncontainedSkillStores(config: SkillStoreConfig): string | undefined {
  const stores = [
    {
      baseDir: config.projectRoot,
      relativePath: ".flywheel/skills",
      error: "The project skill store .flywheel/skills is a symlink or not a directory, so this repository controls where a managed write would land. Nothing was read or written. Replace it with a real directory inside the project.",
    },
    {
      baseDir: config.userDataRoot,
      relativePath: "skills",
      error: "The global skill store ~/.flywheel/skills is a symlink or not a directory, so Flywheel cannot prove where a managed write would land. Nothing was read or written. Replace it with a real directory inside the home store.",
    },
  ] as const;
  for (const store of stores) {
    if (!existsSync(store.baseDir)) continue;
    try {
      requireContainedDirectory(store.baseDir, store.relativePath);
    } catch (error) {
      if (!(error instanceof ContainedPathError)) throw error;
      return store.error;
    }
  }
  return undefined;
}


/** Apply one admitted plan under the package locks. Review audit evidence is
 * rechecked against live registry state before the caller-provided journal is
 * synchronously opened and before any package byte is published. */
export function applyPlannedMutation(
  plan: SkillMutationPlan,
  guard?: () => boolean | Promise<boolean>,
  publication?: {
    readonly currentRevision?: () => import("../../../workflows/skill-schema.js").SkillRegistryRevision;
    readonly openAudit?: () => PendingAudit | undefined;
  },
): Promise<SkillStoreResult> {
  return withPackageLocks(planLockPaths(plan), async () => {
    const stale = staleRefusal(plan);
    if (stale) return { kind: "refused", error: stale };
    if (guard && !await guard()) return { kind: "refused", error: `Skill "${plan.name}" became active before the archive landed.` };
    if (plan.semanticAudit?.kind === "required") return { kind: "refused", error: `Skill "${plan.name}" has no admitted semantic audit evidence, so nothing was written.` };
    if (plan.semanticAudit?.kind === "admitted") {
      const revision = publication?.currentRevision?.();
      if (!revision || !skillSemanticAuditEvidenceIsCurrent(plan.outcome.package, revision, plan.semanticAudit.evidence)) {
        return { kind: "refused", error: `Skill "${plan.name}" semantic audit evidence is stale or does not match the prepared package, so nothing was written.` };
      }
    }
    publication?.openAudit?.();
    applyPlan(plan);
    return resultOfPlan(plan);
  });
}

/** Why this plan no longer describes what is installed, in the words a writer
 *  that may simply retry needs: nothing was written, so the package is read
 *  again and the change reissued from what it holds now. */
function staleRefusal(plan: SkillMutationPlan): string | undefined {
  switch (planStaleness(plan)) {
    case undefined: return undefined;
    case "creation_conflict": return `A package named "${plan.name}" appeared where this change would create one, so nothing was written. Read it and decide what to change.`;
    case "base_absent": return `Skill "${plan.name}" is no longer installed, so nothing was written and there is nothing to change.`;
    case "base_moved": return `Skill "${plan.name}" changed after this change was prepared, so nothing was written: another write landed first. Load the skill again and reissue the change against what it holds now.`;
    case "move_conflict": return `A package already exists where "${plan.name}" would be moved, so nothing was written. Resolve that conflict first.`;
  }
}

/** Why this boundary refuses a global write. Autonomous origins cannot ask,
 *  so they are named rather than pointed at the confirmation path. */
function refuseGlobalReach(origin: SkillWriteOrigin, plan: SkillMutationPlan): string | undefined {
  if (plan.reach !== "global") return undefined;
  if (origin.kind === "review" || origin.kind === "pruner") return refuseBackgroundGlobalWrite(origin.kind, plan.name);
  return `Skill "${plan.name}" is a global package. A global change follows the user into every project, so it needs their explicit confirmation: prepare the mutation, ask with the returned proposal id, then repeat this call with confirmation_id.`;
}

/** No background actor can ask the user, so a global write from one is named
 *  rather than pointed at the confirmation path. */
export function refuseBackgroundGlobalWrite(origin: "review" | "pruner", name: string): string {
  return `Skill "${name}" is a global package and this is a background ${origin}: no autonomous actor may create or change global skills. Write a project skill, or recommend the change in the reply.`;
}

/** Put the planned bytes where the plan says, with no locking and no reach
 *  check. Callers hold the package locks and, for a global write, the operation
 *  manifest that makes the application resumable. */
function applyPlan(plan: SkillMutationPlan): void {
  const outcome = plan.outcome;
  switch (outcome.kind) {
    case "package": {
      const file = outcome.package.files.find((candidate) => candidate.path === outcome.writePath);
      if (!file) throw new Error(`plan for "${plan.name}" does not carry ${outcome.writePath}`);
      writePlannedFile(outcome.destination.dir, file.path, file.content);
      return;
    }
    case "absence":
      removeFileUnder(dirname(outcome.destination.dir), packageRelative(outcome.destination.dir, outcome.removePath));
      return;
    case "archive":
    case "restore":
      mkdirSync(dirname(outcome.destination.dir), { recursive: true });
      renameSync(outcome.source.dir, outcome.destination.dir);
      return;
    case "promotion":
      // The two roots can be two filesystems, so a promotion is published by
      // `global-skill-mutation`'s staged protocol, never by one rename.
      throw new Error(`promotion of "${plan.name}" is published by the global operation protocol, not by a local apply`);
  }
}

/** Write one package file through the descriptor-safe boundary: the store root
 *  is resolved by path, and every component below it - the package directory
 *  included - is created and opened relative to its parent and never followed
 *  through a symlink. A package whose `references/` is a link to somewhere else
 *  therefore fails the write instead of escaping the store. */
function writePlannedFile(packageDir: string, path: string, content: string): void {
  const storeRoot = dirname(packageDir);
  mkdirSync(storeRoot, { recursive: true });
  writeFileUnder(storeRoot, packageRelative(packageDir, path), content);
}

function packageRelative(packageDir: string, path: string): string {
  return `${basename(packageDir)}/${path}`;
}

export function resultOfPlan(plan: SkillMutationPlan): SkillStoreResult {
  return {
    kind: "written",
    action: plan.action,
    name: plan.name,
    reach: plan.reach,
    proposalId: plan.proposalId,
    contentHash: plan.contentHash,
    diff: plan.diff,
    packageIdentity: plan.outcome.package.identity,
    description: plan.description,
    message: plan.message,
  };
}
