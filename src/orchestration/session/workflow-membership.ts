import { createEventProjection } from "../../infra/event-projection.js"
import type { AsyncEventReadSurface } from "../../infra/event-store-types.js"
import { heldProjection } from "../../infra/projection-registry.js"
import { reduceSessionMetadataEvent } from "./session-metadata-projection.js"
import type { WorkflowMembership } from "../../infra/session-workflow-membership.js"

export interface WorkflowMember {
  readonly sessionId: string
  readonly conversationId: string
  readonly membership: WorkflowMembership
}

interface MembershipIndex {
  /** The workflow of each member, so that a deletion finds its workflow. */
  readonly workflows: Map<string, string>
  /** One workflow's members, in creation order. A membership fact of the
   *  workflow replaces the array, and nothing else does, so its identity
   *  names the membership. */
  readonly members: Map<string, readonly WorkflowMember[]>
}

const NO_MEMBERS: readonly WorkflowMember[] = []

/** Derived reverse membership, indexed by workflow: every card, total, and
 *  start reads one workflow's members after each change, so a read costs the
 *  members of that workflow, never a scan of the project's members.
 *  Tombstoning a session removes it from live lookup without changing its
 *  creation fact. */
export function workflowMembershipReader(reader: AsyncEventReadSurface) {
  const projection = heldProjection(reader, "workflow-membership", () => createEventProjection(reader, {
    name: "workflow-membership",
    factTypes: ["session.created", "session.deleted"],
    initialState: (): MembershipIndex => ({ workflows: new Map(), members: new Map() }),
    draft: (state) => ({ workflows: new Map(state.workflows), members: new Map(state.members) }),
    reduce: (state, event) => {
      const metadata = reduceSessionMetadataEvent({ sessions: {}, deleted: {}, errors: {} }, event)
      if (metadata.deleted[event.sessionId] || metadata.errors[event.sessionId]) remove(state, event.sessionId)
      const session = metadata.sessions[event.sessionId]
      if (session?.kind === "workflow-agent") {
        remove(state, event.sessionId)
        const member = { sessionId: event.sessionId, conversationId: session.conversationId, membership: session.workflowMembership }
        const { workflowId } = member.membership
        state.members.set(workflowId, [...(state.members.get(workflowId) ?? NO_MEMBERS), member])
        state.workflows.set(event.sessionId, workflowId)
      }
      return state
    },
    reduceCorruptRow: (state, corrupt) => remove(state, corrupt.sessionId),
  }))
  return {
    /** The workflow's members. The same array answers until a membership fact of the workflow folds. */
    async list(workflowId: string): Promise<readonly WorkflowMember[]> {
      return (await projection.replay()).members.get(workflowId) ?? NO_MEMBERS
    },
    /** The first member of the attempt, in creation order. */
    async attempt(workflowId: string, attemptId: string): Promise<WorkflowMember | null> {
      const members = (await projection.replay()).members.get(workflowId) ?? NO_MEMBERS
      return members.find(({ membership }) => membership.kind === "attempt" && membership.attemptId === attemptId) ?? null
    },
  }
}

function remove(state: MembershipIndex, sessionId: string): MembershipIndex {
  const workflowId = state.workflows.get(sessionId)
  if (workflowId === undefined) return state
  state.workflows.delete(sessionId)
  state.members.set(workflowId, (state.members.get(workflowId) ?? NO_MEMBERS).filter((member) => member.sessionId !== sessionId))
  return state
}
