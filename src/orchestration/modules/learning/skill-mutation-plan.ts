import type { SkillSemanticAuditResult } from "../../agent-runtime/review-types.js";
/** Non-mutating planner of one managed-skill write. Every mutation, project or
 *  global, is normalized, admission-checked, and resolved to its exact
 *  resulting bytes here, before anything touches the filesystem. The plan is
 *  therefore the single source of truth for what a write produces: the store
 *  applies it locally, and the global operation manifest stages and publishes
 *  the very same plan after the user confirms it.
 *
 *  The plan's `proposalId` is the writer-prepared confirmation identity, and it
 *  is content-bound: it covers the action, the skill id, the reach, the source
 *  and destination directories, and the whole-package digest of the result,
 *  which itself folds every declared path, length, and byte. Changing one
 *  support-file byte after approval therefore produces a different identity and
 *  refuses the write. It names a proposal, never one run of it: the operation
 *  that applies a confirmed proposal carries its own identity. */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join, sep } from "node:path";
import { contentEvidence } from "../../../infra/content-evidence.js";
import type { LearningScope } from "../../../infra/learning-scope.js";
import { buildMutationDiff, type MutationDiff, type MutationDiffEndpoint, type MutationDiffTarget } from "../../../infra/mutation-diff.js";
import { redactSecrets } from "../../../infra/redact-secrets.js";
import { isQualifiedSkillId } from "../../../infra/skill-id.js";
import { firstThreatMessage } from "../../../infra/threat-patterns.js";
import { readSkillPackageFiles } from "../../../workflows/skill-context.js";
import { NEW_SKILL_TRIGGER_MAX_CHARS, SKILL_FILE, SKILL_LIMITS, type SkillDefinition, type SkillPackageBinding } from "../../../workflows/skill-schema.js";
import { ownedSkillStoreDirs } from "../../../workflows/skills.js";
import { canonicalMutationPath } from "../../../infra/file-mutation-queue.js";
import type {
  PreparedLocation,
  PreparedMutationOutcome,
  SkillMutation,
  SkillMutationPlan,
  SkillMutationPlanResult,
  SkillStoreConfig,
  SkillStoreRootName,
  SkillWriteAction,
  SkillWriteOrigin,
} from "./skill-store-types.js";
import { composeSkillFile, packageDigestAt, prepareSkillPackage, readPackageFiles, validateSkillFile } from "./skill-package-planning.js";
import { packagePathRefusal } from "../../../workflows/skill-package-path.js";
import { refuseOverBudgetBody } from "./skill-body-budget.js";

import { skillSemanticAuditEvidenceIsCurrent } from "./skill-semantic-audit.js";

/** Write-side bounds, tightened to the registry's admission limits
 *  where the loader is stricter, so the store can never write a package the
 *  catalog refuses. */
const MAX_NAME_CHARS = 64;
const MAX_DESCRIPTION_CHARS = 1_024;


/** Names that read as one session's artifact rather than a class of task. The
 *  review prompt carries the judgment; this is the store-level backstop. */
const SESSION_ARTIFACT_NAME = /(^(fix|hotfix|bug|issue|ticket|todo|task)-)|\d{4,}/;

/** Framing of the proposal identity. The version tag makes a later change of
 *  the framing a different identity, never a silent one. */
const PROPOSAL_IDENTITY_DOMAIN = "flywheel-skill-mutation/1";
export interface SkillStoreRootDirs {
  readonly user: string;
  readonly project: string;
}

export function storeRootDirs(config: SkillStoreConfig): SkillStoreRootDirs {
  return ownedSkillStoreDirs(config);
}

function reachOfRoot(root: SkillStoreRootName): LearningScope {
  return root === "user" ? "global" : "project";
}

/** The physical store one reach lives in. `user` is a directory name, never a
 *  reach: nothing outside this module speaks it. */
function rootOfReach(reach: LearningScope): SkillStoreRootName {
  return reach === "global" ? "user" : "project";
}

function archiveDirOf(config: SkillStoreConfig, root: SkillStoreRootName, name: string): string {
  return join(storeRootDirs(config)[root], ".archive", name);
}

function refused(error: string): SkillMutationPlanResult {
  return { kind: "refused", error };
}

/** Resolve one mutation to the exact package it produces, or say why it is
 *  refused. Reads the current package bytes but writes nothing. */
