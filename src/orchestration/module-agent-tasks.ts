import type { AgentDefinition } from "../infra/agent-definition.js"
import type { RuntimeEvent } from "../infra/runtime-event-types.js"
import type { HandoffToolSchema } from "./workflow-host/handoff-tool-schema.js"
import type { RuntimeTool } from "./agent-runtime/tools/types.js"
import type { FirstPartyModuleComposition } from "./modules.js"

interface DispatchInput { readonly [key: string]: unknown }

/** A module's production task dialect, validation, and completed-text observer. */
export interface ModuleAgentTasks {
  readonly toolId: string
  readonly handoffSchema: HandoffToolSchema
  /** The session-tier roster section that names the agent types a dispatcher may use. */
  roster(agents: ReadonlyMap<string, AgentDefinition>): string
  /** The dispatch tool exactly as the model sees it, with `execute` in place of
   *  a real dispatch. It needs no session, so a stateless caller can offer it. */
  tool(execute: RuntimeTool["execute"]): RuntimeTool
  task(instructions: string, toolNames: readonly string[], maxTurns: number): string
  validate(input: DispatchInput, agents: ReadonlyMap<string, AgentDefinition>): { readonly ok: true; readonly agentType: string } | { readonly ok: false }
  observe(agentType: string): { readonly onEvent: (event: RuntimeEvent) => void; readonly finalAssistantText: () => string }
}

/** Resolve the selected task provider. Missing support grants no dispatch. */
export function agentTasksFromComposition(composition: FirstPartyModuleComposition): ModuleAgentTasks | undefined {
  const providers = composition.contributions.flatMap((contribution) => contribution.domain === "agentTasks" ? [contribution.value] : [])
  if (providers.length > 1) throw new Error("Multiple modules provide agent task execution")
  return providers[0]
}
