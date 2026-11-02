import { requireGuardedEventAppender, type AsyncEventStateReadSurface, type AsyncEventWriter } from "../../infra/event-store-types.js"
import { extractToolContentFact, type ExtractedToolContentFact } from "../../infra/tool-content-extraction.js"
import { contentEvidence } from "../../infra/content-evidence.js"
import { stringField } from "../../infra/output/json-field.js"
import type { ToolOutcome } from "../../infra/tool-outcome.js"
import { readTerminalHandoff, workflowStartFailureContent, workflowStopContent } from "../../workflows/output-contract/workflow-completion.js"
import { childSessionResultFact, workflowNotificationLabel } from "./child-session-completion.js"
import { prepareSessionFactAppend } from "./session-fact-writer.js"
import { holdsInterruptedGuess, readToolExecution } from "./tool-execution-projection.js"

const MAX_CONFLICT_RETRIES = 3

interface ChildWorkflowResultInput {
  readonly reader: AsyncEventStateReadSurface
  readonly projectionReader?: AsyncEventStateReadSurface
  readonly writer: AsyncEventWriter
  readonly parentSessionId: string
  readonly toolUseId: string
  readonly childSessionId: string
  readonly workflowDefinitionId: string
}

/** Records a workflow Stop as its parent's terminal tool result: stopped by a
 * person or cancelled by the requesting agent. The result prevents workflow
 * Resume regardless of its control state. Reconciliation delivers its notice.
 * A live tracked run can correct an earlier result without changing that fact.
 * Returns false when the call already holds a Stop, or holds another result
 * and the caller has no live run to stop. */
export async function recordChildWorkflowStop(input: ChildWorkflowResultInput & { readonly stoppedBy: "person" | "agent"; readonly correctPriorResult?: boolean }): Promise<boolean> {
  const handoff = await readTerminalHandoff(input.projectionReader ?? input.reader, input.childSessionId)
  return await recordChildWorkflowResult(input, "Child workflow stop", input.stoppedBy === "person" ? "stopped" : "cancelled",
    (label) => workflowStopContent({ label, sessionId: input.childSessionId, stoppedBy: input.stoppedBy, handoff }), input.correctPriorResult)
}

/** Records a published workflow's start failure as its parent's error result.
 * The workflow remains paused and resumable, and a later terminal run corrects
 * that result. Reconciliation delivers its notice. Returns false when the
 * parent call already has a result. */
export async function recordChildWorkflowStartFailure(input: ChildWorkflowResultInput): Promise<boolean> {
  return await recordChildWorkflowResult(input, "Child workflow start failure", "error",
    (label) => workflowStartFailureContent({ label, sessionId: input.childSessionId }))
}

async function recordChildWorkflowResult(input: ChildWorkflowResultInput, operation: string, outcome: ToolOutcome, content: (label: string) => string, correctPriorResult = false): Promise<boolean> {
  for (let attempt = 0; attempt <= MAX_CONFLICT_RETRIES; attempt += 1) {
    const reader = input.projectionReader ?? input.reader
    const expectedSeq = await reader.aggregateSeq(`session:${input.parentSessionId}`) + 1
    const tool = await readToolExecution(reader, input.parentSessionId, input.toolUseId)
    if (!tool || tool.resultOutcome === "stopped" || tool.resultOutcome === "cancelled") return false
    const priorResultEventId = holdsInterruptedGuess(tool) ? undefined : tool.resultEventId
    if (priorResultEventId !== undefined && !correctPriorResult) return false
    const text = content(workflowNotificationLabel(tool.input, input.workflowDefinitionId))
    const extracted: ExtractedToolContentFact = priorResultEventId !== undefined && (outcome === "stopped" || outcome === "cancelled")
      ? { fact: {
        type: "workflow.tool_result.corrected", version: 1, actor: "flywheel",
        payload: {
          toolUseId: input.toolUseId, childSessionId: input.childSessionId, workflowDefinitionId: input.workflowDefinitionId,
          description: tool.input ? stringField(tool.input, "description") ?? "" : "",
          priorResultEventId, outcome, ...contentEvidence(text),
        },
      } }
      : extractToolContentFact(childSessionResultFact(tool, text, outcome))
    const result = await requireGuardedEventAppender(input.writer, `${operation} requires guarded append authority`).appendBatchGuarded([{
      ...prepareSessionFactAppend(input.parentSessionId, extracted.fact, extracted.contentRows),
      expectedSeq,
    }])
    if (result.kind === "stored") return true
    if (result.conflict.aggregateId !== `session:${input.parentSessionId}` || attempt === MAX_CONFLICT_RETRIES) {
      throw new Error(`${operation} stayed contended`, { cause: result.conflict })
    }
  }
  return false
}