export function planSkillMutation(config: SkillStoreConfig, origin: SkillWriteOrigin, mutation: SkillMutation): SkillMutationPlanResult {
  try {
    const result = resolvePlan(config, origin, mutation);
    if (result.kind === "refused") return result;
    const overBudget = refuseOverBudgetBody(config, result.plan);
    if (overBudget) return refused(overBudget);
    if (origin.kind !== "review" || !requiresSemanticAudit(result.plan.action)) return result;
    return { kind: "planned", plan: { ...result.plan, semanticAudit: { kind: "required", registryRevision: config.registry().revision } } };
  } catch (err) {
    return refused(err instanceof Error ? err.message : String(err));
  }
}


function requiresSemanticAudit(action: SkillWriteAction): boolean {
  return action === "created" || action === "updated" || action === "patched" || action === "support_file" || action === "restored";
}

/** Admit review-authored bytes only when the audit result names the exact
 * candidate, canonical package relationship, and pinned registry revision. */
export function admitSkillMutationPlan(
  plan: SkillMutationPlan,
  revision: import("../../../workflows/skill-schema.js").SkillRegistryRevision,
  result: SkillSemanticAuditResult,
): SkillMutationPlanResult {
  if (plan.semanticAudit?.kind !== "required") return { kind: "planned", plan };
  if (result.kind !== "verified") {
    return refused(`Skill "${plan.name}" was not admitted: ${result.reason}. Nothing was written.`);
  }
  if (plan.semanticAudit.registryRevision !== revision.revision) {
    return refused(`Skill "${plan.name}" was not admitted: the registry revision moved while the audit ran. Nothing was written.`);
  }
  if (!skillSemanticAuditEvidenceIsCurrent(plan.outcome.package, revision, result.evidence)) {
    return refused(`Skill "${plan.name}" was not admitted: the audit evidence does not match the prepared package. Nothing was written.`);
  }
  return { kind: "planned", plan: { ...plan, semanticAudit: { kind: "admitted", evidence: result.evidence } } };
}

function resolvePlan(config: SkillStoreConfig, origin: SkillWriteOrigin, mutation: SkillMutation): SkillMutationPlanResult {
  if (mutation.kind === "restore") return planRestore(config, mutation);

  const resolved = resolveWritable(config, origin, mutation.name);
  if (resolved.kind === "refused") return refused(resolved.error);
  if (mutation.kind === "save" && resolved.kind === "absent") return planCreate(config, origin, mutation);
  if (resolved.kind === "absent") {
    return refused(mutation.kind === "support_file"
      ? `Skill "${mutation.name}" is not installed; create it with a save of its SKILL.md first.`
      : `Skill "${mutation.name}" is not installed.`);
  }

  // A promotion authors no bytes: it moves the package the user confirmed
  // verbatim, so the read-before-write mark that guards authored content does
  // not apply to it. The review can therefore recommend a promotion of a
  // package it wrote in this run; it still cannot publish one.
  const guard = mutation.kind === "promote" || mutation.kind === "replace_package" || mutation.kind === "remove_package" ? undefined : requireReadBeforeWrite(origin, mutation.name);
  if (guard) return refused(guard);

  const { definition, binding, root } = resolved.pkg;
  const dir = binding.canonicalDir;
  const location: PreparedLocation = { reach: reachOfRoot(root), root, dir };
  // The package is read through the binding the load published, so a directory
  // swapped under the store after that publication is refused rather than
  // prepared from.
  // Only an external package is writable, so every read here is admitted under
  // the external authority's per-file caps.
  const current = readSkillPackageFiles(binding, "external") ?? new Map<string, string>();

  switch (mutation.kind) {
    case "save": return planRewrite(origin, mutation, definition, location, current);
    case "support_file": return planSupportFile(mutation, definition, location, current);
    case "remove_file": return planRemoveFile(mutation, definition, location, current);
    case "patch": return planPatch(mutation, definition, location, current);
    case "archive": return planArchive(config, origin, mutation, definition, location, current);
    case "promote": return planPromotion(config, mutation, definition, location, current);
    case "replace_package": return planExactReplacement(mutation, definition, location, current);
    case "remove_package": return planExactRemoval(config, mutation, definition, location, current);
  }
}

