import type { AgentDefinition } from "../../infra/agent-definition.js"
import type { ResolvedAgent } from "../../workflows/agent-resolution.js"
import { personaInstructions } from "../../workflows/agents/persona-instructions.js"
import { grantedSubagentTypes, personaToolNames, workflowAgentSubagents } from "../../workflows/agents/subagent-reachability.js"
import type { SkillRegistryRevision } from "../../workflows/skill-schema.js"
import { gitDisciplineRule, isReadOnlyPersona } from "../agent-runtime/persona-tool-rules.js"

/** How an agent of a workflow whose record names a `persona` runs: as that
 *  persona runs when a subagent dispatch starts it ("persona" in docs/terminology.md).
 *  The persona's instructions open the agent's task, its tools are a grant
 *  on the full tool surface of an agent of a workflow, its turn limit
 *  bounds the agent's model calls, a persona that can change no file runs a
 *  read-only shell, and its role names the model seat. The system prompt
 *  and the tool surface stay those of every agent of a workflow, so the
 *  agent shares the prompt-cache prefix of its sibling agents. */
export interface AgentPersonaRun {
  /** The persona's role, which names its model seat. */
  readonly role: string
  /** The tools the agent may call: the persona's own, the handoff tool, the
   *  dispatch tools when the agent or the persona grants subagents, and the
   *  session message tool when the host has session messaging. */
  readonly toolGrant: readonly string[]
  /** The personas the agent may dispatch: its brief's, the trial advisor
   *  default (refer to `workflowAgentSubagents`), and the persona's. */
  readonly allowedSubagentTypes: ReadonlySet<string>
  readonly maxTurns: number
  /** Whether the agent's shell refuses a command that writes a project
   *  file, as a dispatch of the persona's shell does. */
  readonly readOnly: boolean
  /** The persona's instructions and its git discipline, as a dispatch of
   *  the persona states them, which open the task. The tools it may call
   *  follow in its opening turn from its first tool plan (`tool-notice.ts`). */
  readonly instructions: string
}

/** The persona run of one agent, or undefined when its record names no
 *  persona. Throws when the persona is not installed: a launch refuses that
 *  agent before it starts (refer to `resolveLaunchAgents`), so only a
 *  persona removed while the run was paused reaches this. */
export function agentPersonaRun(input: {
  readonly agent: ResolvedAgent
  readonly personas: ReadonlyMap<string, AgentDefinition>
  readonly skills: SkillRegistryRevision
  readonly sessionMessaging: boolean
}): AgentPersonaRun | undefined {
  const { agent, personas } = input
  if (agent.persona === undefined) return undefined
  const persona = personas.get(agent.persona)
  if (persona?.kind !== "persona") throw new Error(`Agent "${agent.definitionId}" runs as persona "${agent.persona}", which no installed persona provides`)
  const allowedSubagentTypes = new Set([...workflowAgentSubagents(agent), ...grantedSubagentTypes(persona, personas)])
  const toolGrant = [...new Set([
    ...personaToolNames(persona, personas),
    ...(allowedSubagentTypes.size > 0 ? ["subagent", "process"] : []),
    ...(input.sessionMessaging ? ["message_session"] : []),
  ])]
  const git = gitDisciplineRule(toolGrant)
  return {
    role: persona.role,
    toolGrant,
    allowedSubagentTypes,
    maxTurns: persona.maxTurns,
    readOnly: isReadOnlyPersona(persona),
    instructions: [personaInstructions(persona, input.skills), ...(git === undefined ? [] : [git])].join("\n\n"),
  }
}

/** The task of an agent that runs as a persona: the persona's instructions,
 *  then the agent's own task. */
export function personaTask(run: AgentPersonaRun | undefined, task: string): string {
  return run === undefined ? task : `${run.instructions}\n\n---\n\n${task}`
}
