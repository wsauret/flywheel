import type { AsyncEventStateReadSurface } from "../../infra/substrate/store/event-store-types.js"
import { workflowLaunchTitle } from "../../infra/substrate/output/projector/deferred-agent-meta.js"
import type { FrontendAttempt, WorkflowAgentPersona } from "../../protocol/session/workflow-view-protocol-types.js"
import { getPersonaMetadataIndex } from "../../workflows/agents/agent-roles.js"
import { personaRoleChain } from "../config/models/role-selection.js"
import { readToolExecutions } from "../session/runtime-facts/tool-execution-projection.js"
import type { DefinitionLineageView } from "../../workflows/run/definition-provenance-projection.js"
import type { AttemptRow, WorkflowView } from "../../workflows/view/types.js"
import { workflowRunReader } from "../module-catalog.js"
import type { WorkflowMember } from "../session/metadata/workflow-membership.js"
import { attemptNodeIdOf } from "../../workflows/control-facts/graph-types.js"
import { startedConversation, type AttemptStarts } from "../../workflows/vm/host/attempt-conversations.js"
import type { AgentDefinition } from "../../infra/definitions/agent-definition.js"

/** The persona of each agent record of a run, by record id. */
export type AgentPersonas = ReadonlyMap<string, WorkflowAgentPersona>

function frontendAttempt(row: AttemptRow, personas: AgentPersonas | undefined, members: readonly WorkflowMember[], starts: AttemptStarts): FrontendAttempt {
  const persona = personas?.get(row.definitionId)
  // A reopened agent continues in its failed attempt's session, so the
  // session of an attempt is the one that holds the conversation it started in.
  const started = startedConversation(starts, row)
  const current = members.find(({ membership, conversationId }) => membership.kind === "attempt" && conversationId === started)
    ?? members.find(({ membership }) => membership.kind === "attempt" && membership.attemptId === row.id)
  const history = members.filter(({ membership }) => membership.kind === "historical-generation" && membership.attemptId === row.id)
  const agentNodeId = attemptNodeIdOf(row.id)
  return {
    id: row.id, definitionId: row.definitionId, briefId: row.briefId, name: row.name,
    ...(agentNodeId === null ? {} : { agentNodeId }),
    ...(current ? { sessionId: current.sessionId, conversationId: current.conversationId } : {}),
    history: history.map(({ sessionId, conversationId }) => ({ sessionId, conversationId })),
    status: row.status,
    ...(persona === undefined ? {} : { persona }),
    ...(row.toolUses === undefined ? {} : { toolUses: row.toolUses }),
    ...(row.startedAt === undefined ? {} : { startedAt: row.startedAt }),
    ...(row.completedAt === undefined ? {} : { completedAt: row.completedAt }),
  }
}

/** One row per committed attempt, in view order, each with the persona that
 *  its agent record names and the session of its agent among `members`,
 *  which `starts` (refer to `readAttemptStarts`) finds. Unrun work belongs
 *  to the tree. */
export function frontendAttempts(view: Pick<WorkflowView, "attempts">, personas?: AgentPersonas, members: readonly WorkflowMember[] = [], starts: AttemptStarts = new Map()): FrontendAttempt[] {
  return view.attempts.map((row) => frontendAttempt(row, personas, members, starts))
}

/** The persona that each agent record of a run names, from the records
 *  that its launch recorded (`readRunDefinitionLineage`), with the roles
 *  whose seats the runtime reads for it (refer to
 *  `resolveWorkflowAgentRole`): the role of the persona that this build
 *  installs, then that role's parent. A run records its agent records once,
 *  at its launch. */
export function agentPersonas(lineage: Pick<DefinitionLineageView, "definitions">, roleOf: (id: string) => string | undefined = (id) => getPersonaMetadataIndex()[id]?.role): AgentPersonas {
  const personas = new Map<string, WorkflowAgentPersona>()
  for (const loaded of Object.values(lineage.definitions)) {
    if (loaded.kind !== "agent" || loaded.definition.policy.persona === undefined) continue
    const id = loaded.definition.policy.persona
    personas.set(loaded.definition.definitionId, { id, roles: personaRoleChain(roleOf(id)) })
  }
  return personas
}

/** The role of each persona that `personas` installs, as {@link agentPersonas} reads it. */
export function installedPersonaRole(personas: ReadonlyMap<string, AgentDefinition>): (id: string) => string | undefined {
  return (id) => {
    const persona = personas.get(id)
    return persona?.kind === "persona" ? persona.role : undefined
  }
}

/** What a run's launch recorded for the views of the run: the persona of
 *  each agent record, and the run's name. */
export interface WorkflowRunRecords {
  readonly personas: AgentPersonas
  /** The title that the run's launching call gave it, or the name that its
   *  workflow file gives it when the call gave none, so a reused workflow
   *  file never lends the run an old name. The inline card, the full-size
   *  card, and the agent view all name the run by it. */
  readonly name: string
}

/** The run records of the workflow `workflowId`, or undefined while
 *  its launch commit is not readable. A run records them once, at its
 *  launch, so a caller keeps the first answer for good. */
export async function readWorkflowRunRecords(reader: AsyncEventStateReadSurface, workflowId: string): Promise<WorkflowRunRecords | undefined> {
  const runs = workflowRunReader(reader)
  const [lineage, run] = await Promise.all([runs.readDefinitionLineage(workflowId), runs.read(workflowId)])
  if (lineage.compiledWorkflow === null) return undefined
  const from = run?.launchedFrom
  const call = from?.toolUseId === undefined ? undefined : (await readToolExecutions(reader, from.parentSessionId, [from.toolUseId])).get(from.toolUseId)
  return { personas: agentPersonas(lineage), name: (call?.input === undefined ? null : workflowLaunchTitle(call.input)) ?? lineage.compiledWorkflow.workflowName }
}