function planCreate(config: SkillStoreConfig, origin: SkillWriteOrigin, mutation: Extract<SkillMutation, { kind: "save" }>): SkillMutationPlanResult {
  const normalized = normalizeSave(mutation);
  if ("error" in normalized) return refused(normalized.error);
  // Every agent's prompt carries the description, so a skill Flywheel creates
  // must fit the creation budget; updates skip the check so existing skills
  // stay maintainable.
  if (normalized.description.length > NEW_SKILL_TRIGGER_MAX_CHARS) {
    return refused(`Description is ${normalized.description.length} chars; a new skill's description must fit the ${NEW_SKILL_TRIGGER_MAX_CHARS}-char catalog budget, because every agent's prompt carries it.`);
  }
  const reach = mutation.reach ?? "project";
  const root = rootOfReach(reach);
  const dir = join(storeRootDirs(config)[root], mutation.name);
  if (existsSync(dir)) {
    return refused(`A directory for "${mutation.name}" already exists in the ${reach} store but is not an installed package; resolve it by hand.`);
  }
  const id = originId(origin);
  const content = composeSkillFile(normalized.description, "flywheel", id, id, normalized.body, normalized.dependencies);
  const valid = validateSkillFile(content);
  if ("error" in valid) return refused(valid.error);

  const location: PreparedLocation = { reach, root, dir };
  return packagePlan({
    action: "created",
    name: mutation.name,
    location,
    // A create has no pre-state: the plan's own diff is a whole-file addition.
    before: new Map<string, string>(),
    files: new Map([[SKILL_FILE, content]]),
    writePath: SKILL_FILE,
    description: normalized.description,
    contentHash: contentEvidence(content).sha256,
    message: `Skill "${mutation.name}" created in the ${reach} store.`,
  });
}

function planRewrite(
  origin: SkillWriteOrigin,
  mutation: Extract<SkillMutation, { kind: "save" }>,
  definition: SkillDefinition,
  location: PreparedLocation,
  current: ReadonlyMap<string, string>,
): SkillMutationPlanResult {
  const normalized = normalizeSave(mutation);
  if ("error" in normalized) return refused(normalized.error);
  // Preserve the write contract and creation provenance across rewrites;
  // SAFETY of managed: resolveWritable refused an unmarked package above.
  const managed = definition.managed ?? "flywheel";
  const createdBy = definition.provenance?.createdBy ?? originId(origin);
  const content = composeSkillFile(normalized.description, managed, createdBy, originId(origin), normalized.body, normalized.dependencies);
  const valid = validateSkillFile(content);
  if ("error" in valid) return refused(valid.error);

  const next = new Map(current).set(SKILL_FILE, content);
  return packagePlan({
    action: "updated",
    name: mutation.name,
    location,
    before: current,
    files: next,
    writePath: SKILL_FILE,
    description: normalized.description,
    contentHash: contentEvidence(content).sha256,
    message: `Skill "${mutation.name}" rewritten.`,
  });
}

function planSupportFile(
  mutation: Extract<SkillMutation, { kind: "support_file" }>,
  definition: SkillDefinition,
  location: PreparedLocation,
  current: ReadonlyMap<string, string>,
): SkillMutationPlanResult {
  const pathError = packagePathRefusal(mutation.path);
  if (pathError) return refused(pathError);
  const content = redactSecrets(mutation.content);
  const blocked = scanContent(content);
  if (blocked) return refused(blocked);
  if (!current.has(mutation.path) && definition.resources.length >= SKILL_LIMITS.resources) {
    return refused(`Skill "${mutation.name}" already declares ${SKILL_LIMITS.resources} resources, the admission limit.`);
  }

  return packagePlan({
    action: "support_file",
    name: mutation.name,
    location,
    before: current,
    files: new Map(current).set(mutation.path, content),
    writePath: mutation.path,
    description: definition.trigger,
    contentHash: contentEvidence(content).sha256,
    message: `Support file ${mutation.path} written under skill "${mutation.name}".`,
  });
}

