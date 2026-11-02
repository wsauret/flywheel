import { describe, expect, it } from "bun:test"
import type { AgentDefinition } from "../../../../../src/infra/agent-definition.js"
import type { ToolAction } from "../../../../../src/infra/workflow-types.js"
import type { RuntimeTool } from "../../../../../src/orchestration/agent-runtime/tools/types.js"
import { launchingSessionAuthority } from "../../../../../src/orchestration/modules/workflows.js"

function persona(name: string): AgentDefinition {
  return { kind: "persona", name, description: `${name}.`, systemPrompt: "Work.", tools: ["read"], role: name, maxTurns: 5 }
}

const personas = new Map([["reviewer", persona("reviewer")], ["planner", persona("planner")]])

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
    const authority = launchingSessionAuthority(new Map([["read", tool("read", "file_read")], ["bash", tool("bash", "shell_exec")]]), { personas })

    expect([...authority.toolActions].sort()).toEqual(["file_read", "shell_exec"])
    expect([...authority.personas]).toEqual([])
  })

  it("holds every persona the subagent tool can dispatch, within the session's allowed subagent types", () => {
    const planned = new Map([["subagent", tool("subagent", "task_subagent")]])

    expect([...launchingSessionAuthority(planned, { personas }).personas].sort()).toEqual(["planner", "reviewer"])
    expect([...launchingSessionAuthority(planned, { personas, allowedSubagentTypes: new Set(["reviewer"]) }).personas]).toEqual(["reviewer"])
  })
})
