import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isQualifiedSkillId } from "../../../src/infra/skill-id.js";
import type { AgentDefinition } from "../../../src/infra/agent-definition.js";
import { loadStandalonePersonaRegistry } from "../../../src/workflows/agents/registry.js";
import { getPersonaMetadataIndex } from "../../../src/workflows/agents/agent-roles.js";
import { createSkillTool } from "../../../src/orchestration/agent-runtime/tools/skill.js";
import { resolveWorkflowAgents } from "../../../src/workflows/agent-resolution.js";
import { fixtureDefinitions, FIXTURE_WORKFLOW_ID, workflowIn } from "../../helpers/project-definitions.js";
import { loadSkillDefinitions } from "../../../src/workflows/skills.js";
import { DEVELOPMENT_MODULES } from "../../../src/orchestration/development-modules.js";
import { installedDefinitionBundles } from "../../../src/orchestration/module-catalog.js";
import { renderSkillClosure } from "../../../src/workflows/skill-context.js";
import { publishSkillRevision, type SkillRegistryRevision } from "../../../src/workflows/skill-schema.js";
import { bodyFor, bundled, bundledLoad, bundleRoots, SKILL_ROOTS } from "./_bundled-skills.js";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const PERSONA_DIR = join(REPO_ROOT, "src", "workflows", "agents", "personas");

// The development module's bundle beside the shipped roots: Flywheel's own
// methods live there and are held to the same contracts.
const developmentLoad = loadSkillDefinitions({ roots: [...SKILL_ROOTS, ...bundleRoots(installedDefinitionBundles(DEVELOPMENT_MODULES))] });
const development = developmentLoad.skills;
const developmentRevision: SkillRegistryRevision = publishSkillRevision(1, development, developmentLoad.bundledCorpus);
const revision: SkillRegistryRevision = publishSkillRevision(1, bundled, bundledLoad.bundledCorpus);

// The method packages. A workflow step is workflow content, not a package, so
// no step id appears here.
const EXPECTED_IDS = [
  "code-review",
  "code-review-method",
  "data-integrity-review-principles",
  "design",
  "elegance-review-principles",
  "experiment-charter",
  "experiment-finalize",
  "implementation",
  "implementation-planning",
  "interface-design",
  "mechanism-verification",
  "performance-review-principles",
  "plan-review",
  "research",
  "root-cause-analysis",
  "security-review-principles",
  "ship",
  "surface-mapping",
  "systematic-debugging",
  "test-driven-development",
  "uat",
  "verification",
  "workflow-authoring",
  "worktree-lifecycle",
];

// The canonical method packages the always-on kernel routes to instead of
// restating their bodies.
const METHOD_IDS = [
  "code-review",
  "design",
  "effect-lifecycle",
  "flywheel-uat",
  "implementation",
  "solid-reactivity",
  "systematic-debugging",
  "test-driven-development",
  "tui-rendering",
  "typescript-bun",
];

const INGREDIENT_IDS = [
  "design",
  "elegance-review-principles",
  "implementation-planning",
  "root-cause-analysis",
  "test-driven-development",
  "uat",
  "verification",
];

// Every package is one an agent can pick by itself, so the routing-surface
// limits below apply to all of them.
const directlyInvoked = [...bundled.values()];

function renderedSkillCount(rendered: readonly string[], id: string): number {
  const header = `# Skill: ${id}`;
  return rendered.filter((entry) => {
    const firstLine = entry.split("\n", 1)[0];
    return firstLine === header || firstLine?.startsWith(`${header} (`) === true;
  }).length;
}