function planRemoveFile(
  mutation: Extract<SkillMutation, { kind: "remove_file" }>,
  definition: SkillDefinition,
  location: PreparedLocation,
  current: ReadonlyMap<string, string>,
): SkillMutationPlanResult {
  const pathError = packagePathRefusal(mutation.path);
  if (pathError) return refused(pathError);
  if (!current.has(mutation.path)) {
    return refused(`Skill "${mutation.name}" has no support file at ${mutation.path}. Declared resources: ${definition.resources.map((resource) => resource.path).join(", ") || "(none)"}.`);
  }
  const next = new Map(current);
  next.delete(mutation.path);
  const prepared = prepareSkillPackage(next);
  if ("error" in prepared) return refused(prepared.error);

  return finish({
    action: "file_removed",
    name: mutation.name,
    location,
    before: current,
    outcome: { kind: "absence", destination: location, package: prepared.package, removePath: mutation.path },
    description: definition.trigger,
    contentHash: contentEvidence("").sha256,
    message: `Support file ${mutation.path} removed from skill "${mutation.name}".`,
  });
}

function planPatch(
  mutation: Extract<SkillMutation, { kind: "patch" }>,
  definition: SkillDefinition,
  location: PreparedLocation,
  current: ReadonlyMap<string, string>,
): SkillMutationPlanResult {
  if (!mutation.oldString) return refused("old_string cannot be empty.");
  const path = mutation.path ?? SKILL_FILE;
  if (path !== SKILL_FILE) {
    const pathError = packagePathRefusal(path);
    if (pathError) return refused(pathError);
  }
  const newString = redactSecrets(mutation.newString);
  const blocked = scanContent(newString);
  if (blocked) return refused(blocked);

  const content = current.get(path);
  if (content === undefined) return refused(`Skill "${mutation.name}" has no file at ${path}.`);
  const occurrences = content.split(mutation.oldString).length - 1;
  if (occurrences === 0) return refused(`old_string was not found in ${path}. Load the skill and copy the exact text to replace.`);
  if (occurrences > 1) return refused(`old_string matches ${occurrences} places in ${path}; include more surrounding context so it matches exactly once.`);
  const next = content.replace(mutation.oldString, newString);

  let description = definition.trigger;
  if (path === SKILL_FILE) {
    const valid = validateSkillFile(next);
    if ("error" in valid) return refused(valid.error);
    description = valid.trigger;
  }
  return packagePlan({
    action: "patched",
    name: mutation.name,
    location,
    before: current,
    files: new Map(current).set(path, next),
    writePath: path,
    description,
    contentHash: contentEvidence(next).sha256,
    message: `Skill "${mutation.name}" patched (${path}).`,
  });
}

function planArchive(
  config: SkillStoreConfig,
  origin: SkillWriteOrigin,
  mutation: Extract<SkillMutation, { kind: "archive" }>,
  definition: SkillDefinition,
  location: PreparedLocation,
  current: ReadonlyMap<string, string>,
): SkillMutationPlanResult {
  if (origin.kind === "review") {
    const absorbedInto = mutation.absorbedInto;
    if (!absorbedInto || absorbedInto === mutation.name || !config.registry().skills.has(absorbedInto)) {
      return refused("A review archive requires absorbedInto naming a different installed skill that absorbed this content; a bare prune is refused.");
    }
  }
  const archiveDir = archiveDirOf(config, location.root, mutation.name);
  if (existsSync(archiveDir)) return refused(`The archive already holds a package named "${mutation.name}"; restore or remove it first.`);
  const prepared = prepareSkillPackage(current);
  if ("error" in prepared) return refused(prepared.error);

  return finish({
    action: "archived",
    name: mutation.name,
    location,
    before: current,
    outcome: {
      kind: "archive",
      source: location,
      destination: { ...location, dir: archiveDir },
      package: prepared.package,
    },
    description: definition.trigger,
    contentHash: definition.evidence.sha256,
    message: `Skill "${mutation.name}" archived to .archive/; restore reverses it.`,
  });
}

