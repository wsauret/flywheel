import type { WorkflowRunner, WorkflowResult, StepState } from "./workflow-runner-types.js"
import type { AnyBlock } from "../infra/output-blocks.js"
import type { ModelActivity } from "../infra/output-blocks.js"
import type { ChatRunner } from "./chat-runner-types.js"
import type { SessionKind } from "./session/types.js"
import type { Queue } from "../workflows/queue/types.js"
import type { WorkflowDeps } from "./engines/workflow-deps.js"
import type { EventBus } from "../infra/event-bus.js"
import type { EngineMetadata } from "./engines/core/types.js"

interface WorkflowAdapter {
  connect(bus: EventBus): void
  disconnect(): void
  answerQuestion?(toolUseId: string, answers: Record<string, string>): void
  cancelQuestion?(toolUseId: string): void
}

export type CreateWorkflowAdapter = (opts: { updateEntry: (patch: Partial<WorkflowSessionEntry>) => void; engineMetadata?: EngineMetadata }) => WorkflowAdapter

export interface SessionEntryBase {
  readonly kind: SessionKind
  description: string
  outputBlocks: readonly AnyBlock[]
  tokens: number
  cost: number
  contextPercent: number
  readonly startedAt: number
  modelActivity: ModelActivity
  // Runtime disposal guard, not lifecycle state — loaded sessions also have runner: null.
  ended: boolean
}

export interface WorkflowSessionEntry extends SessionEntryBase {
  readonly kind: "workflow"
  readonly runner: WorkflowRunner | null
  steps: readonly StepState[]
}

export interface ChatSessionEntry extends SessionEntryBase {
  readonly kind: "chat"
  readonly runner: ChatRunner | null
  engineSessionId?: string
}

export type SessionEntry = WorkflowSessionEntry | ChatSessionEntry

export interface ChatStoreHandle {
  updateEntry: (patch: Partial<ChatSessionEntry>) => void
  onError: (message: string) => void
  onEnded: () => void
}

export interface SessionStore {
  start(opts: {
    sessionId: string
    queue: Queue
    description: string
    priorBlocks?: AnyBlock[]
    workerCwd?: string
    workflowDeps?: WorkflowDeps
    chatContext?: string
    onRunnerDone?: (sessionId: string, result: WorkflowResult) => void
    onRunnerError?: (sessionId: string, err: unknown) => void
  }): string

  startChat(opts: {
    sessionId: string
    description?: string
    priorBlocks?: AnyBlock[]
    initialCost?: number
    initialTokens?: number
    startedAt?: number
    contextPercent?: number
    createRunner: (handle: ChatStoreHandle) => Promise<ChatRunner>
    onRunnerDone?: (sessionId: string) => void
    onRunnerError?: (sessionId: string, err: unknown) => void
  }): Promise<string>

  load(sessionId: string, data: {
    kind: SessionKind
    description: string
    outputBlocks: readonly AnyBlock[]
    tokens?: number
    cost?: number
    contextPercent?: number
    startedAt?: number
    engineSessionId?: string
  }): void

  get(sessionId: string): SessionEntry | undefined
  has(sessionId: string): boolean
  isRunning(sessionId: string): boolean
  pause(sessionId: string): boolean
  abort(sessionId: string): void
  remove(sessionId: string): Promise<void>
  updateEntry(sessionId: string, patch: Partial<WorkflowSessionEntry> | Partial<ChatSessionEntry>): void
  injectMessage(sessionId: string, text: string): boolean
  injectToolResult(sessionId: string, toolUseId: string, content: string, isError?: boolean): boolean
  answerQuestion(sessionId: string, toolUseId: string, answers: Record<string, string>): boolean
  cancelQuestion(sessionId: string, toolUseId: string): boolean
  cancelShutdown(sessionId: string): boolean
  runningCount(): number
  allIds(): string[]
  disposeAll(): Promise<void>
}
