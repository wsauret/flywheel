import { beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getPersonaMetadataIndex } from "../../../src/workflows/agents/agent-roles.js";
import { assembleSkillInvocation } from "../../../src/workflows/skill-invocation.js";
import { assembleAgentPrompt } from "../../../src/workflows/context-bundle/prompt-assembly.js";
import { createProjectDefinitionRegistry, type ProjectDefinitionRegistry } from "../../../src/workflows/definition-registry.js";
import { hashContent } from "../../../src/workflows/definition-hash.js";
import { renderSkillClosure, renderSkillContext } from "../../../src/workflows/skill-context.js";
import type { SkillDefinition } from "../../../src/workflows/skill-schema.js";
import type { AgentDefinition } from "../../../src/infra/agent-definition.js";
import type { AttemptRow } from "../../../src/workflows/view/types.js";
import type { ResolvedAgent } from "../../../src/workflows/agent-resolution.js";
import { resolveWorkflowAgents } from "../../../src/workflows/agent-resolution.js";
import { buildDefinitionIdentity, definitionIdentityMismatches } from "../../../src/workflows/vm/definition-identity.js";
import type { WorkflowDefinition } from "../../../src/workflows/workflow-schema.js";
import { createSkillTool } from "../../../src/orchestration/agent-runtime/tools/skill.js";
import type { ToolContext } from "../../../src/orchestration/agent-runtime/tools/types.js";
import { fileTemporaryDirectory, testDirectories } from "../../helpers/directories.js";

// The fixture packages are installed under temp roots this suite's own
// definition owner reads, so the assertions never depend on what the developer
// has installed.
const ROOT = fileTemporaryDirectory("flywheel-skill-composition-test-");
// A second root that outranks ROOT, so one id can be installed twice and the
// precedence winner observed.
const PREFERRED_ROOT = fileTemporaryDirectory("flywheel-skill-composition-test-preferred-");
// A project root with no definition overlay under it.
const PROJECT_ROOT = fileTemporaryDirectory("flywheel-skill-composition-test-project-");
const personaIndex = getPersonaMetadataIndex();

let registry: ProjectDefinitionRegistry | undefined;

function owner(): ProjectDefinitionRegistry {
  registry ??= createProjectDefinitionRegistry({ bundles: [],
    ...testDirectories(PROJECT_ROOT),
    skillRoots: [PREFERRED_ROOT, ROOT].map((dir) => ({ dir, owned: true, reach: "global" as const })),
  });
  return registry;
}

