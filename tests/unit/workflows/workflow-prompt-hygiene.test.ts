import { beforeAll, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { repoDefinitions } from "../../helpers/project-definitions.js";
import { renderSkillClosure } from "../../../src/workflows/skill-render.js";
import { readSrcFile } from "../../fixtures/read-src-file.js";

function workflowFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      files.push(...workflowFiles(path));
    } else {
      files.push(path);
    }
  }
  return files;
}

// Hygiene is judged on the prompt a worker actually receives: the canonical
// packages a skill or a brief depends on, composed ahead of its own body, and
// for a brief, its output requirements after it.
const readSkill = async (id: string): Promise<string> => {
  const skills = repoDefinitions().skills();
  const skill = skills.skills.get(id);
  if (skill) return [...renderSkillClosure(skill.dependencies, skills, `Skill "${id}"`, () => true), skill.body].join("\n\n");
  throw new Error(`no skill package: ${id}`);
};

describe("workflow prompt hygiene", () => {
  it("does not contain active text_search instructions", () => {
    const offenders = workflowFiles(join(process.cwd(), "src", "workflows"))
      .filter((path) => /\.(md|ts|tsx)$/.test(path))
      .filter((path) => readFileSync(path, "utf8").includes("text_search"));

    expect(offenders).toEqual([]);
  });

  it("does not reference deprecated learning directories", () => {
    const deprecatedLearningDirectory = /docs\/(?:standards|solutions)(?![a-z0-9_-])/i;
    expect([
      "Read docs/standards",
      "Read docs/standards/README.md",
      "Search docs/solutions",
      "Search docs/solutions/known-fix.md",
    ].map((value) => deprecatedLearningDirectory.test(value))).toEqual([true, true, true, true]);
    expect(["docs/standard", "docs/standards-archive", "docs/solutions_old"].map((value) => deprecatedLearningDirectory.test(value))).toEqual([
      false,
      false,
      false,
    ]);

    const offenders = workflowFiles(join(process.cwd(), "src", "workflows"))
      .filter((path) => /\.(md|ts|tsx|ya?ml)$/.test(path))
      .filter((path) => deprecatedLearningDirectory.test(readFileSync(path, "utf8")));

    expect(offenders).toEqual([]);
  });

  describe("debugging method evidence contract", () => {
    it("researches the report and runtime evidence without requesting a command", async () => {
      const rootCause = await readSrcFile("agent-skills/root-cause-analysis/SKILL.md");
      expect(rootCause).toMatch(/Treat the report as the investigation request/i);
      expect(rootCause).toMatch(/Do not ask the user for a reproduction or verification command/i);
      expect(rootCause).toMatch(/session, run, request, trace, or error identifiers[\s\S]{0,160}event store, trace store, or logs/i);
    });

    it("keeps the confidence rubric in the composed verification method", async () => {
      const method = await readSrcFile("agent-skills/verification/SKILL.md");
      const debug = await readSrcFile("agent-skills/systematic-debugging/SKILL.md");
      expect(method).toMatch(/High when the full causal chain is confirmed with a tested prediction[\s\S]{0,200}Low when/i);
      expect(debug).not.toMatch(/High when the full causal chain/i);
    });

    it("requires fresh independent proof in the end-to-end debug method", async () => {
      const method = await readSrcFile("agent-skills/systematic-debugging/SKILL.md");
      expect(method).toMatch(/fresh verification/i);
      expect(method).not.toMatch(/Reuse current focused GREEN evidence/i);
    });
  });

  describe("code-review reviewer evidence policy", () => {
    let body: string;
    beforeAll(async () => {
      body = await readSkill("code-review");
    });

    it("investigates ambiguous or unverified evidence before handoff", () => {
      expect(body).toMatch(/investigate ambiguous, incomplete, or unverified evidence/i);
      expect(body).toMatch(/targeted commands or mechanism verification/i);
      expect(body).toMatch(/concrete failure mode/i);
      expect(body).toMatch(/do not leave the evidence gap for the repair to close/i);
    });

    it("includes copy-only interface changes in design review for both targets", () => {
      expect(body).toMatch(/`reviewer-code-design`[\s\S]{0,260}user-facing copy/i);
      expect(body).toMatch(/`reviewer-plan-design`:[\s\S]{0,220}rendered interface/i);
    });

    it("sizes both reviewer families from one roster with named triggers", () => {
      expect(body).toMatch(/Trivial tier[\s\S]{0,400}`reviewer-code-elegance` or `reviewer-plan-elegance` alone/);
      expect(body).toMatch(/`reviewer-plan-security`:[\s\S]{0,180}secrets or credentials[\s\S]{0,180}path and file handling/i);
      expect(body).toMatch(/`reviewer-plan-performance`:[\s\S]{0,200}three or more milestones/i);
      expect(body).toMatch(/`reviewer-uat`, code only/);
    });

    it("assigns material claims before dispatch and carries them in the prompt", () => {
      expect(body).toMatch(/material factual claims verbatim with their locations/i);
      expect(body).toMatch(/Assign each claim to at least one reviewer/);
      expect(body).toContain("ASSIGNED CLAIMS");
    });

    it("fixes findings by shared structural cause and sweeps an integrated plan", async () => {
      const sweep = await readSrcFile("agent-skills/references/plan-review-orchestration.md");
      expect(body).toMatch(/Group actionable findings by shared structural cause, not by file/);
      expect(body).toMatch(/Do not apply reviewer fixes as isolated patches/);
      expect(body).toContain("{{ref:plan-review-orchestration}}");
      expect(sweep).toMatch(/walk the whole merged plan once, including content no reviewer flagged/);
      expect(sweep).toMatch(/design-cited or codebase-cited/);
      expect(sweep).toMatch(/Specialist-driven defensive complexity/);
    });

    it("requires reviewer-uat to investigate and report missing decisive runtime evidence", () => {
      expect(body).toMatch(/Investigate ambiguous runtime evidence within the review budget/i);
      expect(body).toMatch(/acceptance criterion still cannot be verified/i);
      expect(body).toMatch(/narrowest command or probe attempted/i);
      expect(body).toMatch(/do not defer an unverified acceptance claim to the repair/i);
    });
  });

  describe("implementation persistence", () => {
    it("authorizes autonomous replanning without file-list approval stops", async () => {
      const method = await readSkill("implementation");
      const persona = await readSrcFile("workflows/agents/personas/implementer.md");

      expect(method).toContain("Revise or drop the implementation plan");
      expect(method).toContain("Missing paths, extra callers, inaccurate estimates, and a failed planned approach require investigation");
      expect(method).toContain("not a permission boundary");
      expect(method).not.toContain("Do not redesign, broaden scope");
      expect(persona).toMatch(/requiredSkills:\s*\n\s*- implementation/);
      expect(persona).not.toContain("instead of guessing or expanding scope");
    });

    it("requires bounded implementers to troubleshoot newly discovered uncertainty", async () => {
      const body = await readSkill("implementation");

      expect(body).toMatch(/newly discovered uncertainty/i);
      expect(body).toMatch(/each material hypothesis/i);
      expect(body).toMatch(/fresh focused experiment or real observation/i);
      expect(body).toMatch(/remaining work[\s\S]{0,120}not a blocker/i);
    });

  });

  describe("implementation planning method", () => {
    // Planning has one reusable owner, not a workflow-specific copy.
    it("composes phase and verification planning from the implementation-planning method", async () => {
      const method = await readSrcFile("agent-skills/implementation-planning/SKILL.md");
      const rules = await readSrcFile("agent-skills/implementation/SKILL.md");

      expect(method).toMatch(/one agent in one run/i);
      expect(method).toMatch(/roughly ten files/i);
      expect(method).toMatch(/repository-relative production and test files/i);
      expect(method).toMatch(/transitive callers for API, schema, route, event, export, or configuration changes/i);
      expect(method).toMatch(/four or more components/i);
      expect(method).toMatch(/one canonical scenario per behavior/i);
      expect(method).toMatch(/Every milestone has the narrowest fresh runnable command/i);
      expect(method).toMatch(/Keep global acceptance separate/i);
      expect(method).toMatch(/No instance of <rejected-shape> in <scope>/);
      expect(method).toMatch(/never prefix the `timeout` shell utility, which is absent on macOS/i);
      expect(rules).toMatch(/never add a trailing newline[\s\S]{0,120}byte count you did not compute/i);
      expect(method).toMatch(/cannot pass checks without its consumer belongs with that consumer/i);
      expect(rules).toMatch(/recoverable from git, a diff, session artifacts, or tool logs/i);
      expect(method).not.toMatch(/handoff|prior step|earlier step/i);
      expect(rules).not.toMatch(/handoff|prior step|earlier step/i);

    });

  });


  describe("direct review target contracts", () => {
    it("keeps code review complete, host-neutral, and elegance-composed", async () => {
      const method = await readSkill("code-review-method");
      const skill = repoDefinitions().skills().skills.get("code-review-method");
      const targetBody = skill?.body ?? "";

      expect(skill?.dependencies).toEqual(["elegance-review-principles"]);
      expect(method).toMatch(/implementation against the original request or settled design/i);
      expect(method).toMatch(/callers?/i);
      expect(method).toMatch(/Return `Clean:` with the target and evidence only when no actionable finding remains/i);
      expect(targetBody).not.toMatch(/### End Goal|### Approach Chosen|### Completed Steps|### Current Status/);
      expect(targetBody).not.toMatch(/reviewer-mechanism|wave 2|synthesiz/i);
    });
  });

  describe("reviewer doctrine lives only in the reviewer protocol reference", () => {
    let protocol: string;
    beforeAll(async () => {
      protocol = await readSrcFile("agent-skills/references/reviewer-protocol.md");
    });

    it("keeps generic review doctrine in the composed method and workflow overrides in the dispatch block", async () => {
      const method = await readSkill("code-review-method");
      const dispatchBlock = protocol.split("```")[1] ?? "";

      expect(method).toContain("P1 (critical)");
      expect(method).toContain("Every finding names a concrete path and line");
      expect(dispatchBlock).toContain("Reviewers emit prose findings");
      expect(dispatchBlock).toContain("never \"in the auth module.\"");
      expect(dispatchBlock).toContain("These route to reviewer-mechanism in wave 2");
      expect(dispatchBlock).not.toContain("`P1` blocks merge");
      expect(dispatchBlock).not.toContain("A suppressed finding beats a noisy one");
    });

    it("leaves terminal routing to each review brief", () => {
      expect(protocol).toMatch(/the result contract of the invoking brief/i);
      expect(protocol).not.toMatch(/Use `ask_user` only as a rare fallback/i);
    });

    it("states the four-slot failure format once", () => {
      expect(protocol.match(/<Principle name>\. <Intent>\. <Observation>\. <Reasoning>\./g)).toHaveLength(1);
    });

    it("makes elegance govern synthesis after evidence settles instead of unioning specialist fixes", async () => {
      const mechanismVerdicts = protocol.indexOf("#### Apply the mechanism verdicts");
      const remedyArbitration = protocol.indexOf("#### Arbitrate remedy shapes after evidence settles");

      expect(mechanismVerdicts).toBeGreaterThanOrEqual(0);
      expect(remedyArbitration).toBeGreaterThan(mechanismVerdicts);
      expect(protocol).toMatch(/explicit requirements and confirmed correctness, security, data-integrity, performance, and runtime constraints as hard gates/i);
      expect(protocol).toMatch(/fewest new owners, states, layers, abstractions, and failure branches/i);
      expect(protocol).toMatch(/Never union reviewer fixes or count reviewer agreement/i);
      expect(protocol).toMatch(/specialist owns evidence in its domain, not the architecture of the remedy/i);
      expect(protocol).toMatch(/Other reviewers identify requirements the solution must meet/i);
      expect(protocol).toMatch(/They do not decide the solution/i);
      expect(protocol).toMatch(/choose the most elegant solution, no matter how many reviewers prefer another approach/i);
      expect(protocol).not.toMatch(/Pick the strongest Fix or merge them/i);
    });

    it("makes P3 findings opt-in through correctness and elegance judgment", () => {
      expect(protocol).toMatch(/P3 findings are opt-in/i);
      expect(protocol).toMatch(/improves correctness or elegance/i);
      expect(protocol).toMatch(/Drop style preferences, hypothetical hardening, theoretical scale concerns, optional robustness/i);
      expect(protocol).not.toMatch(/Include all P3 findings by default/i);
    });

    it("keeps reviewer doctrine out of non-review step prompts", async () => {
      for (const id of ["implementation", "research", "implementation-planning", "ship"]) {
        const body = await readSkill(id);
        expect(body).not.toMatch(/blocks merge/i);
        expect(body).not.toMatch(/false-positive/i);
      }
    });

    it("owns the constraint rules that reviewers and the synthesizer both apply", async () => {
      const step = await readSrcFile("agent-skills/code-review/SKILL.md");

      expect(protocol.match(/starts with `Deferred:`/g)).toHaveLength(1);
      expect(protocol).toContain("principled extension, not an implementation error");
      expect(protocol).toContain("do not propose an alternative; propose only where the user was silent");
      expect(step).not.toContain("principled extension, not an implementation error");
      expect(step).toContain("Apply the constraint rules in the reviewer protocol block");
      expect(protocol).toContain("project context paths supplied by the dispatching agent");
      expect(protocol).toContain("The supplied user requirements and Design intent bind you");
      expect(protocol).not.toMatch(/spec-create|constraints\[0\]|context\.project_docs/);
    });

    // The review method is an ingredient: it reads a target and reports
    // findings. Who dispatches it, what verifies its tagged claims, and what a
    // workflow consolidates are the caller's decisions.
    it("keeps the review method host-neutral", async () => {
      const method = await readSkill("code-review-method");

      expect(method).toMatch(/Get the actual diff/i);
      expect(method).toMatch(/tag it `UNVERIFIED`/);
      expect(method).toMatch(/the caller owns verification/i);
      expect(method).toMatch(/live acceptance of the running product belongs to UAT/i);
      expect(method).toContain("`Findings:`");

      expect(method).not.toMatch(/reviewer-mechanism|mechanism verifier|wave 2/i);
      expect(method).not.toMatch(/synthesiz/i);
      expect(method).not.toContain("Deferred:");
    });
  });

  describe("research protocol reference", () => {
    let protocol: string;
    beforeAll(async () => {
      protocol = await readSrcFile("agent-skills/references/research-protocol.md");
    });

    it("states facet fanout and documentarian mode exactly once", () => {
      expect(protocol.match(/Split the topic into 2-5 disjoint facets/g)).toHaveLength(1);
      expect(protocol.match(/Documentarian mode/g)).toHaveLength(1);
    });

    it("carries dispatch hygiene: inherited model and paths-not-content input", () => {
      expect(protocol).toMatch(/never set `model`/);
      expect(protocol).toMatch(/paths, not file content/i);
      expect(protocol).toMatch(/under 100 lines/i);
    });
  });

});
