import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderCapabilityText, type CapabilityCheck } from "../infra/capability-text.js";
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

/** The skill body with shared references expanded and its capability markers kept as written. */
export function resolveSkillBody(skill: Pick<SkillDefinition, "body">): string {
  return resolveSkillReferences(skill.body);
}

/** A bundled body rendered for one reader, and each capability term that the rendering tested with its answer. */
export interface RenderedSkillBody {
  readonly text: string;
  readonly conditions: ReadonlyMap<string, boolean>;
}

/** The prompt-ready bundled body for the reader that `has` describes (ARCH-CONTEXT-033): shared references expanded
 *  first, so a reference's own `{{if:}}` blocks are conditioned too, then each block kept or dropped. `conditions`
 *  lists the terms in the order the rendering tested them; a term after one that already held is not tested,
 *  because it cannot change the text. Throws when the expanded body holds an unbalanced marker. */
export function renderSkillBody(skill: Pick<SkillDefinition, "body">, has: CapabilityCheck): RenderedSkillBody {
  const conditions = new Map<string, boolean>();
  const text = renderCapabilityText(resolveSkillBody(skill), (term) => {
    const holds = has(term);
    conditions.set(term, holds);
    return holds;
  });
  return { text, conditions };
}
