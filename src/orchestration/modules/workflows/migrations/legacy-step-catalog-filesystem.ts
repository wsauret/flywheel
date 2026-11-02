/** The filesystem protocol of the one-time legacy step definition migration.
 *
 *  One root is migrated whole or not at all. Every generated target is staged in
 *  a sibling area of the authority root, made durable, published with a rename
 *  inside that one filesystem, verified where it now lives, and only then are the
 *  legacy sources retired. So every state a crash can leave holds either the
 *  legacy source or a complete target, never half of one, and a restart finishes
 *  from what is retained.
 *
 *  The staged target is deterministic, which is what makes a restart idempotent
 *  without a progress manifest: a destination that already holds the exact
 *  staged package is a completed publication. The one authority a restart needs
 *  is therefore the legacy source it has not retired yet.
 *
 *  Every root's legacy source directories and destination package directories
 *  are locked together, in the canonical order the lock helper
 *  imposes, before the plan is recomputed and held until the sources are retired.
 *  A root another owner is already migrating is left to them. */

import { chmodSync, existsSync, lstatSync, renameSync, rmdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fsyncDirectory } from "../../../../infra/atomic-write.js";
import type { ProjectDirectories } from "../../../../infra/directory-authorities.js";
import { errorMessage } from "../../../../infra/error-message.js";
import { Log } from "../../../../infra/log.js";
import {
  ensureDirectoryUnder,
  readFileUnder,
  removeFileUnder,
  writeFileUnder,
} from "../../../../infra/write-file-under.js";
import { ContainedPathError } from "../../../../infra/descriptor-directory.js";
import { SKILL_FILE } from "../../../../workflows/skill-schema.js";
import { tryWithPackageLocksSync } from "../../../../infra/package-directory-lock.js";
import {
  stagingLockPath,
  legacyStepAuthorityRoots,
  planRootMigration,
  publishedPackageState,
  sourceIdentity,
  type LegacyStepAuthorityRoot,
  type PackageTarget,
  type RootPlan,
} from "./legacy-step-catalog.js";

const log = Log.create({ service: "workspace.legacy-step-migration" });

/** Mode of a directory this migration creates. A destination package directory
 *  is Flywheel's own new state, so it is private, which is never broader than the
 *  legacy tree it came from. */
const DIRECTORY_MODE = 0o700;

/** Bytes of one target, which the legacy source's own limit already bounded. */
const TARGET_MAX_BYTES = 256 * 1024;

/** One completed unit of the protocol. A caller observes them in order, so a
 *  test can interrupt the run at any publication boundary. */
export interface MigrationStage {
  readonly kind: "staged" | "package-published" | "verified" | "retired";
  readonly root: string;
  readonly target: string;
}

export interface LegacyStepMigrationOptions {
  readonly onStage?: (stage: MigrationStage) => void;
}

export interface LegacyStepMigrationReport {
  /** `<layer>:<skill id>` of every package this run published. */
  readonly published: readonly string[];
  /** Roots whose legacy sources are retired, so nothing is left to migrate. */
  readonly completed: readonly string[];
  /** Why a root published nothing. Every conflict is detected before any
   *  publication of that root. */
  readonly conflicts: readonly string[];
  /** Roots another owner holds. Their migration is that owner's to finish. */
  readonly deferred: readonly string[];
}

/** Migrate whatever legacy step definitions the user and project overlays still
 *  hold, before any canonical definition registry reads them. Each authority
 *  layer is planned, published, and retired on its own, so precedence between
 *  layers is exactly what the roots already say.
 *
 *  A conflict is reported, never thrown: a project whose overlay cannot migrate
 *  must still start, and the definition loader raises what remains broken. */
export function migrateLegacyStepCatalog(
  directories: ProjectDirectories,
  options: LegacyStepMigrationOptions = {},
): LegacyStepMigrationReport {
  const published: string[] = [];
  const completed: string[] = [];
  const conflicts: string[] = [];
  const deferred: string[] = [];

  for (const root of legacyStepAuthorityRoots(directories.projectRoot, directories.userDataRoot)) {
    const plan = planRootMigration(root);
    if (plan.kind === "nothing") {
      clearLeftoverStaging(root);
      continue;
    }
    if (plan.kind === "blocked") {
      report(root, plan.conflicts, conflicts);
      continue;
    }
    let outcome: RootOutcome = blocked([]);
    const ran = tryWithPackageLocksSync(plan.lockPaths, () => {
      outcome = migrateRoot(plan, options);
    });
    if (!ran) {
      deferred.push(root.dir);
      log.info("legacy step migration left a root to another owner", { root: root.dir });
      continue;
    }
    if (outcome.conflicts.length > 0) {
      report(root, outcome.conflicts, conflicts);
      continue;
    }
    published.push(...outcome.published.map((skillId) => `${root.layer}:${skillId}`));
    completed.push(root.dir);
    log.info("legacy step definitions migrated", { root: root.dir, packages: outcome.published.length });
  }
  return { published, completed, conflicts, deferred };
}

