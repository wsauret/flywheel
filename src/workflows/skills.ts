import { join } from "node:path";
import { sharedAgentsDir } from "../infra/paths.js";
import type { ProjectDirectories } from "../infra/directory-authorities.js";
import { contentEvidence } from "../infra/content-evidence.js";
import type { LearningScope } from "../infra/learning-scope.js";
import { errorMessage } from "../infra/error-message.js";
import { parseFrontmatter } from "../infra/frontmatter.js";
import { Log } from "../infra/log.js";
import { requireQualifiedSkillId } from "../infra/skill-id.js";
import type { SkillDirectoryEntries, ResolvedStepRoot, SkillPackage } from "./skill-context.js";
import {
  holdsSkillFile,
  isAbsentPath,
  readManifestPackage,
  readSkillPackageFiles,
  withSkillRoot,
} from "./skill-context.js";
import type { BundledSkillPackage, SkillAuthority, SkillDefinition, SkillSource } from "./skill-schema.js";
import { normalizeSkillFrontmatter, publishSkillRevision, SKILL_FILE, SKILL_LIMITS, skillFileByteCap } from "./skill-schema.js";
import { resolveDefinitionCandidates, shouldLogDefinitionMasking, type DefinitionCandidate, type DefinitionResolution, type DefinitionSource } from "../infra/definition-resolution.js";
import type { BundledSkillSourceKind } from "./skill-source-inventory.js";
import { resolveSkillClosure } from "./skill-closure.js";

const log = Log.create({ service: "skill-loader" });

/** One external skill store root. Flywheel owns its project and user stores:
 *  it creates them when absent and the learning review writes into
 *  them. A foreign root is shared with other harnesses, so it is read when it
 *  exists and never created or written. */
export interface SkillStoreRoot {
  readonly dir: string;
  readonly owned: boolean;
  /** Reach of every package installed under this root (ARCH-LEARNING-005). */
  readonly reach: LearningScope;
}

/** The project's own skill store. Named on its own because a consumer that
 *  identifies one workspace needs no account paths. */
export function projectSkillStoreDir(projectRoot: string): string {
  return join(projectRoot, ".flywheel", "skills");
}

interface OwnedSkillStoreDirs {
  readonly project: string;
  readonly user: string;
}
/** The two stores Flywheel owns and writes: the project's and the user's. */
export function ownedSkillStoreDirs(directories: Pick<ProjectDirectories, "projectRoot" | "userDataRoot">): OwnedSkillStoreDirs {
  return {
    project: projectSkillStoreDir(directories.projectRoot),
    user: userSkillStoreDir(directories.userDataRoot),
  };
}

/** The account-global store Flywheel owns. Named on its own because a consumer
 *  that writes only global packages has no project root to pass. */
export function userSkillStoreDir(userDataRoot: string): string {
  return join(userDataRoot, "skills");
}

/** External skill store roots of one project, highest precedence first: the
 *  project store, the Flywheel user store, then the shared
 *  `~/.agents/skills/` directory that other agent tools also read, so one
 *  installed skill serves each of them. */
export function skillStoreRoots(directories: ProjectDirectories): readonly SkillStoreRoot[] {
  const owned = ownedSkillStoreDirs(directories);
  return [
    { dir: owned.project, owned: true, reach: "project" },
    { dir: owned.user, owned: true, reach: "global" },
    { dir: join(sharedAgentsDir(directories.accountHome), "skills"), owned: false, reach: "global" },
  ];
}

type SkillPackageRoot =
  | {
    readonly authority: "external";
    readonly dir: string;
    readonly reach: LearningScope;
  }
  | {
    readonly authority: "bundled";
    readonly dir: string;
    readonly reach: LearningScope;
    /** Architectural owner carried from the source inventory. */
    readonly sourceKind: BundledSkillSourceKind;
    /** The module definition bundle this root belongs to, by contribution id. */
    readonly bundle?: string;
    /** The bundle's packages compiled into the binary, keyed `<package>/<path>`.
     *  Read only when this root holds no package on disk, so the source tree
     *  wins in development and a binary, which has no bundle directory, still
     *  loads them. */
    readonly manifest?: Iterable<readonly [string, string]>;
  };

