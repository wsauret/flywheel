import type { AsyncEventStateReadSurface, AsyncEventWriter } from "../../../../infra/event-store-types.js"
import { extractToolContentFact, type ExtractedToolContentFact } from "../../../../infra/tool-content-extraction.js"
import { contentEvidence } from "../../../../infra/content-evidence.js"
import { stringField } from "../../../../infra/tools/json-field.js"
import type { ToolOutcome } from "../../../../infra/tool-outcome.js"
import { readTerminalHandoff, workflowStartFailureContent, workflowStopContent } from "../../../../workflows/vm/recovery/workflow-completion.js"
import { childSessionResultFact, workflowNotificationLabel } from "./child-session-completion.js"
import { prepareSessionFactAppend } from "../../persistence/session-fact-writer.js"
import { holdsInterruptedGuess, readToolExecution } from "../../runtime-facts/tool-execution-projection.js"
import { childCallOf } from "../chat-session-run-evidence.js"
import type { StoppedBy } from "../../../../protocol/app-service-types.js"

const MAX_CONFLICT_RETRIES = 3

interface ChildWorkflowResultInput {
  readonly reader: AsyncEventStateReadSurface
  readonly projectionReader: AsyncEventStateReadSurface
  readonly writer: AsyncEventWriter
  readonly parentSessionId: string
  readonly toolUseId: string
  readonly childSessionId: string
  readonly workflowDefinitionId: string
}

/** Records a workflow Stop as its parent's terminal tool result: stopped by a
 * person or cancelled by the requesting agent. The run ends for its parent
 * until an explicit Resume passes it (`recordChildWorkflowResume`).
 * Reconciliation delivers its notice. A Stop of a run that a host holds, or
 * of a call whose Cancel a Resume passed, corrects the earlier result without
 * changing that fact. Returns false when the call already holds a current
 * Cancel, or holds another result and the caller has no run to stop. */
export async function recordChildWorkflowStop(input: ChildWorkflowResultInput & { readonly stoppedBy: "person" | "agent"; readonly correctPriorResult?: boolean }): Promise<boolean> {
  const handoff = await readTerminalHandoff(input.projectionReader, input.childSessionId)
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
    const reader = input.projectionReader
    const expectedSeq = await reader.aggregateSeq(`session:${input.parentSessionId}`) + 1
    const tool = await readToolExecution(reader, input.parentSessionId, input.toolUseId)
    if (!tool || childCallOf(tool).stoppedBy !== undefined) return false
    const priorResultEventId = holdsInterruptedGuess(tool) ? undefined : tool.resultEventId
    // A Cancel that an explicit Resume passed no longer ends the run, so a
    // new Stop corrects it as it corrects any earlier result.
    const passedStop = priorResultEventId !== undefined && tool.resumedResultEventId === priorResultEventId
    if (priorResultEventId !== undefined && !correctPriorResult && !passedStop) return false
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
    const result = await input.writer.appendBatchGuarded([{
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

/** Records an explicit Resume of a workflow whose launching call holds a
 *  current Cancel: a person's, or the parent agent's (`by`). The Resume
 *  names `resultEventId`, the Cancel that its requester saw, and lands only
 *  while that Cancel is still the call's current result, so a Cancel that
 *  lands meanwhile is the newer decision and wins. Returns false when the
 *  call no longer holds that Cancel as its current result. */
export async function recordChildWorkflowResume(input: Omit<ChildWorkflowResultInput, "reader" | "workflowDefinitionId"> & { readonly resultEventId: string; readonly by: StoppedBy }): Promise<boolean> {
  for (let attempt = 0; attempt <= MAX_CONFLICT_RETRIES; attempt += 1) {
    const expectedSeq = await input.projectionReader.aggregateSeq(`session:${input.parentSessionId}`) + 1
    const tool = await readToolExecution(input.projectionReader, input.parentSessionId, input.toolUseId)
    if (tool?.resultEventId !== input.resultEventId || childCallOf(tool).stoppedBy === undefined) return false
    const result = await input.writer.appendBatchGuarded([{
      ...prepareSessionFactAppend(input.parentSessionId, {
        type: "workflow.tool_result.resumed", version: 1, actor: "flywheel",
        payload: { toolUseId: input.toolUseId, childSessionId: input.childSessionId, resultEventId: input.resultEventId, by: input.by },
      }),
      expectedSeq,
    }])
    if (result.kind === "stored") return true
    if (result.conflict.aggregateId !== `session:${input.parentSessionId}` || attempt === MAX_CONFLICT_RETRIES) {
      throw new Error("Child workflow resume stayed contended", { cause: result.conflict })
    }
  }
  return false
}
