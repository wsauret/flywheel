import type { PreparedPackage } from "../../agent-runtime/review-types.js";
import { realpathSync } from "node:fs";
import { sep } from "node:path";
import { readSkillPackageFiles } from "../../../workflows/skill-context.js";
import type { SkillDefinition, SkillRegistryRevision } from "../../../workflows/skill-schema.js";
import { prepareSkillPackage } from "./skill-package-planning.js";


export interface LearnedSkillEligibilityInput {
  readonly revision: SkillRegistryRevision;
  readonly projectRoot: string;
  readonly globalRoot?: string;
  readonly reach: "project" | "project-and-global";
}

export interface EligibleLearnedSkill {
  readonly definition: SkillDefinition;
  readonly package: PreparedPackage;
}

function canonicalRoot(path: string | undefined): string | undefined {
  if (!path) return undefined;
  try { return realpathSync(path); } catch { return undefined; }
}

function eligibleDefinition(definition: SkillDefinition, roots: readonly string[]): EligibleLearnedSkill | undefined {
  if (definition.managed !== "flywheel" || definition.source.kind !== "filesystem" || definition.source.authority !== "external") return undefined;
  const source = definition.source;
  if (source.linked) return undefined;
  if (!roots.some((root) => source.canonicalDir.startsWith(`${root}${sep}`))) return undefined;
  const files = readSkillPackageFiles(source, "external");
  if (!files) return undefined;
  const prepared = prepareSkillPackage(files);
  if (!("package" in prepared) || prepared.package.identity.sha256 !== definition.packageIdentity.sha256 || prepared.package.identity.bytes !== definition.packageIdentity.bytes) return undefined;
  return { definition, package: prepared.package };
}

interface EligibilityContext {
  readonly roots: readonly string[];
}

function eligibilityContext(input: LearnedSkillEligibilityInput): EligibilityContext {
  const project = canonicalRoot(input.projectRoot);
  const global = input.reach === "project-and-global" ? canonicalRoot(input.globalRoot) : undefined;
  return { roots: [project, global].filter((root): root is string => root !== undefined) };
}

/** Revalidates one named package without scanning the registry. */
export function eligibleLearnedSkill(input: LearnedSkillEligibilityInput, id: string): EligibleLearnedSkill | undefined {
  const definition = input.revision.skills.get(id);
  if (!definition) return undefined;
  return eligibleDefinition(definition, eligibilityContext(input).roots);
}
/** Captures exact active Flywheel-managed packages eligible for autonomous learning maintenance. */
export function eligibleLearnedSkills(input: LearnedSkillEligibilityInput): readonly EligibleLearnedSkill[] {
  const { roots } = eligibilityContext(input);
  const eligible: EligibleLearnedSkill[] = [];
  for (const definition of input.revision.skills.values()) {
    const candidate = eligibleDefinition(definition, roots);
    if (candidate) eligible.push(candidate);
  }
  return eligible.sort((left, right) => left.definition.id.localeCompare(right.definition.id));
}