export interface SkillSources {
  /** Package roots, highest precedence first. */
  readonly roots: readonly SkillPackageRoot[];
  /** Bundled package files compiled into the binary, keyed `<package>/<path>`.
   *  Read only when no bundled root holds packages, so the source tree always
   *  wins in development. */
  readonly bundledEntries?: Iterable<readonly [string, string]>;
  /** Directory stream every root listing and package walk of this load reads.
   * A caller substitutes it to drive a load against entries it controls. */
  readonly entriesOf?: SkillDirectoryEntries;
  /** Selectable definitions for this runtime. Ineligible packages remain in
   *  the bundled corpus but cannot mask an eligible lower-precedence package. */
  readonly eligible?: (definition: SkillDefinition) => boolean;
}

export interface SkillLoad {
  /** Canonical definitions keyed by package name, precedence resolved. */
  readonly skills: Map<string, SkillDefinition>;
  /** Exact bundled packages from this load, before precedence resolution. */
  readonly bundledCorpus: Map<string, BundledSkillPackage>;
  /** Ids whose highest-precedence installed copy is unreadable or malformed,
   *  so the package this load selects is not the one the roots describe. A
   *  lower-precedence copy of the same id may still have loaded, which is
   *  exactly a winner that changed because of a failure. A child directory that
   *  holds no `SKILL.md` is not a package and is never reported here, so a
   *  caller can tell an absent package from one that was observed and could not
   *  be read. A failure under an already-selected id is not reported: the
   *  winner is unchanged. */
  readonly failedSelectionIds: ReadonlySet<string>;
  /** Roots that exist but could not be listed, or whose canonical directory
   *  could not be bound. Their packages were never observed, so this load is a
   *  partial view of what is installed. */
  readonly unreadableRoots: readonly string[];
  /** Lossless precedence decisions for every observed package id. */
  readonly resolutions: readonly DefinitionResolution<SkillDefinition>[];
}

interface ManifestPackages {
  readonly definitions: SkillDefinition[];
  readonly corpus: Map<string, BundledSkillPackage>;
}

/** Load every installed skill package into canonical definitions, keyed by
 *  package name. A malformed external package is skipped with a logged warning
 *  and reported in `failedSelectionIds`: third-party artifacts must not break
 *  startup, but a caller that replaces a published revision must not read the
 *  failure as a removal. A package over an admission limit is refused the same
 *  way. An external package whose dependencies are not installed is
 *  unavailable, not broken: it is left out with only a DEBUG record. A
 *  malformed bundled package is a Flywheel build bug and throws. */
