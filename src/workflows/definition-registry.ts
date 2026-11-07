import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { errorMessage } from "../infra/error-message.js";
import { Log } from "../infra/log.js";
import { skillDefinitions as bundledSkillDefinitions, moduleSkillDefinitions } from "./agents/manifest.js";
import { formerStepSkillWarnings } from "./retired-bindings.js";
import type { DefinitionResolution } from "../infra/definition-resolution.js";
import type { DefinitionBundle } from "./loader.js";
import { validateSkillDependencies } from "./definition-validation.js";
import { formatDefinitionError } from "./definition-provenance.js";
import type { SkillRegistryRevision, SkillSource } from "./skill-schema.js";
import { publishSkillRevision } from "./skill-schema.js";
import type { ProjectDirectories } from "../infra/directory-authorities.js";
import type { SkillLoad, SkillStoreRoot } from "./skills.js";
import { loadSkillDefinitions, skillStoreRoots } from "./skills.js";
import { BUNDLED_SKILL_DIR } from "./skill-source-inventory.js";
import { createPersonaRegistryOwner, type PersonaRegistryRevision, type PersonaToolRegistryEntry } from "./agents/registry.js";
import type { AgentDefinition } from "../infra/agent-definition.js";
import { loadEngineeringDoctrineResolution, loadSystemPromptResolution } from "../infra/agent-assets/system-prompt.js";
import type { DefinitionOverrideOperations } from "./definitions/override-staleness.js";

const log = Log.create({ service: "skill-registry" });


/** Skills of every source: the packages installed under the external roots
 *  outrank Flywheel's own bundled packages and the installed modules'
 *  definition bundles. Both fall back to the compiled manifest when the source
 *  tree is absent (binary mode); a release compiles only the bundles it ships. */
function loadSkills(roots: readonly SkillStoreRoot[], bundles: readonly DefinitionBundle[]): SkillLoad {
  return loadSkillDefinitions({
    roots: [
      ...roots.map(({ dir, reach }) => ({ authority: "external" as const, dir, reach })),
      { authority: "bundled" as const, dir: BUNDLED_SKILL_DIR, reach: "global" as const, sourceKind: "agent" as const },
      ...bundles.map(({ id, root }) => ({ authority: "bundled" as const, dir: join(root, "skills"), reach: "global" as const, sourceKind: "module" as const, bundle: id, manifest: Object.entries(moduleSkillDefinitions[id] ?? {}) })),
    ],
    bundledEntries: Object.entries(bundledSkillDefinitions),
  });
}

export interface ProjectDefinitionRegistryRevision {
  readonly skills: SkillRegistryRevision;
  readonly personaRevision: PersonaRegistryRevision;
  readonly personas: ReadonlyMap<string, AgentDefinition>;
  readonly resolutions: readonly DefinitionResolution<unknown>[];
}

/** Returns the model roles declared by one immutable persona revision. */
export function personaRoleIds(personas: ReadonlyMap<string, AgentDefinition>): ReadonlySet<string> {
  return new Set([...personas.values()].flatMap((agent) => agent.kind === "persona" ? [agent.role] : []));
}

/** Every definition one project composes from: its skills and
 *  personas, republished together as a new immutable revision on reload. Each
 *  read is a method, so a caller that copies the owner still reads the
 *  revision published at call time.
 *
 *  One owner per project root. Nothing here is ambient: a consumer holds the
 *  owner its host injected, so discovery and mutation cannot disagree about
 *  which project they serve. */
