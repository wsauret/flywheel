import { parseProjectionFact } from "../event-projection.js"
import type { StoredFact } from "../event-store-types.js"
import { parseSessionRuntimeFact } from "../runtime-fact-parser.js"
import type { OutputProjectionEvent } from "./output-projection-events.js"

/** Strictly decodes one durable runtime fact and maps nested tool facts to live output events. */
export function nestedFactProjectionEvents(event: StoredFact): OutputProjectionEvent[] {
  const fact = parseProjectionFact(event, parseSessionRuntimeFact)
  const parentToolUseId = "parentToolUseId" in fact.payload ? fact.payload.parentToolUseId : undefined
  if (parentToolUseId === undefined) return []

  switch (fact.type) {
    case "tool.input.completed":
      return [{
        type: "tool-input-complete",
        toolUseId: fact.payload.toolUseId,
        name: fact.payload.toolName,
        input: fact.payload.input,
        timestamp: event.timestamp,
        parentToolUseId,
        nestedInCode: true,
      }]
    case "tool.result.recorded":
      return [{
        type: "tool-result",
        toolUseId: fact.payload.toolUseId,
        outcome: fact.payload.outcome,
        content: [{ type: "text", text: fact.payload.content ?? fact.payload.contentPreview ?? "" }],
        source: "render",
        timestamp: event.timestamp,
        parentToolUseId,
        ...(fact.payload.details !== undefined ? { details: fact.payload.details } : {}),
      }]
    case "tool.execution_output.recorded":
      return [{
        type: "tool-execution-output-recorded",
        toolUseId: fact.payload.toolUseId,
        output: fact.payload.output,
        ...("mutationEvidence" in fact.payload && fact.payload.mutationEvidence !== undefined ? { mutationEvidence: fact.payload.mutationEvidence } : {}),
        parentToolUseId,
      }]
    default:
      return []
  }
}
