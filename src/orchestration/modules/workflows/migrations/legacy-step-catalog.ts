/** Selection and planning of the one-time legacy step definition migration.
 *
 *  Before the unification cutover a user or project overlay declared reusable
 *  instructions as `<root>/steps/<group>/<name>.md`, whose id was
 *  `<group>.<name>`, and its workflow yaml referenced that id directly. The
 *  cutover deleted the step loader. This module reads the retained steps with
 *  its own bounded parser and computes the skill packages for each root.
 *  Retired workflow folders stay untouched. Remove after 2027-04-30.
 *
 *  Planning only. Nothing here writes, so a caller can compute a plan, take the
 *  locks, and compute it again to prove nothing moved underneath (see
 *  legacy-step-catalog-filesystem.ts).
 *
 *  Each authority root is planned on its own and publishes into its own store,
 *  so project-over-user precedence survives untouched: a package of one id in a
 *  lower layer is an intentional shadow, never a conflict. A different package
 *  already installed in the exact destination root is a conflict. Every
 *  conflict is detected here, before anything is published. */

import { createHash } from "node:crypto";
import { lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import * as yaml from "js-yaml";
import { parseFrontmatter } from "../../../../infra/frontmatter.js";
import { isQualifiedSkillId } from "../../../../infra/skill-id.js";
import { ContainedPathError } from "../../../../infra/descriptor-directory.js";
import { readFileUnder, requireContainedDirectory } from "../../../../infra/write-file-under.js";
import { SKILL_FILE } from "../../../../workflows/skill-schema.js";

interface UnknownRecord {
  [key: string]: unknown;
}

/** Staging area of one authority root. A sibling of `skills/`, so a staged target is never a package a
 *  registry can read and publication is a rename inside one filesystem. */
const LEGACY_STAGING_DIR = ".legacy-step-migration";

const LEGACY_STEPS_DIR = "steps";
const SKILLS_DIR = "skills";

/** Group folders that were never step groups: `references` held shared prompt
 *  assets and the other three collided with reserved id namespaces. */
const RESERVED_GROUPS = new Set(["references", "agent", "skill", "workflow"]);
const SEGMENT = /^[a-z0-9][a-z0-9-]*$/u;

/** Legacy overlay files are user artifacts of any size, so every read of one is
 *  bounded and every directory walk counts its entries. */
const LIMITS = {
  stepBytes: 256 * 1024,
  stepFiles: 256,
  entries: 1_024,
} as const;

export interface LegacyStepAuthorityRoot {
  readonly layer: "user" | "project";
  /** Overlay root: `~/.flywheel` or `<project>/.flywheel`. */
  readonly dir: string;
}

/** The two roots a project migrates, lower authority first. A project opened at
 *  the account data root itself has one root, not two. */
export function legacyStepAuthorityRoots(projectRoot: string, userDataRoot: string): readonly LegacyStepAuthorityRoot[] {
  const project = join(projectRoot, ".flywheel");
  if (userDataRoot === project) return [{ layer: "project", dir: project }];
  return [{ layer: "user", dir: userDataRoot }, { layer: "project", dir: project }];
}

/** One legacy file this migration retires, named relative to its root so a plan
 *  is comparable across two computations of it. */
export interface LegacySourceFile {
  readonly relativePath: string;
  readonly groupDir: string;
  readonly digest: string;
  readonly mode: number;
}

export interface PackageTarget {
  readonly skillId: string;
  /** Root-relative destination package directory. */
  readonly destinationDir: string;
  /** Root-relative staged package directory. */
  readonly stagedDir: string;
  readonly skillFile: string;
  /** Mode of the published `SKILL.md`: the legacy source's own mode, so a target
   *  is never more permissive than the file it replaces. */
  readonly mode: number;
  readonly source: LegacySourceFile;
}

export type RootPlan =
  | { readonly kind: "nothing" }
  | { readonly kind: "blocked"; readonly conflicts: readonly string[] }
  | {
    readonly kind: "planned";
    readonly root: LegacyStepAuthorityRoot;
    readonly packages: readonly PackageTarget[];
    /** Every legacy source directory and destination package directory
     *  this plan touches, as absolute paths. The lock helper
     *  orders them canonically, so two owners of one root can never take them
     *  in two orders. */
    readonly lockPaths: readonly string[];
  };

/** What this root must publish, or why it cannot. Skill conversion does not
 *  depend on references in the retired workflow folders. */
export function planRootMigration(root: LegacyStepAuthorityRoot): RootPlan {
  const selected = readLegacySteps(root);
  if (selected.conflicts.length > 0) return { kind: "blocked", conflicts: selected.conflicts };
  if (selected.steps.size === 0) return { kind: "nothing" };

  const conflicts: string[] = [];
  const packages: PackageTarget[] = [];
  for (const [skillId, step] of selected.steps) {
    const destinationDir = `${SKILLS_DIR}/${skillId}`;
    const skillFile = renderSkillFile(step);
    const state = publishedPackageState(root, destinationDir, skillFile);
    if (state === "different") {
      conflicts.push(`${join(root.dir, destinationDir)} already holds a different package, so legacy step ${skillId} cannot be migrated into it`);
      continue;
    }
    packages.push({
      skillId,
      destinationDir,
      stagedDir: `${LEGACY_STAGING_DIR}/${SKILLS_DIR}/${skillId}`,
      skillFile,
      mode: step.source.mode,
      source: step.source,
    });
  }

  if (conflicts.length > 0) return { kind: "blocked", conflicts };

  const lockPaths = [
    ...new Set([
      // The staging area is locked too, so an owner that is cleaning leftover
      // staging and an owner that is building it exclude each other.
      stagingLockPath(root),
      ...packages.map(({ source }) => join(root.dir, source.groupDir)),
      ...packages.map(({ destinationDir }) => join(root.dir, destinationDir)),
    ]),
  ];
  return { kind: "planned", root, packages, lockPaths };
}

/** Path whose lock guards one root's staging area. */
export function stagingLockPath(root: LegacyStepAuthorityRoot): string {
  return join(root.dir, LEGACY_STAGING_DIR);
}

interface LegacyStep {
  readonly metadata: LegacyStepMetadata;
  readonly body: string;
  readonly source: LegacySourceFile;
}

/** The retired step frontmatter, reduced to the fields a skill package carries.
 *  A legacy overlay file is an external artifact, so an unknown key is ignored
 *  rather than refused. Workflow-only keys are not part of the package. */
const RetiredStepMetadataSchema = Schema.Struct({
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  agents: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  requiredSkills: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  "inline-output": Schema.optionalKey(Schema.String),
  "user-invocable": Schema.optionalKey(Schema.Boolean),
  "disable-model-invocation": Schema.optionalKey(Schema.Boolean),
});

type LegacyStepMetadata = typeof RetiredStepMetadataSchema.Type;

interface SelectedSteps {
  readonly steps: ReadonlyMap<string, LegacyStep>;
  readonly conflicts: readonly string[];
}

function listGroupDirs(root: LegacyStepAuthorityRoot) {
  const conflicts: string[] = [];
  const groups: string[] = [];
  let entries: readonly { name: string; isDirectory: () => boolean; isSymbolicLink: () => boolean }[];
  try {
    entries = readdirSync(join(root.dir, LEGACY_STEPS_DIR), { withFileTypes: true }).slice(0, LIMITS.entries);
  } catch {
    // An overlay layer is optional: an absent steps directory is nothing to
    // migrate, which is the state of every root once this has run.
    return { groups, conflicts };
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      conflicts.push(`${join(root.dir, LEGACY_STEPS_DIR, entry.name)} is a symlink, so this migration cannot prove what it would read`);
      continue;
    }
    if (!entry.isDirectory() || RESERVED_GROUPS.has(entry.name) || !SEGMENT.test(entry.name)) continue;
    groups.push(entry.name);
  }
  return { groups: groups.sort(), conflicts };
}