export interface ProjectDefinitionRegistry {
  readonly projectRoot: string;
  /** The published skill revision. Consumers read it at call time, so a reload
   *  is observed on the next read; the revision they already hold never changes
   *  under them. */
  skills(): SkillRegistryRevision;
  /** Published persona map from the same atomic revision as skills(). */
  personas(): ReadonlyMap<string, AgentDefinition>;
  /** Capture the complete project definition catalog by one reference read. */
  captureRevision(): ProjectDefinitionRegistryRevision;
  /** Re-read every definition family and publish the next complete revision,
   *  or keep the last valid one. Only this registry changes; consumers that
   *  hold a snapshot of the definitions are not told. */
  reload(): DefinitionReload;
  /** Current lossless decisions for every runtime definition family. */
  resolutions(): readonly DefinitionResolution<unknown>[];
  /** Runtime-owned override service, when the composition has attached it. */
  readonly definitionOverrides?: DefinitionOverrideOperations;
  /** Reload now through the composition's ordered definition reload, the path
   *  a watched change takes, and resolve after every consumer of the revision
   *  has settled. Absent where no composition observes the definition roots,
   *  such as a one-shot command. Resolves undefined when the composition has
   *  shut down and nothing ran. Rejects when module work before the reload or
   *  a consumer after it fails. */
  readonly publishNow?: () => Promise<DefinitionReload | undefined>;
}

/** What one reload did. */
export interface DefinitionReload {
  /** False when the registry kept the last valid revision. */
  readonly published: boolean;
  /** The skill revision in force after the reload. */
  readonly revision: number;
  /** Skills that revision installs. */
  readonly skills: number;
}

export interface ProjectDefinitionRegistryOptions extends ProjectDirectories {
  /** Skill roots to load and watch. Defaults to the project's stores. */
  readonly skillRoots?: readonly SkillStoreRoot[];
  /** Module definition bundles loaded beside the built-in roots. Production
   *  passes the installed catalog's through `createInstalledDefinitionRegistry`;
   *  a caller that means none states `[]`, so no caller loses them by omission. */
  readonly bundles: readonly DefinitionBundle[];
  readonly personaToolEntries?: readonly PersonaToolRegistryEntry[];
  /** Built-in persona source for this runtime revision. Tests inject a fixture;
   *  production uses the source tree or compiled package location. */
  readonly bundledPersonaDir?: string;
}

/** The project's and the account's own persona directories. The
 *  registry reads them and the definition watch observes them, both from this
 *  one computation. */
function authoredDefinitionDirs(directories: Pick<ProjectDirectories, "projectRoot" | "userDataRoot">) {
  return {
    personas: { project: join(directories.projectRoot, ".flywheel", "agents"), user: join(directories.userDataRoot, "agents") },
  } as const;
}

/** Every skill and persona directory one project's definition owner
 *  reads, highest precedence first within each family. The definition watch
 *  observes exactly these, so a definition saved into any of them mid-session
 *  loads without a restart. Pass the same skill roots the registry receives. */
export function definitionRoots(
  directories: ProjectDirectories,
  skillRoots: readonly SkillStoreRoot[] = skillStoreRoots(directories),
): readonly Pick<SkillStoreRoot, "dir" | "owned">[] {
  const { personas } = authoredDefinitionDirs(directories);
  const authored = [personas.project, personas.user];
  return [...skillRoots, ...authored.map((dir) => ({ dir, owned: true }))];
}