export function loadSkillDefinitions(sources: SkillSources): SkillLoad {
  const entriesOf = sources.entriesOf;
  const loaded: SkillDefinition[] = [];
  const rejected: Array<{ readonly id: string; readonly source: DefinitionSource; readonly reason: string }> = [];
  const bundledCorpus = new Map<string, BundledSkillPackage>();
  const selection = new Map<string, "loaded" | "failed">();
  const bundledLocations = new Map<string, string>();
  const unreadableRoots: string[] = [];
  let bundledOnDisk = 0;
  let externalCount = 0;

  function readPackage(bound: ResolvedStepRoot, root: SkillPackageRoot, dirName: string): void {
    // The package is bound through the root descriptor before any of its bytes
    // are read, so an entry that is not a directory installed in this root is
    // refused, not loaded, and every byte that follows is read through that
    // binding.
    const binding = bound.bindPackage(dirName);
    if (binding === undefined) return;

    if (root.authority === "external" && externalCount >= SKILL_LIMITS.packages) {
      // Refused before it is read: a package this load cannot admit costs one
      // open of its `SKILL.md`, never its body and its file tree. A child
      // directory that is no package is no failure, over the limit as under.
      if (!holdsSkillFile(binding)) return;
      throw new Error(`more than ${SKILL_LIMITS.packages} skill packages are installed; uninstall packages to bring the count under the limit`);
    }

    const rawContents = readSkillPackageFiles(binding, root.authority, entriesOf);
    // A child directory without SKILL.md is not a package; nothing to report.
    if (rawContents === undefined) return;
    if (!rawContents.has(SKILL_FILE)) throw new Error(`the package holds no ${SKILL_FILE}`);
    const contents = readManifestPackage(rawContents);
    const id = dirName.toLowerCase();
    if (root.authority === "bundled") {
      const location = join(root.dir, dirName, SKILL_FILE);
      const previous = bundledLocations.get(id);
      if (previous !== undefined) throw new Error(`Duplicate bundled skill package "${id}": ${previous} and ${location}`);
      bundledLocations.set(id, location);
    }

    const definition = buildDefinition(dirName, contents, {
      kind: "filesystem",
      authority: root.authority,
      reach: root.reach,
      packageDir: join(root.dir, dirName),
      ...(root.authority === "bundled" && root.bundle !== undefined ? { bundle: root.bundle } : {}),
      ...binding,
    });
    loaded.push(definition);
    if (root.authority === "bundled") bundledCorpus.set(dirName.toLowerCase(), bundledPackage(dirName, contents, rawContents, root.sourceKind));
    if (root.authority === "bundled") bundledOnDisk++;
    else externalCount++;
    if (!selection.has(id)) selection.set(id, "loaded");
  }

  for (const root of sources.roots) {
    const onDiskBefore = bundledOnDisk;
    // The limit is global, so once it is spent no later external root can add
    // a package to this load. Such a root is never opened, listed, or read.
    if (root.authority === "external" && externalCount >= SKILL_LIMITS.packages) continue;

    // A package that fails is reported after the scan, so a bundled build bug,
    // which is raised rather than logged, is not mistaken for a root the load
    // could not read.
    const failures: Array<{ readonly dirName: string; readonly err: unknown }> = [];
    try {
      withSkillRoot(root.dir, (bound) => {
        // One directory past the limit is enough to refuse the load, so a root
        // of any size costs the same bounded listing.
        for (const dirName of bound.listPackageDirs(SKILL_LIMITS.packages + 1)) {
          try {
            readPackage(bound, root, dirName);
          } catch (err) {
            failures.push({ dirName, err });
            const id = dirName.toLowerCase();
            if (!selection.has(id)) selection.set(id, "failed");
          }
        }
      }, entriesOf);
    } catch (err) {
      if (!isAbsentPath(err)) {
        if (root.authority === "bundled") throw new Error(`Bundled skill root is installed but unreadable: ${root.dir}: ${errorMessage(err)}`, { cause: err });
        log.warn(`Skill root is installed but unreadable: ${errorMessage(err)}`, { location: root.dir });
        unreadableRoots.push(root.dir);
      }
    }

    for (const { dirName, err } of failures) {
      const location = join(root.dir, dirName, SKILL_FILE);
      if (root.authority === "external") {
        rejected.push({
          id: dirName.toLowerCase(),
          source: { path: location, layer: layerOf(root), reach: root.reach },
          reason: errorMessage(err),
        });
      }
      reportPackageFailure(dirName, root.authority, location, err);
    }

    if (root.authority === "bundled" && root.manifest !== undefined && bundledOnDisk === onDiskBefore) {
      const manifest = loadManifestPackages(root.manifest, root.sourceKind, root.bundle);
      loaded.push(...manifest.definitions);
      for (const [id, pkg] of manifest.corpus) bundledCorpus.set(id, pkg);
    }
  }

  if (bundledOnDisk === 0) {
    const manifest = loadManifestPackages(sources.bundledEntries ?? [], "agent");
    loaded.push(...manifest.definitions);
    for (const [id, pkg] of manifest.corpus) bundledCorpus.set(id, pkg);
  }

  const resolved = resolveUsableSkills(loaded, rejected, sources.roots, bundledCorpus, selection, sources.eligible ?? (() => true));
  const failedSelectionIds = new Set([...selection].filter(([, state]) => state === "failed").map(([id]) => id));
  return { skills: resolved.skills, bundledCorpus, failedSelectionIds, unreadableRoots, resolutions: resolved.resolutions };
}


