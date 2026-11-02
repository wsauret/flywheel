import type { PersonaMetadataIndex } from "./agents/persona-schema.js";
import type { BriefPersonaSlot } from "../protocol/workflow-view-protocol-types.js";
import type { SkillDefinition } from "./skill-schema.js";

/** Group a skill's persona list into per-role subagent slots. */
export function compileSubagents(
  skill: Pick<SkillDefinition, "id" | "agents">,
  personaIndex: PersonaMetadataIndex,
): BriefPersonaSlot[] | undefined {
  if (skill.agents.length === 0) return undefined;

  const byRole = new Map<string, string[]>();
  for (const name of skill.agents) {
    const meta = personaIndex[name];
    if (!meta) throw new Error(`Skill "${skill.id}" references unknown persona: ${name}`);
    let list = byRole.get(meta.role);
    if (!list) { list = []; byRole.set(meta.role, list); }
    list.push(name);
  }

  const slots = Array.from(byRole, ([role, personas]) => ({ role, personas }));
  return slots.length > 0 ? slots : undefined;
}
