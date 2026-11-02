import type { StreamingEditTool, StreamingEditValidationResult } from "./streaming-edit-validator.js"

export interface StreamingEditValidationIdentity {
  readonly attemptToken: string
  readonly toolToken: string
  readonly inputToken: string
}

export interface StreamingEditValidationWorkerIdentity extends StreamingEditValidationIdentity {
  readonly handleToken: string
}

export interface StreamingEditValidationStart extends StreamingEditValidationIdentity {
  readonly tool: StreamingEditTool
}

export interface StreamingEditValidationAppend extends StreamingEditValidationIdentity {
  readonly suffix: string
}

type StreamingEditValidationAdvice =
  | { readonly type: "clear" }
  | { readonly type: "set"; readonly message: string }

export type StreamingEditValidationWorkerRequest =
  | (StreamingEditValidationStart & StreamingEditValidationWorkerIdentity & {
      readonly type: "append"
      readonly executionCwd: string
      readonly sequence: number
      readonly suffix: string
    })
  | (StreamingEditValidationWorkerIdentity & { readonly type: "drop" })

export type StreamingEditValidationWorkerReply =
  | (StreamingEditValidationWorkerIdentity & {
      readonly type: "result"
      readonly sequence: number
      readonly status: StreamingEditValidationResult["status"]
      readonly advice: StreamingEditValidationAdvice
    })
  | { readonly type: "ready" }

export interface StreamingEditValidationAdviceEvent extends StreamingEditValidationIdentity {
  readonly advice: StreamingEditValidationAdvice
}
