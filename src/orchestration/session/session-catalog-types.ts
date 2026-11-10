import type { WorkflowView } from "../../workflows/view/types.js"
import type { SessionDiffStats } from "../../protocol/app-service-types.js"
import type { SessionForkRecord } from "./session-fork-projection.js"
import type { SessionLifecycleState } from "./types.js"
import type { ReplayedSession } from "./schemas.js"
import type { WorkflowMembership } from "../../infra/session-workflow-membership.js"

export interface SessionLaunchedFrom {
  parentSessionId: string
  conversationId?: string
  workflowDefinitionId?: string
  /** Stable identity of the parent tool use that launched this session. */
  toolUseId?: string
  description?: string
}


export interface DurableSessionCatalogError {
  sessionId: string
  scope: "metadata" | "budget" | "duration" | "diffStats" | "fork" | "output"
  reason: string
}

export interface SessionMetadataCatalog {
  readonly entries: ReadonlyArray<{
    id: string
    data: ReplayedSession
    degraded?: true
    unavailableFields?: readonly string[]
  }>
  readonly errors: ReadonlyArray<{ sessionId: string; reason: string }>
}

interface DurableSessionCatalogMetadata {
  id: string
  /** Absent means unnamed (mirrors Session.name). */
  name?: string
  label: string
  shortLabel?: string
  workflowDefinitionId?: string
  lifecycleState: SessionLifecycleState
  /** The auth profile this session selected; absent means it follows the
   *  account default. Listed here so auth owners can find every profile the
   *  active sessions use from one catalog read instead of one read per session. */
  authProfileId?: string
  command: string
  /** Stats are present only when the builder computed them: the full catalog
   *  read (budget + duration projections) sets them, the metadata-only read
   *  omits them. Absent means "not computed", never zero - consumers keep a
   *  previously computed value rather than clobbering it with a placeholder. */
  totalCost?: number
  totalBilledCost?: number
  priceUnavailable?: boolean
  totalTokens?: number
  contextPercent?: number
  contextPromptTokens?: number
  /** The context size of the next automatic reset that the runtime stated: 0
   *  when none can run, absent when the session's history states none. */
  compactionTriggerTokens?: number
  durationMs?: number
  diffStats?: SessionDiffStats
  lastUpdated: string
  createdAt?: string
  /** Canonical directory this session executes in (ARCH-DIRECTORIES-006). Session metadata
   *  is its sole authority, so resume and historical projections read it from
   *  here rather than from a process directory. */
  executionCwd: string
  activatedAt?: string
  repo?: string
  branch?: string
  conversationId?: string
  providerConversationId?: string
  workflowState?: WorkflowView["status"]
  parentSessionId?: string
  childSessionIds?: readonly string[]
  launchedFrom?: SessionLaunchedFrom
  fork?: SessionForkRecord
  /** Present when strict metadata replay quarantined this session and the row
   *  contains only independently recovered values. */
  degraded?: true
  /** Fields the strict metadata row could have supplied but recovery cannot
   *  establish. No placeholder value is published for these fields. */
  unavailableFields?: readonly string[]
}

export type DurableSessionCatalogRow = DurableSessionCatalogMetadata & (
  | { readonly kind: "workflow-agent"; readonly workflowMembership: WorkflowMembership }
  | { readonly kind: "chat" | "subagent"; readonly workflowMembership?: never }
)

export interface DurableSessionCatalog {
  readonly sessions: readonly DurableSessionCatalogRow[]
  readonly errors: readonly DurableSessionCatalogError[]
}
