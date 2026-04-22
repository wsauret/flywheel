import type { AnyBlock } from "../infra/output-blocks.js"

export interface ChatRunner {
  readonly sessionId: string
  abort(): void
  dispose(): Promise<void>
  injectMessage(text: string): boolean
  sendToolResult(toolUseId: string, content: string, isError?: boolean): void
  readonly chatSession: {
    answerQuestion(toolUseId: string, answers: Record<string, string>): void
    cancelQuestion(toolUseId: string): void
  }
  readonly initialBlocks: readonly AnyBlock[]
}