describe("bundled skill packages", () => {
  it("installs exactly the canonical set", () => {
    expect([...bundled.keys()].sort()).toEqual(EXPECTED_IDS);
  });

  it("advertises one unique trigger per package", () => {
    const triggers = new Set<string>();
    for (const skill of bundled.values()) {
      expect(skill.trigger.length).toBeGreaterThan(0);
      expect(triggers.has(skill.trigger)).toBe(false);
      triggers.add(skill.trigger);
    }
  });

  it("keeps the directly invoked triggers concise", () => {
    for (const skill of directlyInvoked) {
      expect(skill.trigger.length).toBeGreaterThan(30);
      // The roster is advertised in every system prompt, so a trigger is a
      // routing pointer, never a summary of the body.
      expect(skill.trigger.length).toBeLessThanOrEqual(110);
    }
  });

  it("carries a body behind every trigger", () => {
    for (const skill of bundled.values()) {
      expect(skill.evidence.bytes).toBeGreaterThan(0);
      expect(skill.body.startsWith("---")).toBe(false);
    }
    for (const skill of directlyInvoked) {
      const minimumBytes = skill.id.endsWith("-review-principles") ? 800 : 500;
      expect(skill.evidence.bytes).toBeGreaterThan(minimumBytes);
    }
  });

  it("routes interface design through planning and review only", () => {
    const interfaceDesign = bundled.get("interface-design");

    expect(interfaceDesign?.trigger).toContain("planning or reviewing");
    expect(interfaceDesign?.trigger).not.toMatch(/\bbuilding\b/i);
    expect(interfaceDesign?.body).toContain("## Planning mode");
    expect(interfaceDesign?.body).toContain("## Review mode");
    expect(interfaceDesign?.body).toContain("Do not write frontend code");
  });

  it("owns the implementation-route section in the design package", () => {
    const design = bundled.get("design");

    expect(design?.body).toContain("## Recommended implementation route");
    expect(design?.body).toContain("select exactly one implementation route:\n   - inline;");
    expect(design?.body).not.toContain("inline, subagent, implement,");
    expect(design?.body).toContain("a delivery commitment, not a suggestion for later");
    expect(design?.body).toContain("Approval covers the design and that route");
    expect(design?.body).toContain("Design-only requires an explicit restriction");
    expect(design?.body).toContain("immediately execute the approved route");
    expect(design?.body).toContain("Do not stop at approval or intent publication");
    expect(design?.body).toContain("no open questions");
    expect(design?.body).toContain("discovery, experiments, spikes, or proof-of-concept work");
    expect(bodyFor(design)).toContain("in the same turn, ask the person to choose `Approve and continue` or `Revise design`, where `Revise design` takes their text.\nAlso offer `Advisor review first`");
    expect(design?.body).toContain("ask the person again only when");
    expect(design?.body).not.toContain("ask_user");
    expect(design?.body).toContain("Existing scope approval takes precedence over per-design approval");
    expect(design?.body).toContain("fix all broken lint and tests");
    expect(design?.body).toContain("An ordinary bug investigation still requires fix-design approval");
    expect(design?.body).toContain("Tool consent requirements remain binding");
    expect(design?.body).toContain("State the deciding observation and its acceptance criterion");
    expect(design?.body).toContain("Close every rejected hypothesis with the evidence that rejected it");
    expect(design?.body).toContain("recommend no delivery route");
  });

  it("keeps scientific scope decisions consistent across delivery and review methods", () => {
    const implementation = bundled.get("implementation");
    const planReview = bundled.get("plan-review");
    const codeReview = bundled.get("code-review");

    expect(implementation?.body).toContain("Technical diagnoses and implementation designs are hypotheses");
    expect(implementation?.body).toContain("Cut or simplify proposed work when evidence supports it");
    expect(implementation?.body).toContain("Expand scope only by the smallest amount demonstrated necessary");
    expect(implementation?.body).toContain("A no-change result is complete");
    expect(planReview?.body).toContain("Preserve approved outcomes, constraints, and explicit user decisions");
    expect(planReview?.body).toContain("Accept evidence-backed reductions");
    expect(planReview?.body).toContain("Admit additional work only when concrete evidence");
    expect(planReview?.body).toContain("Reducing scope never means dropping required behavior or verification");
    expect(codeReview?.body).not.toContain("reviewer-code-performance` for a large diff");
    expect(codeReview?.body).not.toContain("reviewer-code-data-integrity` for a large diff");
  });

  it("enters design for feature feasibility and confirmed fixes, not only ambiguous work", () => {
    const design = bundled.get("design");

    expect(design?.trigger).toContain("feature feasibility");
    expect(design?.trigger).toContain("fix");
    expect(design?.body).not.toContain("Turn an ambiguous change");
    expect(design?.body).toContain("A confirmed cause starts fix design");
    expect(design?.body).toContain("When the requested outcome remains unmet and evidence supports a viable change");
  });

  it("continues confirmed debugging through design only in interactive chat", () => {
    const debugging = bundled.get("systematic-debugging");

    expect(debugging?.body).toContain("In interactive chat only");
    expect(debugging?.body).toContain("load the `design` skill");
    expect(debugging?.body).toContain("its scope check decides whether approval is needed");
    expect(debugging?.body).toContain("approval resumes this method");
    expect(debugging?.body).toContain("Any agent outside an interactive chat follows its brief autonomously");
    expect(debugging?.dependencies).not.toContain("design");
  });

  it("prefers empirical design evidence over educated guesses", () => {
    const design = bundled.get("design");
    const research = bundled.get("research");

    expect(design?.body).toContain("Prefer observed behavior over educated guesses");
    expect(design?.body).toContain("analyze representative data");
    expect(design?.body).toContain("disposable proof-of-concept tests");
    expect(design?.body).toContain("remaining inference");
    // The spike precedes every design: code claims cite code, every other load-bearing claim rests on a spike.
    expect(design?.body).toContain("Spike before you design");
    expect(design?.body).toContain("Prove a claim about what code does by citing the code");
    expect(design?.body).toContain("rests on what a spike observed");
    expect(design?.body).toContain("Prototype competing shapes only when inspection cannot tell the viable shapes apart");
    expect(design?.body).toContain("Your confidence after a code survey is never proof");
    expect(design?.body).toContain("changes the approach before you show any design");
    expect(design?.body).toContain("returns that finding with its evidence, and only evidence-supported alternatives, instead of a design");
    expect(design?.body).toContain("labeled untested theory");
    expect(design?.body).toContain("A decisive no-change conclusion completes the request without approval or delivery");
    expect(research?.body).toContain("Prefer empirical evidence over static reasoning");
    expect(research?.body).toContain("run actual code paths");
    expect(research?.body).toContain("focused experiments in scratch");
  });

  it("publishes the enforced worktree lifecycle doctrine", () => {
    const lifecycle = bundled.get("worktree-lifecycle");
    const ship = bundled.get("ship");

    expect(lifecycle?.modelInvocable).toBe(true);
    expect(lifecycle?.trigger.length).toBeLessThanOrEqual(60);
    expect(lifecycle?.body).toContain("git merge-base --is-ancestor");
    expect(lifecycle?.body).toContain("dispatch `ship` once without forked history");
    expect(lifecycle?.body).toContain("Keep integration and cleanup ownership in the parent");
    expect(lifecycle?.body).not.toContain("load the `ship` skill");
    expect(lifecycle?.body).not.toContain("session scratch");
    expect(lifecycle?.body).not.toContain("worktree remove --force");
    expect(lifecycle?.body).not.toMatch(/git (?:checkout --|reset --hard|stash|clean)/);
    expect(ship?.body).toContain("Leave uncommitted edits outside the supplied list untouched");
    expect(ship?.body).toContain("never use `--autostash`");
    expect(ship?.body).toContain("When the caller supplied that account, put it in the description verbatim");
    expect(ship?.body).toContain("do not assess, edit, or verify it");
    expect(ship?.body).toContain("Use `commit + push` to the current branch's normal push target by default");
  });

  it("publishes both experiment methods as routers over declared references and one finalizer script", () => {
    const charter = bundled.get("experiment-charter");
    const finalize = bundled.get("experiment-finalize");

    expect(charter?.resources.map((resource) => resource.path)).toEqual(["references/loop-rules.md", "references/scripts.md"]);
    expect(finalize?.resources.map((resource) => resource.path)).toEqual(["finalize.sh", "references/groups-json.md"]);
    // Each package ships in the bundle of the module whose tools it runs, so it leaves with that module.
    for (const [skill, bundle] of [[charter, "experiments"], [finalize, "experiments"], [bundled.get("workflow-authoring"), "workflows-bundle"]] as const) {
      expect(skill?.source.kind === "filesystem" ? skill.source.bundle : undefined).toBe(bundle);
    }
    // The person approves each section through whatever channel the agent holds.
    expect(charter?.body).toContain("approved by the person before the next section starts");
    expect(charter?.body).toContain("ask the person for final approval");
    expect(charter?.body).not.toContain("ask_user");
    expect(bundled.get("workflow-authoring")?.body).toContain("you ask the person which one to keep");
  });

  it("ships Flywheel's own methods only in the development module, model-loadable", () => {
    const ids = ["effect-lifecycle", "flywheel-design", "flywheel-uat", "ios-uat", "refactor-safety-net", "session-debugging", "skill-prompt-audit", "solid-reactivity", "tui-rendering", "typescript-bun", "vscode-uat", "webview-rendering", "webview-uat"];

    for (const id of ids) {
      expect(bundled.has(id), id).toBe(false);
      const skill = development.get(id);
      expect(skill?.source.kind === "filesystem" ? skill.source.bundle : undefined, id).toBe("development");
      expect(skill?.modelInvocable, id).toBe(true);
    }

    expect(development.get("flywheel-design")?.dependencies).toEqual(["design"]);
    const design = development.get("flywheel-design")?.body;
    expect(design).toContain("## Intent");
    expect(design).toContain("`docs/product-intent/`");
    expect(design).toContain("`docs/architecture-intent/`");
    // Persisting intent gates every route, whichever ones this agent can take.
    expect(design).toContain("Persist the approved wording before any implementation route starts, or before design-only completion.");
    // The audit's example command must exist with every optional module off.
    expect(development.get("skill-prompt-audit")?.body).toContain("such as `/bug-report-triage`, return");
    const uat = development.get("flywheel-uat")
    expect(uat?.body).toContain("Credential-backed UAT is the default")
    expect(uat?.body).toContain("Clone only that profile's `auth.json` and optional `profile.json`")
    expect(uat?.body).toContain("`for fresh chat`")
    expect(uat?.body).toContain("45 seconds")
    expect(uat?.body).toContain("every 50 ms")
    expect(uat?.body).toContain("A pane process that exits before the marker, or a readiness timeout, is `blocked`")
    expect(uat?.body).toContain("before cleanup retain the final pane capture, available pane history, and stderr file")
    expect(uat?.body).toContain("Do not treat first paint, a title, spinner text, unrelated status copy, or a fixed sleep as readiness")
    expect(uat?.body).toContain("After readiness, use separate `type` and `submit` calls")
    expect(uat?.body).toContain("submit one bounded non-destructive prompt")
    expect(uat?.body).toContain("removes the isolated HOME and copied credentials")
    const iosUat = development.get("ios-uat")
    expect(iosUat?.body).toContain("semantic snapshot")
    expect(iosUat?.body).toContain("element ref")
    expect(iosUat?.body).toContain("parameters in the `arguments` object")
    expect(iosUat?.body).toContain("Use the `schema` action")
    expect(iosUat?.body).toContain("snapshotToken")
    expect(iosUat?.body).toContain("tap-point")
    expect(iosUat?.body).toContain("Never click the Simulator through host-window coordinates")
  });

  it("composes Flywheel design after the generic design method", () => {
    const rendered = renderSkillClosure(["flywheel-design"], developmentRevision, "Flywheel design", () => true).slice(1);

    expect(rendered).toHaveLength(2);
    expect(rendered[0]).toContain(bodyFor(development.get("design")));
    expect(rendered[1]).toContain(bodyFor(development.get("flywheel-design")));
  });

  it("points only at installed packages", () => {
    for (const skill of bundled.values()) {
      for (const related of skill.relatedIds) expect(bundled.has(related)).toBe(true);
    }
  });

  // The roster is the only discovery surface that reaches the model without a
  // tool call, so the advertisement carries every installed skill's trigger
  // line; a partial roster reads as complete and defeats scan-then-load.
  it("advertises every installed skill's trigger line", () => {
    const guidelines = createSkillTool({ treeCapabilities: () => true, availability: { skills: new Map() }, revision, personaIndex: getPersonaMetadataIndex() }).promptGuidelines?.join("\n") ?? "";

    for (const skill of revision.modelInvocable) {
      expect(guidelines, skill.id).toContain(`- ${skill.id}: `);
    }
    expect(guidelines).not.toContain("more installed skills");
  });

  // The catalog unification merged the package ids and the step definition ids
  // into one qualified id namespace, so every shipped id must be admissible
  // there and no id may name two packages.
  it("ships one qualified id per package in the single catalog", () => {
    expect(bundled.size).toBe(EXPECTED_IDS.length);
    for (const id of bundled.keys()) {
      expect({ id, qualified: isQualifiedSkillId(id) }).toEqual({ id, qualified: true });
    }
  });
});

