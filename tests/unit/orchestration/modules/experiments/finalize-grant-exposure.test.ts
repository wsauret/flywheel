import { describe, expect, test } from "bun:test"
import { composeModuleRuntimes } from "../../../../../src/infra/module-runtime.js"
import { createBackgroundWorkRegistry } from "../../../../../src/orchestration/agent-runtime/background-work.js"
import type { ExternalSkillChildGrant } from "../../../../../src/orchestration/agent-runtime/tools/skill.js"
import { planToolExposure } from "../../../../../src/orchestration/agent-runtime/tools/tool-exposure-planner.js"
import type { RuntimeTool } from "../../../../../src/orchestration/agent-runtime/tools/types.js"
import { createFinalizeChildGrant } from "../../../../../src/orchestration/modules/experiments/finalize-child-run.js"
import type { ExperimentsRuntime } from "../../../../../src/orchestration/modules/experiments/runtime.js"
import { testKernelToolDeps } from "../../../../helpers/request-tool-surface.js"
import { makeContext } from "../../agent-runtime/tools/_fixtures.js"
import type { SkillRegistryRevision } from "../../../../../src/workflows/skill-schema.js"
import { publishSkillRevision } from "../../../../../src/workflows/skill-schema.js"
import { BUNDLED_SKILL_DIR } from "../../../../../src/workflows/skill-source-inventory.js"
import { loadSkillDefinitions } from "../../../../../src/workflows/skills.js"
import { testDirectories } from "../../../../helpers/directories.js"

const SKILL_ROOTS = [{ authority: "bundled" as const, dir: BUNDLED_SKILL_DIR, reach: "global" as const, sourceKind: "agent" as const }]
const load = loadSkillDefinitions({ roots: SKILL_ROOTS })
const revision = publishSkillRevision(1, load.skills, load.bundledCorpus)
const { userDataRoot } = testDirectories(process.cwd())

const stubTool = (name: string): RuntimeTool => ({
  name,
  action: "ui_meta",
  description: name,
  inputSchema: { type: "object", properties: {} },
  isConcurrencySafe: true,
  execute: async () => ({ content: "", outcome: "ok" }),
})

/** The chat runner's experiments runtime as the skill tool reads it: the
 *  finalizer grant bound over whichever revision the planner admits. */
function chatExperimentsRuntime(seen: SkillRegistryRevision[]): Pick<ExperimentsRuntime, "tools" | "finalizeGrant" | "guard"> {
  return {
    tools: { initExperiment: stubTool("init_experiment"), runExperiment: stubTool("run_experiment"), logExperiment: stubTool("log_experiment") },
    finalizeGrant: (admitted) => {
      seen.push(admitted)
      return createFinalizeChildGrant({
        resolveSkill: (id) => admitted.skills.get(id),
        scratchDir: "/scratch/unused-scratch",
        workDir: "/scratch/unused-work",
        runOwnedCommand: async () => { throw new Error("not launched in this test") },
      })
    },
    guard: async () => undefined,
  }
}

const workflowGrant: ExternalSkillChildGrant = {
  skillIds: ["captured-external-skill"],
  run: async () => { throw new Error("not launched in this test") },
}

async function skillTool(surfaces: { experiments?: Pick<ExperimentsRuntime, "tools" | "finalizeGrant" | "guard">; externalSkillChildGrant?: ExternalSkillChildGrant }): Promise<RuntimeTool> {
  const plan = await planToolExposure({
    kernel: testKernelToolDeps({
      userDataRoot,
      capabilities: { available: () => true },
      backgroundTasks: createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} }),
      skills: revision,
      ...(surfaces.externalSkillChildGrant ? { externalSkillChildGrant: surfaces.externalSkillChildGrant } : {}),
    }),
    modules: composeModuleRuntimes(surfaces.experiments ? [["experiments", surfaces.experiments]] : []),
  })
  const skill = plan.tools.get("skill")
  if (!skill) throw new Error("skill tool was not exposed")
  return skill
}

async function childRun(tool: RuntimeTool, skillId: string): Promise<{ outcome: string; content: unknown }> {
  return tool.execute({ action: "child-run", skill_id: skillId, script: "finalize.sh", input: {} }, makeContext())
}

const advertised = (tool: RuntimeTool) => JSON.stringify({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })

describe("experiment finalizer child grant exposure", () => {
  test("every grant advertises the same skill tool, so agents of one tree share one agent host", async () => {
    const tools = await Promise.all([
      skillTool({}),
      skillTool({ experiments: chatExperimentsRuntime([]) }),
      skillTool({ experiments: chatExperimentsRuntime([]), externalSkillChildGrant: workflowGrant }),
    ])
    expect(new Set(tools.map(advertised)).size).toBe(1)
  })

  test("a chat runtime with the experiment surface grants experiment-finalize over the admitted revision", async () => {
    const seen: SkillRegistryRevision[] = []
    const refused = await childRun(await skillTool({ experiments: chatExperimentsRuntime(seen) }), "ship")
    expect(refused).toEqual({ outcome: "error", content: 'Child skill "ship" is not granted. Granted child skills: experiment-finalize.' })
    expect(seen).toEqual([revision])
  })

  test("a workflow attempt's captured grant wins over the experiment finalizer", async () => {
    const seen: SkillRegistryRevision[] = []
    const tool = await skillTool({ experiments: chatExperimentsRuntime(seen), externalSkillChildGrant: workflowGrant })
    expect(await childRun(tool, "experiment-finalize")).toEqual({ outcome: "error", content: 'Child skill "experiment-finalize" is not granted. Granted child skills: captured-external-skill.' })
    expect(await childRun(tool, "captured-external-skill")).toEqual({ outcome: "error", content: "not launched in this test" })
    expect(seen).toEqual([])
  })

  test("a runtime without the experiment surface refuses every child-run", async () => {
    expect(await childRun(await skillTool({}), "experiment-finalize")).toEqual({
      outcome: "error",
      content: 'action:"child-run" is unavailable to this agent now: no child skill is granted to it. Do not call it again.',
    })
  })
})
