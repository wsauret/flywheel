import type { AgentDefinition } from "../../infra/agent-definition.js";
import { renderSkillClosure } from "../skill-context.js";
import type { SkillRegistryRevision } from "../skill-schema.js";

/** The instructions that one persona brings to every run of it: the context
 *  of its required skills, in declaration order, then its own system prompt.
 *  A subagent dispatch and an agent of a workflow that runs as the persona
 *  read them here, so the persona means one thing in both places. Throws
 *  when a required skill is not installed in `skills`. */
export function personaInstructions(
  persona: Extract<AgentDefinition, { kind: "persona" }>,
  skills: SkillRegistryRevision,
): string {
  return [...renderSkillClosure(persona.requiredSkills, skills, `Persona "${persona.name}"`), persona.systemPrompt].join("\n\n");
}
