import type { DefinitionAvailabilitySnapshot } from "../app-service/definition-availability.js"
import type { ResolvedAgent } from "../../workflows/agent-resolution.js"
import { personaInstructions } from "../../workflows/agents/persona-instructions.js"
import { grantedSubagentTypes, personaToolNames, workflowAgentSubagents } from "../../workflows/agents/subagent-reachability.js"
import type { CapabilityCheck } from "../../infra/capability-text.js"
import type { SkillRegistryRevision } from "../../workflows/skill-schema.js"
import { availableToolNames, gitDisciplineRule, isReadOnlyPersona } from "../agent-runtime/persona-tool-rules.js"
import type { FirstPartyModuleComposition } from "../modules.js"

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
   *  session message tool when the host has session messaging, each one the
   *  workflow's modules can serve, as a dispatch narrows them. */
  readonly toolGrant: readonly string[]
  /** The personas the agent may dispatch: its brief's, the trial advisor
   *  default (refer to `workflowAgentSubagents`), and the persona's. */
  readonly allowedSubagentTypes: ReadonlySet<string>
  readonly maxTurns: number
  /** Whether the agent's shell refuses a command that writes a project
   *  file, as a dispatch of the persona's shell does. */
  readonly readOnly: boolean
  /** The persona's instructions and its git discipline, as a dispatch of
   *  the persona states them, which open the task, rendered for the check of
   *  the agent's run (ARCH-CONTEXT-033). The tools it may call follow in its
   *  opening turn from its first tool plan (`tool-notice.ts`). */
  readonly instructions: (capabilities: CapabilityCheck) => string
}

/** The persona run of one agent, or undefined when its record names no
 *  persona. `availability` is the agent's own at its start, as a dispatch
 *  judges the persona it starts: the agent runs as an available persona and
 *  may dispatch only available ones. Throws when the persona is not
 *  installed or cannot run: a launch refuses that agent before it starts
 *  (refer to `resolveLaunchAgents` and `admitWorkflowOperation`), so only a
 *  persona removed, or a type turned off, after the run's admission reaches
 *  this. */
export function agentPersonaRun(input: {
  readonly agent: ResolvedAgent
  readonly availability: Pick<DefinitionAvailabilitySnapshot, "personas" | "availablePersonas">
  readonly skills: SkillRegistryRevision
  readonly sessionMessaging: boolean
  /** The workflow's modules, which the grant narrows to. */
  readonly modules: FirstPartyModuleComposition
}): AgentPersonaRun | undefined {
  const { agent, availability } = input
  if (agent.persona === undefined) return undefined
  const reason = availability.personas.get(agent.persona)?.reason
  if (reason !== undefined) throw new Error(`Agent "${agent.definitionId}" runs as persona "${agent.persona}", which cannot run: ${reason}`)
  const personas = availability.availablePersonas
  const persona = personas.get(agent.persona)
  if (persona?.kind !== "persona") throw new Error(`Agent "${agent.definitionId}" runs as persona "${agent.persona}", which no installed persona provides`)
  const allowedSubagentTypes = new Set([...workflowAgentSubagents(agent, personas), ...grantedSubagentTypes(persona, personas)])
  const toolGrant = availableToolNames([...new Set([
    ...personaToolNames(persona, personas),
    ...(allowedSubagentTypes.size > 0 ? ["subagent", "process"] : []),
    ...(input.sessionMessaging ? ["message_session"] : []),
  ])], input.modules)
  return {
    role: persona.role,
    toolGrant,
    allowedSubagentTypes,
    maxTurns: persona.maxTurns,
    readOnly: isReadOnlyPersona(persona),
    instructions: (capabilities) => {
      const git = gitDisciplineRule(capabilities)
      return [personaInstructions(persona, input.skills, capabilities), ...(git === undefined ? [] : [git])].join("\n\n")
    },
  }
}

/** The task of an agent that runs as a persona: the persona's instructions for the check of its run, then the
 *  agent's own task. */
export function personaTask(run: AgentPersonaRun | undefined, task: string, capabilities: CapabilityCheck): string {
  return run === undefined ? task : `${run.instructions(capabilities)}\n\n---\n\n${task}`
}
