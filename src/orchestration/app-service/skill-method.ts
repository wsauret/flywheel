import { getPersonaMetadataIndex } from "../../workflows/agents/agent-roles.js"
import { assembleSkillInvocation } from "../../workflows/skill-invocation.js"
import type { DefinitionAvailabilitySnapshot } from "./definition-availability.js"

/** The turn that starts one skill's method, or why the skill cannot start. */
export type SkillMethod =
  | { readonly kind: "ready"; readonly text: string }
  | { readonly kind: "unavailable"; readonly reason: string }

/** Resolves an installed skill from the runtime's own availability snapshot and
 *  renders its method exactly as the model's `skill` tool loads it, with `args`
 *  as its ARGUMENTS (ARCH-PROTOCOL-038). Unavailable when the skill is not
 *  installed or the module selection does not make it available, with a reason
 *  a person can act on. */
export function skillMethod(skillId: string, args: string | undefined, availability: DefinitionAvailabilitySnapshot): SkillMethod {
  const skill = availability.skillRevision.skills.get(skillId)
  const entry = availability.skills.get(skillId)
  if (!skill || !entry?.available) return { kind: "unavailable", reason: entry?.reason ?? "it is not installed" }
  return {
    kind: "ready",
    text: assembleSkillInvocation(skill, args, { skills: availability.skillRevision, personaIndex: getPersonaMetadataIndex() }),
  }
}
