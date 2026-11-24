import type { ToolOutcome } from "../../../infra/tool-outcome.js"
import type { StoredFact } from "../../../infra/event-store-types.js"
import type { RecordedRuntimeInvocation } from "../../../infra/runtime-fact-types.js"

export type ToolExecutionStatus =
  | "called"
  | "completed"
  | "failed"
  | "interrupted"
  | "validation_failed"

/** Any recorded version: a version-1 adoption has no words. */
interface RuntimeWorkflowInvocationOrigin {
  initiator: RecordedRuntimeInvocation["initiator"]
  parentConversationId: string
  parentEntryId: string
  operation: RecordedRuntimeInvocation["operation"]
}

export interface ToolExecutionEntry {
  toolUseId: string
  toolName: string
  /** Typed degraded gap (ARCH-SUBSTRATE-012): the tool's `tool.input.completed` fact was
   *  never committed, so this entry was rebuilt from its follow-up facts alone.
   *  Its name, input, and mode are unknown; its outcome is what the record says. */
  inputUnrecorded?: true
  providerCallId?: string
  providerToolName?: string
  /** Present only when Flywheel, rather than a provider tool call, created the
   *  workflow invocation. Provider and model request ids stay absent. */
  runtimeOrigin?: RuntimeWorkflowInvocationOrigin
  status: ToolExecutionStatus
  /** Outcome recorded by the tool's single terminal result fact. */
  resultOutcome?: ToolOutcome
  executionMode: "foreground" | "background"
  traceKind: "tool" | "subagent"
  childHasOwnViewport: boolean
  modelRequestId?: string
  parentToolUseId?: string
  calledAt?: number
  completedAt?: number
  acknowledgedAt?: number
  validationFailedAt?: number
  callEventId?: string
  resultEventId?: string
  /** The result, a Cancel of a launched workflow, that the newest explicit
   *  Resume of that workflow passed. The Cancel is current while it is the
   *  call's result and no Resume names it. */
  resumedResultEventId?: string
  ackEventId?: string
  validationEventId?: string
  input?: StringMap<unknown>
  inputBytes?: number
  inputSha256?: string
  inputPreview?: string
  contentBytes?: number
  contentSha256?: string
  contentPreview?: string
  contentTruncated?: boolean
  originalContentBytes?: number
  originalContentSha256?: string
  fullContentPath?: string
  semanticOutputTruncated?: boolean
  byteOutputTruncated?: boolean
  validationReason?: string
}

export interface ToolExecutionState {
  toolCount: number
  completedCount: number
  failedCount: number
  validationFailureCount: number
  tools: StringMap<ToolExecutionEntry>
  /** Tool-use ids of in-flight child agents whose only viewport is this session:
   *  no inline tools, settled entries, or workflow launches, whose persisted
   *  `childHasOwnViewport` flag gives them their own tab. A non-empty set marks
   *  the parent busy. The projection mutates this index in place, so a reader
   *  that hands it on copies it first. */
  activeSubagentToolUseIds: ReadonlySet<string>
  activeSubagentRevision: number
}

export interface SessionToolExecutionStore {
  applyStoredFact(event: StoredFact): Promise<void>
  loadTimeline(): Promise<ToolExecutionEntry[]>
  dispose(): void
}
interface StringMap<T> { [key: string]: T }