/** Every legacy step file of one root, keyed by the qualified id it keeps. */
function readLegacySteps(root: LegacyStepAuthorityRoot): SelectedSteps {
  const listed = listGroupDirs(root);
  const conflicts = [...listed.conflicts];
  const steps = new Map<string, LegacyStep>();

  for (const group of listed.groups) {
    const groupDir = `${LEGACY_STEPS_DIR}/${group}`;
    let entries: readonly { name: string; isFile: () => boolean; isSymbolicLink: () => boolean }[];
    try {
      entries = readdirSync(join(root.dir, groupDir), { withFileTypes: true }).slice(0, LIMITS.entries);
    } catch (err) {
      conflicts.push(`${join(root.dir, groupDir)} could not be listed: ${String(err)}`);
      continue;
    }
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.name.endsWith(".md")) continue;
      const name = entry.name.slice(0, -".md".length);
      const location = join(root.dir, groupDir, entry.name);
      if (entry.isSymbolicLink() || !entry.isFile()) {
        conflicts.push(`${location} is not a regular file, so this migration cannot prove what it would read`);
        continue;
      }
      if (!SEGMENT.test(name)) {
        conflicts.push(`${location} is not a legacy step file name ([a-z0-9-].md)`);
        continue;
      }
      if (steps.size >= LIMITS.stepFiles) {
        conflicts.push(`${join(root.dir, LEGACY_STEPS_DIR)} holds more than ${LIMITS.stepFiles} legacy step files`);
        break;
      }
      const read = readLegacyStep(root, `${groupDir}/${entry.name}`, groupDir, `${group}.${name}`);
      if (typeof read === "string") conflicts.push(read);
      else steps.set(read.skillId, read.step);
    }
  }
  return { steps, conflicts };
}