/** Build one project's skill and persona owner. */
export function createProjectDefinitionRegistry(options: ProjectDefinitionRegistryOptions): ProjectDefinitionRegistry {
  const skillRoots = options.skillRoots ?? skillStoreRoots(options);
  const bundles = options.bundles;
  const userDataRoot = options.userDataRoot ?? options.projectRoot;
  const authored = authoredDefinitionDirs({ projectRoot: options.projectRoot, userDataRoot });
  const initialSkills = loadSkills(skillRoots, bundles);
  const personaToolEntries = options.personaToolEntries;
  const personas = createPersonaRegistryOwner(
    options.bundledPersonaDir ?? fileURLToPath(new URL("agents/personas", import.meta.url)),
    personaToolEntries,
  );

  const assemble = (skillsLoad: SkillLoad, revision: number): ProjectDefinitionRegistryRevision => {
    const skills = publishSkillRevision(revision, skillsLoad.skills, skillsLoad.bundledCorpus);
    const errors = validateSkillDependencies(skills);
    if (errors.length > 0) throw new Error(`Definition errors:\n${errors.map(formatDefinitionError).join("\n")}`);
    for (const warning of formerStepSkillWarnings(skills)) log.warn(warning);
    const personaRevision = personas.load(skills, authored.personas.user, authored.personas.project);
    return Object.freeze({
      skills,
      personas: personaRevision.personas,
      personaRevision,
      resolutions: Object.freeze([
        ...skillsLoad.resolutions,
        ...personaRevision.resolutions,
        loadSystemPromptResolution({ projectRoot: options.projectRoot, userDataRoot }),
        loadEngineeringDoctrineResolution({ projectRoot: options.projectRoot, userDataRoot }),
      ]),
    });
  };

  let published = assemble(initialSkills, 1);

  return {
    projectRoot: options.projectRoot,
    skills: () => published.skills,
    personas: () => published.personas,
    captureRevision: () => published,
    resolutions: () => published.resolutions,
    reload: () => {
      const previous = published;
      try {
        const next = loadSkills(skillRoots, bundles);
        const incomplete = describeIncompleteLoad(next, published.skills);
        if (incomplete) {
          log.warn(`skill reload kept revision ${published.skills.revision}: ${incomplete}`);
        } else {
          const candidate = assemble(next, published.skills.revision + 1);
          const broken = describeBrokenPublishedSources(candidate.resolutions, published.resolutions);
          if (broken) {
            log.warn(`definition reload kept revision ${published.skills.revision}: ${broken}`);
          } else {
            published = candidate;
          }
        }
      } catch (err) {
        log.warn(`definition reload failed, keeping revision ${published.skills.revision}: ${errorMessage(err)}`);
      }
      return { published: published !== previous, revision: published.skills.revision, skills: published.skills.skills.size };
    },
  };
}

/** Why this load must not replace the published revision, or undefined when it
 *  may. An unreadable root hides every package under it, and a failed
 *  highest-precedence copy either removes a published package or hands its id
 *  to a shadowed install: an editor replaces `SKILL.md` in place, so a reload
 *  can observe the file mid-write, and publishing then would silently compose a
 *  different procedure. The next event picks the finished edit
 *  up. A failure that leaves the published source in place is not incomplete,
 *  so a permanently broken shadow of a package cannot freeze hot reload. */
function describeIncompleteLoad(
  next: SkillLoad,
  published: SkillRegistryRevision,
): string | undefined {
  if (next.unreadableRoots.length > 0) return `could not read skill root ${next.unreadableRoots.join(", ")}`;

  const changed = [...next.failedSelectionIds].filter((id) => {
    const current = published.skills.get(id);
    return current !== undefined && sourceKey(next.skills.get(id)?.source) !== sourceKey(current.source);
  });
  if (changed.length > 0) return `could not read ${changed.join(", ")}`;

  return undefined;
}

/** Failure is not removal for authored personas either. When the
 *  file that served a published definition no longer loads, the reload keeps
 *  the published revision: publishing it would hand the id to the copy the
 *  file overrides, or drop the id, while a save is in progress or an edit is
 *  broken. A file that never served a published definition is skipped, as at
 *  startup, so one broken new file cannot freeze hot reload. */
function describeBrokenPublishedSources(
  next: readonly DefinitionResolution<unknown>[],
  published: readonly DefinitionResolution<unknown>[],
): string | undefined {
  const rejected = new Set(next.flatMap(({ candidates }) =>
    candidates.flatMap((candidate) => candidate.kind === "rejected" && candidate.source.layer !== "bundled" ? [candidate.source.path] : [])));
  const broken = published.flatMap(({ family, id, selected }) =>
    selected && rejected.has(selected.source.path) ? [`${family} ${id}`] : []);
  return broken.length > 0 ? `could not load ${broken.join(", ")}` : undefined;
}

/** Identity of the bytes a definition was built from, so two loads of one id
 *  can be compared without comparing bodies. */
function sourceKey(source: SkillSource | undefined): string {
  if (!source) return "(absent)";
  return source.kind === "filesystem" ? source.canonicalDir : `manifest:${source.packageKey}`;
}
