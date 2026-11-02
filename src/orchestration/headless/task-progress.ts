import type { FlywheelEvent, FlywheelEventType } from "../../infra/events.js"
import type { MeasuredUsageEntry } from "../../infra/llm/usage-entry.js"
import type { SessionNoticeOperation } from "../../infra/session-notice.js"
import type { ProviderRequestAuditFact } from "../session/provider-request-audit-facts.js"

export const HEADLESS_PROGRESS_EVENT_TYPES = [
  "agent.provider_response.started",
  "tool.input.completed",
  "tool.execution_output.delta",
  "tool.result.recorded",
  "model.usage.measured",
  "agent.error.observed",
  "model.turn.completed",
  "workflow.run.initialized",
  "workflow.run.completed",
  "workflow.run.paused",
  "workflow.run.failed",
  "workflow.attempt.started",
  "workflow.attempt.completed",
  "workflow.attempt.failed",
  "workflow.attempt.interrupted",
] as const satisfies readonly FlywheelEventType[]

/** Compact live stderr progress for headless task and workflow runs.
 *
 *  Bus events carry most progress. Two sources reach a run outside the bus:
 *  usage that the session settles into the store, and the audit record of a
 *  provider request that failed before any response. A task run feeds both
 *  through `usage` and `audit`, so a provider walk that retries for a minute
 *  still prints one line for each failed request. */
export interface TaskProgressWriter {
  readonly event: (event: FlywheelEvent) => void
  readonly usage: (entry: MeasuredUsageEntry) => void
  readonly audit: (fact: ProviderRequestAuditFact) => void
  /** Writes each status notice once, when it appears: its title and message. */
  readonly notice: (operation: SessionNoticeOperation) => void
}

export function createTaskProgressWriter(write: (line: string) => void): TaskProgressWriter {
  const startedAt = Date.now()
  let requests = 0
  const printedUsage = new Set<string>()
  const printedOutput = new Map<string, string>()
  const stamp = () => `[+${Math.round((Date.now() - startedAt) / 1000)}s]`

  const usage = (entry: MeasuredUsageEntry): void => {
    if (printedUsage.has(entry.attemptId)) return
    printedUsage.add(entry.attemptId)
    write(`${stamp()} usage out=${entry.tokens.output} cache=${entry.tokens.cacheRead ?? "unreported"}`)
  }

  // A live output delta carries the command's whole current tail, not only
  // what is new, so print only the complete lines this writer has not shown.
  // Once the tail window drops its first lines, the last line shown anchors
  // where the new lines start.
  const executionOutput = (toolUseId: string, output: string): void => {
    const complete = output.slice(0, output.lastIndexOf("\n") + 1)
    if (complete === "") return
    const shown = printedOutput.get(toolUseId) ?? ""
    printedOutput.set(toolUseId, complete)
    let fresh = complete
    if (complete.startsWith(shown)) fresh = complete.slice(shown.length)
    else {
      const lastLine = shown.slice(shown.lastIndexOf("\n", shown.length - 2) + 1)
      const at = lastLine === "" ? -1 : complete.lastIndexOf(lastLine)
      if (at >= 0) fresh = complete.slice(at + lastLine.length)
    }
    if (fresh === "") return
    for (const line of fresh.slice(0, -1).split("\n")) write(`${stamp()}   | ${previewText(line)}`)
  }

  const onEvent = (event: FlywheelEvent): void => {
    switch (event.type) {
      case "agent.provider_response.started":
        requests += 1
        write(`${stamp()} request #${requests}`)
        return
      case "tool.input.completed": {
        const { name } = event.data.tool_use
        write(`${stamp()} tool ${previewText(name)}`)
        return
      }
      case "tool.execution_output.delta":
        executionOutput(event.data.tool_use_id, event.data.output)
        return
      case "tool.result.recorded":
        if (event.data.tool_use_id !== undefined) printedOutput.delete(event.data.tool_use_id)
        if (event.data.is_error === true) write(`${stamp()} tool result: error`)
        return
      case "model.usage.measured":
        if (event.data.usage_entry.coverage !== "unmeasured") usage(event.data.usage_entry)
        return
      case "agent.error.observed":
        write(`${stamp()} error observed`)
        return
      case "model.turn.completed":
        write(`${stamp()} response completed`)
        return
      case "workflow.run.initialized":
        write(`${stamp()} workflow initialized attempts=${event.data.attemptIds.length}`)
        return
      case "workflow.run.completed":
        write(`${stamp()} workflow completed attempts=${event.data.attemptsCompleted}`)
        return
      case "workflow.run.paused":
        write(`${stamp()} workflow paused after=${event.data.attemptsCompleted}: ${previewText(event.data.reason)}`)
        return
      case "workflow.run.failed":
        write(`${stamp()} workflow failed after=${event.data.attemptsCompleted}: ${previewText(event.data.reason)}`)
        return
      case "workflow.attempt.started":
        write(`${stamp()} agent started: ${previewText(event.data.agentName)}`)
        return
      case "workflow.attempt.completed":
        write(`${stamp()} agent completed: ${previewText(event.data.agentName)}`)
        return
      case "workflow.attempt.failed":
        write(`${stamp()} agent failed: ${previewText(event.data.agentName)}: ${previewText(event.data.reason)}`)
        return
      case "workflow.attempt.interrupted":
        write(`${stamp()} agent interrupted: ${previewText(event.data.agentName)}: ${previewText(event.data.reason)}`)
        return
      default:
        return
    }
  }

  const audit = (fact: ProviderRequestAuditFact): void => {
    if (fact.type !== "model.response_received") return
    const { outcome } = fact.payload
    if (outcome === "ok" || outcome === "aborted") return
    write(`${stamp()} request failed: ${outcome}${fact.payload.error ? ` (${previewText(fact.payload.error.tag)})` : ""}`)
  }

  const notice = (operation: SessionNoticeOperation): void => {
    if (operation.type === "upsert") write(`${stamp()} ${operation.notice.title}: ${previewText(operation.notice.message)}`)
  }

  return { event: onEvent, usage, audit, notice }
}

function previewText(text: string): string {
  return text.length > 160 ? `${text.slice(0, 160)}...` : text
}
