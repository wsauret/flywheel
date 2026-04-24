import { readdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import yaml from "js-yaml";

const TierSchema = z.enum(["powerful", "mid", "cheap", "inherit"]);
type AgentTier = z.infer<typeof TierSchema>;

const HarnessSectionSchema = z.object({
  tools: z.array(z.string()),
  maxTurns: z.number().int().positive().default(30),
});

const PersonaFrontmatterSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    tier: TierSchema.default("inherit"),
    harness: HarnessSectionSchema.optional(),
  })
  .passthrough();

export interface AgentDefinition {
  name: string;
  description: string;
  systemPrompt: string;
  tools: readonly string[];
  // "inherit" means the subagent runs on the parent's current model rather
  // than pinning to a tier. The subagent tool maps this to the parent's model
  // at invocation time.
  defaultTier: AgentTier;
  maxTurns: number;
}

// Personas use a canonical format with `tier` at the top level (the concept is
// shared between Claude and the harness) and `claude:`/`harness:` subtrees for
// fields that differ per destination (tools, skills, maxTurns). When neither
// subtree is present we fall back to treating the top-level fields as
// harness-native, which keeps inline test fixtures working without conversion.
export function parsePersonaFile(content: string): AgentDefinition {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) throw new Error("Invalid persona file: missing YAML frontmatter delimiters");

  const rawYaml = match[1]!;
  const body = match[2]!.trim();

  const parsed = yaml.load(rawYaml) as Record<string, unknown>;
  const frontmatter = PersonaFrontmatterSchema.parse(parsed);

  const harness = frontmatter.harness ?? HarnessSectionSchema.parse(parsed);

  return {
    name: frontmatter.name,
    description: frontmatter.description,
    systemPrompt: body,
    tools: harness.tools,
    defaultTier: frontmatter.tier,
    maxTurns: harness.maxTurns,
  };
}

async function loadAgentsFromDirectory(dirPath: string): Promise<Map<string, AgentDefinition>> {
  const agents = new Map<string, AgentDefinition>();

  let entries: string[];
  try {
    entries = readdirSync(dirPath);
  } catch {
    return agents;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".md")) continue;
    const filePath = join(dirPath, entry);
    const file = Bun.file(filePath);
    const content = await file.text();
    try {
      const agent = parsePersonaFile(content);
      agents.set(agent.name, agent);
    } catch {
      // Persona without a harness section (e.g. Claude-only) is not loadable
      // by the harness — skip silently rather than failing registry load.
    }
  }

  return agents;
}

export async function loadAgentRegistry(
  builtInDir: string,
  userDir?: string,
  projectDir?: string,
): Promise<Map<string, AgentDefinition>> {
  const merged = await loadAgentsFromDirectory(builtInDir);

  if (userDir) {
    for (const [name, agent] of await loadAgentsFromDirectory(userDir)) {
      merged.set(name, agent);
    }
  }

  if (projectDir) {
    for (const [name, agent] of await loadAgentsFromDirectory(projectDir)) {
      merged.set(name, agent);
    }
  }

  return merged;
}
