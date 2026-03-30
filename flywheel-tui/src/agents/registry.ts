// ---------------------------------------------------------------------------
// Agent Registry — loads and exposes flywheel agent personas
// ---------------------------------------------------------------------------
//
// Agent persona files live in src/agents/personas/fly/*.md with YAML
// frontmatter (name, description, model, tools, skills) and a markdown body
// containing the full persona/system prompt.
//
// The registry:
//   1. Discovers .md files under the personas directory
//   2. Parses frontmatter + body via the shared frontmatter parser
//   3. Exposes typed AgentPersona objects by name, category, or list
//
// Agent names follow the pattern: fly/<category>-<domain>
//   e.g., fly/reviewer-architecture, fly/locator-codebase
//
// Categories: reviewer, locator, analyzer
// ---------------------------------------------------------------------------

import { parseFrontmatter } from "../utils/frontmatter.js";
import { Log } from "../utils/log.js";
import { readdir, readFile } from "fs/promises";
import { join, basename } from "path";

const log = Log.create({ service: "agent-registry" });

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentCategory = "reviewer" | "locator" | "analyzer";

export interface AgentPersona {
  /** Fully qualified name, e.g. "fly/reviewer-architecture" */
  name: string;
  /** Short name from filename, e.g. "reviewer-architecture" */
  shortName: string;
  /** Category derived from name prefix */
  category: AgentCategory;
  /** One-line description (from frontmatter) */
  description: string;
  /** Recommended model (e.g. "haiku", "sonnet") */
  model: string;
  /** Allowed tools (e.g. ["Read", "Grep", "Glob"]) */
  tools: string[];
  /** Skills to load (e.g. ["flywheel-conventions", "language-standards"]) */
  skills: string[];
  /** Full persona body (markdown) — the system prompt */
  body: string;
  /** Raw frontmatter for passthrough */
  frontmatter: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

let _agents: Map<string, AgentPersona> | null = null;

// ---------------------------------------------------------------------------
// Persona directory — resolved relative to this module
// ---------------------------------------------------------------------------

/**
 * Resolve the personas directory path.
 * In the built output this file is at dist/agents/registry.js,
 * and personas are copied to dist/agents/personas/fly/.
 * At dev time this file is at src/agents/registry.ts with
 * personas at src/agents/personas/fly/.
 *
 * We use import.meta to find the base and walk up to src/ or dist/.
 */
function getPersonasDir(): string {
  const thisDir = new URL(".", import.meta.url).pathname;
  return join(thisDir, "personas", "fly");
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function detectCategory(shortName: string): AgentCategory | null {
  if (shortName.startsWith("reviewer-")) return "reviewer";
  if (shortName.startsWith("locator-")) return "locator";
  if (shortName.startsWith("analyzer-")) return "analyzer";
  return null;
}

function parsePersonaFile(
  filename: string,
  content: string,
): AgentPersona | null {
  const shortName = filename.replace(/\.md$/, "");
  const category = detectCategory(shortName);
  if (!category) {
    log.warn("skipping persona with unknown category", { filename });
    return null;
  }

  const parsed = parseFrontmatter(content);
  if (!parsed) {
    log.warn("skipping persona with invalid frontmatter", { filename });
    return null;
  }

  const fm = parsed.frontmatter;

  return {
    name: `fly/${shortName}`,
    shortName,
    category,
    description: typeof fm.description === "string" ? fm.description : "",
    model: typeof fm.model === "string" ? fm.model : "sonnet",
    tools: Array.isArray(fm.tools) ? fm.tools.map(String) : [],
    skills: Array.isArray(fm.skills) ? fm.skills.map(String) : [],
    body: parsed.body.trim(),
    frontmatter: fm,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load all agent personas from the bundled personas directory.
 * Results are cached after first call.
 */
export async function loadAgents(): Promise<Map<string, AgentPersona>> {
  if (_agents) return _agents;

  const agents = new Map<string, AgentPersona>();
  const dir = getPersonasDir();

  try {
    const files = await readdir(dir);
    for (const file of files) {
      if (!file.endsWith(".md")) continue;
      try {
        const content = await readFile(join(dir, file), "utf-8");
        const persona = parsePersonaFile(file, content);
        if (persona) {
          agents.set(persona.name, persona);
        }
      } catch (err) {
        log.warn("failed to read persona file", {
          file,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  } catch (err) {
    log.error("failed to read personas directory", {
      dir,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  log.info("loaded agent personas", { count: agents.size });
  _agents = agents;
  return agents;
}

/**
 * Get a single agent by fully qualified name (e.g. "fly/reviewer-architecture").
 */
export async function getAgent(name: string): Promise<AgentPersona | undefined> {
  const agents = await loadAgents();
  return agents.get(name);
}

/**
 * Get all agents in a category.
 */
export async function getAgentsByCategory(
  category: AgentCategory,
): Promise<AgentPersona[]> {
  const agents = await loadAgents();
  return [...agents.values()].filter((a) => a.category === category);
}

/**
 * Get all agent names in a category.
 */
export async function getAgentNames(
  category: AgentCategory,
): Promise<string[]> {
  const agents = await getAgentsByCategory(category);
  return agents.map((a) => a.name);
}

/**
 * Get all loaded agents as an array.
 */
export async function getAllAgents(): Promise<AgentPersona[]> {
  const agents = await loadAgents();
  return [...agents.values()];
}

/**
 * Clear the cache (for testing).
 */
export function clearAgentCache(): void {
  _agents = null;
}
