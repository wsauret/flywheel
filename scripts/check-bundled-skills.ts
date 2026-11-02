import { installedDefinitionBundles, installModuleCatalog } from "../src/orchestration/module-catalog.js"
/** Repository gate over the bundled skill corpus.
 *
 *  Bundled packages are never written through the skill store, so the body
 *  budget's write-time gate cannot reach them, and their bodies are paid on
 *  every load of the most-loaded packages in the catalog. `flywheel skills
 *  doctor --all` reports the same findings, but nothing holds them; this gate
 *  is what holds them.
 *
 *  Two views, one per build. The shipped view is what a release loads: the
 *  agent methods under `src/agent-skills/`, inspected with no module bundle,
 *  so a shipped package that points at a development-module skill is reported
 *  as pointing at an uninstalled one, which is what a user would find. The
 *  source view adds the development catalog's bundles and inspects the
 *  packages they carry. */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectSkillLibrary } from "../src/workflows/skill-health.js";
import { createProjectDefinitionRegistry, type ProjectDefinitionRegistry } from "../src/workflows/definition-registry.js";
import type { DefinitionBundle } from "../src/workflows/loader.js";

import { DEVELOPMENT_MODULES } from "../src/orchestration/development-modules.js";
import { SHIPPED_OTHER_MODULES } from "../src/orchestration/modules.js";
import { installedPersonaToolEntries } from "../src/orchestration/tool-catalog.js";
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
// State roots the check does not read: a scratch dir keeps the user's real
// ~/.flywheel and ~/.agents libraries out of a repository gate.
const scratch = mkdtempSync(join(tmpdir(), "flywheel-bundled-skills-"));
const directories = { projectRoot: repoRoot, userDataRoot: scratch, accountHome: scratch };

// Persona tool entries name the benchmark tool in a source run, so the catalog
// is the source one for both views; only the bundles differ.
installModuleCatalog({ otherModules: () => [...SHIPPED_OTHER_MODULES, ...DEVELOPMENT_MODULES] });
const developmentBundles = installedDefinitionBundles();

function brokenFindings(registry: ProjectDefinitionRegistry, roots: readonly string[]): readonly string[] {
  const revision = registry.skills();
  const canonicalRoots = roots.map((root) => `${realpathSync(root)}${sep}`);
  return inspectSkillLibrary({ revision, directories, includeUnowned: true })
    .filter((finding) => {
      const skill = revision.skills.get(finding.skill);
      if (skill?.source.kind !== "filesystem") return false;
      const dir = realpathSync(skill.source.canonicalDir);
      return finding.severity === "broken" && canonicalRoots.some((root) => dir.startsWith(root));
    })
    .map((finding) => `bundled-skill: ${finding.skill}: ${finding.detail}`);
}

function registryWith(bundles: readonly DefinitionBundle[]): ProjectDefinitionRegistry {
  return createProjectDefinitionRegistry({ ...directories, skillRoots: [], bundles, personaToolEntries: installedPersonaToolEntries() });
}

let failed = false;
try {
  const findings = [
    ...brokenFindings(registryWith([]), [join(repoRoot, "src", "agent-skills")]),
    ...brokenFindings(registryWith(developmentBundles), developmentBundles.map((bundle) => join(bundle.root, "skills"))),
  ];
  for (const finding of findings) {
    failed = true;
    console.log(finding);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
