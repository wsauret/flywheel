import { describe, expect, it } from "bun:test"
import { renderCapabilityText } from "../../../../../src/infra/capability-text.js"
import type { AgentDefinition } from "../../../../../src/infra/agent-definition.js"
import type { ToolAction } from "../../../../../src/infra/workflow-types.js"
import type { RuntimeTool } from "../../../../../src/orchestration/agent-runtime/tools/types.js"
import { launchingSessionAuthority } from "../../../../../src/orchestration/modules/workflows.js"
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { ToolActionSchema } from "../../../../../src/infra/workflow-types.js"
import { definitionAvailabilityOf } from "../../../../../src/orchestration/app-service/definition-availability.js"
import { composeFirstPartyModules } from "../../../../../src/orchestration/modules.js"
import { loadPathWorkflow, sessionWorkflowsDir } from "../../../../../src/orchestration/workflow-host/path-workflow.js"
import { temporaryDirectories } from "../../../../helpers/directories.js"
import { repoDefinitions } from "../../../../helpers/project-definitions.js"

const temporary = temporaryDirectories()

function persona(name: string): AgentDefinition {
  return { kind: "persona", name, description: `${name}.`, systemPrompt: "Work.", tools: ["read"], role: name, maxTurns: 5 }
}

const personas = new Map([["reviewer", persona("reviewer")], ["planner", persona("planner")]])

const OFF = "agent type reviewer is turned off. Remove it from subagents.disabled_types in flywheel.toml to turn it on"

/** The persona entries of a definition availability under which every persona is available, except the ones
 *  `off` names, each with the owner's reason sentence. */
function availability(off: readonly string[] = []) {
  return {
    personas: new Map([...personas.keys()].map((name) => [name, off.includes(name)
      ? { id: name, requires: [], types: [name], missing: [], off: [name], available: false, modelInvocable: false, reason: OFF }
      : { id: name, requires: [], types: [name], missing: [], off: [], available: true, modelInvocable: true }])),
  }
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
    mkdirSync(sessionWorkflowsDir(sessionDir), { recursive: true })
    const file = join(sessionWorkflowsDir(sessionDir), "lens-review.workflow.yaml")
    // The example as an agent with every agent type on reads it: with a lens reviewer off, it is not offered at all.
    writeFileSync(file, renderCapabilityText(readFileSync(join(import.meta.dir, "../../../../../src/orchestration/modules/workflows/definitions/skills/workflow-authoring/examples/lens-review.workflow.yaml"), "utf8"), () => true))
    const installed = repoDefinitions().captureRevision()
    const planned = new Map(ToolActionSchema.literals.map((action) => [action, tool(action, action)] as const))
    const launch = (disabledTypes: readonly string[]) => loadPathWorkflow({
      path: file, sessionDir, revision: installed,
      authority: launchingSessionAuthority(planned, { personas: installed.personas }, definitionAvailabilityOf(installed, composeFirstPartyModules().enabledModuleIds, disabledTypes)),
    })

    const refused = await launch(["reviewer"])
    if (refused.ok) throw new Error("the example launched with the reviewer type off")
    expect((refused.diagnostics ?? []).map((diagnostic) => diagnostic.message)).toEqual(["reviewer-code-security", "reviewer-code-performance", "reviewer-code-elegance"].map((name) =>
      `runs as persona ${name}, which the launching session cannot dispatch: ${OFF}`))
    expect((await launch(["advisor"])).ok).toBe(true)
  })
})