function planRestore(config: SkillStoreConfig, mutation: Extract<SkillMutation, { kind: "restore" }>): SkillMutationPlanResult {
  const nameError = validateName(mutation.name);
  if (nameError) return refused(nameError);
  const roots = storeRootDirs(config);
  // A global restore selects the global archive: reach is the caller's, never
  // whichever store happens to hold an archived package of the same name.
  const candidates = (["project", "user"] as const).filter((root) => mutation.reach === undefined || reachOfRoot(root) === mutation.reach);
  for (const root of candidates) {
    const archiveDir = join(roots[root], ".archive", mutation.name);
    if (!existsSync(archiveDir)) continue;
    const liveDir = join(roots[root], mutation.name);
    if (existsSync(liveDir)) return refused(`A live package named "${mutation.name}" already exists in the ${reachOfRoot(root)} store.`);
    const current = readPackageFiles(archiveDir);
    const prepared = prepareSkillPackage(current);
    if ("error" in prepared) return refused(prepared.error);
    const valid = validateSkillFile(current.get(SKILL_FILE) ?? "");
    const location: PreparedLocation = { reach: reachOfRoot(root), root, dir: liveDir };
    return finish({
      action: "restored",
      name: mutation.name,
      location,
      before: current,
      outcome: {
        kind: "restore",
        source: { ...location, dir: archiveDir },
        destination: location,
        package: prepared.package,
      },
      description: "error" in valid ? "" : valid.trigger,
      contentHash: contentEvidence(current.get(SKILL_FILE) ?? "").sha256,
      message: `Skill "${mutation.name}" restored from the ${reachOfRoot(root)} archive.`,
    });
  }
  const where = mutation.reach ?? "project or global";
  return refused(`No archived package named "${mutation.name}" in the ${where} store.`);
}

/** Move one project package into the global store under the same id. The plan
 *  carries the destination's reach, so a promotion needs the same typed
 *  confirmation as any other global mutation, and its two locations can be two
 *  filesystems, so the publisher stages rather than renames.
 *
 *  One id names one package: a promotion that would leave a second package
 *  under the same id, in the global store or in a shared root the project copy
 *  already shadows, is refused rather than resolved by precedence. */
function planPromotion(
  config: SkillStoreConfig,
  mutation: Extract<SkillMutation, { kind: "promote" }>,
  definition: SkillDefinition,
  source: PreparedLocation,
  current: ReadonlyMap<string, string>,
): SkillMutationPlanResult {
  if (source.root !== "project") {
    return refused(`Skill "${mutation.name}" is already a global package; promotion moves a project package into the global store.`);
  }
  if (definition.shadowed) {
    return refused(`Skill "${mutation.name}" shadows another installed package with the same id, so promoting it would leave two packages for one id. Resolve that conflict first; a distinct project specialization uses a distinct id.`);
  }
  const destinationDir = join(storeRootDirs(config).user, mutation.name);
  if (existsSync(destinationDir)) {
    return refused(`A global package named "${mutation.name}" already exists. Resolve that conflict first; a distinct project specialization uses a distinct id.`);
  }
  const prepared = prepareSkillPackage(current);
  if ("error" in prepared) return refused(prepared.error);

  const destination: PreparedLocation = { reach: "global", root: "user", dir: destinationDir };
  return finish({
    action: "promoted",
    name: mutation.name,
    location: destination,
    before: current,
    outcome: { kind: "promotion", source, destination, package: prepared.package },
    description: definition.trigger,
    contentHash: contentEvidence(current.get(SKILL_FILE) ?? "").sha256,
    message: `Skill "${mutation.name}" promoted from the project store to the global store.`,
  });
}

function planExactReplacement(
  mutation: Extract<SkillMutation, { kind: "replace_package" }>,
  definition: SkillDefinition,
  location: PreparedLocation,
  current: ReadonlyMap<string, string>,
): SkillMutationPlanResult {
  return packagePlan({
    action: "updated",
    name: mutation.name,
    location,
    before: current,
    files: new Map(Object.entries(mutation.files)),
    writePath: SKILL_FILE,
    description: definition.trigger,
    contentHash: contentEvidence(mutation.files[SKILL_FILE] ?? "").sha256,
    message: `Skill "${mutation.name}" replaced with the approved complete package.`,
  });
}

function planExactRemoval(
  config: SkillStoreConfig,
  mutation: Extract<SkillMutation, { kind: "remove_package" }>,
  definition: SkillDefinition,
  location: PreparedLocation,
  current: ReadonlyMap<string, string>,
): SkillMutationPlanResult {
  const prepared = prepareSkillPackage(current);
  if ("error" in prepared) return refused(prepared.error);
  const destination: PreparedLocation = { ...location, dir: archiveDirOf(config, location.root, mutation.name) };
  return finish({
    action: "archived",
    name: mutation.name,
    location,
    before: current,
    outcome: { kind: "archive", source: location, destination, package: prepared.package },
    description: definition.trigger,
    contentHash: contentEvidence("").sha256,
    message: `Skill "${mutation.name}" removed so the bundled default is active.`,
  });
}