describe("deterministic composition", () => {
  const dependencies = (id: string): readonly string[] => {
    const skill = development.get(id);
    if (!skill) throw new Error(`Skill ${id} is missing`);
    return skill.dependencies;
  };

  it("composes the canonical method into the packages that run it", () => {
    expect(dependencies("implementation")).toEqual(["implementation-planning", "test-driven-development", "verification"]);
    expect(dependencies("systematic-debugging")).toEqual(["root-cause-analysis", "test-driven-development", "verification"]);
    expect(dependencies("flywheel-uat")).toEqual(["uat"]);
    expect(dependencies("vscode-uat")).toEqual(["uat"]);
    expect(dependencies("tui-rendering")).toEqual([]);
    expect(dependencies("code-review")).toEqual(["elegance-review-principles"]);
    const fixtures = fixtureDefinitions();
    const workflow = workflowIn(fixtures.captureRevision(), FIXTURE_WORKFLOW_ID);
    const agents = resolveWorkflowAgents(workflow);
    expect(agents.get("investigate")?.dependencies).toEqual(["root-cause-analysis"]);
    expect(agents.get("fix")?.dependencies).toEqual(["test-driven-development"]);
    expect(agents.get("verify")?.dependencies).toEqual(["verification"]);
  });

  it("delegates publication to the ship persona here and leaves the package invocable elsewhere", () => {
    const ship = bundled.get("ship");
    expect(ship?.delegate).toBe("ship");
    expect(ship?.modelInvocable).toBe(false);
    expect(revision.modelInvocable.some((skill) => skill.id === "ship")).toBe(false);
    // The cross-harness keys stay absent, so a harness without the Ship agent
    // reads an ordinary invocable skill.
    const frontmatter = readFileSync(join(REPO_ROOT, "src", "agent-skills", "ship", "SKILL.md"), "utf8").split("---")[1] ?? "";
    expect(frontmatter).not.toContain("disable-model-invocation");
    expect(frontmatter).not.toContain("user-invocable");
    const personas = loadStandalonePersonaRegistry(PERSONA_DIR, revision);
    const persona = personas.get("ship");
    expect(persona?.kind === "persona" && persona.requiredSkills?.includes("ship")).toBe(true);
  });

  it("routes review methods only through target-correct personas", () => {
    const codeReview = bundled.get("code-review");
    const legacyWorkflowReview = bundled.get("fly.code-review");
    const codeAgents = codeReview?.agents ?? [];

    expect(codeReview?.modelInvocable).toBe(true);
    expect(legacyWorkflowReview).toBeUndefined();
    expect(codeReview?.body).toContain("For a review-only request, report and stop without editing.");
    expect(codeAgents).toContain("reviewer-code-elegance");
    expect(codeAgents).toContain("reviewer-code-design");
    // The one orchestration method dispatches both families; each persona
    // composes only its own target method.
    expect(codeAgents).toContain("reviewer-plan-elegance");
    expect(codeAgents).toContain("reviewer-plan-design");
    expect(codeAgents).not.toContain("reviewer-elegance");
    expect(codeAgents).not.toContain("reviewer-performance");
    expect(codeAgents).not.toContain("reviewer-data-integrity");
    expect(codeAgents).not.toContain("reviewer-security");
  });

  it("renders direct review and principle composition without target contamination", () => {
    const principleIds = [
      "elegance-review-principles",
      "performance-review-principles",
      "data-integrity-review-principles",
      "security-review-principles",
    ];
    for (const target of ["code-review", "plan-review"]) {
      const rendered = renderSkillClosure([target], revision, `Direct ${target}`, () => true);
      expect(renderedSkillCount(rendered, target), target).toBe(1);
      expect(renderedSkillCount(rendered, "elegance-review-principles"), target).toBe(1);
      expect(renderedSkillCount(rendered, target === "code-review" ? "plan-review" : "code-review"), target).toBe(0);
      for (const principle of principleIds.slice(1)) expect(renderedSkillCount(rendered, principle), `${target}: ${principle}`).toBe(0);
    }

    for (const principle of principleIds) {
      const rendered = renderSkillClosure([principle], revision, `Direct ${principle}`, () => true);
      const prompt = rendered.join("\n\n");
      expect(renderedSkillCount(rendered, principle), principle).toBe(1);
      expect(renderedSkillCount(rendered, "code-review"), principle).toBe(0);
      expect(renderedSkillCount(rendered, "plan-review"), principle).toBe(0);
      expect(prompt, principle).toMatch(/exactly one active (?:review )?target/i);
      expect(prompt, principle).toMatch(/if neither (?:target )?is active|if neither is active/i);
    }
  });

  it("renders each review family's target closure exactly once", () => {
    const personas = loadStandalonePersonaRegistry(PERSONA_DIR, revision);
    const cases = [
      { workflow: "code-review", mandatory: "reviewer-code-elegance", target: "code-review-method", opposite: "plan-review", orchestration: 0 },
      { workflow: "code-review", mandatory: "reviewer-plan-elegance", target: "plan-review", opposite: "code-review-method", orchestration: 0 },
    ];

    for (const item of cases) {
      const workflow = bundled.get(item.workflow);
      const persona = personas.get(item.mandatory);
      if (!workflow || !persona || persona.kind !== "persona") throw new Error(`review closure not loaded: ${item.workflow}`);
      expect(workflow.agents, item.workflow).toContain(item.mandatory);
      const rendered = renderSkillClosure([...workflow.dependencies, ...(persona.requiredSkills ?? [])], revision, `Workflow ${item.workflow}`, () => true);
      expect(renderedSkillCount(rendered, item.target), item.workflow).toBe(1);
      expect(renderedSkillCount(rendered, "code-review"), item.workflow).toBe(item.orchestration);
      expect(renderedSkillCount(rendered, "elegance-review-principles"), item.workflow).toBe(1);
      if (item.opposite) expect(renderedSkillCount(rendered, item.opposite), item.workflow).toBe(0);
      for (const principle of ["performance-review-principles", "data-integrity-review-principles", "security-review-principles"]) {
        expect(renderedSkillCount(rendered, principle), `${item.workflow}: ${principle}`).toBe(0);
      }
    }
  });

  it("keeps dependency ingredients reachable under their invocation policy", () => {
    // Flywheel's own methods in the development bundle depend on shipped
    // ingredients too, so the closure is walked over both.
    const ingredientIds = [...new Set([...development.values()].flatMap((entry) => entry.dependencies))].sort();
    const modelInvocableIds = new Set(developmentRevision.modelInvocable.map((skill) => skill.id));

    expect(ingredientIds).toEqual(INGREDIENT_IDS);
    for (const skillId of ingredientIds) {
      const skill = development.get(skillId);
      expect(skill?.modelInvocable, skillId).toBe(true);
      expect(modelInvocableIds.has(skillId), skillId).toBe(true);
    }
  });

  it("requires inline revision text in the built-in design approval", () => {
    const body = bundled.get("design")?.body
    expect(body).toContain("where `Revise design` takes their text")
    expect(body).toContain("A text answer that rejects the approach, not a detail, returns the work to step 1")
    expect(body).toContain("When you cannot tell a correction from a rethink, ask")
  })

  it("settles challenges on the disputed premise and reshapes published code against its existing proof", () => {
    const body = bundled.get("design")?.body
    expect(body).toContain("first restate their model")
    expect(body).toContain("name the exact premise where it differs from yours")
    expect(body).toContain("Do not defend or concede by reflex")
    expect(body).toContain("treat the behavioral proof that the change already passed, its tests, probes, and measurements, as a fixed contract")
    expect(body).toContain("only after the same proof passes again")
    expect(body).toContain("A local objection, such as a name, a misplaced function, or a missing case, is an ordinary fix: verify it and publish it to the same change")
  })

});

