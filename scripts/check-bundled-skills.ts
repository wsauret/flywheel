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
 *  packages they carry.
 *
 *  Capability markers (`{{if:}}`, ARCH-CONTEXT-033) are checked once, against
 *  everything the source catalog installs: every bundled body after its
 *  `{{ref:}}` expansion, every shared reference, every bundled persona, and
 *  every bundled agent asset must balance and name only known terms, and no
 *  resource may hold one, because resources go out byte for byte. */

import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { bundledAgentAsset, type AgentAssetName } from "../src/infra/agent-assets/system-prompt.js";
import { renderCapabilityText } from "../src/infra/capability-text.js";
import { errorMessage } from "../src/infra/error-message.js";
import { inspectSkillLibrary } from "../src/workflows/skill-health.js";
import { loadSkillReferences, resolveSkillBody } from "../src/workflows/skill-references.js";
import { BUNDLED_REFERENCE_DIR } from "../src/workflows/skill-source-inventory.js";
import type { SkillDefinition } from "../src/workflows/skill-schema.js";
import { createProjectDefinitionRegistry, type ProjectDefinitionRegistry } from "../src/workflows/definition-registry.js";
import type { DefinitionBundle } from "../src/workflows/loader.js";

import { DEVELOPMENT_MODULES } from "../src/orchestration/development-modules.js";
import { installedDefinitionBundles, installModuleCatalog } from "../src/orchestration/module-catalog.js";
import { composeFirstPartyModules, SHIPPED_OTHER_MODULES } from "../src/orchestration/modules.js";
import { installedPersonaToolEntries } from "../src/orchestration/tool-catalog.js";

interface CheckDirectories {
  readonly projectRoot: string;
  readonly userDataRoot: string;
  readonly accountHome: string;
}

/** The canonical directory of a package from one of `roots`, or undefined for a package from anywhere else. */
function bundledDir(skill: SkillDefinition | undefined, roots: readonly string[]): string | undefined {
  if (skill?.source.kind !== "filesystem") return undefined;
  const dir = realpathSync(skill.source.canonicalDir);
  return roots.some((root) => dir.startsWith(`${realpathSync(root)}${sep}`)) ? dir : undefined;
}

function brokenFindings(registry: ProjectDefinitionRegistry, directories: CheckDirectories, roots: readonly string[]): readonly string[] {
  const revision = registry.skills();
  return inspectSkillLibrary({ revision, directories, includeUnowned: true })
    .filter((finding) => finding.severity === "broken" && bundledDir(revision.skills.get(finding.skill), roots) !== undefined)
    .map((finding) => `bundled-skill: ${finding.skill}: ${finding.detail}`);
}

const MARKER_LINE = /^\{\{(?:if:[^}]*|else|end)\}\}$/u;

/** Why one text's capability markers would not render: an unbalanced marker, or a term no installed tool, skill,
 *  or persona answers. A tool term is a tool that a module contributes; kernel tools are always present, so they are
 *  never terms (ARCH-STRUCTURE-032). */
function markerFindings(subject: string, text: string, known: (term: string) => boolean): readonly string[] {
  const terms: string[] = [];
  try {
    // A check that never holds tests every term of every block.
    renderCapabilityText(text, (term) => { terms.push(term); return false; });
  } catch (error) {
    return [`${subject}: ${errorMessage(error)}`];
  }
  return [...new Set(terms)].filter((term) => !known(term)).map((term) => `${subject}: capability marker names unknown term "${term}"`);
}

/** Whether `term` names a tool that an installed module contributes, or a skill or persona of `registry`. */
export function knownCapabilityTerm(registry: ProjectDefinitionRegistry): (term: string) => boolean {
  const skills = registry.skills().skills;
  const personas = registry.personas();
  const tools = new Set(composeFirstPartyModules().contributions.flatMap((contribution) => contribution.domain === "tools" ? [contribution.value.name] : []));
  return (term) => {
    if (term.startsWith("skill:")) return skills.has(term.slice("skill:".length));
    if (term.startsWith("persona:")) return personas.has(term.slice("persona:".length));
    return tools.has(term);
  };
}

const AGENT_ASSETS: readonly AgentAssetName[] = ["system-prompt.md", "engineering-doctrine.md"];

/** The marker findings of each bundled agent asset, whose text `asset` supplies. The system prompt renders each
 *  asset for its reader's check, so a misspelled term drops its passage and an unbalanced block fails assembly. */
export function agentAssetMarkerFindings(known: (term: string) => boolean, asset: (name: AgentAssetName) => string = bundledAgentAsset): readonly string[] {
  return AGENT_ASSETS.flatMap((name) => markerFindings(`bundled-agent-asset: ${name}`, asset(name), known));
}

function capabilityMarkerFindings(registry: ProjectDefinitionRegistry, roots: readonly string[]): readonly string[] {
  const revision = registry.skills();
  const known = knownCapabilityTerm(registry);
  const findings: string[] = [...agentAssetMarkerFindings(known)];
  for (const skill of revision.skills.values()) {
    const dir = bundledDir(skill, roots);
    if (dir === undefined) continue;
    findings.push(...markerFindings(`bundled-skill: ${skill.id}`, resolveSkillBody(skill), known));
    for (const resource of skill.resources) {
      const lines = readFileSync(join(dir, resource.path), "utf8").split("\n");
      if (lines.some((line) => MARKER_LINE.test(line.trim()))) findings.push(`bundled-skill: ${skill.id}: resource ${resource.path} holds a capability marker; resources go out byte for byte, so condition the body instead`);
    }
  }
  for (const [name, text] of loadSkillReferences(BUNDLED_REFERENCE_DIR)) findings.push(...markerFindings(`bundled-reference: ${name}`, text, known));
  for (const persona of registry.personas().values()) {
    if (persona.kind === "persona") findings.push(...markerFindings(`bundled-persona: ${persona.name}`, persona.systemPrompt, known));
  }
  return findings;
}

function registryWith(directories: CheckDirectories, bundles: readonly DefinitionBundle[]): ProjectDefinitionRegistry {
  return createProjectDefinitionRegistry({ ...directories, skillRoots: [], bundles, personaToolEntries: installedPersonaToolEntries() });
}

if (import.meta.main) {
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  // State roots the check does not read: a scratch dir keeps the user's real
  // ~/.flywheel and ~/.agents libraries out of a repository gate.
  const scratch = mkdtempSync(join(tmpdir(), "flywheel-bundled-skills-"));
  const directories = { projectRoot: repoRoot, userDataRoot: scratch, accountHome: scratch };
  // Persona tool entries name the benchmark tool in a source run, so the catalog
  // is the source one for both views; only the bundles differ.
  installModuleCatalog({ otherModules: () => [...SHIPPED_OTHER_MODULES, ...DEVELOPMENT_MODULES] });
  const developmentBundles = installedDefinitionBundles();
  let failed = false;
  try {
    const shippedRoots = [join(repoRoot, "src", "agent-skills")];
    const bundleRoots = developmentBundles.map((bundle) => join(bundle.root, "skills"));
    const source = registryWith(directories, developmentBundles);
    const findings = [
      ...brokenFindings(registryWith(directories, []), directories, shippedRoots),
      ...brokenFindings(source, directories, bundleRoots),
      ...capabilityMarkerFindings(source, [...shippedRoots, ...bundleRoots]),
    ];
    for (const finding of findings) {
      failed = true;
      console.log(finding);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
}
