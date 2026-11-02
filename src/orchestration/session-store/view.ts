import type { AsyncEventStateReadSurface, AsyncEventWriter } from "../../infra/event-store-types.js"
import type { Activity, AnyBlock, ConnectionState, ToolStreamingText } from "../../infra/output-blocks.js"
import type { SessionNotice } from "../../infra/session-notice.js"
import { createReadQueue, type ReadQueue } from "../../infra/read-queue.js"
import { budgetSummaryFromState } from "../session/budget-summary.js"
import { createBudgetProjection } from "../session/budget-projection.js"
import { readSessionDurationFromReader } from "../session/session-duration-projection.js"
import { durableBranchHasUserMessage } from "../session/conversation/conversation-tree-handle.js"
import { readSessionMetadata } from "../session/session-metadata-store.js"
import type { SessionLifecycleState } from "../session/types.js"
import type { RoleSettings as RoleAssignments } from "../session/schemas.js"
import { effectiveRoleAssignments } from "../config/session-role-resolver.js"
import type { SessionEntry, SessionEntryBase } from "./types.js"
import type { WorkflowMembership } from "../../infra/session-workflow-membership.js"
import { entryActivity } from "./activity.js"

interface SessionViewBase {
  id: string
  description: string
  shortDescription?: string
  lifecycleState: SessionLifecycleState
  outputBlocks: readonly AnyBlock[]
  streamingToolText: Readonly<StringMap<ToolStreamingText>>
  tokens: number
  cost: number
  /** Metered (API-key) portion of `cost`; the remainder is
   *  subscription-covered API-equivalent value. */
  billedCost: number
  priceUnavailable: boolean
  contextPercent: number
  contextPromptTokens: number
  startedAt: number
  activity: Activity
  streamingStartedAt: number | null
  activityStartedAt: number | null
  accumulatedActiveMs: number
  connectionState: ConnectionState
  notices: readonly SessionNotice[]
  compactionStartedAt: number | null
  roleAssignments?: RoleAssignments
}

export interface ChatSessionView extends SessionViewBase {
  kind: "chat"
  /** Stable Flywheel key for the durable conversation tree. Always present;
   *  minted at session creation, sourced from the store entry (active) or the
   *  durable metadata (inactive), both of which require it. */
  conversationId: string
  /** Provider continuation token used to resume the same prompt-cache slot. */
  providerConversationId?: string
  seedContext?: string
}

interface SubagentSessionView extends SessionViewBase {
  kind: "subagent"
  conversationId: string
  providerConversationId?: string
  seedContext?: string
}
interface WorkflowAgentSessionView extends SessionViewBase {
  kind: "workflow-agent"
  workflowMembership: WorkflowMembership
  conversationId: string
  providerConversationId?: string
  seedContext?: string
}

export type SessionView = ChatSessionView | SubagentSessionView | WorkflowAgentSessionView

export interface SessionViewLoader {
  load(sessionId: string): Promise<SessionView | null>
}

export function toSessionView(id: string, entry: SessionEntry, lifecycleState: SessionLifecycleState, workflowMembership?: WorkflowMembership): SessionView {
  const base = {
    id,
    description: entry.description,
    shortDescription: entry.shortDescription,
    lifecycleState,
    outputBlocks: [...entry.outputBlocks()],
    streamingToolText: entry.streamingToolText,
    tokens: entry.tokens,
    cost: entry.cost,
    billedCost: entry.billedCost,
    priceUnavailable: entry.priceUnavailable,
    contextPercent: entry.contextPercent,
    contextPromptTokens: entry.contextPromptTokens,
    startedAt: entry.startedAt,
    activity: entryActivity(entry),
    activityStartedAt: entry.activityStartedAt,
    streamingStartedAt: entry.streamingStartedAt,
    accumulatedActiveMs: entry.accumulatedActiveMs,
    connectionState: entry.connectionState,
    notices: entry.notices,
    compactionStartedAt: entry.compactionStartedAt,
  }

  const conversation = { ...base, conversationId: entry.conversationId, providerConversationId: entry.providerConversationId, seedContext: entry.seedContext }
  // SAFETY: both live and passive callers supply the membership from the member's committed creation.
  return entry.kind === "workflow-agent" ? { ...conversation, kind: entry.kind, workflowMembership: workflowMembership! } : { ...conversation, kind: entry.kind }
}

