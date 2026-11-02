import { beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createMemoryTool } from "../../../../../src/orchestration/modules/learning/tools/memory.js";
import { createSkillManageTool } from "../../../../../src/orchestration/modules/learning/tools/skill-manage.js";
import type { ToolContext } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import { publishSkillRevision } from "../../../../../src/workflows/skill-schema.js";
import { loadSkillDefinitions, ownedSkillStoreDirs } from "../../../../../src/workflows/skills.js";
import { fileTemporaryDirectory } from "../../../../helpers/directories.js";
import { createRecordingFileMutationStore, makeContext } from "./_fixtures.js";

// A runner whose tools execute outside the project it owns state for: the
// execution directory and the project directory are two different places, and
// only the project directory may receive a durable learning write.
const TMP = fileTemporaryDirectory("flywheel-durable-writes-project-root-test-");
const PROJECT = join(TMP, "project");
const EXECUTION = join(TMP, "elsewhere");
const HOME = join(TMP, "home");
// The directory authorities of this test's project and account state (ARCH-DIRECTORIES-001).
const DIRS = { projectRoot: PROJECT, accountHome: HOME, userDataRoot: join(HOME, ".flywheel") };

/** A recording runtime: a memory write reports success only once its audit fact
 *  is recorded, so the context carries an accepting writer. */
function context(): ToolContext {
  return makeContext({
    executionCwd: EXECUTION,
    projectRoot: PROJECT,
    userDataRoot: DIRS.userDataRoot,
    sessionId: "conv-1",
    sessionEventWriter: createRecordingFileMutationStore().writer,
  });
}

function skillRegistry() {
  const dirs = ownedSkillStoreDirs(DIRS);
  const load = loadSkillDefinitions({
    roots: [
      { authority: "external", dir: dirs.project, reach: "project" },
      { authority: "external", dir: dirs.user, reach: "global" },
    ],
  });
  return publishSkillRevision(1, load.skills);
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(PROJECT, { recursive: true });
  mkdirSync(EXECUTION, { recursive: true });
  mkdirSync(HOME, { recursive: true });
});

describe("durable learning writes follow projectRoot, not executionCwd", () => {
  it("writes project memory into the project directory only", async () => {
    const tool = createMemoryTool({ accountHome: HOME, sessionId: "sess-1" });

    const result = await tool.execute(
      { title: "Bun is the runtime", action: "add", content: "Bun is the runtime, never Node." },
      context(),
    );

    expect(result.outcome).toBe("ok");
    const stored = readFileSync(join(PROJECT, ".flywheel", "memory", "MEMORY.json"), "utf8");
    expect(stored).toContain("Bun is the runtime, never Node.");
    expect(existsSync(join(EXECUTION, ".flywheel"))).toBe(false);
  });

  it("writes a project skill package into the project store only", async () => {
    const tool = createSkillManageTool({
      origin: { kind: "agent", sessionId: "sess-1" },
      registry: skillRegistry,
      userDataRoot: DIRS.userDataRoot,
    });

    const result = await tool.execute({
      action: "save",
      name: "provider-quirks",
      description: "Use when handling provider quirks.",
      body: "# Quirks\n\nHandle them.",
      reach: "project",
    }, context());

    expect(result.outcome).toBe("ok");
    expect(existsSync(join(PROJECT, ".flywheel", "skills", "provider-quirks", "SKILL.md"))).toBe(true);
    expect(existsSync(join(EXECUTION, ".flywheel"))).toBe(false);
  });
});