/** Drop the staging area of a root with nothing left to migrate. A run that was
 *  interrupted after its last source was retired left work nobody owes: under
 *  the staging lock, because an owner that is building staging holds the same
 *  lock, that leftover is removed rather than kept forever. */
function clearLeftoverStaging(root: LegacyStepAuthorityRoot): void {
  const staging = stagingLockPath(root);
  if (!existsSync(staging)) return;
  tryWithPackageLocksSync([staging], () => rmSync(staging, { recursive: true, force: true }));
}

function report(root: LegacyStepAuthorityRoot, found: readonly string[], into: string[]): void {
  for (const conflict of found) {
    into.push(conflict);
    log.warn("legacy step migration is blocked", { root: root.dir, conflict });
  }
}

interface RootOutcome {
  readonly conflicts: readonly string[];
  readonly published: readonly string[];
}

function blocked(conflicts: readonly string[]): RootOutcome {
  return { conflicts, published: [] };
}

type PlannedRoot = Extract<RootPlan, { kind: "planned" }>;

/** Publish and retire one root under its held locks. The plan is recomputed here
 *  because the locks are what make a plan authoritative: anything that changed
 *  while they were being taken invalidates every conflict check that produced
 *  it, so the root publishes nothing and reports the drift. */
function migrateRoot(
  plan: PlannedRoot,
  options: LegacyStepMigrationOptions,
): RootOutcome {
  const fresh = planRootMigration(plan.root);
  if (fresh.kind === "blocked") return blocked(fresh.conflicts);
  if (fresh.kind !== "planned" || !isDeepStrictEqual(fresh, plan)) {
    return blocked([`${plan.root.dir} changed while this migration was taking its locks, so nothing was published`]);
  }

  const staged = stageTargets(plan, options);
  if (staged) return blocked([staged]);

  const published: string[] = [];
  for (const target of plan.packages) {
    const failure = publishPackage(plan.root, target, published, options);
    if (failure) return blocked([failure]);
  }

  const unverified = verifyTargets(plan, options);
  if (unverified) return blocked([unverified]);

  retireSources(plan, options);
  rmSync(stagingLockPath(plan.root), { recursive: true, force: true });
  return { conflicts: [], published };
}

/** Put every generated target in the staging area, durable and with its final
 *  mode. A staged file that already holds the target is kept: it is the same
 *  deterministic bytes, so an interrupted run resumes instead of rebuilding.
 *  Anything else is rewritten, so a torn file from an interrupted run cannot be
 *  published. */
function stageTargets(plan: PlannedRoot, options: LegacyStepMigrationOptions): string | undefined {
  const files = plan.packages.map((target) => ({ path: `${target.stagedDir}/${SKILL_FILE}`, content: target.skillFile, mode: target.mode }));
  for (const file of files) {
    try {
      if (!holdsExactly(plan.root, file.path, file.content, file.mode)) {
        writeFileUnder(plan.root.dir, file.path, file.content);
        // The published mode is the legacy source's own, so a target is never
        // more permissive than what it replaces, whatever the umask of the
        // process that stages it. Applied by path, which is safe here: every
        // component was created below the root without following a link, and the
        // locks exclude every other owner of this root.
        chmodSync(join(plan.root.dir, file.path), file.mode);
        fsyncDirectory(join(plan.root.dir, parentOf(file.path)));
      }
      if (!holdsExactly(plan.root, file.path, file.content, file.mode)) {
        return `${join(plan.root.dir, file.path)} could not be staged completely, so nothing was published`;
      }
    } catch (err) {
      return `${join(plan.root.dir, file.path)} could not be staged (${err instanceof ContainedPathError ? err.message : errorMessage(err)}), so nothing was published`;
    }
    options.onStage?.({ kind: "staged", root: plan.root.dir, target: file.path });
  }
  return undefined;
}

/** Publish one staged package with a rename inside the destination store, after
 *  revalidating the legacy source and the destination under the held locks. */
