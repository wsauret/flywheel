import { beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as os from "node:os";

import { createSubagentDispatch } from "../../../../../src/orchestration/modules/subagents/execution/tool.js";
import { createProjectDefinitionRegistry, type ProjectDefinitionRegistry } from "../../../../../src/workflows/definition-registry.js";
import { renderSkillContext } from "../../../../../src/workflows/skill-render.js";
import type { AgentDefinition } from "../../../../../src/infra/agent-definition.js";
import { capabilityAccessFor } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import { buildRegistry, grantOf, makeContext, makeDeps, makeMockRunnerFactory, TEST_RATIONALE, childTask } from "./_fixtures.js";
import { fileTemporaryDirectory, testDirectories } from "../../../../helpers/directories.js";
import { fixedAvailability } from "../../../../helpers/project-definitions.js";

// Fixture packages live under a temp root this suite's own definition owner
// reads, so the assertions never depend on what the developer has installed.
const ROOT = fileTemporaryDirectory("flywheel-subagent-skill-test-");
const PROJECT_ROOT = fileTemporaryDirectory("flywheel-subagent-skill-project-");

let definitions: ProjectDefinitionRegistry | undefined;

function owner(): ProjectDefinitionRegistry {
  definitions ??= createProjectDefinitionRegistry({ bundles: [],
    ...testDirectories(PROJECT_ROOT),
    skillRoots: [{ dir: ROOT, owned: true, reach: "global" }],
  });
  return definitions;
}

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(join(ROOT, "auditing"), { recursive: true });
  mkdirSync(PROJECT_ROOT, { recursive: true });
  writeFileSync(join(ROOT, "auditing", "SKILL.md"), "---\ndescription: Use when auditing.\n---\nAudit procedure.");
  owner();
});

function registryWith(requiredSkills: readonly string[]): Map<string, AgentDefinition> {
  const registry = buildRegistry();
  const explorer = registry.get("explorer");
  if (!explorer || explorer.kind !== "persona") throw new Error("explorer persona fixture missing");
  registry.set("explorer", { ...explorer, requiredSkills });
  return registry;
}

async function dispatchExplorer(
  registry: Map<string, AgentDefinition>,
  skills = owner().skills(),
): Promise<string> {
  const { factory, calls } = makeMockRunnerFactory({ finalText: "done" });
  const sessionDir = join(os.tmpdir(), `subagent-skill-${Date.now()}`);
  const tool = createSubagentDispatch(makeDeps({ agentRegistry: registry, sessionDir, createRunner: factory, skills }));

  await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "look" }, makeContext());

  rmSync(sessionDir, { recursive: true, force: true });
  const options = calls[0]?.options;
  if (options === undefined) throw new Error("runner was not constructed");
  return childTask(options);
}

describe("subagent tool - persona skill composition", () => {
  it("composes a persona's required skills ahead of its role instructions", async () => {
    const skill = owner().skills().skills.get("auditing");
    if (!skill) throw new Error("fixture skill not installed");

    const instructions = await dispatchExplorer(registryWith(["auditing"]));

    expect(instructions).toContain(renderSkillContext(skill));
    expect(instructions.indexOf("Audit procedure."))
      .toBeLessThan(instructions.indexOf("You are a focused codebase investigator."));
  });

  it("leaves a persona that declares no skills body-free", async () => {
    const instructions = await dispatchExplorer(buildRegistry());

    expect(instructions).not.toContain("Audit procedure.");
    expect(instructions).toContain("You are a focused codebase investigator.");
  });

  it("composes the revision pinned for the dispatch, not one published after it", async () => {
    const pinned = owner().skills();
    const skill = pinned.skills.get("auditing");
    if (!skill) throw new Error("fixture skill not installed");

    writeFileSync(join(ROOT, "auditing", "SKILL.md"), "---\ndescription: Use when auditing.\n---\nAudit procedure, revised.");
    owner().reload();

    const instructions = await dispatchExplorer(registryWith(["auditing"]), pinned);

    expect(instructions).toContain(renderSkillContext(skill));
    expect(instructions).not.toContain("Audit procedure, revised.");
  });

  // No person reads an unattended chat's tree, so a persona that composes a method that a person answers or approves
  // cannot run in it (PI-AGENT-121). A dispatcher that a person reads composes the method as usual.
  it("refuses a persona that composes an attended skill under an unattended dispatcher, and composes it under an interactive one", async () => {
    const registry = registryWith(["design"]);
    const design = owner().skills().skills.get("design");
    if (!design?.attended) throw new Error("the bundled design skill is not attended");
    const { factory, calls } = makeMockRunnerFactory({ finalText: "done" });
    const tool = createSubagentDispatch(makeDeps({ agentRegistry: registry, createRunner: factory, skills: owner().skills() }));
    const unattended = capabilityAccessFor({
      state: () => ({ moduleIds: [], capabilities: [], requireWorkflowConfirmation: true, workflowsMode: "off", identity: "test" }),
      admit: async () => { throw new Error("the dispatch grant covers the subagent tool"); },
    }, grantOf(["subagents"]), undefined, true);

    const refused = await tool.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "look" }, makeContext({ capabilityAccess: unattended }));

    expect(refused).toMatchObject({ outcome: "error", content: "Subagent 'explorer' cannot run here: its persona composes the skill \"design\", which a person answers or approves, and no person reads this run. Dispatch another agent type or do the work directly." });
    expect(calls).toEqual([]);
    expect(await dispatchExplorer(registry)).toContain("# Skill: design\n");
  });
});

describe("subagent tool - agent types turned off", () => {
  it("refuses a persona whose type is off with a reason that says how to turn it on, and runs it once the type is on", async () => {
    const registry = buildRegistry();
    const { factory, calls } = makeMockRunnerFactory({ finalText: "done" });
    const off = createSubagentDispatch(makeDeps({ agentRegistry: registry, createRunner: factory, definitionAvailability: fixedAvailability({ personas: registry }, undefined, ["explorer"]) }));

    const refused = await off.execute({ persona: "explorer", rationale: TEST_RATIONALE, prompt: "look" }, makeContext());

    expect(refused).toMatchObject({ outcome: "error", content: "Subagent 'explorer' cannot run: agent type explorer is turned off. Remove it from subagents.disabled_types in flywheel.toml to turn it on. Dispatch another agent type or do the work directly." });
    expect(calls).toEqual([]);
    expect(await dispatchExplorer(registry)).toContain("You are a focused codebase investigator.");
  });
});