/** Compiled bundled packages, keyed `<package>/<path>`. The manifest is written
 *  by the build, so a malformed key is an invariant violation, not user input.
 *  Every package carries the source kind and module bundle of the manifest
 *  section that holds it. */
function loadManifestPackages(entries: Iterable<readonly [string, string]>, sourceKind: BundledSkillSourceKind, bundle?: string): ManifestPackages {
  const packages = new Map<string, Map<string, string>>();
  for (const [key, content] of entries) {
    const separator = key.indexOf("/");
    if (separator <= 0 || separator === key.length - 1) throw new Error(`Bundled skill manifest key must be "<package>/<path>": ${key}`);
    const packageKey = key.slice(0, separator);
    const files = packages.get(packageKey) ?? new Map<string, string>();
    files.set(key.slice(separator + 1), content);
    packages.set(packageKey, files);
  }

  const definitions: SkillDefinition[] = [];
  const corpus = new Map<string, BundledSkillPackage>();
  for (const [packageKey, files] of packages) {
    try {
      const contents = readManifestPackage(files);
      const definition = buildDefinition(packageKey, contents, { kind: "manifest", authority: "bundled", reach: "global", packageKey, files, ...(bundle === undefined ? {} : { bundle }) });
      definitions.push(definition);
      corpus.set(packageKey.toLowerCase(), bundledPackage(packageKey, contents, files, sourceKind));
    } catch (err) {
      reportPackageFailure(packageKey, "bundled", packageKey, err);
    }
  }
  return { definitions, corpus };
}

function bundledPackage(id: string, contents: SkillPackage, files: ReadonlyMap<string, string>, sourceKind: BundledSkillSourceKind): BundledSkillPackage {
  const ordered = [
    Object.freeze({ path: SKILL_FILE, bytes: Buffer.byteLength(contents.skillFile, "utf8"), content: contents.skillFile }),
    ...contents.resources.map((resource) => Object.freeze({ ...resource, content: files.get(resource.path) ?? "" })),
  ];
  return Object.freeze({ id: id.toLowerCase(), sourceKind, authority: "bundled", files: Object.freeze(ordered), packageIdentity: Object.freeze({ ...contents.identity }) });
}


/** Normalize one package into a canonical definition, or throw with the reason
 *  the caller must report. Admission limits are enforced here, so every
 *  consumer of a definition reads the same bounded body and resource manifest,
 *  whatever authority the package came from. */
