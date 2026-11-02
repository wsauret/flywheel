import { createProjectDefinitionRegistry, type ProjectDefinitionRegistry, type ProjectDefinitionRegistryRevision } from "../../src/workflows/definition-registry.js";
import type { WorkflowDefinition } from "../../src/workflows/workflow-schema.js";
import { publishSkillRevision, type SkillRegistryRevision } from "../../src/workflows/skill-schema.js";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { dirname, basename, join } from "node:path";
import { decodeWorkflowFile } from "../../src/workflows/workflow-file.js";
import { withLoadedContent } from "../../src/workflows/loader.js";
import { definitionAssets } from "../../src/workflows/definition-assets.js";
import { testAccountHome, testDirectories } from "./directories.js";
import type { AgentDefinition } from "../../src/infra/agent-definition.js";

import { DEVELOPMENT_MODULES } from "../../src/orchestration/development-modules.js";
import { installedDefinitionBundles } from "../../src/orchestration/module-catalog.js";
import { SHIPPED_MODULES, type FirstPartyModule } from "../../src/orchestration/modules.js";
import { installedPersonaToolEntries } from "../../src/orchestration/tool-catalog.js";
let registry: ProjectDefinitionRegistry | undefined;
let fixtureRegistry: ProjectDefinitionRegistry | undefined;

/** The catalog the checked-out repository composes from in a source run: the
 *  shipped modules plus the development module whose bundle `repoDefinitions`
 *  loads. Availability over those definitions resolves against it. */
export const repoModules: readonly FirstPartyModule[] = [...SHIPPED_MODULES, ...DEVELOPMENT_MODULES];

/** The definition owner of the checked-out repository, built once per test
 *  process, with the development module's bundle the source entry installs.
 *  Tests that assert on the repository's personas and packages share
 *  it; a test that needs its own project root builds its own owner. */
export function repoDefinitions(): ProjectDefinitionRegistry {
  registry ??= createProjectDefinitionRegistry({
    ...testDirectories(process.cwd()),
    skillRoots: [],
    bundles: installedDefinitionBundles(repoModules),
    personaToolEntries: installedPersonaToolEntries(),
  });
  return registry;
}

/** The id of the committed fixture workflow that {@link fixtureWorkflowProject}
 *  holds: investigate, fix when a hypothesis is confirmed, then verify and
 *  refix while defects remain, each with an inline brief. */
export const FIXTURE_WORKFLOW_ID = "repair";

/** A new project whose own workflow folder holds the committed fixture
 *  workflow of `tests/fixtures/workflow-project`. The repository ignores
 *  `.flywheel/`, so the fixture keeps the folder's contents under a plain
 *  name and copies them into place. The test account owns cleanup. */
export function fixtureWorkflowProject(): string {
  const root = mkdtempSync(join(testAccountHome(), "fixture-workflows-"));
  cpSync(join(import.meta.dir, "..", "fixtures", "workflow-project"), join(root, ".flywheel"), { recursive: true });
  return root;
}

/** The skill and persona owner of the fixture project, with the repository bundles. */
export function fixtureDefinitions(): ProjectDefinitionRegistry {
  fixtureRegistry ??= createProjectDefinitionRegistry({
    ...testDirectories(fixtureWorkflowProject()),
    skillRoots: [],
    bundles: installedDefinitionBundles(repoModules),
    personaToolEntries: installedPersonaToolEntries(),
  });
  return fixtureRegistry;
}

/** A published revision that installs nothing. Identity composed from
 *  fabricated definitions that require no package reads it, so the composition
 *  never depends on what the developer has installed. */
export const noSkills: SkillRegistryRevision = publishSkillRevision(1, new Map());

/** A definition owner that serves one fixed revision and never reloads: by
 *  default no skills and no personas, so composition reads nothing the
 *  developer has installed. `reload` keeps the revision, as an owner whose
 *  sources did not change does. */
export function fixedDefinitions(fixed: { readonly skills?: SkillRegistryRevision; readonly personas?: ReadonlyMap<string, AgentDefinition>; readonly projectRoot?: string } = {}): ProjectDefinitionRegistry {
  const skills = fixed.skills ?? noSkills;
  const personas = fixed.personas ?? new Map<string, AgentDefinition>();
  const revision: ProjectDefinitionRegistryRevision = { skills, personas, resolutions: [], personaRevision: { revision: "fixed", personas, resolutions: [] } };
  return {
    projectRoot: fixed.projectRoot ?? process.cwd(),
    skills: () => skills,
    personas: () => personas,
    captureRevision: () => revision,
    reload: () => ({ published: false, revision: skills.revision, skills: skills.skills.size }),
    resolutions: () => [],
  };
}

/** Reads one test project's explicit workflow file with the captured skill and brief sources. Throws on an invalid file. */
export function workflowIn(revision: Pick<ProjectDefinitionRegistryRevision, "skills">, workflowDefinitionId: string, projectRoot = fixtureDefinitions().projectRoot): WorkflowDefinition {
  const file = join(projectRoot, ".flywheel", "workflows", `${workflowDefinitionId}.yaml`);
  const decoded = decodeWorkflowFile({ file, content: readFileSync(file, "utf8"), skills: revision.skills });
  if (!decoded.ok) throw new Error(JSON.stringify(decoded.diagnostics));
  return withLoadedContent(decoded.definition, {
    location: { root: { kind: "directory", dir: dirname(file) }, path: basename(file) },
    reader: definitionAssets,
    provenance: { layer: "project", id: decoded.definition.id, filePath: file },
    ...(decoded.stepGrammar ? { stepGrammar: decoded.stepGrammar.view } : {}),
  });
}
