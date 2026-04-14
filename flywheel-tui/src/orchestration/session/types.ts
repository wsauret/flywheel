export type SessionKind = "workflow" | "chat"

export interface RunnerDoneResult {
  terminalTitle: string
}

export interface RunnerErrorResult {
  errorMessage: string
  terminalTitle: string
}