function buildDefinition(dirName: string, contents: SkillPackage, source: SkillSource): SkillDefinition {
  const id = dirName.toLowerCase();
  requireQualifiedSkillId(id, "Package name");

  const parsed = parseFrontmatter(contents.skillFile);
  if (!parsed) throw new Error(`${SKILL_FILE} has no valid YAML frontmatter`);

  // A bundled package is admitted by the whole-package total alone, so its
  // frontmatter and body carry no separate bound (see `skillFileByteCap`).
  if (skillFileByteCap(source.authority) !== undefined) {
    const bodyBytes = Buffer.byteLength(parsed.body, "utf8");
    const metadataBytes = Buffer.byteLength(contents.skillFile, "utf8") - bodyBytes;
    if (metadataBytes > SKILL_LIMITS.metadataBytes) {
      throw new Error(`frontmatter is ${metadataBytes} bytes, over the ${SKILL_LIMITS.metadataBytes}-byte limit; move the detail into the body`);
    }
    if (bodyBytes > SKILL_LIMITS.bodyBytes) {
      throw new Error(`${SKILL_FILE} body is ${bodyBytes} bytes, over the ${SKILL_LIMITS.bodyBytes}-byte limit; a body is never truncated, so move the detail into resource files`);
    }
  }
  const metadata = normalizeSkillFrontmatter(parsed.frontmatter);

  const definition: SkillDefinition = {
    id,
    name: metadata.name ?? id,
    trigger: metadata.trigger,
    version: metadata.version,
    tags: metadata.tags,
    relatedIds: metadata.relatedIds,
    dependencies: metadata.dependencies,
    agents: metadata.agents,
    ...(metadata.directOutput ? { directOutput: metadata.directOutput } : {}),
    ...(metadata.delegate ? { delegate: metadata.delegate } : {}),
    ...(metadata.attended ? { attended: true } : {}),
    modelInvocable: metadata.modelInvocable,
    ...(metadata.managed ? { managed: metadata.managed } : {}),
    ...(metadata.provenance ? { provenance: metadata.provenance } : {}),
    body: parsed.body,
    evidence: contentEvidence(parsed.body),
    packageIdentity: contents.identity,
    resources: contents.resources,
    source,
  };
  return definition;
}

/** External package failures this process has already warned about. Every
 *  registry build and every hot reload reads the roots again, and a package
 *  that stays broken is one condition, so its warning is recorded once per
 *  process and each repeat is a DEBUG record. */
const warnedPackageFailures = new Set<string>();

/** A bundled package that fails is a build bug and throws; an external one is
 *  skipped, so the caller records it as a failure and carries on. */
function reportPackageFailure(dirName: string, authority: SkillAuthority, location: string, err: unknown): void {
  if (authority === "bundled") {
    throw new Error(`Bundled skill "${dirName}": ${errorMessage(err)}`, { cause: err });
  }
  const message = `Skipping skill "${dirName}": ${errorMessage(err)}`;
  const key = `${location}\n${message}`;
  if (warnedPackageFailures.has(key)) {
    log.debug(message, { location });
    return;
  }
  warnedPackageFailures.add(key);
  log.warn(message, { location });
}


function layerOf(root: SkillPackageRoot): "bundled" | "user" | "project" {
  if (root.authority === "bundled") return "bundled";
  return root.reach === "project" ? "project" : "user";
}

function definitionSource(definition: SkillDefinition): DefinitionSource {
  const source = definition.source;
  return {
    path: source.kind === "filesystem" ? join(source.packageDir, SKILL_FILE) : `manifest:${source.packageKey}/${SKILL_FILE}`,
    layer: source.authority === "bundled" ? "bundled" : source.reach === "project" ? "project" : "user",
    reach: source.reach,
    identity: definition.packageIdentity.sha256,
  };
}

interface ResolvedSkillLoad {
  readonly skills: Map<string, SkillDefinition>;
  readonly resolutions: readonly DefinitionResolution<SkillDefinition>[];
}