function readLegacyStep(
  root: LegacyStepAuthorityRoot,
  relativePath: string,
  groupDir: string,
  skillId: string,
): { readonly skillId: string; readonly step: LegacyStep } | string {
  const location = join(root.dir, relativePath);
  if (!isQualifiedSkillId(skillId)) return `${location} does not name a qualified skill id`;
  let bytes: Buffer | undefined;
  let mode: number;
  try {
    bytes = readFileUnder(root.dir, relativePath, { maxBytes: LIMITS.stepBytes });
    mode = lstatSync(location).mode & 0o777;
  } catch (err) {
    return `${location} could not be read: ${err instanceof ContainedPathError ? err.message : String(err)}`;
  }
  if (bytes === undefined) return `${location} disappeared while it was being selected`;
  const text = bytes.toString("utf8");
  const parsed = parseFrontmatter(text);
  if (!parsed) return `${location} has no valid YAML frontmatter, so it cannot become a skill package`;
  let metadata: LegacyStepMetadata;
  try {
    metadata = Schema.decodeUnknownSync(RetiredStepMetadataSchema)(parsed.frontmatter);
  } catch (err) {
    return `${location} carries frontmatter this migration cannot read: ${String(err)}`;
  }
  return {
    skillId,
    step: {
      metadata,
      body: parsed.body,
      source: { relativePath, groupDir, digest: digestOf(text), mode },
    },
  };
}

/** The package one legacy step becomes. The skill owns the procedure and its
 *  direct-invocation contract. A step with no description keeps its name as the routing line,
 *  because a package with neither cannot be advertised at all. */
function renderSkillFile(step: LegacyStep): string {
  const { metadata } = step;
  const frontmatter: UnknownRecord = {
    name: metadata.name,
    description: metadata.description ?? metadata.name,
  };
  if (metadata.requiredSkills && metadata.requiredSkills.length > 0) frontmatter.dependencies = [...metadata.requiredSkills];
  if (metadata.agents && metadata.agents.length > 0) frontmatter.agents = [...metadata.agents];
  if (metadata["inline-output"] !== undefined) frontmatter["direct-output"] = metadata["inline-output"];
  if (metadata["user-invocable"] === false) frontmatter["user-invocable"] = false;
  if (metadata["disable-model-invocation"] === true) frontmatter["disable-model-invocation"] = true;
  return `---\n${renderYaml(frontmatter)}---\n${step.body}`;
}

function renderYaml(value: UnknownRecord): string {
  return yaml.dump(value, { lineWidth: -1, noRefs: true, sortKeys: false });
}

function digestOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Identity of one file this migration reads: its bytes and its mode. A caller
 *  holding the locks compares it against the plan to prove nothing moved. */
export function sourceIdentity(root: LegacyStepAuthorityRoot, relativePath: string): LegacySourceFile | undefined {
  try {
    const bytes = readFileUnder(root.dir, relativePath, { maxBytes: LIMITS.stepBytes });
    if (bytes === undefined) return undefined;
    const separator = relativePath.lastIndexOf("/");
    return {
      relativePath,
      groupDir: separator <= 0 ? "." : relativePath.slice(0, separator),
      digest: digestOf(bytes.toString("utf8")),
      mode: lstatSync(join(root.dir, relativePath)).mode & 0o777,
    };
  } catch {
    return undefined;
  }
}

/** Is the exact destination root free, does it already hold this deterministic
 *  target, or does it hold a different package? A component that is a symlink is
 *  refused rather than resolved, so a link put in the destination's place blocks
 *  the migration instead of redirecting it. */
export function publishedPackageState(root: LegacyStepAuthorityRoot, destinationDir: string, skillFile: string): "absent" | "matches" | "different" {
  try {
    requireContainedDirectory(root.dir, destinationDir);
  } catch {
    return "different";
  }
  let entries: readonly string[];
  try {
    entries = readdirSync(join(root.dir, destinationDir));
  } catch {
    return "absent";
  }
  // The staged target is one file, so a destination that holds anything else is
  // another package with the same id, whatever its `SKILL.md` says.
  if (entries.length !== 1 || entries[0] !== SKILL_FILE) return "different";
  const installed = readFileUnder(root.dir, `${destinationDir}/${SKILL_FILE}`, { maxBytes: LIMITS.stepBytes });
  return installed?.toString("utf8") === skillFile ? "matches" : "different";
}

