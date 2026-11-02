import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { workflowAssets as manifestWorkflowAssets } from "./agents/manifest.js";
import { BUNDLED_REFERENCE_DIR } from "./skill-source-inventory.js";
import type { SkillDefinition } from "./skill-schema.js";

const hasManifestWorkflowAssets = Object.keys(manifestWorkflowAssets).length > 0;
const refCache = new Map<string, string>();

/** Load the bundled references, keyed by file name without `.md`. A missing
 *  or readable-empty root contributes nothing. */
export function loadSkillReferences(dir: string): Map<string, string> {
  const references = new Map<string, string>();
  if (!existsSync(dir)) return references;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Bundled skill reference root is installed but unreadable: ${dir}`, { cause: error });
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    references.set(entry.name.slice(0, -3), readFileSync(join(dir, entry.name), "utf8"));
  }
  return references;
}

const sourceReferences = hasManifestWorkflowAssets
  ? undefined
  : loadSkillReferences(BUNDLED_REFERENCE_DIR);

function readReference(name: string): string {
  const key = `references/${name}.md`;
  const content = hasManifestWorkflowAssets ? manifestWorkflowAssets[key] : sourceReferences?.get(name);
  if (content !== undefined) return content;
  throw new Error(`Missing skill reference "${name}": expected ${key}`);
}

function resolveSkillReferences(body: string): string {
  return body.replace(/\{\{ref:([a-z0-9-]+)\}\}/g, (_, name: string) => {
    let content = refCache.get(name);
    if (content === undefined) {
      content = readReference(name);
      refCache.set(name, content);
    }
    return content;
  });
}

/** The prompt-ready skill body with shared references expanded. */
export function resolveSkillBody(skill: Pick<SkillDefinition, "body">): string {
  return resolveSkillReferences(skill.body);
}
