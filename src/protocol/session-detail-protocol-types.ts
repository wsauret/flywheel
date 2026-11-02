import type { SessionRow } from "./app-service-types.js"
import type { BudgetView } from "./budget-protocol-types.js"
import type { StatusView } from "./status-protocol-types.js"
import type { ToolStreamingText } from "../infra/output-blocks.js"
import { sessionDomainCursor, type RuntimeSessionViewsResult } from "./runtime-ui-protocol-types.js"

export type RuntimeSessionDetailSnapshotResult = RuntimeSessionViewsResult<RuntimeSessionDetailView>
export type SessionDetailPatchPayload = { readonly kind: "session_detail.changed"; readonly row: RuntimeSessionDetailView["row"] | null }
export const sessionDetailCursor = (sessionId: string) => sessionDomainCursor("session_detail", sessionId)


interface RuntimeStreamingToolText {
  readonly [toolUseId: string]: ToolStreamingText
}

export type RuntimeSessionDetailView = RuntimeLiveHistorySessionView | RuntimeDurableHistorySessionView

type RuntimeLiveHistorySessionView = RuntimeLiveHistorySessionBase & RuntimeSessionDetailKind
type RuntimeDurableHistorySessionView = RuntimeDurableHistorySessionBase & RuntimeSessionDetailKind

type RuntimeSessionDetailKind =
  | {
    readonly kind: "chat"
    readonly row: Extract<SessionRow, { readonly kind: "chat" }>
    readonly conversationId: string
    readonly providerConversationId?: string
    readonly seedContext?: string
  }
  | {
    readonly kind: "subagent"
    readonly row: Extract<SessionRow, { readonly kind: "subagent" }>
    readonly conversationId: string
    readonly providerConversationId?: string
    readonly seedContext?: string
  }
  | {
    readonly kind: "workflow-agent"
    readonly row: Extract<SessionRow, { readonly kind: "workflow-agent" }>
    readonly conversationId: string
    readonly providerConversationId?: string
    readonly seedContext?: string
  }

interface RuntimeSessionDetailBase {
  readonly id: string
  readonly status: StatusView
}

interface RuntimeLiveHistorySessionBase extends RuntimeSessionDetailBase {
  readonly source: "live"
  readonly streamingToolText: RuntimeStreamingToolText
  readonly budget: BudgetView
}

interface RuntimeDurableHistorySessionBase extends RuntimeSessionDetailBase {
  readonly source: "durable"
  readonly budget: BudgetView | null
}

export interface RuntimeSessionDetailQuery {
  readonly sessionId: string
}

export interface RuntimeSessionDetailResult {
  readonly view: RuntimeSessionDetailView | null
}
