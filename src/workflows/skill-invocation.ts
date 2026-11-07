import type { CapabilityCheck } from "../infra/capability-text.js";
import type { PersonaMetadataIndex } from "./agents/persona-schema.js";
import type { BriefPersonaSlot } from "../protocol/workflow-view-protocol-types.js";
import { resolveSkillClosure } from "./skill-closure.js";
import { dispatchingSkill, renderSkillContext } from "./skill-context.js";
import type { SkillDefinition, SkillRegistryRevision } from "./skill-schema.js";
import { compileSubagents } from "./skill-subagents.js";

export interface SkillInvocationOptions {
  /** Revision the dependency closure is composed from. The caller's registry
   *  owns it; this composition never reads a live registry. */
  readonly skills: SkillRegistryRevision;
  readonly personaIndex: PersonaMetadataIndex;
  /** The check of the agent that reads the invocation (ARCH-CONTEXT-033). The
   *  caller admits only a skill whose `skillInvocationRefusal` is undefined. */
  readonly capabilities: CapabilityCheck;
}

function renderAgentSection(slots: readonly BriefPersonaSlot[]): string {
  const lines = [
    "## Available Agents",
    "",
    "Dispatch these personas where the skill body calls for agent dispatch.",
  ];
  for (const slot of slots) {
    lines.push(`\n**${slot.role}:** ${slot.personas.join(", ")}`);
  }
  return lines.join("\n");
}

function renderDirectResult(skill: SkillDefinition): string | undefined {
  return skill.directOutput === undefined ? undefined : `## Direct Result\n\n${skill.directOutput}`;
}

/** The skill and its transitive dependencies, dependencies first: the packages one invocation renders. */
function invocationClosure(skill: SkillDefinition, revision: SkillRegistryRevision): readonly SkillDefinition[] {
  return [...resolveSkillClosure(skill.dependencies, revision, `Skill "${skill.id}"`), skill];
}

/** Why the agent that `has` describes cannot carry out `skill`, or undefined when it can: the skill or one of its
 *  dependencies dispatches agents, and that agent cannot call the subagent tool. A module that is off is the
 *  caller's availability check, which already covers the whole closure. */
export function skillInvocationRefusal(skill: SkillDefinition, revision: SkillRegistryRevision, has: CapabilityCheck): string | undefined {
  if (has("subagent")) return undefined;
  const blocked = dispatchingSkill(invocationClosure(skill, revision));
  if (!blocked) return undefined;
  return blocked === skill
    ? "it dispatches agents, and the agent that reads it cannot call the subagent tool"
    : `it composes skill "${blocked.id}", which dispatches agents, and the agent that reads it cannot call the subagent tool`;
}

/** Assemble the canonical chat turn one skill invocation expands to: the
 *  context of its transitive dependencies, its own canonical context, the
 *  persona catalog when it declares agents, and its direct-result contract
 *  when it declares one. Every body renders for `options.capabilities`.
 *  Throws when `skillInvocationRefusal` refuses the skill for that check.
 *
 *  This is the one direct-invocation path: the published skill command and the
 *  model `skill` tool render exactly this text, so a skill reads the same
 *  however it was selected. */
export function assembleSkillInvocation(
  skill: SkillDefinition,
  args: string | undefined,
  options: SkillInvocationOptions,
): string {
  const refusal = skillInvocationRefusal(skill, options.skills, options.capabilities);
  if (refusal) throw new Error(`Skill "${skill.id}" cannot be invoked: ${refusal}`);
  const sections = invocationClosure(skill, options.skills).map((member) => renderSkillContext(member, options.capabilities));

  const slots = compileSubagents(skill, options.personaIndex);
  if (slots) sections.push(renderAgentSection(slots));
  const directResult = renderDirectResult(skill);
  if (directResult) sections.push(directResult);

  const prompt = sections.join("\n\n");
  return args === undefined ? prompt : `${prompt}\n\nARGUMENTS: ${args}`;
}
