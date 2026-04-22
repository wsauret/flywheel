import type { Step, StepStatus } from "../workflows/queue/types.js"

export type StepState = {
  id: string; type: Step["type"]; title: string; status: StepStatus
  durationMs?: number; startedAt?: number; completedAt?: number
}

export interface WorkflowResult {
  completed: boolean
  stepsCompleted: number
  stepsTotal: number
  cost: number
  tokens: number
  reason?: string
}

export interface WorkflowRunner {
  run(): Promise<WorkflowResult>
  pause(): void
  abort(): void
  injectMessage(text: string): boolean
  answerQuestion(toolUseId: string, answers: Record<string, string>): void
  cancelQuestion(toolUseId: string): void
  cancelShutdown(): void
  readonly sessionId: string
  dispose(): Promise<void>
}
