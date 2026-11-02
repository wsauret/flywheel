import { describe, expect, it } from "bun:test";
import { skillSemanticAuditEvidenceIsCurrent, verifySkillSemanticAudit } from "../../../../../src/orchestration/modules/learning/skill-semantic-audit.js";
import { publishSkillRevision, type BundledSkillPackage, type SkillDefinition } from "../../../../../src/workflows/skill-schema.js";
import { prepareSkillPackage } from "../../../../../src/orchestration/modules/learning/skill-package-planning.js";

function prepared(dependencies: readonly string[] = []) {
  const dependencyLines = dependencies.length === 0 ? "" : `\ndependencies:\n${dependencies.map((id) => `  - ${id}`).join("\n")}`;
  const result = prepareSkillPackage(new Map([["SKILL.md", `---\ndescription: Candidate${dependencyLines}\n---\nCandidate procedure.`]]));
  if (!("package" in result)) throw new Error(result.error);
  return result.package;
}

function bundled(id: string): BundledSkillPackage {
  const pkg = prepared();
  return Object.freeze({ id, sourceKind: "agent", authority: "bundled", files: pkg.files, packageIdentity: pkg.identity });
}

function definition(pkg: BundledSkillPackage): SkillDefinition {
  return {
    id: pkg.id, name: pkg.id, trigger: "Canonical", tags: [], relatedIds: [], dependencies: [], agents: [],
    modelInvocable: true, body: "Canonical procedure.",
    evidence: { sha256: "body", bytes: 20, preview: "Canonical procedure." }, packageIdentity: pkg.packageIdentity, resources: [],
    source: { kind: "manifest", authority: "bundled", reach: "global", packageKey: pkg.id, files: new Map(pkg.files.map((file) => [file.path, file.content])) },
  };
}

function fixture() {
  const canonical = bundled("canonical");
  const selected = definition(canonical);
  return { canonical, revision: publishSkillRevision(7, new Map([[selected.id, selected]]), new Map([[canonical.id, canonical]])) };
}

describe("skill semantic audit", () => {

  it("binds independent evidence to candidate bytes and registry revision", () => {
    const { revision } = fixture();
    const candidate = prepared();
    expect(verifySkillSemanticAudit(candidate, revision, JSON.stringify({ outcome: "independent" }))).toEqual({
      kind: "verified", evidence: { candidateIdentity: candidate.identity, registryRevision: 7, outcome: { outcome: "independent" } },
    });
  });

  it("accepts specialization only through the first bundled dependency", () => {
    const { canonical, revision } = fixture();
    const candidate = prepared(["canonical"]);
    expect(verifySkillSemanticAudit(candidate, revision, JSON.stringify({ outcome: "specialization", canonicalSkillId: "canonical" }))).toEqual({
      kind: "verified",
      evidence: { candidateIdentity: candidate.identity, registryRevision: 7, outcome: { outcome: "specialization", canonicalSkillId: "canonical" }, canonicalPackageIdentity: canonical.packageIdentity },
    });
  });

  it("rejects fabricated specialization evidence when the canonical skill is not the first dependency", () => {
    const { canonical, revision } = fixture();
    const candidate = prepared();
    expect(skillSemanticAuditEvidenceIsCurrent(candidate, revision, {
      candidateIdentity: candidate.identity,
      registryRevision: revision.revision,
      outcome: { outcome: "specialization", canonicalSkillId: canonical.id },
      canonicalPackageIdentity: canonical.packageIdentity,
    })).toBe(false);
  });

  it("returns uncertain for malformed, extra, conflict, and shadowed specialization output", () => {
    const { canonical, revision } = fixture();
    const candidate = prepared(["canonical"]);
    expect(verifySkillSemanticAudit(candidate, revision, "not json").kind).toBe("uncertain");
    expect(verifySkillSemanticAudit(candidate, revision, JSON.stringify({ outcome: "independent", extra: true })).kind).toBe("uncertain");
    expect(verifySkillSemanticAudit(candidate, revision, '{"outcome":"conflict","outcome":"independent"}').kind).toBe("uncertain");
    expect(verifySkillSemanticAudit(candidate, revision, JSON.stringify({ outcome: "conflict" })).kind).toBe("uncertain");

    const external: SkillDefinition = { ...definition(canonical), source: { kind: "filesystem", authority: "external", reach: "project", packageDir: "/external/canonical", canonicalDir: "/external/canonical", canonicalId: "external", linked: false } };
    const shadowed = publishSkillRevision(8, new Map([[external.id, external]]), revision.bundledCorpus);
    expect(verifySkillSemanticAudit(candidate, shadowed, JSON.stringify({ outcome: "specialization", canonicalSkillId: "canonical" })).kind).toBe("uncertain");
  });
});
