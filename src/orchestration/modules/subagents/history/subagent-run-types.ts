import type { ModuleId } from "../../../modules.js"
import type { WorkflowsMode } from "../../../../protocol/module-protocol-types.js"
import type { PausedBy } from "../../../../infra/output-blocks.js"
import type { HashMap } from "effect"

type SubagentRunStatus = "created" | "completed" | "partial" | "failed" | "interrupted" | "paused" | "cancelled" | "stopped"
type SubagentInterruptionReason = "runtime_restarted"

export interface SubagentRunCreateInput {
  childRunId: string
  toolUseId?: string
  modelRequestId?: string
  /** Durable conversation of the dispatching runner. Cold-runtime recovery
   *  folds its recovery message into this conversation; absent when the
   *  dispatcher has no durable tree (a subagent dispatching a grandchild). */
  conversationId?: string
  agentType: string
  description: string
  model: string
  effort?: string
  /** Present (true) only for forked general-agent runs. */
  fork?: true
  maxTurns: number
  tools: ReadonlyArray<string>
  /** Canonical effective child directory. Required for every current write. */
  executionCwd: string
}

export interface DurableSubagentRunCreateInput {
  childSessionId: string
  childRunId: string
  conversationId: string
  parentSessionId: string
  parentConversationId: string
  parentToolCallId: string
  modelRequestId?: string
  persona: {
    name: string
    kind: "general" | "persona"
  }
  capabilityGrant: {
    operation: string
    required: readonly ModuleId[]
    capabilities: readonly ModuleId[]
    moduleIds: readonly ModuleId[]
    requireWorkflowConfirmation: boolean
    workflowsMode: WorkflowsMode
    identity: string
  }
  admittedModuleIds: readonly ModuleId[]
  skillsRevision: number
  model?: string
  effort?: string
  tools: readonly string[]
  executionCwd: string
  budget: {
    maxTurns: number
    maxTokens: number
  }
  parentDepth: number
  description: string
  fork?: true
}

export interface SubagentPromptInput {
  childRunId: string
  prompt: string
  task: string
  toolNames: ReadonlyArray<string>
}

export interface SubagentCompletionInput {
  childRunId: string
  status: Extract<SubagentRunStatus, "completed" | "partial" | "failed" | "cancelled" | "stopped">
  isError: boolean
  modelFailure?: true
  content: string
  durationMs: number
  totalTokens?: number
  inputTokens?: number
  outputTokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  reasoningTokens?: number
  totalCostUsd?: number
  toolUses?: number
}

export interface SubagentInterruptionInput {
  childRunId: string
  reason: SubagentInterruptionReason
  recoveryId: string
}

export interface SubagentPauseInput {
  childRunId: string
  /** Version 1 of `subagent.paused` names a person or the runtime. The
   *  parent agent's interrupt is saved as a person's, because the child's
   *  turn end names who interrupted it. */
  pausedBy: Exclude<PausedBy, "agent">
}

export interface SubagentResumeInput {
  childRunId: string
  authorizationId: string
  continuation: number
}

export interface SubagentRunEntry {
  childSessionId?: string
  childRunId: string
  status: SubagentRunStatus
  toolUseId?: string
  modelRequestId?: string
  conversationId?: string
  parentSessionId?: string
  parentConversationId?: string
  parentToolCallId?: string
  parentDepth?: number
  agentType: string
  personaKind?: "general" | "persona"
  capabilityGrant?: DurableSubagentRunCreateInput["capabilityGrant"]
  admittedModuleIds?: readonly ModuleId[]
  skillsRevision?: number
  description: string
  model?: string
  effort?: string
  fork?: true
  maxTurns?: number
  maxTokens?: number
  tools: string[]
  executionCwd?: string
  prompt?: string
  task?: string
  promptToolNames?: string[]
  createdAt?: number
  promptedAt?: number
  completedAt?: number
  createEventId?: string
  promptEventId?: string
  completionEventId?: string
  interruptedAt?: number
  interruptionEventId?: string
  interruptionReason?: SubagentInterruptionReason
  recoveryId?: string
  /** Who paused the run, as `subagent.paused` v1 records it: a person or
   *  the runtime. The child's turn end names the parent agent. */
  pausedBy?: Exclude<PausedBy, "agent">
  pausedAt?: number
  pauseEventId?: string
  continuationCount?: number
  isError?: boolean
  modelFailure?: true
  durationMs?: number
  totalTokens?: number
  inputTokens?: number
  outputTokens?: number
  cacheReadInputTokens?: number
  cacheCreationInputTokens?: number
  reasoningTokens?: number
  totalCostUsd?: number
  toolUses?: number
  resultBytes?: number
  resultSha256?: string
  resultPreview?: string
  result?: string
}

export interface SubagentRunState {
  runCount: number
  completedCount: number
  failedCount: number
  interruptedCount: number
  runs: HashMap.HashMap<string, { readonly entry: SubagentRunEntry; readonly ordinal: number }>
}