interface PackagePlanInput {
  action: SkillWriteAction;
  name: string;
  location: PreparedLocation;
  /** The package as it stands at the outgoing location, keyed by
   *  package-relative path. The diff is captured against it. */
  before: ReadonlyMap<string, string>;
  files: ReadonlyMap<string, string>;
  writePath: string;
  description: string;
  contentHash: string;
  message: string;
}

function packagePlan(input: PackagePlanInput): SkillMutationPlanResult {
  const prepared = prepareSkillPackage(input.files);
  if ("error" in prepared) return refused(prepared.error);
  return finish({
    ...input,
    outcome: { kind: "package", destination: input.location, package: prepared.package, writePath: input.writePath },
  });
}

interface FinishInput {
  action: SkillWriteAction;
  name: string;
  location: PreparedLocation;
  before: ReadonlyMap<string, string>;
  outcome: PreparedMutationOutcome;
  description: string;
  contentHash: string;
  message: string;
}

function finish(input: FinishInput): SkillMutationPlanResult {
  // The digest the outgoing location holds right now. Every applier revalidates
  // it under the package locks (`planStaleness`), so a mutation planned against
  // one package state can never be applied onto another one: two concurrent
  // writes would otherwise union into a package nobody planned.
  const base = packageDigestAt(outgoingDirOf(input.outcome));
  const plan: SkillMutationPlan = {
    proposalId: proposalIdentity(input.action, input.name, input.location.reach, input.outcome),
    action: input.action,
    name: input.name,
    reach: input.location.reach,
    root: input.location.root,
    outcome: input.outcome,
    description: input.description,
    contentHash: input.contentHash,
    diff: planDiff(input),
    message: input.message,
    summary: summarize(input),
    ...(base ? { basePackageSha256: base } : {}),
  };
  return { kind: "planned", plan };
}

function summarize(input: FinishInput): string {
  const pkg = input.outcome.package;
  const files = pkg.files.map((file) => `${file.path} (${file.bytes} bytes)`).join(", ");
  return [
    `${input.action.replace("_", " ")} ${input.location.reach} skill "${input.name}"`,
    input.description ? `description: ${input.description}` : "",
    `resulting package: ${pkg.identity.bytes} bytes, sha256 ${pkg.identity.sha256}`,
    `files: ${files}`,
  ].filter((line) => line.length > 0).join("\n");
}

/** What applying this plan changes, captured from the plan's own endpoints: the
 *  package the outgoing location holds now, and the exact bytes the plan
 *  produces. Nothing here rereads the filesystem, so the diff describes the
 *  mutation the caller confirms rather than whatever the tree looks like later.
 *
 *  A move is two changes at two paths, and both are retained: the package
 *  disappears from its source and appears at its destination. */
function planDiff(input: FinishInput): MutationDiff {
  const outcome = input.outcome;
  const sourceDir = "source" in outcome ? outcome.source.dir : outcome.destination.dir;
  const destinationDir = outcome.destination.dir;
  const after = new Map(outcome.package.files.map((file) => [file.path, file.content]));
  const paths = [...new Set([...input.before.keys(), ...after.keys()])];
  const moved = sourceDir !== destinationDir;
  return buildMutationDiff(paths.flatMap((path): MutationDiffTarget[] => (moved
    ? [
      { path: join(sourceDir, path), before: endpoint(input.before.get(path)), after: { kind: "absent" } },
      { path: join(destinationDir, path), before: { kind: "absent" }, after: endpoint(after.get(path)) },
    ]
    : [{ path: join(destinationDir, path), before: endpoint(input.before.get(path)), after: endpoint(after.get(path)) }])));
}

function endpoint(text: string | undefined): MutationDiffEndpoint {
  return text === undefined ? { kind: "absent" } : { kind: "text", text };
}

/** Fold every content-bound field of the mutation into one opaque identity.
 *  The package digest already folds each file's path, length, and bytes, so a
 *  change anywhere in the package changes the identity.
 *
 *  The pre-state digest is deliberately NOT folded in: the identity names the
 *  proposed result, so the same proposal prepared twice is one proposal to ask
 *  about. The pre-state is carried beside the identity in the plan and enforced
 *  by the publisher under the package locks. */