function publishPackage(
  root: LegacyStepAuthorityRoot,
  target: PackageTarget,
  published: string[],
  options: LegacyStepMigrationOptions,
): string | undefined {
  const source = sourceIdentity(root, target.source.relativePath);
  if (!isDeepStrictEqual(source, target.source)) {
    return `${join(root.dir, target.source.relativePath)} changed while this migration held its locks, so nothing more was published`;
  }
  const state = publishedPackageState(root, target.destinationDir, target.skillFile);
  if (state === "matches") return undefined;
  if (state === "different") {
    return `${join(root.dir, target.destinationDir)} holds a different package, so legacy step ${target.skillId} was not published`;
  }
  try {
    ensureDirectoryUnder(root.dir, parentOf(target.destinationDir));
    chmodSync(join(root.dir, target.stagedDir), DIRECTORY_MODE);
    renameSync(join(root.dir, target.stagedDir), join(root.dir, target.destinationDir));
    fsyncDirectory(join(root.dir, parentOf(target.destinationDir)));
  } catch (err) {
    return `${join(root.dir, target.destinationDir)} could not be published (${errorMessage(err)}), so the legacy sources are retained`;
  }
  published.push(target.skillId);
  options.onStage?.({ kind: "package-published", root: root.dir, target: target.skillId });
  return undefined;
}

/** Prove every target is complete where it now lives. Until this holds, the
 *  legacy sources are the only authority and none of them is retired. */
function verifyTargets(plan: PlannedRoot, options: LegacyStepMigrationOptions): string | undefined {
  for (const target of plan.packages) {
    const location = `${target.destinationDir}/${SKILL_FILE}`;
    if (!holdsExactly(plan.root, location, target.skillFile, target.mode)) {
      return `${join(plan.root.dir, location)} does not hold the migrated package, so the legacy sources are retained`;
    }
    // Broader means any bit outside the private mode, which a numeric compare
    // would miss: group read alone is a smaller number and a wider grant.
    if (MODE_BITS_HOLD_PRIVACY && ((modeOf(join(plan.root.dir, target.destinationDir)) ?? 0) & ~DIRECTORY_MODE) !== 0) {
      return `${join(plan.root.dir, target.destinationDir)} is more permissive than the migration allows, so the legacy sources are retained`;
    }
  }
  options.onStage?.({ kind: "verified", root: plan.root.dir, target: plan.root.dir });
  return undefined;
}

/** Retire the legacy sources last. An empty group directory is removed with
 *  them; the steps directory itself is left when anything remains under it,
 *  because this migration only ever owned the files it selected. */
function retireSources(plan: PlannedRoot, options: LegacyStepMigrationOptions): void {
  const groups = new Set<string>();
  for (const { source } of plan.packages) {
    removeFileUnder(plan.root.dir, source.relativePath);
    groups.add(source.groupDir);
    options.onStage?.({ kind: "retired", root: plan.root.dir, target: source.relativePath });
  }
  for (const group of [...groups].sort()) {
    removeEmptyDirectory(join(plan.root.dir, group));
    removeEmptyDirectory(join(plan.root.dir, parentOf(group)));
  }
}

function removeEmptyDirectory(dir: string): void {
  try {
    rmdirSync(dir);
  } catch {
    // A directory that still holds anything is not this migration's to remove.
  }
}

/** Does this location hold exactly these bytes under exactly this mode? A read
 *  this cannot contain answers no, so a symlink put in a target's place is never
 *  read as the target. */
/** Whether POSIX mode bits are this platform's privacy authority. Windows keeps
 *  no mode bits: `lstat` reports a fixed value whatever a write asked for, and
 *  privacy there is held by the owner-only ACL the private-path layer applies.
 *  Comparing modes on Windows would retain every legacy source over a
 *  permission the platform never had. */
const MODE_BITS_HOLD_PRIVACY = process.platform !== "win32";

function holdsExactly(root: LegacyStepAuthorityRoot, relativePath: string, content: string, mode: number): boolean {
  try {
    const bytes = readFileUnder(root.dir, relativePath, { maxBytes: TARGET_MAX_BYTES });
    if (bytes?.toString("utf8") !== content) return false;
    return !MODE_BITS_HOLD_PRIVACY || modeOf(join(root.dir, relativePath)) === mode;
  } catch {
    return false;
  }
}

function modeOf(location: string): number | undefined {
  try {
    return lstatSync(location).mode & 0o777;
  } catch {
    return undefined;
  }
}

function parentOf(relativePath: string): string {
  const separator = relativePath.lastIndexOf("/");
  return separator <= 0 ? "." : relativePath.slice(0, separator);
}
