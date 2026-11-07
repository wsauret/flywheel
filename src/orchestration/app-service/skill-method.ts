import type { CapabilityCheck } from "../../infra/capability-text.js"
import { getPersonaMetadataIndex } from "../../workflows/agents/agent-roles.js"
import { assembleSkillInvocation, skillInvocationRefusal } from "../../workflows/skill-invocation.js"
import type { DefinitionAvailabilitySnapshot } from "./definition-availability.js"

/** The turn that starts one skill's method, or why the skill cannot start. */
export type SkillMethod =
  | { readonly kind: "ready"; readonly text: string }
  | { readonly kind: "unavailable"; readonly reason: string }

/** Resolves an installed skill from the runtime's own availability snapshot and renders its method exactly as the
 *  model's `skill` tool loads it, with `args` as its ARGUMENTS (ARCH-PROTOCOL-038). Only the receiving chat reads the
 *  method, so it renders for that chat's agent check (ARCH-CONTEXT-033), which `agentCheck` plans only once the
 *  module selection makes the skill available. Unavailable, with a reason a person can act on, when the skill is not
 *  installed, the selection leaves a module of its closure off, or it dispatches agents and the chat's next request
 *  cannot call the subagent tool. */
export async function skillMethod(
  skillId: string,
  args: string | undefined,
  availability: DefinitionAvailabilitySnapshot,
  agentCheck: () => Promise<CapabilityCheck>,
): Promise<SkillMethod> {
  const skill = availability.skillRevision.skills.get(skillId)
  const entry = availability.skills.get(skillId)
  if (!skill || !entry?.available) return { kind: "unavailable", reason: entry?.reason ?? "it is not installed" }
  const has = await agentCheck()
  const refusal = skillInvocationRefusal(skill, availability.skillRevision, has)
  if (refusal !== undefined) return { kind: "unavailable", reason: refusal }
  return {
    kind: "ready",
    text: assembleSkillInvocation(skill, args, { skills: availability.skillRevision, personaIndex: getPersonaMetadataIndex(), capabilities: has }),
  }
}
