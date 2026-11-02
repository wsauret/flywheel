import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Where a bundled package sits in the architecture: a reusable agent method
 *  that every release ships, or a module's own definition bundle. The core
 *  corpus a release identifies is the agent kind alone. */
export type BundledSkillSourceKind = "agent" | "module";

/** Flywheel's own skill packages. Every package here is of the agent kind. */
export const BUNDLED_SKILL_DIR = fileURLToPath(new URL("../agent-skills", import.meta.url));

/** The shared references that bundled package bodies include. It is a child of
 *  the package directory but holds no package. */
export const BUNDLED_REFERENCE_DIR = join(BUNDLED_SKILL_DIR, "references");