export async function loadSessionView(sessionId: string, reader: AsyncEventStateReadSurface, projectionReader: AsyncEventStateReadSurface, writer?: AsyncEventWriter): Promise<SessionView | null> {
  const session = await readSessionMetadata(projectionReader, sessionId)
  if (!session || session.kind === "workflow") return null

  // Durable output is served by the indexed range/index readers, not this view:
  // a reactivated chat's transcript re-hydrates through the transcript cache, and
  // its model context comes from the SQLite chat tree.
  const budget = budgetSummaryFromState(await createBudgetProjection(projectionReader, sessionId).replay())
  const duration = await readSessionDurationFromReader(projectionReader, sessionId)
  const startedAt = session.createdAt ? new Date(session.createdAt).getTime() : Date.now()
  const base = {
    id: sessionId,
    description: session.label || session.name || sessionId,
    shortDescription: session.shortLabel,
    lifecycleState: session.lifecycleState,
    outputBlocks: [],
    streamingToolText: {},
    tokens: budget.totalTokens,
    cost: budget.totalCost,
    billedCost: budget.totalBilledCost,
    priceUnavailable: budget.priceUnavailable,
    contextPromptTokens: budget.contextPromptTokens,
    contextPercent: budget.contextPercent,
    startedAt,
    activity: "absent" as const,
    streamingStartedAt: null,
    activityStartedAt: null,
    accumulatedActiveMs: duration.accumulatedActiveMs,
    connectionState: "connected" as const,
    notices: [],
    compactionStartedAt: null,
    roleAssignments: session.roleAssignments ? effectiveRoleAssignments(session.roleAssignments) : undefined,
  }

    // Loadability is the CONVERSATION's, not the render index's: a durably
    // committed user turn (a cold send killed inside the flush debounce, say)
    // must stay reachable even when no output was ever indexed - an empty index
    // means empty transcript, never "not a conversation". Loadability reads only
    // the current branch. The discard rule, `isEmptyChat` in
    // session/empty-chat.ts, counts a message on any branch, so a chat that
    // fails this check only because its message is on another branch is never
    // removed. The writer travels along because the runtime's read surface is
    // not a local append store.
    if (session.kind === "chat" && !await durableBranchHasUserMessage({ conversationId: session.conversationId, sessionId, store: reader, ...(writer ? { writer } : {}) })) return null
    const conversation = { ...base, conversationId: session.conversationId, providerConversationId: session.providerConversationId, seedContext: session.seedContext }
    return session.kind === "workflow-agent" ? { ...conversation, kind: session.kind, workflowMembership: session.workflowMembership } : { ...conversation, kind: session.kind }
}

export function createSessionViewLoader(deps: { reader: AsyncEventStateReadSurface; projectionReader: AsyncEventStateReadSurface; writer?: AsyncEventWriter }): SessionViewLoader {
  // One queue for each session that a load is running or waiting for.
  const loads = new Map<string, ReadQueue<SessionView | null>>()

  return {
    load(sessionId: string): Promise<SessionView | null> {
      let queue = loads.get(sessionId)
      if (!queue) {
        queue = createReadQueue(
          () => loadSessionView(sessionId, deps.reader, deps.projectionReader, deps.writer),
          () => loads.delete(sessionId),
        )
        loads.set(sessionId, queue)
      }
      return queue.read()
    },
  }
}
interface StringMap<T> { [key: string]: T }

/** Whether the session's turn is in flight: it runs, or it is parked on a
 *  question or on background work. A parked turn is still the agent's turn
 *  (PI-INTERACTION-013), so it is not at rest although its runner shows no activity. */
export function turnInFlight(entry: Pick<SessionEntryBase, "runnerState" | "waitingOnBackgroundWork">): boolean {
  return entry.runnerState === "streaming" || entry.runnerState === "awaiting_user" || entry.waitingOnBackgroundWork
}

/** Whether an agent runs its workflow card's clock: its turn is in flight
 *  and has streamed. This is the one state of an agent its card reads. */
export function runsWorkflowClock(entry: Pick<SessionEntryBase, "runnerState" | "waitingOnBackgroundWork" | "streamingStartedAt">): boolean {
  return turnInFlight(entry) && entry.streamingStartedAt !== null
}
