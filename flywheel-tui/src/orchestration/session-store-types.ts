import type { WorkflowRunner, WorkflowResult, StepState } from "./workflow-runner.js"
import type { AnyBlock } from "../infra/output-blocks.js"
import type { ModelActivity } from "../infra/events.js"
import type { ChatRunner } from "./chat-runner.js"
import type { SessionKind } from "./session/types.js"
import type { Queue } from "../workflows/queue/types.js"
import type { WorkflowDeps } from "./engines/workflow-deps.js"

export interface SessionEntryBase {
  readonly kind: SessionKind
  description: string
  outputBlocks: readonly AnyBlock[]
  tokens: number
  cost: number
  contextPercent: number
  readonly startedAt: number
  modelActivity: ModelActivity
  /** True after the runner has completed/errored and been disposed. Data is retained for display. */
  ended: boolean
}

export interface WorkflowSessionEntry extends SessionEntryBase {
  readonly kind: "workflow"
  /** Null for ended/loaded entries (no live runner). */
  readonly runner: WorkflowRunner | null
  steps: readonly StepState[]
}

export interface ChatSessionEntry extends SessionEntryBase {
  readonly kind: "chat"
  /** Null for ended/loaded entries (no live runner). */
  readonly runner: ChatRunner | null
  /** Claude Code session ID — used for --resume to reconnect with full context. */
  claudeSessionId?: string
}

export type SessionEntry = WorkflowSessionEntry | ChatSessionEntry

export interface ChatStoreHandle {
  updateEntry: (patch: Partial<ChatSessionEntry>) => void
  /** Signal a fatal error — removes entry and fires onRunnerError.
   *  Returns void (fire-and-forget). Implementations are async but callers
   *  intentionally drop the promise — cleanup is best-effort. */
  onError: (message: string) => void
  /** Signal normal completion — removes entry and fires onRunnerDone.
   *  Returns void (fire-and-forget). Implementations are async but callers
   *  intentionally drop the promise — cleanup is best-effort. */
  onEnded: () => void
}

export interface SessionStore {
  start(opts: {
    sessionId: string
    queue: Queue
    description: string
    priorBlocks?: AnyBlock[]
    subprocessCwd?: string
    workflowDeps?: WorkflowDeps
    chatContext?: string
    onComplete?: () => void
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
    onComplete?: () => void
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
    claudeSessionId?: string
  }): void

  get(sessionId: string): SessionEntry | undefined
  has(sessionId: string): boolean
  isRunning(sessionId: string): boolean
  pause(sessionId: string): boolean
  abort(sessionId: string): void
  remove(sessionId: string): Promise<void>
  updateEntry(sessionId: string, patch: Partial<WorkflowSessionEntry> | Partial<ChatSessionEntry>): void
  injectMessage(sessionId: string, text: string): boolean
  cancelShutdown(sessionId: string): boolean
  runningCount(): number
  allIds(): string[]
  disposeAll(): Promise<void>
}
