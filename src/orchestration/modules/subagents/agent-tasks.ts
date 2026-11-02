import type { ModuleAgentTasks } from "../../module-agent-tasks.js"
import { renderSubagentRoster, buildSubagentTask, SUBAGENT_HANDOFF_SCHEMA, validateDispatchInput } from "./execution/prompts.js"
import { createFilteredSubagentStream, createSubagentStats } from "./execution/stream-filter.js"
import { subagentToolWith } from "./tool.js"

export const subagentTasks: ModuleAgentTasks = {
  toolId: "subagent",
  handoffSchema: SUBAGENT_HANDOFF_SCHEMA,
  roster: renderSubagentRoster,
  tool: (execute) => subagentToolWith(execute),
  task: buildSubagentTask,
  validate: (input, agents) => {
    const result = validateDispatchInput(input, agents)
    return result.ok ? { ok: true, agentType: result.dispatch.agentType } : { ok: false }
  },
  observe: (agentType) => {
    const textState = { finalAssistantText: "" }
    const onEvent = createFilteredSubagentStream({ agentType, stats: createSubagentStats(), textState, onRenderEvent: () => {} })
    return { onEvent, finalAssistantText: () => textState.finalAssistantText }
  },
}
