import { afterAll, describe, expect, it } from "bun:test"
import { renderCapabilityText } from "../../../../../src/infra/capability-text.js"
import type { AgentDefinition } from "../../../../../src/infra/agent-definition.js"
import type { ToolAction } from "../../../../../src/infra/workflow-types.js"
import type { RuntimeTool } from "../../../../../src/orchestration/agent-runtime/tools/types.js"
import { workflowsModule } from "../../../../../src/orchestration/modules/workflows.js"
import { readFileSync, realpathSync } from "node:fs"
import { join } from "node:path"
import { ToolActionSchema } from "../../../../../src/infra/workflow-types.js"
import { definitionAvailabilityOf, type DefinitionAvailabilitySnapshot } from "../../../../../src/orchestration/config/policy/definition-availability.js"
import { createBackgroundExecutionOwner } from "../../../../../src/orchestration/agent-runtime/background-execution/background-execution-owner.js"
import { createBackgroundWorkRegistry } from "../../../../../src/orchestration/session/control/background-work/background-work.js"
import type { ModuleRuntimeServices } from "../../../../../src/orchestration/agent-runtime/request/module-services/module-runtime-services.js"
import { composeFirstPartyModules } from "../../../../../src/orchestration/module-contract/module-composition.js"
import { loadPathWorkflow } from "../../../../../src/orchestration/workflow-host/lifecycle/path-workflow.js"
import { temporaryDirectories } from "../../../../helpers/directories.js"
import { fixedAvailability, repoDefinitions } from "../../../../helpers/project-definitions.js"
import { moduleRuntimeServices } from "../../../../helpers/module-runtime-services.js"
import { stagedWorkflowContent } from "../../../../helpers/workflow-files.js"

const temporary = temporaryDirectories()

function persona(name: string): AgentDefinition {
  return { kind: "persona", name, description: `${name}.`, systemPrompt: "Work.", tools: ["read"], role: name, maxTurns: 5 }
}

const personas = new Map([["reviewer", persona("reviewer")], ["planner", persona("planner")]])

const OFF = "agent type reviewer is turned off. Remove it from subagents.disabled_types in flywheel.toml to turn it on"

/** The definition availability of {@link personas} with the agent types that `off` names turned off. */
function availability(off: readonly string[] = []): DefinitionAvailabilitySnapshot {
  return fixedAvailability({ personas }, undefined, off)
}

const background = createBackgroundExecutionOwner(createBackgroundWorkRegistry({ kind: "chat", enqueueNotification: () => {} }))
afterAll(() => background.close())

/** The authority the workflows runtime of one runner grants under `planned` and `snapshot`. */
function launchingSessionAuthority(planned: ReadonlyMap<string, RuntimeTool>, services: Pick<ModuleRuntimeServices, "allowedSubagentTypes" | "personas">, snapshot: DefinitionAvailabilitySnapshot) {
  const runtime = workflowsModule.runtime.create(moduleRuntimeServices({
    ...services,
    background,
    startWorkflow: async () => { throw new Error("this test launches no workflow") },
  }))
  if (!runtime) throw new Error("the workflows runtime needs a workflow starter and a background owner")
  return runtime.authority(planned, snapshot)
}

function tool(name: string, action: ToolAction): RuntimeTool {
  return {
    name,
    action,
    description: name,
    inputSchema: { type: "object" },
    isConcurrencySafe: true,
    execute: async () => ({ content: "", outcome: "ok" }),
  }
}

describe("the authority a launching session grants a workflow file", () => {
  it("holds the actions of the planned tools, and no persona without the subagent tool", () => {
    const authority = launchingSessionAuthority(new Map([["read", tool("read", "file_read")], ["bash", tool("bash", "shell_exec")]]), { personas }, availability())

    expect([...authority.toolActions].sort()).toEqual(["file_read", "shell_exec"])
    expect([...authority.personas]).toEqual([])
  })

  it("holds every persona the subagent tool can dispatch, within the session's allowed subagent types", () => {
    const planned = new Map([["subagent", tool("subagent", "task_subagent")]])

    expect([...launchingSessionAuthority(planned, { personas }, availability()).personas].sort()).toEqual(["planner", "reviewer"])
    expect([...launchingSessionAuthority(planned, { personas, allowedSubagentTypes: new Set(["reviewer"]) }, availability()).personas]).toEqual(["reviewer"])
  })

  it("holds no persona whose agent type is off, and keeps the reason it cannot run", () => {
    const authority = launchingSessionAuthority(new Map([["subagent", tool("subagent", "task_subagent")]]), { personas }, availability(["reviewer"]))

    expect([...authority.personas]).toEqual(["planner"])
    expect([...authority.unavailable]).toEqual([["reviewer", OFF]])
  })

  it("refuses the bundled reviewer example while the reviewer type is off, says how to turn it on, and launches it with the type on", async () => {
    const sessionDir = realpathSync(temporary("flywheel-launch-authority-"))
    // The example as an agent with every agent type on reads it: with a lens reviewer off, it is not offered at all.
    const staged = stagedWorkflowContent(sessionDir, renderCapabilityText(readFileSync(join(import.meta.dir, "../../../../../src/orchestration/modules/workflows/definitions/skills/workflow-authoring/examples/lens-review.workflow.yaml"), "utf8"), () => true))
    const installed = repoDefinitions().captureRevision()
    const planned = new Map(ToolActionSchema.literals.map((action) => [action, tool(action, action)] as const))
    const launch = (disabledTypes: readonly string[]) => loadPathWorkflow({
      ...staged, sessionDir, revision: installed,
      authority: launchingSessionAuthority(planned, { personas: installed.personas }, definitionAvailabilityOf(installed, composeFirstPartyModules().enabledModuleIds, disabledTypes)),
    })

    const refused = await launch(["reviewer"])
    if (refused.ok) throw new Error("the example launched with the reviewer type off")
    expect((refused.diagnostics ?? []).map((diagnostic) => diagnostic.message)).toEqual(["reviewer-code-security", "reviewer-code-performance", "reviewer-code-elegance"].map((name) =>
      `runs as persona ${name}, which the launching session cannot dispatch: ${OFF}`))
    expect((await launch(["advisor"])).ok).toBe(true)
  })
})
