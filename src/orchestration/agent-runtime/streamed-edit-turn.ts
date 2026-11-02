import type { StreamEvent } from "./llm/types.js"
import type { StreamingEditValidationService } from "./tools/streaming-edit-validation.js"
import type { StreamingEditValidationIdentity } from "./tools/streaming-edit-validation-protocol.js"

interface StreamedEditTurnOptions {
  readonly service: StreamingEditValidationService | undefined
  readonly executionCwd: string
  readonly turnOrdinal: number
  readonly onEvent: (event: StreamEvent) => void
}

export interface StreamedEditTurn {
  observe(event: StreamEvent): void
  retire(toolUseId: string): void
  reset(): void
  dispose(): void
}

/** Owns the provisional edit-validation identities and advice for one model turn. */
export function createStreamedEditTurn(options: StreamedEditTurnOptions): StreamedEditTurn {
  let attempt = 0
  let input = 0
  let attemptToken = `${options.turnOrdinal}:${attempt}`
  const inputs = new Map<string, StreamingEditValidationIdentity>()
  const validation = options.service?.openTurn({
    executionCwd: options.executionCwd,
    onAdvice: (event) => {
      const current = inputs.get(event.toolToken)
      if (
        current?.attemptToken !== event.attemptToken
        || current.inputToken !== event.inputToken
      ) return
      options.onEvent({
        kind: "tool_preview_check",
        toolUseId: event.toolToken,
        operation: event.advice.type === "set"
          ? { type: "set", advice: event.advice.message }
          : { type: "clear" },
      })
    },
  })

  const retire = (toolUseId: string): void => {
    const identity = inputs.get(toolUseId)
    if (!identity) return
    validation?.retire(identity)
    inputs.delete(toolUseId)
    options.onEvent({
      kind: "tool_preview_check",
      toolUseId,
      operation: { type: "clear" },
    })
  }

  return {
    observe: (event) => {
      if (event.kind === "tool_input_start" && (event.name === "apply_patch" || event.name === "edit")) {
        const previous = inputs.get(event.toolUseId)
        if (previous) validation?.retire(previous)
        const identity = {
          attemptToken,
          toolToken: event.toolUseId,
          inputToken: `${attemptToken}:${++input}`,
        }
        inputs.set(event.toolUseId, identity)
        validation?.start({ ...identity, tool: event.name })
        return
      }
      if (event.kind !== "tool_input_delta") return
      const identity = inputs.get(event.toolUseId)
      if (identity) validation?.append({ ...identity, suffix: event.partialJson })
    },
    retire,
    reset: () => {
      validation?.reset(attemptToken)
      inputs.clear()
      attempt += 1
      attemptToken = `${options.turnOrdinal}:${attempt}`
    },
    dispose: () => {
      validation?.reset(attemptToken)
      inputs.clear()
    },
  }
}
