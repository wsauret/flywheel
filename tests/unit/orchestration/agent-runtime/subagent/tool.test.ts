import { beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as os from "node:os";

import { createSubagentDispatch } from "../../../../../src/orchestration/modules/subagents/execution/tool.js";
import { createProjectDefinitionRegistry, type ProjectDefinitionRegistry } from "../../../../../src/workflows/definition-registry.js";
import { renderSkillContext } from "../../../../../src/workflows/skill-context.js";
import type { AgentDefinition } from "../../../../../src/infra/agent-definition.js";
import { buildRegistry, makeContext, makeDeps, makeMockRunnerFactory, TEST_RATIONALE, childTask } from "./_fixtures.js";
import { fileTemporaryDirectory, testDirectories } from "../../../../helpers/directories.js";

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
});