// A persona's method is definition data: the packages its lens always needs
// compose into the dispatched prompt in declaration order, so the child spends
// no turn loading them and cannot skip one. A lens whose method is optional
// stays metadata-only and loads it with the skill tool.
describe("persona method composition", () => {
  const REQUIRED_SKILLS = {
    implementer: ["implementation"],
    "reviewer-code-quality": ["code-review-method"],
    "reviewer-code-design": ["code-review-method", "interface-design"],
    "reviewer-plan-quality": ["plan-review"],
    "reviewer-plan-design": ["plan-review", "interface-design"],
    "reviewer-code-elegance": ["code-review-method"],
    "reviewer-plan-elegance": ["plan-review"],
    "reviewer-code-performance": ["code-review-method", "performance-review-principles"],
    "reviewer-plan-performance": ["plan-review", "performance-review-principles"],
    "reviewer-code-data-integrity": ["code-review-method", "data-integrity-review-principles"],
    "reviewer-plan-data-integrity": ["plan-review", "data-integrity-review-principles"],
    "reviewer-code-security": ["code-review-method", "security-review-principles"],
    "reviewer-plan-security": ["plan-review", "security-review-principles"],
    "reviewer-uat": ["uat"],
    "reviewer-mechanism": ["mechanism-verification"],
  };
  const personas = loadStandalonePersonaRegistry(PERSONA_DIR, revision);

  const persona = (name: string): Extract<AgentDefinition, { kind: "persona" }> => {
    const found = personas.get(name);
    if (!found || found.kind !== "persona") throw new Error(`persona not loaded: ${name}`);
    return found;
  };

  it("declares each deterministic method as requiredSkills", () => {
    for (const [name, ids] of Object.entries(REQUIRED_SKILLS)) {
      expect({ name, requiredSkills: persona(name).requiredSkills }).toEqual({ name, requiredSkills: ids });
    }
  });

  it("composes every declared package and mandatory elegance exactly once", () => {
    for (const [name, ids] of Object.entries(REQUIRED_SKILLS)) {
      const composed = renderSkillClosure(persona(name).requiredSkills, revision, `Persona "${name}"`, () => true);
      for (const id of ids) {
        expect(renderedSkillCount(composed, id), `${name}: ${id}`).toBe(1);
      }
      if (name.startsWith("reviewer-code-") || name.startsWith("reviewer-plan-")) {
        expect(renderedSkillCount(composed, "elegance-review-principles"), name).toBe(1);
      }
    }
  });

  it("renders only the additive principles selected by a persona", () => {
    const cases = [
      { name: "reviewer-code-quality", target: "code-review-method", additive: [] },
      { name: "reviewer-plan-security", target: "plan-review", additive: ["security-review-principles"] },
      { name: "reviewer-code-design", target: "code-review-method", additive: ["interface-design"] },
      { name: "reviewer-plan-design", target: "plan-review", additive: ["interface-design"] },
    ];
    const additiveIds = ["performance-review-principles", "data-integrity-review-principles", "security-review-principles", "interface-design"];

    for (const item of cases) {
      const rendered = renderSkillClosure(persona(item.name).requiredSkills, revision, `Persona ${item.name}`, () => true);
      expect(renderedSkillCount(rendered, item.target), item.name).toBe(1);
      expect(renderedSkillCount(rendered, "elegance-review-principles"), item.name).toBe(1);
      expect(renderedSkillCount(rendered, item.target === "code-review-method" ? "plan-review" : "code-review-method"), item.name).toBe(0);
      for (const principle of additiveIds) expect(renderedSkillCount(rendered, principle), `${item.name}: ${principle}`).toBe(item.additive.includes(principle) ? 1 : 0);
    }
  });

  it("carries no package body and no manual load of a declared method", () => {
    for (const [name, definition] of personas) {
      if (definition.kind !== "persona") continue;
      for (const skill of bundled.values()) {
        expect(definition.systemPrompt).not.toContain(skill.body.slice(0, 200));
      }
      for (const id of definition.requiredSkills ?? []) {
        expect(definition.systemPrompt, `${name} loads ${id} manually`).not.toContain(`\`${id}\``);
      }
    }
  });

  it("keeps advisor and explorer dependency-free", () => {
    expect(persona("advisor").requiredSkills).toBeUndefined();
    expect(persona("explorer").requiredSkills).toBeUndefined();
  });

  it("keeps every declared package installed and hides the individual review ingredient", () => {
    const roster = new Set(revision.modelInvocable.map((skill) => skill.id));

    for (const ids of Object.values(REQUIRED_SKILLS)) {
      for (const id of ids) expect({ id, installed: bundled.has(id), loadable: roster.has(id) }).toEqual({ id, installed: true, loadable: id !== "code-review-method" });
    }
  });

  // Reviewers lead a structural Failure with a catalog name and synthesizers
  // route on it, so the catalog has one home that every review closure renders
  // exactly once.
  it("carries the structural-defect catalog once through every review closure", () => {
    const catalog = bundled.get("elegance-review-principles")?.body ?? "";
    const names = [
      "Single Source of Truth", "Depth over Indirection", "Narrow Interfaces, Deep Modules", "One-Direction Data Flow", "Dead Code Is Debt",
      "God Class", "Shallow Wrapper", "Forwarding Chain", "Parallel State", "Speculative Code", "Config Soup", "Stubborn Duplication",
      "Manual Sync", "Bidirectional Coupling", "Cascade Mutation", "Leaky Event",
      "Premature Abstraction", "Leaky Interface", "Comments-as-Apology", "Indirection Tax", "Concrete Dependency",
    ];
    for (const name of names) {
      expect(catalog, name).toMatch(new RegExp(`^\\| \\*\\*${name}\\*\\* \\| [^|]+ \\| [^|]+ \\|$`, "m"));
    }

    const closures = [
      ["code-review", renderSkillClosure(["code-review"], revision, "code-review", () => true)],
      ...Object.keys(REQUIRED_SKILLS).filter((id) => id.startsWith("reviewer-code-") || id.startsWith("reviewer-plan-"))
        .map((name) => [name, renderSkillClosure(persona(name).requiredSkills, revision, name, () => true)] as const),
    ] as const;
    for (const [label, rendered] of closures) {
      expect(renderedSkillCount(rendered, "elegance-review-principles"), label).toBe(1);
      const text = rendered.join("\n");
      for (const name of names) expect(text.split(`**${name}**`).length - 1, `${label}: ${name}`).toBe(1);
    }
  });

  it("never gives individual code reviewers parent dispatch or fix instructions", () => {
    for (const name of Object.keys(REQUIRED_SKILLS).filter((id) => id.startsWith("reviewer-code-"))) {
      const rendered = renderSkillClosure(persona(name).requiredSkills, revision, name, () => true);
      expect(renderedSkillCount(rendered, "code-review")).toBe(0);
      expect(rendered.join("\n")).toContain("Do not dispatch reviewers");
      expect(rendered.join("\n")).not.toContain("## Select the reviewer set");
      expect(rendered.join("\n")).not.toContain("resume that task after the review result");
    }
  });
});