function installSkill(id: string, body: string, options: { frontmatter?: string; root?: string } = {}): void {
  const dir = join(options.root ?? ROOT, id);
  mkdirSync(dir, { recursive: true });
  const frontmatter = `description: Use when the task is about ${id}.${options.frontmatter ? `\n${options.frontmatter}` : ""}`;
  writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}`);
}

function installed(id: string): SkillDefinition {
  const skill = owner().skills().skills.get(id);
  if (!skill) throw new Error(`fixture skill not installed: ${id}`);
  return skill;
}

beforeAll(() => {
  installSkill("alpha", "Alpha procedure.");
  installSkill("beta", "Beta procedure.");
  installSkill("fixture", "Do the fixture work.", { frontmatter: "dependencies:\n  - alpha" });
  installSkill("agented", "Audit through the persona roster.", { frontmatter: "agents:\n  - auditor" });
  owner();
});

/** The workflow every case below compiles: one inline step that composes the
 *  fixture package, which declares `alpha` as its dependency. */
const WORKFLOW: WorkflowDefinition = {
  id: "wf",
  name: "Workflow",
  phases: [{ phase: "fixture", brief: "Do the step work.", name: "fixture", dependencies: ["fixture"], writes: [] }, { phase: "solo", brief: "Do the solo work.", name: "solo", writes: [] }],
};

function bound(workflow: WorkflowDefinition, stepId: string): ResolvedAgent {
  const step = resolveWorkflowAgents(workflow).get(stepId);
  if (!step) throw new Error(`fixture step not resolved: ${stepId}`);
  return step;
}

function boundFixture(): ResolvedAgent {
  return bound(WORKFLOW, "fixture");
}

function fixtureStep(): AttemptRow {
  return {
    id: "s1",
    definitionId: "fixture",
    briefId: "fixture",
    workflowDefinitionId: "wf",
    name: "Fixture Step",
    description: "",
    status: "running",
    writes: [],
    resumeRevertCount: 0,
  };
}

describe("canonical skill context", () => {
  it("is the exact text the model's skill tool loads", async () => {
    const revision = owner().skills();
    const tool = createSkillTool({ treeCapabilities: () => true, availability: { skills: new Map() }, revision, personaIndex });

    const context: ToolContext = { ...testDirectories(PROJECT_ROOT), artifactScopeId: "skill-composition", retrievalSessionId: "skill-composition", capabilities: () => true };
    const loaded = await tool.execute({ action: "load", skill_id: "alpha" }, context);

    expect(loaded.content).toBe(renderSkillContext(installed("alpha")));
  });

  it("composes declared packages in declaration order, never sorted", () => {
    const revision = owner().skills();

    expect(renderSkillClosure(["beta", "alpha"], revision, 'Skill "consumer"', () => true).slice(1)).toEqual([
      renderSkillContext(installed("beta")),
      renderSkillContext(installed("alpha")),
    ]);
    expect(renderSkillClosure(undefined, revision, 'Skill "consumer"', () => true)).toEqual([]);
  });

  it("tells the reader that every composed package is already in its context", () => {
    // A step or persona whose instructions name a composed package must not
    // try to load it: a dependency-only package is not loadable, and the
    // refused load shows the person an error row in a normal run.
    const [preface] = renderSkillClosure(["beta", "alpha"], owner().skills(), 'Skill "consumer"', () => true);

    expect(preface).toContain("`beta`, `alpha`");
    expect(preface).toContain("Do not load them.");
  });

  it("refuses to compose a package that is not installed", () => {
    expect(() => renderSkillClosure(["gone"], owner().skills(), 'Skill "consumer"', () => true))
      .toThrow('Skill "consumer" requires skill "gone", which is not installed');
  });
});

describe("worker prompt composition", () => {
  it("puts dependency context ahead of the step's own instructions", () => {
    const step = fixtureStep();

    const { task } = assembleAgentPrompt({
      capabilities: () => true,
      attempt: step,
      agent: boundFixture(),
      contextBundle: "",
      skills: owner().skills(),
    });

    expect(task.indexOf("Alpha procedure."))
      .toBeLessThan(task.indexOf("Do the step work."));
  });

  it("puts dependency context ahead of the directly invoked body", () => {
    const prompt = assembleSkillInvocation(installed("fixture"), undefined, { skills: owner().skills(), personaIndex, capabilities: () => true });

    expect(prompt).toContain(renderSkillContext(installed("alpha")));
    expect(prompt.indexOf("Alpha procedure.")).toBeLessThan(prompt.indexOf("Do the fixture work."));
  });

  it("leaves a step that declares no dependencies untouched", () => {
    const { task } = assembleAgentPrompt({
      capabilities: () => true,
      attempt: fixtureStep(),
      agent: bound(WORKFLOW, "solo"),
      contextBundle: "",
      skills: owner().skills(),
    });

    expect(task.startsWith("Do the solo work.")).toBe(true);
  });
});

describe("definition identity", () => {
  const workflow = WORKFLOW;
  /** Read per call: the drift cases below compose against the revision the
   *  latest reload published. */
  const identityOptions = () => ({ skills: owner().skills() });
  const bindings = () => resolveWorkflowAgents(workflow);

  /** Identity pins the composed context, so the expectation is derived from the
   *  same text the prompt receives. */
  function renderedHash(id: string): string {
    return hashContent(renderSkillContext(installed(id))).sha256;
  }

  function skillDrift(recorded: ReturnType<typeof buildDefinitionIdentity>): readonly unknown[] {
    return definitionIdentityMismatches(recorded, buildDefinitionIdentity(workflow, bindings(), identityOptions()));
  }

  it("pins the rendered context of every package the step composes, with its dependencies", () => {
    const identity = buildDefinitionIdentity(workflow, bindings(), identityOptions());

    expect(identity.skills).toEqual([
      { skillId: "alpha", sha256: renderedHash("alpha") },
      { skillId: "fixture", sha256: renderedHash("fixture") },
    ]);
    expect(identity.skills[0]?.sha256).not.toBe(installed("alpha").evidence.sha256);
  });

  it("reports an edited skill body as drift, not as a silently different procedure", () => {
    const recorded = buildDefinitionIdentity(workflow, bindings(), identityOptions());

    installSkill("alpha", "Alpha procedure, revised.");
    owner().reload();

    expect(skillDrift(recorded)).toEqual([{
      component: "skill",
      skillId: "alpha",
      recorded: recorded.skills[0]?.sha256 ?? "",
      current: renderedHash("alpha"),
    }]);
  });

  it("reports a metadata-only edit as drift, because the composed header changed", () => {
    const recorded = buildDefinitionIdentity(workflow, bindings(), identityOptions());
    const body = installed("alpha").evidence.sha256;

    installSkill("alpha", "Alpha procedure, revised.", { frontmatter: "version: 2" });
    owner().reload();

    expect(installed("alpha").evidence.sha256).toBe(body);
    expect(skillDrift(recorded)).toEqual([{
      component: "skill",
      skillId: "alpha",
      recorded: recorded.skills[0]?.sha256 ?? "",
      current: renderedHash("alpha"),
    }]);
  });

  it("reports a changed resource list as drift, because the header advertises it", () => {
    const recorded = buildDefinitionIdentity(workflow, bindings(), identityOptions());
    const body = installed("alpha").evidence.sha256;

    mkdirSync(join(ROOT, "alpha", "references"), { recursive: true });
    writeFileSync(join(ROOT, "alpha", "references", "api.md"), "Reference.");
    owner().reload();

    expect(installed("alpha").evidence.sha256).toBe(body);
    expect(installed("alpha").resources.map(({ path }) => path)).toEqual(["references/api.md"]);
    expect(skillDrift(recorded)).toEqual([{
      component: "skill",
      skillId: "alpha",
      recorded: recorded.skills[0]?.sha256 ?? "",
      current: renderedHash("alpha"),
    }]);
  });

  it("reports a higher-precedence install of the same body as drift", () => {
    const recorded = buildDefinitionIdentity(workflow, bindings(), identityOptions());
    const body = installed("alpha").body;

    installSkill("alpha", body, { root: PREFERRED_ROOT });
    owner().reload();

    expect(installed("alpha").body).toBe(body);
    expect(installed("alpha").shadowed).toBeDefined();
    expect(skillDrift(recorded)).toEqual([{
      component: "skill",
      skillId: "alpha",
      recorded: recorded.skills[0]?.sha256 ?? "",
      current: renderedHash("alpha"),
    }]);
  });
});

describe("definition identity for personas a step can dispatch", () => {
  const workflow: WorkflowDefinition = {
    id: "wf-personas",
    name: "Workflow",
    phases: [{ phase: "agented", brief: "Do the agented work.", name: "agented", dependencies: ["agented"], subagents: ["auditor"], writes: [] }],
  };
  const auditor: AgentDefinition = {
    kind: "persona",
    name: "auditor",
    description: "Audits a diff.",
    role: "reviewer",
    tools: ["read"],
    maxTurns: 10,
    systemPrompt: "Audit the diff.",
    requiredSkills: ["beta"],
  };
  const identityOptions = () => ({ skills: owner().skills(), personas: new Map([[auditor.name, auditor]]) });
  const bindings = () => resolveWorkflowAgents(workflow);

  function renderedHash(id: string): string {
    return hashContent(renderSkillContext(installed(id))).sha256;
  }

  it("pins the rendered context of every skill a dispatchable persona requires", () => {
    const identity = buildDefinitionIdentity(workflow, bindings(), identityOptions());

    expect(identity.skills).toEqual([
      { skillId: "agented", sha256: renderedHash("agented") },
      { skillId: "beta", sha256: renderedHash("beta") },
    ]);
  });

  it("reports an edited persona package as drift, so a resumed dispatch cannot change the persona's context", () => {
    const recorded = buildDefinitionIdentity(workflow, bindings(), identityOptions());
    const recordedBeta = recorded.skills.find(({ skillId }) => skillId === "beta")?.sha256 ?? "";

    installSkill("beta", "Beta procedure, revised.");
    owner().reload();

    expect(definitionIdentityMismatches(recorded, buildDefinitionIdentity(workflow, bindings(), identityOptions()))).toEqual([{
      component: "skill",
      skillId: "beta",
      recorded: recordedBeta,
      current: renderedHash("beta"),
    }]);
  });
});