function resolveUsableSkills(
  loaded: readonly SkillDefinition[],
  rejected: readonly { readonly id: string; readonly source: DefinitionSource; readonly reason: string }[],
  roots: readonly SkillPackageRoot[],
  bundledCorpus: ReadonlyMap<string, BundledSkillPackage>,
  selection: Map<string, "loaded" | "failed">,
  eligible: (definition: SkillDefinition) => boolean,
): ResolvedSkillLoad {
  let candidates = [...loaded];
  const failures = [...rejected];
  while (true) {
    const resolutions = resolveSkills(candidates, failures, roots, eligible);
    const skills = new Map(resolutions.flatMap((resolution) => resolution.selected ? [[resolution.id, resolution.selected.value] as const] : []));
    const external = resolutions.filter((resolution) => resolution.selected?.value.source.authority === "external");

    // A dependency that is not installed makes its dependents unavailable, not
    // broken: a release build has no development-module skills, so a project
    // skill written on top of one is expected to drop out there. Removing them
    // one layer per pass lets a dependent of a dependent drop out next pass.
    const unavailable = external.flatMap(({ selected }) => {
      const missing = selected?.value.dependencies.filter((id) => !skills.has(id)) ?? [];
      return selected && missing.length > 0 ? [{ id: selected.value.id, path: selected.source.path, missing }] : [];
    });
    if (unavailable.length > 0) {
      const skipped = new Set(unavailable.map(({ path }) => path));
      candidates = candidates.filter((candidate) => !skipped.has(definitionSource(candidate).path));
      for (const { id, path, missing } of unavailable) {
        log.debug(`Skipping skill "${id}": requires ${missing.map((dependency) => `"${dependency}"`).join(", ")}, which is not installed`, { location: path });
      }
      continue;
    }

    const revision = publishSkillRevision(0, skills, bundledCorpus);
    const invalid = external.flatMap((resolution) => {
      const skill = resolution.selected?.value;
      if (!skill) return [];
      try {
        resolveSkillClosure(skill.dependencies, revision, `Skill "${skill.id}"`);
        return [];
      } catch (error) {
        return [{ resolution, skill, reason: errorMessage(error) }];
      }
    });
    if (invalid.length === 0) {
      // Logged from the settled resolution only: an earlier pass may still
      // select an override that a later pass drops.
      for (const diagnostic of resolutions.flatMap((resolution) => resolution.diagnostics)) {
        if (diagnostic.kind === "masking" && shouldLogDefinitionMasking(diagnostic)) log.warn("skill override masks bundled definition", { winner: diagnostic.winner.path, bundled: diagnostic.displaced.path });
      }
      return { skills, resolutions };
    }

    for (const { resolution, skill, reason } of invalid) {
      const source = resolution.selected?.source;
      if (!source) continue;
      candidates = candidates.filter((candidate) => definitionSource(candidate).path !== source.path);
      failures.push({ id: skill.id, source, reason });
      selection.set(skill.id, "failed");
      reportPackageFailure(skill.id, "external", source.path, new Error(reason));
    }
  }
}

function resolveSkills(
  loaded: readonly SkillDefinition[],
  rejected: readonly { readonly id: string; readonly source: DefinitionSource; readonly reason: string }[],
  roots: readonly SkillPackageRoot[],
  eligible: (definition: SkillDefinition) => boolean,
): readonly DefinitionResolution<SkillDefinition>[] {
  const ids = new Set([...loaded.map((definition) => definition.id), ...rejected.map(({ id }) => id)]);
  return [...ids].map((id) => {
    const candidates: DefinitionCandidate<SkillDefinition>[] = [
      ...loaded.filter((definition) => definition.id === id && eligible(definition)).map((value) => ({ kind: "valid" as const, source: definitionSource(value), value })),
      ...rejected.filter((failure) => failure.id === id).map(({ source, reason }) => ({ kind: "rejected" as const, source, reason })),
    ].sort((left, right) => sourceRank(left.source.path, roots) - sourceRank(right.source.path, roots));
    const resolution = resolveDefinitionCandidates("skill", id, `skills/${id}/${SKILL_FILE}`, candidates);
    if (!resolution.selected) return resolution;
    const selectedIndex = candidates.findIndex((candidate) => candidate.kind === "valid");
    const lower = candidates.slice(selectedIndex + 1).find((candidate) => candidate.kind === "valid");
    if (lower?.kind !== "valid") return resolution;
    const selected = {
      source: resolution.selected.source,
      value: {
        ...resolution.selected.value,
        shadowed: { source: lower.value.source, packageIdentity: lower.value.packageIdentity },
      },
    };
    return { ...resolution, selected };
  });
}

function sourceRank(path: string, roots: readonly SkillPackageRoot[]): number {
  const rank = roots.findIndex((root) => path.startsWith(`${root.dir}/`));
  return rank < 0 ? roots.length : rank;
}