describe("retired review package IDs", () => {
  it("has no package or dependency consumer for superseded IDs", () => {
    const retired = ["data-integrity-review", "performance-review", "security-review"];
    for (const id of retired) {
      expect(bundled.has(id), id).toBe(false);
      expect([...bundled.values()].some((skill) => skill.dependencies.includes(id)), id).toBe(false);
    }
  });
});

describe("always-on kernel", () => {
  const agentsMd = readFileSync(join(REPO_ROOT, "AGENTS.md"), "utf-8");

  it("routes every canonical package instead of restating it", () => {
    for (const id of METHOD_IDS) expect(agentsMd).toContain(id);
  });

  // The kernel is what every agent carries whether or not it loads a package:
  // safety, evidence, secrets, persistence and tool boundaries, verification.
  it("keeps the universal invariants", () => {
    for (const invariant of [
      "Redacted",
      "bun run test",
      "bun run lint",
      "check:boundaries",
      ".flywheel/flywheel.sqlite",
      "infra <- protocol <- workflows <- orchestration <- tui",
    ]) {
      expect(agentsMd).toContain(invariant);
    }
  });

  it("carries no package body", () => {
    for (const migrated of [
      "createStore",
      "createMemo",
      "Deferred",
      "StyledText",
      "Bun.spawn",
      "tmux",
      "RED",
    ]) {
      expect(agentsMd).not.toContain(migrated);
    }
  });
});
