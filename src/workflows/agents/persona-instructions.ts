import type { AgentDefinition } from "../../infra/agent-definition.js";
import { renderCapabilityText, type CapabilityCheck } from "../../infra/capability-text.js";
import { renderSkillClosure } from "../skill-render.js";
import type { SkillRegistryRevision } from "../skill-schema.js";

/** The instructions that one persona brings to every run of it: the context
 *  of its required skills, in declaration order, then its own system prompt.
 *  A subagent dispatch and an agent of a workflow that runs as the persona
 *  read them here, so the persona means one thing in both places. Both render
 *  for `has`, the check of the agent that runs as the persona: its tools as
 *  the run will grant them and the availability of its selection
 *  (ARCH-CONTEXT-033). Only a bundled persona body carries markers; a user or
 *  project body is external text and passes through byte for byte. Throws
 *  when a required skill is not installed in `skills`, or when a bundled body
 *  holds an unbalanced capability marker. */
export function personaInstructions(
  persona: Extract<AgentDefinition, { kind: "persona" }>,
  skills: SkillRegistryRevision,
  has: CapabilityCheck,
): string {
  const body = persona.bundled ? renderCapabilityText(persona.systemPrompt, has) : persona.systemPrompt;
  return [...renderSkillClosure(persona.requiredSkills, skills, `Persona "${persona.name}"`, has), body].join("\n\n");
}
