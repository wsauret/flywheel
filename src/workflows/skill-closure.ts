import type { SkillDefinition, SkillRegistryRevision } from "./skill-schema.js";

/** The one transitive-closure resolver of skill dependencies. Prompt assembly
 *  composes exactly this order and definition identity hashes exactly this set,
 *  so the procedure a worker reads and the contract that pins it cannot
 *  disagree about which packages participate.
 *
 *  Order is deterministic and dependency-first: every dependency of a skill
 *  appears before the skill that names it, roots keep their declaration order,
 *  and a skill reached twice is composed once, at its first position.
 *
 *  Throws when an id names no installed package or when the dependencies form a
 *  cycle. Both are definition errors the load-time validator reports first;
 *  reaching them here means the registry changed under a definition that
 *  requires the package, and composing a partial procedure would silently run a
 *  different one. */
export function resolveSkillClosure(
  rootIds: readonly string[],
  revision: SkillRegistryRevision,
  subject: string,
): readonly SkillDefinition[] {
  const closure: SkillDefinition[] = [];
  const resolved = new Set<string>();
  const visiting: string[] = [];

  const visit = (id: string): void => {
    if (resolved.has(id)) return;
    const cycleStart = visiting.indexOf(id);
    if (cycleStart >= 0) {
      throw new Error(`${subject} has a skill dependency cycle: ${[...visiting.slice(cycleStart), id].join(" -> ")}`);
    }
    const skill = revision.skills.get(id);
    if (!skill) throw new Error(`${subject} requires skill "${id}", which is not installed`);
    visiting.push(id);
    for (const dependency of skill.dependencies) visit(dependency);
    visiting.pop();
    resolved.add(id);
    closure.push(skill);
  };

  for (const id of rootIds) visit(id);
  return closure;
}

/** The members of the closure of `rootIds` that a person answers or approves (`attended: true`), in closure order. No
 *  person reads an unattended run, so none of its agents may compose or load one (PI-AGENT-121). Throws as
 *  `resolveSkillClosure` does. */
export function attendedClosureMembers(
  rootIds: readonly string[],
  revision: SkillRegistryRevision,
  subject: string,
): readonly SkillDefinition[] {
  return resolveSkillClosure(rootIds, revision, subject).filter((skill) => skill.attended);
}

/** Ids of the closure, which is what definition identity records. */
export function skillClosureIds(
  rootIds: readonly string[],
  revision: SkillRegistryRevision,
  subject: string,
): readonly string[] {
  return resolveSkillClosure(rootIds, revision, subject).map((skill) => skill.id);
}
