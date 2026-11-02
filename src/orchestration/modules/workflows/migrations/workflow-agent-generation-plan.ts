import { CorruptEventRowError, type EventStoreReadSurface, type StoredFact } from "../../../../infra/event-store-types.js"
import { generateSessionId } from "../../../../infra/session-id.js"
import { committedWorkflowEvent, parseWorkflowSessionFact, workflowRootControl } from "../../../../workflows/vm/session-facts.js"
import { workflowRecoveryBasis } from "../../../../workflows/vm/recovery.js"
import type { WorkflowMembership } from "../../../../infra/session-workflow-membership.js"

export interface ImportedWorkflowGeneration {
  readonly sessionId: string
  readonly conversationId: string
  readonly membership: WorkflowMembership
}

/** All retained epochs prove history. Ambiguous conversation ownership never authorizes a member. */
export function workflowAgentGenerationPlan(reader: EventStoreReadSurface, workflowId: string) {
  const starts = new Map<string, string[]>()
  const followUps = new Map<string, string>()
  const gaps: number[] = []
  const conversationGaps: number[] = []
  const current = workflowRecoveryBasis(reader.readTolerant({ aggregateId: `workflow:${workflowId}` }))
  const add = (attemptId: string, conversationId: string | null) => {
    if (!conversationId) return
    const known = starts.get(attemptId) ?? []
    if (!known.includes(conversationId)) starts.set(attemptId, [...known, conversationId])
  }
  for (const row of reader.readTolerant({
    aggregateId: `workflow:${workflowId}`,
    types: ["workflow.control.initialized", "workflow.control.recovered", "workflow.control.committed", "step.resume_state.recorded", "follow_up.requested"],
  })) {
    if (row instanceof CorruptEventRowError) { gaps.push(row.position); continue }
    try {
      const fact = parseWorkflowSessionFact({ type: row.type, version: row.version, actor: row.actor, payload: row.payload })
      if (fact.type === "workflow.control.initialized" || fact.type === "workflow.control.recovered") {
        const control = workflowRootControl(fact)
        for (const attempt of control.attempts) add(attempt.id, attempt.conversationId)
        if (control.followUp) followUps.set(control.followUp.conversationId, String(control.followUp.requestSequence))
      } else if (fact.type === "workflow.control.committed") {
        const event = committedWorkflowEvent(fact)
        if (event.type === "ATTEMPT_STARTED") add(event.attemptId, event.conversationId)
      } else if (fact.type === "step.resume_state.recorded") {
        // Before VM commits recorded starts, the resume-state companion bound each step to its conversation.
        add("stepId" in fact.payload ? fact.payload.stepId : fact.payload.attemptId, fact.payload.conversationId)
      } else if (fact.type === "follow_up.requested") {
        followUps.set(fact.payload.conversationId, String(fact.payload.requestSequence))
      }
    } catch { gaps.push(row.position) }
  }
  const owners = new Map<string, number>()
  for (const conversations of starts.values()) for (const id of conversations) owners.set(id, (owners.get(id) ?? 0) + 1)
  for (const id of followUps.keys()) owners.set(id, (owners.get(id) ?? 0) + 1)
  const creations = new Map<string, StoredFact | CorruptEventRowError>()
  const admitted = [...owners].flatMap(([id, count]) => count === 1 ? [`conversation:${id}`] : [])
  for (const row of reader.readTolerant({ aggregateIds: admitted, types: ["chat.tree.created"] })) {
    const aggregateId = row instanceof CorruptEventRowError ? row.row.aggregateId : row.aggregateId
    if (!creations.has(aggregateId)) creations.set(aggregateId, row)
  }
  const generations: ImportedWorkflowGeneration[] = []
  const addGeneration = (conversationId: string, membership: WorkflowMembership) => {
    if (owners.get(conversationId) !== 1) return
    const creation = creations.get(`conversation:${conversationId}`)
    if (creation instanceof CorruptEventRowError) { conversationGaps.push(creation.position); return }
    if (!creation || creation.sessionId !== workflowId) return
    generations.push({ sessionId: generateSessionId(), conversationId, membership })
  }
  for (const [attemptId, conversations] of starts) {
    for (const [generation, conversationId] of conversations.entries()) {
      addGeneration(conversationId, current?.attempts.some(attempt => attempt.id === attemptId && attempt.conversationId === conversationId)
        ? { kind: "attempt", workflowId, attemptId }
        : { kind: "historical-generation", workflowId, attemptId, generation })
    }
  }
  for (const [conversationId, followUpId] of followUps) addGeneration(conversationId, { kind: "historical-follow-up", workflowId, followUpId })
  return { generations, gaps, conversationGaps }
}
