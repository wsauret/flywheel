import type { PersonaMetadataIndex } from "./agents/persona-schema.js";
import type { BriefPersonaSlot } from "../protocol/workflow-view-protocol-types.js";
import { resolveSkillClosure } from "./skill-closure.js";
import { renderSkillContext } from "./skill-context.js";
import type { SkillDefinition, SkillRegistryRevision } from "./skill-schema.js";
import { compileSubagents } from "./skill-subagents.js";

export interface SkillInvocationOptions {
  /** Revision the dependency closure is composed from. The caller's registry
   *  owns it; this composition never reads a live registry. */
  readonly skills: SkillRegistryRevision;
  readonly personaIndex: PersonaMetadataIndex;
}

function renderAgentSection(slots: readonly BriefPersonaSlot[]): string {
  const lines = [
    "## Available Agents",
    "",
    "Dispatch these personas with your existing `subagent` tool where the skill body calls for agent dispatch.",
  ];
  for (const slot of slots) {
    lines.push(`\n**${slot.role}:** ${slot.personas.join(", ")}`);
  }
  return lines.join("\n");
}

function renderDirectResult(skill: SkillDefinition): string | undefined {
  return skill.directOutput === undefined ? undefined : `## Direct Result\n\n${skill.directOutput}`;
}

/** Assemble the canonical chat turn one skill invocation expands to: the
 *  context of its transitive dependencies, its own canonical context, the
 *  persona catalog when it declares agents, and its direct-result contract
 *  when it declares one.
 *
 *  This is the one direct-invocation path: the published skill command and the
 *  model `skill` tool render exactly this text, so a skill reads the same
 *  however it was selected. */
export function assembleSkillInvocation(
  skill: SkillDefinition,
  args: string | undefined,
  options: SkillInvocationOptions,
): string {
  const sections = resolveSkillClosure(skill.dependencies, options.skills, `Skill "${skill.id}"`)
    .map((dependency) => renderSkillContext(dependency));
  sections.push(renderSkillContext(skill));

  const slots = compileSubagents(skill, options.personaIndex);
  if (slots) sections.push(renderAgentSection(slots));
  const directResult = renderDirectResult(skill);
  if (directResult) sections.push(directResult);

  const prompt = sections.join("\n\n");
  return args === undefined ? prompt : `${prompt}\n\nARGUMENTS: ${args}`;
}
