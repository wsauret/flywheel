import type { SkillRegistryRevision } from "../../skills/skill-schema.js"
import type { ResolvedAgent } from "../../definitions/agent-resolution.js"
import { composedIdentity, type DefinitionIdentity, type DefinitionIdentityOptions } from "./definition-identity.js"

// Proofs that a skill closure an earlier build recorded is the closure of the current bundled skills. Each proof
// restores exactly the dependencies a retired edit removed, so any other change to a closure still reports as drift.

/** The dependencies that the lean-prompt edit of 2026-11-14 removed from bundled skills: the implementation skill
 *  stopped composing implementation-planning and loads it only when the change needs milestones. Remove after
 *  2027-05-14. */
const LEAN_PROMPT_DEPENDENCIES: ReadonlyMap<string, readonly string[]> = new Map([
  ["implementation", ["implementation-planning"]],
])

/** The revision with each bundled skill's dependencies as they read before the lean-prompt edit. A skill that is not
 *  bundled, or a removed dependency that is not installed, stays as it is. Returns the same revision when nothing
 *  changes. Remove after 2027-05-14. */
export function skillsBeforeLeanPrompt(revision: SkillRegistryRevision): SkillRegistryRevision {
  const skills = new Map(revision.skills)
  for (const [skillId, removed] of LEAN_PROMPT_DEPENDENCIES) {
    const skill = skills.get(skillId)
    const restored = removed.filter((id) => skills.has(id) && !skill?.dependencies.includes(id))
    if (skill?.source.authority !== "bundled" || restored.length === 0) continue
    skills.set(skillId, { ...skill, dependencies: [...restored, ...skill.dependencies] })
  }
  return skills.size === revision.skills.size && [...skills].every(([id, skill]) => revision.skills.get(id) === skill)
    ? revision
    : { ...revision, skills }
}

/** The skills that the agents composed before the lean-prompt edit and no longer compose. Remove after 2027-05-14. */
export function leanPromptDroppedSkills(
  workflowId: string,
  agents: readonly ResolvedAgent[],
  options: DefinitionIdentityOptions,
): ReadonlySet<string> {
  const before = skillsBeforeLeanPrompt(options.skills)
  if (before === options.skills) return new Set()
  const now = new Set(composedIdentity(workflowId, agents, options).skills.map(({ skillId }) => skillId))
  return new Set(composedIdentity(workflowId, agents, { ...options, skills: before }).skills
    .map(({ skillId }) => skillId)
    .filter((skillId) => !now.has(skillId)))
}

/** The recorded identity without each skill in `dropped` (refer to `leanPromptDroppedSkills`). Any other recorded
 *  skill stays, so a changed closure still reports as drift. Returns the same identity when no skill is removed.
 *  Remove after 2027-05-14. */
export function withoutLeanPromptDependencies<Identity extends DefinitionIdentity>(identity: Identity, dropped: ReadonlySet<string>): Identity {
  return identity.skills.some(({ skillId }) => dropped.has(skillId))
    ? { ...identity, skills: identity.skills.filter(({ skillId }) => !dropped.has(skillId)) }
    : identity
}