function proposalIdentity(
  action: SkillWriteAction,
  name: string,
  reach: LearningScope,
  outcome: PreparedMutationOutcome,
): string {
  const digest = createHash("sha256").update(PROPOSAL_IDENTITY_DOMAIN);
  const source = "source" in outcome ? outcome.source : undefined;
  const destination = outcome.destination;
  const path = outcome.kind === "package" ? outcome.writePath : outcome.kind === "absence" ? outcome.removePath : "";
  for (const field of [action, name, reach, outcome.kind, canonicalMutationPath(source?.dir ?? ""), canonicalMutationPath(destination.dir), path, outcome.package.identity.sha256, String(outcome.package.identity.bytes)]) {
    digest.update(`${field.length}\n${field}\n`);
  }
  return digest.digest("hex");
}

/** Recompute one plan's identity from the plan itself. A persisted plan is
 *  trusted only when it still names the proposal its record claims. */
export function proposalIdentityOfPlan(plan: SkillMutationPlan): string {
  return proposalIdentity(plan.action, plan.name, plan.reach, plan.outcome);
}



interface WritablePackage {
  definition: SkillDefinition;
  binding: SkillPackageBinding;
  root: SkillStoreRootName;
}

/** Resolve an existing package for a mutation under the origin-aware write
 *  contract, or say why it is off-limits. `absent` means the name is free to
 *  create. */
function resolveWritable(
  config: SkillStoreConfig,
  origin: SkillWriteOrigin,
  name: string,
): { kind: "ok"; pkg: WritablePackage } | { kind: "absent" } | { kind: "refused"; error: string } {
  const definition = config.registry().skills.get(name);
  if (!definition) return { kind: "absent" };
  if (definition.source.authority === "bundled") {
    return { kind: "refused", error: `Skill "${name}" is a bundled package; bundled packages refuse every write.` };
  }
  if (definition.source.kind !== "filesystem") {
    return { kind: "refused", error: `Skill "${name}" is not an editable filesystem package.` };
  }
  const binding = definition.source;
  if (binding.linked) return { kind: "refused", error: `Skill "${name}" is installed as a link to a package directory elsewhere; Flywheel does not write through a link. Edit the package where the link points.` };
  const root = rootOf(config, binding.canonicalDir);
  if (!root) {
    return { kind: "refused", error: `Skill "${name}" is installed in a shared root the runtime does not own; edit it where it lives.` };
  }
  if (definition.managed === undefined) {
    return { kind: "refused", error: `Skill "${name}" carries no managed marker, so writes are refused. Add "managed: user" to its frontmatter to claim it, or edit the files directly.` };
  }
  if (definition.managed === "user" && (origin.kind === "review" || origin.kind === "pruner")) {
    return { kind: "refused", error: `Skill "${name}" is pinned (managed: user); no autonomous actor may change it. If it is wrong, say so in the reply and recommend the user adopt the change.` };
  }
  return { kind: "ok", pkg: { definition, binding, root } };
}

function rootOf(config: SkillStoreConfig, canonicalDir: string): SkillStoreRootName | undefined {
  const roots = storeRootDirs(config);
  for (const name of ["project", "user"] as const) {
    const rootPath = canonicalMutationPath(roots[name]);
    if (canonicalDir.startsWith(rootPath + sep)) return name;
  }
  return undefined;
}

/** The review may not rewrite content it merely inferred from the transcript:
 *  a mutation of an existing package requires a load of that package through
 *  the skill tool within the same review run. */
function requireReadBeforeWrite(origin: SkillWriteOrigin, name: string): string | undefined {
  if (origin.kind !== "review") return undefined;
  if (origin.loadedSkillIds.has(name)) return undefined;
  return `Load skill "${name}" with the skill tool before changing it: the review may only patch content it has actually read in this run.`;
}

