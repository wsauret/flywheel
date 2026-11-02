import type { PreparedPackage, SkillSemanticAuditEvidence, SkillSemanticAuditResult } from "../../agent-runtime/review-types.js";
import { parseFrontmatter } from "../../../infra/frontmatter.js";
import { resolveSkillClosure } from "../../../workflows/skill-closure.js";
import { normalizeSkillFrontmatter, SKILL_FILE, type SkillPackageIdentity, type SkillRegistryRevision } from "../../../workflows/skill-schema.js";


type SkillSemanticAuditDecision =
  | { readonly outcome: "independent" }
  | { readonly outcome: "specialization"; readonly canonicalSkillId: string }
  | { readonly outcome: "conflict" }
  | { readonly outcome: "uncertain" }
  /** The answer left the contract: no outcome, and the reason why. */
  | { readonly outcome: "unmatched"; readonly reason: string };
/** Decode model output and bind a successful judgment to the exact candidate. */
export function verifySkillSemanticAudit(candidate: PreparedPackage, revision: SkillRegistryRevision, output: unknown): SkillSemanticAuditResult {
  const dependencies = candidateDependencies(candidate);
  if (!dependencies) return { kind: "uncertain", reason: "the candidate's SKILL.md frontmatter did not parse" };
  return bindEvidence(candidate.identity, dependencies, revision, decodeDecision(output));
}

/** Check request-local evidence against the candidate and current revision. */
export function skillSemanticAuditEvidenceIsCurrent(candidate: PreparedPackage, revision: SkillRegistryRevision, evidence: SkillSemanticAuditEvidence): boolean {
  const dependencies = candidateDependencies(candidate);
  if (!dependencies || !sameIdentity(evidence.candidateIdentity, candidate.identity) || evidence.registryRevision !== revision.revision) return false;
  if (evidence.outcome.outcome === "independent") return evidence.canonicalPackageIdentity === undefined;
  const canonical = resolveSpecializationCanonical(dependencies, evidence.outcome.canonicalSkillId, revision);
  return canonical !== undefined && evidence.canonicalPackageIdentity !== undefined && sameIdentity(canonical.packageIdentity, evidence.canonicalPackageIdentity);
}


function candidateDependencies(candidate: PreparedPackage): readonly string[] | undefined {
  const skillFile = candidate.files.find((file) => file.path === SKILL_FILE)?.content;
  if (skillFile === undefined) return undefined;
  const parsed = parseFrontmatter(skillFile);
  if (!parsed) return undefined;
  try {
    return normalizeSkillFrontmatter(parsed.frontmatter).dependencies;
  } catch {
    return undefined;
  }
}

function decodeDecision(output: unknown): SkillSemanticAuditDecision {
  if (typeof output !== "string") return { outcome: "unmatched", reason: "the auditor's answer was not text" };
  const text = output.trim();
  if (text === '{"outcome":"independent"}') return { outcome: "independent" };
  if (text === '{"outcome":"conflict"}') return { outcome: "conflict" };
  if (text === '{"outcome":"uncertain"}') return { outcome: "uncertain" };
  const specialization = /^\{"outcome":"specialization","canonicalSkillId":"([^"\\]+)"\}$/.exec(text);
  if (specialization?.[1]) return { outcome: "specialization", canonicalSkillId: specialization[1] };
  return { outcome: "unmatched", reason: `the auditor answered with text that is not one of the four outcomes: "${text.replace(/\s+/gu, " ").slice(0, 160)}"` };
}

function bindEvidence(candidateIdentity: SkillPackageIdentity, dependencies: readonly string[], revision: SkillRegistryRevision, decision: SkillSemanticAuditDecision): SkillSemanticAuditResult {
  if (decision.outcome === "conflict") return { kind: "uncertain", reason: "the auditor judged the candidate to duplicate or contradict a bundled procedure" };
  if (decision.outcome === "uncertain") return { kind: "uncertain", reason: "the auditor could not classify the candidate" };
  if (decision.outcome === "unmatched") return { kind: "uncertain", reason: decision.reason };
  if (decision.outcome === "independent") return { kind: "verified", evidence: { candidateIdentity, registryRevision: revision.revision, outcome: decision } };
  const canonical = resolveSpecializationCanonical(dependencies, decision.canonicalSkillId, revision);
  if (!canonical) {
    const first = dependencies[0];
    return { kind: "uncertain", reason: `the auditor named "${decision.canonicalSkillId}" as the canonical bundled skill, but the candidate's first dependency is ${first === undefined ? "none" : `"${first}"`}, so the specialization does not bind` };
  }
  return { kind: "verified", evidence: { candidateIdentity, registryRevision: revision.revision, outcome: decision, canonicalPackageIdentity: canonical.packageIdentity } };
}

export function resolveSkillSpecializationCanonical(candidate: PreparedPackage, canonicalSkillId: string, revision: SkillRegistryRevision) {
  const dependencies = candidateDependencies(candidate);
  if (!dependencies) return undefined;
  return resolveSpecializationCanonical(dependencies, canonicalSkillId, revision);
}

function resolveSpecializationCanonical(dependencies: readonly string[], canonicalSkillId: string, revision: SkillRegistryRevision) {
  const firstDependency = dependencies[0];
  if (firstDependency !== canonicalSkillId) return undefined;
  try {
    const dependency = resolveSkillClosure([firstDependency], revision, "Semantic audit candidate").find((skill) => skill.id === firstDependency);
    const canonical = revision.corePackages.get(firstDependency);
    if (!dependency || dependency.source.authority !== "bundled" || !canonical || !sameIdentity(dependency.packageIdentity, canonical.packageIdentity)) return undefined;
    return canonical;
  } catch {
    return undefined;
  }
}

function sameIdentity(left: SkillPackageIdentity, right: SkillPackageIdentity): boolean {
  return left.sha256 === right.sha256 && left.bytes === right.bytes;
}
