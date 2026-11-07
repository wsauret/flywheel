import { join } from "node:path";
import { shippedDefinitionBundles } from "../../../src/orchestration/modules.js";
import type { DefinitionBundle } from "../../../src/workflows/loader.js";
import { renderSkillBody } from "../../../src/workflows/skill-references.js";
import type { SkillDefinition } from "../../../src/workflows/skill-schema.js";
import { BUNDLED_SKILL_DIR } from "../../../src/workflows/skill-source-inventory.js";
import { loadSkillDefinitions } from "../../../src/workflows/skills.js";

/** The skill roots of the given definition bundles. */
export const bundleRoots = (bundles: readonly DefinitionBundle[]) => bundles.map(({ id, root }) => ({ authority: "bundled" as const, dir: join(root, "skills"), reach: "global" as const, sourceKind: "module" as const, bundle: id }));
// Every package a release ships: Flywheel's own methods and the bundles of the shipped modules.
export const SKILL_ROOTS = [{ authority: "bundled" as const, dir: BUNDLED_SKILL_DIR, reach: "global" as const, sourceKind: "agent" as const }, ...bundleRoots(shippedDefinitionBundles())];

// Bundled packages only: the installing user's external roots must not decide
// whether Flywheel's own canonical packages are present and well-formed.
export const bundledLoad = loadSkillDefinitions({ roots: SKILL_ROOTS });
export const bundled = bundledLoad.skills;

/** A bundled body as an agent reads it: everything on, or every term in `off` refused. */
export function bodyFor(skill: SkillDefinition | undefined, off: readonly string[] = []): string {
  if (!skill) throw new Error("the bundled package is installed");
  return renderSkillBody(skill, (term) => !off.includes(term)).text;
}