function normalizeSave(mutation: Extract<SkillMutation, { kind: "save" }>): { description: string; body: string; dependencies: readonly string[] } | { error: string } {
  const nameError = validateName(mutation.name);
  if (nameError) return { error: nameError };
  const description = redactSecrets(mutation.description).replace(/\s+/gu, " ").trim();
  if (!description) return { error: "A skill needs a description: it is the catalog's routing surface." };
  if (description.length > MAX_DESCRIPTION_CHARS) {
    return { error: `Description is ${description.length} chars; the limit is ${MAX_DESCRIPTION_CHARS}.` };
  }
  const body = redactSecrets(mutation.body).trim();
  if (!body) return { error: "A skill needs a body: the trigger is a pointer, never enough to act on." };
  const dependencies = mutation.dependencies ?? [];
  if (dependencies.some((dependency) => !isQualifiedSkillId(dependency))) return { error: "Every dependency must be a dot-delimited lowercase skill id." };
  if (new Set(dependencies).size !== dependencies.length) return { error: "Skill dependencies must be unique." };
  const blocked = scanContent(body) ?? scanContent(description);
  if (blocked) return { error: blocked };
  return { description, body, dependencies };
}

function validateName(name: string): string | undefined {
  if (!isQualifiedSkillId(name)) return `Skill name must be a dot-delimited lowercase slug ([a-z0-9-]): ${JSON.stringify(name)}.`;
  if (name.length > MAX_NAME_CHARS) return `Skill name is ${name.length} chars; the limit is ${MAX_NAME_CHARS}.`;
  if (SESSION_ARTIFACT_NAME.test(name)) {
    return `Skill name "${name}" reads as a one-session artifact (ticket number, fix-of-the-day). Name the class of task the skill teaches.`;
  }
  return undefined;
}


function originId(origin: SkillWriteOrigin): string {
  switch (origin.kind) {
    case "review": return origin.reviewRunId;
    case "agent": return origin.sessionId;
    case "user": return "user";
    case "pruner": return "pruner";
  }
}

function scanContent(content: string): string | undefined {
  return firstThreatMessage(content, "strict") ?? undefined;
}


/** The paths one plan mutates, for deterministic multi-path locking. */
export function planLockPaths(plan: SkillMutationPlan): readonly string[] {
  const outcome = plan.outcome;
  return "source" in outcome ? [outcome.source.dir, outcome.destination.dir] : [outcome.destination.dir];
}

/** The live package directory the mutation moves or replaces: the source of a
 *  move, and the destination of an in-place write. Its digest is the plan's
 *  pre-state, and it is the directory the publisher hides before it swaps. */
export function outgoingDirOf(outcome: PreparedMutationOutcome): string {
  return "source" in outcome ? outcome.source.dir : outcome.destination.dir;
}

/** Does the destination already hold exactly the prepared result? A resumed or
 *  replayed operation reads this as "already applied" instead of writing
 *  again. */
export function destinationMatchesPlan(plan: SkillMutationPlan): boolean {
  const outcome = plan.outcome;
  if (outcome.kind === "archive") return !existsSync(outcome.source.dir) && existsSync(outcome.destination.dir);
  // A promotion is applied when the source is gone and the destination holds
  // exactly the confirmed package: one visible authority, not two.
  if (outcome.kind === "promotion") {
    return !existsSync(outcome.source.dir) && packageDigestAt(outcome.destination.dir) === outcome.package.identity.sha256;
  }
  return packageDigestAt(outcome.destination.dir) === outcome.package.identity.sha256;
}

/** How the live filesystem differs from the state one plan was computed from,
 *  or undefined when the plan still applies:
 *
 *  - `creation_conflict`: a package now stands where this plan would create one.
 *  - `base_absent`: the package this plan changes is no longer installed.
 *  - `base_moved`: it is installed but is no longer the package the plan was
 *    computed from, so applying the plan would publish a union nobody planned.
 *  - `move_conflict`: a package now stands where this plan would move one.
 *
 *  Every applier asks this under the package locks. The refusal wording belongs
 *  to the applier, because a project write is simply retried while a confirmed
 *  global write must be prepared and asked again. */
export type PlanStaleness = "creation_conflict" | "base_absent" | "base_moved" | "move_conflict";

export function planStaleness(plan: SkillMutationPlan): PlanStaleness | undefined {
  const outcome = plan.outcome;
  if (plan.basePackageSha256 === undefined) {
    return existsSync(outcome.destination.dir) ? "creation_conflict" : undefined;
  }
  const outgoing = packageDigestAt(outgoingDirOf(outcome));
  if (outgoing !== plan.basePackageSha256) return outgoing === undefined ? "base_absent" : "base_moved";
  return "source" in outcome && existsSync(outcome.destination.dir) ? "move_conflict" : undefined;
}
